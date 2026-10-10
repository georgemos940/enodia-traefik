// Traefik's Prometheus metrics, scraped on the poll interval and turned into rates: requests a second
// by status class, latency percentiles, bandwidth, for the whole proxy and for every entry point,
// router and service. An hour of points is kept in memory, so no Prometheus is needed.
import { config } from './config.mjs';
import { get } from './http.mjs';
import { parsePrometheus, histogramQuantile } from './prom.mjs';
import { state as traefik } from './traefik.mjs';

const FAMILIES = [
  { prefix: 'traefik_entrypoint_', label: 'entrypoint', key: 'ep' },
  { prefix: 'traefik_router_', label: 'router', key: 'router' },
  { prefix: 'traefik_service_', label: 'service', key: 'service' },
];

export const metrics = {
  enabled: Boolean(config.traefik.metricsUrl),
  ok: false,
  error: null,
  scrapedAt: null,
  stepSeconds: config.pollSeconds,
  latest: {},        // key -> latest point
  totals: {},        // key -> { requests, codes: {200: n}, methods: {GET: n}, bytesIn, bytesOut } since Traefik started
  gauges: {
    openConnections: {},  // entrypoint -> n
    serverUp: {},         // service -> { url: 0|1 }
    reloads: null,
    lastReloadSuccess: null,
    process: {},
    tls: {},              // entrypoint -> { "1.3": n }
    ciphers: {},          // cipher -> n
    retries: {},          // service -> n
  },
  certs: [],
  internalEntrypoints: [],
};

const series = new Map();  // key -> [point]
const keepPoints = () => Math.ceil((config.historyMinutes * 60) / config.pollSeconds) + 1;
let prev = null;           // key -> cumulative aggregate
let prevAt = 0;
let prevCpu = null;

const classOf = (code) => {
  const c = Number(code);
  if (c >= 500) return '5xx';
  if (c >= 400) return '4xx';
  if (c >= 300) return '3xx';
  if (c >= 100) return '2xx';
  return 'other';
};

function blank() {
  return { classes: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 }, codes: {}, methods: {}, buckets: new Map(), sum: 0, count: 0, bytesIn: 0, bytesOut: 0 };
}

/** Every family folded to its key (entry point / router / service), summed over code, method and protocol. */
function aggregate(samples) {
  const agg = new Map();
  const at = (k) => { if (!agg.has(k)) agg.set(k, blank()); return agg.get(k); };
  const gauges = { openConnections: {}, serverUp: {}, reloads: null, lastReloadSuccess: null, process: {}, tls: {}, ciphers: {}, retries: {} };
  const certs = [];

  for (const s of samples) {
    const n = s.name;
    if (n === 'traefik_open_connections') { gauges.openConnections[s.labels.entrypoint ?? '?'] = (gauges.openConnections[s.labels.entrypoint ?? '?'] ?? 0) + s.value; continue; }
    if (n === 'traefik_service_server_up') { (gauges.serverUp[s.labels.service] ??= {})[s.labels.url] = s.value; continue; }
    if (n === 'traefik_config_reloads_total') { gauges.reloads = s.value; continue; }
    if (n === 'traefik_config_last_reload_success') { gauges.lastReloadSuccess = s.value; continue; }
    if (n === 'traefik_tls_certs_not_after') {
      certs.push({ cn: s.labels.cn ?? '', sans: (s.labels.sans ?? '').split(',').filter(Boolean), serial: s.labels.serial ?? '', notAfter: new Date(s.value * 1000).toISOString() });
      continue;
    }
    if (n === 'traefik_service_retries_total') { gauges.retries[s.labels.service] = s.value; continue; }
    if (n === 'traefik_entrypoint_requests_tls_total') {
      const ep = s.labels.entrypoint ?? '?';
      (gauges.tls[ep] ??= {})[s.labels.tls_version ?? '?'] = ((gauges.tls[ep] ?? {})[s.labels.tls_version ?? '?'] ?? 0) + s.value;
      gauges.ciphers[s.labels.tls_cipher ?? '?'] = (gauges.ciphers[s.labels.tls_cipher ?? '?'] ?? 0) + s.value;
      continue;
    }
    if (n === 'process_resident_memory_bytes') { gauges.process.memory = s.value; continue; }
    if (n === 'process_cpu_seconds_total') { gauges.process.cpuSeconds = s.value; continue; }
    if (n === 'process_start_time_seconds') { gauges.process.startTime = s.value; continue; }
    if (n === 'process_open_fds') { gauges.process.openFds = s.value; continue; }
    if (n === 'process_max_fds') { gauges.process.maxFds = s.value; continue; }
    if (n === 'go_goroutines') { gauges.process.goroutines = s.value; continue; }
    if (n === 'go_memstats_heap_alloc_bytes') { gauges.process.heap = s.value; continue; }

    const fam = FAMILIES.find((f) => n.startsWith(f.prefix));
    if (!fam) continue;
    const id = s.labels[fam.label];
    if (id === undefined) continue;
    const a = at(`${fam.key}:${id}`);
    const metric = n.slice(fam.prefix.length);
    if (metric === 'requests_total') {
      a.classes[classOf(s.labels.code)] += s.value;
      if (s.labels.code) a.codes[s.labels.code] = (a.codes[s.labels.code] ?? 0) + s.value;
      if (s.labels.method) a.methods[s.labels.method] = (a.methods[s.labels.method] ?? 0) + s.value;
    } else if (metric === 'request_duration_seconds_bucket') {
      const le = s.labels.le === '+Inf' ? Infinity : Number(s.labels.le);
      a.buckets.set(le, (a.buckets.get(le) ?? 0) + s.value);
    } else if (metric === 'request_duration_seconds_sum') a.sum += s.value;
    else if (metric === 'request_duration_seconds_count') a.count += s.value;
    else if (metric === 'requests_bytes_total') a.bytesIn += s.value;
    else if (metric === 'responses_bytes_total') a.bytesOut += s.value;
  }

  // the whole proxy: every entry point that serves traffic, not the ones Enodia itself scrapes
  const internal = new Set(metrics.internalEntrypoints);
  const total = blank();
  for (const [k, a] of agg) {
    if (!k.startsWith('ep:') || internal.has(k.slice(3))) continue;
    for (const c of Object.keys(total.classes)) total.classes[c] += a.classes[c];
    for (const [c, v] of Object.entries(a.codes)) total.codes[c] = (total.codes[c] ?? 0) + v;
    for (const [m, v] of Object.entries(a.methods)) total.methods[m] = (total.methods[m] ?? 0) + v;
    for (const [le, v] of a.buckets) total.buckets.set(le, (total.buckets.get(le) ?? 0) + v);
    total.sum += a.sum; total.count += a.count; total.bytesIn += a.bytesIn; total.bytesOut += a.bytesOut;
  }
  agg.set('total', total);
  return { agg, gauges, certs };
}

const requests = (a) => Object.values(a.classes).reduce((s, v) => s + v, 0);
const sortedBuckets = (m) => [...m.entries()].sort((x, y) => x[0] - y[0]).map(([le, count]) => ({ le, count }));

function point(now, cur, before, dt) {
  const d = (x, y) => Math.max(0, x - y);
  const reset = before && requests(cur) < requests(before);
  const b = reset || !before ? null : before;
  const dc = Object.fromEntries(Object.keys(cur.classes).map((c) => [c, b ? d(cur.classes[c], b.classes[c]) : 0]));
  const dReq = Object.values(dc).reduce((s, v) => s + v, 0);
  const cb = sortedBuckets(cur.buckets);
  const deltaBuckets = cb.map(({ le, count }) => ({ le, count: b ? d(count, b.buckets.get(le) ?? 0) : 0 }));
  const dCount = b ? d(cur.count, b.count) : 0;
  const dSum = b ? d(cur.sum, b.sum) : 0;
  const q = (x) => { const v = histogramQuantile(x, deltaBuckets); return v === null ? null : Math.round(v * 1000); };
  return {
    t: now,
    rps: dReq / dt,
    r2: dc['2xx'] / dt, r3: dc['3xx'] / dt, r4: dc['4xx'] / dt, r5: dc['5xx'] / dt,
    errorRate: dReq > 0 ? dc['5xx'] / dReq : 0,
    p50: dCount ? q(0.5) : null, p95: dCount ? q(0.95) : null, p99: dCount ? q(0.99) : null,
    avg: dCount ? Math.round((dSum / dCount) * 1000) : null,
    inBps: b ? d(cur.bytesIn, b.bytesIn) / dt : 0,
    outBps: b ? d(cur.bytesOut, b.bytesOut) / dt : 0,
  };
}

function pushPoint(key, p) {
  if (!series.has(key)) series.set(key, []);
  const list = series.get(key);
  list.push(p);
  const keep = keepPoints();
  if (list.length > keep) list.splice(0, list.length - keep);
}

function internalEntrypoints() {
  const s = traefik.static;
  const out = new Set();
  const metricsEp = s?.metrics?.prometheus?.entryPoint;
  if (metricsEp) out.add(metricsEp);
  if (s?.api?.insecure || !s) out.add('traefik');
  if (!s) out.add('metrics');
  return [...out];
}

export async function scrape() {
  if (!metrics.enabled) return null;
  try {
    const r = await get(config.traefik.metricsUrl, { accept: 'text/plain' });
    if (r.status !== 200) throw new Error(`metrics endpoint answered ${r.status}`);
    metrics.internalEntrypoints = internalEntrypoints();
    const { agg, gauges, certs } = aggregate(parsePrometheus(r.body.toString('utf8')));
    const now = Date.now();
    const dt = prev ? Math.max(0.5, (now - prevAt) / 1000) : config.pollSeconds;

    const latest = {};
    for (const [key, cur] of agg) {
      const p = point(now, cur, prev?.get(key), dt);
      if (prev) pushPoint(key, p);
      latest[key] = p;
    }
    // a key that disappeared still gets a zero point so its chart ends cleanly
    if (prev) for (const key of prev.keys()) if (!agg.has(key)) pushPoint(key, { t: now, rps: 0, r2: 0, r3: 0, r4: 0, r5: 0, errorRate: 0, p50: null, p95: null, p99: null, avg: null, inBps: 0, outBps: 0 });

    if (gauges.process.cpuSeconds !== undefined) {
      gauges.process.cpu = prevCpu !== null && prev ? Math.max(0, (gauges.process.cpuSeconds - prevCpu) / dt) : null;
      prevCpu = gauges.process.cpuSeconds;
    }

    metrics.totals = Object.fromEntries([...agg].map(([k, a]) => [k, { requests: requests(a), classes: a.classes, codes: a.codes, methods: a.methods, bytesIn: a.bytesIn, bytesOut: a.bytesOut, avg: a.count ? Math.round((a.sum / a.count) * 1000) : null }]));
    Object.assign(metrics, { ok: true, error: null, scrapedAt: new Date(now).toISOString(), latest, gauges, certs, stepSeconds: config.pollSeconds });
    prev = agg;
    prevAt = now;
    return latest;
  } catch (e) {
    Object.assign(metrics, { ok: false, error: e.message, scrapedAt: new Date().toISOString() });
    return null;
  }
}

/** Points for the given keys over the last `minutes`. */
export function seriesFor(keys, minutes = 15) {
  const since = Date.now() - minutes * 60_000;
  return Object.fromEntries(keys.map((k) => [k, (series.get(k) ?? []).filter((p) => p.t >= since)]));
}

export function seriesKeys() {
  return [...series.keys()];
}

/** The busiest routers or services over the last few minutes. */
export function top(kind, minutes = 5, limit = 10) {
  const since = Date.now() - minutes * 60_000;
  const rows = [];
  for (const [key, list] of series) {
    if (!key.startsWith(`${kind}:`)) continue;
    const pts = list.filter((p) => p.t >= since);
    if (!pts.length) continue;
    const rps = pts.reduce((s, p) => s + p.rps, 0) / pts.length;
    const r5 = pts.reduce((s, p) => s + p.r5, 0) / pts.length;
    const lat = pts.map((p) => p.p95).filter((v) => v !== null);
    rows.push({ name: key.slice(kind.length + 1), rps, errorRate: rps > 0 ? r5 / rps : 0, p95: lat.length ? Math.max(...lat) : null });
  }
  return rows.sort((a, b) => b.rps - a.rps).slice(0, limit);
}
