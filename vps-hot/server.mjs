// server.mjs - HTTP 服务，无依赖
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { collectOnce } from './collector.mjs';
import { research } from './research.mjs';
import { aiConfigured, listProviders, addProvider, removeProvider } from './ai.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'items.json');
const STATUS_FILE = path.join(DATA_DIR, 'sources_status.json');

const PORT = parseInt(process.env.PORT || '8080', 10);
const TOKEN = process.env.INGEST_TOKEN || '';
const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || '';

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveJson(p, obj) {
  if (!fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function htmlPage(items, status) {
  const rows = items.slice(0, 100).map(it => {
    const age = Math.round((Date.now() - new Date(it.createdAt).getTime())/3600000);
    return `<div class="item">
      <div class="score">${it.score}</div>
      <div class="main">
        <a href="${it.url}" target="_blank" rel="noopener">${escapeHtml(it.title)}</a>
        <div class="meta">${it.source} · ${age}h ago · ${escapeHtml(it.description||'').slice(0,120)}</div>
      </div>
    </div>`;
  }).join('');

  const srcRows = Object.entries(status).map(([id, s]) => {
    const color = s.error ? '#ef4444' : s.enabled === false ? '#9ca3af' : '#22c55e';
    const text = s.enabled === false ? '暂停' : s.error ? s.error : `OK ${s.lastCount||0}/${s.lastTotal||0}`;
    return `<tr><td>${id}</td><td><span style="color:${color}">●</span> ${text}</td><td>${s.lastFetch||'-'}</td></tr>`;
  }).join('');

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>vps-hot - VPS 热点聚合</title>
<style>
body{font-family:ui-sans,system-ui, -apple-system; max-width:900px; margin:0 auto; padding:20px; background:#fafafa; color:#111}
h1{font-size:24px} .item{display:flex; gap:12px; padding:12px; background:#fff; border:1px solid #eee; border-radius:10px; margin:8px 0}
.score{min-width:42px; height:32px; background:#111; color:#fff; display:grid; place-items:center; border-radius:8px; font-weight:600}
.main a{font-weight:600; color:#111; text-decoration:none} .main a:hover{text-decoration:underline}
.meta{font-size:12px; color:#666; margin-top:4px}
table{width:100%; border-collapse:collapse; font-size:13px; margin-top:12px}
td,th{border:1px solid #eee; padding:6px 8px; text-align:left; background:#fff}
.badge{display:inline-block; padding:2px 8px; border-radius:999px; background:#e5e7eb; font-size:12px; margin-right:6px}
code{background:#eee; padding:2px 6px; border-radius:6px}
</style></head><body>
<h1>vps-hot 🔥 <span class="badge">${items.length} 条</span></h1>
<p>聚合 LowEndBox / LowEndTalk / NodeSeek / Reddit VPS 板块。分数按 <code>rules.json</code> 规则 + 时间半衰期计算。
<a href="/rss">RSS</a> · <a href="/api/items">/api/items</a> · <a href="/api/sources">/api/sources</a></p>
<h2>AI 研究</h2>
<form id="rf" style="display:flex;gap:8px;flex-wrap:wrap"><input id="rq" placeholder="输入需求，如：找适合跑 Docker 的便宜日本 VPS" style="flex:1;min-width:240px;padding:8px"/><input id="rt" type="password" placeholder="Token(如已设置)" style="width:140px;padding:8px"/><select id="rp" style="padding:8px"><option value="default">内置 AI</option></select><select id="rd" style="padding:8px"><option value="1">深度1</option><option value="2" selected>深度2</option><option value="3">深度3</option></select><input id="ra" placeholder="限定域名(逗号分隔,可空)" style="width:200px;padding:8px"/><button style="padding:8px 16px">分析并搜索</button></form>
<details style="margin:8px 0"><summary>AI 提供商管理（需 Token）</summary>
<div id="pl" class="meta" style="margin:6px 0"></div>
<form id="pf" style="display:flex;gap:6px;flex-wrap:wrap"><input name="id" placeholder="id 如 mine" style="width:90px;padding:6px"/><input name="baseUrl" placeholder="https://api.xxx.com/v1" style="flex:1;min-width:200px;padding:6px"/><input name="apiKey" type="password" placeholder="API Key" style="width:150px;padding:6px"/><input name="model" placeholder="model" style="width:130px;padding:6px"/><button>添加/更新</button></form></details>
<div id="ro" style="margin:12px 0"></div>
<script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safe=u=>/^https?:\/\//i.test(u)?u:'#';
const tok=()=>document.getElementById('rt').value;
const ah=()=>tok()?{Authorization:'Bearer '+tok()}:{};
async function loadP(){try{const r=await fetch('/api/providers',{headers:ah()});const j=await r.json();if(!r.ok)throw new Error(j.error);
document.getElementById('rp').innerHTML=j.providers.filter(p=>p.configured).map(p=>'<option value="'+esc(p.id)+'">'+esc(p.builtin?'内置 AI':p.name)+' · '+esc(p.model)+'</option>').join('');
document.getElementById('pl').innerHTML=j.providers.map(p=>esc(p.id)+' · '+esc(p.baseUrl)+' · '+esc(p.model)+' · '+esc(p.apiKey)+(p.builtin?'':' <a href="#" data-del="'+esc(p.id)+'">删除</a>')).join('<br>')}catch(e){document.getElementById('pl').textContent='需要有效 Token：'+e.message}}
document.getElementById('rt').onchange=loadP;
document.getElementById('pl').onclick=async e=>{const id=e.target.dataset?.del;if(!id)return;e.preventDefault();await fetch('/api/providers?id='+encodeURIComponent(id),{method:'DELETE',headers:ah()});loadP()};
document.getElementById('pf').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));const r=await fetch('/api/providers',{method:'POST',headers:{'Content-Type':'application/json',...ah()},body:JSON.stringify(f)});const j=await r.json();if(!r.ok)alert(j.error);else{e.target.reset();loadP()}};
document.getElementById('rf').onsubmit=async e=>{e.preventDefault();const o=document.getElementById('ro');o.textContent='分析中...';
try{const t=document.getElementById('rt').value;const r=await fetch('/api/research',{method:'POST',headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:JSON.stringify({query:document.getElementById('rq').value,provider:document.getElementById('rp').value,depth:+document.getElementById('rd').value,allowed_domains:document.getElementById('ra').value.split(',').map(s=>s.trim()).filter(Boolean).slice(0,5)})});
const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);
o.innerHTML='<p><b>意图：</b>'+esc(j.intent)+'</p><p><b>关键词：</b>'+j.keywords.map(k=>'<span class="badge">'+esc(k)+'</span>').join('')+'</p><div style="white-space:pre-wrap;background:#fff;border:1px solid #eee;border-radius:10px;padding:12px">'+esc(j.answer||j.summary)+'</div><p><b>来源：</b></p>'+(j.sources||[]).map(s=>'<div class="meta">['+s.n+'] <a href="'+esc(safe(s.url))+'" target="_blank" rel="noopener">'+esc(s.title)+'</a>'+(s.read?' · 已阅读':'')+'</div>').join('')+'<details><summary>研究过程</summary><pre style="font-size:12px;white-space:pre-wrap">'+esc(JSON.stringify(j.steps,null,1))+'</pre></details>'+j.picks.map(p=>'<div class="item"><div class="score">'+esc(p.aiScore)+'</div><div class="main"><a href="'+esc(safe(p.url))+'" target="_blank" rel="noopener">'+esc(p.title)+'</a><div class="meta">'+esc(p.reason)+'</div></div></div>').join('');
}catch(err){o.textContent='错误：'+err.message}};
</script>
<div>${rows || '<p>正在抓取中，稍后刷新...</p>'}</div>
<h2>来源状态</h2>
<table><tr><th>来源</th><th>状态</th><th>最后抓取</th></tr>${srcRows}</table>
<footer style="margin-top:24px; font-size:12px; color:#999">PORT=${PORT} · data卷: ${DATA_DIR} · 试用地址仅限自己IP可访问，Railway部署后公开</footer>
</body></html>`;
}
function escapeHtml(s){ return s.replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const items = loadJson(DATA_FILE, []);
      const status = loadJson(STATUS_FILE, {});
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage(items, status));
    } else if (url.pathname === '/rss') {
      const items = loadJson(DATA_FILE, []).slice(0, 50);
      const rss = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>vps-hot</title><link>https://${PUBLIC_DOMAIN || req.headers.host}</link><description>VPS热点聚合</description>${items.map(it=>`<item><title><![CDATA[${it.title}]]></title><link>${it.url}</link><guid>${it.url}</guid><pubDate>${new Date(it.createdAt).toUTCString()}</pubDate><description><![CDATA[${it.description||''} score:${it.score} source:${it.source}]]></description></item>`).join('')}</channel></rss>`;
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
      res.end(rss);
    } else if (url.pathname === '/api/items') {
      const items = loadJson(DATA_FILE, []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: items.length, items }, null, 2));
    } else if (url.pathname === '/api/sources') {
      const status = loadJson(STATUS_FILE, {});
      const sources = loadJson(path.join(__dirname, 'sources.json'), []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sources, status }, null, 2));
    } else if (url.pathname === '/api/providers') {
      // 提供商管理：必须设置 INGEST_TOKEN 且鉴权通过（含 API key，不可匿名）
      const authed = TOKEN && (req.headers.authorization || '') === `Bearer ${TOKEN}`;
      const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (!authed) return send(TOKEN ? 401 : 403, { error: TOKEN ? 'unauthorized' : 'set INGEST_TOKEN to manage providers' });
      try {
        if (req.method === 'GET') return send(200, { providers: listProviders() });
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 20000) break; }
        const j = JSON.parse(body || '{}');
        if (req.method === 'POST') { addProvider(j); return send(200, { ok: true, providers: listProviders() }); }
        if (req.method === 'DELETE') return send(removeProvider(String(j.id || url.searchParams.get('id') || '')) ? 200 : 404, { ok: true, providers: listProviders() });
        send(405, { error: 'method not allowed' });
      } catch (e) { send(e.status || 400, { error: e.message }); }
    } else if (url.pathname === '/api/research' && req.method === 'POST') {
      // 会消耗 AI/搜索额度：设置了 INGEST_TOKEN 就必须鉴权
      if (TOKEN && (req.headers.authorization || '') !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 20000) break; }
      let q = '';
      let ropts = {};
      try { const j = JSON.parse(body || '{}'); q = String(j.query || '').trim(); ropts = { provider: String(j.provider || 'default'), depth: j.depth, allowed_domains: j.allowed_domains, excluded_domains: j.excluded_domains }; } catch {}
      if (!q) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'query required' })); return; }
      try {
        const out = await research(q.slice(0, 2000), ropts);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out, null, 2));
      } catch (e) {
        res.writeHead(e.status || 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    } else if (url.pathname === '/api/ingest' && req.method === 'POST') {
      if (TOKEN) {
        const auth = req.headers.authorization || '';
        if (auth !== `Bearer ${TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const incoming = JSON.parse(body || '{}');
      const list = Array.isArray(incoming) ? incoming : incoming.items || [incoming];
      const existing = loadJson(DATA_FILE, []);
      let added = 0;
      for (const it of list) {
        if (!it.title || !it.url) continue;
        if (existing.some(e=> e.url===it.url)) continue;
        existing.push({ id: `ingest:${Date.now()}:${added}`, title: it.title, url: it.url, source: it.source||'ingest', score: it.score||20, rawScore: it.score||20, createdAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), description: it.description||'' });
        added++;
      }
      saveJson(DATA_FILE, existing.slice(-500));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, added }));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('error: '+e.message);
  }
});

server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}  token:${TOKEN?'set':'none'}  ai:${aiConfigured()?'on':'off'}  domain:${PUBLIC_DOMAIN||'local'}`);
  // 启动立即抓一次
  collectOnce().catch(console.error);
});

// 每5分钟检查到期来源
setInterval(() => {
  collectOnce().catch(console.error);
}, 5 * 60 * 1000);
