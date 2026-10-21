// search.mjs - web search providers (zero deps)
// SEARCH_PROVIDER: tavily | brave | serper | searxng | duckduckgo | bing | auto (default: duckduckgo -> bing, 免 key)
// Keys: SEARCH_API_KEY ; SEARXNG_URL for searxng
async function getJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`search HTTP ${res.status}`);
    return res;
  } finally { clearTimeout(t); }
}
const norm = (title, url, snippet) => ({ title: String(title || '').trim(), url: String(url || ''), snippet: String(snippet || '').trim() });

const strip = s => (s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').trim();

const providers = {
  async bing(q, n) {
    const r = await getJson(`https://www.bing.com/search?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    });
    const html = await r.text();
    const out = [];
    for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)) {
      const blk = m[0].replace(/<link[^>]*>/g, '');
      const a = blk.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      let href = a[1].replace(/&amp;/g, '&');
      const u = href.match(/[?&]u=a1([^&]+)/);
      if (u) { try { href = Buffer.from(u[1], 'base64url').toString('utf8'); } catch {} }
      if (!/^https?:\/\//.test(href)) continue;
      const p = blk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      out.push(norm(strip(a[2]), href, strip(p?.[1])));
      if (out.length >= n) break;
    }
    return out;
  },
  async tavily(q, n) {
    const r = await getJson('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SEARCH_API_KEY}` },
      body: JSON.stringify({ query: q, max_results: n }),
    });
    return ((await r.json()).results || []).map(x => norm(x.title, x.url, x.content));
  },
  async brave(q, n) {
    const r = await getJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`, {
      headers: { 'X-Subscription-Token': process.env.SEARCH_API_KEY, Accept: 'application/json' },
    });
    return ((await r.json()).web?.results || []).map(x => norm(x.title, x.url, x.description));
  },
  async serper(q, n) {
    const r = await getJson('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SEARCH_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, num: n }),
    });
    return ((await r.json()).organic || []).map(x => norm(x.title, x.link, x.snippet));
  },
  async searxng(q, n) {
    const base = (process.env.SEARXNG_URL || '').replace(/\/+$/, '');
    if (!base) throw new Error('SEARXNG_URL not set');
    const r = await getJson(`${base}/search?q=${encodeURIComponent(q)}&format=json`);
    return ((await r.json()).results || []).slice(0, n).map(x => norm(x.title, x.url, x.content));
  },
  async duckduckgo(q, n) {
    const r = await getJson('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0 (compatible; vps-hot/1.3)' },
      body: `q=${encodeURIComponent(q)}`,
    });
    const html = await r.text();
    const out = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
    let m;
    while ((m = re.exec(html)) && out.length < n) {
      let href = m[1];
      const u = href.match(/uddg=([^&]+)/);
      if (u) href = decodeURIComponent(u[1]);
      if (href.startsWith('//')) href = 'https:' + href;
      out.push(norm(strip(m[2]), href, strip(m[3])));
    }
    return out;
  },
};

export async function webSearch(query, n = 8) {
  const name = (process.env.SEARCH_PROVIDER || 'auto').toLowerCase();
  if (name === 'auto') {
    for (const k of ['duckduckgo', 'bing']) {
      try { const r = await providers[k](query, n); if (r.length) return r; } catch {}
    }
    return [];
  }
  const fn = providers[name];
  if (!fn) throw new Error(`unknown SEARCH_PROVIDER: ${name}`);
  return fn(query, n);
}

export async function searchMany(queries, perQuery = 8) {
  const settled = await Promise.allSettled(queries.map(q => webSearch(q, perQuery)));
  const seen = new Set();
  const results = [];
  const errors = [];
  for (const s of settled) {
    if (s.status === 'rejected') { errors.push(s.reason.message); continue; }
    for (const r of s.value) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      results.push(r);
    }
  }
  return { results: results.slice(0, 30), errors };
}
