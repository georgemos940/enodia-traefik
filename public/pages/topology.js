// Topology: the whole proxy as a map. Entry points -> routers -> services -> servers, with live
// requests flowing along the edges. Hover follows a path, click opens the details, drag and wheel
// move around, the search focuses whatever matches.
import { h, s } from '../lib/dom.js';
import { glyph } from '../lib/glyphs.js';
import { store, live } from '../lib/store.js';
import { pageHead, searchInput, drawer, badge, statusBadge, providerBadge, kv, hrefFor, banner } from '../lib/components.js';
import { ruleView, hostsOf } from '../lib/rules.js';
import { rate, pct, ms, split, plural, num } from '../lib/format.js';
import { buildGraph, layoutGraph, pathOf, computeFlows, nodeHealth, pointAt } from '../lib/graph.js';
import { SERVICE_TYPES, svcType, findMiddleware, childrenOf, serversOf, healthOf, routersReaching, protoCounts, isInternal, serviceLive } from '../lib/model.js';
import { kindOf, summaryOf, tone } from '../lib/mwkinds.js';
import { tile, filterChip, healthDot, HEALTH, errTone } from '../lib/gparts.js';

const PROTOS = [['http', 'HTTP'], ['tcp', 'TCP'], ['udp', 'UDP']];
const KIND = {
  ep: { label: 'Entry points', glyph: 'entrypoint', hue: 258 },
  router: { label: 'Routers', glyph: 'router', hue: 38 },
  service: { label: 'Services', glyph: 'service', hue: 199 },
  missing: { label: 'Missing', glyph: 'ghost', hue: 0 },
  server: { label: 'Servers', glyph: 'server', hue: 152 },
};
const SPEED = 170;          // particle speed, graph units a second
const MIN_K = 0.08;
const MAX_K = 2.6;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// text width for truncating labels inside SVG nodes
const measureCtx = document.createElement('canvas').getContext('2d');
function fitText(text, max, font) {
  measureCtx.font = font;
  if (measureCtx.measureText(text).width <= max) return text;
  let lo = 0; let hi = text.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (measureCtx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid; else hi = mid - 1; }
  return `${text.slice(0, lo)}…`;
}

export default {
  render(ctx) {
    ctx.setCrumbs([['Topology']]);
    const q = ctx.query;
    let proto = PROTOS.some(([p]) => p === q.get('proto')) ? q.get('proto') : 'http';
    let showMws = q.get('mw') === '1';
    let showInternal = q.get('internal') === '1';
    let particlesOn = !reducedMotion();
    let query = q.get('q') ?? '';
    const sans = getComputedStyle(document.body).fontFamily;
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace';
    const FONT = { title: `650 12.5px ${sans}`, sub: `500 11px ${sans}`, metric: `650 11px ${mono}` };

    let g = null;
    let flows = { flows: new Map(), nodeFlow: new Map() };
    const view = { k: 1, x: 0, y: 0 };
    let anim = null;
    let hoverId = null;
    let focusIds = null;        // Set of node ids from the search or a focus click
    let focusFromSearch = false;
    let active = null;          // { nodes, edges } highlighted path
    let closeDrawer = null;
    let raf = 0;
    let running = true;
    let lastT = 0;
    let fitted = false;
    let userMoved = false;      // the view was panned or zoomed by hand: keep it across rebuilds
    const nodeEls = new Map();
    const haloEls = new Map();
    const edgeEls = new Map();
    const pstate = new Map();   // edge id -> particle state

    // ── DOM ──
    const el = h('div', { class: 'col gap-lg gr-topo' });
    const protoSeg = h('div', { class: 'seg gr-proto-seg' });
    const statsEl = h('div', { class: 'gr-map-stats' });
    const colsEl = h('div', { class: 'gr-cols', 'aria-hidden': 'true' });
    const zoomLabel = h('button', { class: 'gr-zoom-label tnum', type: 'button', title: 'Back to 100%', onclick: () => zoomAt(1 / view.k) }, '100%');
    const noteEl = h('div', { class: 'gr-map-note gr-map-ui', hidden: true });
    const tipEl = h('div', { class: 'gr-map-tip', hidden: true });
    const emptyEl = h('div', { class: 'gr-map-empty', hidden: true });
    const edgeRoot = s('g', { class: 'gr-view' });
    const nodeRoot = s('g', { class: 'gr-view' });
    const haloRoot = s('g', { class: 'gr-view' });
    // glows for broken nodes live in their own layer: it pulses by opacity alone, so the big node layer never repaints
    const svgHalo = s('svg', { class: 'gr-svg gr-svg-halo', 'aria-hidden': 'true' }, haloRoot);
    const svgEdges = s('svg', { class: 'gr-svg gr-svg-edges', 'aria-hidden': 'true' }, edgeRoot);
    const svgNodes = s('svg', { class: 'gr-svg gr-svg-nodes', role: 'img', 'aria-label': 'Map of entry points, routers, services and servers' }, nodeRoot);
    const canvas = h('canvas', { class: 'gr-particles' });
    const pctx = canvas.getContext('2d');
    const mini = h('canvas', { class: 'gr-minimap gr-map-ui', width: 360, height: 240, title: 'Click to move around' });
    const mctx = mini.getContext('2d');
    const chips = h('div', { class: 'gr-fchips' });
    const search = searchInput({ placeholder: 'Find a router, service, host or server…', value: query, oninput: (v) => { query = v; applySearch(false); } });
    search.querySelector('input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applySearch(true); }
      if (e.key === 'Escape') { e.target.value = ''; query = ''; applySearch(false); }
    });

    const btn = (g2, title, onclick) => h('button', { class: 'gr-map-btn', type: 'button', title, 'aria-label': title, onclick }, glyph(g2, { size: 16 }));
    const fullBtn = btn('maximize', 'Full screen (F)', () => toggleFull());
    const controls = h('div', { class: 'gr-map-ctrl gr-map-ui' },
      btn('plus', 'Zoom in (+)', () => zoomAt(1.25)),
      zoomLabel,
      btn('minus', 'Zoom out (-)', () => zoomAt(0.8)),
      btn('target', 'Fit everything (0)', () => fit(null, true, { all: true })),
      fullBtn);
    const legend = h('div', { class: 'gr-legend gr-map-ui' },
      h('span', {}, h('i', { class: 'gr-lg-dot' }), 'requests'),
      h('span', {}, h('i', { class: 'gr-lg-line ok' }), 'healthy'),
      h('span', {}, h('i', { class: 'gr-lg-line warn' }), '1–5% errors'),
      h('span', {}, h('i', { class: 'gr-lg-line bad' }), '5%+ errors'),
      h('span', {}, h('i', { class: 'gr-lg-line dash' }), 'standby / mirror'),
      h('span', {}, h('i', { class: 'gr-lg-node' }), 'down'));
    const mapEl = h('div', { class: 'gr-map', tabindex: '0', 'aria-label': 'Topology map. Drag to move, scroll to zoom, arrow keys to pan.' },
      svgEdges, canvas, svgHalo, svgNodes, colsEl, noteEl, mini, controls, legend, tipEl, emptyEl);
    const mapCard = h('section', { class: 'card gr-map-card' },
      h('div', { class: 'gr-map-bar' },
        protoSeg,
        h('div', { class: 'gr-map-search' }, search),
        chips,
        h('div', { class: 'grow' }),
        statsEl),
      mapEl);
    const warnBox = h('div');
    el.append(
      pageHead({ title: 'Topology', icon: 'topology', sub: 'How a request travels: entry point, router, service, server. Every dot is a live request.' }),
      warnBox,
      mapCard);

    // ── toolbar ──
    function paintBar() {
      const c = protoCounts('routers');
      protoSeg.replaceChildren(...PROTOS.map(([p, l]) => h('button', { type: 'button', class: p === proto ? 'on' : '', onclick: () => { if (proto === p) return; proto = p; fitted = false; rebuild(); paintBar(); } }, l, h('span', { class: 'gr-seg-n' }, String(c[p])))));
      const internalN = (store.state?.[proto]?.routers ?? []).filter(isInternal).length;
      chips.replaceChildren(
        proto !== 'udp' ? filterChip({ label: 'Middlewares', glyph: 'middleware', on: showMws, title: 'Show each router\'s middlewares', onclick: () => { showMws = !showMws; rebuild(); paintBar(); } }) : null,
        internalN ? filterChip({ label: 'Internal', glyph: showInternal ? 'eye' : 'eyeOff', count: internalN, on: showInternal, title: 'Traefik\'s own routers: API, dashboard, ping, metrics', onclick: () => { showInternal = !showInternal; fitted = false; rebuild(); paintBar(); } }) : null,
        filterChip({ label: 'Live flow', glyph: 'sparkles', on: particlesOn, title: reducedMotion() ? 'Off while the system asks for reduced motion' : 'Animate requests along the edges', onclick: () => { particlesOn = !particlesOn; for (const st of pstate.values()) st.list.length = 0; paintBar(); kick(); } }));
      warnBox.replaceChildren(store.state && !store.state.ok ? banner('bad', 'Traefik is not answering', `${store.state.error ?? ''} The map shows the last configuration Enodia saw.`) : null);
    }

    // ── build ──
    function rebuild() {
      const keepView = fitted && userMoved;
      g = layoutGraph(buildGraph(proto, { internal: showInternal, mws: showMws }), { mws: showMws });
      sizeMap();
      renderGraph();
      updateFlows();
      applySearch(false, true);
      if (!keepView) requestAnimationFrame(() => fit(null, fitted));
      else applyView();
    }

    // the map fills the window below the toolbar; on a phone a wide map would leave the box mostly
    // empty, so it is sized to the content instead
    function sizeMap() {
      const W = mapEl.clientWidth || window.innerWidth;
      let want = '';
      if (mapCard.classList.contains('gr-full') || !mapEl.isConnected) want = '';
      else if (g && W < 600 && g.width) want = `${Math.round(Math.max(360, Math.min(window.innerHeight * 0.66, (g.height / g.width) * (W - 28) * 1.6 + 110)))}px`;
      else {
        const top = mapEl.getBoundingClientRect().top + window.scrollY;
        want = `${Math.round(Math.max(460, window.innerHeight - top - 24))}px`;
      }
      if (mapEl.style.height !== want) mapEl.style.height = want;
    }
    const colName = (c) => (c === 0 ? 'Entry points' : c === 1 ? 'Routers' : c === g.cols - 1 ? 'Servers' : c === 2 ? 'Services' : 'Child services');
    function lanes() {
      return g.colInfo.filter((ci) => ci.count).map((ci) => s('rect', { class: 'gr-lane', x: ci.x - 14, y: -16, width: ci.w + 28, height: g.height + 32, rx: 18 }));
    }
    function paintCols() {
      if (!g) return;
      colsEl.replaceChildren(...g.colInfo.map((ci, c) => {
        if (!ci.count) return null;
        const el2 = h('div', { class: 'gr-col' }, ci.w * view.k >= 74 ? h('span', { class: 'ellipsis' }, colName(c)) : null, h('b', { title: colName(c) }, String(ci.count)));
        el2.style.left = `${view.x + ci.x * view.k}px`;
        el2.style.width = `${Math.max(40, ci.w * view.k)}px`;
        return el2;
      }));
    }

    function renderGraph() {
      nodeEls.clear(); edgeEls.clear(); pstate.clear();
      const hasNodes = g.nodes.size > 0;
      emptyEl.hidden = hasNodes;
      if (!hasNodes) {
        emptyEl.replaceChildren(glyph('topology', { size: 30 }), h('div', { class: 'empty-title' }, `No ${proto.toUpperCase()} routers${!showInternal && (store.state?.[proto]?.routers ?? []).length ? ' outside Traefik\'s own' : ''}`),
          h('div', { class: 'small muted' }, proto === 'http' ? 'Routers appear here as soon as a provider defines them.' : `Define ${proto.toUpperCase()} routers to see them here.`));
      }
      edgeRoot.replaceChildren(s('g', { class: 'gr-lanes' }, ...(hasNodes ? lanes() : [])),
        ...g.edges.map((e) => {
          const p = s('path', { class: `gr-edge e-${e.kind}${e.role ? ` r-${e.role}` : ''}${e.status === 'DOWN' ? ' down' : ''}`, d: e.d });
          edgeEls.set(e.id, p);
          pstate.set(e.id, { curve: e.curve, rate: 0, err: 0, tone: 0, acc: Math.random(), list: [] });
          return p;
        }));
      nodeRoot.replaceChildren(...[...g.nodes.values()].map(nodeEl));
      haloEls.clear();
      haloRoot.replaceChildren(...[...g.nodes.values()].filter((n) => nodeHealth(n, proto) === 'bad').map((n) => {
        const r = s('rect', { class: 'gr-halo', x: n.x - 3, y: n.y - 3, width: n.w + 6, height: n.h + 6, rx: g.compact ? 11 : 14 });
        haloEls.set(n.id, r);
        return r;
      }));
      drawMinimap();
      paintStats();
      paintCols();
    }

    function nodeEl(n) {
      const S = g.S;
      const hl = nodeHealth(n, proto);
      const type = n.kind === 'service' ? svcType(n.data) : null;
      const k = n.kind === 'service' ? { glyph: SERVICE_TYPES[type]?.glyph ?? 'service', hue: SERVICE_TYPES[type]?.hue ?? 199 } : KIND[n.kind];
      const hue = n.kind === 'server' ? (hl === 'bad' ? 0 : hl === 'warn' ? 40 : hl === 'idle' ? 220 : 152) : k.hue;
      const baseH = n.h - (showMws && n.kind === 'router' && n.mws?.length ? S.mwRow : 0);
      const ts = g.compact ? 22 : 28;
      const icY = (baseH - ts) / 2;
      const textX = 12 + ts + 10;
      const metricW = n.kind === 'router' || n.kind === 'service' || n.kind === 'ep' || n.kind === 'server' ? 58 : 0;
      const maxText = n.w - textX - 12 - metricW;
      const { base } = split(n.name);
      const title = n.kind === 'server' ? n.name.replace(/^[a-z]+:\/\//, '') : base;
      const sub = subText(n, type);
      const grp = s('g', { class: `gr-node gr-tone k-${n.kind} h-${hl}${n.orphan ? ' orphan' : ''}${isInternal(n.data ?? {}) ? ' internal' : ''}`, transform: `translate(${n.x},${n.y})`, 'data-id': n.id, style: { '--h': hue } });
      const metric = s('text', { class: 'gr-node-metric', x: n.w - 12, y: g.compact ? baseH / 2 + 4 : baseH / 2 - 3, 'text-anchor': 'end' });
      const metric2 = s('text', { class: 'gr-node-metric2', x: n.w - 12, y: baseH / 2 + 13, 'text-anchor': 'end' });
      const ic = glyph(k.glyph, { size: g.compact ? 12 : 14 });
      ic.setAttribute('x', String(12 + (ts - (g.compact ? 12 : 14)) / 2));
      ic.setAttribute('y', String(icY + (ts - (g.compact ? 12 : 14)) / 2));
      ic.setAttribute('class', 'gr-node-glyph');
      grp.append(
        s('title', {}, n.name),
        s('rect', { class: 'gr-node-bg', width: n.w, height: n.h, rx: g.compact ? 9 : 12 }),
        s('rect', { class: 'gr-node-accent', x: 0, y: g.compact ? 8 : 12, width: 3, height: Math.max(6, baseH - (g.compact ? 16 : 24)), rx: 1.5 }),
        s('rect', { class: 'gr-node-ic', x: 12, y: icY, width: ts, height: ts, rx: g.compact ? 6 : 8 }),
        ic,
        s('text', { class: 'gr-node-title', x: textX, y: g.compact ? baseH / 2 + 4 : baseH / 2 - 3 }, fitText(title, maxText, FONT.title)),
        g.compact ? null : s('text', { class: 'gr-node-sub', x: textX, y: baseH / 2 + 13 }, fitText(sub, maxText, FONT.sub)),
        metric, g.compact ? null : metric2);
      if (showMws && n.kind === 'router' && n.mws?.length) {
        const max = Math.floor((n.w - 24) / 22);
        n.mws.slice(0, max).forEach((name, i) => {
          const m = findMiddleware(name, proto);
          const kk = m ? kindOf(m) : null;
          const cx = 12 + i * 22;
          const cyy = baseH - 4;
          const chip = s('g', { class: `gr-mwchip gr-tone ${m ? '' : 'missing'}`.trim(), style: tone(kk?.hue ?? 0), transform: `translate(${cx},${cyy})` },
            s('title', {}, m ? `${kk.label}: ${split(name).base} (${summaryOf(m)})` : `${name}: missing`),
            s('rect', { width: 18, height: 16, rx: 5 }));
          const gi = glyph(kk?.glyph ?? 'ghost', { size: 10 });
          gi.setAttribute('x', '4'); gi.setAttribute('y', '3');
          chip.append(gi);
          grp.append(chip);
        });
        if (n.mws.length > max) grp.append(s('text', { class: 'gr-node-sub', x: 12 + max * 22 + 2, y: baseH + 8 }, `+${n.mws.length - max}`));
      }
      if (hl === 'bad') grp.append(s('circle', { class: 'gr-node-alarm', cx: n.w - 1, cy: 1, r: 4 }));
      nodeEls.set(n.id, { g: grp, metric, metric2, n });
      return grp;
    }

    function subText(n, type) {
      if (n.kind === 'ep') {
        const internalEp = (store.metrics?.internalEntrypoints ?? []).includes(n.name);
        return `${n.data?.address ?? ''}${n.data?.http?.tls ? ' · TLS' : ''}${internalEp ? ' · internal' : ''}`;
      }
      if (n.kind === 'router') {
        const r = n.data;
        if (r.status === 'disabled') return (r.error ?? ['not serving'])[0];
        const hosts = hostsOf(r.rule ?? '');
        if (hosts.length === 1 && hosts[0] === '*') return 'any host';
        if (hosts.length) return `${hosts[0]}${hosts.length > 1 ? ` +${hosts.length - 1}` : ''}`;
        return r.rule ?? (proto === 'udp' ? 'every datagram' : 'no rule');
      }
      if (n.kind === 'missing') return 'does not exist';
      if (n.kind === 'service') {
        const svc = n.data;
        const label = SERVICE_TYPES[type]?.short ?? 'Service';
        if (svc.loadBalancer) {
          const srv = serversOf(svc);
          const down = srv.filter((x) => x.status === 'DOWN').length;
          return `${label} · ${plural(srv.length, 'server')}${down ? `, ${down} down` : ''}`;
        }
        if (type === 'internal') return 'built into Traefik';
        if (n.orphan) return `${label} · nothing routes here`;
        return `${label} · ${plural(childrenOf(svc).length, 'service')}`;
      }
      if (n.kind === 'server') {
        const st = n.data.statuses;
        const down = st.filter((x) => x.status === 'DOWN').length;
        if (st.length > 1) return `${st.length} services${down ? `, ${down} see it down` : ''}`;
        return st[0]?.status === 'DOWN' ? 'failing its health check' : st[0]?.status === 'UP' ? `up · ${split(st[0].service).base}` : split(st[0]?.service ?? '').base;
      }
      return '';
    }

    // ── live numbers ──
    function updateFlows() {
      if (!g) return;
      flows = computeFlows(g);
      for (const e of g.edges) {
        const f = flows.flows.get(e.id) ?? { rps: 0, err: 0 };
        const p = edgeEls.get(e.id);
        const t = f.err >= 0.05 ? 2 : f.err >= 0.01 ? 1 : 0;
        const liveEdge = f.rps > 0.005;
        const cls = [liveEdge ? 'live' : 'idle', liveEdge && t === 2 ? 'bad' : liveEdge && t === 1 ? 'warn' : '', e.standby ? 'standby' : ''].filter(Boolean);
        p.classList.remove('live', 'idle', 'bad', 'warn', 'standby');
        p.classList.add(...cls);
        p.style.strokeWidth = `${(1.3 + Math.min(4.2, Math.log2(1 + f.rps) * 0.95)).toFixed(2)}px`;
        const st = pstate.get(e.id);
        st.rate = liveEdge ? Math.min(12, Math.max(0.3, Math.log2(1 + f.rps * 2) * 1.3)) : 0;
        st.err = f.err;
        st.tone = t;
      }
      for (const { n, metric, metric2 } of nodeEls.values()) {
        const f = flows.nodeFlow.get(n.id);
        if (n.kind === 'ep') {
          metric.textContent = proto === 'http' ? (f?.rps ? `${rate(f.rps)}/s` : '') : '';
          if (metric2) metric2.textContent = f?.conns ? `${num(f.conns)} conn` : '';
        } else if (n.kind === 'router' || n.kind === 'service') {
          metric.textContent = proto === 'http' && f?.rps ? `${rate(f.rps)}/s` : '';
          const er = f?.rps ? f.err : 0;
          if (metric2) { metric2.textContent = er >= 0.01 ? `${pct(er)} 5xx` : ''; metric2.setAttribute('class', `gr-node-metric2 ${errTone(er)}`); }
          metric.setAttribute('class', `gr-node-metric ${er >= 0.05 ? 'bad' : ''}`);
        } else if (n.kind === 'server') {
          const st = n.data.statuses;
          const down = st.length && st.every((x) => x.status === 'DOWN');
          metric.textContent = down ? 'DOWN' : proto === 'http' && f?.rps ? `${rate(f.rps)}/s` : '';
          metric.setAttribute('class', `gr-node-metric ${down ? 'bad' : ''}`);
        }
      }
      paintStats();
      kick();
    }

    function paintStats() {
      if (!g) return;
      const count = (k) => [...g.nodes.values()].filter((n) => n.kind === k).length;
      const total = proto === 'http' ? live('total') : null;
      const down = [...g.nodes.values()].filter((n) => n.kind === 'server' && nodeHealth(n, proto) === 'bad').length;
      const broken = [...g.nodes.values()].filter((n) => n.kind === 'router' && n.data.status === 'disabled').length;
      statsEl.replaceChildren(
        ...[['router', 'router'], ['service', 'service'], ['server', 'server']].map(([k2, word]) => { const n2 = count(k2); return h('span', {}, h('b', {}, String(n2)), ` ${n2 === 1 ? word : `${word}s`}`); }),
        total ? h('span', { class: 'gr-stat-live' }, h('i', { class: 'dot ok pulse' }), h('b', {}, `${rate(total.rps)}`), ' req/s') : null,
        down ? h('span', { class: 'bad-text' }, h('b', {}, String(down)), ' down') : null,
        broken ? h('span', { class: 'bad-text' }, h('b', {}, String(broken)), ' broken') : null);
    }

    // ── focus and hover ──
    function setActive() {
      const ids = hoverId ? [hoverId] : focusIds ? [...focusIds] : null;
      active = ids && ids.length ? pathOf(g, ids) : null;
      svgNodes.classList.toggle('gr-dim', Boolean(active));
      svgEdges.classList.toggle('gr-dim', Boolean(active));
      svgHalo.classList.toggle('gr-dim', Boolean(active));
      for (const [id, r] of haloEls) r.classList.toggle('on', Boolean(active?.nodes.has(id)));
      for (const [id, x] of nodeEls) {
        x.g.classList.toggle('on', Boolean(active?.nodes.has(id)));
        x.g.classList.toggle('match', Boolean(focusIds?.has(id)));
      }
      for (const [id, p] of edgeEls) p.classList.toggle('on', Boolean(active?.edges.has(id)));
      drawMinimap();
    }

    function haystack(n) {
      const parts = [n.name];
      if (n.kind === 'router') parts.push(n.data.rule ?? '', ...(n.mws ?? []));
      if (n.kind === 'ep') parts.push(n.data?.address ?? '');
      if (n.kind === 'service') parts.push(svcType(n.data));
      return parts.join(' ').toLowerCase();
    }

    function applySearch(andFit, quiet = false) {
      if (!g) return;
      const t = query.trim().toLowerCase();
      if (!t) {
        if (focusFromSearch || !quiet) { focusIds = null; noteEl.hidden = true; }
        focusFromSearch = false;
      } else {
        focusFromSearch = true;
        const words = t.split(/\s+/);
        const hits = [...g.nodes.values()].filter((n) => words.every((w) => haystack(n).includes(w))).map((n) => n.id);
        focusIds = new Set(hits);
        noteEl.hidden = false;
        noteEl.replaceChildren(hits.length
          ? h('span', {}, glyph('search', { size: 13 }), ` ${plural(hits.length, 'match', 'matches')} for “${query.trim()}”`, h('button', { class: 'gr-note-btn', onclick: () => fit(focusIds) }, 'Zoom to them'), h('button', { class: 'gr-note-btn', onclick: () => { query = ''; search.querySelector('input').value = ''; applySearch(false); } }, 'Clear'))
          : h('span', {}, `Nothing matches “${query.trim()}”`));
        if (andFit && hits.length) fit(focusIds);
      }
      setActive();
      // follow the matches once the typing pauses
      clearTimeout(searchTimer);
      if (!quiet && !andFit && focusIds?.size && focusIds.size <= 12 && fitted) searchTimer = setTimeout(() => { if (focusIds?.size) fit(focusIds); }, 500);
    }
    let searchTimer = 0;

    function nodeFromEvent(e) {
      const gEl = e.target.closest?.('.gr-node');
      return gEl ? gEl.getAttribute('data-id') : null;
    }

    // ── tooltip ──
    function showTip(id) {
      const x = nodeEls.get(id);
      if (!x) { tipEl.hidden = true; return; }
      const n = x.n;
      const f = flows.nodeFlow.get(id);
      const kindLabel = n.kind === 'service' ? SERVICE_TYPES[svcType(n.data)]?.label ?? 'Service' : n.kind === 'ep' ? 'Entry point' : n.kind === 'router' ? 'Router' : n.kind === 'server' ? 'Server' : 'Missing service';
      const lines = [];
      if (proto === 'http' && f && n.kind !== 'ep') lines.push(['Traffic', f.rps ? `${rate(f.rps)} req/s` : 'idle']);
      if (proto === 'http' && f?.rps && n.kind !== 'ep') lines.push(['5xx', pct(f.err)]);
      if (n.kind === 'ep') { lines.push(['Address', n.data?.address ?? '—']); if (f?.rps) lines.push(['Traffic', `${rate(f.rps)} req/s`]); lines.push(['Open connections', num(f?.conns ?? 0)]); }
      if (n.kind === 'router') { const p = live('router', n.name); if (p?.p95) lines.push(['p95', ms(p.p95)]); lines.push(['Status', n.data.status]); }
      if (n.kind === 'service') lines.push(['Health', HEALTH[healthOf(n.name, proto)]?.label ?? '—']);
      if (n.kind === 'server') for (const st of n.data.statuses) lines.push([split(st.service).base, st.status ?? 'no check']);
      tipEl.replaceChildren(
        h('div', { class: 'gr-tip-head' }, h('b', { class: 'ellipsis' }, n.kind === 'server' ? n.name : split(n.name).base), h('span', { class: 'tiny muted' }, kindLabel)),
        ...lines.map(([k2, v]) => h('div', { class: 'gr-tip-row' }, h('span', {}, k2), h('b', {}, v))),
        h('div', { class: 'tiny faint' }, 'Click for details'));
      tipEl.hidden = false;
      const W = mapEl.clientWidth; const H = mapEl.clientHeight;
      const sx = view.x + (n.x + n.w) * view.k + 12;
      const sy = view.y + n.y * view.k;
      const tw = tipEl.offsetWidth; const th = tipEl.offsetHeight;
      const left = sx + tw > W - 8 ? Math.max(8, view.x + n.x * view.k - tw - 12) : sx;
      tipEl.style.left = `${left}px`;
      tipEl.style.top = `${Math.max(8, Math.min(H - th - 8, sy))}px`;
    }

    // ── drawer ──
    function openNode(id) {
      const n = g?.nodes.get(id);
      if (!n) return;
      closeDrawer?.();
      const d = drawer(n.kind === 'server' ? n.name : split(n.name).base, details(n));
      closeDrawer = d.close;
    }

    function liveTrio(p) {
      return h('div', { class: 'gr-trio' },
        h('div', {}, h('b', {}, p ? `${rate(p.rps)}` : '—'), h('span', {}, 'req/s')),
        h('div', {}, h('b', { class: p ? `${errTone(p.errorRate)}-text` : '' }, p?.rps ? pct(p.errorRate) : '—'), h('span', {}, '5xx')),
        h('div', {}, h('b', {}, p?.p95 ? ms(p.p95) : '—'), h('span', {}, 'p95')));
    }

    function splitBar(kids) {
      const total = kids.reduce((a, c) => a + (c.weight ?? 0), 0) || 1;
      const colors = ['--sky', '--violet', '--torch', '--ok', '--ember'];
      return h('div', { class: 'gr-splitbar' }, ...kids.map((c, i) => {
        const seg = h('span', { title: `${split(c.name).base}: ${pct((c.weight ?? 0) / total)}`, style: { width: '0%', background: `var(${colors[i % colors.length]})` } }, h('b', {}, `${split(c.name).base} ${pct((c.weight ?? 0) / total)}`));
        requestAnimationFrame(() => requestAnimationFrame(() => { seg.style.width = `${((c.weight ?? 0) / total) * 100}%`; }));
        return seg;
      }));
    }

    function details(n) {
      const focusBtn = h('button', { class: 'btn sm', onclick: () => { closeDrawer?.(); query = ''; search.querySelector('input').value = ''; focusIds = new Set([n.id]); setActive(); fit(focusIds); noteEl.hidden = false; noteEl.replaceChildren(h('span', {}, glyph('target', { size: 13 }), ` Following ${split(n.name).base}`, h('button', { class: 'gr-note-btn', onclick: () => { focusIds = null; noteEl.hidden = true; setActive(); } }, 'Clear'))); } }, glyph('target', { size: 14 }), 'Follow in map');
      if (n.kind === 'router') {
        const r = n.data;
        const svc = n.outs.find((e) => e.kind === 'route');
        return h('div', { class: 'col gap-lg' },
          h('div', { class: 'row wrap', style: { gap: '8px' } }, tile('router', 38, { size: 40, icon: 20 }), statusBadge(r.status), providerBadge(r.name), h('span', { class: 'badge' }, proto.toUpperCase())),
          r.error?.length ? banner('bad', 'Not serving', r.error.join('; ')) : null,
          proto === 'http' ? liveTrio(live('router', r.name)) : null,
          h('div', { class: 'col', style: { gap: '6px' } }, h('div', { class: 'gr-sec-title' }, 'Rule'), r.rule ? ruleView(r.rule) : h('span', { class: 'muted small' }, 'none')),
          kv([
            ['Entry points', h('div', { class: 'chips' }, ...(r.entryPoints ?? []).map((x) => h('a', { class: 'chip', href: hrefFor('entrypoints', x) }, x)))],
            ['Priority', r.priority >= 2 ** 53 ? 'max' : String(r.priority ?? '—')],
            proto !== 'udp' ? ['TLS', r.tls ? [r.tls.certResolver ? `resolver ${r.tls.certResolver}` : 'yes', r.tls.options ? ` · ${r.tls.options}` : ''].join('') : 'no'] : null,
            svc ? ['Service', h('a', { class: 'gr-link', href: hrefFor('services', g.nodes.get(svc.to).name, proto) }, split(g.nodes.get(svc.to).name).base)] : null,
          ]),
          n.mws?.length ? h('div', { class: 'col', style: { gap: '8px' } }, h('div', { class: 'gr-sec-title' }, 'Middlewares, in order'), h('div', { class: 'gr-pipe' }, ...n.mws.flatMap((name, i) => {
            const m = findMiddleware(name, proto);
            const kk = m ? kindOf(m) : null;
            return [i ? h('span', { class: 'gr-pipe-arrow' }, glyph('chevron', { size: 13 })) : null,
              m ? h('a', { class: 'gr-pipe-step gr-tone', style: tone(kk.hue), href: hrefFor('middlewares', name, proto), title: summaryOf(m) }, glyph(kk.glyph, { size: 13 }), h('span', { class: 'ellipsis' }, split(name).base))
                : h('span', { class: 'gr-pipe-step missing' }, glyph('ghost', { size: 13 }), split(name).base)];
          }))) : null,
          h('div', { class: 'row wrap' }, h('a', { class: 'btn sm primary', href: hrefFor('routers', r.name, proto), onclick: () => closeDrawer?.() }, 'Open router', glyph('chevron', { size: 14 })), focusBtn));
      }
      if (n.kind === 'service' || n.kind === 'missing') {
        if (n.kind === 'missing') return h('div', { class: 'col gap-lg' }, banner('bad', 'This service does not exist', 'A router or a composite service points at it, so those requests fail.'), focusBtn);
        const svc = n.data;
        const type = svcType(svc);
        const T = SERVICE_TYPES[type] ?? SERVICE_TYPES.unknown;
        const hl = healthOf(n.name, proto);
        const kids = childrenOf(svc);
        return h('div', { class: 'col gap-lg' },
          h('div', { class: 'row wrap', style: { gap: '8px' } }, tile(T.glyph, T.hue, { size: 40, icon: 20 }), h('span', { class: 'badge' }, T.label), h('span', { class: `badge ${HEALTH[hl]?.tone ?? ''}` }, healthDot(hl), HEALTH[hl]?.label ?? hl), providerBadge(n.name)),
          h('div', { class: 'small muted' }, T.desc),
          proto === 'http' ? liveTrio(serviceLive(svc) ?? (flows.nodeFlow.get(n.id)?.rps ? { rps: flows.nodeFlow.get(n.id).rps, errorRate: flows.nodeFlow.get(n.id).err } : null)) : null,
          svc.loadBalancer ? h('div', { class: 'col', style: { gap: '6px' } }, h('div', { class: 'gr-sec-title' }, 'Servers'),
            ...serversOf(svc).map((x) => h('div', { class: 'gr-probe' }, h('span', { class: `dot ${x.status === 'UP' ? 'ok' : x.status === 'DOWN' ? 'bad' : ''}` }), h('code', { class: 'ellipsis grow' }, x.key), h('b', { class: `tiny ${x.status === 'DOWN' ? 'bad-text' : 'ok-text'}` }, x.status ?? '—')))) : null,
          kids.length ? h('div', { class: 'col', style: { gap: '6px' } }, h('div', { class: 'gr-sec-title' }, 'Sends to'),
            type === 'weighted' ? splitBar(kids) : null,
            ...kids.map((c) => h('a', { class: 'gr-rrow', href: hrefFor('services', c.name, proto), onclick: () => closeDrawer?.() }, healthDot(healthOf(c.name, proto)), h('b', { class: 'grow ellipsis' }, split(c.name).base), h('span', { class: 'tiny muted' }, c.role === 'weight' ? `weight ${c.weight}` : c.role === 'mirror' ? `${c.percent}% copied` : c.role)))) : null,
          h('div', { class: 'col', style: { gap: '6px' } }, h('div', { class: 'gr-sec-title' }, 'Routers'),
            h('div', { class: 'chips' }, ...routersReaching(n.name, proto).map(({ router: r }) => h('a', { class: 'chip', href: hrefFor('routers', r.name, proto), onclick: () => closeDrawer?.() }, glyph('router', { size: 12 }), split(r.name).base)))),
          h('div', { class: 'row wrap' }, h('a', { class: 'btn sm primary', href: hrefFor('services', n.name, proto), onclick: () => closeDrawer?.() }, 'Open service', glyph('chevron', { size: 14 })), focusBtn));
      }
      if (n.kind === 'ep') {
        const f = flows.nodeFlow.get(n.id);
        const routers = n.outs.map((e) => g.nodes.get(e.to));
        return h('div', { class: 'col gap-lg' },
          h('div', { class: 'row wrap', style: { gap: '8px' } }, tile('entrypoint', 258, { size: 40, icon: 20 }), h('span', { class: 'badge mono' }, n.data?.address ?? '—'), n.data?.http?.tls ? badge('TLS', 'ok') : null),
          proto === 'http' ? liveTrio(live('ep', n.name)) : kv([['Open connections', num(f?.conns ?? 0)]]),
          h('div', { class: 'col', style: { gap: '6px' } }, h('div', { class: 'gr-sec-title' }, `${plural(routers.length, 'router')} shown`),
            h('div', { class: 'chips' }, ...routers.map((r) => h('a', { class: 'chip', href: hrefFor('routers', r.name, proto), onclick: () => closeDrawer?.() }, glyph('router', { size: 12 }), split(r.name).base)))),
          h('div', { class: 'row wrap' }, h('a', { class: 'btn sm primary', href: hrefFor('entrypoints', n.name), onclick: () => closeDrawer?.() }, 'Open entry point', glyph('chevron', { size: 14 })), focusBtn));
      }
      // server
      const f = flows.nodeFlow.get(n.id);
      return h('div', { class: 'col gap-lg' },
        h('div', { class: 'row wrap', style: { gap: '8px' } }, tile('server', 152, { size: 40, icon: 20 }), h('code', { class: 'small' }, n.name)),
        proto === 'http' ? h('div', { class: 'gr-trio' }, h('div', {}, h('b', {}, f?.rps ? rate(f.rps) : '0'), h('span', {}, 'req/s (est.)')), h('div', {}, h('b', { class: f?.err >= 0.05 ? 'bad-text' : '' }, f?.rps ? pct(f.err) : '—'), h('span', {}, '5xx')), h('div', {}, h('b', {}, String(n.data.statuses.length)), h('span', {}, 'services'))) : null,
        h('div', { class: 'col', style: { gap: '6px' } }, h('div', { class: 'gr-sec-title' }, 'Health, per service'),
          ...n.data.statuses.map((st) => h('a', { class: 'gr-rrow', href: hrefFor('services', st.service, proto), onclick: () => closeDrawer?.() }, h('span', { class: `dot ${st.status === 'UP' ? 'ok' : st.status === 'DOWN' ? 'bad pulse' : ''}` }), h('b', { class: 'grow ellipsis' }, split(st.service).base), h('span', { class: `tiny bold ${st.status === 'DOWN' ? 'bad-text' : st.status === 'UP' ? 'ok-text' : 'muted'}` }, st.status ?? 'no health check')))),
        h('div', { class: 'tiny muted' }, 'Health checks run per service: the same server can be up for one and down for another.'),
        h('div', { class: 'row wrap' }, focusBtn));
    }

    // ── view: pan, zoom, fit ──
    function applyView() {
      const t = `translate(${view.x.toFixed(2)},${view.y.toFixed(2)}) scale(${view.k.toFixed(4)})`;
      edgeRoot.setAttribute('transform', t);
      nodeRoot.setAttribute('transform', t);
      haloRoot.setAttribute('transform', t);
      mapEl.classList.toggle('gr-lod-low', view.k < 0.55);
      mapEl.classList.toggle('gr-lod-min', view.k < 0.3);
      zoomLabel.textContent = `${Math.round(view.k * 100)}%`;
      if (!tipEl.hidden && hoverId) showTip(hoverId);
      paintCols();
      // the minimap only helps when part of the map is off screen
      const b = g?.nodes.size ? bounds(null) : null;
      const W = mapEl.clientWidth; const H = mapEl.clientHeight;
      const offscreen = b && (view.x + b.x0 * view.k < -4 || view.y + b.y0 * view.k < -4 || view.x + b.x1 * view.k > W + 4 || view.y + b.y1 * view.k > H + 4);
      mini.classList.toggle('on', Boolean(offscreen));
      drawMinimap();
      kick();
    }
    function zoomAt(factor, cx = mapEl.clientWidth / 2, cy = mapEl.clientHeight / 2) {
      anim = null;
      userMoved = true;
      const k2 = Math.max(MIN_K, Math.min(MAX_K, view.k * factor));
      const f = k2 / view.k;
      view.x = cx - (cx - view.x) * f;
      view.y = cy - (cy - view.y) * f;
      view.k = k2;
      applyView();
    }
    function bounds(ids) {
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      for (const n of g.nodes.values()) {
        if (ids && !ids.has(n.id)) continue;
        x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h);
      }
      if (!ids) y0 -= 16;
      return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
    }
    /** Fit nodes (or everything) in view. A very tall map starts readable, from the top; `all` forces the overview. */
    function fit(ids, animate = true, { all = false } = {}) {
      if (!g || !g.nodes.size) return;
      const b = bounds(ids && ids.size ? pathOf(g, [...ids]).nodes : null);
      if (!b) return;
      const W = mapEl.clientWidth; const H = mapEl.clientHeight;
      if (!W || !H) return;
      const left = W < 600 ? 14 : 36; const right = W < 600 ? 14 : 64;
      const top = 44; const bottom = W < 600 ? 50 : 56;
      const kw = (W - left - right) / (b.x1 - b.x0);
      let k = Math.max(MIN_K, Math.min(ids ? 1.35 : 1.15, Math.min(kw, (H - top - bottom) / (b.y1 - b.y0))));
      let tall = false;
      if (!ids && !all && W >= 600 && k < 0.3 && kw > k * 1.6) { k = Math.min(0.62, Math.max(0.3, kw)); tall = true; }
      userMoved = Boolean(ids) || tall;
      const target = {
        k,
        x: left + Math.max(0, W - left - right - (b.x1 - b.x0) * k) / 2 - b.x0 * k,
        y: tall ? top - b.y0 * k : top + (H - top - bottom - (b.y1 - b.y0) * k) / 2 - b.y0 * k,
      };
      if (tall) {
        noteEl.hidden = false;
        noteEl.replaceChildren(h('span', {}, glyph('info', { size: 13 }), `The top of ${plural(g.routerCount, 'router')}: drag to move, or`, h('button', { class: 'gr-note-btn', onclick: () => { noteEl.hidden = true; fit(null, true, { all: true }); } }, 'see everything')));
      }
      fitted = true;
      if (!animate || reducedMotion()) { Object.assign(view, target); anim = null; applyView(); return; }
      anim = { from: { ...view }, to: target, start: performance.now(), dur: 520 };
      kick();
    }
    function stepAnim(now) {
      if (!anim) return;
      const t = Math.min(1, (now - anim.start) / anim.dur);
      const e = 1 - (1 - t) ** 3;
      // zoom in log space so it feels even
      view.k = Math.exp(Math.log(anim.from.k) + (Math.log(anim.to.k) - Math.log(anim.from.k)) * e);
      view.x = anim.from.x + (anim.to.x - anim.from.x) * e;
      view.y = anim.from.y + (anim.to.y - anim.from.y) * e;
      if (t >= 1) anim = null;
      applyView();
    }

    // ── particles ──
    // sprites are drawn at their final pixel size, so each particle is a plain blit
    const spriteCache = new Map();
    const colors = [];
    let dark = true;
    function makeSprites() {
      const cs = getComputedStyle(mapEl);
      dark = document.documentElement.dataset.theme !== 'light';
      colors.length = 0;
      for (const v of ['--p-ok', '--p-warn', '--p-bad']) colors.push(cs.getPropertyValue(v).trim() || '#7dd3fc');
      spriteCache.clear();
    }
    function trimParticles() {
      let total = 0;
      for (const st of pstate.values()) total += st.list.length;
      if (total <= maxParticles) return;
      const keep = maxParticles / total;
      for (const st of pstate.values()) st.list = st.list.filter(() => Math.random() < keep);
    }
    function sprite(t, px) {
      const key = `${t}:${px}`;
      let c = spriteCache.get(key);
      if (c) return c;
      c = document.createElement('canvas');
      c.width = px; c.height = px;
      const x = c.getContext('2d');
      const r = px / 2;
      const color = colors[t];
      const gr = x.createRadialGradient(r, r, 0, r, r, r);
      if (dark) { gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, color); gr.addColorStop(0.5, `${color}66`); gr.addColorStop(1, `${color}00`); }
      else { gr.addColorStop(0, color); gr.addColorStop(0.34, color); gr.addColorStop(0.55, `${color}55`); gr.addColorStop(1, `${color}00`); }
      x.fillStyle = gr;
      x.fillRect(0, 0, px, px);
      spriteCache.set(key, c);
      return c;
    }

    // how many particles may be in flight: shrinks when frames come slowly, grows back when they do not
    let maxParticles = 1100;
    let slowFrames = 0;
    // one loop at most: kick() during a frame (applyView does that) must not start a second one
    let inFrame = false;
    function kick() { if (!raf && !inFrame && running) { lastT = performance.now(); raf = requestAnimationFrame(frame); } }
    function frame(now) {
      raf = 0;
      if (!running) return;
      inFrame = true;
      const gap = now - lastT;
      const dt = Math.min(0.05, Math.max(0, gap / 1000));
      lastT = now;
      if (particlesOn && gap > 0) {
        slowFrames = gap > 34 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
        if (slowFrames > 8) { maxParticles = Math.max(120, Math.round(maxParticles * 0.6)); slowFrames = 0; trimParticles(); }
        else if (gap < 20 && maxParticles < 1100) maxParticles += 2;
      }
      stepAnim(now);
      const W = mapEl.clientWidth; const H = mapEl.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
      pctx.setTransform(1, 0, 0, 1, 0, 0);
      pctx.clearRect(0, 0, canvas.width, canvas.height);
      let any = false;
      if (particlesOn && g) {
        pctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        const k = view.k;
        const px = Math.round(Math.max(5, Math.min(15, 13 * k)) * dpr);
        const half = px / 2;
        const sx = view.x * dpr; const sy = view.y * dpr; const sk = k * dpr;
        // zoomed far out the dots merge into lines: spawn fewer of them
        const density = Math.min(1, Math.max(0.18, k / 0.6));
        const speed = SPEED * Math.min(3, Math.max(1, 1 / Math.sqrt(k)));
        let budget = maxParticles;
        for (const st of pstate.values()) budget -= st.list.length;
        const cw = canvas.width; const ch = canvas.height;
        for (const [id, st] of pstate) {
          if (st.rate > 0) {
            st.acc += st.rate * density * dt * (0.6 + Math.random() * 0.8);
            while (st.acc >= 1) {
              st.acc -= 1;
              if (st.list.length < 70 && budget-- > 0) st.list.push({ d: Math.random() * speed * dt, c: Math.random() < st.err ? 2 : st.tone });
            }
          }
          if (!st.list.length) continue;
          any = true;
          const total = st.curve.total;
          const bb = st.curve.bbox;
          const hidden = bb[2] * sk + sx < -px || bb[0] * sk + sx > cw + px || bb[3] * sk + sy < -px || bb[1] * sk + sy > ch + px;
          const base = active && !active.edges.has(id) ? 0.1 : 1;
          for (let i = st.list.length - 1; i >= 0; i--) {
            const p = st.list[i];
            p.d += speed * dt;
            if (p.d >= total) { st.list.splice(i, 1); continue; }
            if (hidden) continue;
            const [x, y] = pointAt(st.curve, p.d);
            // fade in and out at the ends of the edge
            pctx.globalAlpha = base * Math.min(1, p.d / 30, (total - p.d) / 30);
            pctx.drawImage(sprite(p.c, px), Math.round(x * sk + sx - half), Math.round(y * sk + sy - half));
          }
        }
        pctx.globalAlpha = 1;
        pctx.globalCompositeOperation = 'source-over';
      }
      const flowing = particlesOn && [...pstate.values()].some((st) => st.rate > 0);
      inFrame = false;
      if ((anim || flowing || any) && !raf) raf = requestAnimationFrame(frame);
    }

    // ── minimap ──
    function drawMinimap() {
      if (!g || !g.nodes.size || !mini.classList.contains('on') || mini.offsetParent === null) return;
      const MW = mini.width; const MH = mini.height;
      mctx.clearRect(0, 0, MW, MH);
      const b = bounds(null);
      const pad = 14;
      const sc = Math.min((MW - pad * 2) / (b.x1 - b.x0), (MH - pad * 2) / (b.y1 - b.y0));
      const ox = pad + ((MW - pad * 2) - (b.x1 - b.x0) * sc) / 2 - b.x0 * sc;
      const oy = pad + ((MH - pad * 2) - (b.y1 - b.y0) * sc) / 2 - b.y0 * sc;
      mini.dataset.map = JSON.stringify([sc, ox, oy]);
      const cs = getComputedStyle(mapEl);
      const col = { ep: cs.getPropertyValue('--violet').trim(), router: cs.getPropertyValue('--torch').trim(), service: cs.getPropertyValue('--sky').trim(), missing: cs.getPropertyValue('--bad').trim(), server: cs.getPropertyValue('--ok').trim() };
      mctx.globalAlpha = 0.35;
      mctx.strokeStyle = cs.getPropertyValue('--muted').trim();
      mctx.lineWidth = 1;
      mctx.beginPath();
      for (const e of g.edges) { mctx.moveTo(ox + e.x1 * sc, oy + e.y1 * sc); mctx.lineTo(ox + e.x2 * sc, oy + e.y2 * sc); }
      mctx.stroke();
      for (const n of g.nodes.values()) {
        const hl = nodeHealth(n, proto);
        mctx.globalAlpha = active && !active.nodes.has(n.id) ? 0.25 : 0.9;
        mctx.fillStyle = hl === 'bad' ? col.missing : col[n.kind];
        mctx.fillRect(ox + n.x * sc, oy + n.y * sc, Math.max(2, n.w * sc), Math.max(2, n.h * sc));
      }
      mctx.globalAlpha = 1;
      const W = mapEl.clientWidth; const H = mapEl.clientHeight;
      const vx = (-view.x / view.k) * sc + ox; const vy = (-view.y / view.k) * sc + oy;
      mctx.strokeStyle = cs.getPropertyValue('--torch').trim();
      mctx.lineWidth = 2;
      mctx.strokeRect(vx, vy, (W / view.k) * sc, (H / view.k) * sc);
    }
    function miniMove(e) {
      const [sc, ox, oy] = JSON.parse(mini.dataset.map ?? '[1,0,0]');
      const r = mini.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * mini.width;
      const my = ((e.clientY - r.top) / r.height) * mini.height;
      const gx = (mx - ox) / sc; const gy = (my - oy) / sc;
      anim = null;
      view.x = mapEl.clientWidth / 2 - gx * view.k;
      view.y = mapEl.clientHeight / 2 - gy * view.k;
      applyView();
    }
    let miniDrag = false;
    mini.addEventListener('pointerdown', (e) => { e.stopPropagation(); miniDrag = true; mini.setPointerCapture(e.pointerId); miniMove(e); });
    mini.addEventListener('pointermove', (e) => { if (miniDrag) miniMove(e); });
    mini.addEventListener('pointerup', () => { miniDrag = false; });

    // ── pointer input ──
    const pointers = new Map();
    let drag = null;
    let pinch = null;
    mapEl.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.gr-map-ui, .gr-map-tip')) return;
      mapEl.focus({ preventScroll: true });
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { mapEl.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      if (pointers.size === 1) drag = { x0: e.clientX, y0: e.clientY, vx: view.x, vy: view.y, moved: false, node: nodeFromEvent(e) };
      else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), k0: view.k, x0: view.x, y0: view.y, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        drag = null;
      }
    });
    mapEl.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const r = mapEl.getBoundingClientRect();
        const k2 = Math.max(MIN_K, Math.min(MAX_K, pinch.k0 * (Math.hypot(a.x - b.x, a.y - b.y) / (pinch.d0 || 1))));
        const cx = pinch.mx - r.left; const cy = pinch.my - r.top;
        const mx = (a.x + b.x) / 2 - r.left; const my = (a.y + b.y) / 2 - r.top;
        view.x = mx - (cx - pinch.x0) * (k2 / pinch.k0);
        view.y = my - (cy - pinch.y0) * (k2 / pinch.k0);
        view.k = k2;
        anim = null;
        userMoved = true;
        applyView();
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x0; const dy = e.clientY - drag.y0;
        if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; mapEl.classList.add('grabbing'); tipEl.hidden = true; }
        if (drag.moved) { anim = null; userMoved = true; view.x = drag.vx + dx; view.y = drag.vy + dy; applyView(); }
        return;
      }
      // hover
      const id = nodeFromEvent(e);
      if (id !== hoverId) {
        hoverId = id;
        setActive();
        if (id) showTip(id); else tipEl.hidden = true;
      }
    });
    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag && !drag.moved && drag.node && e.type === 'pointerup') openNode(drag.node);
      if (!pointers.size) { drag = null; mapEl.classList.remove('grabbing'); }
    };
    mapEl.addEventListener('pointerup', endPointer);
    mapEl.addEventListener('pointercancel', endPointer);
    mapEl.addEventListener('pointerleave', () => { if (!drag && hoverId) { hoverId = null; tipEl.hidden = true; setActive(); } });
    mapEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = mapEl.getBoundingClientRect();
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.2) { anim = null; view.x -= e.deltaX; applyView(); return; }
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0016) * (e.deltaMode === 1 ? 16 : 1)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    mapEl.addEventListener('dblclick', (e) => {
      if (e.target.closest('.gr-map-ui')) return;
      const id = document.elementFromPoint(e.clientX, e.clientY)?.closest('.gr-node')?.getAttribute('data-id');
      const r = mapEl.getBoundingClientRect();
      if (id) { focusIds = new Set([id]); setActive(); fit(focusIds); } else zoomAt(1.6, e.clientX - r.left, e.clientY - r.top);
    });
    mapEl.addEventListener('keydown', (e) => {
      if (e.target !== mapEl) return;
      const step = 70;
      const keys = {
        '+': () => zoomAt(1.25), '=': () => zoomAt(1.25), '-': () => zoomAt(0.8), _: () => zoomAt(0.8), 0: () => fit(null, true, { all: true }), f: () => toggleFull(),
        ArrowLeft: () => { view.x += step; applyView(); }, ArrowRight: () => { view.x -= step; applyView(); },
        ArrowUp: () => { view.y += step; applyView(); }, ArrowDown: () => { view.y -= step; applyView(); },
        Escape: () => { if (mapCard.classList.contains('gr-full')) toggleFull(); else if (focusIds) { focusIds = null; noteEl.hidden = true; setActive(); } },
      };
      if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
    });

    function toggleFull() {
      const on = !mapCard.classList.contains('gr-full');
      mapCard.classList.toggle('gr-full', on);
      document.body.classList.toggle('gr-noscroll', on);
      sizeMap();
      fullBtn.replaceChildren(glyph(on ? 'shrink' : 'maximize', { size: 16 }));
      fullBtn.title = on ? 'Leave full screen (Esc)' : 'Full screen (F)';
      requestAnimationFrame(() => fit(focusIds?.size ? focusIds : null, false));
    }
    const onDocKey = (e) => { if (e.key === 'Escape' && mapCard.classList.contains('gr-full') && document.activeElement !== mapEl) toggleFull(); };
    document.addEventListener('keydown', onDocKey);

    // ── lifecycle ──
    const onVisibility = () => {
      running = !document.hidden;
      if (running) kick(); else { cancelAnimationFrame(raf); raf = 0; }
    };
    document.addEventListener('visibilitychange', onVisibility);
    const ro = new ResizeObserver(() => { sizeMap(); if (!fitted || !userMoved) fit(focusIds?.size ? focusIds : null, false); else { applyView(); kick(); } });
    ro.observe(mapEl);
    const onResize = () => sizeMap();
    window.addEventListener('resize', onResize);

    makeSprites();
    paintBar();
    rebuild();
    if (matchMedia('(pointer: coarse)').matches && !query) {
      noteEl.hidden = false;
      noteEl.replaceChildren(h('span', {}, glyph('sparkles', { size: 13 }), 'Pinch to zoom, drag to move, tap for details'));
      setTimeout(() => { if (!query && !focusIds) noteEl.hidden = true; }, 4500);
    }
    requestAnimationFrame(() => { if (query) applySearch(true); });

    let logTimer = 0;
    return {
      el,
      update(event) {
        if (event === 'state') { paintBar(); rebuild(); }
        else if (event === 'metrics') updateFlows();
        else if (event === 'logs' && !logTimer) logTimer = setTimeout(() => { logTimer = 0; updateFlows(); }, 3000);
        else if (event === 'theme') { makeSprites(); drawMinimap(); }
      },
      destroy() {
        running = false;
        cancelAnimationFrame(raf);
        clearTimeout(logTimer);
        clearTimeout(searchTimer);
        ro.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        document.removeEventListener('keydown', onDocKey);
        window.removeEventListener('resize', onResize);
        document.body.classList.remove('gr-noscroll');
        closeDrawer?.();
      },
    };
  },
};
