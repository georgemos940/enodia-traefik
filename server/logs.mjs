// Traefik's access log, followed like `tail -F`: new lines are read as they are written, a rotated or
// truncated file is picked up again, and the last ENODIA_LOG_KEEP requests are kept for the explorer.
// Only the JSON format carries enough to be useful (router, service, timings), so that is what is read.
import fs from 'node:fs';
import { config } from './config.mjs';
import { state as traefik } from './traefik.mjs';

const auto = config.accessLog === 'auto';

export const logs = {
  // in auto mode it turns on once Traefik's own access-log path turns out to be readable here
  enabled: Boolean(config.accessLog) && !auto,
  auto,
  path: auto ? '' : config.accessLog,
  ok: false,
  error: null,
  format: null,       // 'json' | 'clf' | null
  total: 0,           // lines read since Enodia started
};

const ring = [];
const listeners = new Set();
export const onLines = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

let fd = null;
let pos = 0;
let ino = null;
let carry = '';
let seq = 0;

const ms = (ns) => (typeof ns === 'number' ? Math.round(ns / 1e6 * 10) / 10 : null);

/** One access-log line, reduced to what the explorer shows and filters on. */
export function normalize(o) {
  const ua = o['request_User-Agent'] ?? o.request_User_Agent ?? null;
  return {
    id: ++seq,
    t: o.StartUTC ?? o.time ?? null,
    status: o.DownstreamStatus ?? o.OriginStatus ?? null,
    originStatus: o.OriginStatus ?? null,
    method: o.RequestMethod ?? null,
    host: o.RequestHost ?? null,
    path: o.RequestPath ?? null,
    protocol: o.RequestProtocol ?? null,
    scheme: o.RequestScheme ?? null,
    router: o.RouterName ?? null,
    service: o.ServiceName ?? null,
    server: o.ServiceURL ?? o.ServiceAddr ?? null,
    entrypoint: o.entryPointName ?? null,
    client: o.ClientHost ?? null,
    user: o.ClientUsername && o.ClientUsername !== '-' ? o.ClientUsername : null,
    durationMs: ms(o.Duration),
    originMs: ms(o.OriginDuration),
    overheadMs: ms(o.Overhead),
    size: o.DownstreamContentSize ?? null,
    retries: o.RetryAttempts ?? 0,
    tls: o.TLSVersion ?? null,
    ua,
    referer: o.request_Referer ?? null,
    // Cloudflare's country code, when Traefik keeps that header (accessLog.fields.headers.names.Cf-Ipcountry=keep)
    country: o['request_Cf-Ipcountry'] ?? o['request_CF-IPCountry'] ?? o['request_Cf-IPCountry'] ?? null,
  };
}

function ingest(text) {
  const lines = (carry + text).split('\n');
  carry = lines.pop() ?? '';
  const fresh = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    if (s[0] !== '{') {
      if (!logs.format) logs.format = 'clf';
      continue;
    }
    try {
      const entry = normalize(JSON.parse(s));
      logs.format = 'json';
      fresh.push(entry);
    } catch { /* a half-written line: the next read completes it */ }
  }
  if (!fresh.length) return;
  logs.total += fresh.length;
  ring.push(...fresh);
  if (ring.length > config.accessLogKeep) ring.splice(0, ring.length - config.accessLogKeep);
  for (const fn of listeners) fn(fresh);
}

function readMore() {
  try {
    const st = fs.statSync(logs.path);
    if (fd === null || st.ino !== ino || st.size < pos) {
      // first open, a rotated file (new inode) or a truncated one: start over on the current file
      if (fd !== null) try { fs.closeSync(fd); } catch { /* gone already */ }
      fd = fs.openSync(logs.path, 'r');
      const first = ino === null;
      ino = st.ino;
      // on first start, read only the tail: a 2 GB log is not a startup cost anyone wants
      pos = first ? Math.max(0, st.size - 4 * 1024 * 1024) : 0;
      carry = '';
      if (first && pos > 0) {
        const skip = Buffer.alloc(64 * 1024);
        const n = fs.readSync(fd, skip, 0, skip.length, pos);
        const nl = skip.subarray(0, n).indexOf(10);
        pos += nl >= 0 ? nl + 1 : n;
      }
    }
    const size = st.size;
    while (pos < size) {
      const len = Math.min(1024 * 1024, size - pos);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, pos);
      if (n <= 0) break;
      pos += n;
      ingest(buf.subarray(0, n).toString('utf8'));
    }
    logs.ok = true;
    logs.error = null;
  } catch (e) {
    logs.ok = false;
    logs.error = e.code === 'ENOENT' ? `no file at ${logs.path}` : e.message;
  }
}

export function startTailing() {
  if (!config.accessLog) return;
  if (!auto) {
    readMore();
    setInterval(readMore, 1000).unref();
    return;
  }
  // Auto: Traefik's support dump masks the log path, so the usual places a log directory is mounted
  // are tried. Mount the directory there (the installer uses /traefik-logs) and the explorer turns on.
  const tried = ['/traefik-logs/access.log', '/logs/access.log', '/var/log/traefik/access.log', '/var/log/traefik/access.json', '/var/log/access.log'];
  const look = setInterval(() => {
    const dumped = traefik.static?.accessLog?.filePath;
    const p = [...(dumped && dumped !== 'xxxx' ? [dumped] : []), ...tried].find((f) => fs.existsSync(f));
    if (!p) return;
    clearInterval(look);
    logs.path = p;
    logs.enabled = true;
    readMore();
    setInterval(readMore, 1000).unref();
  }, 5000);
  look.unref();
}

// ── querying ─────────────────────────────────────────────────────────────────

const statusMatch = (want, status) => {
  if (!want) return true;
  if (/^[1-5]xx$/.test(want)) return Math.floor(status / 100) === Number(want[0]);
  return String(status) === want;
};

/**
 * The explorer's filters as one test. `q` is a free search over host, path, client, router, service
 * and user agent; the rest are exact.
 */
export function matcher({ q = '', status = '', router = '', service = '', client = '', host = '', method = '', minMs = 0 } = {}) {
  const needle = q.toLowerCase();
  return (e) => statusMatch(status, e.status)
    && (!router || e.router === router) && (!service || e.service === service) && (!client || e.client === client)
    && (!host || e.host === host) && (!method || e.method === method)
    && (!minMs || e.durationMs >= minMs)
    && (!needle || [e.host, e.path, e.client, e.router, e.service, e.ua].some((v) => v && v.toLowerCase().includes(needle)));
}

/** Entries newest first, filtered (see matcher). */
export function query({ before = 0, limit = 200, ...filters } = {}) {
  const match = matcher(filters);
  const out = [];
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
    const e = ring[i];
    if (before && e.id >= before) continue;
    if (match(e)) out.push(e);
  }
  return out;
}

/** What the explorer's side panels show: the busiest of everything over the kept window, filtered. */
export function stats({ minutes = 0, ...filters } = {}) {
  const since = minutes ? Date.now() - minutes * 60_000 : 0;
  const match = matcher(filters);
  const counts = { hosts: new Map(), paths: new Map(), clients: new Map(), routers: new Map(), services: new Map(), statuses: new Map(), agents: new Map(), methods: new Map() };
  const bump = (m, k, d = 1) => { if (k === null || k === undefined || k === '') return; m.set(k, (m.get(k) ?? 0) + d); };
  let n = 0;
  let errors = 0;
  let slow = [];
  const durations = [];
  for (const e of ring) {
    if (since && e.t && Date.parse(e.t) < since) continue;
    if (!match(e)) continue;
    n++;
    bump(counts.services, e.service);
    bump(counts.hosts, e.host);
    bump(counts.paths, e.path ? `${e.host ?? ''}${e.path.split('?')[0]}` : null);
    bump(counts.clients, e.client);
    bump(counts.routers, e.router);
    bump(counts.statuses, e.status);
    bump(counts.agents, e.ua);
    bump(counts.methods, e.method);
    if (e.status >= 500) errors++;
    if (e.durationMs !== null) durations.push(e.durationMs);
    if (e.durationMs !== null && (slow.length < 15 || e.durationMs > slow[slow.length - 1].durationMs)) {
      slow.push(e);
      slow.sort((a, b) => b.durationMs - a.durationMs);
      slow = slow.slice(0, 15);
    }
  }
  const topOf = (m, k = 10) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([key, count]) => ({ key, count }));
  durations.sort((a, b) => a - b);
  const pct = (p) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(p * durations.length))] : null);
  return {
    count: n,
    errors,
    oldest: ring[0]?.t ?? null,
    newest: ring[ring.length - 1]?.t ?? null,
    p50: pct(0.5), p95: pct(0.95), p99: pct(0.99),
    hosts: topOf(counts.hosts), paths: topOf(counts.paths), clients: topOf(counts.clients), routers: topOf(counts.routers), services: topOf(counts.services),
    statuses: topOf(counts.statuses, 20), agents: topOf(counts.agents), methods: topOf(counts.methods),
    slowest: slow,
  };
}

// bucket widths the histogram picks from, in seconds
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400];

/**
 * Requests over time for the explorer's histogram, split by status class and filtered: at most
 * `buckets` slices of a round width covering the kept window (or the last `minutes`), newest last.
 */
export function histogram({ buckets = 60, minutes = 0, ...filters } = {}) {
  const max = Math.max(10, Math.min(240, buckets));
  const now = Date.now();
  const oldest = ring.length ? Date.parse(ring[0].t) : now;
  const span = minutes ? minutes * 60_000 : Math.max(60_000, now - (Number.isFinite(oldest) ? oldest : now));
  const step = (STEPS.find((s) => s * 1000 * max >= span) ?? STEPS[STEPS.length - 1]) * 1000;
  const to = Math.ceil(now / step) * step;
  const n = Math.min(max, Math.ceil(span / step) + 1);
  const from = to - n * step;
  const out = Array.from({ length: n }, (_, i) => ({ t: from + i * step, n: 0, c2: 0, c3: 0, c4: 0, c5: 0 }));
  const match = matcher(filters);
  for (let i = ring.length - 1; i >= 0; i--) {
    const e = ring[i];
    const t = Date.parse(e.t);
    if (!Number.isFinite(t)) continue;
    if (t < from) break;
    if (!match(e)) continue;
    const b = out[Math.min(n - 1, Math.floor((t - from) / step))];
    b.n++;
    const c = Math.floor(e.status / 100);
    if (c >= 2 && c <= 5) b[`c${c}`]++;
  }
  return { step, from, to, buckets: out };
}

export const recent = (n = 100) => ring.slice(-n);
