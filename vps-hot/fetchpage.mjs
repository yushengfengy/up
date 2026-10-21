// fetchpage.mjs - 安全抓取网页并提取正文（零依赖）
import dns from 'dns/promises';
import net from 'net';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:') ;
}

async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s)');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(x => x.address);
  if (!ips.length || ips.some(isPrivateIp)) throw new Error('blocked: non-public address');
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

export async function fetchPage(url, { maxChars = 4000, timeoutMs = 12000, maxBytes = 1_000_000 } = {}) {
  let u = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(u);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(u, { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; vps-hot/1.3)', Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = new URL(res.headers.get('location'), u); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      if (!/text\/|html|xml|json/i.test(ct)) throw new Error(`unsupported content-type ${ct}`);
      const reader = res.body.getReader();
      const chunks = []; let size = 0;
      while (size < maxBytes) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); size += value.length; }
      reader.cancel().catch(() => {});
      const raw = Buffer.concat(chunks).toString('utf8');
      const { title, text } = /html/i.test(ct) ? htmlToText(raw) : { title: '', text: raw };
      return { url: u.toString(), title, text: text.slice(0, maxChars) };
    } finally { clearTimeout(t); }
  }
  throw new Error('too many redirects');
}
