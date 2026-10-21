// collector.mjs - 无依赖采集器
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'items.json');
const STATUS_FILE = path.join(DATA_DIR, 'sources_status.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function normalizeTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim().slice(0, 80);
}

function scoreTitle(title, sourceId, rules) {
  let score = 10; // base
  const weight = rules.sourceWeight?.[sourceId] ?? rules.sourceWeight?.default ?? 1.0;
  score *= weight;
  
  for (const r of rules.positiveRules || []) {
    try {
      const re = new RegExp(r.pattern, r.flags || 'i');
      if (re.test(title)) score += r.score;
    } catch {}
  }
  for (const r of rules.negativeRules || []) {
    try {
      const re = new RegExp(r.pattern, r.flags || 'i');
      if (re.test(title)) score += r.score;
    } catch {}
  }
  return Math.round(score * 10) / 10;
}

function decayScore(score, createdAt, halfLifeHours) {
  const ageH = (Date.now() - new Date(createdAt).getTime()) / 3600000;
  const factor = Math.pow(0.5, ageH / halfLifeHours);
  return Math.round(score * factor * 10) / 10;
}

async function fetchWithRetry(url, opts = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        throw err;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (e.status === 429) {
        // 429 退避更久
        await new Promise(r => setTimeout(r, 5000 + i * 5000));
      } else {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

function parseRss(xml) {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i');
      const mm = block.match(re);
      return mm ? mm[1].trim().replace(/<!\[CDATA\[|\]\]>/g, '') : '';
    };
    const title = get('title');
    const link = get('link') || get('guid');
    const pubDate = get('pubDate') || get('dc:date') || new Date().toISOString();
    const desc = get('description') || '';
    if (title && link) items.push({ title, url: link, pubDate, description: desc });
  }
  return items;
}

function parseJsonList(json) {
  // 支持多种格式，自动探测
  const arr = Array.isArray(json) ? json : json.items || json.data || json.list || [];
  return arr.map(o => ({
    title: o.title || o.name || '',
    url: o.url || o.link || o.href || '',
    pubDate: o.pubDate || o.date || o.created_at || new Date().toISOString(),
    description: o.description || o.summary || ''
  })).filter(x => x.title && x.url);
}

function parseWebList(html, baseUrl) {
  const items = [];
  // 极简实现：抓取所有 <a> 标签，过滤长度
  const aRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]{5,120})<\/a>/gi;
  let m;
  while ((m = aRegex.exec(html)) !== null) {
    let href = m[1];
    const title = m[2].trim();
    if (href.startsWith('/')) {
      try { href = new URL(href, baseUrl).toString(); } catch {}
    }
    if (!href.startsWith('http')) continue;
    if (title.length < 8) continue;
    // 过滤导航类
    if (/登录|注册|首页|导航|login|home/i.test(title)) continue;
    items.push({ title, url: href, pubDate: new Date().toISOString(), description: '' });
    if (items.length > 30) break;
  }
  return items;
}

export async function collectOnce() {
  const sources = loadJson(path.join(__dirname, 'sources.json'), []);
  const rules = loadJson(path.join(__dirname, 'rules.json'), { minScore: 0, halfLifeHours: 24 });
  const existing = loadJson(DATA_FILE, []);
  const status = loadJson(STATUS_FILE, {});

  const now = Date.now();
  const domainLastFetch = new Map(); // 简单限速
  let allItems = [...existing];

  for (const src of sources) {
    if (!src.enabled) {
      status[src.id] = { ...status[src.id], enabled: false, lastCheck: new Date().toISOString() };
      continue;
    }
    const last = status[src.id]?.lastFetch ? new Date(status[src.id].lastFetch).getTime() : 0;
    const intervalMs = (src.interval_minutes || 60) * 60 * 1000;
    if (now - last < intervalMs) continue;

    // 域限速：同域至少间隔 5s
    try {
      const domain = new URL(src.url).hostname;
      const lastDomain = domainLastFetch.get(domain) || 0;
      if (now - lastDomain < 5000) {
        await new Promise(r => setTimeout(r, 5000 - (now - lastDomain)));
      }
    } catch {}

    console.log(`[collect] ${src.id} ${src.type} ${src.url}`);
    try {
      const headers = { 'User-Agent': 'vps-hot/1.2 (+https://github.com/)', ...(src.headers || {}) };
      const res = await fetchWithRetry(src.url, { headers });
      const text = await res.text();
      
      let rawItems = [];
      if (src.type === 'rss') rawItems = parseRss(text);
      else if (src.type === 'json_list') rawItems = parseJsonList(JSON.parse(text));
      else if (src.type === 'web_list') rawItems = parseWebList(text, src.url);
      
      domainLastFetch.set(new URL(src.url).hostname, Date.now());

      let newCount = 0;
      for (const ri of rawItems) {
        const score = scoreTitle(ri.title, src.id, rules);
        if (score < (rules.minScore ?? 0)) continue;
        const id = `${src.id}:${normalizeTitle(ri.title)}`; // 聚簇ID
        const item = {
          id,
          title: ri.title.trim(),
          url: ri.url,
          source: src.id,
          score,
          rawScore: score,
          createdAt: new Date(ri.pubDate).toISOString(),
          fetchedAt: new Date().toISOString(),
          description: (ri.description || '').slice(0, 300)
        };
        // 去重：同URL或同聚簇ID
        const existsIdx = allItems.findIndex(x => x.url === item.url || x.id === item.id);
        if (existsIdx >= 0) {
          // 保留分数高的
          if (item.score > allItems[existsIdx].score) allItems[existsIdx] = item;
        } else {
          allItems.push(item);
          newCount++;
        }
      }
      // 按标题聚簇去重：相似标题只留最高分
      const clusterMap = new Map();
      for (const it of allItems) {
        const key = normalizeTitle(it.title);
        if (!clusterMap.has(key) || clusterMap.get(key).score < it.score) clusterMap.set(key, it);
      }
      allItems = Array.from(clusterMap.values());

      status[src.id] = {
        enabled: true,
        lastFetch: new Date().toISOString(),
        lastCount: newCount,
        lastTotal: rawItems.length,
        error: null,
        lastCheck: new Date().toISOString()
      };
    } catch (e) {
      console.error(`[collect] ${src.id} failed:`, e.message);
      status[src.id] = {
        ...status[src.id],
        lastCheck: new Date().toISOString(),
        error: `${e.status || ''} ${e.message}`.trim(),
        lastFetch: status[src.id]?.lastFetch || null
      };
    }
  }

  // 按分数+时间排序，衰减分数
  const halfLife = loadJson(path.join(__dirname, 'rules.json'), {}).halfLifeHours || 24;
  for (const it of allItems) {
    it.score = decayScore(it.rawScore || it.score, it.createdAt, halfLife);
  }
  allItems.sort((a, b) => b.score - a.score || new Date(b.createdAt) - new Date(a.createdAt));
  // 只保留最近500条
  allItems = allItems.slice(0, 500);

  saveJson(DATA_FILE, allItems);
  saveJson(STATUS_FILE, status);
  console.log(`[collect] done, total ${allItems.length}`);
  return { items: allItems, status };
}

// CLI 直接运行
if (import.meta.url === `file://${process.argv[1]}`) {
  collectOnce().then(() => process.exit(0));
}
