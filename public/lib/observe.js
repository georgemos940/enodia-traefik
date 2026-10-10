// Pieces the observe pages (live traffic, access log, certificates) share: sparklines, rings, donuts and
// bar lists that update in place instead of being rebuilt, a searchable picker, a small menu, setup
// guides with copyable snippets, and downloads.
import { h, s, icon } from './dom.js';
import { copy } from './components.js';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

/** A colour canvas can use: var(--token) resolved against the current theme. */
export function resolve(color) {
  const m = /^var\((--[\w-]+)\)$/.exec(color);
  return m ? getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() : color;
}

/** Average `values` down to at most n points, so a sparkline of an hour stays light. */
export function thin(values, n = 90) {
  if (values.length <= n) return values;
  const out = [];
  const step = values.length / n;
  for (let i = 0; i < n; i++) {
    let sum = 0; let c = 0;
    for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) if (values[j] !== null && values[j] !== undefined) { sum += values[j]; c++; }
    out.push(c ? sum / c : 0);
  }
  return out;
}

// ── extra icons (Lucide shapes, MIT) ─────────────────────────────────────────

const P = {
  calendar: 'M3 5h18v16H3zM16 3v4M8 3v4M3 10h18',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  compare: 'M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM13 6h3a2 2 0 0 1 2 2v7M11 18H8a2 2 0 0 1-2-2V9',
  plus: 'M12 5v14M5 12h14',
  gauge: 'M12 14l4-4M3.3 19a10 10 0 1 1 17.4 0',
  timer: 'M10 2h4M12 14l3-3M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
  hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  arrowDown: 'M12 5v14M19 12l-7 7-7-7',
  memory: 'M6 19v-3M10 19v-3M14 19v-3M18 19v-3M8 11V9M16 11V9M12 11V9M2 15h20M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.1a2 2 0 0 0 0 3.8V15H2v-3.1a2 2 0 0 0 0-3.8z',
  wave: 'M2 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0',
};

export function oicon(name, opts = {}) {
  if (!P[name]) return icon(name, opts);
  const { size = 16, cls = '', stroke = 1.8 } = opts;
  return s('svg', { class: `icon ${cls}`.trim(), width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': stroke, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    ...P[name].split(/(?=M)/).map((seg) => s('path', { d: seg })));
}

// ── live marks ───────────────────────────────────────────────────────────────

/** A sparkline that is drawn once and re-pathed on .set(values), so it never flickers. */
export function liveSpark({ color = 'var(--torch)', width = 240, height = 46, cls = 'spark', fill = true, max: fixedMax = null } = {}) {
  const id = `os${Math.random().toString(36).slice(2, 9)}`;
  const area = s('path', { fill: `url(#${id})` });
  const line = s('path', { fill: 'none', 'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke', style: { stroke: color } });
  const svg = s('svg', { class: cls, viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    s('defs', {}, s('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 },
      s('stop', { offset: '0', style: { 'stop-color': color, 'stop-opacity': '0.3' } }),
      s('stop', { offset: '1', style: { 'stop-color': color, 'stop-opacity': '0' } }))),
    fill ? area : null, line);
  svg.set = (values) => {
    const vals = values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0];
    const top = fixedMax ?? Math.max(...vals.map((v) => v ?? 0), 1e-9);
    const step = width / (vals.length - 1);
    const d = vals.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(height - 3 - ((v ?? 0) / top) * (height - 9)).toFixed(1)}`).join(' ');
    line.setAttribute('d', d);
    area.setAttribute('d', `${d} L${width},${height} L0,${height} Z`);
  };
  svg.set([]);
  return svg;
}

/** A ring meter: .set(fraction, { color, value, label }). The arc eases to its new length. */
export function meter({ size = 96, thickness = 9, label = '' } = {}) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const arc = s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': thickness, 'stroke-linecap': 'round', class: 'ob-meter-arc', style: { 'stroke-dasharray': `${c}`, 'stroke-dashoffset': `${c}` } });
  const val = h('b', {}, '—');
  const sub = h('span', {}, label);
  const el = h('div', { class: 'ob-meter', style: { width: `${size}px`, height: `${size}px`, '--ob-size': `${size}px` } },
    s('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` },
      s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': thickness, class: 'ob-meter-track' }), arc),
    h('div', { class: 'ob-meter-val' }, val, sub));
  el.set = (frac, { color = 'var(--torch)', value, label: l } = {}) => {
    arc.style.stroke = color;
    const off = c * (1 - clamp01(frac));
    requestAnimationFrame(() => requestAnimationFrame(() => { arc.style.strokeDashoffset = `${frac > 0 ? Math.min(off, c - 0.01) : c}`; }));
    if (value !== undefined) { if (value instanceof Node) val.replaceChildren(value); else val.textContent = value; }
    if (l !== undefined) sub.textContent = l;
  };
  el.valueEl = val;
  return el;
}

/** A donut whose arcs glide between updates. parts: [{ key, label, value, color }]. */
export function liveDonut({ size = 150, thickness = 16 } = {}) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const g = s('g', { transform: `rotate(-90 ${size / 2} ${size / 2})` });
  const arcs = new Map();
  const center = h('b', {}, '—');
  const sub = h('span', {}, '');
  const el = h('div', { class: 'ob-donut', style: { width: `${size}px`, height: `${size}px`, '--ob-size': `${size}px` } },
    s('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` },
      s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': thickness, class: 'ob-meter-track' }), g),
    h('div', { class: 'ob-meter-val' }, center, sub));
  el.set = (parts, { value, label } = {}) => {
    const total = parts.reduce((a, p) => a + p.value, 0);
    let off = 0;
    const seen = new Set();
    for (const p of parts) {
      if (!(p.value > 0) || !total) continue;
      seen.add(p.key);
      let arc = arcs.get(p.key);
      if (!arc) {
        arc = s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': thickness, class: 'ob-donut-arc', style: { 'stroke-dasharray': `0 ${c}`, 'stroke-dashoffset': `${-off}` } }, s('title', {}));
        arcs.set(p.key, arc);
        g.append(arc);
      }
      const len = (p.value / total) * c;
      arc.style.stroke = p.color;
      arc.firstChild.textContent = `${p.label}: ${p.value.toLocaleString()}`;
      const gap = parts.length > 1 ? Math.min(2.5, len / 3) : 0;
      const o = off;
      requestAnimationFrame(() => { arc.style.strokeDasharray = `${Math.max(0, len - gap)} ${c}`; arc.style.strokeDashoffset = `${-o}`; });
      off += len;
    }
    for (const [k, arc] of arcs) if (!seen.has(k)) { arc.remove(); arcs.delete(k); }
    if (value !== undefined) center.textContent = value;
    if (label !== undefined) sub.textContent = label;
  };
  el.highlight = (key) => { for (const [k, arc] of arcs) arc.classList.toggle('dim', key !== null && k !== key); };
  return el;
}

/**
 * Horizontal bars that keep their rows between updates, so values glide instead of redrawing.
 * rows: [{ key, label, sub, value, color, title, active }]; onpick(row) makes rows clickable.
 */
export function barList({ format = String, onpick, onhover, emptyText = 'Nothing yet', max = null, cls = '' } = {}) {
  const el = h('div', { class: `ob-bars ${cls}`.trim() });
  const rows = new Map();
  el.set = (list) => {
    const top = max ?? Math.max(1e-9, ...list.map((r) => r.value));
    if (!list.length) { rows.clear(); el.replaceChildren(h('div', { class: 'ob-bars-empty' }, emptyText)); return; }
    const out = list.map((r) => {
      let row = rows.get(r.key);
      if (!row) {
        const fill = h('i');
        const label = h('span', { class: 'ob-bar-label' });
        const value = h('span', { class: 'ob-bar-value tnum' });
        const node = h(onpick ? 'button' : 'div', { type: onpick ? 'button' : undefined, class: 'ob-bar', onclick: onpick ? () => onpick(row.data) : undefined,
          onmouseenter: onhover ? () => onhover(row.data) : undefined, onmouseleave: onhover ? () => onhover(null) : undefined },
        h('span', { class: 'ob-bar-top' }, label, value), h('span', { class: 'ob-bar-track' }, fill));
        row = { node, fill, label, value };
        rows.set(r.key, row);
      }
      row.data = r;
      row.label.replaceChildren(r.swatch ? h('i', { class: 'ob-sw', style: { background: r.swatch } }) : null, h('span', { class: 'ellipsis' }, r.label), r.sub ? h('span', { class: 'ob-bar-sub' }, r.sub) : null);
      row.label.title = r.title ?? (typeof r.label === 'string' ? r.label : '');
      row.value.textContent = format(r.value, r);
      row.node.classList.toggle('on', Boolean(r.active));
      row.fill.style.background = r.color ?? 'var(--torch)';
      const w = `${Math.max(1.5, (r.value / top) * 100)}%`;
      if (!row.fill.style.width) requestAnimationFrame(() => requestAnimationFrame(() => { row.fill.style.width = w; }));
      else row.fill.style.width = w;
      return row.node;
    });
    const keep = new Set(list.map((r) => r.key));
    for (const k of rows.keys()) if (!keep.has(k)) rows.delete(k);
    el.replaceChildren(...out);
  };
  return el;
}

// ── popovers ────────────────────────────────────────────────────────────────

let openPop = null;

/** Opens `panel` under `anchor`; closes on outside click or Esc. Returns close(). */
export function popover(anchor, panel, { onclose, align = 'auto' } = {}) {
  openPop?.();
  panel.classList.add('ob-pop');
  document.body.append(panel);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = Math.min(panel.offsetWidth || 320, window.innerWidth - 16);
    let left = align === 'right' || (align === 'auto' && r.left + w > window.innerWidth - 8) ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    const below = window.innerHeight - r.bottom;
    panel.style.left = `${left}px`;
    panel.style.maxWidth = `${window.innerWidth - 16}px`;
    if (below < 260 && r.top > below) { panel.style.top = ''; panel.style.bottom = `${window.innerHeight - r.top + 6}px`; panel.style.maxHeight = `${r.top - 16}px`; }
    else { panel.style.bottom = ''; panel.style.top = `${r.bottom + 6}px`; panel.style.maxHeight = `${below - 16}px`; }
  };
  place();
  const onDown = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus?.(); } };
  const onMove = () => { if (!anchor.isConnected) close(); else place(); };
  setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onMove);
  window.addEventListener('scroll', onMove, true);
  function close() {
    if (openPop !== close) return;
    openPop = null;
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onMove);
    window.removeEventListener('scroll', onMove, true);
    panel.classList.add('out');
    setTimeout(() => panel.remove(), 140);
    onclose?.();
  }
  openPop = close;
  return close;
}

/**
 * A searchable picker. groups(): [{ name, items: [{ value, label, sub, icon, swatch, hint, faint }] }].
 * button(item) renders the closed state; onchange(value) fires on a pick.
 */
export function picker({ value, groups, onchange, button, placeholder = 'Search…', cls = '', title = '' }) {
  let current = value;
  const btn = h('button', { type: 'button', class: `ob-pick ${cls}`.trim(), 'aria-haspopup': 'listbox', title, onclick: () => open() });
  const findItem = (v) => groups().flatMap((g) => g.items).find((it) => it.value === v);
  const paintBtn = () => btn.replaceChildren(...[button(findItem(current) ?? { value: current, label: String(current ?? '') })].flat(), icon('down', { size: 14, cls: 'ob-pick-caret' }));
  paintBtn();

  function open() {
    if (btn.classList.contains('open')) return;
    let sel = 0;
    let shown = [];
    const input = h('input', { class: 'ob-pick-input', placeholder, autocomplete: 'off', spellcheck: false, type: 'text' });
    const list = h('div', { class: 'ob-pick-list', role: 'listbox' });
    const panel = h('div', { class: 'ob-pick-panel' }, h('label', { class: 'ob-pick-search' }, icon('search', { size: 15 }), input), list);
    const paint = () => {
      const q = input.value.trim().toLowerCase();
      shown = [];
      const nodes = [];
      for (const g of groups()) {
        const items = g.items.filter((it) => !q || `${it.label} ${it.sub ?? ''} ${it.value}`.toLowerCase().includes(q));
        if (!items.length) continue;
        nodes.push(h('div', { class: 'ob-pick-group' }, g.name, h('span', {}, String(items.length))));
        for (const it of items) {
          const i = shown.length;
          shown.push(it);
          nodes.push(h('div', { class: `ob-pick-item ${it.value === current ? 'cur' : ''} ${it.faint ? 'faint' : ''}`.trim(), role: 'option', dataset: { i: String(i) },
            onmouseenter: () => { sel = i; mark(); }, onclick: () => pick(it) },
          it.swatch ? h('i', { class: 'ob-sw', style: { background: it.swatch } }) : it.icon ? icon(it.icon, { size: 15, cls: 'muted' }) : null,
          h('span', { class: 'grow ellipsis' }, it.label, it.sub ? h('span', { class: 'ob-pick-sub' }, ` ${it.sub}`) : null),
          it.hint ? h('span', { class: 'ob-pick-hint tnum' }, it.hint) : null,
          it.value === current ? icon('check', { size: 14, cls: 'torch-text' }) : null));
        }
      }
      if (!shown.length) nodes.push(h('div', { class: 'ob-pick-none' }, 'Nothing matches'));
      list.replaceChildren(...nodes);
      if (sel >= shown.length) sel = 0;
      mark();
    };
    const mark = () => {
      list.querySelectorAll('.ob-pick-item').forEach((n) => n.classList.toggle('on', Number(n.dataset.i) === sel));
      list.querySelector(`.ob-pick-item[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    const pick = (it) => { close(); if (it.value !== current) { current = it.value; paintBtn(); onchange(it.value); } };
    input.addEventListener('input', () => { sel = 0; paint(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
      else if (e.key === 'Enter' && shown[sel]) { e.preventDefault(); pick(shown[sel]); }
    });
    btn.classList.add('open');
    paint();
    const cur = shown.findIndex((it) => it.value === current);
    if (cur >= 0) { sel = cur; mark(); }
    const close = popover(btn, panel, { onclose: () => btn.classList.remove('open') });
    if (matchMedia('(pointer: fine)').matches) setTimeout(() => input.focus(), 20);
  }

  btn.set = (v) => { current = v; paintBtn(); };
  btn.refresh = paintBtn;
  return btn;
}

/** A small action menu under a button. items: [{ label, icon, run, hint }] */
export function menuButton(trigger, items) {
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.addEventListener('click', () => {
    if (trigger.classList.contains('open')) return;
    trigger.classList.add('open');
    let close;
    const panel = h('div', { class: 'ob-menu', role: 'menu' }, ...items().map((it) => it === '-' ? h('div', { class: 'ob-menu-sep' })
      : h('button', { type: 'button', class: 'ob-menu-item', role: 'menuitem', onclick: () => { close(); it.run(); } },
        it.icon ? oicon(it.icon, { size: 15 }) : null, h('span', { class: 'grow' }, it.label), it.hint ? h('span', { class: 'ob-pick-hint' }, it.hint) : null)));
    close = popover(trigger, panel, { onclose: () => trigger.classList.remove('open'), align: 'right' });
  });
  return trigger;
}

// ── floating tooltip ─────────────────────────────────────────────────────────

let tipEl = null;
export function showTip(x, y, ...content) {
  tipEl ??= document.body.appendChild(h('div', { class: 'tip ob-tip', hidden: true }));
  tipEl.replaceChildren(...content);
  tipEl.hidden = false;
  const w = tipEl.offsetWidth; const hh = tipEl.offsetHeight;
  tipEl.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2))}px`;
  tipEl.style.top = `${y - hh - 10 < 8 ? y + 18 : y - hh - 10}px`;
}
export function hideTip() { if (tipEl) tipEl.hidden = true; }

// ── code and guides ──────────────────────────────────────────────────────────

/** Where a # comment starts on a line, outside quotes; -1 if none. */
function commentAt(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return i;
  }
  return -1;
}

function highlight(text, lang) {
  return text.split('\n').flatMap((line, i) => {
    const out = i ? ['\n'] : [];
    let rest = line;
    let comment = '';
    const hash = commentAt(rest);
    if (hash >= 0) { comment = rest.slice(hash); rest = rest.slice(0, hash); }
    if (lang === 'yaml') {
      const m = /^(\s*-?\s*)([\w.$/{}"-]+)(:)(\s.*)?$/.exec(rest);
      if (m) out.push(m[1], h('span', { class: 'k' }, m[2]), m[3], ...value(m[4] ?? ''));
      else out.push(...value(rest));
    } else if (lang === 'sh') {
      for (const part of rest.split(/(\s+)/)) out.push(/^--?[\w.-]+/.test(part) ? h('span', { class: 'k' }, part) : /^["'].*["']$/.test(part) ? h('span', { class: 's' }, part) : part);
    } else out.push(rest);
    if (comment) out.push(h('span', { class: 'c' }, comment));
    return out;
  });
  function value(v) {
    const t = v.trim();
    if (!t) return [v];
    const lead = v.slice(0, v.length - v.trimStart().length);
    const trail = v.slice(v.trimEnd().length);
    const cls = /^(true|false|null)$/.test(t) ? 'b' : /^-?\d+(\.\d+)?$/.test(t) ? 'n' : 's';
    return [lead, h('span', { class: cls }, t), trail];
  }
}

/** A code snippet with a title bar and a copy button. */
export function codeBlock(text, { title = '', lang = 'yaml' } = {}) {
  return h('div', { class: 'ob-code' },
    h('div', { class: 'ob-code-head' }, h('span', { class: 'ob-code-dots' }, h('i'), h('i'), h('i')), h('span', { class: 'grow ellipsis' }, title),
      h('button', { type: 'button', class: 'btn sm ghost ob-code-copy', onclick: () => copy(text, 'Snippet copied') }, icon('copy', { size: 13 }), 'Copy')),
    h('pre', {}, h('code', {}, ...highlight(text, lang))));
}

/** Snippets in tabs: [{ label, title, lang, text }] */
export function snippetTabs(list) {
  let on = 0;
  const body = h('div');
  const bar = h('div', { class: 'ob-snip-tabs', role: 'tablist' });
  const paint = () => {
    bar.replaceChildren(...list.map((x, i) => h('button', { type: 'button', class: i === on ? 'on' : '', onclick: () => { on = i; paint(); } }, x.label)));
    body.replaceChildren(codeBlock(list[on].text, { title: list[on].title ?? list[on].label, lang: list[on].lang }));
  };
  paint();
  return h('div', { class: 'ob-snips' }, list.length > 1 ? bar : null, body);
}

/** A setup guide: a hero, then numbered steps that each hold text and snippets. */
export function guide({ icon: ic = 'info', title, text, steps = [], foot = null, tone = 'torch' }) {
  return h('section', { class: `card ob-guide ob-guide-${tone}` },
    h('div', { class: 'ob-guide-hero' },
      h('div', { class: 'ob-guide-mark' }, oicon(ic, { size: 26 })),
      h('div', { class: 'grow' }, h('h2', {}, title), text ? h('p', { class: 'muted' }, text) : null)),
    h('ol', { class: 'ob-steps' }, ...steps.map((st, i) => h('li', { class: 'ob-step', style: { '--i': String(i) } },
      h('div', { class: 'ob-step-n' }, String(i + 1)),
      h('div', { class: 'ob-step-body' }, h('div', { class: 'ob-step-title' }, st.title), st.text ? h('div', { class: 'ob-step-text' }, st.text) : null,
        st.snippets ? snippetTabs(st.snippets) : null, st.extra ?? null)))),
    foot ? h('div', { class: 'ob-guide-foot' }, foot) : null);
}

/** Inline code inside prose. */
export const code = (t) => h('code', { class: 'ob-icode' }, t);

// ── misc ─────────────────────────────────────────────────────────────────────

/** Save text as a file. */
export function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** The page's query, read straight from the address bar so values may hold & or =. */
export function hashQuery() {
  const i = location.hash.indexOf('?');
  return new URLSearchParams(i < 0 ? '' : location.hash.slice(i + 1));
}

/** Put a page's state in the address bar without re-rendering the page. */
export function setHashQuery(path, params) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== false).map(([k, v]) => [k, String(v)])).toString();
  const next = `#/${path}${qs ? `?${qs}` : ''}`;
  if (location.hash !== next) history.replaceState(history.state, '', next);
}

export const STATUS_TEXT = {
  100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 408: 'Request Timeout',
  409: 'Conflict', 410: 'Gone', 413: 'Content Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type', 421: 'Misdirected Request', 422: 'Unprocessable Content',
  425: 'Too Early', 426: 'Upgrade Required', 429: 'Too Many Requests', 431: 'Headers Too Large', 499: 'Client Closed Request',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported',
};
export const statusText = (code) => STATUS_TEXT[code] ?? '';

/** The colour of a status class, as a token. */
export const classColor = (code) => {
  const c = Math.floor(Number(code) / 100);
  return c === 5 ? 'var(--c5xx)' : c === 4 ? 'var(--c4xx)' : c === 3 ? 'var(--c3xx)' : c === 2 ? 'var(--c2xx)' : 'var(--muted)';
};

export const METHOD_COLOR = { GET: 'var(--ob-sky)', POST: 'var(--ob-ok)', PUT: 'var(--torch)', PATCH: 'var(--violet)', DELETE: 'var(--ob-bad)', HEAD: 'var(--muted)', OPTIONS: 'var(--muted)' };

/** Count a number up only when motion is welcome. */
export const motionOk = () => !reduced();
