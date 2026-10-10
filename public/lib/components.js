// The building blocks every page uses. Keep pages made of these so the whole app looks like one thing.
import { h, icon, stagger } from './dom.js';
import { ago, split, num } from './format.js';

// ── links ────────────────────────────────────────────────────────────────────

/** The hash route of a resource: kind = routers | services | middlewares | entrypoints. */
export const hrefFor = (kind, name, proto = 'http') => (kind === 'entrypoints' ? `#/entrypoints/${encodeURIComponent(name)}` : `#/${kind}/${proto}/${encodeURIComponent(name)}`);

export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

// ── layout ───────────────────────────────────────────────────────────────────

export function pageHead({ title, sub, icon: ic, actions = [] }) {
  return h('div', { class: 'page-head' },
    h('div', { class: 'grow' },
      h('h1', { class: 'page-title' }, ic ? icon(ic, { size: 24, cls: 'torch-text' }) : null, title),
      sub ? h('p', { class: 'page-sub' }, sub) : null),
    actions.length ? h('div', { class: 'row wrap' }, ...actions) : null);
}

export function card({ title, sub, icon: ic, tools = [], body, flush = false, cls = '', id } = {}, ...children) {
  return h('section', { class: `card ${cls}`.trim(), id },
    title || tools.length ? h('div', { class: 'card-head' },
      h('div', { class: 'grow' },
        title ? h('div', { class: 'card-title' }, ic ? icon(ic, { size: 15 }) : null, title) : null,
        sub ? h('div', { class: 'card-sub' }, sub) : null),
      tools.length ? h('div', { class: 'card-tools' }, ...tools) : null) : null,
    h('div', { class: flush ? 'card-body flush' : 'card-body' }, body ?? null, ...children));
}

/** A number tile. value is text or a node; spark is an optional sparkline node. */
export function stat({ label, value, unit, foot, icon: ic, spark, tone, href } = {}) {
  const v = h('div', { class: `stat-value ${tone ? `${tone}-text` : ''}`.trim() }, value, unit ? h('small', {}, unit) : null);
  const el = h(href ? 'a' : 'div', { class: `card stat ${href ? 'hover' : ''}`.trim(), href },
    h('div', { class: 'stat-label' }, ic ? icon(ic, { size: 14 }) : null, label),
    v,
    foot ? h('div', { class: 'stat-foot' }, foot) : null,
    spark ?? null);
  el.valueEl = v;
  return el;
}

export function grid(cols, ...children) {
  return stagger(h('div', { class: `grid ${cols}` }, ...children));
}

// ── badges ───────────────────────────────────────────────────────────────────

export const badge = (text, tone = '', extra = {}) => h('span', { class: `badge ${tone}`.trim(), ...extra }, text);

/** Traefik's own status: enabled / warning / disabled. */
export function statusBadge(status) {
  if (status === 'enabled') return h('span', { class: 'badge ok' }, h('span', { class: 'dot ok' }), 'enabled');
  if (status === 'warning') return h('span', { class: 'badge warn' }, h('span', { class: 'dot warn' }), 'warning');
  if (status === 'disabled') return h('span', { class: 'badge bad' }, h('span', { class: 'dot bad pulse' }), 'disabled');
  return h('span', { class: 'badge' }, status ?? 'unknown');
}

const PROVIDER_TONE = { docker: 'info', swarm: 'info', file: 'torch', internal: '', kubernetes: 'violet', kubernetescrd: 'violet', kubernetesingress: 'violet', kubernetesgateway: 'violet', consulcatalog: 'ok', nomad: 'ok', ecs: 'warn', http: 'violet', redis: 'bad', etcd: 'info', zookeeper: 'info', consul: 'ok' };
export function providerBadge(name) {
  const p = name.includes('@') ? split(name).provider : name;
  return h('span', { class: `badge ${PROVIDER_TONE[p] ?? ''}`.trim() }, p || '—');
}

/** "shop@docker" as name + provider, the base name in bold. */
export function resName(name, { href, sub } = {}) {
  const { base, provider } = split(name);
  const inner = [h('span', { class: 'ellipsis', title: name }, base), provider ? h('span', { class: 'faint tiny' }, `@${provider}`) : null];
  return h('div', { class: 'col', style: { gap: '1px', minWidth: '0' } },
    href ? h('a', { class: 'cell-title', href }, ...inner) : h('div', { class: 'cell-title' }, ...inner),
    sub ? h('div', { class: 'cell-sub ellipsis' }, sub) : null);
}

export function dot(tone, pulse = false) { return h('span', { class: `dot ${tone} ${pulse ? 'pulse' : ''}`.trim() }); }

// ── table ────────────────────────────────────────────────────────────────────

/**
 * A sortable table. columns: [{ key, label, render(row) -> node, sort(row) -> value, num, tight, width }]
 * Returns { el, update(rows) }. rowClick(row) makes rows clickable.
 */
export function table(columns, rows, { rowClick, empty = 'Nothing here', sortBy = null, desc = false, rowKey = (r) => r.name ?? JSON.stringify(r) } = {}) {
  let data = rows;
  let sort = sortBy;
  let dir = desc ? -1 : 1;
  const thead = h('thead');
  const tbody = h('tbody');
  const wrap = h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, thead, tbody));
  const prevKeys = new Set();

  function head() {
    thead.replaceChildren(h('tr', {}, ...columns.map((c) => h('th', {
      class: [c.sort ? 'sortable' : '', c.num ? 'num' : '', c.tight ? 'tight' : ''].join(' '),
      style: c.width ? { width: c.width } : undefined,
      onclick: c.sort ? () => { if (sort === c.key) dir = -dir; else { sort = c.key; dir = c.num ? -1 : 1; } render(); } : undefined,
    }, c.label, sort === c.key ? h('span', { class: 'arrow' }, dir > 0 ? '▲' : '▼') : null))));
  }
  function render() {
    head();
    const col = columns.find((c) => c.key === sort);
    const list = col?.sort ? [...data].sort((a, b) => {
      const x = col.sort(a); const y = col.sort(b);
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x > y ? 1 : -1) * dir;
    }) : data;
    if (!list.length) {
      tbody.replaceChildren(h('tr', {}, h('td', { colspan: columns.length }, h('div', { class: 'empty' }, icon('search', { size: 22 }), h('div', {}, empty)))));
      return;
    }
    const fresh = [];
    tbody.replaceChildren(...list.map((row) => {
      const k = rowKey(row);
      fresh.push(k);
      return h('tr', { class: rowClick ? 'clickable' : '', onclick: rowClick ? (e) => { if (!e.target.closest('a,button')) rowClick(row); } : undefined },
        ...columns.map((c) => h('td', { class: [c.num ? 'num' : '', c.tight ? 'tight' : ''].join(' ') }, c.render ? c.render(row) : row[c.key])));
    }));
    prevKeys.clear(); fresh.forEach((k) => prevKeys.add(k));
  }
  render();
  return { el: wrap, update(next) { data = next; render(); } };
}

// ── inputs ───────────────────────────────────────────────────────────────────

export function searchInput({ placeholder = 'Filter…', value = '', oninput, autofocus = false } = {}) {
  const input = h('input', { class: 'input', type: 'search', placeholder, value, autocomplete: 'off', spellcheck: false, oninput: (e) => oninput?.(e.target.value) });
  if (autofocus) setTimeout(() => input.focus(), 50);
  return h('label', { class: 'input-wrap' }, icon('search', { size: 15 }), input);
}

/** A segmented control. options: [[value, label]]. */
export function segmented(options, value, onchange) {
  const el = h('div', { class: 'seg', role: 'tablist' });
  const paint = (v) => el.replaceChildren(...options.map(([val, label]) => h('button', { type: 'button', class: val === v ? 'on' : '', onclick: () => { paint(val); onchange(val); } }, label)));
  paint(value);
  return el;
}

export function tabs(list, value, onchange) {
  const el = h('div', { class: 'tabs' });
  const paint = (v) => el.replaceChildren(...list.map(([id, label, count]) => h('button', { type: 'button', class: id === v ? 'on' : '', onclick: () => { paint(id); onchange(id); } }, label, count !== undefined ? h('span', { class: 'badge', style: { marginLeft: '6px', height: '18px' } }, String(count)) : null)));
  paint(value);
  return el;
}

// ── feedback ─────────────────────────────────────────────────────────────────

export function empty(title, text = '', ic = 'info') {
  return h('div', { class: 'empty' }, icon(ic, { size: 28 }), h('div', { class: 'empty-title' }, title), text ? h('div', { class: 'small' }, text) : null);
}

export function skeleton(lines = 4, height = 14) {
  return h('div', { class: 'col' }, ...Array.from({ length: lines }, (_, i) => h('div', { class: 'skeleton', style: { height: `${height}px`, width: `${70 + ((i * 37) % 30)}%` } })));
}

export function banner(tone, title, text, action) {
  return h('div', { class: `banner ${tone}` }, icon(tone === 'bad' ? 'xcircle' : tone === 'warn' ? 'alert' : 'info', { size: 18, cls: `${tone}-text` }),
    h('div', { class: 'grow' }, h('div', { class: 'bold' }, title), text ? h('div', { class: 'muted small' }, text) : null), action ?? null);
}

let toastRoot = null;
export function toast(text, tone = 'ok') {
  toastRoot ??= document.body.appendChild(h('div', { class: 'toasts' }));
  const el = h('div', { class: 'toast' }, icon(tone === 'bad' ? 'xcircle' : tone === 'warn' ? 'alert' : 'ok', { size: 17, cls: `${tone}-text` }), h('div', {}, text));
  toastRoot.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, 3200);
}

export async function copy(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { toast('Copy failed', 'bad'); }
}
export const copyButton = (text, title = 'Copy') => h('button', { class: 'btn sm ghost icon-only', title, onclick: (e) => { e.stopPropagation(); copy(typeof text === 'function' ? text() : text); } }, icon('copy', { size: 14 }));

/** A modal; returns { el, close }. */
export function modal(content, { onclose } = {}) {
  const box = h('div', { class: 'modal' }, content);
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } }, box);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); onclose?.(); }
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  return { el: box, close };
}

/** A panel sliding in from the right; returns { el, close }. */
export function drawer(title, content) {
  const panel = h('aside', { class: 'drawer' },
    h('div', { class: 'row', style: { padding: '14px 16px', borderBottom: '1px solid var(--line)' } }, h('div', { class: 'bold grow ellipsis' }, title), h('button', { class: 'btn sm ghost icon-only', onclick: () => close() }, icon('x'))),
    h('div', { style: { overflow: 'auto', padding: '16px', flex: '1' } }, content));
  const back = h('div', { class: 'overlay', style: { padding: '0' }, onclick: () => close() });
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() { panel.remove(); back.remove(); document.removeEventListener('keydown', onKey); }
  document.addEventListener('keydown', onKey);
  document.body.append(back, panel);
  return { el: panel, close };
}

// ── data views ───────────────────────────────────────────────────────────────

export function kv(pairs) {
  return h('dl', { class: 'kv' }, ...pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? h('span', { class: 'faint' }, '—'))]));
}

/** JSON with colours. Masks values of keys that look like secrets. */
export function jsonView(value, { mask = true } = {}) {
  const SECRET = /pass|secret|token|users|key$|apikey|credential/i;
  const out = h('pre', { class: 'json' });
  const walk = (v, indent, key) => {
    const pad = '  '.repeat(indent);
    if (mask && key && SECRET.test(key) && v !== null && v !== '' && typeof v !== 'boolean') return [h('span', { class: 'z' }, '"••••••"')];
    if (v === null) return [h('span', { class: 'z' }, 'null')];
    if (typeof v === 'string') return [h('span', { class: 's' }, JSON.stringify(v))];
    if (typeof v === 'number') return [h('span', { class: 'n' }, String(v))];
    if (typeof v === 'boolean') return [h('span', { class: 'b' }, String(v))];
    if (Array.isArray(v)) {
      if (!v.length) return ['[]'];
      return ['[\n', ...v.flatMap((x, i) => [pad + '  ', ...walk(x, indent + 1, key), i < v.length - 1 ? ',\n' : '\n']), pad + ']'];
    }
    const keys = Object.keys(v);
    if (!keys.length) return ['{}'];
    return ['{\n', ...keys.flatMap((k, i) => [pad + '  ', h('span', { class: 'k' }, JSON.stringify(k)), ': ', ...walk(v[k], indent + 1, k), i < keys.length - 1 ? ',\n' : '\n']), pad + '}'];
  };
  out.append(...walk(value, 0, ''));
  return out;
}

/** A time that keeps saying "12 seconds ago" correctly. */
export function timeAgo(iso) {
  const el = h('time', { datetime: iso, title: iso ? new Date(iso).toLocaleString() : '' }, ago(iso));
  el.dataset.ago = '1';
  return el;
}
setInterval(() => { for (const el of document.querySelectorAll('time[data-ago]')) el.textContent = ago(el.getAttribute('datetime')); }, 15000);

export const count = (n) => h('span', { class: 'tnum' }, num(n));
