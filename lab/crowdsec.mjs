// A stand-in for CrowdSec's Local API, enough for Enodia's Shield page: the bouncer decisions stream,
// a community blocklist, and a lab-only POST /lab/ban that lab/attack.mjs uses to ban its loudest bots.
//   node lab/crowdsec.mjs     (http://127.0.0.1:8095, bouncer key "lab")
import http from 'node:http';

const KEY = 'lab';
let nextId = 1;
const decisions = [];   // { id, value, scope, type, origin, scenario, until }
const fresh = [];       // ids not yet handed out on the stream

const add = (d, hours = 4) => {
  const x = { id: nextId++, scope: 'Ip', type: 'ban', origin: 'crowdsec', ...d, until: Date.now() + hours * 3600_000 };
  decisions.push(x);
  fresh.push(x.id);
  return x;
};
const go = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`; };
const wire = (d) => ({ id: d.id, value: d.value, scope: d.scope, type: d.type, origin: d.origin, scenario: d.scenario, duration: go(d.until - Date.now()) });

// a community blocklist, as CrowdSec's central API sends it (benchmarking range, nobody real)
for (let i = 0; i < 1500; i++) add({ value: `198.19.${(i * 7) % 256}.${(i * 13) % 254 + 1}`, origin: 'CAPI', scenario: 'crowdsecurity/community-blocklist' }, 24);
// and a few bans from earlier today
for (const [value, scenario] of [['203.0.113.45', 'crowdsecurity/http-probing'], ['203.0.113.77', 'crowdsecurity/http-bad-user-agent'], ['198.18.250.9', 'crowdsecurity/ssh-bf']]) add({ value, scenario }, 3);
fresh.length = 0;

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://lab');
  if (u.pathname === '/lab/ban' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { ip, scenario } = JSON.parse(body || '{}');
      if (ip && !decisions.some((d) => d.value === ip && d.origin === 'crowdsec')) add({ value: ip, scenario: scenario || 'crowdsecurity/http-flood' });
      res.end('ok');
    });
    return;
  }
  if (req.headers['x-api-key'] !== KEY) { res.writeHead(403); res.end(JSON.stringify({ message: 'access forbidden' })); return; }
  if (u.pathname === '/v1/decisions/stream') {
    const live = decisions.filter((d) => d.until > Date.now());
    const startup = u.searchParams.get('startup') === 'true';
    const list = startup ? live : live.filter((d) => fresh.includes(d.id));
    fresh.length = 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ new: list.length ? list.map(wire) : null, deleted: null }));
    return;
  }
  res.writeHead(404); res.end('{}');
}).listen(8095, '127.0.0.1', () => console.log('crowdsec stand-in on http://127.0.0.1:8095 (bouncer key "lab")'));
