// How Traefik's pieces hang together: which service a router sends to, what a weighted, mirroring or
// failover service points at, who uses a middleware and where in the chain. Shared by the services,
// middlewares and topology pages.
import { store, all, live } from './store.js';
import { qualify, split } from './format.js';

// ── service types ────────────────────────────────────────────────────────────

export const SERVICE_TYPES = {
  loadbalancer: { label: 'Load balancer', short: 'LB', glyph: 'network', hue: 199, desc: 'Spreads requests over a list of servers.' },
  weighted: { label: 'Weighted', short: 'Weighted', glyph: 'scale', hue: 258, desc: 'Splits traffic between services by weight: canaries and blue/green.' },
  mirroring: { label: 'Mirroring', short: 'Mirror', glyph: 'flip', hue: 38, desc: 'Sends every request to a main service and copies a share to mirrors.' },
  failover: { label: 'Failover', short: 'Failover', glyph: 'buoy', hue: 12, desc: 'Uses a primary service and falls back when its health check fails.' },
  internal: { label: 'Internal', short: 'Internal', glyph: 'cpu', hue: 230, desc: 'Built into Traefik: the API, dashboard, ping, metrics.' },
  unknown: { label: 'Service', short: 'Service', glyph: 'service', hue: 220, desc: '' },
};

export function svcType(svc) {
  if (!svc) return 'unknown';
  if (svc.type && SERVICE_TYPES[svc.type]) return svc.type;
  if (svc.loadBalancer) return 'loadbalancer';
  if (svc.weighted) return 'weighted';
  if (svc.mirroring) return 'mirroring';
  if (svc.failover) return 'failover';
  if (svc.provider === 'internal' || split(svc.name).provider === 'internal') return 'internal';
  return 'unknown';
}

export const isInternal = (x) => (x?.provider ?? split(x?.name ?? '').provider) === 'internal';

/** The service a router sends to, qualified with the router's provider. */
export const routerService = (r) => (r?.service ? qualify(r.service, r.provider ?? split(r.name).provider) : null);

/** The servers of a load balancer: [{ key, url, weight, status }]. status: UP | DOWN | null (no health info). */
export function serversOf(svc) {
  const list = svc?.loadBalancer?.servers ?? [];
  const st = svc?.serverStatus ?? {};
  return list.map((x) => {
    const key = x.url ?? x.address ?? '';
    return { key, url: key, weight: x.weight, preservePath: x.preservePath, tls: x.tls, status: st[key] ?? null };
  });
}

/** The services a composite service points at: [{ name, role, weight, percent }]. */
export function childrenOf(svc) {
  if (!svc) return [];
  const prov = svc.provider ?? split(svc.name).provider;
  const q = (n) => qualify(n, prov);
  if (svc.weighted) return (svc.weighted.services ?? []).map((x) => ({ name: q(x.name), role: 'weight', weight: x.weight ?? 1 }));
  if (svc.mirroring) {
    return [
      { name: q(svc.mirroring.service), role: 'main', percent: 100 },
      ...(svc.mirroring.mirrors ?? []).map((m) => ({ name: q(m.name), role: 'mirror', percent: m.percent ?? 0 })),
    ];
  }
  if (svc.failover) {
    return [
      svc.failover.service ? { name: q(svc.failover.service), role: 'primary' } : null,
      svc.failover.fallback ? { name: q(svc.failover.fallback), role: 'fallback' } : null,
    ].filter(Boolean);
  }
  return [];
}

export function services(proto) {
  return store.state?.[proto]?.services ?? [];
}
export function findService(name, proto = 'http') {
  return services(proto).find((x) => x.name === name) ?? null;
}

/** Composite services that point at this one, and errors middlewares that send their pages here. */
export function parentsOf(name, proto = 'http') {
  const out = [];
  for (const s of services(proto)) for (const c of childrenOf(s)) if (c.name === name) out.push({ service: s, ...c });
  return out;
}
export function errorPagesFor(name) {
  return (store.state?.http?.middlewares ?? []).filter((m) => m.errors?.service && qualify(m.errors.service, m.provider) === name);
}

/**
 * Health of a service, following composites down to their servers.
 *   'up' every known server answers, 'partial' some are down, 'down' none answer, 'unknown' no health data.
 */
export function healthOf(name, proto = 'http', seen = new Set()) {
  if (seen.has(name)) return 'unknown';
  seen.add(name);
  const svc = findService(name, proto);
  if (!svc) return 'missing';
  if (svc.loadBalancer) {
    const st = Object.values(svc.serverStatus ?? {});
    if (!st.length) return (svc.loadBalancer.servers ?? []).length ? 'unknown' : 'down';
    const up = st.filter((v) => v === 'UP').length;
    return up === st.length ? 'up' : up ? 'partial' : 'down';
  }
  if (svc.failover) {
    const [p, f] = childrenOf(svc);
    const hp = p ? healthOf(p.name, proto, new Set(seen)) : 'down';
    if (hp !== 'down' && hp !== 'missing') return hp === 'partial' ? 'partial' : hp;
    const hf = f ? healthOf(f.name, proto, new Set(seen)) : 'down';
    return hf === 'down' || hf === 'missing' ? 'down' : 'partial';
  }
  const kids = childrenOf(svc).filter((c) => c.role !== 'mirror');
  if (!kids.length) return 'unknown';
  const hs = kids.map((c) => healthOf(c.name, proto, new Set(seen)));
  if (hs.every((x) => x === 'up' || x === 'unknown')) return hs.some((x) => x === 'up') ? 'up' : 'unknown';
  if (hs.every((x) => x === 'down' || x === 'missing')) return 'down';
  return 'partial';
}

/** For a failover service: which side is serving right now. */
export function failoverActive(svc, proto = 'http') {
  const [p, f] = childrenOf(svc);
  const hp = p ? healthOf(p.name, proto) : 'missing';
  const primaryOk = hp !== 'down' && hp !== 'missing';
  return { primary: p, fallback: f, primaryHealth: hp, active: primaryOk ? p : f };
}

/** Every router that ends up at this service, directly or through composites above it. */
export function routersReaching(name, proto = 'http') {
  const routers = store.state?.[proto]?.routers ?? [];
  const direct = routers.filter((r) => routerService(r) === name);
  const out = direct.map((r) => ({ router: r, via: null }));
  const seen = new Set([name]);
  const walk = (n, path) => {
    for (const p of parentsOf(n, proto)) {
      if (seen.has(p.service.name)) continue;
      seen.add(p.service.name);
      for (const r of routers.filter((x) => routerService(x) === p.service.name)) out.push({ router: r, via: [...path, p.service.name] });
      walk(p.service.name, [...path, p.service.name]);
    }
  };
  walk(name, []);
  return out;
}

/** The load balancers under a service (itself if it is one). */
export function leavesOf(name, proto = 'http', seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const svc = findService(name, proto);
  if (!svc) return [];
  if (svc.loadBalancer) return [svc];
  return childrenOf(svc).flatMap((c) => leavesOf(c.name, proto, seen));
}

/**
 * Live numbers for a service. Load balancers have their own metrics; a composite has none in Traefik,
 * so it is measured by the routers that send to it.
 */
export function serviceLive(svc) {
  if (!svc) return null;
  const own = live('service', svc.name);
  if (own) return { ...own, source: 'service' };
  if (svc.loadBalancer) return null;
  const rs = (svc.usedBy ?? []).map((r) => live('router', r)).filter(Boolean);
  if (!rs.length) return null;
  return sumPoints(rs, 'routers');
}

export function sumPoints(list, source = '') {
  const out = { rps: 0, r2: 0, r3: 0, r4: 0, r5: 0, inBps: 0, outBps: 0, source };
  let wsum = 0; let p50 = 0; let p95 = 0; let p99 = 0;
  for (const p of list) {
    for (const k of ['rps', 'r2', 'r3', 'r4', 'r5', 'inBps', 'outBps']) out[k] += p[k] ?? 0;
    const w = p.rps || 0;
    wsum += w;
    p50 += (p.p50 ?? 0) * w; p95 += (p.p95 ?? 0) * w; p99 += (p.p99 ?? 0) * w;
  }
  out.errorRate = out.rps ? out.r5 / out.rps : 0;
  out.p50 = wsum ? p50 / wsum : null; out.p95 = wsum ? p95 / wsum : null; out.p99 = wsum ? p99 / wsum : null;
  out.t = list[0]?.t;
  return out;
}

/** Which servers of each service the recent access log saw: Map(service -> Map(server -> { n, errors, ms })). */
export function serverShares(entries = store.logs, sinceMs = 3 * 60_000) {
  const since = Date.now() - sinceMs;
  const out = new Map();
  for (const e of entries) {
    if (!e.service || !e.server) continue;
    if (sinceMs && e.t && Date.parse(e.t) < since) continue;
    let m = out.get(e.service);
    if (!m) out.set(e.service, m = new Map());
    let c = m.get(e.server);
    if (!c) m.set(e.server, c = { n: 0, errors: 0, ms: 0, last: null, lastStatus: null });
    c.n++;
    if (e.status >= 500) c.errors++;
    c.ms += e.durationMs ?? 0;
    if (!c.last || e.t > c.last) { c.last = e.t; c.lastStatus = e.status; }
  }
  return out;
}

// ── middlewares ──────────────────────────────────────────────────────────────

/** The key a middleware keeps its config under: type "ratelimit" -> "rateLimit". */
export function mwConfigKey(m) {
  if (!m) return null;
  const skip = new Set(['name', 'provider', 'status', 'usedBy', 'type', 'error', 'proto']);
  const keys = Object.keys(m).filter((k) => !skip.has(k));
  return keys.find((k) => k.toLowerCase() === String(m.type ?? '').toLowerCase()) ?? keys.find((k) => m[k] && typeof m[k] === 'object') ?? null;
}
export const mwConfig = (m) => (m ? m[mwConfigKey(m)] ?? {} : {});
export const mwKind = (m) => mwConfigKey(m) ?? m?.type ?? 'unknown';

export function middlewares(proto) {
  return store.state?.[proto]?.middlewares ?? [];
}
export function findMiddleware(name, proto = 'http') {
  return middlewares(proto).find((x) => x.name === name) ?? null;
}

/** The middlewares a router runs, chains expanded: [{ name, depth, via }]. */
export function routerChain(r, proto = 'http') {
  const prov = r.provider ?? split(r.name).provider;
  const out = [];
  const walk = (names, depth, via, seen) => {
    for (const n of names ?? []) {
      const q = qualify(n, prov);
      out.push({ name: q, depth, via });
      const m = findMiddleware(q, proto);
      if (m?.chain && !seen.has(q)) walk((m.chain.middlewares ?? []).map((x) => qualify(x, m.provider)), depth + 1, q, new Set([...seen, q]));
    }
  };
  walk(r.middlewares, 0, null, new Set());
  return out;
}

/** Where a middleware runs: [{ router, index, total, via }] with index 1-based in the router's list. */
export function mwUsage(name, proto = 'http') {
  const routers = store.state?.[proto]?.routers ?? [];
  const out = [];
  for (const r of routers) {
    const prov = r.provider ?? split(r.name).provider;
    const list = (r.middlewares ?? []).map((n) => qualify(n, prov));
    list.forEach((n, i) => {
      if (n === name) out.push({ router: r, index: i + 1, total: list.length, via: null, chain: list });
      else {
        const m = findMiddleware(n, proto);
        if (m?.chain && chainContains(m, name, proto, new Set())) out.push({ router: r, index: i + 1, total: list.length, via: n, chain: list });
      }
    });
  }
  return out;
}
function chainContains(m, name, proto, seen) {
  if (seen.has(m.name)) return false;
  seen.add(m.name);
  for (const n of (m.chain?.middlewares ?? []).map((x) => qualify(x, m.provider))) {
    if (n === name) return true;
    const sub = findMiddleware(n, proto);
    if (sub?.chain && chainContains(sub, name, proto, seen)) return true;
  }
  return false;
}

export const protoCounts = (kind) => ({
  http: store.state?.http?.[kind]?.length ?? 0,
  tcp: store.state?.tcp?.[kind]?.length ?? 0,
  udp: store.state?.udp?.[kind]?.length ?? 0,
});

export { all };
