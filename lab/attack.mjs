// A fake attack on the lab Traefik, for the Shield page: a botnet of made-up addresses (sent as
// X-Forwarded-For, which the lab entry points trust) brute-forcing the login page, probing for files,
// flooding the shop and knocking on the admin, in two waves. Every few seconds the loudest bots get
// banned on the CrowdSec stand-in and go quiet, the way a firewall bouncer drops them.
//   node lab/attack.mjs [peak req/s, default 500] [seconds, default 80]
import http from 'node:http';
import https from 'node:https';

const peak = Number(process.argv[2] ?? 500);
const seconds = Number(process.argv[3] ?? 80);

// addresses from the benchmarking (198.18.0.0/15) and documentation ranges, so no real network is blamed
const COUNTRIES = ['RU', 'CN', 'BR', 'VN', 'IN', 'US', 'NL', 'DE', 'ID', 'TR', 'UA', 'KR', 'IR', 'RO'];
const AGENTS = ['python-requests/2.31.0', 'Go-http-client/1.1', 'curl/7.68.0', 'Mozilla/5.0 (compatible; MJ12bot/v1.4.8)', 'masscan/1.3', 'Mozilla/5.0 zgrab/0.x', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/91.0', 'Java/11.0.2'];
const ROLES = ['login', 'login', 'flood', 'flood', 'probe', 'admin'];
const SCENARIO = { login: 'crowdsecurity/http-generic-bf', flood: 'crowdsecurity/http-crawl-non_statics', probe: 'crowdsecurity/http-sensitive-files', admin: 'crowdsecurity/http-bad-user-agent' };

const bots = [];
for (let i = 0; i < 420; i++) {
  const net = (i * 37) % 250;
  const ip = i < 380 ? `198.18.${net}.${(i * 91) % 253 + 1}` : `203.0.113.${(i * 7) % 250 + 2}`;
  bots.push({ ip, cc: COUNTRIES[net % COUNTRIES.length], ua: AGENTS[(i * 5) % AGENTS.length], role: ROLES[i % ROLES.length], weight: 1 / Math.pow(i + 1, 0.85), sent: 0, banned: false });
}
// people in the office using the login page as usual, from the range the lab's bouncer lets through
const office = Array.from({ length: 6 }, (_, i) => ({ ip: `192.0.2.${20 + i}`, cc: 'GR', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) Safari/605.1', role: 'office', weight: 0, sent: 0 }));

const insecure = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 256 });
const keep = new http.Agent({ keepAlive: true, maxSockets: 256 });
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function target(role) {
  switch (role) {
    case 'login': return { tls: false, host: 'login.localhost', path: pick(['/login', '/login', '/wp-login.php', '/api/session']), method: 'POST' };
    case 'flood': return { tls: true, host: 'shop.localhost', path: pick(['/', '/products', '/cart', '/search?q=' + Math.random().toString(36).slice(2, 8)]), method: 'GET' };
    case 'probe': return { tls: false, host: pick(['203.0.113.10', 'old.example.test', 'mail.example.test']), path: pick(['/.env', '/.git/config', '/phpmyadmin/', '/xmlrpc.php', '/admin.php', '/vendor/phpunit/eval-stdin.php']), method: 'GET' };
    case 'admin': return { tls: false, host: 'admin.localhost', path: pick(['/', '/users', '/config']), method: 'GET' };
    case 'office': return { tls: false, host: 'login.localhost', path: '/login', method: Math.random() < 0.3 ? 'POST' : 'GET' };
    default: return { tls: true, host: 'api.localhost', path: '/v1/users', method: 'GET' };
  }
}

function fire(bot) {
  // most bots stick to their job; a fifth of the time they try something else
  const t = target(bot.role !== 'office' && Math.random() < 0.2 ? pick(['login', 'flood', 'probe', 'admin', 'api']) : bot.role);
  bot.sent++;
  const req = (t.tls ? https : http).request({
    host: '127.0.0.1', port: t.tls ? 8443 : 8081, path: t.path, method: t.method, servername: t.tls ? t.host : undefined,
    agent: t.tls ? insecure : keep, timeout: 4000,
    headers: { Host: t.host, 'X-Forwarded-For': bot.ip, 'CF-IPCountry': bot.cc, 'User-Agent': bot.ua, ...(t.method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': 27 } : {}) },
  }, (res) => res.resume());
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(t.method === 'POST' ? 'user=admin&password=123456' : undefined);
}

// two waves: a first push, a short lull, then the full flood, then it fades
function level(u) {
  if (u < 0.1) return 0.6 * (u / 0.1);
  if (u < 0.38) return 0.6 + 0.08 * Math.sin(u * 60);
  if (u < 0.45) return 0.2;
  if (u < 0.55) return 0.2 + 0.8 * ((u - 0.45) / 0.1);
  if (u < 0.88) return 1 + 0.1 * Math.sin(u * 80);
  return Math.max(0, 1 - (u - 0.88) / 0.12);
}

function pickBot() {
  let total = 0;
  for (const b of bots) if (!b.banned) total += b.weight;
  let r = Math.random() * total;
  for (const b of bots) { if (b.banned) continue; if ((r -= b.weight) <= 0) return b; }
  return bots.find((b) => !b.banned);
}

function ban(bot) {
  bot.banned = true;
  const body = JSON.stringify({ ip: bot.ip, scenario: SCENARIO[bot.role] });
  const req = http.request({ host: '127.0.0.1', port: 8095, path: '/lab/ban', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
  req.on('error', () => {});
  req.end(body);
}

const start = Date.now();
let carry = 0;
const loop = setInterval(() => {
  const u = (Date.now() - start) / (seconds * 1000);
  if (u >= 1) { clearInterval(loop); return; }
  carry += peak * level(u) * 0.05;
  for (; carry >= 1; carry--) { const b = pickBot(); if (b) fire(b); }
  for (const o of office) if (Math.random() < 0.03) fire(o);
}, 50);

const bans = setInterval(() => {
  if (Date.now() - start < 10_000) return;
  const loud = bots.filter((b) => !b.banned).sort((a, b) => b.sent - a.sent).slice(0, 5);
  for (const b of loud) ban(b);
}, 4000);

const report = setInterval(() => {
  const s = Math.round((Date.now() - start) / 1000);
  const sent = bots.reduce((n, b) => n + b.sent, 0);
  console.log(`${s}s  ${Math.round(peak * level(s / seconds))} req/s  ${sent} sent  ${bots.filter((b) => b.banned).length} banned`);
  if (s >= seconds) { clearInterval(report); clearInterval(bans); setTimeout(() => process.exit(0), 1500); }
}, 5000);
console.log(`attacking the lab for ${seconds}s, peak ${peak} req/s, ${bots.length} bots`);
