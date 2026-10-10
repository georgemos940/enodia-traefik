// Enodia: a dashboard for Traefik. One process, no dependencies, no database.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';
import { state, history, onChange, startPolling } from './traefik.mjs';
import { metrics, scrape, seriesFor, seriesKeys, top } from './metrics.mjs';
import { logs, startTailing, onLines, query, stats, histogram, recent } from './logs.mjs';
import { diagnose, healthScore } from './diagnostics.mjs';
import { authMode, whoIs, login, logoutCookie, tooManyAttempts } from './auth.mjs';
import { get } from './http.mjs';
import { updates, onUpdate, startUpdateChecks, checkNow } from './updates.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '..', 'public');
const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8'));

// ── live state ───────────────────────────────────────────────────────────────

let findings = [];
let findingsKey = '';
const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

const notified = new Set();
function notify(list) {
  if (!config.webhookUrl) return;
  const fresh = list.filter((f) => f.severity === 'critical' && !notified.has(f.id));
  for (const f of list) if (f.severity === 'critical') notified.add(f.id);
  for (const id of [...notified]) if (!list.some((f) => f.id === id)) notified.delete(id);
  if (!fresh.length) return;
  const text = fresh.map((f) => `• ${f.title}${f.detail ? ` - ${f.detail}` : ''}`).join('\n').slice(0, 1900);
  const name = config.instanceName || 'Traefik';
  const body = JSON.stringify({ content: `**Enodia · ${name}**\n${text}`, text: `Enodia · ${name}\n${text}` });
  const u = new URL(config.webhookUrl);
  const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
  req.on('error', (e) => console.error('[enodia] webhook failed:', e.message));
  req.end(body);
}
function refreshFindings() {
  findings = diagnose();
  const key = findings.map((f) => `${f.id}|${f.title}`).join('\n');
  if (key !== findingsKey) {
    findingsKey = key;
    broadcast('diagnostics', { findings, score: healthScore(findings) });
    notify(findings);
  }
}

onChange(({ events, changed }) => {
  if (changed) broadcast('state', publicState());
  if (events.length) broadcast('history', events.map((e, i) => history[history.length - events.length + i]));
  refreshFindings();
});

const pending = [];
onLines((lines) => { pending.push(...lines); });
setInterval(() => {
  if (!pending.length) return;
  broadcast('logs', pending.splice(0, 500));
  pending.length = 0;
}, 1000).unref();

// for the sidebar: how many certificates expire soon, without sending the list every scrape
function certSummary() {
  const now = Date.now(), day = 86400000;
  const left = metrics.certs.map((c) => (Date.parse(c.notAfter) - now) / day);
  return { total: left.length, warn: left.filter((d) => d < config.certWarnDays).length, critical: left.filter((d) => d < config.certCriticalDays).length };
}

async function scrapeLoop() {
  const latest = await scrape();
  if (latest) broadcast('metrics', { t: Date.now(), latest, gauges: metrics.gauges, totals: metrics.totals, certs: certSummary() });
  refreshFindings();
  setTimeout(scrapeLoop, config.pollSeconds * 1000);
}

function publicState() {
  return { ...state, history: undefined };
}

function meta() {
  return {
    name: 'Enodia',
    version: pkg.version,
    instanceName: config.instanceName,
    pollSeconds: config.pollSeconds,
    historyMinutes: config.historyMinutes,
    traefikApi: config.traefik.apiUrl,
    features: {
      metrics: metrics.enabled,
      logs: logs.enabled,
      persistentHistory: Boolean(config.dataDir),
      webhook: Boolean(config.webhookUrl),
      updateCheck: updates.enabled,
    },
    install: updates.installMethod,
    updates,
    auth: authMode,
    certWarnDays: config.certWarnDays,
    certCriticalDays: config.certCriticalDays,
  };
}

// ── http ─────────────────────────────────────────────────────────────────────

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isBuf || typeof body === 'string' ? headers['Content-Type'] ?? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function serveStatic(req, res, rel) {
  let file = path.resolve(publicDir, '.' + decodeURIComponent(rel));
  if (!file.startsWith(publicDir)) return send(res, 404, 'not found');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(publicDir, 'index.html');
  const st = fs.statSync(file);
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, SECURITY_HEADERS); return res.end(); }
  let body = fs.readFileSync(file);
  const ext = path.extname(file);
  if (file.endsWith('index.html')) body = Buffer.from(body.toString('utf8').replace('<base href="/">', `<base href="${config.basePath}/">`));
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[ext] ?? 'application/octet-stream', ETag: etag, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
  res.end(body);
}

const readBody = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 10_000) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
});

const ip = (req) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?';
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
// the access-log filters every /api/logs* endpoint takes
const logFilters = (q) => ({ q: q.get('q') ?? '', status: q.get('status') ?? '', router: q.get('router') ?? '', service: q.get('service') ?? '', client: q.get('client') ?? '', host: q.get('host') ?? '', method: q.get('method') ?? '', minMs: num(q.get('minMs'), 0) });

// Only the read-only parts of the Traefik API go through the raw explorer.
const RAW_ALLOWED = /^\/api\/(overview|version|rawdata|entrypoints(\/[^/]+)?|(http|tcp|udp)\/(routers|services|middlewares)(\/[^/]+)?)$/;

async function api(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/session') return send(res, 200, { mode: authMode, user: whoIs(req)?.user ?? null, meta: meta() });
  if (p === '/api/login' && req.method === 'POST') {
    if (authMode !== 'password') return send(res, 400, { error: 'Password login is not enabled' });
    if (tooManyAttempts(ip(req))) return send(res, 429, { error: 'Too many attempts, wait a minute' });
    const body = await readBody(req);
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted === true;
    const cookie = login(body.password, ip(req), secure);
    if (!cookie) return send(res, 401, { error: 'Wrong password' });
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }
  if (p === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': logoutCookie() });

  if (!whoIs(req)) return send(res, 401, { error: 'Log in first' });
  if (req.method !== 'GET') return send(res, 405, { error: 'Read-only' });

  switch (p) {
    case '/api/state': return send(res, 200, { meta: meta(), state: publicState() });
    case '/api/metrics': return send(res, 200, { enabled: metrics.enabled, ok: metrics.ok, error: metrics.error, scrapedAt: metrics.scrapedAt, stepSeconds: metrics.stepSeconds, latest: metrics.latest, totals: metrics.totals, gauges: metrics.gauges, certs: metrics.certs, internalEntrypoints: metrics.internalEntrypoints, keys: seriesKeys() });
    case '/api/series': {
      const keys = (q.get('keys') ?? 'total').split(',').map((k) => k.trim()).filter(Boolean).slice(0, 60);
      return send(res, 200, { stepSeconds: metrics.stepSeconds, series: seriesFor(keys, Math.min(config.historyMinutes, num(q.get('minutes'), 15))) });
    }
    case '/api/top': return send(res, 200, { rows: top(q.get('kind') === 'service' ? 'service' : q.get('kind') === 'ep' ? 'ep' : 'router', num(q.get('minutes'), 5), Math.min(100, num(q.get('limit'), 10))) });
    case '/api/logs': {
      if (!logs.enabled) return send(res, 200, { enabled: false, auto: logs.auto, entries: [] });
      return send(res, 200, {
        enabled: true, ok: logs.ok, error: logs.error, format: logs.format, total: logs.total, path: logs.path,
        entries: query({ ...logFilters(q), before: num(q.get('before'), 0), limit: Math.min(1000, num(q.get('limit'), 200)) }),
      });
    }
    case '/api/logs/stats': return send(res, 200, logs.enabled ? { enabled: true, ok: logs.ok, error: logs.error, format: logs.format, ...stats({ minutes: num(q.get('minutes'), 0), ...logFilters(q) }) } : { enabled: false });
    // requests over time for the explorer's histogram, by status class, with the same filters as /api/logs
    case '/api/logs/histogram': return send(res, 200, logs.enabled ? { enabled: true, ...histogram({ buckets: num(q.get('buckets'), 60), minutes: num(q.get('minutes'), 0), ...logFilters(q) }) } : { enabled: false });
    case '/api/history': {
      const limit = Math.min(1000, num(q.get('limit'), 200));
      return send(res, 200, { persistent: Boolean(config.dataDir), events: history.slice(-limit).reverse() });
    }
    case '/api/diagnostics': return send(res, 200, { findings, score: healthScore(findings) });
    // ?check=1 asks GitHub right away instead of waiting for the next scheduled check
    case '/api/update': return send(res, 200, q.get('check') ? await checkNow() : updates);
    case '/api/raw': {
      const target = q.get('path') ?? '/api/overview';
      if (!RAW_ALLOWED.test(target.split('?')[0])) return send(res, 400, { error: 'Only the read-only Traefik API paths can be viewed' });
      try {
        const r = await get(`${config.traefik.apiUrl}${target}`);
        return send(res, r.status, r.body, { 'Content-Type': 'application/json; charset=utf-8', 'X-Traefik-Ms': String(r.ms), 'X-Next-Page': String(r.headers['x-next-page'] ?? '') });
      } catch (e) {
        return send(res, 502, { error: e.message });
      }
    }
    case '/api/live': {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ meta: meta(), state: publicState(), findings, score: healthScore(findings), metrics: { t: Date.now(), latest: metrics.latest, gauges: metrics.gauges, totals: metrics.totals, certs: certSummary() }, logs: logs.enabled ? recent(200) : [] })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    default: return send(res, 404, { error: 'No such endpoint' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    let url = new URL(req.url ?? '/', 'http://enodia');
    if (url.pathname === '/healthz') return send(res, state.ok ? 200 : 503, state.ok ? 'ok' : `traefik: ${state.error}`);
    if (config.basePath) {
      if (url.pathname === config.basePath) { res.writeHead(301, { Location: `${config.basePath}/` }); return res.end(); }
      if (!url.pathname.startsWith(config.basePath + '/')) return send(res, 404, 'not found');
      url = new URL(url.pathname.slice(config.basePath.length) + url.search, 'http://enodia');
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('[enodia]', e);
    if (!res.headersSent) send(res, 500, { error: 'Internal error' });
  }
});

startPolling();
startTailing();
setTimeout(scrapeLoop, 1500);
startUpdateChecks();
onUpdate((u) => broadcast('update', u));

server.listen(config.port, config.host, () => {
  console.log(`[enodia] ${pkg.version} on http://${config.host}:${config.port}${config.basePath}/  ·  Traefik API ${config.traefik.apiUrl}  ·  auth: ${authMode}`);
  if (authMode === 'none') console.log('[enodia] no ENODIA_PASSWORD set: protect the route in Traefik (basicAuth, forwardAuth or ipAllowList) before exposing it.');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
