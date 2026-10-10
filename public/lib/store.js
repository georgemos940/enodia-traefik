// Everything the server knows, kept current over one Server-Sent Events stream. Pages read
// store.state / store.metrics / store.findings and subscribe with store.on(event, fn).
//
// Events: 'state' (Traefik config changed), 'metrics' (every scrape), 'logs' (new access-log lines),
// 'history' (configuration changes), 'diagnostics', 'connection' (stream up/down), 'any'.

const listeners = new Map();

export const store = {
  meta: null,
  state: null,
  metrics: null,          // { t, latest, gauges, totals }
  findings: [],
  score: null,
  logs: [],               // recent access-log entries, oldest first
  history: [],            // configuration changes this session, newest first
  connected: false,
  lastMessageAt: 0,

  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  },
  emit(event, data) {
    for (const fn of listeners.get(event) ?? []) { try { fn(data); } catch (e) { console.error(e); } }
    if (event !== 'any') for (const fn of listeners.get('any') ?? []) { try { fn(event, data); } catch (e) { console.error(e); } }
  },
};

const LOG_KEEP = 2000;

/** GET a JSON endpoint of the Enodia API. Paths are relative to the page (base path aware). */
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`api/${path.replace(/^\/?(api\/)?/, '')}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    store.emit('unauthorized');
    throw new Error('Log in first');
  }
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `Error ${res.status}`);
  return data;
}

let source = null;
let retry = 1000;

export function connect() {
  source?.close();
  source = new EventSource('api/live');
  source.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    store.meta = d.meta;
    store.state = d.state;
    store.findings = d.findings;
    store.score = d.score;
    store.metrics = d.metrics;
    store.logs = d.logs ?? [];
    setConnected(true);
    store.emit('state', store.state);
    store.emit('metrics', store.metrics);
    store.emit('diagnostics', { findings: store.findings, score: store.score });
    store.emit('ready');
  });
  source.addEventListener('state', (e) => { store.state = JSON.parse(e.data); touch(); store.emit('state', store.state); });
  source.addEventListener('update', (e) => { const u = JSON.parse(e.data); if (store.meta) store.meta.updates = u; store.emit('update', u); });
  source.addEventListener('metrics', (e) => { store.metrics = JSON.parse(e.data); touch(); store.emit('metrics', store.metrics); });
  source.addEventListener('diagnostics', (e) => { const d = JSON.parse(e.data); store.findings = d.findings; store.score = d.score; touch(); store.emit('diagnostics', d); });
  source.addEventListener('history', (e) => { const list = JSON.parse(e.data); store.history.unshift(...list.reverse()); store.history.length = Math.min(store.history.length, 500); touch(); store.emit('history', list); });
  source.addEventListener('logs', (e) => {
    const lines = JSON.parse(e.data);
    store.logs.push(...lines);
    if (store.logs.length > LOG_KEEP) store.logs.splice(0, store.logs.length - LOG_KEEP);
    touch();
    store.emit('logs', lines);
  });
  source.onerror = () => {
    setConnected(false);
    source.close();
    // the stream drops on a 401 too: check before retrying forever
    fetch('api/session', { credentials: 'same-origin' }).then((r) => r.json()).then((s) => {
      if (s.mode !== 'none' && !s.user) store.emit('unauthorized');
      else setTimeout(connect, retry);
    }).catch(() => setTimeout(connect, retry));
    retry = Math.min(retry * 2, 15000);
  };
  source.onopen = () => { retry = 1000; };
}

function touch() { store.lastMessageAt = Date.now(); }
function setConnected(v) {
  touch();
  if (store.connected === v) return;
  store.connected = v;
  store.emit('connection', v);
}

// ── selectors pages share ────────────────────────────────────────────────────

/** Every resource of a kind across protocols: [{...item, proto}] */
export function all(kind) {
  const st = store.state;
  if (!st) return [];
  return ['http', 'tcp', 'udp'].flatMap((proto) => (st[proto]?.[kind] ?? []).map((x) => ({ ...x, proto })));
}

export function find(kind, name, proto = 'http') {
  return store.state?.[proto]?.[kind]?.find((x) => x.name === name) ?? null;
}

/** The latest metrics point for a router/service/entry point, or null. */
export function live(kind, name) {
  return store.metrics?.latest?.[kind === 'total' ? 'total' : `${kind}:${name}`] ?? null;
}

export function findingsFor(kind, name) {
  return store.findings.filter((f) => f.resource && f.resource.name === name && (!kind || f.resource.kind.endsWith(kind)));
}
