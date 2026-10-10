// Tiny backends for the lab Traefik: a few HTTP apps with a mix of fast, slow and failing pages,
// a TCP echo standing in for Postgres and a UDP echo standing in for DNS. Ports 9198 and 9199 are
// left free on purpose: the lab's "down" servers point there.
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';

const apps = { 9101: 'shop-a', 9102: 'shop-b', 9103: 'api', 9104: 'api-next', 9105: 'blog' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [port, name] of Object.entries(apps)) {
  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') return res.end('ok');
    if (url.pathname.startsWith('/slow')) await sleep(300 + Math.random() * 1500);
    if (url.pathname.startsWith('/error') || (name === 'shop-b' && Math.random() < 0.03)) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end(`${name} failed`);
    }
    if (url.pathname.startsWith('/missing')) { res.writeHead(404); return res.end('not found'); }
    if (/^\/[45]\d\d\.html$/.test(url.pathname)) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<h1>${url.pathname}</h1>`); }
    await sleep(5 + Math.random() * 60);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ app: name, path: url.pathname, at: Date.now(), pad: 'x'.repeat(Math.floor(Math.random() * 4000)) }));
  }).listen(Number(port), '127.0.0.1');
}

net.createServer((s) => s.pipe(s)).listen(9110, '127.0.0.1');
const udp = dgram.createSocket('udp4');
udp.on('message', (msg, rinfo) => udp.send(msg, rinfo.port, rinfo.address));
udp.bind(9153, '127.0.0.1');

console.log('lab backends up: http 9101-9105, tcp 9110, udp 9153');
