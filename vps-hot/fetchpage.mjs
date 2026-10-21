// fetchpage.mjs - 安全抓取网页并提取正文（零依赖）
import dns from 'dns/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileP = promisify(execFile);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
import net from 'net';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:') ;
}

async function resolvePublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s)');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(x => x.address);
  if (!ips.length || ips.some(isPrivateIp)) throw new Error('blocked: non-public address');
  return ips[0];
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };
const decode = s => s.replace(/&(#?\w+);/g, (m, k) => ENT[k] ?? (k[0] === '#' ? String.fromCodePoint(parseInt(k.slice(1), k[1] === 'x' ? 16 : 10) || 32) : m));

export function htmlToText(html) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim());
  let h = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe)[\s\S]*?<\/\1>/gi, ' ');
  const main = h.match(/<(article|main)[\s\S]*?<\/\1>/i);
  if (main && main[0].length > 800) h = main[0];
  h = h.replace(/<\/(p|div|li|h[1-6]|tr|br|section)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  const text = decode(h).replace(/[ \t\f\r]+/g, ' ').replace(/\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
  return { title, text };
}

// 很多站点按连接特征拦截 Node 的 fetch（403），系统 curl 正常。所以优先用 curl：
// 先自己解析并校验 IP（防 SSRF），再用 --resolve 固定到该 IP，重定向手动逐跳校验。
async function curlGet(u, ip, { timeoutMs, maxBytes }) {
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const args = ['-sS', '-m', String(Math.ceil(timeoutMs / 1000)), '--max-filesize', String(maxBytes), '-A', UA,
    '-H', 'Accept: text/html,text/plain;q=0.9,*/*;q=0.1', '-H', 'Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8',
    '-w', '\n%{http_code}\n%{content_type}\n%{redirect_url}']; 
  if (!net.isIPv6(ip)) args.push('--resolve', `${u.hostname}:${port}:${ip}`);
  args.push(u.toString());
  const { stdout } = await execFileP('curl', args, { encoding: 'buffer', maxBuffer: maxBytes + 4096 });
  const tail = stdout.subarray(Math.max(0, stdout.length - 600)).toString('utf8').split('\n');
  const [code, ctype, redirect] = tail.slice(-3);
  const bodyEnd = stdout.length - Buffer.byteLength(`\n${code}\n${ctype}\n${redirect}`);
  return { status: Number(code), ctype, redirect, body: stdout.subarray(0, bodyEnd).toString('utf8') };
}

// 兜底：Jina Reader（公开阅读代理）。会把目标 URL 发给第三方，FETCH_FALLBACK_JINA=0 可关闭
async function jinaRead(url, { timeoutMs, maxChars }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs + 8000);
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, { signal: ctrl.signal, headers: { Accept: 'text/plain' } });
    if (!res.ok) throw new Error(`reader HTTP ${res.status}`);
    const raw = await res.text();
    const title = raw.match(/^Title:\s*(.*)$/m)?.[1]?.trim() || '';
    const text = raw.replace(/^[\s\S]*?Markdown Content:\s*/, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
    return { url, title, text: text.slice(0, maxChars), via: 'reader' };
  } finally { clearTimeout(t); }
}

export async function fetchPage(url, { maxChars = 4000, timeoutMs = 12000, maxBytes = 1_000_000 } = {}) {
  let u = new URL(url);
  let lastErr;
  for (let hop = 0; hop < 4; hop++) {
    const ip = await resolvePublic(u);
    let r;
    try { r = await curlGet(u, ip, { timeoutMs, maxBytes }); }
    catch (e) { if (e.code === 'ENOENT') { r = await nodeGet(u, { timeoutMs, maxBytes }); } else { lastErr = e; break; } }
    if (r.status >= 300 && r.status < 400 && r.redirect) { u = new URL(r.redirect, u); continue; }
    if (r.status < 200 || r.status >= 300) { lastErr = new Error(`HTTP ${r.status}`); break; }
    if (!/text\/|html|xml|json/i.test(r.ctype)) { lastErr = new Error(`unsupported content-type ${r.ctype}`); break; }
    const { title, text } = /html/i.test(r.ctype) ? htmlToText(r.body) : { title: '', text: r.body };
    return { url: u.toString(), title, text: text.slice(0, maxChars), via: 'direct' };
  }
  if (process.env.FETCH_FALLBACK_JINA !== '0' && lastErr && !/blocked|unsupported/.test(lastErr.message)) {
    try { return await jinaRead(u.toString(), { timeoutMs, maxChars }); } catch (e) { lastErr = new Error(`${lastErr.message}; reader: ${e.message}`); }
  }
  throw lastErr || new Error('too many redirects');
}

// 没有 curl 时的回退：Node fetch（手动重定向）
async function nodeGet(u, { timeoutMs, maxBytes }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(u, { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' } });
    const redirect = res.status >= 300 && res.status < 400 ? res.headers.get('location') || '' : '';
    if (redirect || !res.ok) return { status: res.status, ctype: '', redirect, body: '' };
    const reader = res.body.getReader(); const chunks = []; let size = 0;
    while (size < maxBytes) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); size += value.length; }
    reader.cancel().catch(() => {});
    return { status: res.status, ctype: res.headers.get('content-type') || '', redirect: '', body: Buffer.concat(chunks).toString('utf8') };
  } finally { clearTimeout(t); }
}
