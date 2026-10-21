// research.mjs - 需求 -> AI 提取关键词 -> 联网搜索 -> AI 筛选总结
import { aiConfigured, extractKeywords, summarize } from './ai.mjs';
import { searchMany } from './search.mjs';

export async function research(query, provider = 'default') {
  if (!aiConfigured(provider)) throw Object.assign(new Error(`AI provider "${provider}" not configured`), { status: 503 });
  const kw = await extractKeywords(query, provider);
  const { results, errors } = await searchMany(kw.queries);
  if (!results.length) return { query, ...kw, results: [], picks: [], summary: '没有搜索到结果', errors };
  const { summary, picks } = await summarize(query, results, provider);
  return { query, ...kw, summary, picks, results, errors };
}
