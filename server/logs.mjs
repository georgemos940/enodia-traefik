// Traefik's access log, followed like `tail -F`: new lines are read as they are written, a rotated or
// truncated file is picked up again, and the last ENODIA_LOG_KEEP requests are kept for the explorer.
// Only the JSON format carries enough to be useful (router, service, timings), so that is what is read.
import fs from 'node:fs';
import { config } from './config.mjs';

export const logs = {
  enabled: Boolean(config.accessLog),
  path: config.accessLog,
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
    const st = fs.statSync(config.accessLog);
    if (fd === null || st.ino !== ino || st.size < pos) {
      // first open, a rotated file (new inode) or a truncated one: start over on the current file
      if (fd !== null) try { fs.closeSync(fd); } catch { /* gone already */ }
      fd = fs.openSync(config.accessLog, 'r');
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
    logs.error = e.code === 'ENOENT' ? `no file at ${config.accessLog}` : e.message;
  }
}

export function startTailing() {
  if (!logs.enabled) return;
  readMore();
  setInterval(readMore, 1000).unref();
}

// ── querying ─────────────────────────────────────────────────────────────────

const statusMatch = (want, status) => {
  if (!want) return true;
  if (/^[1-5]xx$/.test(want)) return Math.floor(status / 100) === Number(want[0]);
  return String(status) === want;
};

/**
 * Entries newest first, filtered. `q` is a free search over host, path, client, router, service and
 * user agent; the rest are exact.
 */
export function query({ q = '', status = '', router = '', service = '', client = '', host = '', method = '', minMs = 0, before = 0, limit = 200 } = {}) {
  const needle = q.toLowerCase();
  const out = [];
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
    const e = ring[i];
    if (before && e.id >= before) continue;
    if (!statusMatch(status, e.status)) continue;
    if (router && e.router !== router) continue;
    if (service && e.service !== service) continue;
    if (client && e.client !== client) continue;
    if (host && e.host !== host) continue;
    if (method && e.method !== method) continue;
    if (minMs && !(e.durationMs >= minMs)) continue;
    if (needle && ![e.host, e.path, e.client, e.router, e.service, e.ua].some((v) => v && v.toLowerCase().includes(needle))) continue;
    out.push(e);
  }
  return out;
}

/** What the explorer's side panels show: the busiest of everything over the kept window. */
export function stats({ minutes = 0 } = {}) {
  const since = minutes ? Date.now() - minutes * 60_000 : 0;
  const counts = { hosts: new Map(), paths: new Map(), clients: new Map(), routers: new Map(), statuses: new Map(), agents: new Map(), methods: new Map() };
  const bump = (m, k, d = 1) => { if (k === null || k === undefined || k === '') return; m.set(k, (m.get(k) ?? 0) + d); };
  let n = 0;
  let errors = 0;
  let slow = [];
  const durations = [];
  for (const e of ring) {
    if (since && e.t && Date.parse(e.t) < since) continue;
    n++;
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
    hosts: topOf(counts.hosts), paths: topOf(counts.paths), clients: topOf(counts.clients), routers: topOf(counts.routers),
    statuses: topOf(counts.statuses, 20), agents: topOf(counts.agents), methods: topOf(counts.methods),
    slowest: slow,
  };
}

export const recent = (n = 100) => ring.slice(-n);
