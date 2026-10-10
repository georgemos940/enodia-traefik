// The Traefik API, polled: every router, service, middleware and entry point, the static
// configuration from the support dump, and a history of every change between two polls.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { get, getJson } from './http.mjs';

const LISTS = [
  ['http', 'routers'], ['http', 'services'], ['http', 'middlewares'],
  ['tcp', 'routers'], ['tcp', 'services'], ['tcp', 'middlewares'],
  ['udp', 'routers'], ['udp', 'services'],
];

const api = (p) => `${config.traefik.apiUrl}${p}`;

/** A list endpoint, every page of it (Traefik pages with X-Next-Page). */
async function fetchAll(p) {
  const items = [];
  let page = 1;
  for (let guard = 0; guard < 200; guard++) {
    const { data, headers } = await getJson(api(`${p}?per_page=1000&page=${page}`));
    if (Array.isArray(data)) items.push(...data);
    const next = Number(headers['x-next-page']);
    if (!next || next <= page) break;
    page = next;
  }
  return items;
}

// ── the support dump: a tar.gz holding static-config.json ─────────────────────

function untar(buf) {
  const files = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    files[name] = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function fetchStatic() {
  const r = await get(api('/api/support-dump'), { accept: '*/*', timeoutMs: Math.max(config.traefik.timeoutMs, 10000) });
  if (r.status !== 200) return null;
  const files = untar(zlib.gunzipSync(r.body));
  const pick = (n) => Object.entries(files).find(([k]) => k.endsWith(n))?.[1];
  const parse = (b) => { try { return b ? JSON.parse(b.toString('utf8')) : null; } catch { return null; } };
  return parse(pick('static-config.json'));
}

// ── state ─────────────────────────────────────────────────────────────────────

export const state = {
  ok: false,
  error: null,
  fetchedAt: null,
  apiMs: null,
  version: null,
  overview: null,
  entrypoints: [],
  http: { routers: [], services: [], middlewares: [] },
  tcp: { routers: [], services: [], middlewares: [] },
  udp: { routers: [], services: [] },
  static: null,
  staticAt: null,
  revision: 0,
};

export const history = [];          // newest last
const HISTORY_KEEP = 1000;
let fingerprints = null;             // "http.routers:name" -> JSON
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

const historyFile = () => (config.dataDir ? path.join(config.dataDir, 'history.json') : null);
function loadHistory() {
  const f = historyFile();
  if (!f) return;
  try { history.push(...JSON.parse(fs.readFileSync(f, 'utf8')).slice(-HISTORY_KEEP)); } catch { /* first run */ }
}
let saveTimer = null;
function saveHistory() {
  const f = historyFile();
  if (!f) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f + '.tmp', JSON.stringify(history.slice(-HISTORY_KEEP)));
      fs.renameSync(f + '.tmp', f);
    } catch (e) { console.error('[enodia] could not save history:', e.message); }
  }, 1000);
}

// What changes on its own every poll is not a configuration change.
const stable = (o) => JSON.stringify(o, (k, v) => (k === 'serverStatus' ? undefined : v));

function diffFields(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...keys].filter((k) => k !== 'serverStatus' && JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
}

function record(event) {
  history.push({ id: crypto.randomUUID(), at: new Date().toISOString(), ...event });
  if (history.length > HISTORY_KEEP) history.splice(0, history.length - HISTORY_KEEP);
}

function detectChanges(next) {
  const fp = new Map();
  const full = new Map();
  for (const [proto, kind] of LISTS) {
    for (const item of next[proto][kind]) {
      const key = `${proto}.${kind}:${item.name}`;
      fp.set(key, stable(item));
      full.set(key, item);
    }
  }
  const events = [];
  if (fingerprints) {
    for (const [key, sig] of fp) {
      const [where, name] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      const before = fingerprints.get(key);
      if (before === undefined) events.push({ type: 'added', where, name, after: full.get(key) });
      else if (before.sig !== sig) events.push({ type: 'changed', where, name, fields: diffFields(before.item, full.get(key)), before: before.item, after: full.get(key) });
    }
    for (const [key, before] of fingerprints) {
      if (!fp.has(key)) events.push({ type: 'removed', where: key.slice(0, key.indexOf(':')), name: key.slice(key.indexOf(':') + 1), before: before.item });
    }
    // a backend going up or down is worth a line too
    for (const [key, item] of full) {
      const before = fingerprints.get(key)?.item;
      if (!before?.serverStatus || !item.serverStatus) continue;
      for (const [url, status] of Object.entries(item.serverStatus)) {
        const was = before.serverStatus[url];
        if (was && was !== status) events.push({ type: status === 'UP' ? 'server-up' : 'server-down', where: key.slice(0, key.indexOf(':')), name: item.name, server: url });
      }
    }
  }
  fingerprints = new Map([...fp].map(([k, sig]) => [k, { sig, item: full.get(k) }]));
  return events;
}

let staticDueAt = 0;

export async function poll() {
  const started = Date.now();
  try {
    const [version, overview, entrypoints, ...lists] = await Promise.all([
      getJson(api('/api/version')).then((r) => r.data),
      getJson(api('/api/overview')).then((r) => r.data),
      fetchAll('/api/entrypoints'),
      ...LISTS.map(([proto, kind]) => fetchAll(`/api/${proto}/${kind}`).catch((e) => (e.status === 404 ? [] : Promise.reject(e)))),
    ]);
    const next = {
      http: { routers: lists[0], services: lists[1], middlewares: lists[2] },
      tcp: { routers: lists[3], services: lists[4], middlewares: lists[5] },
      udp: { routers: lists[6], services: lists[7] },
    };
    // the static configuration changes only on a Traefik restart: once a minute is plenty
    if (Date.now() >= staticDueAt) {
      staticDueAt = Date.now() + 60_000;
      try {
        const s = await fetchStatic();
        if (s) { state.static = s; state.staticAt = new Date().toISOString(); }
      } catch { /* older Traefik or the dump is refused: the pages that use it say so */ }
    }

    const events = detectChanges(next);
    const restarted = state.version && version.startDate && state.version.startDate !== version.startDate;
    if (restarted) events.push({ type: 'restart', where: 'traefik', name: 'Traefik', version: version.Version });
    for (const e of events) record(e);
    if (events.length) saveHistory();

    const wasOk = state.ok;
    Object.assign(state, { ok: true, error: null, fetchedAt: new Date().toISOString(), apiMs: Date.now() - started, version, overview, entrypoints, ...next });
    if (events.length || !wasOk) state.revision++;
    for (const fn of listeners) fn({ events, changed: events.length > 0 || !wasOk });
  } catch (e) {
    const changed = state.ok || state.error !== e.message;
    Object.assign(state, { ok: false, error: e.message, fetchedAt: new Date().toISOString() });
    if (changed) {
      state.revision++;
      for (const fn of listeners) fn({ events: [], changed: true });
    }
  }
}

export function startPolling() {
  loadHistory();
  const tick = async () => { await poll(); setTimeout(tick, config.pollSeconds * 1000); };
  tick();
}
