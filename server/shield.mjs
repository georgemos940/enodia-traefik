// Shield: who is knocking, and what Traefik does about it. Every access-log line is sorted into what
// reached a backend and what Traefik stopped at the edge (rate limits, allow lists, the CrowdSec plugin,
// auth, unknown hosts), then counted per second and per source address. Traffic well above this
// Traefik's own normal level opens an attack, which is kept with its sources, targets and timeline.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { logs, onLines } from './logs.mjs';
import { metrics } from './metrics.mjs';
import { state as traefik } from './traefik.mjs';
import { banFor, onDecisions, crowdsecSummary } from './crowdsec.mjs';
import { isCloudflare } from './netmatch.mjs';
import { postWebhook } from './webhook.mjs';

export const CLASSES = ['pass', 'limit', 'block', 'auth', 'miss', 'error'];
const KEEP_S = 15 * 60;
const MAX_SOURCES = 20000;
const WARMUP_MS = 60_000;

const zero = () => ({ n: 0, pass: 0, limit: 0, block: 0, auth: 0, miss: 0, error: 0 });
const stoppedOf = (c) => c.limit + c.block + c.auth + c.miss;
const hhmm = (t) => `${new Date(t).toISOString().slice(11, 16)} UTC`;

/** What happened to a request: reached a backend, or was answered by Traefik itself, and how. */
export function classify(e) {
  const s = e.status ?? 0;
  const edge = !e.originStatus; // no backend answered: a middleware or Traefik did
  if (s === 429) return 'limit';
  if (edge && s === 403) return 'block';
  if (edge && s === 401) return 'auth';
  if (edge && s === 404 && !e.router) return 'miss';
  if (s >= 500) return 'error';
  return 'pass';
}

// counters that stay small: an attacker can send a million different paths
function bump(map, key, by = 1, cap = 40) {
  if (key === null || key === undefined || key === '') return;
  const v = map.get(key);
  if (v !== undefined) map.set(key, v + by);
  else if (map.size < cap) map.set(key, by);
}
const topOf = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, n: Math.round(count) }));

// ── per second ──────────────────────────────────────────────────────────────

const secs = new Array(KEEP_S);
function secBucket(sec) {
  const i = sec % KEEP_S;
  let b = secs[i];
  if (!b || b.s !== sec) { b = { s: sec, tot: null, ...zero() }; secs[i] = b; }
  return b;
}

// ── per source ──────────────────────────────────────────────────────────────

const sources = new Map();
function sourceOf(ip, t) {
  let s = sources.get(ip);
  if (!s) {
    s = { ip, c: zero(), cc: null, first: t, last: t, mins: [], ua: new Map(), paths: new Map(), hosts: new Map(), routers: new Map() };
    sources.set(ip, s);
  }
  return s;
}
function prune(now) {
  const oldest = Math.floor((now - KEEP_S * 1000) / 60000);
  for (const [ip, s] of sources) {
    while (s.mins.length && s.mins[0][0] < oldest) s.mins.shift();
    if (!s.mins.length) sources.delete(ip);
  }
  if (sources.size > MAX_SOURCES) {
    const quiet = [...sources.values()].sort((a, b) => a.last - b.last).slice(0, sources.size - MAX_SOURCES * 0.8);
    for (const s of quiet) sources.delete(s.ip);
  }
}

// targets, countries and user agents fade with a half-life of about five minutes
const recent = { paths: new Map(), hosts: new Map(), routers: new Map(), countries: new Map(), uas: new Map() };
function fade() {
  for (const m of Object.values(recent)) {
    for (const [k, v] of m) { const nv = v * 0.87; if (nv < 0.5) m.delete(k); else m.set(k, nv); }
  }
}

// ── live tick, levels and attacks ───────────────────────────────────────────

const started = Date.now();
let live = new Map();      // ip -> { c, cc } for lines that arrived since the last tick
let liveTotals = zero();
let newBans = [];
let lastLowStatusAt = 0;   // a logged line under 400: the log is not filtered to errors only
let countriesSeen = false;
const proxySample = new Map();

let level = 'calm';
let hot = 0;
let cool = 0;
let baseline = null;
let baselineStopped = 0;   // even quiet traffic has a few 401s and 404s
const lastTotals = [];
let attack = null;
let broadcast = () => {};

const attacksFile = config.dataDir ? path.join(config.dataDir, 'attacks.json') : null;
let attacks = [];
try { if (attacksFile && fs.existsSync(attacksFile)) attacks = JSON.parse(fs.readFileSync(attacksFile, 'utf8')); } catch { attacks = []; }
function saveAttacks() {
  if (!attacksFile) return;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(`${attacksFile}.tmp`, JSON.stringify(attacks));
    fs.renameSync(`${attacksFile}.tmp`, attacksFile);
  } catch (e) { console.error('[enodia] could not save attacks:', e.message); }
}

function ingest(lines) {
  const now = Date.now();
  for (const e of lines) {
    const t = Date.parse(e.t) || now;
    if (now - t > KEEP_S * 1000) continue;
    const cls = classify(e);
    const b = secBucket(Math.floor(t / 1000));
    b.n++; b[cls]++;
    if ((e.status ?? 0) < 400) lastLowStatusAt = Math.max(lastLowStatusAt, t);
    const ip = e.client;
    if (e.country) { countriesSeen = true; bump(recent.countries, e.country, 1, 250); }
    bump(recent.paths, e.path ? `${e.host ?? ''}${e.path}` : null, 1, 400);
    bump(recent.hosts, e.host, 1, 200);
    bump(recent.routers, e.router, 1, 200);
    bump(recent.uas, e.ua ?? '(none)', 1, 300);
    if (ip) {
      const s = sourceOf(ip, t);
      s.c.n++; s.c[cls]++;
      if (t > s.last) s.last = t;
      if (e.country) s.cc = e.country;
      const min = Math.floor(t / 60000);
      const m = s.mins[s.mins.length - 1];
      const stop = cls !== 'pass' && cls !== 'error' ? 1 : 0;
      if (m && m[0] === min) { m[1]++; m[2] += stop; } else s.mins.push([min, 1, stop]);
      bump(s.ua, e.ua ?? '(none)', 1, 8);
      bump(s.paths, e.path, 1, 12);
      bump(s.hosts, e.host, 1, 8);
      bump(s.routers, e.router, 1, 8);
      if (proxySample.size < 2000 && !proxySample.has(ip)) proxySample.set(ip, isCloudflare(ip));
    }
    // only what is happening now feeds the live view and attacks, not a log read back at startup
    if (now - t > 15_000) continue;
    liveTotals.n++; liveTotals[cls]++;
    if (ip) {
      let l = live.get(ip);
      if (!l) { l = { c: zero(), cc: e.country ?? null }; live.set(ip, l); }
      l.c.n++; l.c[cls]++;
    }
    if (attack) {
      const stop = cls !== 'pass' && cls !== 'error' ? 1 : 0;
      attack.logged.n++; attack.logged[cls]++;
      if (ip) {
        let a = attack.srcs.get(ip);
        if (!a && attack.srcs.size < MAX_SOURCES) { a = { n: 0, stopped: 0, cc: e.country ?? null, ua: e.ua ?? null }; attack.srcs.set(ip, a); }
        if (a) { a.n++; a.stopped += stop; }
      }
      bump(attack.paths, e.path ? `${e.host ?? ''}${e.path}` : null, 1, 60);
      bump(attack.hosts, e.host, 1, 30);
      bump(attack.uas, e.ua ?? '(none)', 1, 40);
      bump(attack.countries, e.country, 1, 60);
      bump(attack.routers, e.router, 1, 30);
    }
  }
}

/** Is the log limited to some status codes (accessLog.filters.statusCodes), so passing traffic is missing? */
export function logFiltered() {
  const sc = traefik.static?.accessLog?.filters?.statusCodes;
  if ((Array.isArray(sc) && sc.length) || (typeof sc === 'string' && sc)) return true;
  const t = metrics.latest?.total;
  const flowing = t && (t.r2 ?? 0) + (t.r3 ?? 0) > 0.2;
  return Boolean(logs.enabled && logs.ok && flowing && Date.now() - started > 120_000 && Date.now() - lastLowStatusAt > 120_000);
}

function thresholds() {
  const b = baseline ?? 0;
  const bs = baselineStopped;
  return {
    attack: config.shield.attackRps || Math.max(b * 4, b + 40, 30),
    stopped: Math.max(20, b * 0.5, bs * 5 + 10),
    elevated: Math.max(b * 2, b + 15, 10),
    stoppedElevated: Math.max(5, bs * 3 + 3),
  };
}

function brief(a) {
  const top = [...a.srcs].sort((x, y) => y[1].n - x[1].n).slice(0, 3).map(([ip, s]) => [ip, s.n, s.cc]);
  const stopped = stoppedOf(a.logged);
  return { id: a.id, start: a.start, peak: Math.round(a.peak), requests: Math.round(a.requests), stoppedPct: a.logged.n ? stopped / a.logged.n : 0, sources: a.srcs.size, top };
}

function finish(a, now) {
  const stopped = stoppedOf(a.logged);
  const top = [...a.srcs].sort((x, y) => y[1].n - x[1].n).slice(0, 15).map(([ip, s]) => ({ ip, n: s.n, stopped: s.stopped, cc: s.cc, ua: s.ua }));
  return {
    id: a.id, start: a.start, end: now, durationS: Math.round((now - a.start) / 1000),
    peak: Math.round(a.peak), peakStopped: Math.round(a.peakStopped), requests: Math.round(a.requests),
    logged: a.logged, stoppedPct: a.logged.n ? stopped / a.logged.n : 0, sources: a.srcs.size,
    top, paths: topOf(a.paths, 10), hosts: topOf(a.hosts, 6), uas: topOf(a.uas, 8), countries: topOf(a.countries, 10), routers: topOf(a.routers, 6),
    series: a.series, bans: a.bans.slice(0, 50),
  };
}

function tick() {
  const now = Date.now();
  const filtered = logFiltered();
  const m = metrics.enabled && metrics.ok ? metrics.latest?.total?.rps ?? null : null;
  const logged = liveTotals.n;
  // the metrics see every request; the log may only hold the stopped ones, or nothing at all
  const total = !logs.enabled ? (m ?? 0) : filtered ? Math.max(m ?? 0, logged) : logged;
  const stopped = stoppedOf(liveTotals);
  secBucket(Math.floor(now / 1000) - 1).tot = total;

  lastTotals.push([total, stopped]);
  if (lastTotals.length > 3) lastTotals.shift();
  const avg = lastTotals.reduce((s, x) => s + x[0], 0) / lastTotals.length;
  const avgStopped = lastTotals.reduce((s, x) => s + x[1], 0) / lastTotals.length;
  const warm = now - started < WARMUP_MS;
  const th = thresholds();

  if (warm) {
    baseline = baseline === null ? avg : baseline + (avg - baseline) / 10;
    baselineStopped += (avgStopped - baselineStopped) / 10;
  } else {
    const isHot = avg >= th.attack || avgStopped >= th.stopped;
    const isWarm = avg >= th.elevated || avgStopped >= th.stoppedElevated;
    hot = isHot ? hot + 1 : 0;
    // an attack is over after half a minute without a hot second and well below the attack level
    cool = isHot || avg >= th.attack * 0.75 ? 0 : cool + 1;
    if (!attack && hot >= 5) {
      attack = { id: now - 5000, start: now - 5000, peak: 0, peakStopped: 0, requests: 0, logged: zero(), srcs: new Map(), paths: new Map(), hosts: new Map(), uas: new Map(), countries: new Map(), routers: new Map(), series: [], bans: [], acc: null };
      if (config.shield.alerts) {
        postWebhook(`Attack started at ${hhmm(attack.start)}: ${Math.round(avg)} req/s, ${avg ? Math.round((avgStopped / avg) * 100) : 0}% of it stopped at the edge.`);
      }
    }
    if (attack && cool >= 30) {
      const done = finish(attack, now - 30_000);
      attacks.unshift(done);
      attacks = attacks.slice(0, 50);
      saveAttacks();
      if (config.shield.alerts) {
        const loud = done.top[0];
        postWebhook(`Attack over after ${Math.round(done.durationS / 60)} min: peak ${done.peak} req/s, ${done.requests.toLocaleString('en')} requests, ${Math.round(done.stoppedPct * 100)}% stopped at the edge${loud ? `. Loudest source ${loud.ip}${loud.cc ? ` (${loud.cc})` : ''}` : ''}.`);
      }
      attack = null;
    }
    level = attack ? 'attack' : isWarm ? 'elevated' : 'calm';
    // the baseline only learns from quiet traffic, so an attack never becomes the new normal
    if (level === 'calm') {
      baseline = baseline === null ? avg : baseline + (avg - baseline) / 600;
      baselineStopped += (avgStopped - baselineStopped) / 600;
    }
  }

  if (attack) {
    attack.requests += total;
    attack.peak = Math.max(attack.peak, total);
    attack.peakStopped = Math.max(attack.peakStopped, stopped);
    const acc = attack.acc ?? (attack.acc = { t: now, total: 0, stopped: 0, k: 0 });
    acc.total += total; acc.stopped += stopped; acc.k++;
    if (acc.k >= 5) {
      attack.series.push([acc.t, Math.round(acc.total / acc.k), Math.round(acc.stopped / acc.k)]);
      if (attack.series.length > 1440) attack.series = attack.series.filter((_, i) => i % 2 === 0);
      attack.acc = null;
    }
  }

  const src = [...live].sort((a, b) => b[1].c.n - a[1].c.n).slice(0, 60)
    .map(([ip, { c, cc }]) => [ip, c.n, c.pass, c.limit, c.block, c.auth, c.miss, c.error, cc, banFor(ip) ? 1 : 0]);
  broadcast('shield', {
    t: now, level, warm, filtered,
    total: Math.round(total * 10) / 10, stopped,
    c: liveTotals,
    anon: Math.max(0, Math.round(total - logged)),
    src,
    baseline: baseline === null ? null : Math.round(baseline * 10) / 10,
    attack: attack ? brief(attack) : null,
    bans: newBans,
  });
  live = new Map();
  liveTotals = zero();
  newBans = [];
}

onDecisions((list) => {
  for (const d of list) {
    const b = { ip: d.value, scope: d.scope, scenario: d.scenario, origin: d.origin, until: d.until, at: Date.now() };
    newBans.push(b);
    if (attack && attack.bans.length < 200) attack.bans.push(b);
  }
});

export function startShield(send) {
  broadcast = send;
  onLines(ingest);
  setInterval(tick, 1000).unref();
  setInterval(() => { prune(Date.now()); fade(); }, 60_000).unref();
  setInterval(() => proxySample.clear(), 10 * 60_000).unref();
}

// ── reads ───────────────────────────────────────────────────────────────────

function windowOf(s, minutes, now) {
  const from = Math.floor(now / 60000) - minutes + 1;
  let n = 0; let stopped = 0;
  for (const [min, k, st] of s.mins) if (min >= from) { n += k; stopped += st; }
  return { n, stopped };
}

function topSources(minutes, limit, now) {
  const rows = [];
  for (const s of sources.values()) {
    const w = windowOf(s, minutes, now);
    if (w.n) rows.push([s, w]);
  }
  rows.sort((a, b) => b[1].n - a[1].n);
  return { count: rows.length, rows: rows.slice(0, limit).map(([s, w]) => {
    const ban = banFor(s.ip);
    return {
      ip: s.ip, n: w.n, stopped: w.stopped, c: s.c, cc: s.cc, last: s.last,
      ua: topOf(s.ua, 1)[0]?.key ?? null, path: topOf(s.paths, 1)[0]?.key ?? null, host: topOf(s.hosts, 1)[0]?.key ?? null,
      ban: ban ? { scenario: ban.scenario, until: ban.until, origin: ban.origin } : null,
    };
  }) };
}

export function shieldSnapshot() {
  const now = Date.now();
  const filtered = logFiltered();
  const nowSec = Math.floor(now / 1000);
  const series = [];
  for (let s = nowSec - KEEP_S + 5 - (nowSec % 5); s <= nowSec; s += 5) {
    const acc = { ...zero(), tot: 0 };
    let have = false;
    for (let k = s; k < s + 5; k++) {
      const b = secs[k % KEEP_S];
      if (!b || b.s !== k) continue;
      have = true;
      for (const c of CLASSES) acc[c] += b[c];
      acc.n += b.n;
      acc.tot += b.tot ?? b.n;
    }
    if (!have) { series.push([s * 1000, 0, 0, 0, 0, 0, 0, 0]); continue; }
    const pass = filtered ? Math.max(0, acc.tot - stoppedOf(acc) - acc.error) : acc.pass;
    series.push([s * 1000, ...[acc.tot, pass, acc.limit, acc.block, acc.auth, acc.miss, acc.error].map((v) => Math.round((v / 5) * 100) / 100)]);
  }
  const th = thresholds();
  return {
    enabled: logs.enabled || metrics.enabled,
    logs: { enabled: logs.enabled, ok: logs.ok, filtered },
    metrics: metrics.enabled,
    countries: countriesSeen,
    level, warm: now - started < WARMUP_MS,
    baseline: baseline === null ? null : Math.round(baseline * 10) / 10,
    thresholds: { attack: Math.round(th.attack), elevated: Math.round(th.elevated), stopped: Math.round(th.stopped), fixed: Boolean(config.shield.attackRps) },
    baselineStopped: Math.round(baselineStopped * 10) / 10,
    attack: attack ? { ...finish(attack, now), live: true } : null,
    attacks: attacks.map(({ top, paths, hosts, uas, countries, routers, series: sr, bans, ...rest }) => ({ ...rest, top: top.slice(0, 3), bans: bans.length })),
    series,
    sources: { m5: topSources(5, 50, now), m15: topSources(15, 50, now) },
    targets: { paths: topOf(recent.paths, 12), hosts: topOf(recent.hosts, 8), routers: topOf(recent.routers, 8) },
    countryList: topOf(recent.countries, 16),
    uas: topOf(recent.uas, 10),
    crowdsec: crowdsecSummary(),
    alerts: Boolean(config.webhookUrl) && config.shield.alerts,
  };
}

export function shieldSource(ip) {
  const s = sources.get(ip);
  const ban = banFor(ip);
  if (!s) return { ip, seen: false, ban };
  return {
    ip, seen: true, c: s.c, cc: s.cc, first: s.first, last: s.last, mins: s.mins,
    ua: topOf(s.ua, 8), paths: topOf(s.paths, 12), hosts: topOf(s.hosts, 8), routers: topOf(s.routers, 8),
    cloudflare: isCloudflare(ip), ban,
  };
}

export function shieldAttack(id) {
  if (attack && String(attack.id) === String(id)) return { ...finish(attack, Date.now()), live: true };
  return attacks.find((a) => String(a.id) === String(id)) ?? null;
}

export function shieldFindings() {
  const out = [];
  if (attack) {
    const b = brief(attack);
    out.push({
      id: 'attack', severity: 'warning', resource: null,
      title: `Under attack: ${b.peak} req/s at the peak`,
      detail: `Since ${hhmm(attack.start)}, from ${b.sources} sources; ${Math.round(b.stoppedPct * 100)}% of the logged requests were stopped at the edge so far.`,
      fix: 'Shield shows the sources and what they hit. Rate limits, an IP allow list or CrowdSec stop them in Traefik; Cloudflare\'s Under Attack mode stops them before they reach this server.',
    });
  }
  const sample = [...proxySample.values()];
  if (sample.length >= 30 && sample.filter(Boolean).length / sample.length >= 0.9) {
    out.push({
      id: 'proxy-ips', severity: 'warning', resource: null,
      title: 'Visitors show up with Cloudflare\'s addresses',
      detail: `${Math.round((sample.filter(Boolean).length / sample.length) * 100)}% of the client addresses in the access log belong to Cloudflare. Traefik does not trust it as a proxy, so rate limits, allow lists and CrowdSec all see Cloudflare instead of the visitor.`,
      fix: 'Trust Cloudflare\'s ranges on the entry points: --entrypoints.websecure.forwardedHeaders.trustedIPs=<the list at cloudflare.com/ips>, and the same for web.',
    });
  }
  return out;
}
