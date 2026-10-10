// Services: every load balancer, weighted, mirroring and failover service, how healthy its servers are
// and how much traffic it takes. The detail page shows where requests really go.
import { h, s, stagger } from '../lib/dom.js';
import { glyph } from '../lib/glyphs.js';
import { store, api, live, findingsFor } from '../lib/store.js';
import { card, stat, badge, statusBadge, providerBadge, tabs, segmented, searchInput, kv, copyButton, empty, banner, hrefFor, pageHead, skeleton } from '../lib/components.js';
import { timeChart, sparkline, countTo } from '../lib/charts.js';
import { rate, pct, ms, bytes, num, split, plural } from '../lib/format.js';
import { ruleView } from '../lib/rules.js';
import { liveTable } from '../lib/livetable.js';
import {
  SERVICE_TYPES, svcType, serversOf, childrenOf, parentsOf, errorPagesFor, healthOf, failoverActive, routersReaching,
  serviceLive, findService, services, protoCounts, isInternal, leavesOf, sumPoints,
} from '../lib/model.js';
import { tile, healthPills, healthDot, HEALTH, filterChip, errTone, fmtErr, fmtRps, fmtMs, cssVar, shortAgo } from '../lib/gparts.js';
import { sanitize, durText, rawView } from '../lib/mwkinds.js';

const PROTOS = [['http', 'HTTP'], ['tcp', 'TCP'], ['udp', 'UDP']];
const PALETTE = ['--sky', '--violet', '--torch', '--ok', '--ember', '--info', '--warn'];
const STRATEGY = {
  wrr: ['Weighted round robin', 'Servers take turns, in proportion to their weight.'],
  p2c: ['Power of two choices', 'Picks two servers at random and sends to the one with fewer requests in flight.'],
  hrw: ['Highest random weight', 'Hashes the client IP, so a client keeps landing on the same server.'],
  leasttime: ['Least time', 'Sends to the server answering fastest with the fewest requests in flight.'],
};
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export default {
  render(ctx) {
    const [proto, name] = ctx.params;
    return name ? detail(ctx, proto, name) : list(ctx);
  },
};

// ── shared ───────────────────────────────────────────────────────────────────

const T = (type) => SERVICE_TYPES[type] ?? SERVICE_TYPES.unknown;

function nameBlock(svc, proto, { link = true } = {}) {
  const { base, provider } = split(svc.name);
  const inner = [h('span', { class: 'ellipsis', title: svc.name }, base), provider ? h('span', { class: 'faint tiny' }, `@${provider}`) : null];
  return link ? h('a', { class: 'cell-title', href: hrefFor('services', svc.name, proto) }, ...inner) : h('div', { class: 'cell-title' }, ...inner);
}

/** The children of a composite service as compact chips with a share and a health dot. */
function kidChips(svc, proto, kids) {
  const type = svcType(svc);
  if (type === 'failover') {
    const fo = failoverActive(svc, proto);
    return h('div', { class: 'gr-kids' }, ...kids.flatMap((k, i) => [
      i ? h('span', { class: 'gr-kid-arrow' }, glyph('arrow', { size: 12 })) : null,
      h('a', { class: `gr-kid ${fo.active?.name === k.name ? 'is-active' : 'is-standby'}`, href: hrefFor('services', k.name, proto), title: `${k.role}: ${k.name} (${HEALTH[k.health]?.label ?? k.health})` },
        healthDot(k.health), h('span', { class: 'ellipsis' }, split(k.name).base), fo.active?.name === k.name ? h('span', { class: 'gr-kid-n' }, 'serving') : null),
    ]));
  }
  const total = kids.filter((k) => k.role === 'weight').reduce((a, k) => a + (k.weight ?? 0), 0) || 1;
  return h('div', { class: 'gr-kids' }, ...kids.map((k) => h('a', { class: `gr-kid r-${k.role}`, href: hrefFor('services', k.name, proto), title: `${k.role}: ${k.name} (${HEALTH[k.health]?.label ?? k.health})` },
    healthDot(k.health), h('span', { class: 'ellipsis' }, split(k.name).base),
    h('span', { class: 'gr-kid-n' }, k.role === 'weight' ? pct((k.weight ?? 0) / total) : k.role === 'mirror' ? `+${k.percent}%` : 'main'))));
}

// ── list ─────────────────────────────────────────────────────────────────────

function list(ctx) {
  ctx.setCrumbs([['Services']]);
  const q = ctx.query;
  let proto = PROTOS.some(([p]) => p === q.get('proto')) ? q.get('proto') : 'http';
  let filter = q.get('q') ?? '';
  let type = q.get('type') ?? '';
  let problems = q.get('problems') === '1';
  let showInternal = q.get('internal') === '1';
  const hist = new Map();     // series key -> [rps], oldest first
  const refs = new Map();     // service name -> live cell elements
  const metricsOff = store.meta?.features?.metrics === false;

  const el = h('div', { class: 'col gap-lg' });
  const sub = h('span');
  const tiles = {
    count: stat({ label: 'Services', icon: 'service', value: '—' }),
    servers: stat({ label: 'Servers up', icon: 'server', value: '—' }),
    rps: stat({ label: 'Requests / second', icon: 'zap', value: '—' }),
    err: stat({ label: 'Server errors (5xx)', icon: 'alert', value: '—' }),
  };
  tiles.rps.classList.add('gr-stat-sfoot');
  tiles.err.classList.add('gr-stat-sfoot');
  for (const t of Object.values(tiles)) t.classList.add('gr-stat');
  const tabsHost = h('div', { class: 'gr-tabs-host' });
  const chips = h('div', { class: 'gr-fchips' });
  const meta = h('div', { class: 'tiny muted gr-meta' });
  const tableHost = h('div');
  let table = null;

  el.append(
    pageHead({ title: 'Services', icon: 'service', sub }),
    metricsOff ? banner('info', 'Live traffic is off', 'Set TRAEFIK_METRICS_URL to see requests, errors and latency per service.') : null,
    stagger(h('div', { class: 'grid g4' }, ...Object.values(tiles))),
    card({ flush: true, cls: 'gr-list-card' },
      h('div', { class: 'gr-toolbar' }, tabsHost,
        h('div', { class: 'gr-toolbar-right' }, searchInput({ placeholder: 'Filter by name, server or router…', value: filter, oninput: (v) => { filter = v; paint(); } }))),
      h('div', { class: 'gr-toolbar gr-toolbar-2' }, chips, meta),
      tableHost));

  const rowsFor = (p) => services(p).map((svc) => {
    const ty = svcType(svc);
    const servers = serversOf(svc);
    const kids = childrenOf(svc).map((c) => ({ ...c, health: healthOf(c.name, p) }));
    const health = healthOf(svc.name, p);
    return {
      name: svc.name, proto: p, svc, type: ty, servers, kids, health,
      sev: findingsFor('service', svc.name).map((f) => f.severity),
      down: servers.filter((x) => x.status === 'DOWN').length,
      internal: isInternal(svc),
      parents: parentsOf(svc.name, p).map((x) => x.service.name),
    };
  });
  const isProblem = (r) => r.health === 'down' || r.health === 'partial' || r.health === 'missing' || (r.svc.status && r.svc.status !== 'enabled') || r.sev.includes('critical');
  const liveOf = (r) => (r.proto === 'http' ? serviceLive(r.svc) : null);

  function seriesOf(r) {
    if (r.proto !== 'http') return [];
    if (r.svc.loadBalancer) return hist.get(`service:${r.name}`) ?? [];
    const lists = (r.svc.usedBy ?? []).map((x) => hist.get(`router:${x}`) ?? []).filter((x) => x.length);
    if (!lists.length) return [];
    const n = Math.max(...lists.map((x) => x.length));
    return Array.from({ length: n }, (_, i) => lists.reduce((a, l) => a + (l[l.length - n + i] ?? 0), 0));
  }

  function liveCells(r) {
    const ref = refs.get(r.name) ?? {};
    ref.row = r;
    ref.rps ??= h('span', { class: 'tnum bold' });
    ref.spark ??= h('span', { class: 'gr-spark-wrap' });
    ref.err ??= h('span', { class: 'tnum' });
    ref.p95 ??= h('span', { class: 'tnum' });
    refs.set(r.name, ref);
    paintLive(ref, liveOf(r), r);
    return ref;
  }
  function paintLive(ref, l, r) {
    ref.rps.textContent = l ? fmtRps(l.rps) : '—';
    ref.rps.title = l?.source === 'routers' ? 'Measured on the routers that use it' : '';
    ref.err.textContent = l && l.rps ? fmtErr(l.errorRate) : '—';
    ref.err.className = `tnum ${l && l.rps ? `${errTone(l.errorRate)}-text` : 'faint'}`;
    ref.p95.textContent = l?.p95 ? fmtMs(l.p95) : '—';
    ref.p95.className = `tnum ${l?.p95 > 1000 ? 'warn-text' : l?.p95 ? '' : 'faint'}`;
    const vals = seriesOf(r).slice(-48);
    ref.spark.replaceChildren(vals.length > 1 ? sparkline(vals, { height: 24, width: 84, cls: 'gr-spark', color: l && l.errorRate >= 0.05 ? 'var(--bad)' : 'var(--sky)' }) : null);
  }

  const columns = (p) => [
    { key: 'name', label: 'Service', sort: (r) => split(r.name).base.toLowerCase(), render: (r) => h('div', { class: 'row gr-name-cell' },
      tile(T(r.type).glyph, T(r.type).hue, { size: 32, icon: 16 }),
      h('div', { class: 'col', style: { gap: '2px', minWidth: '0' } }, nameBlock(r.svc, p),
        h('div', { class: 'cell-sub row', style: { gap: '6px' } }, h('span', {}, T(r.type).label),
          r.svc.status && r.svc.status !== 'enabled' ? statusBadge(r.svc.status) : null,
          r.sev.includes('critical') ? badge('problem', 'bad') : r.sev.includes('warning') ? badge('warning', 'warn') : null))) },
    { key: 'servers', label: 'Servers', cls: 'gr-c-half', sort: (r) => (r.health === 'down' ? 0 : r.health === 'partial' ? 1 : 2) * 1000 + r.servers.length, render: (r) => {
      if (r.svc.loadBalancer) {
        const up = r.servers.filter((x) => x.status === 'UP').length;
        return h('div', { class: 'col', style: { gap: '5px' } }, healthPills(r.servers),
          h('span', { class: `tiny ${r.down ? 'bad-text' : 'muted'}` }, r.servers.some((x) => x.status) ? `${up} of ${r.servers.length} up` : plural(r.servers.length, 'server')));
      }
      if (r.kids.length) return kidChips(r.svc, p, r.kids);
      return h('span', { class: 'faint small' }, r.internal ? 'built into Traefik' : '—');
    } },
    { key: 'setup', label: 'Setup', cls: 'gr-c-half gr-c-setup', render: (r) => setupBadges(r.svc, p) },
    { key: 'usedBy', label: 'Used by', cls: 'gr-c-full', sort: (r) => (r.svc.usedBy ?? []).length || (r.parents.length ? 0.5 : 0), render: (r) => usedByCell(r, p) },
    ...(p === 'http' && !metricsOff ? [
      { key: 'rps', label: 'Traffic', num: true, cls: 'gr-c-third', sort: (r) => liveOf(r)?.rps ?? -1, render: (r) => { const ref = liveCells(r); return h('div', { class: 'gr-traffic' }, ref.spark, ref.rps); } },
      { key: 'err', label: 'Errors', num: true, cls: 'gr-c-third', sort: (r) => liveOf(r)?.errorRate ?? -1, render: (r) => liveCells(r).err },
      { key: 'p95', label: 'p95', num: true, cls: 'gr-c-third', sort: (r) => liveOf(r)?.p95 ?? -1, render: (r) => liveCells(r).p95 },
    ] : []),
  ];

  function setupBadges(svc, p) {
    const out = [];
    const lb = svc.loadBalancer;
    if (lb) {
      const st = lb.strategy ?? (p === 'http' ? 'wrr' : null);
      if (st) out.push(h('span', { class: 'badge mono', title: STRATEGY[st]?.[0] ?? st }, st));
      if (lb.sticky?.cookie) out.push(h('span', { class: 'badge violet', title: `Sticky cookie ${lb.sticky.cookie.name ?? ''}` }, glyph('cookie', { size: 12 }), lb.sticky.cookie.name ?? 'sticky'));
      if (lb.healthCheck) out.push(h('span', { class: 'badge ok', title: `Health check ${lb.healthCheck.path ?? ''} every ${durText(lb.healthCheck.interval) ?? '30s'}` }, glyph('heart', { size: 12 }), `${lb.healthCheck.path ?? lb.healthCheck.mode ?? 'check'} · ${durText(lb.healthCheck.interval) ?? '30s'}`));
      else if ((lb.servers ?? []).length > 1 && p !== 'udp') out.push(h('span', { class: 'badge', title: 'No health check: a dead server keeps getting traffic' }, 'no health check'));
      if (lb.passHostHeader === false) out.push(badge('host rewritten'));
      if (lb.serversTransport) out.push(h('span', { class: 'badge', title: 'serversTransport' }, glyph('key', { size: 12 }), split(lb.serversTransport).base));
    }
    if (svc.weighted?.sticky?.cookie) out.push(h('span', { class: 'badge violet' }, glyph('cookie', { size: 12 }), svc.weighted.sticky.cookie.name ?? 'sticky'));
    if (svc.mirroring) out.push(badge(svc.mirroring.mirrorBody === false ? 'headers only' : 'with body'));
    if (svc.weighted?.healthCheck || svc.mirroring?.healthCheck || svc.failover?.healthCheck) out.push(h('span', { class: 'badge ok' }, glyph('heart', { size: 12 }), 'propagated'));
    return out.length ? h('div', { class: 'row wrap', style: { gap: '5px' } }, ...out) : h('span', { class: 'faint small' }, '—');
  }

  function usedByCell(r, p) {
    const used = r.svc.usedBy ?? [];
    const routerChips = used.slice(0, 2).map((x) => h('a', { class: 'chip gr-chip-link', href: hrefFor('routers', x, p), title: x }, glyph('router', { size: 12 }), h('span', { class: 'ellipsis' }, split(x).base)));
    const via = r.parents.slice(0, 2).map((x) => h('a', { class: 'chip gr-chip-link', href: hrefFor('services', x, p), title: `inside ${x}` }, glyph(T(svcType(findService(x, p))).glyph, { size: 12 }), h('span', { class: 'ellipsis' }, split(x).base)));
    if (!used.length && !via.length) {
      const pages = p === 'http' ? errorPagesFor(r.name) : [];
      if (pages.length) return h('a', { class: 'chip gr-chip-link', href: hrefFor('middlewares', pages[0].name, 'http') }, glyph('octagon', { size: 12 }), 'error pages');
      return h('span', { class: 'faint small' }, 'unused');
    }
    return h('div', { class: 'row wrap', style: { gap: '5px' } }, ...routerChips, ...via, used.length > 2 ? h('span', { class: 'tiny muted' }, `+${used.length - 2}`) : null);
  }

  function buildTable() {
    const old = table?.sort;
    table = liveTable(columns(proto), {
      rowKey: (r) => r.name,
      sig: (r) => JSON.stringify([r.svc, r.health, r.kids.map((k) => k.health), r.sev, r.parents, metricsOff]),
      rowClick: (r) => { location.hash = hrefFor('services', r.name, r.proto); },
      rowClass: (r) => [isProblem(r) ? 'gr-row-bad' : '', r.internal ? 'gr-row-internal' : ''].join(' '),
      empty: 'No service matches',
      sortBy: old?.[0] && columns(proto).some((c) => c.key === old[0]) ? old[0] : 'name',
      desc: old?.[1] === -1,
    });
    refs.clear();
    tableHost.replaceChildren(table.el);
  }

  function paintTabs() {
    const c = protoCounts('services');
    tabsHost.replaceChildren(tabs(PROTOS.map(([p, l]) => [p, l, c[p]]), proto, (v) => { proto = v; type = ''; buildTable(); paint(); }));
  }

  function paint() {
    const rows = rowsFor(proto);
    const counts = {};
    for (const r of rows) counts[r.type] = (counts[r.type] ?? 0) + 1;
    const internalN = rows.filter((r) => r.internal).length;
    const problemN = rows.filter(isProblem).length;
    chips.replaceChildren(
      filterChip({ label: 'All', count: rows.length - (showInternal ? 0 : internalN), on: !type && !problems, onclick: () => { type = ''; problems = false; paint(); } }),
      ...['loadbalancer', 'weighted', 'mirroring', 'failover'].filter((t) => counts[t]).map((t) => filterChip({ label: T(t).label, glyph: T(t).glyph, hue: T(t).hue, count: counts[t], on: type === t, onclick: () => { type = type === t ? '' : t; paint(); } })),
      problemN ? filterChip({ label: 'Problems', glyph: 'alert', hue: 0, count: problemN, on: problems, onclick: () => { problems = !problems; paint(); } }) : null,
      internalN ? filterChip({ label: 'Internal', glyph: showInternal ? 'eye' : 'eyeOff', count: internalN, on: showInternal, title: showInternal ? 'Hide Traefik\'s own services' : 'Show Traefik\'s own services', onclick: () => { showInternal = !showInternal; paint(); } }) : null);
    const f = filter.trim().toLowerCase();
    const shown = rows.filter((r) => {
      if (r.internal && !showInternal) return false;
      if (type && r.type !== type) return false;
      if (problems && !isProblem(r)) return false;
      if (f && ![r.name, ...r.servers.map((x) => x.key), ...(r.svc.usedBy ?? []), ...r.kids.map((k) => k.name), T(r.type).label].some((v) => String(v).toLowerCase().includes(f))) return false;
      return true;
    });
    meta.textContent = `Showing ${shown.length} of ${rows.length}${!showInternal && internalN ? ` · ${internalN} internal hidden` : ''}`;
    table.update(shown);
    paintTabs();
    paintTiles();
  }

  const footOf = (tileEl, node) => { tileEl.querySelector('.stat-foot')?.remove(); if (node) tileEl.querySelector('.stat-value').after(h('div', { class: 'stat-foot' }, node)); };
  function paintTiles() {
    const allRows = PROTOS.flatMap(([p]) => rowsFor(p));
    const lbs = allRows.filter((r) => r.type === 'loadbalancer').length;
    const comp = allRows.filter((r) => ['weighted', 'mirroring', 'failover'].includes(r.type)).length;
    sub.textContent = `Where routers send requests: ${plural(allRows.length, 'service')}, ${plural(allRows.reduce((a, r) => a + r.servers.length, 0), 'server')} behind them.`;
    tiles.count.valueEl.textContent = String(allRows.length);
    footOf(tiles.count, h('span', {}, `${lbs} load balancer${lbs === 1 ? '' : 's'}${comp ? ` · ${comp} composite` : ''}`));
    let up = 0; let known = 0;
    for (const r of allRows) for (const x of r.servers) if (x.status) { known++; if (x.status === 'UP') up++; }
    tiles.servers.valueEl.replaceChildren(String(up), h('small', {}, `/ ${known}`));
    footOf(tiles.servers, known - up ? h('span', { class: 'bad-text' }, `${known - up} down`) : h('span', { class: 'ok-text' }, known ? 'all answering' : 'no health checks'));
    if (metricsOff) return;
    const leaf = services('http').filter((x) => x.loadBalancer).map((x) => live('service', x.name)).filter(Boolean);
    const tot = sumPoints(leaf);
    countTo(tiles.rps.valueEl, tot.rps, { format: rate });
    countTo(tiles.err.valueEl, tot.errorRate * 100, { format: (v) => `${v.toFixed(v >= 10 ? 0 : 1)}%` });
    tiles.err.valueEl.className = `stat-value ${errTone(tot.errorRate) ? `${errTone(tot.errorRate)}-text` : ''}`;
    const lists = [...hist.entries()].filter(([k]) => k.startsWith('service:')).map(([, v]) => v).filter((v) => v.length);
    if (lists.length) {
      const n = Math.max(...lists.map((x) => x.length));
      const sum = Array.from({ length: n }, (_, i) => lists.reduce((a, l) => a + (l[l.length - n + i] ?? 0), 0));
      tiles.rps.querySelector('.spark')?.remove();
      tiles.rps.append(sparkline(sum.slice(-60), { color: cssVar('--torch') }));
      const errs = Array.from({ length: n }, (_, i) => lists.reduce((a, l) => a + (l[l.length - n + i] ?? 0), 0));
      void errs;
    }
    const busiest = services('http').map((x) => [x, live('service', x.name)?.rps ?? 0]).sort((a, b) => b[1] - a[1])[0];
    footOf(tiles.rps, busiest?.[1] ? h('span', {}, 'busiest: ', h('a', { class: 'gr-link', href: hrefFor('services', busiest[0].name) }, split(busiest[0].name).base)) : null);
    const worst = services('http').map((x) => [x, live('service', x.name)]).filter(([, l]) => l?.rps > 0.05).sort((a, b) => b[1].errorRate - a[1].errorRate)[0];
    footOf(tiles.err, worst && worst[1].errorRate >= 0.01 ? h('span', {}, 'worst: ', h('a', { class: 'gr-link', href: hrefFor('services', worst[0].name) }, split(worst[0].name).base), ` ${pct(worst[1].errorRate)}`) : h('span', { class: 'ok-text' }, 'no service above 1%'));
  }

  async function loadSeries() {
    if (metricsOff) return;
    const keys = [];
    for (const svc of services('http')) {
      if (svc.loadBalancer) keys.push(`service:${svc.name}`);
      else for (const r of svc.usedBy ?? []) keys.push(`router:${r}`);
    }
    const uniq = [...new Set(keys)];
    for (let i = 0; i < uniq.length; i += 60) {
      try {
        const r = await api(`series?keys=${encodeURIComponent(uniq.slice(i, i + 60).join(','))}&minutes=5`);
        for (const [k, pts] of Object.entries(r.series ?? {})) hist.set(k, pts.map((p) => p.rps ?? 0));
      } catch { /* the next tick fills in */ }
    }
    for (const ref of refs.values()) paintLive(ref, liveOf(ref.row), ref.row);
    paintTiles();
  }

  buildTable();
  paint();
  loadSeries();

  return {
    el,
    update(event, data) {
      if (event === 'metrics' && data?.latest) {
        for (const [k, p] of Object.entries(data.latest)) {
          if (!k.startsWith('service:') && !k.startsWith('router:')) continue;
          const arr = hist.get(k) ?? [];
          arr.push(p.rps ?? 0);
          if (arr.length > 70) arr.splice(0, arr.length - 70);
          hist.set(k, arr);
        }
        for (const ref of refs.values()) if (ref.rps.isConnected) paintLive(ref, liveOf(ref.row), ref.row);
        if (['rps', 'err', 'p95'].includes(table.sort[0])) paint(); else paintTiles();
      } else if (event === 'state' || event === 'diagnostics') paint();
    },
  };
}

// ── detail ───────────────────────────────────────────────────────────────────

function detail(ctx, proto, name) {
  const { base } = split(name);
  ctx.setCrumbs([['Services', `#/services${proto !== 'http' ? `?proto=${proto}` : ''}`], [base]]);
  const el = h('div', { class: 'col gap-lg' });
  let svc = findService(name, proto);
  const metricsOff = store.meta?.features?.metrics === false || proto !== 'http';
  const logsOff = store.meta?.features?.logs === false || proto !== 'http';
  let minutes = 15;
  let entries = null;          // access-log entries for this service, oldest first
  const series = new Map();    // key -> points
  const charts = [];
  let lastSig = '';
  let mainSig = '';
  // bars and arcs start from where they were, so a repaint reads as motion, not a reset
  const widths = new Map();
  const growBar = (key, frac, attrs = {}) => {
    const target = `${Math.max(0, Math.min(1, frac || 0)) * 100}%`;
    const span = h('span', { ...attrs, style: { ...(attrs.style ?? {}), width: widths.get(key) ?? '0%' } });
    widths.set(key, target);
    requestAnimationFrame(() => requestAnimationFrame(() => { span.style.width = target; }));
    return span;
  };
  const phase = () => ({ '--phase': `${-Math.round(performance.now() % 1200)}ms` });

  if (!svc) {
    el.append(empty(`No ${proto.toUpperCase()} service named ${name}`, 'It may have been removed, or it lives under another provider.', 'service'),
      h('div', { class: 'row', style: { justifyContent: 'center' } }, h('a', { class: 'btn', href: '#/services' }, glyph('chevron', { size: 14 }), 'All services')));
    return { el, update(ev) { if (ev === 'state' && findService(name, proto)) window.dispatchEvent(new HashChangeEvent('hashchange')); } };
  }

  const type = () => svcType(svc);
  const composite = () => ['weighted', 'mirroring', 'failover'].includes(type());
  const reaching = () => routersReaching(name, proto);

  // ── containers ──
  const heroBox = h('div');
  const tiles = {
    rps: stat({ label: 'Requests / second', icon: 'zap', value: '—' }),
    err: stat({ label: 'Server errors (5xx)', icon: 'alert', value: '—' }),
    p95: stat({ label: 'Latency p95', icon: 'clock', value: '—' }),
    out: stat({ label: 'Bandwidth out', icon: 'download', value: '—' }),
    servers: stat({ label: 'Servers up', icon: 'server', value: '—' }),
    retries: stat({ label: 'Retries', icon: 'refresh', value: '—' }),
  };
  for (const t of [tiles.rps, tiles.err, tiles.p95, tiles.out]) t.classList.add('gr-stat-sfoot');
  for (const t of Object.values(tiles)) t.classList.add('gr-stat');
  const mainBox = h('div', { class: 'col gap-lg' });
  const sideBox = h('div', { class: 'col gap-lg' });
  const routersBox = h('div', { class: 'col', style: { gap: '8px' } });
  const refsBox = h('div', { class: 'col', style: { gap: '8px' } });
  const findingsBox = h('div', { class: 'col', style: { gap: '8px' } });
  const reqBox = h('div', { class: 'gr-reqs' });
  const rawBox = h('div');

  // ── hero ──
  function paintHero() {
    const ty = T(type());
    const hl = healthOf(name, proto);
    const lb = svc.loadBalancer;
    const facts = [
      providerBadge(name),
      h('span', { class: 'badge', title: proto.toUpperCase() }, proto.toUpperCase()),
      lb?.strategy ? h('span', { class: 'badge mono', title: STRATEGY[lb.strategy]?.[1] ?? '' }, STRATEGY[lb.strategy]?.[0] ?? lb.strategy) : null,
      lb?.sticky?.cookie ? h('span', { class: 'badge violet' }, glyph('cookie', { size: 12 }), `sticky: ${lb.sticky.cookie.name ?? 'cookie'}`) : null,
      lb?.healthCheck ? h('span', { class: 'badge ok' }, glyph('heart', { size: 12 }), `health check ${lb.healthCheck.path ?? ''}`) : null,
      lb && lb.passHostHeader === false ? badge('Host header rewritten') : null,
      lb?.serversTransport ? h('span', { class: 'badge' }, glyph('key', { size: 12 }), `transport ${split(lb.serversTransport).base}`) : null,
      h('span', { class: 'badge' }, glyph('router', { size: 12 }), plural(reaching().length, 'router')),
    ];
    heroBox.replaceChildren(h('section', { class: `card gr-hero ${hl === 'down' || hl === 'missing' ? 'bad' : hl === 'partial' ? 'warn' : ''}`.trim() },
      tile(ty.glyph, ty.hue, { size: 58, icon: 28, cls: 'gr-hero-tile' }),
      h('div', { class: 'grow col', style: { gap: '6px', minWidth: '0' } },
        h('div', { class: 'row wrap', style: { gap: '10px' } },
          h('h1', { class: 'gr-hero-title' }, base),
          statusBadge(svc.status),
          h('span', { class: `badge ${HEALTH[hl]?.tone ?? ''}` }, healthDot(hl), HEALTH[hl]?.label ?? hl)),
        h('div', { class: 'muted small' }, `${ty.label}. ${ty.desc}`),
        h('div', { class: 'row wrap', style: { gap: '6px', marginTop: '4px' } }, ...facts)),
      h('div', { class: 'gr-hero-actions' },
        h('a', { class: 'btn sm', href: `#/topology?proto=${proto}&q=${encodeURIComponent(name)}` }, glyph('topology', { size: 14 }), 'Topology'),
        proto === 'http' ? h('a', { class: 'btn sm', href: `#/logs?service=${encodeURIComponent(name)}` }, glyph('logs', { size: 14 }), 'Access log') : null,
        copyButton(name, 'Copy name'))));
  }

  // ── live tiles ──
  function tileSeries() {
    const keys = composite() ? (svc.usedBy ?? []).map((r) => `router:${r}`) : [`service:${name}`];
    const lists = keys.map((k) => series.get(k) ?? []).filter((x) => x.length);
    if (!lists.length) return [];
    if (lists.length === 1) return lists[0];
    const byT = new Map();
    for (const l of lists) for (const p of l) byT.set(p.t, [...(byT.get(p.t) ?? []), p]);
    return [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([, ps]) => sumPoints(ps));
  }
  const footOf = (t, node) => { t.querySelector('.stat-foot')?.remove(); if (node) t.querySelector('.stat-value').after(h('div', { class: 'stat-foot' }, node)); };
  function paintTiles() {
    const l = serviceLive(svc);
    const pts = tileSeries().slice(-60);
    const set = (t, v, fmt, key, color) => {
      if (v === null || v === undefined) { t.valueEl.textContent = '—'; return; }
      countTo(t.valueEl, v, { format: fmt });
      t.querySelector('.spark')?.remove();
      if (pts.length > 1) t.append(sparkline(pts.map((p) => p[key] ?? 0), { color }));
    };
    if (!metricsOff) {
      set(tiles.rps, l?.rps ?? 0, rate, 'rps', cssVar('--torch'));
      set(tiles.err, (l?.errorRate ?? 0) * 100, (v) => `${v.toFixed(v >= 10 ? 0 : 1)}%`, 'r5', cssVar('--bad'));
      set(tiles.p95, l?.p95 ?? null, ms, 'p95', cssVar('--violet'));
      set(tiles.out, l?.outBps ?? 0, (v) => bytes(v, true), 'outBps', cssVar('--sky'));
      tiles.err.valueEl.className = `stat-value ${errTone(l?.errorRate ?? 0) ? `${errTone(l.errorRate)}-text` : ''}`;
      footOf(tiles.rps, l?.source === 'routers' ? 'measured on its routers' : !l ? 'no traffic seen' : null);
    }
    const leaves = leavesOf(name, proto);
    let up = 0; let known = 0; let totalServers = 0;
    for (const lf of leaves) for (const x of serversOf(lf)) { totalServers++; if (x.status) { known++; if (x.status === 'UP') up++; } }
    tiles.servers.valueEl.replaceChildren(known ? String(up) : String(totalServers), known ? h('small', {}, `/ ${known}`) : h('small', {}, 'servers'));
    tiles.servers.valueEl.className = `stat-value ${known && up === 0 ? 'bad-text' : known && up < known ? 'warn-text' : ''}`;
    footOf(tiles.servers, composite() ? `across ${plural(leaves.length, 'load balancer')}` : known ? (up < known ? h('span', { class: 'bad-text' }, `${known - up} failing the health check`) : h('span', { class: 'ok-text' }, 'all pass the health check')) : 'no health check');
    const retries = leaves.reduce((a, lf) => a + (store.metrics?.gauges?.retries?.[lf.name] ?? 0), 0);
    tiles.retries.valueEl.textContent = num(retries);
    footOf(tiles.retries, 'since Traefik started');
  }

  // ── servers (load balancer) ──
  function serverStats() {
    const m = new Map();
    for (const e of entries ?? []) {
      if (!e.server || e.service !== name) continue;
      let c = m.get(e.server);
      if (!c) m.set(e.server, c = { n: 0, errors: 0, ms: 0, last: null, lastStatus: null });
      c.n++; if (e.status >= 500) c.errors++; c.ms += e.durationMs ?? 0;
      if (!c.last || e.t >= c.last) { c.last = e.t; c.lastStatus = e.status; }
    }
    return m;
  }
  function serversCard() {
    const list = serversOf(svc);
    const statsBy = serverStats();
    const total = [...statsBy.values()].reduce((a, c) => a + c.n, 0);
    const busiest = [...statsBy.entries()].sort((a, b) => b[1].n - a[1].n)[0]?.[0];
    const rows = list.map((x) => {
      const st = statsBy.get(x.key);
      const share = total ? (st?.n ?? 0) / total : 0;
      const fill = growBar(`srv:${x.key}`, entries ? Math.max(share ? 0.015 : 0, share) : 0, { class: x.status === 'DOWN' ? 'bad' : '' });
      return h('div', { class: `gr-server ${x.status === 'DOWN' ? 'down' : x.status === 'UP' ? 'up' : ''}`.trim() },
        h('div', { class: 'gr-server-state' }, h('span', { class: `dot ${x.status === 'UP' ? 'ok' : x.status === 'DOWN' ? 'bad pulse' : ''}`.trim() }), h('b', {}, x.status ?? '—')),
        h('div', { class: 'gr-server-url' },
          h('div', { class: 'row', style: { gap: '6px', minWidth: '0' } }, h('code', { class: 'ellipsis', title: x.key }, x.key), copyButton(x.key, 'Copy address')),
          h('div', { class: 'tiny muted' }, busiest === x.key && total && list.length > 1 ? h('span', { class: 'torch-text bold' }, 'most traffic · ') : null,
            [x.weight !== undefined ? `weight ${x.weight}` : null, x.preservePath ? 'keeps path' : null, st?.last ? `last request ${shortAgo(st.last)} · ${st.lastStatus}` : entries && !logsOff ? 'no requests in the access log' : null].filter(Boolean).join(' · ') || ' ')),
        logsOff ? null : h('div', { class: 'gr-server-share' },
          h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('span', { class: 'tiny muted' }, 'share'), h('b', { class: 'tnum small' }, entries ? pct(share) : '…')),
          h('div', { class: 'bar' }, fill)),
        logsOff ? null : h('div', { class: 'gr-server-nums' },
          h('div', {}, h('b', { class: 'tnum' }, st ? num(st.n) : '0'), h('span', { class: 'tiny muted' }, 'requests')),
          h('div', {}, h('b', { class: `tnum ${st?.errors ? 'bad-text' : ''}` }, st?.n ? pct(st.errors / st.n) : '—'), h('span', { class: 'tiny muted' }, '5xx')),
          h('div', {}, h('b', { class: 'tnum' }, st?.n ? ms(st.ms / st.n) : '—'), h('span', { class: 'tiny muted' }, 'avg'))));
    });
    return card({
      title: 'Servers', icon: 'server',
      sub: logsOff ? 'Status from the health check' : `Status from the health check; share of the last ${num(total)} requests in the access log`,
      tools: [h('span', { class: 'badge' }, plural(list.length, 'server'))],
    }, list.length ? h('div', { class: 'col', style: { gap: '8px' } }, ...rows) : empty('No servers', 'Every request to this service fails with 503.', 'server'),
    list.length && list.every((x) => x.status === 'DOWN') ? h('div', { class: 'mt' }, banner('bad', 'Every server is down', 'Routers using this service answer 503 Service Unavailable.')) : null);
  }

  // ── composite (weighted / mirroring / failover) ──
  function childShares() {
    // which child the access log says served each request of the routers using this service
    const routerNames = new Set(reaching().map((x) => x.router.name));
    const leafToKid = new Map();
    for (const k of childrenOf(svc)) {
      leafToKid.set(k.name, k.name);
      for (const lf of leavesOf(k.name, proto)) if (!leafToKid.has(lf.name)) leafToKid.set(lf.name, k.name);
    }
    const counts = new Map();
    let total = 0;
    for (const e of entries ?? []) {
      if (!routerNames.has(e.router)) continue;
      const kid = leafToKid.get(e.service);
      if (!kid) continue;
      counts.set(kid, (counts.get(kid) ?? 0) + 1);
      total++;
    }
    return { counts, total };
  }

  function compositeCard() {
    const ty = type();
    const kids = childrenOf(svc).map((c, i) => ({ ...c, health: healthOf(c.name, proto), color: cssVar(PALETTE[i % PALETTE.length]), child: findService(c.name, proto) }));
    const { counts, total } = childShares();
    const fo = ty === 'failover' ? failoverActive(svc, proto) : null;
    const wsum = kids.filter((k) => k.role === 'weight').reduce((a, k) => a + (k.weight ?? 0), 0) || 1;
    const items = kids.map((k) => {
      const actual = total && ty !== 'mirroring' ? (counts.get(k.name) ?? 0) / total : null;
      const share = ty === 'weighted' ? (k.weight ?? 0) / wsum : ty === 'mirroring' ? k.percent / 100 : fo?.active?.name === k.name ? 1 : 0;
      const label = ty === 'weighted' ? `weight ${k.weight} · ${pct(share)}` : ty === 'mirroring' ? (k.role === 'main' ? 'every request' : `copies ${k.percent}%`) : k.role === 'primary' ? 'primary' : 'fallback';
      const activeNow = ty !== 'failover' || fo?.active?.name === k.name;
      const kt = k.child ? T(svcType(k.child)) : null;
      return h('div', { class: `gr-branch-item r-${k.role} ${activeNow ? 'is-active' : 'is-standby'}`.trim(), style: { '--w': `${Math.max(2, Math.round(2 + share * 5))}px`, '--c': k.color, ...phase() } },
        h('div', { class: `gr-branch-line ${activeNow && !reducedMotion() ? 'flow' : ''} ${k.role === 'mirror' ? 'dashed' : ''}`.trim() }, h('span', { class: 'gr-branch-tag' }, label)),
        h('a', { class: 'gr-branch-node', href: hrefFor('services', k.name, proto) },
          kt ? tile(kt.glyph, kt.hue, { size: 30, icon: 15 }) : tile('ghost', 0, { size: 30, icon: 15 }),
          h('div', { class: 'grow col', style: { gap: '1px', minWidth: '0' } },
            h('div', { class: 'row', style: { gap: '6px' } }, h('b', { class: 'ellipsis' }, split(k.name).base), healthDot(k.health)),
            h('span', { class: 'tiny muted ellipsis' }, !k.child ? 'does not exist' : `${kt.label} · ${HEALTH[k.health]?.label ?? k.health}`)),
          ty === 'failover' ? h('span', { class: `badge ${activeNow ? 'ok' : ''}` }, activeNow ? 'serving' : 'standby') : null,
          actual !== null ? h('div', { class: 'gr-branch-actual' }, h('b', { class: 'tnum' }, pct(actual)), h('span', { class: 'tiny muted' }, 'of requests')) : null));
    });
    const parts = [h('div', { class: 'gr-branch' },
      h('div', { class: 'gr-branch-src' }, tile(T(ty).glyph, T(ty).hue, { size: 40, icon: 20 }), h('div', { class: 'col', style: { gap: '0', minWidth: '0' } }, h('b', { class: 'ellipsis' }, base), h('span', { class: 'tiny muted' }, T(ty).label))),
      h('div', { class: 'gr-branch-list' }, ...items))];
    if (ty === 'weighted') parts.push(splitView(kids, wsum, counts, total));
    if (ty === 'failover') {
      parts.push(fo.active?.name === fo.primary?.name
        ? banner('info', 'The primary is healthy', `Requests go to ${split(fo.primary?.name ?? '').base}; ${split(fo.fallback?.name ?? '').base} takes over if its health check fails.`)
        : banner('warn', 'Running on the fallback', `${split(fo.primary?.name ?? '').base} is ${HEALTH[fo.primaryHealth]?.label ?? fo.primaryHealth}, so ${split(fo.fallback?.name ?? '').base} answers every request.`));
    }
    if (ty === 'mirroring') {
      parts.push(kv([
        ['Mirrors the body', svc.mirroring.mirrorBody === false ? 'no, headers only' : 'yes'],
        ['Largest mirrored body', svc.mirroring.maxBodySize === undefined || svc.mirroring.maxBodySize < 0 ? 'no limit' : bytes(svc.mirroring.maxBodySize)],
        ['Answers from mirrors', 'dropped: the client only sees the main service'],
      ]));
    }
    const sub = ty === 'weighted' ? 'Configured weights, and the share the access log saw' : ty === 'mirroring' ? 'The main service answers; mirrors get copies' : 'Which side is answering right now';
    return card({ title: ty === 'weighted' ? 'Traffic split' : ty === 'mirroring' ? 'Mirroring' : 'Failover', icon: ty === 'weighted' ? 'weight' : ty === 'mirroring' ? 'mirror' : 'failover', sub }, h('div', { class: 'col gap-lg' }, ...parts));
  }

  function splitView(kids, wsum, counts, total) {
    const size = 132; const th = 16; const r = (size - th) / 2; const c = 2 * Math.PI * r;
    let off = 0;
    const arcs = kids.filter((k) => k.role === 'weight' && k.weight > 0).map((k) => {
      const len = ((k.weight ?? 0) / wsum) * c;
      const want = `${Math.max(0, len - 2)} ${c}`;
      const arc = s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: k.color, 'stroke-width': th, 'stroke-dasharray': widths.get(`arc:${k.name}`) ?? `0 ${c}`, 'stroke-dashoffset': -off, class: 'gr-donut-arc' });
      arc.append(s('title', {}, `${k.name}: weight ${k.weight}`));
      widths.set(`arc:${k.name}`, want);
      requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute('stroke-dasharray', want)));
      off += len;
      return arc;
    });
    const donutEl = h('div', { class: 'ring gr-donut', style: { width: `${size}px`, height: `${size}px` } },
      s('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` }, s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--line)', 'stroke-width': th }), s('g', { transform: `rotate(-90 ${size / 2} ${size / 2})` }, ...arcs)),
      h('div', { class: 'ring-val' }, h('b', { class: 'gr-donut-n' }, String(kids.length)), h('span', {}, 'services')));
    const rowsEl = kids.map((k) => {
      const want = (k.weight ?? 0) / wsum;
      const got = total ? (counts.get(k.name) ?? 0) / total : null;
      const a = growBar(`want:${k.name}`, want, { style: { background: k.color } });
      const b = growBar(`got:${k.name}`, got ?? 0, { style: { background: k.color } });
      const drift = got !== null && total >= 50 && Math.abs(got - want) > 0.1;
      return h('div', { class: 'gr-split-row' },
        h('div', { class: 'row', style: { gap: '8px' } }, h('i', { class: 'gr-swatch', style: { background: k.color } }), h('a', { class: 'bold ellipsis gr-link', href: hrefFor('services', k.name, proto) }, split(k.name).base), h('span', { class: 'grow' }), drift ? badge('off target', 'warn') : null),
        h('div', { class: 'gr-split-bars' },
          h('span', { class: 'tiny muted' }, 'configured'), h('div', { class: 'bar' }, a), h('b', { class: 'tnum small' }, pct(want)),
          h('span', { class: 'tiny muted' }, 'actual'), h('div', { class: 'bar gr-bar-actual' }, b), h('b', { class: 'tnum small' }, got === null ? '—' : pct(got))));
    });
    return h('div', { class: 'gr-split' }, donutEl, h('div', { class: 'grow col', style: { gap: '14px', minWidth: '0' } }, ...rowsEl,
      h('div', { class: 'tiny faint' }, logsOff ? 'Turn on the access log to compare with real traffic.' : total ? `Actual: the last ${num(total)} requests of the routers using it.` : 'No requests in the access log yet.')));
  }

  // ── configuration cards ──
  function healthCard() {
    const hc = svc.loadBalancer?.healthCheck;
    if (!hc) {
      return card({ title: 'Health check', icon: 'health' }, h('div', { class: 'col', style: { gap: '10px' } },
        h('div', { class: 'muted small' }, (svc.loadBalancer?.servers ?? []).length > 1 ? 'None. Traefik cannot tell when a server dies and keeps sending it requests.' : 'None.'),
        (svc.loadBalancer?.servers ?? []).length > 1 && proto === 'http' ? h('pre', { class: 'gr-snippet' }, 'healthCheck:\n  path: /health\n  interval: 10s\n  timeout: 3s') : null));
    }
    const probe = (u) => {
      try { const x = new URL(u); if (hc.scheme) x.protocol = `${hc.scheme}:`; if (hc.port) x.port = String(hc.port); if (hc.hostname) x.hostname = hc.hostname; x.pathname = hc.path ?? '/'; return x.toString(); } catch { return `${u}${hc.path ?? ''}`; }
    };
    const interval = durText(hc.interval) ?? '30s';
    return card({ title: 'Health check', icon: 'health', sub: `Every ${interval}, timeout ${durText(hc.timeout) ?? '5s'}` },
      h('div', { class: 'gr-probes' }, ...serversOf(svc).map((x) => h('div', { class: `gr-probe ${x.status === 'DOWN' ? 'down' : 'up'}` },
        h('span', { class: 'gr-probe-pulse' }), h('code', { class: 'ellipsis grow', title: probe(x.key) }, `${hc.method ?? (hc.mode === 'grpc' ? 'gRPC' : 'GET')} ${probe(x.key)}`), h('b', { class: `tiny ${x.status === 'DOWN' ? 'bad-text' : 'ok-text'}` }, x.status ?? '?')))),
      h('div', { class: 'mt' }, kv([
        ['Mode', hc.mode ?? 'http'],
        ['Path', h('code', {}, hc.path ?? '/')],
        ['Interval', interval],
        hc.unhealthyInterval ? ['When down', `every ${durText(hc.unhealthyInterval)}`] : null,
        ['Timeout', durText(hc.timeout) ?? '5s'],
        ['Expects', hc.status ? String(hc.status) : '2xx or 3xx'],
        hc.port ? ['Port', String(hc.port)] : null,
        hc.scheme ? ['Scheme', hc.scheme] : null,
        hc.hostname ? ['Host', hc.hostname] : null,
        ['Follows redirects', hc.followRedirects === false ? 'no' : 'yes'],
        hc.headers ? ['Headers', h('div', { class: 'chips' }, ...Object.keys(hc.headers).map((k) => h('span', { class: 'chip mono' }, k)))] : null,
      ])));
  }
  function stickyCard() {
    const ck = svc.loadBalancer?.sticky?.cookie ?? svc.weighted?.sticky?.cookie;
    if (!ck) return card({ title: 'Sticky sessions', icon: 'lock' }, h('div', { class: 'muted small' }, 'Off: each request may land on a different server.'));
    return card({ title: 'Sticky sessions', icon: 'lock', sub: 'A cookie pins each client to one server' },
      h('div', { class: 'gr-cookie' }, glyph('cookie', { size: 22 }), h('div', { class: 'col', style: { gap: '0', minWidth: '0' } }, h('code', { class: 'bold' }, ck.name || '(generated name)'), h('span', { class: 'tiny muted' }, 'set on the first answer, read on every request after'))),
      h('div', { class: 'mt' }, kv([
        ['Secure', ck.secure ? 'yes' : h('span', { class: 'warn-text' }, 'no')],
        ['HttpOnly', ck.httpOnly ? 'yes' : 'no'],
        ['SameSite', ck.sameSite || 'not set'],
        ['Max age', ck.maxAge ? `${num(ck.maxAge)} s` : 'session'],
        ck.path ? ['Path', h('code', {}, ck.path)] : null,
        ck.domain ? ['Domain', ck.domain] : null,
      ])));
  }
  function forwardingCard() {
    const lb = svc.loadBalancer;
    if (!lb) return null;
    const st = lb.strategy ?? (proto === 'http' ? 'wrr' : null);
    return card({ title: 'Forwarding', icon: 'arrow' }, kv([
      st ? ['Strategy', h('div', { class: 'col', style: { gap: '1px' } }, h('span', { class: 'bold' }, STRATEGY[st]?.[0] ?? st), h('span', { class: 'tiny muted' }, STRATEGY[st]?.[1] ?? ''))] : null,
      proto === 'http' ? ['Host header', lb.passHostHeader === false ? 'replaced with the server\'s' : 'passed through'] : null,
      lb.responseForwarding?.flushInterval ? ['Flush interval', durText(lb.responseForwarding.flushInterval)] : null,
      proto !== 'udp' ? ['Servers transport', lb.serversTransport ? h('code', {}, lb.serversTransport) : h('span', { class: 'muted' }, 'default')] : null,
      lb.terminationDelay !== undefined ? ['Termination delay', `${lb.terminationDelay} ms`] : null,
      lb.proxyProtocol ? ['PROXY protocol', `v${lb.proxyProtocol.version ?? 2}`] : null,
    ]));
  }

  // ── routers and references ──
  function paintRouters() {
    const items = reaching();
    if (!items.length) {
      routersBox.replaceChildren(empty('No router sends here', parentsOf(name, proto).length ? 'It is reached through the services on the right.' : 'Nothing routes to this service.', 'router'));
      return;
    }
    routersBox.replaceChildren(...items.map(({ router: r, via }) => {
      const l = proto === 'http' ? live('router', r.name) : null;
      return h('a', { class: `gr-rrow ${r.status !== 'enabled' ? 'bad' : ''}`.trim(), href: hrefFor('routers', r.name, proto) },
        h('span', { class: 'gr-rrow-ic' }, glyph('router', { size: 15 })),
        h('div', { class: 'grow col', style: { gap: '4px', minWidth: '0' } },
          h('div', { class: 'row wrap', style: { gap: '6px' } }, h('b', {}, split(r.name).base), r.status !== 'enabled' ? statusBadge(r.status) : null,
            ...(r.entryPoints ?? []).map((ep) => h('span', { class: 'badge mono' }, ep)), via ? h('span', { class: 'tiny muted' }, `via ${via.map((v) => split(v).base).join(' › ')}`) : null),
          r.rule ? ruleView(r.rule, { cls: 'small' }) : h('span', { class: 'tiny muted' }, 'no rule')),
        proto === 'http' ? h('div', { class: 'gr-rrow-live' }, h('b', { class: 'tnum' }, l ? fmtRps(l.rps) : '—'), h('span', { class: `tiny ${l?.rps ? `${errTone(l.errorRate) || 'muted'}-text` : 'muted'}` }, l?.rps ? `${pct(l.errorRate)} 5xx` : '')) : null);
    }));
  }
  function paintRefs() {
    const parents = parentsOf(name, proto);
    const pages = proto === 'http' ? errorPagesFor(name) : [];
    if (!parents.length && !pages.length) { refsBox.replaceChildren(h('div', { class: 'muted small' }, 'No other service or middleware points here.')); return; }
    refsBox.replaceChildren(
      ...parents.map((p) => h('a', { class: 'gr-rrow', href: hrefFor('services', p.service.name, proto) }, tile(T(svcType(p.service)).glyph, T(svcType(p.service)).hue, { size: 28, icon: 14 }),
        h('div', { class: 'grow col', style: { gap: '1px', minWidth: '0' } }, h('b', { class: 'ellipsis' }, split(p.service.name).base), h('span', { class: 'tiny muted' }, `${T(svcType(p.service)).label}: ${p.role === 'weight' ? `weight ${p.weight}` : p.role === 'mirror' ? `mirror, ${p.percent}%` : p.role}`)))),
      ...pages.map((m) => h('a', { class: 'gr-rrow', href: hrefFor('middlewares', m.name, 'http') }, tile('octagon', 356, { size: 28, icon: 14 }),
        h('div', { class: 'grow col', style: { gap: '1px', minWidth: '0' } }, h('b', { class: 'ellipsis' }, split(m.name).base), h('span', { class: 'tiny muted' }, `error pages for ${(m.errors.status ?? []).join(', ')}`)))));
  }
  function paintFindings() {
    const f = findingsFor('service', name);
    if (!f.length) { findingsBox.replaceChildren(h('div', { class: 'row muted small' }, glyph('ok', { size: 16, cls: 'ok-text' }), 'Nothing to fix here.')); return; }
    findingsBox.replaceChildren(...f.map((x) => h('a', { href: `#/health?q=${encodeURIComponent(name)}`, class: `gr-finding ${x.severity}` },
      glyph(x.severity === 'critical' ? 'xcircle' : x.severity === 'warning' ? 'alert' : 'info', { size: 16 }),
      h('div', { class: 'grow col', style: { gap: '2px', minWidth: '0' } }, h('b', { class: 'small' }, x.title), h('span', { class: 'tiny muted' }, x.detail), x.fix ? h('span', { class: 'tiny' }, x.fix) : null))));
  }

  // ── recent requests ──
  function paintRequests() {
    if (logsOff) { reqBox.replaceChildren(empty('No request log', proto === 'http' ? 'Point ENODIA_ACCESS_LOG at Traefik\'s JSON access log to see requests.' : 'Traefik\'s access log covers HTTP only.', 'logs')); return; }
    if (!entries) { reqBox.replaceChildren(skeleton(5, 18)); return; }
    const mine = composite() ? entries : entries.filter((e) => e.service === name);
    const last = mine.slice(-12).reverse();
    if (!last.length) { reqBox.replaceChildren(empty('No requests yet', 'They show up here as they arrive.', 'logs')); return; }
    reqBox.replaceChildren(...last.map((e) => h('div', { class: 'gr-req' },
      h('span', { class: `badge ${e.status >= 500 ? 'bad' : e.status >= 400 ? 'warn' : e.status >= 300 ? 'info' : 'ok'} mono` }, String(e.status ?? '—')),
      h('span', { class: 'mono tiny muted gr-req-m' }, e.method ?? ''),
      h('span', { class: 'mono small ellipsis gr-req-p', title: `${e.host ?? ''}${e.path ?? ''}` }, h('span', { class: 'faint' }, e.host ?? ''), e.path ?? ''),
      h('span', { class: 'mono tiny muted ellipsis gr-req-s', title: e.server ?? '' }, composite() ? split(e.service ?? '').base : (e.server ?? '').replace(/^https?:\/\//, '')),
      h('span', { class: `tnum small gr-req-d ${e.durationMs > 1000 ? 'warn-text' : ''}` }, e.durationMs !== null ? ms(e.durationMs) : '—'),
      h('span', { class: 'tiny faint gr-req-t' }, shortAgo(e.t)))));
  }

  const paintRaw = () => rawBox.replaceChildren(rawView(Object.fromEntries(Object.entries(svc).filter(([k]) => k !== 'proto'))));

  // ── charts ──
  const chartKeys = () => {
    if (!composite()) return [`service:${name}`];
    return [...new Set(childrenOf(svc).flatMap((k) => leavesOf(k.name, proto).map((lf) => `service:${lf.name}`)))];
  };
  const reqChart = timeChart([], { height: 210, stacked: true, yFormat: (v) => rate(v) });
  const latChart = timeChart([], { height: 210, yFormat: (v) => ms(v), area: false });
  const bwChart = timeChart([], { height: 210, yFormat: (v) => bytes(v, true) });
  charts.push(reqChart, latChart, bwChart);
  const reqLegend = h('div', { class: 'legend mt-sm' });
  const latLegend = h('div', { class: 'legend mt-sm' });
  const bwLegend = h('div', { class: 'legend mt-sm' });
  const legend = (box, items) => box.replaceChildren(...items.map(([l, c]) => h('span', {}, h('i', { style: { background: c } }), l)));

  function paintCharts() {
    if (metricsOff) return;
    const keys = chartKeys();
    const since = Date.now() - minutes * 60_000;
    const pts = (k) => (series.get(k) ?? []).filter((p) => p.t >= since);
    if (keys.length === 1) {
      const p = pts(keys[0]);
      const cl = [['r2', '2xx', '--c2xx'], ['r3', '3xx', '--c3xx'], ['r4', '4xx', '--c4xx'], ['r5', '5xx', '--c5xx']];
      reqChart.update(cl.map(([k, l, c]) => ({ key: k, label: l, color: cssVar(c), values: p.map((x) => ({ t: x.t, v: x[k] })) })));
      legend(reqLegend, cl.map(([, l, c]) => [l, cssVar(c)]));
      const lat = [['p50', 'p50', '--sky'], ['p95', 'p95', '--violet'], ['p99', 'p99', '--ember']];
      latChart.update(lat.map(([k, l, c]) => ({ key: k, label: l, color: cssVar(c), values: p.map((x) => ({ t: x.t, v: x[k] })) })));
      legend(latLegend, lat.map(([, l, c]) => [l, cssVar(c)]));
      const bw = [['outBps', 'out', '--sky'], ['inBps', 'in', '--violet']];
      bwChart.update(bw.map(([k, l, c]) => ({ key: k, label: l, color: cssVar(c), values: p.map((x) => ({ t: x.t, v: x[k] })) })));
      legend(bwLegend, bw.map(([, l, c]) => [l, cssVar(c)]));
    } else {
      const named = keys.map((k, i) => [k, split(k.slice(8)).base, cssVar(PALETTE[i % PALETTE.length])]);
      reqChart.update(named.map(([k, l, c]) => ({ key: k, label: l, color: c, values: pts(k).map((x) => ({ t: x.t, v: x.rps })) })));
      latChart.update(named.map(([k, l, c]) => ({ key: k, label: `${l} p95`, color: c, values: pts(k).map((x) => ({ t: x.t, v: x.p95 })) })));
      bwChart.update(named.map(([k, l, c]) => ({ key: k, label: l, color: c, values: pts(k).map((x) => ({ t: x.t, v: x.outBps })) })));
      for (const box of [reqLegend, latLegend, bwLegend]) legend(box, named.map(([, l, c]) => [l, c]));
    }
  }

  const liveKeys = () => [...new Set([...chartKeys(), ...(svc.usedBy ?? []).map((r) => `router:${r}`), `service:${name}`])].slice(0, 60);
  async function loadSeries() {
    if (metricsOff) return;
    try {
      const r = await api(`series?keys=${encodeURIComponent(liveKeys().join(','))}&minutes=${Math.max(minutes, 15)}`);
      for (const [k, v] of Object.entries(r.series ?? {})) series.set(k, v);
    } catch { /* the next tick fills in */ }
    paintCharts(); paintTiles();
  }

  async function loadEntries() {
    if (logsOff) { paintRequests(); return; }
    try {
      let got = [];
      if (composite()) {
        const routerNames = [...new Set(reaching().map((x) => x.router.name))].slice(0, 5);
        const res = await Promise.all(routerNames.map((r) => api(`logs?router=${encodeURIComponent(r)}&limit=600`).catch(() => ({ entries: [] }))));
        got = res.flatMap((x) => x.entries ?? []);
      } else {
        got = (await api(`logs?service=${encodeURIComponent(name)}&limit=1000`)).entries ?? [];
      }
      const seen = new Set();
      entries = got.filter((e) => (seen.has(e.id) ? false : seen.add(e.id))).sort((a, b) => a.id - b.id);
    } catch { entries = []; }
    paintMain(); paintRequests();
  }

  // ── layout ──
  function paintMain(force = false) {
    const shares = composite() ? [...childShares().counts.entries()].map(([k, v]) => [k, Math.round((v / Math.max(1, childShares().total)) * 200)]) : [...serverStats().entries()].map(([k, v]) => [k, v.n, v.errors, v.lastStatus, v.last]);
    const sig = JSON.stringify([svc, childrenOf(svc).map((c) => healthOf(c.name, proto)), shares, entries === null]);
    if (!force && sig === mainSig) return;
    mainSig = sig;
    mainBox.replaceChildren(svc.loadBalancer ? serversCard() : composite() ? compositeCard() : card({ title: 'Built into Traefik', icon: 'cpu' }, h('div', { class: 'muted small' }, 'Internal services answer inside Traefik itself: the API, the dashboard, ping, metrics, or noop for routers that only redirect.')));
  }
  // load balancers: health check beside the servers, sticky / forwarding / references below;
  // composites: references and findings beside the split
  const configRow = h('div', { class: 'grid g3' });
  const underMain = h('div', { class: 'col gap-lg' });
  function paintSide() {
    const findings = card({ title: 'Findings', icon: 'health' }, findingsBox);
    if (svc.loadBalancer) {
      sideBox.replaceChildren(healthCard());
      underMain.replaceChildren(refsCard);
      const cards = [proto === 'http' ? stickyCard() : null, forwardingCard(), findings].filter(Boolean);
      configRow.className = `grid ${cards.length === 3 ? 'g3' : 'g2'}`;
      configRow.replaceChildren(...cards);
      configRow.hidden = false;
    } else {
      sideBox.replaceChildren(refsCard, findings);
      underMain.replaceChildren();
      configRow.hidden = true;
    }
    stagger(configRow);
  }

  function paintConfig() {
    const sig = JSON.stringify(svc);
    if (sig === lastSig) return;
    lastSig = sig;
    paintHero(); paintMain(true); paintSide(); paintRouters(); paintRefs(); paintRaw(); paintTiles();
  }

  const showTiles = !metricsOff ? Object.values(tiles) : [tiles.servers];
  const refsCard = card({ title: 'Referenced by', icon: 'link', sub: 'Services and middlewares that point here' }, refsBox);
  const routersCard = card({ title: 'Routers', icon: 'router', sub: 'Every router whose requests end up here' }, routersBox);
  el.append(
    heroBox,
    proto === 'http' ? stagger(h('div', { class: `grid ${showTiles.length > 1 ? 'g6' : 'g4'}` }, ...showTiles)) : null,
    stagger(h('div', { class: 'grid g3' }, h('div', { class: 'span2 col gap-lg' }, mainBox, underMain), sideBox)),
    configRow,
    metricsOff ? null : stagger(h('div', { class: 'grid g3' },
      card({ title: composite() ? 'Requests by service' : 'Requests by status', icon: 'traffic', tools: [segmented([[5, '5m'], [15, '15m'], [60, '1h']], minutes, (v) => { minutes = v; loadSeries(); })] }, reqChart.el, reqLegend),
      card({ title: 'Latency', icon: 'clock', sub: composite() ? 'p95 of each service' : 'Percentiles of the time to answer' }, latChart.el, latLegend),
      card({ title: 'Bandwidth', icon: 'download', sub: composite() ? 'Out, per service' : 'In and out' }, bwChart.el, bwLegend))),
    routersCard,
    proto !== 'http' ? null : card({ title: 'Recent requests', icon: 'logs', tools: proto === 'http' && !logsOff ? [h('a', { class: 'btn sm ghost', href: composite() ? '#/logs' : `#/logs?service=${encodeURIComponent(name)}` }, 'Access log', glyph('chevron', { size: 14 }))] : [] }, reqBox),
    card({ title: 'Raw configuration', icon: 'code', cls: 'gr-raw', sub: 'As Traefik reports it, secrets masked', tools: [copyButton(() => JSON.stringify(sanitize(svc), null, 2), 'Copy JSON'),
      h('a', { class: 'btn sm ghost', href: `#/explorer?path=${encodeURIComponent(`/api/${proto}/services/${name}`)}` }, glyph('code', { size: 13 }), 'API explorer'),
      h('button', { class: 'btn sm ghost', onclick: async (e) => {
        const btn = e.currentTarget; btn.disabled = true;
        try { const raw = await api(`raw?path=${encodeURIComponent(`/api/${proto}/services/${name}`)}`); rawBox.replaceChildren(rawView(raw)); } catch (x) { rawBox.prepend(banner('bad', 'Could not ask Traefik', x.message)); }
        btn.disabled = false;
      } }, glyph('refresh', { size: 13 }), 'Fetch from Traefik')] }, rawBox),
  );

  paintConfig(); paintFindings(); paintRequests(); paintCharts();
  loadSeries(); loadEntries();

  let pend = 0;
  return {
    el,
    update(event, data) {
      if (event === 'state') {
        const next = findService(name, proto);
        if (next) { svc = next; paintConfig(); }
      } else if (event === 'metrics' && data?.latest && !metricsOff) {
        const since = Date.now() - Math.max(minutes, 15) * 60_000;
        for (const k of liveKeys()) {
          const p = data.latest[k];
          if (!p) continue;
          const arr = series.get(k) ?? [];
          if (!arr.length || arr[arr.length - 1].t < p.t) arr.push(p);
          while (arr.length && arr[0].t < since) arr.shift();
          series.set(k, arr);
        }
        paintTiles(); paintCharts(); paintRouters();
        if (composite()) paintMain();
      } else if (event === 'logs' && entries && Array.isArray(data)) {
        const routerNames = composite() ? new Set(reaching().map((x) => x.router.name)) : null;
        const fresh = data.filter((e) => (routerNames ? routerNames.has(e.router) : e.service === name));
        if (!fresh.length) return;
        entries.push(...fresh);
        if (entries.length > 1500) entries.splice(0, entries.length - 1500);
        if (!pend) pend = setTimeout(() => { pend = 0; paintMain(); paintRequests(); }, 700);
      } else if (event === 'diagnostics') { paintFindings(); paintHero(); }
    },
    destroy() { for (const c of charts) c.destroy(); clearTimeout(pend); },
  };
}
