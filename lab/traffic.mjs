// Steady, uneven traffic through the lab Traefik so every chart has something to show: busy and quiet
// sites, redirects, 401s, 403s, 404s, 500s, slow pages, a mirrored service and the odd TCP and UDP hit.
//   node lab/traffic.mjs [requests per second, default 25]
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dgram from 'node:dgram';

const rps = Number(process.argv[2] ?? 25);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const weighted = (pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[0][0];
};

const targets = [
  [{ tls: true, host: 'shop.localhost', paths: ['/', '/products', '/cart', '/slow/checkout', '/missing', '/error'] }, 40],
  [{ tls: false, host: 'shop.localhost', paths: ['/', '/products'] }, 6],
  [{ tls: true, host: 'www.shop.localhost', paths: ['/', '/sale'] }, 3],
  [{ tls: true, host: 'api.localhost', paths: ['/v1/users', '/v1/orders', '/v1/slow/report', '/v1/missing', '/health'] }, 25],
  [{ tls: false, host: 'api.localhost', paths: ['/v1/users', '/health'] }, 6],
  [{ tls: false, host: 'admin.localhost', paths: ['/', '/users'], auth: true }, 4],
  [{ tls: false, host: 'admin.localhost', paths: ['/'] }, 2],
  [{ tls: false, host: 'blog.localhost', paths: ['/', '/posts/hello', '/posts/error'], headers: { 'X-Preview': '1' } }, 6],
  [{ tls: false, host: 'blog.localhost', paths: ['/posts/hello'] }, 1],
  [{ tls: false, host: 'status.localhost', paths: ['/', '/health'] }, 3],
  [{ tls: false, host: 'mirror.localhost', paths: ['/', '/products'] }, 3],
  [{ tls: false, host: 'unknown.localhost', paths: ['/'] }, 1],
];
const agents = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1', 'curl/8.9.1', 'Googlebot/2.1', 'python-requests/2.32'];
const insecure = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const keep = new http.Agent({ keepAlive: true });

function fire() {
  const t = weighted(targets);
  const path = pick(t.paths);
  const headers = { Host: t.host, 'User-Agent': pick(agents), ...(t.headers ?? {}) };
  if (t.auth) headers.Authorization = 'Basic ' + Buffer.from('admin:enodia').toString('base64');
  const lib = t.tls ? https : http;
  const req = lib.request({
    host: '127.0.0.1', port: t.tls ? 8443 : 8081, path, method: Math.random() < 0.1 ? 'POST' : 'GET', headers,
    agent: t.tls ? insecure : keep, servername: t.host, timeout: 5000,
  }, (res) => res.resume());
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end();
}

setInterval(() => {
  // bursts now and then, so the charts are not a flat line
  const n = Math.max(1, Math.round((rps / 10) * (Math.random() < 0.05 ? 6 : 0.5 + Math.random())));
  for (let i = 0; i < n; i++) fire();
}, 100);

setInterval(() => {
  const s = net.connect(15432, '127.0.0.1', () => { s.write('ping'); setTimeout(() => s.end(), 200); });
  s.on('error', () => {});
  const u = dgram.createSocket('udp4');
  u.send('query', 15353, '127.0.0.1', () => setTimeout(() => u.close(), 200));
}, 2000);

console.log(`lab traffic: about ${rps} requests a second`);
