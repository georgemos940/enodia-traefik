// Routers: every HTTP, TCP and UDP router with its live traffic, and one router in depth: the path a
// request takes through its middlewares to the servers, live charts, its access log and its findings.
import { h, s, icon, stagger } from '../lib/dom.js';
import { store, api, all, find, findingsFor } from '../lib/store.js';
import { card, stat, badge, statusBadge, providerBadge, kv, jsonView, empty, banner, hrefFor, copyButton, skeleton, navigate, segmented } from '../lib/components.js';
import { timeChart, donut, countTo, bars } from '../lib/charts.js';
import { rate, pct, ms, bytes, num, split, time, plural } from '../lib/format.js';
import { ruleView, explainRule, ruleConditions, middlewareInfo, priorityOf, fmtPriority, byPriority, syntaxOf, parseRule, epPort, qualifyName, MAX_PRIORITY } from '../lib/rules.js';

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const PROTOS = [['http', 'HTTP'], ['tcp', 'TCP'], ['udp', 'UDP']];
export const epsOf = (r) => (r.using?.length ? r.using : r.entryPoints ?? []);
export const svcOf = (r) => (r.service ? qualifyName(r.service, r.provider ?? split(r.name).provider) : '');
export const liveOf = (name) => store.metrics?.latest?.[`router:${name}`] ?? null;
export const errTone = (e) => (e >= 0.05 ? 'bad' : e > 0.01 ? 'warn' : '');

/** A view that can rebuild itself in place (when the router it shows changes, or the state arrives). */
export function rebuildable(build) {
  const box = h('div', { class: 'rt-host' });
  let view = null;
  const mount = () => {
    view?.destroy?.();
    view = build(mount);
    box.replaceChildren(view.el);
  };
  mount();
  return { el: box, update: (e, d) => view?.update?.(e, d), destroy: () => view?.destroy?.() };
}

// ── history for the little sparklines, kept while the app is open ─────────────

export const HIST = new Map();   // 'router:NAME' | 'ep:NAME' -> [{ t, rps, e }]
const HIST_KEEP = 36;
function remember(latest) {
  for (const [k, p] of Object.entries(latest ?? {})) {
    if (!k.startsWith('router:') && !k.startsWith('ep:')) continue;
    const arr = HIST.get(k) ?? [];
    if (arr.length && arr[arr.length - 1].t >= p.t) continue;
    arr.push({ t: p.t, rps: p.rps ?? 0, e: p.errorRate ?? 0 });
    if (arr.length > HIST_KEEP) arr.splice(0, arr.length - HIST_KEEP);
    HIST.set(k, arr);
  }
}
store.on('metrics', (m) => remember(m?.latest));
remember(store.metrics?.latest);

let seededAt = 0;
/** Fill the sparkline history from the server once, for every key that has traffic. */
export async function seedHistory() {
  if (Date.now() - seededAt < 120_000 || store.meta?.features?.metrics === false) return false;
  seededAt = Date.now();
  const keys = Object.keys(store.metrics?.latest ?? {}).filter((k) => k.startsWith('router:') || k.startsWith('ep:'));
  const batches = [];
  for (let i = 0; i < keys.length; i += 60) batches.push(keys.slice(i, i + 60));
  try {
    const res = await Promise.all(batches.map((b) => api(`series?keys=${b.map(encodeURIComponent).join(',')}&minutes=3`)));
    for (const r of res) {
      for (const [k, pts] of Object.entries(r.series ?? {})) {
        const known = HIST.get(k) ?? [];
        const lastT = pts.length ? pts[pts.length - 1].t : 0;
        const merged = [...pts.map((p) => ({ t: p.t, rps: p.rps ?? 0, e: p.errorRate ?? 0 })), ...known.filter((x) => x.t > lastT)];
        HIST.set(k, merged.slice(-HIST_KEEP));
      }
    }
    return true;
  } catch { return false; }
}

/** A small sparkline whose path is updated in place. */
let sparkIds = 0;
export function miniSpark(w = 80, hgt = 26) {
  const id = `rtsg${++sparkIds}`;
  const area = s('path', { class: 'rt-spark-area', fill: `url(#${id})` });
  const line = s('path', { class: 'rt-spark-line' });
  const svg = s('svg', { class: 'rt-spark', viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    s('defs', {}, s('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: '0', 'stop-color': 'currentColor', 'stop-opacity': '0.32' }), s('stop', { offset: '1', 'stop-color': 'currentColor', 'stop-opacity': '0' }))),
    area, line);
  svg.set = (vals, tone = '') => {
    svg.setAttribute('class', `rt-spark ${svg.dataset.extra ?? ''} ${tone ? `t-${tone}` : ''}`.replace(/\s+/g, ' ').trim());
    if (!vals.length) { line.setAttribute('d', ''); area.setAttribute('d', ''); return; }
    // scale between the low and the high mark so a steady but busy line still shows its shape
    const hi = Math.max(...vals);
    const lo0 = Math.min(...vals);
    const span = hi - lo0;
    const lo = span < hi * 0.04 ? hi * 0.5 : Math.max(0, lo0 - span * 0.25);
    const range = Math.max(hi - lo, 1e-9);
    const step = w / Math.max(1, vals.length - 1);
    const pts = vals.map((v, i) => [i * step, hgt - 2 - ((v - lo) / range) * (hgt - 6)]);
    if (pts.length === 1) pts.push([w, pts[0][1]]);
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    line.setAttribute('d', d);
    area.setAttribute('d', `${d}L${w},${hgt}L0,${hgt}Z`);
  };
  return svg;
}

// ── shared bits ──────────────────────────────────────────────────────────────

/** A TLS badge with what drives it: resolver, options or domains. */
export function tlsBadge(r, proto = 'http') {
  const t = r.tls;
  if (!t) return h('span', { class: 'faint small' }, '—');
  const domains = (t.domains ?? []).flatMap((d) => [d.main, ...(d.sans ?? [])]).filter(Boolean);
  const sub = t.passthrough ? 'passthrough' : t.certResolver ? t.certResolver : domains.length ? plural(domains.length, 'domain') : t.options && t.options !== 'default' ? `opts ${split(t.options).base}` : 'default';
  return h('div', { class: 'rt-tls', title: [t.certResolver && `resolver: ${t.certResolver}`, t.options && `options: ${t.options}`, domains.length && `domains: ${domains.join(', ')}`, t.passthrough && 'passthrough: Traefik does not decrypt'].filter(Boolean).join('\n') },
    h('span', { class: `badge ${t.passthrough ? 'violet' : 'torch'}` }, icon('lock', { size: 11 }), proto === 'tcp' && t.passthrough ? 'pass' : 'TLS'),
    h('span', { class: 'rt-tls-sub' }, sub));
}

/** A request that should reach this router: for the tester and the "test" links. */
export function sampleRequest(r, entrypoints = store.state?.entrypoints ?? []) {
  const eps = epsOf(r);
  const epObj = entrypoints.find((e) => e.name === eps[0]) ?? null;
  const tls = Boolean(r.tls) || Boolean(epObj?.http?.tls);
  const out = { host: '', path: '', method: '', headers: [], query: [] };
  let ast = null;
  try { ast = parseRule(r.rule ?? '', { syntax: syntaxOf(r, store.state?.static), proto: r.proto === 'tcp' ? 'tcp' : 'http' }); } catch { /* defaults */ }
  const fromRegex = (re) => {
    const g = re.replace(/^\^|\$$/g, '').replace(/\\\./g, '.').replace(/\(\?i\)/g, '').replace(/\[[^\]]*\][+*]?|\.[+*]|\\w[+*]|\\d[+*]|\{[^}]*\}/g, 'app');
    return /[\\^$()|[\]*+?{}]/.test(g) ? '' : g;
  };
  const walk = (n, neg) => {
    if (!n) return;
    if (n.type === 'not') { walk(n.expr, !neg); return; }
    if (n.type === 'or') { walk(n.items[0], neg); return; }
    if (n.type === 'and') { for (const x of n.items) walk(x, neg); return; }
    if (neg) return;
    const [a, b] = n.args;
    const tpl = (x) => x.replace(/\{[^}]*\}/g, 'app');
    switch (n.name) {
      case 'Host': case 'HostHeader': case 'HostSNI': if (a !== '*') out.host ||= a; break;
      case 'HostRegexp': case 'HostSNIRegexp': out.host ||= n.syntax === 'v2' ? tpl(a) : fromRegex(a); break;
      case 'Path': case 'PathPrefix': out.path ||= n.syntax === 'v2' ? tpl(a) : a; break;
      case 'PathRegexp': out.path ||= fromRegex(a); break;
      case 'Method': out.method ||= a.toUpperCase(); break;
      case 'Header': case 'Headers': out.headers.push([a, b]); break;
      case 'Query': if (n.syntax === 'v2') { for (const x of n.args) { const [k, v = ''] = x.split('='); out.query.push([k, tpl(v)]); } } else out.query.push([a, b ?? '']); break;
      default: break;
    }
  };
  walk(ast, false);
  const port = epPort(epObj);
  const def = tls ? '443' : '80';
  const qs = out.query.length ? `?${out.query.map(([k, v]) => `${encodeURIComponent(k)}${v ? `=${encodeURIComponent(v)}` : ''}`).join('&')}` : '';
  const path = out.path && out.path.startsWith('/') ? out.path : '/';
  return { url: `${tls ? 'https' : 'http'}://${out.host || 'example.com'}${port && port !== def ? `:${port}` : ''}${path}${qs}`, method: out.method || 'GET', headers: out.headers, ep: eps[0] ?? '', sni: out.host, tls };
}

/** The tester link for a router. */
export function testerHref(r) {
  if (r.proto === 'udp') return '#/tester';
  const x = sampleRequest(r);
  const p = new URLSearchParams();
  if (r.proto === 'tcp') { p.set('mode', 'tcp'); p.set('sni', x.sni || ''); p.set('tls', r.tls ? '1' : '0'); } else {
    p.set('url', x.url);
    if (x.method !== 'GET') p.set('method', x.method);
    for (const [k, v] of x.headers) p.append('h', `${k}: ${v}`);
  }
  if (x.ep) p.set('ep', x.ep);
  return `#/tester?${p.toString()}`;
}

// ── the table ────────────────────────────────────────────────────────────────

const COLS = {
  http: ['name', 'rule', 'eps', 'mw', 'svc', 'tls', 'prio', 'live'],
  tcp: ['name', 'rule', 'eps', 'mw', 'svc', 'tls', 'prio'],
  udp: ['name', 'eps', 'svc'],
};
const HEAD = { name: ['Router', 'name'], rule: ['Rule', ''], eps: ['Entry points', ''], mw: ['Middlewares', 'mw'], svc: ['Service', 'service'], tls: ['TLS', 'tls'], prio: ['Priority', 'priority'], live: ['Traffic', 'rps'] };
const SORTS = {
  name: { label: 'Name', key: (r) => r.name.toLowerCase(), dir: 1 },
  priority: { label: 'Priority', cmp: byPriority, dir: -1 },
  rps: { label: 'Requests', key: (r) => liveOf(r.name)?.rps ?? -1, dir: -1, live: true },
  errors: { label: 'Errors', key: (r) => liveOf(r.name)?.errorRate ?? -1, dir: -1, live: true },
  p95: { label: 'Latency', key: (r) => liveOf(r.name)?.p95 ?? -1, dir: -1, live: true },
  status: { label: 'Problems first', key: (r) => ({ disabled: 0, warning: 1 }[r.status] ?? 2), dir: 1 },
  mw: { label: 'Middlewares', key: (r) => (r.middlewares ?? []).length, dir: -1 },
  service: { label: 'Service', key: (r) => svcOf(r).toLowerCase(), dir: 1 },
  tls: { label: 'TLS', key: (r) => (r.tls ? 0 : 1), dir: 1 },
};

/**
 * The router table. Rows are keyed by name and kept between updates: live numbers change in place,
 * filters only hide rows and sorting moves them (animated), so nothing flickers and scroll stays put.
 * opts: { proto, only(r) -> bool, compact, sort, onChange }.
 */
export function routerTable({ proto = 'http', only = null, compact = false, sort = 'name', onChange, onClear } = {}) {
  let cur = proto;
  let sortKey = SORTS[sort] ? sort : 'name';
  let sortDir = 0;            // 0: the sort's own direction, else 1 / -1
  let q = '';
  let filters = { status: new Set(), provider: new Set(), ep: new Set(), tls: new Set() };
  const recs = new Map();     // name -> { r, el, fp, hay, live }
  const head = h('div', { class: 'rt-head', role: 'row' });
  const rows = h('div', { class: 'rt-rows', role: 'rowgroup' });
  const none = h('div', { class: 'rt-none', hidden: true });
  const el = h('div', { class: `rt-table rt-${cur} ${compact ? 'rt-compact' : ''}`.trim(), role: 'table' }, head, rows, none);
  let shown = 0;
  let firstPaint = true;

  const colsFor = () => COLS[cur].filter((c) => !(compact && c === 'mw'));
  const source = () => (store.state?.[cur]?.routers ?? []).map((r) => ({ ...r, proto: cur })).filter((r) => !only || only(r));
  const fingerprint = (r) => `${JSON.stringify(r)}|${findingsFor('router', r.name).filter((x) => x.severity !== 'info').map((x) => x.id).join(',')}`;

  function buildRow(r) {
    const href = hrefFor('routers', r.name, cur);
    const { base, provider } = split(r.name);
    const findings = findingsFor('router', r.name).filter((x) => x.severity !== 'info');
    const live = {};
    const cells = {
      name: () => h('div', { class: 'rt-c rt-c-name', role: 'cell' },
        h('span', { class: `rt-dot ${r.status === 'enabled' ? 'ok' : r.status === 'warning' ? 'warn' : 'bad'}`, title: r.status }),
        h('div', { class: 'rt-name' },
          h('a', { class: 'rt-title', href, title: r.name }, base),
          h('div', { class: 'rt-name-sub' }, h('span', { class: 'rt-prov' }, provider || '—'),
            findings.length ? h('span', { class: `rt-flag ${findings.some((x) => x.severity === 'critical') ? 'bad' : 'warn'}`, title: findings.map((x) => x.title).join('\n') }, icon('alert', { size: 11 }), String(findings.length)) : null))),
      rule: () => h('div', { class: 'rt-c rt-c-rule', role: 'cell' }, r.rule ? ruleView(r.rule) : h('span', { class: 'faint small' }, 'catches everything')),
      eps: () => h('div', { class: 'rt-c rt-c-eps', role: 'cell', 'data-label': 'Entry points' }, ...epsOf(r).map((e) => h('a', { class: 'rt-ep', href: hrefFor('entrypoints', e) }, e))),
      mw: () => {
        const mws = r.middlewares ?? [];
        return h('div', { class: 'rt-c rt-c-mw', role: 'cell', 'data-label': 'Middlewares' }, mws.length
          ? h('span', { class: 'rt-mw', title: mws.join('\n') }, h('b', {}, String(mws.length)), h('span', { class: 'rt-mw-dots' }, ...mws.slice(0, 6).map((m) => h('i', { class: find('middlewares', m, cur) ? '' : 'bad' }))))
          : h('span', { class: 'faint small' }, 'none'));
      },
      svc: () => {
        const svc = svcOf(r);
        const missing = svc && !svc.endsWith('@internal') && !find('services', svc, cur);
        return h('div', { class: 'rt-c rt-c-svc', role: 'cell', 'data-label': 'Service' }, svc
          ? h('a', { class: `rt-svc ${missing ? 'bad' : ''}`.trim(), href: hrefFor('services', svc, cur), title: svc }, icon(svc.endsWith('@internal') ? 'zap' : 'service', { size: 13 }), h('span', { class: 'ellipsis' }, split(svc).base))
          : h('span', { class: 'faint small' }, '—'));
      },
      tls: () => h('div', { class: 'rt-c rt-c-tls', role: 'cell', 'data-label': 'TLS' }, tlsBadge(r, cur)),
      prio: () => {
        const p = priorityOf(r);
        const own = Number(r.priority) && String(r.rule ?? '').length !== Number(r.priority);
        return h('div', { class: 'rt-c rt-c-prio', role: 'cell', 'data-label': 'Priority', title: p >= MAX_PRIORITY ? 'Highest possible (Traefik internal)' : own ? 'Set explicitly' : 'From the rule length' }, h('span', { class: `rt-prio ${own || p >= MAX_PRIORITY ? 'own' : ''}`.trim() }, fmtPriority(p)));
      },
      live: () => {
        live.rps = h('b', { class: 'rt-rps' }, '—');
        live.sub = h('span', { class: 'rt-live-sub' });
        live.spark = miniSpark();
        return h('div', { class: 'rt-c rt-c-live', role: 'cell' }, live.spark, h('div', { class: 'rt-live-nums' }, live.rps, live.sub));
      },
    };
    const el = h('div', { class: `rt-row st-${r.status}`, role: 'row', onclick: (e) => { if (!e.target.closest('a,button') && !window.getSelection()?.toString()) navigate(href); } },
      ...colsFor().map((c) => cells[c]()),
      r.error?.length ? h('div', { class: `rt-err ${r.status === 'disabled' ? 'bad' : 'warn'}`, role: 'cell' }, icon(r.status === 'disabled' ? 'xcircle' : 'alert', { size: 14 }), h('span', {}, h('b', {}, r.status === 'disabled' ? 'Not serving: ' : 'Warning: '), r.error.join(' · '))) : null);
    const hay = [r.name, r.rule, svcOf(r), ...(r.middlewares ?? []), ...epsOf(r), r.tls?.certResolver, r.tls?.options].filter(Boolean).join(' ').toLowerCase();
    return { r, el, live, hay, fp: fingerprint(r) };
  }

  function paintLive(rec) {
    if (!rec.live.rps) return;
    const p = liveOf(rec.r.name);
    const vals = (HIST.get(`router:${rec.r.name}`) ?? []).map((x) => x.rps);
    if (!p) {
      rec.live.rps.textContent = '—';
      rec.live.rps.className = 'rt-rps idle';
      rec.live.sub.replaceChildren(store.meta?.features?.metrics === false ? 'metrics off' : 'no traffic');
      rec.live.spark.set(vals);
      return;
    }
    rec.live.rps.textContent = `${rate(p.rps)}/s`;
    rec.live.rps.className = `rt-rps ${p.rps > 0 ? '' : 'idle'}`.trim();
    const tone = errTone(p.errorRate);
    rec.live.sub.replaceChildren(
      h('span', { class: tone ? `${tone}-text` : '', title: 'Server errors (5xx)' }, `${pct(p.errorRate)} err`),
      h('span', { class: 'faint' }, ' · '),
      h('span', { title: '95th percentile latency' }, `p95 ${p.p95 === null || p.p95 === undefined ? '—' : ms(p.p95)}`));
    rec.live.spark.set(vals.length ? vals : [p.rps], tone === 'bad' ? 'bad' : '');
  }

  const dirOf = () => sortDir || SORTS[sortKey]?.dir || 1;

  function paintHead() {
    head.replaceChildren(...colsFor().map((c) => {
      const [label, key] = HEAD[c];
      const on = key && key === sortKey;
      return h('div', {
        class: `rt-h rt-h-${c} ${key ? 'sortable' : ''} ${on ? 'on' : ''}`.trim(), role: 'columnheader',
        onclick: key ? () => { if (sortKey === key) sortDir = -dirOf(); else { sortKey = key; sortDir = 0; } paintHead(); order(true); onChange?.(); } : undefined,
      }, label, on ? h('span', { class: 'rt-arrow' }, dirOf() > 0 ? '↑' : '↓') : null);
    }));
  }

  function passes(rec) {
    const r = rec.r;
    if (q) for (const w of q.split(/\s+/)) if (w && !rec.hay.includes(w)) return false;
    if (filters.status.size && !filters.status.has(r.status)) return false;
    if (filters.provider.size && !filters.provider.has(r.provider ?? split(r.name).provider)) return false;
    if (filters.ep.size && !epsOf(r).some((e) => filters.ep.has(e))) return false;
    if (filters.tls.size && !filters.tls.has(r.tls ? 'yes' : 'no')) return false;
    return true;
  }

  function sorted() {
    const sd = SORTS[sortKey] ?? SORTS.name;
    const list = [...recs.values()];
    const flip = dirOf() === (sd.dir || 1) ? 1 : -1;
    if (sd.cmp) list.sort((a, b) => sd.cmp(a.r, b.r) * flip);
    else {
      const dir = dirOf();
      list.sort((a, b) => {
        const x = sd.key(a.r); const y = sd.key(b.r);
        if (x === y) return a.r.name.localeCompare(b.r.name);
        return (x > y ? 1 : -1) * dir;
      });
    }
    return list;
  }

  function order(animate) {
    const list = sorted();
    const kids = rows.children;
    let same = kids.length === list.length;
    for (let i = 0; same && i < list.length; i++) if (kids[i] !== list[i].el) same = false;
    if (same) return;
    const before = new Map();
    if (animate && !reduced() && rows.isConnected) {
      for (const rec of list) {
        if (rec.el.hidden || !rec.el.isConnected) continue;
        const b = rec.el.getBoundingClientRect();
        if (b.bottom > -80 && b.top < innerHeight + 80) before.set(rec.el, b.top);
      }
    }
    rows.append(...list.map((x) => x.el));
    for (const [node, top] of before) {
      const dy = top - node.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) node.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 460, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }

  function applyFilter() {
    shown = 0;
    for (const rec of recs.values()) {
      const ok = passes(rec);
      if (rec.el.hidden === ok) rec.el.hidden = !ok;
      if (ok) shown++;
    }
    const total = recs.size;
    none.hidden = shown > 0;
    if (!shown) {
      none.replaceChildren(total
        ? h('div', { class: 'empty' }, icon('filter', { size: 26 }), h('div', { class: 'empty-title' }, 'No router matches these filters'), h('div', { class: 'small' }, `${plural(total, `${cur.toUpperCase()} router`)} hidden by the filters.`), onClear ? h('button', { type: 'button', class: 'btn sm mt-sm', onclick: onClear }, icon('x', { size: 13 }), 'Clear the filters') : null)
        : h('div', { class: 'empty' }, icon(cur === 'http' ? 'router' : cur, { size: 28 }), h('div', { class: 'empty-title' }, `No ${cur.toUpperCase()} routers`), h('div', { class: 'small' }, cur === 'http' ? 'Routers appear here as soon as a provider defines them.' : `This Traefik has no ${cur.toUpperCase()} routers.`)));
    }
    head.hidden = !shown;
  }

  function refresh() {
    const list = source();
    const seen = new Set();
    for (const r of list) {
      seen.add(r.name);
      const old = recs.get(r.name);
      const fp = fingerprint(r);
      if (old && old.fp === fp) { old.r = r; continue; }
      const rec = buildRow(r);
      if (old) { old.el.replaceWith(rec.el); rec.el.hidden = old.el.hidden; rec.el.classList.add('flash'); }
      recs.set(r.name, rec);
      paintLive(rec);
    }
    for (const [n, rec] of recs) if (!seen.has(n)) { rec.el.remove(); recs.delete(n); }
    if (firstPaint) {
      firstPaint = false;
      sorted().slice(0, 16).forEach((rec, i) => { rec.el.classList.add('rt-in'); rec.el.style.setProperty('--i', String(i)); });
    }
    el.classList.toggle('rt-many', recs.size > 80);
    order(false);
    applyFilter();
  }

  function tick() {
    for (const rec of recs.values()) paintLive(rec);
    if (SORTS[sortKey]?.live) order(true);
  }

  function setProto(p) {
    if (p === cur) return;
    cur = p;
    for (const rec of recs.values()) rec.el.remove();
    recs.clear();
    el.className = `rt-table rt-${cur} ${compact ? 'rt-compact' : ''}`.trim();
    firstPaint = true;
    paintHead();
    refresh();
  }

  paintHead();
  refresh();
  return {
    el, refresh, tick, setProto,
    setQuery(v) { q = String(v ?? '').trim().toLowerCase(); applyFilter(); },
    setFilters(f) { filters = f; applyFilter(); },
    setSort(k, dir = 0) { sortKey = SORTS[k] ? k : 'name'; sortDir = dir; paintHead(); order(true); },
    get sort() { return sortKey; },
    get sortDir() { return sortDir; },
    get shown() { return shown; },
    get total() { return recs.size; },
    get proto() { return cur; },
  };
}

// ── list page ────────────────────────────────────────────────────────────────

function renderList(ctx, rebuild) {
  ctx.setCrumbs([['Routers']]);
  const q0 = ctx.query;
  const el = h('div', { class: 'col gap-lg rt-page' });

  el.append(h('div', { class: 'page-head' },
    h('div', { class: 'grow' },
      h('h1', { class: 'page-title' }, icon('router', { size: 24, cls: 'torch-text' }), 'Routers'),
      h('p', { class: 'page-sub' }, 'Every rule Traefik matches requests against, where each one sends traffic, and how busy it is right now.')),
    h('div', { class: 'row wrap' },
      h('a', { class: 'btn', href: '#/tester' }, icon('tester', { size: 15 }), 'Test a URL'),
      h('a', { class: 'btn ghost', href: '#/topology' }, icon('topology', { size: 15 }), 'Topology'))));

  if (!store.state) {
    el.append(h('div', { class: 'grid g6' }, ...Array.from({ length: 6 }, () => h('div', { class: 'card stat' }, skeleton(2, 16)))), card({}, skeleton(10, 18)));
    return { el, update(ev) { if (ev === 'state' && store.state) rebuild(); } };
  }

  const st0 = store.state;
  let proto = PROTOS.some(([p]) => p === q0.get('proto')) ? q0.get('proto') : 'http';
  if (!q0.get('proto') && !(st0.http?.routers?.length) && st0.tcp?.routers?.length) proto = 'tcp';
  const filters = { status: new Set(q0.getAll('status')), provider: new Set(q0.getAll('provider')), ep: new Set(q0.getAll('ep')), tls: new Set(q0.getAll('tls')) };
  let query = q0.get('q') ?? '';
  const metricsOff = store.meta?.features?.metrics === false;

  // tiles
  const tiles = {
    total: stat({ label: 'Routers', icon: 'router', value: '—' }),
    ok: stat({ label: 'Serving', icon: 'ok', value: '—' }),
    bad: stat({ label: 'Not serving', icon: 'xcircle', value: '—' }),
    tls: stat({ label: 'With TLS', icon: 'lock', value: '—' }),
    rps: stat({ label: 'Requests / second', icon: 'zap', value: '—' }),
    err: stat({ label: 'Error rate', icon: 'alert', value: '—' }),
  };
  tiles.bad.classList.add('hover', 'rt-click');
  tiles.bad.tabIndex = 0;
  const toggleBroken = () => { const only = filters.status.size === 1 && filters.status.has('disabled'); filters.status = new Set(only ? [] : ['disabled']); syncFilters(); paintTiles(); };
  tiles.bad.addEventListener('click', toggleBroken);
  tiles.bad.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBroken(); } });
  const rpsSpark = miniSpark(240, 46);
  rpsSpark.dataset.extra = 'spark';
  rpsSpark.set([]);
  tiles.rps.append(rpsSpark);
  el.append(stagger(h('div', { class: 'grid g6' }, ...Object.values(tiles))));

  // toolbar + table
  const tabBar = h('div', { class: 'tabs rt-tabs', role: 'tablist' });
  const clearAll = () => { for (const k of Object.keys(filters)) filters[k].clear(); query = ''; search.value = ''; table.setQuery(''); syncFilters(); paintTiles(); };
  const table = routerTable({ proto, sort: q0.get('sort') ?? 'name', onChange: () => { sortSel.value = table.sort; saveUrl(); }, onClear: () => clearAll() });
  if (q0.get('dir')) table.setSort(table.sort, q0.get('dir') === 'asc' ? 1 : -1);
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Filter by name, rule, host, service, middleware…', value: query, autocomplete: 'off', spellcheck: false, 'aria-label': 'Filter routers' });
  search.addEventListener('input', () => { query = search.value; table.setQuery(query); paintCount(); saveUrl(); paintChips(); });
  const sortSel = h('select', { class: 'input rt-sort', 'aria-label': 'Sort' }, ...Object.entries(SORTS).filter(([k]) => !['mw', 'service', 'tls'].includes(k)).map(([k, v]) => h('option', { value: k }, v.label)));
  sortSel.value = SORTS[table.sort] && !['mw', 'service', 'tls'].includes(table.sort) ? table.sort : 'name';
  sortSel.addEventListener('change', () => { table.setSort(sortSel.value); saveUrl(); });
  const countEl = h('span', { class: 'rt-count-txt' });
  const chipsEl = h('div', { class: 'rt-chips' });
  const filterBtn = h('button', { class: 'btn rt-filter-btn', type: 'button', 'aria-expanded': 'false', onclick: () => { const open = chipsEl.classList.toggle('open'); filterBtn.setAttribute('aria-expanded', String(open)); } }, icon('filter', { size: 14 }), 'Filters', h('span', { class: 'rt-filter-n' }));
  const toolbar = h('div', { class: 'rt-toolbar' },
    h('label', { class: 'input-wrap rt-search' }, icon('search', { size: 15 }), search, h('span', { class: 'kbd rt-slash' }, '/')),
    h('label', { class: 'rt-sort-wrap' }, h('span', { class: 'small muted' }, 'Sort'), sortSel),
    filterBtn,
    countEl);
  el.append(h('section', { class: 'card rt-list-card' }, h('div', { class: 'rt-list-top' }, tabBar, toolbar, chipsEl), table.el));

  function paintTabs() {
    const st = store.state;
    tabBar.replaceChildren(...PROTOS.map(([p, label]) => {
      const list = st?.[p]?.routers ?? [];
      const broken = list.filter((r) => r.status === 'disabled').length;
      return h('button', {
        type: 'button', role: 'tab', class: p === table.proto ? 'on' : '', 'aria-selected': String(p === table.proto),
        onclick: () => { if (p === table.proto) return; table.setProto(p); for (const k of Object.keys(filters)) filters[k].clear(); syncFilters(); paintTabs(); },
      }, icon(p === 'http' ? 'globe' : p, { size: 14 }), label, h('span', { class: 'rt-tab-n' }, String(list.length)), broken ? h('span', { class: 'rt-tab-alert', title: `${broken} not serving` }) : null);
    }));
  }

  function chip(group, value, label, n, lead) {
    const on = filters[group].has(value);
    return h('button', { type: 'button', class: `rt-chip ${on ? 'on' : ''}`.trim(), 'aria-pressed': String(on), onclick: () => { if (on) filters[group].delete(value); else filters[group].add(value); syncFilters(); paintTiles(); } },
      lead ?? null, label, h('span', { class: 'rt-chip-n' }, String(n)));
  }

  function paintChips() {
    const list = store.state?.[table.proto]?.routers ?? [];
    const count = (fn) => { const m = new Map(); for (const r of list) for (const k of [].concat(fn(r))) m.set(k, (m.get(k) ?? 0) + 1); return m; };
    const status = count((r) => r.status);
    const prov = count((r) => r.provider ?? split(r.name).provider);
    const eps = count((r) => epsOf(r));
    const tls = count((r) => (r.tls ? 'yes' : 'no'));
    const group = (label, items) => (items.length ? h('div', { class: 'rt-chip-group' }, h('span', { class: 'rt-chip-label' }, label), ...items) : null);
    const active = Object.values(filters).reduce((a, x) => a + x.size, 0);
    chipsEl.replaceChildren(
      group('Status', ['enabled', 'warning', 'disabled'].filter((x) => status.get(x) || filters.status.has(x)).map((x) => chip('status', x, x === 'disabled' ? 'not serving' : x, status.get(x) ?? 0, h('span', { class: `rt-dot ${x === 'enabled' ? 'ok' : x === 'warning' ? 'warn' : 'bad'}` })))),
      group('Provider', [...prov.keys()].sort().map((x) => chip('provider', x, x, prov.get(x)))),
      group('Entry point', [...eps.keys()].sort().map((x) => chip('ep', x, x, eps.get(x)))),
      table.proto === 'udp' ? null : group('TLS', [['yes', 'TLS'], ['no', 'plain']].filter(([x]) => tls.get(x)).map(([x, l]) => chip('tls', x, l, tls.get(x), icon(x === 'yes' ? 'lock' : 'unlock', { size: 12 })))),
      active || query ? h('button', { type: 'button', class: 'btn sm ghost rt-clear', onclick: clearAll }, icon('x', { size: 13 }), 'Clear all') : null);
    filterBtn.querySelector('.rt-filter-n').textContent = active ? String(active) : '';
    filterBtn.classList.toggle('on', active > 0);
  }

  function paintCount() {
    const total = table.total;
    countEl.textContent = table.shown === total ? plural(total, 'router') : `${num(table.shown)} of ${num(total)}`;
  }

  function syncFilters() {
    table.setFilters(filters);
    paintChips();
    paintCount();
    saveUrl();
  }

  function saveUrl() {
    const p = new URLSearchParams();
    if (table.proto !== 'http') p.set('proto', table.proto);
    if (query) p.set('q', query);
    for (const [k, set] of Object.entries(filters)) for (const v of set) p.append(k, v);
    if (table.sort !== 'name') p.set('sort', table.sort);
    if (table.sortDir) p.set('dir', table.sortDir > 0 ? 'asc' : 'desc');
    const qs = p.toString();
    const next = `#/routers${qs ? `?${qs}` : ''}`;
    if (location.hash !== next) history.replaceState(history.state, '', next);
  }

  function setFoot(tile, ...content) {
    tile.querySelector('.stat-foot')?.remove();
    tile.append(h('div', { class: 'stat-foot' }, ...content));
  }

  function paintTiles() {
    const routers = all('routers');
    const by = (p) => routers.filter((r) => r.proto === p).length;
    tiles.total.valueEl.textContent = num(routers.length);
    setFoot(tiles.total, `${by('http')} HTTP · ${by('tcp')} TCP · ${by('udp')} UDP`);
    const ok = routers.filter((r) => r.status === 'enabled').length;
    const warn = routers.filter((r) => r.status === 'warning').length;
    const bad = routers.filter((r) => r.status === 'disabled').length;
    tiles.ok.valueEl.textContent = num(ok);
    tiles.ok.valueEl.className = 'stat-value ok-text';
    setFoot(tiles.ok, warn ? h('span', { class: 'warn-text' }, `${warn} with warnings`) : `${pct(routers.length ? ok / routers.length : 1)} of them`);
    tiles.bad.valueEl.textContent = num(bad);
    tiles.bad.valueEl.className = `stat-value ${bad ? 'bad-text' : 'muted'}`;
    tiles.bad.classList.toggle('rt-armed', filters.status.size === 1 && filters.status.has('disabled'));
    setFoot(tiles.bad, bad ? h('span', { class: 'bad-text' }, filters.status.size === 1 && filters.status.has('disabled') ? 'showing only these · click to undo' : 'click to show only these') : 'nothing broken');
    const tlsAble = routers.filter((r) => r.proto !== 'udp');
    const tls = tlsAble.filter((r) => r.tls).length;
    tiles.tls.valueEl.textContent = num(tls);
    setFoot(tiles.tls, `${pct(tlsAble.length ? tls / tlsAble.length : 0)} of HTTP and TCP`);
  }

  // a summed history for the tile, built from the per-router one
  function sumHistory() {
    const pts = [];
    for (const [k, arr] of HIST) {
      if (!k.startsWith('router:') || k === 'router:__sum') continue;
      for (const p of arr) pts.push(p);
    }
    pts.sort((a, b) => a.t - b.t);
    // points from different routers land a few ms apart: one bucket per scrape
    const out = [];
    for (const p of pts) { const last = out[out.length - 1]; if (last && p.t - last.t < 1500) last.rps += p.rps; else out.push({ t: p.t, rps: p.rps }); }
    return out.slice(-HIST_KEEP);
  }

  function paintTraffic() {
    if (metricsOff) {
      tiles.rps.valueEl.textContent = 'off';
      tiles.err.valueEl.textContent = 'off';
      setFoot(tiles.rps, 'metrics are not configured');
      return;
    }
    const latest = store.metrics?.latest ?? {};
    let rps = 0; let r5 = 0; let busiest = null;
    for (const [k, p] of Object.entries(latest)) {
      if (!k.startsWith('router:')) continue;
      rps += p.rps ?? 0; r5 += p.r5 ?? 0;
      if (!busiest || p.rps > busiest[1]) busiest = [k.slice(7), p.rps];
    }
    countTo(tiles.rps.valueEl, rps, { format: rate });
    const e = rps ? r5 / rps : 0;
    countTo(tiles.err.valueEl, e * 100, { format: (v) => `${v.toFixed(v >= 10 ? 0 : 1)}%` });
    tiles.err.valueEl.className = `stat-value ${errTone(e) ? `${errTone(e)}-text` : ''}`.trim();
    setFoot(tiles.err, '5xx, all routers');
    tiles.rps.title = busiest ? `Busiest: ${busiest[0]}` : '';
    rpsSpark.set(sumHistory().map((x) => x.rps));
  }

  paintTabs(); table.setQuery(query); table.setFilters(filters); paintChips(); paintCount(); paintTiles(); paintTraffic();
  seedHistory().then((did) => { if (did) { table.tick(); paintTraffic(); } });

  return {
    el,
    update(ev) {
      if (ev === 'metrics') { table.tick(); paintTraffic(); }
      else if (ev === 'state' || ev === 'diagnostics') { table.refresh(); paintTabs(); paintChips(); paintCount(); paintTiles(); }
    },
  };
}

// ── the request path, animated ───────────────────────────────────────────────

/** How fast the dots run for a request rate: busier is faster, within a floor and a ceiling. */
export function flowSpeed(rps) {
  if (!(rps > 0)) return { dur: 0, dots: 0 };
  const dur = Math.max(0.55, Math.min(3.4, 3.4 - Math.log10(rps + 1) * 1.35));
  return { dur: Math.round(dur * 5) / 5, dots: rps < 0.5 ? 1 : rps < 3 ? 2 : rps < 20 ? 3 : 4 };
}

function station({ kind, ic, title, sub, href, tone = '', tag, rows, cls = '' }) {
  return h(href && !rows ? 'a' : 'div', { class: `rt-st ${cls} ${tone}`.replace(/\s+/g, ' ').trim(), href: rows ? undefined : href },
    h('span', { class: 'rt-st-dot' }, icon(ic, { size: 16 })),
    h('div', { class: 'rt-st-text' },
      h('div', { class: 'rt-st-kind' }, h('span', { class: 'ellipsis' }, kind), tag ? h('span', { class: 'rt-st-tag' }, tag) : null),
      href && rows ? h('a', { class: 'rt-st-title', href, title }, title) : h('div', { class: 'rt-st-title', title }, title),
      sub ? h('div', { class: 'rt-st-sub', title: sub }, sub) : null,
      rows ? h('div', { class: 'rt-st-rows' }, ...rows) : null));
}

/**
 * The path a request takes, drawn as one line with a station per hop: entry points, every middleware in
 * order, the service and what is behind it. Dots travel the line at a speed that follows the live
 * request rate; a share of them turn red with the error rate. Returns { el, set(point), rateEl, destroy }.
 */
export function requestFlow(r, proto = 'http') {
  const st = store.state;
  const eps = epsOf(r).map((n) => st?.entrypoints?.find((e) => e.name === n) ?? { name: n, missing: true });
  const stations = [];

  const tlsOn = Boolean(r.tls) || eps.some((e) => e.http?.tls);
  stations.push(eps.length === 1 ? station({
    cls: 'k-ep', kind: 'Entry point', ic: 'entrypoint', title: eps[0].name, href: hrefFor('entrypoints', eps[0].name), tone: eps[0].missing ? 'bad' : '',
    sub: eps[0].missing ? 'does not exist' : `${eps[0].address ?? ''}${eps[0].http3 ? ' · HTTP/3' : ''}`, tag: tlsOn ? 'TLS' : null,
  }) : station({
    cls: 'k-ep', kind: 'Entry points', ic: 'entrypoint', title: `${eps.length} entry points`, tag: tlsOn ? 'TLS' : null,
    rows: eps.map((e) => h('a', { class: `rt-st-row ${e.missing ? 'bad' : ''}`.trim(), href: hrefFor('entrypoints', e.name) }, h('span', { class: 'bold' }, e.name), h('span', { class: 'muted mono' }, e.address ?? '?'))),
  }));

  // middlewares: the entry point's defaults first, then the router's own
  const epMws = [...new Set(eps.flatMap((e) => e.http?.middlewares ?? []))].map((n) => ({ name: n, ep: true }));
  const mws = [...epMws, ...(r.middlewares ?? []).map((n) => ({ name: n, ep: false }))];
  mws.forEach((m, i) => {
    const obj = find('middlewares', m.name, proto) ?? find('middlewares', qualifyName(m.name, r.provider), proto);
    const info = middlewareInfo(obj);
    stations.push(station({
      cls: 'k-mw', kind: `${i + 1} · ${info.type === 'missing' ? 'middleware' : info.label}`, ic: info.icon, title: split(m.name).base, href: hrefFor('middlewares', m.name, proto),
      sub: info.type === 'missing' ? 'does not exist' : info.summary, tone: info.type === 'missing' ? 'bad' : '', tag: m.ep ? 'entry point' : null,
    }));
  });

  const svcName = svcOf(r);
  const svc = svcName ? find('services', svcName, proto) : null;
  const internal = svcName.endsWith('@internal');
  const type = String(svc?.type ?? (svc?.loadBalancer ? 'loadbalancer' : '')).toLowerCase();
  const INTERNAL = { 'noop@internal': 'answers nothing itself', 'api@internal': 'the Traefik API', 'dashboard@internal': 'the Traefik dashboard', 'ping@internal': 'health ping', 'prometheus@internal': 'Prometheus metrics' };
  stations.push(station({
    cls: 'k-svc', kind: internal ? 'Traefik internal' : `Service${type ? ` · ${type === 'loadbalancer' ? 'balancer' : type}` : ''}`,
    ic: internal ? 'zap' : type === 'weighted' ? 'weight' : type === 'mirroring' ? 'mirror' : type === 'failover' ? 'failover' : 'service',
    title: svcName ? split(svcName).base : 'no service', href: svcName ? hrefFor('services', svcName, proto) : undefined,
    sub: !svcName ? '' : internal ? INTERNAL[svcName] ?? 'Traefik internal' : !svc ? 'does not exist' : svc.status !== 'enabled' ? svc.status : svc.loadBalancer?.sticky ? 'sticky sessions' : svc.loadBalancer?.healthCheck ? `health check ${svc.loadBalancer.healthCheck.path ?? ''}`.trim() : '',
    tone: svcName && !internal && !svc ? 'bad' : '',
  }));

  // what the service hands the request to
  const row = (href, tone, a, b) => h(href ? 'a' : 'div', { class: `rt-st-row ${tone}`.trim(), href }, a, b);
  if (svc?.loadBalancer) {
    const servers = svc.loadBalancer.servers ?? [];
    const down = servers.filter((x) => svc.serverStatus?.[x.url ?? x.address] === 'DOWN').length;
    stations.push(station({
      cls: 'k-srv', kind: down ? `${down} of ${servers.length} down` : 'Servers', ic: 'server', title: plural(servers.length, 'server'), tone: servers.length && down === servers.length ? 'bad' : down ? 'warn' : 'ok',
      rows: servers.map((x) => {
        const url = x.url ?? x.address ?? '';
        const s0 = svc.serverStatus?.[url];
        return row(null, s0 === 'DOWN' ? 'bad' : '', h('span', { class: `dot ${s0 === 'DOWN' ? 'bad' : s0 === 'UP' ? 'ok' : ''}`.trim() }), h('span', { class: 'mono ellipsis', title: url }, url.replace(/^[a-z]+:\/\//, '')));
      }),
    }));
  } else if (svc?.weighted) {
    const parts = svc.weighted.services ?? [];
    const total = parts.reduce((a, p) => a + Number(p.weight ?? 1), 0) || 1;
    stations.push(station({ cls: 'k-srv', kind: 'Split by weight', ic: 'weight', title: plural(parts.length, 'service'), rows: parts.map((p) => row(hrefFor('services', qualifyName(p.name, svc.provider), proto), '', h('span', { class: 'bold tnum' }, `${Math.round((Number(p.weight ?? 1) / total) * 100)}%`), h('span', { class: 'ellipsis' }, p.name))) }));
  } else if (svc?.failover) {
    stations.push(station({ cls: 'k-srv', kind: 'Failover', ic: 'failover', title: split(svc.failover.service ?? '').base, rows: [
      row(hrefFor('services', qualifyName(svc.failover.service, svc.provider), proto), '', h('span', { class: 'muted' }, 'main'), h('span', { class: 'ellipsis' }, svc.failover.service)),
      row(hrefFor('services', qualifyName(svc.failover.fallback, svc.provider), proto), '', h('span', { class: 'muted' }, 'fallback'), h('span', { class: 'ellipsis' }, svc.failover.fallback)),
    ] }));
  } else if (svc?.mirroring) {
    stations.push(station({ cls: 'k-srv', kind: 'Mirroring', ic: 'mirror', title: split(svc.mirroring.service ?? '').base, rows: [
      row(hrefFor('services', qualifyName(svc.mirroring.service, svc.provider), proto), '', h('span', { class: 'muted' }, 'answers'), h('span', { class: 'ellipsis' }, svc.mirroring.service)),
      ...(svc.mirroring.mirrors ?? []).map((m) => row(hrefFor('services', qualifyName(m.name, svc.provider), proto), '', h('span', { class: 'muted tnum' }, `${m.percent ?? 0}%`), h('span', { class: 'ellipsis' }, m.name))),
    ] }));
  }

  const broken = r.status === 'disabled';
  const track = h('div', { class: 'rt-track', 'aria-hidden': 'true' });
  const flowEl = h('div', { class: 'rt-flow', style: { '--n': String(stations.length) }, role: 'img', 'aria-label': `Requests go from ${eps.map((e) => e.name).join(', ')} through ${plural(mws.length, 'middleware')} to ${svcName || 'no service'}` }, track, ...stations);
  const rateEl = h('span', { class: 'rt-flow-rate' });
  const el = h('div', { class: `rt-flow-wrap ${broken ? 'broken' : ''}`.trim() }, flowEl);

  // the track runs from the centre of the first station's circle to the last one's
  function layout() {
    const dots = flowEl.querySelectorAll('.rt-st-dot');
    if (dots.length < 2 || !flowEl.isConnected) return;
    const box = flowEl.getBoundingClientRect();
    const a = dots[0].getBoundingClientRect();
    const b = dots[dots.length - 1].getBoundingClientRect();
    const ax = a.left + a.width / 2 - box.left; const ay = a.top + a.height / 2 - box.top;
    const bx = b.left + b.width / 2 - box.left; const by = b.top + b.height / 2 - box.top;
    const vertical = Math.abs(by - ay) > Math.abs(bx - ax);
    el.classList.toggle('vertical', vertical);
    Object.assign(track.style, vertical
      ? { left: `${ax - 1}px`, top: `${ay}px`, width: '2px', height: `${Math.max(0, by - ay)}px` }
      : { left: `${ax}px`, top: `${ay - 1}px`, width: `${Math.max(0, bx - ax)}px`, height: '2px' });
  }
  const ro = new ResizeObserver(() => requestAnimationFrame(layout));
  ro.observe(flowEl);

  const hops = Math.max(1, stations.length - 1);
  let shown = { dur: -1, dots: -1, bad: -1 };
  function set(point) {
    if (broken) {
      rateEl.replaceChildren(h('span', { class: 'rt-flow-live bad' }, icon('xcircle', { size: 13 }), 'not loaded, nothing reaches it'));
      el.classList.add('idle');
      return;
    }
    const rps = point?.rps ?? 0;
    const sp = flowSpeed(rps);
    const n = sp.dots ? Math.min(14, Math.max(2, Math.round(sp.dots * hops / 1.6))) : 0;
    const bad = n ? Math.min(n, Math.round(n * Math.min(1, (point?.errorRate ?? 0) * 1.5))) : 0;
    rateEl.replaceChildren(point
      ? h('span', { class: 'rt-flow-live' }, h('span', { class: `dot ${rps > 0 ? 'ok pulse' : ''}`.trim() }), h('b', { class: 'tnum' }, rate(rps)), ' req/s', point.errorRate > 0.01 ? h('span', { class: `${errTone(point.errorRate)}-text` }, ` · ${pct(point.errorRate)} 5xx`) : null)
      : h('span', { class: 'rt-flow-live' }, h('span', { class: 'dot' }), proto === 'http' ? (store.meta?.features?.metrics === false ? 'metrics off' : 'idle') : 'no per-router metrics for TCP and UDP'));
    if (sp.dur === shown.dur && n === shown.dots && bad === shown.bad) return;
    // the line is long: keep the dots' speed per hop, not per line
    el.style.setProperty('--rt-dur', `${((sp.dur || 2) * hops * 0.55).toFixed(2)}s`);
    el.classList.toggle('idle', !n);
    if (n !== shown.dots || bad !== shown.bad) {
      // spread the red ones out instead of bunching them
      const red = new Set(Array.from({ length: bad }, (_, i) => Math.floor(((i + 0.5) * n) / bad)));
      track.replaceChildren(...Array.from({ length: n }, (_, k) => h('span', { class: `rt-lane ${red.has(k) ? 'bad' : ''}`.trim(), style: { '--k': String(k / n) } })));
    }
    shown = { dur: sp.dur, dots: n, bad };
  }
  set(null);
  requestAnimationFrame(layout);
  return { el, set, rateEl, destroy: () => ro.disconnect() };
}


// ── detail page ──────────────────────────────────────────────────────────────

const CLASS_KEYS = [['r2', '2xx', '--c2xx'], ['r3', '3xx', '--c3xx'], ['r4', '4xx', '--c4xx'], ['r5', '5xx', '--c5xx']];
export const codeTone = (c) => (c >= 500 ? 'bad' : c >= 400 ? 'warn' : c >= 300 ? 'info' : c >= 200 ? 'ok' : '');

/** Which certificate a host gets, from what Traefik reports in its metrics. */
function certFor(host, certs) {
  const hst = host.toLowerCase();
  return certs.find((c) => [c.cn, ...(c.sans ?? [])].filter(Boolean).some((n) => {
    const x = n.toLowerCase();
    return x === hst || (x.startsWith('*.') && hst.endsWith(x.slice(1)) && hst.split('.').length === x.split('.').length);
  })) ?? null;
}

/** Status codes as a donut and bars, and methods as bars, from a totals entry. */
export function paintCodeTotals(t, codesBox, methodsBox) {
  if (!t || !t.requests) {
    codesBox.replaceChildren(empty('No requests yet', 'Codes appear after the first request.', 'activity'));
    methodsBox?.replaceChildren(empty('No requests yet', '', 'code'));
    return;
  }
  const codes = Object.entries(t.codes ?? {}).map(([c, n]) => [Number(c), n]).sort((a, b) => b[1] - a[1]);
  const parts = CLASS_KEYS.map(([, l, v]) => ({ label: l, value: t.classes?.[l] ?? 0, color: cssVar(v) }));
  codesBox.replaceChildren(
    h('div', { class: 'rt-codes' },
      donut(parts, { size: 124, thickness: 14, center: pct((t.classes?.['2xx'] ?? 0) / t.requests), sub: '2xx' }),
      h('div', { class: 'rt-code-list grow' }, ...codes.slice(0, 7).map(([c, n]) => h('div', { class: 'rt-code-row' },
        h('span', { class: `rt-code ${codeTone(c)}` }, String(c)),
        h('div', { class: 'bar grow' }, h('span', { style: { width: `${Math.max(2, (n / codes[0][1]) * 100)}%`, background: `var(--${codeTone(c) || 'muted'})` } })),
        h('span', { class: 'tnum small rt-code-n' }, num(n)))))));
  methodsBox?.replaceChildren(bars(Object.entries(t.methods ?? {}).sort((a, b) => b[1] - a[1]).map(([m, n]) => ({ label: m, value: n, sub: `· ${pct(n / t.requests)}`, color: 'var(--violet)' })), { format: (v) => num(v) }));
}

export { CLASS_KEYS, cssVar };

/**
 * Live tiles and charts for one metrics key ('router:NAME' or 'ep:NAME'): requests by status, latency,
 * status codes and methods. conns() puts open connections in place of p50 (entry points).
 * Returns { tilesEl, chartEls, start(), tick(metrics), paint(), destroy() }.
 */
export function liveTraffic(key, { conns = null } = {}) {
  let minutes = 15;
  let points = [];
  let destroyed = false;
  let totalsKey = '';
  const tiles = {
    rps: stat({ label: 'Requests / second', icon: 'zap', value: '—' }),
    err: stat({ label: 'Server errors (5xx)', icon: 'alert', value: '—' }),
    p95: stat({ label: 'Latency p95', icon: 'clock', value: '—' }),
    mid: stat({ label: conns ? 'Open connections' : 'Latency p50', icon: conns ? 'activity' : 'clock', value: '—' }),
    out: stat({ label: 'Bandwidth out', icon: 'download', value: '—' }),
    total: stat({ label: 'Requests since start', icon: 'layers', value: '—' }),
  };
  const sparks = {};
  for (const [k, tone] of [['rps', ''], ['err', 'bad'], ['p95', 'violet'], ['out', 'sky']]) {
    sparks[k] = miniSpark(240, 46);
    sparks[k].dataset.extra = `spark ${tone ? `t-${tone}` : ''}`;
    sparks[k].set([]);
    tiles[k].append(sparks[k]);
  }
  const tilesEl = stagger(h('div', { class: 'grid g6' }, ...Object.values(tiles)));

  const statusChart = timeChart([], { height: 230, stacked: true, yFormat: (v) => rate(v) });
  const latChart = timeChart([], { height: 230, yFormat: (v) => ms(v) });
  const codesBox = h('div', { class: 'col', style: { gap: '14px' } });
  const methodsBox = h('div');
  const range = segmented([[5, '5m'], [15, '15m'], [60, '1h']], minutes, (v) => { minutes = v; load(); });
  const chartEls = [
    stagger(h('div', { class: 'grid g3' },
      h('div', { class: 'span2' }, card({ title: 'Requests by status', icon: 'traffic', sub: 'Per second, stacked', tools: [range] }, statusChart.el, h('div', { class: 'legend mt-sm' }, ...CLASS_KEYS.map(([, l, v]) => h('span', {}, h('i', { style: { background: `var(${v})` } }), l))))),
      card({ title: 'Status codes', icon: 'activity', sub: 'Since Traefik started' }, codesBox))),
    stagger(h('div', { class: 'grid g3' },
      h('div', { class: 'span2' }, card({ title: 'Latency', icon: 'clock', sub: 'How long requests take, by percentile' }, latChart.el, h('div', { class: 'legend mt-sm' }, h('span', {}, h('i', { style: { background: 'var(--ok)' } }), 'p50'), h('span', {}, h('i', { style: { background: 'var(--torch)' } }), 'p95'), h('span', {}, h('i', { style: { background: 'var(--bad)' } }), 'p99')))),
      card({ title: 'Methods', icon: 'code', sub: 'Since Traefik started' }, methodsBox))),
  ];

  function paintTiles() {
    const p = store.metrics?.latest?.[key];
    const last = points.slice(-60);
    if (p) {
      countTo(tiles.rps.valueEl, p.rps, { format: rate });
      countTo(tiles.err.valueEl, p.errorRate * 100, { format: (v) => `${v.toFixed(v >= 10 ? 0 : 1)}%` });
      tiles.err.valueEl.className = `stat-value ${errTone(p.errorRate) ? `${errTone(p.errorRate)}-text` : ''}`.trim();
      countTo(tiles.p95.valueEl, p.p95 ?? 0, { format: ms });
      if (!conns) countTo(tiles.mid.valueEl, p.p50 ?? 0, { format: ms });
      countTo(tiles.out.valueEl, p.outBps ?? 0, { format: (v) => bytes(v, true) });
    } else for (const k of ['rps', 'err', 'p95', 'out', ...(conns ? [] : ['mid'])]) tiles[k].valueEl.textContent = '—';
    if (conns) countTo(tiles.mid.valueEl, conns() ?? 0, { format: (v) => num(Math.round(v)) });
    sparks.rps.set(last.map((x) => x.rps));
    sparks.err.set(last.map((x) => x.r5));
    sparks.p95.set(last.map((x) => x.p95 ?? 0));
    sparks.out.set(last.map((x) => x.outBps ?? 0));
    const t = store.metrics?.totals?.[key];
    tiles.total.valueEl.textContent = t ? num(t.requests) : '—';
    tiles.total.querySelector('.stat-foot')?.remove();
    if (t) tiles.total.append(h('div', { class: 'stat-foot' }, `${bytes(t.bytesOut)} sent · avg ${ms(t.avg)}`));
  }

  function paintCharts() {
    statusChart.update(CLASS_KEYS.map(([k, l, v]) => ({ key: k, label: l, color: cssVar(v), values: points.map((p) => ({ t: p.t, v: p[k] })) })));
    latChart.update([['p50', '--ok'], ['p95', '--torch'], ['p99', '--bad']].map(([k, v]) => ({ key: k, label: k, color: cssVar(v), values: points.map((p) => ({ t: p.t, v: p[k] ?? null })) })));
  }

  function paintTotals() {
    const t = store.metrics?.totals?.[key];
    const k = JSON.stringify(t ?? null);
    if (k === totalsKey) return;
    totalsKey = k;
    paintCodeTotals(t, codesBox, methodsBox);
  }

  async function load() {
    try {
      const res = await api(`series?keys=${encodeURIComponent(key)}&minutes=${minutes}`);
      if (destroyed) return;
      points = res.series?.[key] ?? [];
      paintCharts(); paintTiles();
    } catch { /* the next tick fills in */ }
  }

  return {
    tilesEl, chartEls,
    start() { paintTiles(); paintTotals(); load(); },
    tick(m) {
      const p = m?.latest?.[key];
      if (p && (!points.length || p.t > points[points.length - 1].t)) {
        points.push(p);
        const since = Date.now() - minutes * 60_000;
        while (points.length && points[0].t < since) points.shift();
      }
      paintTiles(); paintCharts(); paintTotals();
    },
    paint: paintCharts,
    destroy() { destroyed = true; statusChart.destroy(); latChart.destroy(); },
  };
}

function renderDetail(ctx, proto, name, rebuild) {
  const { base, provider } = split(name);
  ctx.setCrumbs([['Routers', '#/routers'], [base]]);
  const el = h('div', { class: 'col gap-lg rt-page' });
  const metricsWanted = store.meta?.features?.metrics !== false && proto === 'http';
  let metricsOn = metricsWanted;
  let destroyed = false;
  const cleanups = [];

  const found = find('routers', name, proto);
  if (!found) {
    el.append(store.state
      ? h('div', { class: 'card' }, empty('This router does not exist (any more)', `Traefik reports no ${proto.toUpperCase()} router called ${name}.`, 'router'), h('div', { class: 'row', style: { justifyContent: 'center', paddingBottom: '24px' } }, h('a', { class: 'btn', href: '#/routers' }, icon('router', { size: 15 }), 'All routers')))
      : card({}, skeleton(6, 18)));
    return { el, update(ev) { if (ev === 'state' && find('routers', name, proto)) rebuild(); } };
  }
  const r = { ...found, proto };
  const fp = JSON.stringify(found);
  // a router Traefik never loaded has no traffic to chart
  if (found.status === 'disabled' && !liveOf(name)) metricsOn = false;

  // ── hero ──
  const pr = proto === 'tcp' ? 'tcp' : 'http';
  const syntax = syntaxOf(r, store.state?.static);
  const prio = priorityOf(r);
  const ownPrio = Number(r.priority) && String(r.rule ?? '').length !== Number(r.priority);
  const words = r.rule ? explainRule(r.rule, { syntax, proto: pr }) : '';
  const conds = r.rule ? ruleConditions(r.rule, { syntax, proto: pr }) : { all: [], error: null };
  const hero = h('section', { class: `card glow rt-hero ${r.status === 'disabled' ? 'broken' : ''}`.trim() },
    h('div', { class: 'rt-hero-top' },
      h('div', { class: 'rt-hero-ic' }, icon(proto === 'http' ? 'router' : proto, { size: 26 })),
      h('div', { class: 'grow col', style: { gap: '8px', minWidth: '0' } },
        h('div', { class: 'rt-hero-name' }, h('h1', {}, base), provider ? h('span', { class: 'rt-hero-prov' }, `@${provider}`) : null, copyButton(name, 'Copy the name')),
        h('div', { class: 'row wrap rt-facts' },
          statusBadge(r.status), providerBadge(provider || 'unknown'), badge(proto.toUpperCase(), 'violet'),
          r.tls ? h('span', { class: 'badge torch' }, icon('lock', { size: 11 }), r.tls.passthrough ? 'TLS passthrough' : r.tls.certResolver ? `TLS · ${r.tls.certResolver}` : 'TLS') : null,
          proto !== 'udp' ? h('span', { class: 'badge mono', title: ownPrio ? 'Set explicitly' : 'Traefik uses the rule length when no priority is set' }, `priority ${fmtPriority(prio)}${ownPrio || prio >= MAX_PRIORITY ? '' : ' · rule length'}`) : null,
          syntax === 'v2' ? badge('v2 rule syntax', 'warn') : null)),
      h('div', { class: 'row wrap rt-hero-actions' },
        proto !== 'udp' ? h('a', { class: 'btn primary', href: testerHref(r) }, icon('tester', { size: 15 }), 'Test it') : null,
        h('button', { class: 'btn', type: 'button', onclick: () => el.querySelector('#rt-raw')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, icon('code', { size: 15 }), 'JSON'))),
    h('div', { class: 'rt-hero-rule' },
      h('div', { class: 'rt-rule-box' }, r.rule ? ruleView(r.rule, { cls: 'rt-rule-big' }) : h('span', { class: 'muted' }, proto === 'udp' ? 'UDP routers have no rule: they take every datagram on their entry points.' : 'No rule: catches everything on its entry points.'), r.rule ? copyButton(r.rule, 'Copy the rule') : null),
      words ? h('div', { class: 'rt-words' }, icon('info', { size: 15 }),
        conds.all.length > 1
          ? h('div', {}, h('span', {}, 'Matches when all of these hold:'), h('ul', {}, ...conds.all.map((c) => h('li', {}, c))))
          : h('div', {}, 'Matches when ', h('b', {}, words.charAt(0).toLowerCase() + words.slice(1)), '.'))
        : conds.error ? h('div', { class: 'rt-words bad' }, icon('xcircle', { size: 15 }), h('div', {}, `The rule does not parse: ${conds.error.message}`)) : null));
  el.append(hero);
  if (r.error?.length) el.append(banner(r.status === 'disabled' ? 'bad' : 'warn', r.status === 'disabled' ? 'Traefik does not serve this router' : 'Traefik reports a problem with this router', r.error.join(' · ')));

  const traffic = metricsOn ? liveTraffic(`router:${name}`) : null;
  if (traffic) el.append(traffic.tilesEl);

  // ── request path ──
  const flow = requestFlow(r, proto);
  el.append(card({ title: proto === 'http' ? 'Request path' : 'Connection path', icon: 'topology', sub: proto === 'http' ? 'What a request goes through on its way to a server. The dots move with the live request rate.' : 'Where a connection goes once this router takes it.', tools: [flow.rateEl], cls: 'rt-flow-card' }, flow.el));

  cleanups.push(() => flow.destroy());
  if (traffic) { el.append(...traffic.chartEls); cleanups.push(() => traffic.destroy()); }
  else if (proto === 'http' && !metricsWanted) el.append(banner('info', 'Live traffic is off', 'Set TRAEFIK_METRICS_URL to Traefik\'s Prometheus endpoint (with addRoutersLabels) to see this router\'s requests, errors and latency.'));

  // ── details, TLS, findings ──
  const findingsBox = h('div', { class: 'col', style: { gap: '8px' } });
  const tlsBox = h('div', { class: 'col', style: { gap: '12px' } });
  const svcName = svcOf(r);
  el.append(stagger(h('div', { class: 'grid g3' },
    card({ title: 'Details', icon: 'info' }, kv([
      ['Name', h('span', { class: 'mono small' }, name)],
      ['Status', statusBadge(r.status)],
      ['Entry points', h('div', { class: 'chips' }, ...epsOf(r).map((e) => h('a', { class: 'chip', href: hrefFor('entrypoints', e) }, icon('entrypoint', { size: 12 }), e)))],
      proto !== 'udp' ? ['Middlewares', (r.middlewares ?? []).length ? h('div', { class: 'chips' }, ...(r.middlewares ?? []).map((m, i) => h('a', { class: `chip ${find('middlewares', m, proto) ? '' : 'rt-chip-bad'}`.trim(), href: hrefFor('middlewares', m, proto) }, h('span', { class: 'faint tiny' }, String(i + 1)), split(m).base))) : h('span', { class: 'faint' }, 'none')] : null,
      ['Service', svcName ? h('a', { class: 'chip', href: hrefFor('services', svcName, proto) }, icon('service', { size: 12 }), svcName) : null],
      proto !== 'udp' ? ['Priority', h('span', {}, h('b', { class: 'tnum' }, fmtPriority(prio)), h('span', { class: 'muted small' }, prio >= MAX_PRIORITY ? ' · the highest, internal' : prio < 0 ? ' · below any rule length, tried last' : ownPrio ? ' · set explicitly' : ` · rule length, ${String(r.rule ?? '').length} characters`))] : null,
      proto !== 'udp' ? ['Rule syntax', h('span', {}, syntax, r.ruleSyntax && r.ruleSyntax !== syntax ? h('span', { class: 'muted small' }, ` (${r.ruleSyntax})`) : null)] : null,
      r.observability ? ['Observability', h('div', { class: 'chips' }, ...['accessLogs', 'metrics', 'tracing'].map((k) => h('span', { class: 'chip' }, icon(r.observability[k] === false ? 'x' : 'check', { size: 12, cls: r.observability[k] === false ? 'muted' : 'ok-text' }), k === 'accessLogs' ? 'access log' : k)))] : null,
    ])),
    card({ title: 'TLS', icon: 'lock' }, tlsBox),
    card({ title: 'Health', icon: 'health', tools: [h('a', { class: 'btn sm ghost', href: `#/health?q=${encodeURIComponent(base)}` }, 'Checks', icon('chevron', { size: 14 }))] }, findingsBox))));

  // ── access log ──
  const logsOn = store.meta?.features?.logs !== false && proto === 'http';
  const logBody = h('tbody');
  const logBox = h('div', { class: 'rt-logbox' }, skeleton(5, 16));
  if (proto === 'http') {
    el.append(card({ title: 'Recent requests', icon: 'logs', sub: logsOn ? 'From the access log, newest first, live' : '', tools: logsOn ? [h('a', { class: 'btn sm ghost', href: '#/logs' }, 'Access log', icon('chevron', { size: 14 }))] : [], flush: true }, logBox));
  }

  // ── raw ──
  const rawBox = h('div', {}, skeleton(6, 14));
  let rawJson = null;
  el.append(card({ title: 'Raw JSON', icon: 'code', sub: `GET /api/${proto}/routers/${name}`, id: 'rt-raw', tools: [h('a', { class: 'btn sm ghost', href: `#/explorer?path=${encodeURIComponent(`/api/${proto}/routers/${name}`)}` }, 'API explorer', icon('chevron', { size: 14 })), copyButton(() => JSON.stringify(rawJson ?? found, null, 2), 'Copy JSON')] }, rawBox));

  // ── painters ──
  function paintFindings() {
    const f = findingsFor('router', name).concat(svcName ? findingsFor('service', svcName) : []);
    if (!f.length) {
      findingsBox.replaceChildren(h('div', { class: 'rt-allgood' }, h('span', { class: 'rt-allgood-ic ok' }, icon('ok', { size: 20 })), h('div', {}, h('div', { class: 'bold' }, 'Nothing to fix'), h('div', { class: 'small muted' }, 'No check fails for this router or its service.'))));
      return;
    }
    const rank = { critical: 0, warning: 1, info: 2 };
    findingsBox.replaceChildren(...f.sort((a, b) => rank[a.severity] - rank[b.severity]).map((x) => h('div', { class: `rt-finding ${x.severity}` },
      icon(x.severity === 'critical' ? 'xcircle' : x.severity === 'warning' ? 'alert' : 'info', { size: 16 }),
      h('div', { class: 'grow col', style: { gap: '2px' } }, h('span', { class: 'bold small' }, x.title), x.detail ? h('span', { class: 'tiny muted' }, x.detail) : null, x.fix ? h('span', { class: 'tiny' }, h('span', { class: 'torch-text' }, 'Fix: '), x.fix) : null))));
  }

  async function paintTLS() {
    const t = r.tls;
    if (proto === 'udp') { tlsBox.replaceChildren(h('div', { class: 'rt-allgood' }, h('span', { class: 'rt-allgood-ic' }, icon('udp', { size: 20 })), h('div', {}, h('div', { class: 'bold' }, 'No TLS for UDP'), h('div', { class: 'small muted' }, 'Datagrams pass through as they come.')))); return; }
    if (!t) {
      tlsBox.replaceChildren(h('div', { class: 'rt-allgood' }, h('span', { class: 'rt-allgood-ic' }, icon('unlock', { size: 20 })), h('div', {}, h('div', { class: 'bold' }, proto === 'tcp' ? 'Plain TCP' : 'Plain HTTP'), h('div', { class: 'small muted' }, proto === 'tcp' ? 'No tls section: Traefik passes bytes through as they come.' : 'No tls section: this router only answers requests without TLS.'))));
      return;
    }
    const resolvers = store.state?.static?.certificatesResolvers;
    const known = !t.certResolver || !store.state?.static || Boolean(resolvers && Object.prototype.hasOwnProperty.call(resolvers, t.certResolver));
    const domains = (t.domains ?? []).flatMap((d) => [d.main, ...(d.sans ?? [])]).filter(Boolean);
    const hosts = [...new Set([...domains, ...[...(r.rule ?? '').matchAll(/Host(?:SNI)?\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/[`"]([^`"]*)[`"]/g)].map((x) => x[1]))])].filter((x) => x && x !== '*');
    tlsBox.replaceChildren(kv([
      t.passthrough !== undefined ? ['Passthrough', t.passthrough ? h('span', {}, 'yes', h('span', { class: 'muted small' }, ', Traefik does not decrypt')) : 'no'] : null,
      ['Options', h('span', { class: 'mono small' }, t.options || 'default')],
      ['Resolver', t.certResolver ? h('span', { class: known ? '' : 'warn-text' }, t.certResolver, known ? '' : ' · not in the static config') : h('span', { class: 'muted' }, 'none, a stored or the default certificate')],
      domains.length ? ['Domains', h('div', { class: 'chips' }, ...domains.map((d) => h('span', { class: 'chip mono' }, d)))] : null,
    ]), hosts.length ? h('div', { class: 'col', style: { gap: '6px' } }, h('div', { class: 'rt-label' }, 'Certificate per host'), ...hosts.slice(0, 6).map((host) => h('div', { class: 'rt-cert', dataset: { host } }, icon('cert', { size: 14, cls: 'muted' }), h('span', { class: 'mono small grow ellipsis' }, host), h('span', { class: 'small muted' }, '…')))) : null);
    let certs = [];
    try { certs = (await api('metrics')).certs ?? []; } catch { /* metrics off */ }
    if (destroyed) return;
    for (const row of tlsBox.querySelectorAll('.rt-cert')) {
      const c = certFor(row.dataset.host, certs);
      const out = row.lastChild;
      if (!c) { out.replaceChildren(h('span', { class: 'muted' }, certs.length ? 'default certificate' : 'unknown')); continue; }
      const days = Math.floor((Date.parse(c.notAfter) - Date.now()) / 86_400_000);
      const tone = days < (store.meta?.certCriticalDays ?? 7) ? 'bad' : days < (store.meta?.certWarnDays ?? 21) ? 'warn' : 'ok';
      out.replaceChildren(h('a', { class: `${tone}-text`, href: '#/certificates', title: `${c.cn} · expires ${new Date(c.notAfter).toLocaleDateString()}` }, days < 0 ? 'expired' : `${days} days left`));
    }
  }

  const logRow = (e, fresh = false) => h('tr', { class: fresh ? 'rt-fresh' : '' },
    h('td', { class: 'tight muted tnum small rt-hide-sm' }, time(e.t)),
    h('td', { class: 'tight' }, h('span', { class: `rt-code ${codeTone(e.status)}` }, String(e.status))),
    h('td', { class: 'tight mono small' }, e.method),
    h('td', { class: 'rt-log-path' }, h('div', { class: 'ellipsis mono small', title: `${e.host}${e.path}` }, h('span', { class: 'muted' }, e.host), e.path)),
    h('td', { class: 'tight mono small muted rt-hide-sm' }, e.client ?? ''),
    h('td', { class: 'num small' }, h('span', { class: e.durationMs > 1000 ? 'warn-text' : '' }, ms(e.durationMs))),
    h('td', { class: 'num muted small rt-hide-sm' }, bytes(e.size)),
    h('td', { class: 'tight mono tiny muted rt-hide-md' }, (e.server ?? '').replace(/^https?:\/\//, '')));

  async function loadLogs() {
    if (proto !== 'http') return;
    if (!logsOn) { logBox.replaceChildren(empty('The access log is off', 'Point Enodia at Traefik\'s access log (JSON format) to see each request this router handled.', 'logs')); return; }
    try {
      const res = await api(`logs?router=${encodeURIComponent(name)}&limit=30`);
      if (destroyed) return;
      if (!res.enabled) { logBox.replaceChildren(empty('The access log is off', '', 'logs')); return; }
      if (!res.entries.length) { logBox.replaceChildren(empty('No requests logged yet', 'They show up here live.', 'logs')); return; }
      logBody.replaceChildren(...res.entries.map((e) => logRow(e)));
      logBox.replaceChildren(h('div', { class: 'table-wrap rt-logs-wrap' }, h('table', { class: 'table rt-logs' },
        h('thead', {}, h('tr', {}, ...['Time', 'Status', 'Method', 'Request', 'Client', 'Duration', 'Size', 'Server'].map((x, i) => h('th', { class: [i === 5 || i === 6 ? 'num' : '', i === 0 || i === 4 || i === 6 ? 'rt-hide-sm' : '', i === 7 ? 'rt-hide-md' : ''].join(' ').trim() }, x)))),
        logBody)));
    } catch (e) { logBox.replaceChildren(empty('Could not read the access log', e.message, 'alert')); }
  }

  async function loadRaw() {
    try {
      rawJson = await api(`raw?path=${encodeURIComponent(`/api/${proto}/routers/${name}`)}`);
      if (!destroyed) rawBox.replaceChildren(jsonView(rawJson));
    } catch (e) { if (!destroyed) rawBox.replaceChildren(jsonView(found), h('div', { class: 'tiny muted mt-sm' }, `Enodia's copy (the live API said: ${e.message})`)); }
  }

  traffic?.start(); paintFindings(); paintTLS(); loadLogs(); loadRaw();
  flow.set(store.metrics?.latest?.[`router:${name}`] ?? null);

  return {
    el,
    update(ev, data) {
      if (ev === 'metrics') {
        traffic?.tick(data);
        const p = data?.latest?.[`router:${name}`];
        flow.set(p ?? null);
      } else if (ev === 'logs' && logsOn) {
        const mine = (data ?? []).filter((e) => e.router === name);
        if (!mine.length) return;
        if (!logBody.isConnected) { loadLogs(); return; }
        logBody.prepend(...mine.reverse().slice(0, 30).map((e) => logRow(e, true)));
        while (logBody.children.length > 30) logBody.lastChild.remove();
      } else if (ev === 'state') {
        const next = find('routers', name, proto);
        if (!next || JSON.stringify(next) !== fp) rebuild();
      } else if (ev === 'diagnostics') paintFindings();
      else if (ev === 'theme') traffic?.paint();
    },
    destroy() { destroyed = true; for (const c of cleanups) c(); },
  };
}

export default {
  render(ctx) {
    const [proto, name] = ctx.params;
    return rebuildable((rebuild) => (name ? renderDetail(ctx, proto, name, rebuild) : renderList(ctx, rebuild)));
  },
};
