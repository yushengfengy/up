// ai.mjs - OpenAI-compatible chat client (zero deps)
// Env: AI_BASE_URL (default https://api.openai.com/v1), AI_API_KEY, AI_MODEL (default gpt-4o-mini)
const cfg = () => ({
  baseUrl: (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  apiKey: process.env.AI_API_KEY || '',
  model: process.env.AI_MODEL || 'gpt-4o-mini',
  timeoutMs: parseInt(process.env.AI_TIMEOUT_MS || '60000', 10),
});

export function aiConfigured() { return !!cfg().apiKey; }

export async function chat(messages, { temperature = 0.2, json = false } = {}) {
  const c = cfg();
  if (!c.apiKey) throw new Error('AI_API_KEY not set');
  const body = { model: c.model, messages, temperature };
  if (json && process.env.AI_JSON_MODE !== '0') body.response_format = { type: 'json_object' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), c.timeoutMs);
  try {
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`AI HTTP ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    return data.choices?.[0]?.message?.content ?? '';
  } finally { clearTimeout(t); }
}

// 容错解析：模型可能用 ```json 包裹或夹带说明文字
export function parseJsonLoose(s) {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI returned no JSON');
  return JSON.parse(m[0]);
}

export async function extractKeywords(query) {
  const out = await chat([
    { role: 'system', content: '你是搜索助手。分析用户需求，提取用于网络搜索的关键词。只输出 JSON：{"intent":"一句话概括需求","keywords":["核心关键词"],"queries":["可直接搜索的查询语句，2-4条，中英文按需"]}' },
    { role: 'user', content: query },
  ], { json: true });
  const j = parseJsonLoose(out);
  const arr = (x) => (Array.isArray(x) ? x.map(String).filter(Boolean) : []);
  const queries = arr(j.queries).slice(0, 4);
  const keywords = arr(j.keywords).slice(0, 8);
  return { intent: String(j.intent || ''), keywords, queries: queries.length ? queries : [keywords.join(' ') || query] };
}

export async function summarize(query, results) {
  const list = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.snippet || '').slice(0, 300)}`).join('\n\n');
  const out = await chat([
    { role: 'system', content: '你是信息筛选助手。根据用户需求，从搜索结果中挑出有价值、相关的条目并简要总结。只依据给定结果，不要编造。只输出 JSON：{"summary":"总体结论","picks":[{"index":编号,"reason":"为何有价值","score":0-10}]}' },
    { role: 'user', content: `需求：${query}\n\n搜索结果：\n${list}` },
  ], { json: true });
  const j = parseJsonLoose(out);
  const picks = (Array.isArray(j.picks) ? j.picks : [])
    .map(p => ({ r: results[(Number(p.index) || 0) - 1], reason: String(p.reason || ''), score: Number(p.score) || 0 }))
    .filter(p => p.r)
    .sort((a, b) => b.score - a.score)
    .map(p => ({ ...p.r, reason: p.reason, aiScore: p.score }));
  return { summary: String(j.summary || ''), picks };
}
