// research.mjs - 类 Grok web_search 的多轮研究：
// 规划查询 → 搜索 → AI 选页 → 抓取阅读 → 评估是否足够/追问 → 带引用编号的最终回答
import { aiConfigured, chat, parseJsonLoose, extractKeywords } from './ai.mjs';
import { searchMany } from './search.mjs';
import { fetchPage } from './fetchpage.mjs';

const arr = x => (Array.isArray(x) ? x : []);
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const domainOk = (u, allow, deny) => {
  const h = host(u);
  const m = d => h === d || h.endsWith('.' + d);
  return (!allow.length || allow.some(m)) && !deny.some(m);
};
const cleanDomains = v => arr(v).map(d => String(d).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter(Boolean).slice(0, 5);

async function json(system, user, provider) {
  return parseJsonLoose(await chat([{ role: 'system', content: system }, { role: 'user', content: user }], { json: true, provider }));
}

export async function research(query, opts = {}) {
  const provider = opts.provider || 'default';
  if (!aiConfigured(provider)) throw Object.assign(new Error(`AI provider "${provider}" not configured`), { status: 503 });
  const depth = Math.min(Math.max(parseInt(opts.depth ?? 2, 10) || 1, 1), 3);
  const allow = cleanDomains(opts.allowed_domains), deny = allow.length ? [] : cleanDomains(opts.excluded_domains);
  const steps = [];
  const errors = [];

  const kw = await extractKeywords(query, provider);
  let queries = kw.queries.slice(0, 3);
  const all = [];            // 全部搜索结果（带稳定编号）
  const seen = new Set();
  const read = [];           // 已阅读页面 {n,url,title,text}
  let notes = '';

  for (let round = 1; round <= depth; round++) {
    // 1. 搜索
    const { results, errors: se } = await searchMany(queries);
    errors.push(...se);
    const fresh = results.filter(r => !seen.has(r.url) && domainOk(r.url, allow, deny));
    fresh.forEach(r => { seen.add(r.url); r.n = all.length + 1; all.push(r); });
    steps.push({ round, action: 'search', queries, found: fresh.length });
    if (!fresh.length) break;

    // 2. AI 选择要打开阅读的页面
    const list = fresh.map(r => `[${r.n}] ${r.title} (${host(r.url)})\n${(r.snippet || '').slice(0, 200)}`).join('\n');
    let pick = [];
    try {
      const sel = await json('你是研究助理。从搜索结果中选出最值得打开阅读的页面（最多4个，优先权威/一手/时效性强的来源，避免重复）。只输出 JSON：{"open":[编号]}', `需求：${query}\n\n结果：\n${list}`, provider);
      pick = arr(sel.open).map(Number).filter(n => fresh.some(r => r.n === n)).slice(0, 4);
    } catch (e) { errors.push(`select: ${e.message}`); }
    if (!pick.length) pick = fresh.slice(0, 3).map(r => r.n);

    // 3. 并行抓取阅读
    const pages = await Promise.allSettled(pick.map(n => fetchPage(all[n - 1].url)));
    pages.forEach((p, i) => {
      const r = all[pick[i] - 1];
      if (p.status === 'fulfilled' && p.value.text.length > 200) read.push({ n: r.n, url: r.url, title: p.value.title || r.title, text: p.value.text });
      else steps.push({ round, action: 'read_failed', url: r.url, reason: p.status === 'rejected' ? p.reason.message : 'too little text' });
    });
    steps.push({ round, action: 'read', urls: read.filter(x => pick.includes(x.n)).map(x => x.url) });

    // 4. 评估：信息够不够，是否需要追问
    if (round === depth) break;
    try {
      const ctx = read.map(p => `[${p.n}] ${p.title}\n${p.text.slice(0, 1500)}`).join('\n\n');
      const a = await json('你是研究助理。基于已读内容判断能否充分回答用户需求。只输出 JSON：{"enough":true|false,"notes":"目前已确认的要点","followups":["还缺什么，用于下一轮搜索的新查询，最多3条"]}', `需求：${query}\n\n已读内容：\n${ctx}`, provider);
      notes = String(a.notes || '');
      steps.push({ round, action: 'assess', enough: !!a.enough, notes });
      if (a.enough) break;
      queries = arr(a.followups).map(String).filter(Boolean).slice(0, 2);
      if (!queries.length) break;
    } catch (e) { errors.push(`assess: ${e.message}`); break; }
  }

  if (!all.length) return { query, ...kw, answer: '没有搜索到结果', summary: '没有搜索到结果', picks: [], sources: [], results: [], steps, errors };

  // 5. 最终回答：只能依据已读页面和搜索摘要，用 [n] 标注来源
  const ctx = read.length
    ? read.map(p => `[${p.n}] ${p.title}\n${p.url}\n${p.text}`).join('\n\n')
    : all.slice(0, 10).map(r => `[${r.n}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
  const answer = (await chat([
    { role: 'system', content: '你是研究助理。仅依据给定资料回答用户需求，不要编造；用 [编号] 行内标注来源，资料不足或相互矛盾要明说。直接输出 markdown 回答，不要输出 JSON，不要在末尾列参考文献。' },
    { role: 'user', content: `需求：${query}\n${notes ? `\n已确认要点：${notes}\n` : ''}\n资料：\n${ctx}` },
  ], { provider })).trim();
  const byN = new Map(all.map(r => [r.n, r]));
  const cnt = new Map();
  for (const m of answer.matchAll(/\[(\d{1,3})\]/g)) { const n = Number(m[1]); if (byN.has(n)) cnt.set(n, (cnt.get(n) || 0) + 1); }
  const sources = [...cnt.keys()].sort((x, y) => x - y).map(n => ({ n, title: byN.get(n).title, url: byN.get(n).url, read: read.some(p => p.n === n) }));
  const picks = [...cnt.entries()].sort((x, y) => y[1] - x[1]).map(([n, c]) => ({ ...byN.get(n), reason: `被回答引用 ${c} 次`, aiScore: Math.min(10, c * 3) }));
  return { query, ...kw, answer, summary: answer, sources, picks, results: all.map(({ n, title, url, snippet }) => ({ n, title, url, snippet })), steps, errors };
}
