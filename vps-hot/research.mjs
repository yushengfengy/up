// research.mjs - 需求 -> AI 提取关键词 -> 联网搜索 -> AI 筛选总结
import { aiConfigured, extractKeywords, summarize } from './ai.mjs';
import { searchMany } from './search.mjs';

export async function research(query) {
  if (!aiConfigured()) throw Object.assign(new Error('AI not configured: set AI_API_KEY (and AI_BASE_URL / AI_MODEL)'), { status: 503 });
  const kw = await extractKeywords(query);
  const { results, errors } = await searchMany(kw.queries);
  if (!results.length) return { query, ...kw, results: [], picks: [], summary: '没有搜索到结果', errors };
  const { summary, picks } = await summarize(query, results);
  return { query, ...kw, summary, picks, results, errors };
}
