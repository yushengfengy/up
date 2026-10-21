// ai.mjs - OpenAI-compatible chat client (zero deps) + provider registry
// 内置提供商 "default"：AI_BASE_URL / AI_API_KEY / AI_MODEL；
//   未设置时回退到平台网关 AI_GATEWAY_URL / AI_AGENT_KEY（仅 Railway Cloud Agent VM 内有）。
// 用户提供商：保存在 data/providers.json，通过 /api/providers 增删。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'providers.json');
const timeoutMs = () => parseInt(process.env.AI_TIMEOUT_MS || '60000', 10);

function defaultProvider() {
  const e = process.env;
  const baseUrl = e.AI_BASE_URL || (e.AI_API_KEY ? 'https://api.openai.com/v1' : e.AI_GATEWAY_URL) || '';
  const apiKey = e.AI_API_KEY || e.AI_AGENT_KEY || '';
  const onGateway = !!e.AI_GATEWAY_URL && baseUrl.replace(/\/+$/, '') === e.AI_GATEWAY_URL.replace(/\/+$/, '');
  const model = e.AI_MODEL || (onGateway || !e.AI_API_KEY ? 'claude-sonnet-5-5' : 'gpt-4o-mini');
  return { id: 'default', name: '内置', baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model, builtin: true };
}

function loadUser() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function saveUser(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}

export function getProvider(id = 'default') {
  if (!id || id === 'default') return defaultProvider();
  const p = loadUser().find(x => x.id === id);
  if (!p) throw Object.assign(new Error(`unknown provider: ${id}`), { status: 400 });
  return p;
}

const mask = k => (k ? (k.length > 8 ? k.slice(0, 3) + '…' + k.slice(-4) : '***') : '');
export function listProviders() {
  return [defaultProvider(), ...loadUser()].map(p => ({
    id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model, builtin: !!p.builtin,
    apiKey: mask(p.apiKey), configured: !!(p.baseUrl && p.apiKey),
  }));
}

export function addProvider({ id, name, baseUrl, apiKey, model }) {
  id = String(id || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id) || id === 'default') throw Object.assign(new Error('invalid id (a-z0-9_-, max 32, not "default")'), { status: 400 });
  let u; try { u = new URL(baseUrl); } catch { throw Object.assign(new Error('invalid baseUrl'), { status: 400 }); }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('baseUrl must be http(s)'), { status: 400 });
  if (!apiKey || !model) throw Object.assign(new Error('apiKey and model required'), { status: 400 });
  const list = loadUser().filter(x => x.id !== id);
  list.push({ id, name: String(name || id), baseUrl: String(baseUrl).replace(/\/+$/, ''), apiKey: String(apiKey), model: String(model) });
  saveUser(list);
}

export function removeProvider(id) {
  const list = loadUser();
  const next = list.filter(x => x.id !== id);
  saveUser(next);
  return next.length !== list.length;
}

export function aiConfigured(id = 'default') {
  try { const p = getProvider(id); return !!(p.baseUrl && p.apiKey); } catch { return false; }
}

async function post(p, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs());
  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return { res, text: await res.text() };
  } finally { clearTimeout(t); }
}

export async function chat(messages, { json = false, provider = 'default' } = {}) {
  const p = getProvider(provider);
  if (!p.baseUrl || !p.apiKey) throw Object.assign(new Error(`AI provider "${p.id}" not configured`), { status: 503 });
  const body = { model: p.model, messages };
  if (process.env.AI_TEMPERATURE) body.temperature = Number(process.env.AI_TEMPERATURE); // 部分模型不支持，默认不发
  let r;
  if (json && process.env.AI_JSON_MODE !== '0') {
    r = await post(p, { ...body, response_format: { type: 'json_object' } });
    if (r.res.status === 400) r = await post(p, body); // 不支持 JSON mode 的服务商：去掉重试
  } else r = await post(p, body);
  if (!r.res.ok) throw new Error(`AI HTTP ${r.res.status}: ${r.text.slice(0, 300)}`);
  return JSON.parse(r.text).choices?.[0]?.message?.content ?? '';
}

// 容错解析：模型可能用 ```json 包裹或夹带说明文字
export function parseJsonLoose(s) {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI returned no JSON');
  return JSON.parse(m[0]);
}

export async function extractKeywords(query, provider) {
  const out = await chat([
    { role: 'system', content: '你是搜索助手。分析用户需求，提取用于网络搜索的关键词。只输出 JSON：{"intent":"一句话概括需求","keywords":["核心关键词"],"queries":["可直接搜索的查询语句，2-4条，中英文按需"]}' },
    { role: 'user', content: query },
  ], { json: true, provider });
  const j = parseJsonLoose(out);
  const arr = (x) => (Array.isArray(x) ? x.map(String).filter(Boolean) : []);
  const queries = arr(j.queries).slice(0, 4);
  const keywords = arr(j.keywords).slice(0, 8);
  return { intent: String(j.intent || ''), keywords, queries: queries.length ? queries : [keywords.join(' ') || query] };
}

export async function summarize(query, results, provider) {
  const list = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.snippet || '').slice(0, 300)}`).join('\n\n');
  const out = await chat([
    { role: 'system', content: '你是信息筛选助手。根据用户需求，从搜索结果中挑出有价值、相关的条目并简要总结。只依据给定结果，不要编造。只输出 JSON：{"summary":"总体结论","picks":[{"index":编号,"reason":"为何有价值","score":0-10}]}' },
    { role: 'user', content: `需求：${query}\n\n搜索结果：\n${list}` },
  ], { json: true, provider });
  const j = parseJsonLoose(out);
  const picks = (Array.isArray(j.picks) ? j.picks : [])
    .map(p => ({ r: results[(Number(p.index) || 0) - 1], reason: String(p.reason || ''), score: Number(p.score) || 0 }))
    .filter(p => p.r)
    .sort((a, b) => b.score - a.score)
    .map(p => ({ ...p.r, reason: p.reason, aiScore: p.score }));
  return { summary: String(j.summary || ''), picks };
}
