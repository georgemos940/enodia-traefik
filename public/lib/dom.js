// Building DOM without a framework. h('div', { class: 'x', onclick }, ...children). Styles are set
// through the CSSOM (style: { width: '10px', '--i': 2 }): the CSP allows no inline style attributes.

const SVG_NS = 'http://www.w3.org/2000/svg';

// el.append(cond ? node : null) would print the word "null". Everywhere in the app an empty child is
// skipped, the same as in h(), so a conditional child never needs a filter.
const isChild = (x) => x !== null && x !== undefined && x !== false && x !== true;
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const m of ['append', 'prepend', 'replaceChildren']) {
    const native = proto[m];
    proto[m] = function (...nodes) { return native.apply(this, nodes.flat(Infinity).filter(isChild)); };
  }
}

function apply(el, attrs) {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'style') {
      for (const [p, val] of Object.entries(v)) {
        if (val === undefined || val === null) continue;
        el.style.setProperty(p.startsWith('--') ? p : p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), String(val));
      }
    } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'ref' && typeof v === 'function') v(el);
    else if (k === 'html') el.innerHTML = v; // only for trusted, static markup (icons)
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function h(tag, attrs, ...children) {
  if (attrs instanceof Node || typeof attrs !== 'object' || Array.isArray(attrs) || attrs === null) {
    children.unshift(attrs);
    attrs = {};
  }
  const el = document.createElement(tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, String(val));
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clear = (el) => { el.replaceChildren(); return el; };

/** Replace an element's contents, keeping the scroll position. */
export function swap(el, ...children) {
  const top = el.scrollTop;
  el.replaceChildren();
  append(el, children);
  el.scrollTop = top;
  return el;
}

/** Give children a --i so .stagger animates them in one after another. */
export function stagger(el) {
  [...el.children].forEach((c, i) => c.style.setProperty('--i', String(Math.min(i, 14))));
  el.classList.add('stagger');
  return el;
}

// ── icons (Lucide shapes, MIT) ───────────────────────────────────────────────

const P = {
  overview: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  router: 'M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  service: 'M4 6a8 3 0 1 0 16 0a8 3 0 1 0-16 0M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  middleware: 'M3 6h18M7 12h10M10 18h4',
  entrypoint: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
  topology: 'M5 5m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M19 5m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M12 19m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M6.7 6.5 10.5 17M17.3 6.5 13.5 17M7 5h10',
  traffic: 'M3 3v18h18M7 15l4-4 3 3 6-7',
  logs: 'M4 6h16M4 12h16M4 18h10',
  cert: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  health: 'M22 12h-4l-3 9L9 3l-3 9H2',
  history: 'M3 3v5h5M3.05 13A9 9 0 1 0 6 5.3L3 8M12 7v5l4 2',
  tester: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3',
  config: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4',
  moon: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  xcircle: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM15 9l-6 6M9 9l6 6',
  ok: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3',
  copy: 'M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  chevron: 'M9 18l6-6-6-6',
  down: 'M6 9l6 6 6-6',
  up: 'M18 15l-6-6-6 6',
  arrow: 'M5 12h14M12 5l7 7-7 7',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.9-1',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  server: 'M3 4h18v6H3zM3 14h18v6H3zM7 7h.01M7 17h.01',
  filter: 'M22 3H2l8 9.5V19l4 2v-8.5z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  play: 'M6 3l14 9-14 9z',
  refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  layers: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zM15.5 7.5l3 3L22 7l-3-3',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  cpu: 'M4 4h16v16H4zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  github: 'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.1-1.3-.4-2.6-1.3-3.5.2-1.3.2-2.6-.4-3.8 0 0-1 0-3.5 1.5-2.2-.6-4.6-.6-6.8 0C6 1.6 5 1.6 5 1.6c-.6 1.2-.6 2.5-.4 3.8C3.7 6.3 3.2 7.6 3.3 9c0 3.5 3 5.5 6 5.5-.4.5-.8 1.2-1 2M9 18c-4.5 2-5-2-7-2',
  weight: 'M12 5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6.5 8h11l3 13h-17z',
  mirror: 'M12 3v18M5 7l-3 5 3 5M19 7l3 5-3 5',
  failover: 'M16 3h5v5M21 3l-7 7M8 21H3v-5M3 21l7-7',
  tcp: 'M7 7h10v10H7zM3 12h4M17 12h4M12 3v4M12 17v4',
  udp: 'M2 12h4l3-8 6 16 3-8h4',
};

export function icon(name, { size = 16, cls = '', stroke = 1.8 } = {}) {
  const d = P[name] ?? P.info;
  return s('svg', { class: `icon ${cls}`.trim(), width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': stroke, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    ...d.split(/(?=M)/).map((seg) => s('path', { d: seg })));
}
export const ICONS = Object.keys(P);

/** The Enodia mark: a crossroads under two torches. */
export function brandMark(cls = 'brand-mark') {
  return s('svg', { class: cls, viewBox: '0 0 48 48', fill: 'none', 'aria-hidden': 'true' },
    s('defs', {},
      s('linearGradient', { id: 'eg-flame', x1: '0', y1: '0', x2: '0', y2: '1' }, s('stop', { offset: '0', 'stop-color': '#ffd479' }), s('stop', { offset: '1', 'stop-color': '#f57b24' })),
      s('linearGradient', { id: 'eg-road', x1: '0', y1: '0', x2: '1', y2: '1' }, s('stop', { offset: '0', 'stop-color': '#b3a8ff' }), s('stop', { offset: '1', 'stop-color': '#6d5ce8' }))),
    s('rect', { x: '2', y: '2', width: '44', height: '44', rx: '13', fill: '#11131f', stroke: 'rgba(179,168,255,.35)' }),
    s('path', { d: 'M24 40V22M24 22 13 13M24 22l11-9', stroke: 'url(#eg-road)', 'stroke-width': '3.2', 'stroke-linecap': 'round' }),
    s('circle', { cx: '24', cy: '22', r: '3.4', fill: '#11131f', stroke: 'url(#eg-road)', 'stroke-width': '2.4' }),
    s('path', { d: 'M13 13c-2.4-2-2-4.8.2-6.8.2 1.6 1.4 2.2 2.2 1.4.8 1.8.3 4-2.4 5.4z', fill: 'url(#eg-flame)' }),
    s('path', { d: 'M35 13c2.4-2 2-4.8-.2-6.8-.2 1.6-1.4 2.2-2.2 1.4-.8 1.8-.3 4 2.4 5.4z', fill: 'url(#eg-flame)' }));
}
