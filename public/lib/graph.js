// The proxy as a layered graph: entry points -> routers -> services (composites and their children)
// -> servers. Laid out left to right with a barycentre ordering to cut crossings, then each column
// placed by isotonic regression so nodes sit level with their neighbours without overlapping.
import { store, live } from './store.js';
import { qualify } from './format.js';
import { routerService, findService, childrenOf, serversOf, svcType, healthOf, isInternal, failoverActive, routerChain, findMiddleware, serverShares } from './model.js';

export const SIZES = {
  normal: { ep: [196, 54], router: [240, 58], service: [224, 58], missing: [210, 54], server: [208, 46], gapX: 128, gapY: 14, mwRow: 22 },
  compact: { ep: [170, 40], router: [232, 40], service: [216, 40], missing: [200, 40], server: [200, 34], gapX: 116, gapY: 8, mwRow: 18 },
};

/**
 * Nodes: { id, kind: ep | router | service | missing | server, name, data, col, x, y, w, h, ins, outs }
 * Edges: { id, from, to, kind: ep | route | child | server | aux, role, weight, percent }
 */
export function buildGraph(proto, { internal = false, mws = false } = {}) {
  const st = store.state;
  const nodes = new Map();
  const edges = [];
  const edgeIds = new Set();
  const add = (n) => { if (!nodes.has(n.id)) nodes.set(n.id, { ...n, ins: [], outs: [] }); return nodes.get(n.id); };
  const link = (from, to, extra = {}) => {
    const id = `${from}>${to}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    const e = { id, from, to, ...extra };
    edges.push(e);
    nodes.get(from).outs.push(e);
    nodes.get(to).ins.push(e);
  };
  const epByName = new Map((st?.entrypoints ?? []).map((e) => [e.name, e]));
  const routers = (st?.[proto]?.routers ?? []).filter((r) => internal || !isInternal(r));

  const visit = (name) => {
    const id = `svc:${name}`;
    if (nodes.has(id)) return id;
    const svc = findService(name, proto);
    add({ id, kind: svc ? 'service' : 'missing', name, data: svc ?? { name } });
    if (!svc) return id;
    for (const c of childrenOf(svc)) {
      const cid = visit(c.name);
      link(id, cid, { kind: 'child', role: c.role, weight: c.weight, percent: c.percent });
    }
    for (const x of serversOf(svc)) {
      const sid = `srv:${x.key}`;
      const sn = add({ id: sid, kind: 'server', name: x.key, data: { url: x.key, statuses: [] } });
      sn.data.statuses.push({ service: name, status: x.status, weight: x.weight });
      link(id, sid, { kind: 'server', status: x.status });
    }
    return id;
  };

  for (const r of routers) {
    const rid = `router:${r.name}`;
    add({ id: rid, kind: 'router', name: r.name, data: r, mws: routerChain(r, proto).filter((x) => x.depth === 0).map((x) => x.name) });
    for (const ep of r.entryPoints ?? r.using ?? []) {
      add({ id: `ep:${ep}`, kind: 'ep', name: ep, data: epByName.get(ep) ?? { name: ep } });
      link(`ep:${ep}`, rid, { kind: 'ep' });
    }
    const sname = routerService(r);
    if (sname) link(rid, visit(sname), { kind: 'route' });
    if (mws && proto === 'http') {
      for (const x of routerChain(r, proto)) {
        const m = findMiddleware(x.name, proto);
        if (m?.errors?.service) link(rid, visit(qualify(m.errors.service, m.provider)), { kind: 'aux', mw: m.name });
      }
    }
  }
  // services nothing routes to still exist: show them, faded
  for (const svc of st?.[proto]?.services ?? []) {
    if (nodes.has(`svc:${svc.name}`) || (!internal && isInternal(svc))) continue;
    nodes.get(visit(svc.name)).orphan = true;
  }

  // columns: services by their longest distance from a router-facing service
  const memo = new Map();
  const depth = (n, stack = new Set()) => {
    if (memo.has(n.id)) return memo.get(n.id);
    if (stack.has(n.id)) return 0;
    stack.add(n.id);
    let v = 0;
    for (const e of n.ins) if (e.kind === 'child') v = Math.max(v, depth(nodes.get(e.from), stack) + 1);
    stack.delete(n.id);
    memo.set(n.id, v);
    return v;
  };
  let maxD = 0;
  for (const n of nodes.values()) if (n.kind === 'service' || n.kind === 'missing') maxD = Math.max(maxD, depth(n));
  for (const n of nodes.values()) {
    n.col = n.kind === 'ep' ? 0 : n.kind === 'router' ? 1 : n.kind === 'server' ? 3 + maxD : 2 + depth(n);
  }
  return { proto, nodes, edges, cols: 4 + maxD, routerCount: routers.length };
}

// ── layout ───────────────────────────────────────────────────────────────────

const cy = (n) => n.y + n.h / 2;

/** Isotonic regression (pool adjacent violators): the closest non-decreasing sequence. */
function isotonic(t) {
  const blocks = [];
  for (const v of t) {
    blocks.push({ sum: v, n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
      const b = blocks.pop();
      blocks[blocks.length - 1].sum += b.sum;
      blocks[blocks.length - 1].n += b.n;
    }
  }
  return blocks.flatMap((b) => Array(b.n).fill(b.sum / b.n));
}

/** Place a column's nodes (in order) as close to `want` tops as possible, keeping order and gaps. */
function place(col, want, gap) {
  const off = [];
  let acc = 0;
  for (const n of col) { off.push(acc); acc += n.h + gap; }
  const z = isotonic(want.map((w, i) => w - off[i]));
  col.forEach((n, i) => { n.y = z[i] + off[i]; });
}

export function layoutGraph(g, { mws = false } = {}) {
  const compact = g.routerCount > 40;
  const S = compact ? SIZES.compact : SIZES.normal;
  for (const n of g.nodes.values()) {
    const [w, hh] = S[n.kind] ?? S.service;
    n.w = w;
    n.h = hh + (mws && n.kind === 'router' && n.mws?.length ? S.mwRow : 0);
  }
  const cols = Array.from({ length: g.cols }, () => []);
  for (const n of g.nodes.values()) cols[n.col].push(n);

  // initial order
  const internalEps = new Set(store.metrics?.internalEntrypoints ?? []);
  cols[0].sort((a, b) => (internalEps.has(a.name) - internalEps.has(b.name)) || a.name.localeCompare(b.name));
  const idx = new Map();
  const reindex = () => cols.forEach((c) => c.forEach((n, i) => idx.set(n.id, c.length > 1 ? i / (c.length - 1) : 0.5)));
  reindex();
  for (let c = 1; c < cols.length; c++) {
    cols[c].sort((a, b) => {
      const ka = a.ins.length ? Math.min(...a.ins.map((e) => idx.get(e.from) ?? 0)) : 2;
      const kb = b.ins.length ? Math.min(...b.ins.map((e) => idx.get(e.from) ?? 0)) : 2;
      return ka - kb || (a.orphan ?? false) - (b.orphan ?? false) || a.name.localeCompare(b.name);
    });
    reindex();
  }
  // barycentre sweeps
  const bary = (n, dir) => {
    const list = dir === 'in' ? n.ins.map((e) => e.from) : n.outs.map((e) => e.to);
    if (!list.length) return null;
    return list.reduce((a, id) => a + (idx.get(id) ?? 0), 0) / list.length;
  };
  for (let it = 0; it < 6; it++) {
    const down = it % 2 === 0;
    const order = down ? cols.map((_, i) => i).slice(1) : cols.map((_, i) => i).reverse().slice(1);
    for (const c of order) {
      const col = cols[c];
      const keyed = col.map((n, i) => [n, bary(n, down ? 'in' : 'out') ?? idx.get(n.id) ?? i / Math.max(1, col.length - 1)]);
      keyed.sort((a, b) => a[1] - b[1]);
      cols[c] = keyed.map(([n]) => n);
      reindex();
    }
  }

  // x: columns side by side
  let x = 0;
  const colInfo = cols.map((col, c) => {
    const w = col.length ? Math.max(...col.map((n) => n.w)) : 0;
    const info = { x, w, count: col.length };
    for (const n of col) n.x = x + (w - n.w) / 2;
    if (col.length) x += w + S.gapX;
    return info;
  });

  // y: stack, then pull each node level with its neighbours
  for (const col of cols) { let y = 0; for (const n of col) { n.y = y; y += n.h + S.gapY; } }
  const tallest = Math.max(...cols.map((col) => col.reduce((a, n) => a + n.h + S.gapY, 0)));
  for (const col of cols) {
    const hgt = col.reduce((a, n) => a + n.h + S.gapY, 0);
    for (const n of col) n.y += (tallest - hgt) / 2;
  }
  for (let it = 0; it < 8; it++) {
    const seq = it % 2 === 0 ? cols.map((_, i) => i) : cols.map((_, i) => i).reverse();
    for (const c of seq) {
      const col = cols[c];
      if (!col.length) continue;
      const want = col.map((n) => {
        const nb = [...n.ins.map((e) => g.nodes.get(e.from)), ...n.outs.map((e) => g.nodes.get(e.to))];
        return nb.length ? nb.reduce((a, m) => a + cy(m), 0) / nb.length - n.h / 2 : n.y;
      });
      place(col, want, S.gapY);
    }
  }
  let minY = Infinity; let maxY = -Infinity;
  for (const n of g.nodes.values()) { minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y + n.h); }
  if (!Number.isFinite(minY)) { minY = 0; maxY = 0; }
  for (const n of g.nodes.values()) n.y -= minY;

  // ports: edges leave and enter a node spread along its side, ordered by the other end
  for (const n of g.nodes.values()) {
    const spread = (list, other, key) => {
      const sorted = [...list].sort((a, b) => cy(g.nodes.get(other(a))) - cy(g.nodes.get(other(b))));
      const k = sorted.length;
      const span = Math.min(n.h * 0.56, (k - 1) * 7);
      sorted.forEach((e, i) => { e[key] = cy(n) + (k > 1 ? -span / 2 + (span * i) / (k - 1) : 0); });
    };
    spread(n.outs, (e) => e.to, 'y1');
    spread(n.ins, (e) => e.from, 'y2');
  }
  for (const e of g.edges) {
    const a = g.nodes.get(e.from); const b = g.nodes.get(e.to);
    e.x1 = a.x + a.w; e.x2 = b.x;
    const dx = Math.max(40, (e.x2 - e.x1) * 0.5);
    const c = [e.x1, e.y1, e.x1 + dx, e.y1, e.x2 - dx, e.y2, e.x2, e.y2];
    e.d = `M${c[0].toFixed(1)},${c[1].toFixed(1)} C${c[2].toFixed(1)},${c[3].toFixed(1)} ${c[4].toFixed(1)},${c[5].toFixed(1)} ${c[6].toFixed(1)},${c[7].toFixed(1)}`;
    e.curve = sampleBezier(c);
  }
  g.width = Math.max(0, x - S.gapX);
  g.height = maxY - minY;
  g.colInfo = colInfo;
  g.compact = compact;
  g.S = S;
  return g;
}

/** Points along a cubic curve with their running length, for moving particles at even speed. */
function sampleBezier([x0, y0, x1, y1, x2, y2, x3, y3], n = 32) {
  const xs = new Float32Array(n + 1); const ys = new Float32Array(n + 1); const len = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n; const u = 1 - t;
    xs[i] = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
    ys[i] = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
    len[i] = i ? len[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]) : 0;
  }
  const bbox = [Math.min(x0, x3), Math.min(...ys), Math.max(x0, x3), Math.max(...ys)];
  return { xs, ys, len, total: len[n], bbox };
}

export function pointAt(curve, d) {
  const { xs, ys, len } = curve;
  let lo = 0; let hi = len.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (len[mid] < d) lo = mid; else hi = mid; }
  const span = len[hi] - len[lo] || 1;
  const t = (d - len[lo]) / span;
  return [xs[lo] + (xs[hi] - xs[lo]) * t, ys[lo] + (ys[hi] - ys[lo]) * t];
}

// ── paths and flows ──────────────────────────────────────────────────────────

/** Everything upstream and downstream of some nodes: { nodes: Set, edges: Set } */
export function pathOf(g, ids) {
  const nodes = new Set(); const edges = new Set();
  const walk = (id, dir) => {
    const n = g.nodes.get(id);
    if (!n) return;
    for (const e of dir === 'up' ? n.ins : n.outs) {
      if (edges.has(e.id)) continue;
      edges.add(e.id);
      const next = dir === 'up' ? e.from : e.to;
      nodes.add(next);
      walk(next, dir);
    }
  };
  for (const id of ids) { nodes.add(id); walk(id, 'up'); walk(id, 'down'); }
  return { nodes, edges };
}

/**
 * Requests a second on every edge. Routers and load balancers are measured; what a composite service
 * passes to its children follows its weights, mirror percentages or which failover side is active;
 * what a load balancer passes to each server follows the access log, or an even split.
 */
export function computeFlows(g) {
  const flows = new Map();      // edge id -> { rps, err, measured }
  const nodeFlow = new Map();   // node id -> { rps, err }
  const set = (e, rps, err) => flows.set(e.id, { rps: Math.max(0, rps || 0), err: Math.max(0, Math.min(1, err || 0)) });
  const proto = g.proto;
  const conns = store.metrics?.gauges?.openConnections ?? {};

  for (const n of g.nodes.values()) {
    if (n.kind === 'ep') {
      const p = proto === 'http' ? live('ep', n.name) : null;
      nodeFlow.set(n.id, { rps: p?.rps ?? (proto !== 'http' ? conns[n.name] ?? 0 : 0), err: p?.errorRate ?? 0, conns: conns[n.name] ?? 0 });
    }
  }
  // routers
  for (const n of g.nodes.values()) {
    if (n.kind !== 'router') continue;
    let rps = 0; let err = 0;
    if (proto === 'http') { const p = live('router', n.name); rps = p?.rps ?? 0; err = p?.errorRate ?? 0; } else {
      // TCP/UDP have no per-router numbers: share the entry point's open connections
      for (const e of n.ins) { const ep = g.nodes.get(e.from); rps += (nodeFlow.get(ep.id)?.rps ?? 0) / Math.max(1, ep.outs.length); }
    }
    nodeFlow.set(n.id, { rps, err });
    const eps = n.ins.map((e) => [e, Math.max(0.0001, nodeFlow.get(e.from)?.rps ?? 0)]);
    const tot = eps.reduce((a, [, v]) => a + v, 0);
    for (const [e, v] of eps) set(e, proto === 'http' ? rps * (v / tot) : rps / Math.max(1, eps.length), err);
    for (const e of n.outs) set(e, e.kind === 'aux' ? rps * err : rps, e.kind === 'aux' ? 1 : err);
  }
  // services, parents before children
  const svcs = [...g.nodes.values()].filter((n) => n.kind === 'service' || n.kind === 'missing').sort((a, b) => a.col - b.col);
  const shares = proto === 'http' ? serverShares() : new Map();
  for (const n of svcs) {
    let inflow = 0; let inErr = 0;
    for (const e of n.ins) { const f = flows.get(e.id); if (f && e.kind !== 'aux') { inflow += f.rps; inErr += f.rps * f.err; } }
    const own = proto === 'http' ? live('service', n.name) : null;
    const rps = own ? own.rps : inflow;
    const err = own ? own.errorRate : inflow ? inErr / inflow : 0;
    nodeFlow.set(n.id, { rps, err, measured: Boolean(own) });
    const svc = n.data;
    const kids = n.outs.filter((e) => e.kind === 'child');
    if (kids.length) {
      const type = svcType(svc);
      const wsum = kids.reduce((a, e) => a + (e.weight ?? 0), 0) || 1;
      const active = type === 'failover' ? failoverActive(svc, proto).active?.name : null;
      for (const e of kids) {
        const child = live('service', g.nodes.get(e.to).name);
        const v = type === 'weighted' ? rps * ((e.weight ?? 0) / wsum) : type === 'mirroring' ? (e.role === 'main' ? rps : rps * ((e.percent ?? 0) / 100)) : type === 'failover' ? (g.nodes.get(e.to).name === active ? rps : 0) : rps / kids.length;
        set(e, v, child?.errorRate ?? err);
        e.standby = type === 'failover' && g.nodes.get(e.to).name !== active;
      }
    }
    const srv = n.outs.filter((e) => e.kind === 'server');
    if (srv.length) {
      const seen = shares.get(n.name);
      const total = seen ? [...seen.values()].reduce((a, c) => a + c.n, 0) : 0;
      const alive = srv.filter((e) => e.status !== 'DOWN');
      for (const e of srv) {
        const key = g.nodes.get(e.to).name;
        const c = seen?.get(key);
        const share = total >= 10 ? (c?.n ?? 0) / total : e.status === 'DOWN' ? 0 : 1 / Math.max(1, alive.length);
        set(e, rps * share, c?.n ? c.errors / c.n : err);
      }
    }
  }
  for (const n of g.nodes.values()) {
    if (n.kind !== 'server') continue;
    const rps = n.ins.reduce((a, e) => a + (flows.get(e.id)?.rps ?? 0), 0);
    const er = n.ins.reduce((a, e) => a + (flows.get(e.id)?.rps ?? 0) * (flows.get(e.id)?.err ?? 0), 0);
    nodeFlow.set(n.id, { rps, err: rps ? er / rps : 0 });
  }
  return { flows, nodeFlow };
}

/** Health of a node for colouring: ok | warn | bad | idle */
export function nodeHealth(n, proto) {
  if (n.kind === 'router') return n.data.status === 'disabled' ? 'bad' : n.data.status === 'warning' ? 'warn' : 'ok';
  if (n.kind === 'missing') return 'bad';
  if (n.kind === 'service') {
    const hl = healthOf(n.name, proto);
    return hl === 'down' || hl === 'missing' ? 'bad' : hl === 'partial' ? 'warn' : 'ok';
  }
  if (n.kind === 'server') {
    const st = n.data.statuses.map((x) => x.status).filter(Boolean);
    if (!st.length) return 'idle';
    if (st.every((x) => x === 'DOWN')) return 'bad';
    if (st.some((x) => x === 'DOWN')) return 'warn';
    return 'ok';
  }
  return 'ok';
}
