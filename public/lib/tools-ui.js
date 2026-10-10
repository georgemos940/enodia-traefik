// Pieces the tool pages share: copyable code snippets with tabs, a JSON tree that folds, searches and
// masks secrets, file downloads, and a few icons the shared set does not have.
import { h, s, icon } from './dom.js';
import { toast } from './components.js';

export const SECRET = /pass|secret|token|users|key$|apikey|credential/i;
const isComposite = (v) => v !== null && typeof v === 'object';

// ── icons ────────────────────────────────────────────────────────────────────

const P = {
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  sparkles: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8zM5 2l.6 1.4L7 4l-1.4.6L5 6l-.6-1.4L3 4l1.4-.6z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M17.9 17.9A10 10 0 0 1 12 19c-6.5 0-10-7-10-7a18 18 0 0 1 5.1-5.9M9.9 4.2A9 9 0 0 1 12 4c6.5 0 10 7 10 7a18 18 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2M2 2l20 20',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  fold: 'M7 20l5-5 5 5M7 4l5 5 5-5',
  unfold: 'M7 15l5 5 5-5M7 9l5-5 5 5',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  keyboard: 'M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  box: 'M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7zM3.3 7 12 12l8.7-5M12 22V12',
  plug: 'M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z',
  flame: 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3.2.3 1.5 1.3 2.7 2.5 2.7z',
  hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  braces: 'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1',
  split: 'M3 3h18v18H3zM12 3v18',
  rows: 'M3 3h18v18H3zM3 12h18',
  calendar: 'M3 5h18v16H3zM16 3v4M8 3v4M3 10h18',
  wrench: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z',
  scale: 'M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0zM8 21h8',
  gauge: 'M12 14l4-4M3.3 19a10 10 0 1 1 17.4 0',
  route: 'M6 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM9 16h6.5a3.5 3.5 0 0 0 0-7H12',
  power: 'M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10',
  tag: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01',
};

/** An icon from the shared set, or one of the extra shapes above. */
export function ticon(name, { size = 16, cls = '', stroke = 1.8 } = {}) {
  const d = P[name];
  if (!d) return icon(name, { size, cls, stroke });
  return s('svg', { class: `icon ${cls}`.trim(), width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': stroke, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    ...d.split(/(?=M)/).map((seg) => s('path', { d: seg })));
}

// ── clipboard & files ────────────────────────────────────────────────────────

/** Copy text; works on plain-HTTP origins too, where navigator.clipboard is missing. */
export async function copyText(text, label = 'Copied') {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const ta = h('textarea', { class: 'tl-offscreen', readonly: true });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('copy refused');
    }
    if (label) toast(label);
    return true;
  } catch {
    toast('Copy failed: select the text and copy it by hand', 'bad');
    return false;
  }
}

/** A button that copies and briefly turns into a check mark. */
export function copyBtn(get, { label = 'Copy', toastText = 'Copied', cls = 'btn sm ghost' } = {}) {
  const btn = h('button', { type: 'button', class: `${cls} tl-copy`, title: label },
    ticon('copy', { size: 14 }), label ? h('span', { class: 'tl-copy-label' }, label) : null);
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (await copyText(typeof get === 'function' ? get() : get, toastText)) {
      btn.classList.add('done');
      btn.replaceChildren(ticon('check', { size: 14 }), label ? h('span', { class: 'tl-copy-label' }, 'Copied') : null);
      setTimeout(() => { btn.classList.remove('done'); btn.replaceChildren(ticon('copy', { size: 14 }), label ? h('span', { class: 'tl-copy-label' }, label) : null); }, 1600);
    }
  });
  return btn;
}

export function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name, class: 'tl-offscreen' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * JSON.parse that keeps integers beyond 2^53 exact (Traefik's internal routers use MaxInt64 - 1 as
 * priority) by turning them into BigInt, where the browser hands the reviver the source text.
 */
export function parseJson(text) {
  return JSON.parse(text, (k, v, ctx) => (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v) && ctx?.source && /^-?\d+$/.test(ctx.source) ? BigInt(ctx.source) : v));
}

/** JSON.stringify that writes BigInt values as plain digits. */
export function toJson(v, space = 2) {
  return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `@@enodia-bigint:${x}` : x), space).replace(/"@@enodia-bigint:(-?\d+)"/g, '$1');
}

/** A deep copy with secret-looking values replaced. */
export function maskDeep(v, key = '', masked = false) {
  const m = masked || (key && SECRET.test(key));
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, key, m));
  if (isComposite(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x, k, m)]));
  if (m && v !== null && v !== '' && typeof v !== 'boolean') return '••••••';
  return v;
}

/** "george@example.com" -> "g•••••@e••••••.com" */
export function maskEmail(email) {
  const m = /^([^@]*)@(.+?)(\.[^.]+)?$/.exec(String(email ?? ''));
  if (!m) return email ? '••••••' : '';
  const dots = (x) => (x ? x[0] + '•'.repeat(Math.min(6, Math.max(2, x.length - 1))) : '');
  return `${dots(m[1])}@${dots(m[2])}${m[3] ?? ''}`;
}

// ── code snippets ────────────────────────────────────────────────────────────

const span = (cls, t) => h('span', { class: cls }, t);

function yamlValue(v) {
  if (!v) return [];
  const cm = /^(.*?)(\s+#.*)$/.exec(v);
  if (cm && (cm[1].split('"').length % 2 === 1)) return [...yamlValue(cm[1]), span('tl-c', cm[2])];
  if (/^".*"$|^'.*'$/.test(v)) return [span('s', v)];
  if (/^-?\d+(\.\d+)?$/.test(v)) return [span('n', v)];
  if (/^(true|false|null)$/.test(v)) return [span('b', v)];
  if (/^[[{|>]/.test(v)) return [span('tl-p', v)];
  return [span('s', v)];
}

function highlightLine(line, lang) {
  if (/^\s*#/.test(line)) return [span('tl-c', line)];
  if (lang === 'yaml') {
    let m = /^(\s*)(- )?([\w.\-/"']+?)(:)(\s+|$)(.*)$/.exec(line);
    if (m) return [m[1], m[2] ? span('tl-p', m[2]) : null, span('k', m[3]), span('tl-p', m[4]), m[5], ...yamlValue(m[6])];
    m = /^(\s*)(- )(.*)$/.exec(line);
    if (m) return [m[1], span('tl-p', m[2]), ...yamlValue(m[3])];
    return [line];
  }
  if (lang === 'labels' || lang === 'env') {
    const m = /^(\s*-\s*)?(["']?)([^=\s"']+)(=)(.*?)(["']?)$/.exec(line);
    if (m) return [m[1] ? span('tl-p', m[1]) : null, m[2], span('k', m[3]), span('tl-p', m[4]), span('s', m[5]), m[6]];
    return lang === 'labels' ? highlightLine(line, 'yaml') : [line];
  }
  if (lang === 'sh') {
    const parts = line.split(/(\s+|"[^"]*"|'[^']*')/).filter((x) => x !== '');
    let first = true;
    return parts.map((p) => {
      if (/^\s+$/.test(p)) return p;
      if (/^["']/.test(p)) return span('s', p);
      if (/^--?[\w.-]/.test(p)) return span('n', p);
      if (first) { first = false; return span('tl-cmd', p); }
      if (p === '|' || p === '\\' || p === '&&') return span('tl-p', p);
      return p;
    });
  }
  return [line];
}

let lastTab = (() => { try { return localStorage.getItem('enodia-snippet-tab'); } catch { return null; } })();

/**
 * A code snippet with a copy button. tabs: [{ label, lang: 'yaml' | 'labels' | 'env' | 'sh' | 'text', code, note }]
 * or a single { lang, code }. The tab picked last (Docker labels, File...) is remembered.
 */
export function codeBlock(tabs, { title = '', compact = false } = {}) {
  const list = Array.isArray(tabs) ? tabs : [tabs];
  let cur = Math.max(0, list.findIndex((t) => t.label && t.label === lastTab));
  const pre = h('pre', { class: 'tl-pre' });
  const note = h('div', { class: 'tl-code-note' });
  const tabBar = list.length > 1 ? h('div', { class: 'tl-code-tabs', role: 'tablist' }) : null;
  const paint = () => {
    const t = list[cur];
    pre.replaceChildren(h('code', {}, ...t.code.replace(/\n$/, '').split('\n').flatMap((ln, i) => [i ? '\n' : null, ...highlightLine(ln, t.lang)])));
    note.replaceChildren(t.note ?? '');
    note.hidden = !t.note;
    tabBar?.replaceChildren(...list.map((x, i) => h('button', { type: 'button', role: 'tab', class: i === cur ? 'on' : '', onclick: () => { cur = i; lastTab = x.label; try { localStorage.setItem('enodia-snippet-tab', x.label); } catch { /* private */ } paint(); } }, x.label)));
  };
  paint();
  return h('div', { class: `tl-code ${compact ? 'compact' : ''}`.trim() },
    h('div', { class: 'tl-code-head' },
      tabBar ?? h('span', { class: 'tl-code-title' }, title || list[0].label || langName(list[0].lang)),
      h('span', { class: 'grow' }),
      copyBtn(() => list[cur].code.replace(/\n$/, ''), { label: 'Copy', toastText: 'Snippet copied' })),
    pre, note);
}
const langName = (l) => ({ yaml: 'YAML', labels: 'Docker labels', env: 'Environment', sh: 'Shell' }[l] ?? '');

// ── JSON tree ────────────────────────────────────────────────────────────────

const SEP = '\u0001';

/**
 * A JSON tree: objects and arrays fold, the search expands the way to every match and marks it.
 * Returns { el, search(q) -> hits, step(dir), expandAll(), collapseAll(), setMask(bool), set(data) }.
 */
export function jsonTree(data, { depth = 2, mask = true } = {}) {
  const el = h('div', { class: 'tl-jt', role: 'tree' });
  const openState = new Map();
  const shownCount = new Map();
  let value = data;
  let masked = mask;
  let query = '';
  let forced = new Set();
  let hits = [];
  let cur = -1;
  let allOpen = false;

  const isOpen = (path, d) => forced.has(path) || (openState.has(path) ? openState.get(path) : allOpen || d < depth);
  const mark = (text) => {
    if (!query) return text;
    const lower = text.toLowerCase();
    const out = [];
    let i = 0;
    for (let at = lower.indexOf(query); at >= 0; at = lower.indexOf(query, i)) {
      out.push(text.slice(i, at), h('mark', { class: 'tl-hit' }, text.slice(at, at + query.length)));
      i = at + query.length;
    }
    out.push(text.slice(i));
    return out;
  };
  const scalar = (v, sec) => {
    if (sec && v !== null && v !== '' && typeof v !== 'boolean') return h('span', { class: 'z', title: 'Hidden: looks like a secret' }, '"••••••"');
    if (v === null) return h('span', { class: 'z' }, 'null');
    if (typeof v === 'string') return h('span', { class: 's' }, mark(JSON.stringify(v)));
    if (typeof v === 'number' || typeof v === 'bigint') return h('span', { class: 'n' }, mark(String(v)));
    return h('span', { class: 'b' }, mark(String(v)));
  };
  const summary = (v) => {
    if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`;
    const keys = Object.keys(v);
    const label = typeof v.name === 'string' ? v.name : typeof v.address === 'string' ? v.address : typeof v.url === 'string' ? v.url : null;
    return label ? `${label} · ${keys.length} keys` : keys.slice(0, 3).join(', ') + (keys.length > 3 ? ` +${keys.length - 3}` : '');
  };
  const toggle = (path, d) => { openState.set(path, !isOpen(path, d)); forced.delete(path); paint(); };

  function lines(v, key, path, d, sec, out) {
    const secret = sec || (masked && typeof key === 'string' && SECRET.test(key));
    const k = key === null ? null : typeof key === 'number' ? [h('span', { class: 'tl-ji' }, String(key)), ' '] : [h('span', { class: 'k' }, mark(JSON.stringify(key))), h('span', { class: 'tl-p' }, ': ')];
    const line = (...parts) => out.push(h('div', { class: 'tl-jl', role: 'treeitem', style: { '--d': d } }, ...parts));
    const composite = isComposite(v) && (Array.isArray(v) ? v.length : Object.keys(v).length);
    if (!composite) { line(h('span', { class: 'tl-jcaret none' }), k, isComposite(v) ? h('span', { class: 'tl-p' }, Array.isArray(v) ? '[]' : '{}') : scalar(v, secret)); return; }
    const arr = Array.isArray(v);
    const open = isOpen(path, d);
    const caret = h('button', { type: 'button', class: `tl-jcaret ${open ? 'open' : ''}`, 'aria-label': open ? 'Fold' : 'Unfold', onclick: () => toggle(path, d) }, icon('chevron', { size: 12, stroke: 2.4 }));
    if (!open) {
      line(caret, k, h('button', { type: 'button', class: 'tl-jsum', onclick: () => toggle(path, d) }, arr ? '[' : '{', h('span', {}, mark(summary(v))), arr ? ']' : '}'));
      return;
    }
    line(caret, k, h('span', { class: 'tl-p' }, arr ? '[' : '{'), h('span', { class: 'tl-jcount' }, arr ? `${v.length}` : ''));
    const entries = arr ? v.map((x, i) => [i, x]) : Object.entries(v);
    const limit = shownCount.get(path) ?? 200;
    for (const [kk, x] of entries.slice(0, limit)) lines(x, kk, path + SEP + kk, d + 1, secret, out);
    if (entries.length > limit) {
      out.push(h('div', { class: 'tl-jl', style: { '--d': d + 1 } }, h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { shownCount.set(path, limit + 500); paint(); } }, `Show ${Math.min(500, entries.length - limit)} more of ${entries.length - limit}`)));
    }
    line(h('span', { class: 'tl-jcaret none' }), h('span', { class: 'tl-p' }, arr ? ']' : '}'));
  }

  function paint() {
    const out = [];
    lines(value, null, '', 0, false, out);
    el.replaceChildren(...out);
    hits = [...el.querySelectorAll('mark.tl-hit')];
    if (cur >= hits.length) cur = hits.length - 1;
    hits[cur]?.classList.add('on');
  }

  // every path whose subtree holds a match, so the search can open the way to it
  function findPaths(q) {
    const paths = new Set();
    let n = 0;
    const walk = (v, key, path, sec) => {
      if (n > 5000) return false;
      const secret = sec || (masked && typeof key === 'string' && SECRET.test(key));
      let hit = typeof key === 'string' && JSON.stringify(key).toLowerCase().includes(q);
      if (isComposite(v)) {
        const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
        for (const [k, x] of entries) if (walk(x, k, path + SEP + k, secret)) hit = true;
        if (hit) paths.add(path);
      } else if (!(secret && v !== null && v !== '' && typeof v !== 'boolean') && (typeof v === 'string' ? JSON.stringify(v) : String(v)).toLowerCase().includes(q)) hit = true;
      if (hit) n++;
      return hit;
    };
    walk(value, null, '', false);
    return paths;
  }

  paint();
  return {
    el,
    search(q) {
      query = String(q ?? '').trim().toLowerCase();
      forced = query ? findPaths(query) : new Set();
      cur = query ? 0 : -1;
      paint();
      hits[0]?.scrollIntoView({ block: 'nearest' });
      return { count: hits.length, index: hits.length ? cur : -1 };
    },
    step(dir) {
      if (!hits.length) return { count: 0, index: -1 };
      hits[cur]?.classList.remove('on');
      cur = (cur + dir + hits.length) % hits.length;
      hits[cur].classList.add('on');
      hits[cur].scrollIntoView({ block: 'center', behavior: 'smooth' });
      return { count: hits.length, index: cur };
    },
    expandAll() { allOpen = true; openState.clear(); paint(); },
    collapseAll() { allOpen = false; depth = 1; openState.clear(); forced = new Set(); paint(); },
    setMask(v) { masked = v; paint(); },
    set(next) { value = next; openState.clear(); shownCount.clear(); if (query) forced = findPaths(query); paint(); },
  };
}

/**
 * A JSON tree with its toolbar: search with match count and stepping, fold / unfold, mask secrets,
 * copy and download. Returns { el, set(data) }.
 */
export function jsonPanel(data, { filename = 'traefik.json', depth = 2, maxHeight = '' } = {}) {
  let value = data;
  let masked = true;
  const tree = jsonTree(value, { depth, mask: true });
  const counter = h('span', { class: 'tl-jp-count tnum' });
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Find in JSON…', autocomplete: 'off', spellcheck: false });
  const show = (r) => { counter.textContent = input.value.trim() ? (r.count ? `${r.index + 1} / ${r.count}` : 'no match') : ''; counter.classList.toggle('none', Boolean(input.value.trim()) && !r.count); };
  let t = 0;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => show(tree.search(input.value)), 120); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); show(tree.step(e.shiftKey ? -1 : 1)); } });
  const eyeBtn = h('button', { type: 'button', class: 'btn sm ghost icon-only', title: 'Show or hide secret-looking values' });
  const paintEye = () => { eyeBtn.replaceChildren(ticon(masked ? 'eyeOff' : 'eye', { size: 15 })); eyeBtn.classList.toggle('tl-on', !masked); eyeBtn.title = masked ? 'Secrets hidden: click to show them' : 'Secrets shown: click to hide them'; };
  eyeBtn.addEventListener('click', () => { masked = !masked; tree.setMask(masked); paintEye(); });
  paintEye();
  const text = () => toJson(masked ? maskDeep(value) : value);
  const body = h('div', { class: 'tl-jp-body', style: maxHeight ? { maxHeight } : undefined }, tree.el);
  const el = h('div', { class: 'tl-jp' },
    h('div', { class: 'tl-jp-bar' },
      h('label', { class: 'input-wrap tl-jp-search' }, icon('search', { size: 15 }), input, counter),
      h('div', { class: 'row tl-jp-steps' },
        h('button', { type: 'button', class: 'btn sm ghost icon-only', title: 'Previous match (Shift+Enter)', onclick: () => show(tree.step(-1)) }, icon('up', { size: 15 })),
        h('button', { type: 'button', class: 'btn sm ghost icon-only', title: 'Next match (Enter)', onclick: () => show(tree.step(1)) }, icon('down', { size: 15 }))),
      h('span', { class: 'grow' }),
      h('div', { class: 'row tl-jp-tools' },
        h('button', { type: 'button', class: 'btn sm ghost', title: 'Unfold everything', onclick: () => tree.expandAll() }, ticon('unfold', { size: 14 }), h('span', { class: 'tl-hide-sm' }, 'Expand')),
        h('button', { type: 'button', class: 'btn sm ghost', title: 'Fold everything', onclick: () => tree.collapseAll() }, ticon('fold', { size: 14 }), h('span', { class: 'tl-hide-sm' }, 'Collapse')),
        eyeBtn,
        copyBtn(text, { label: '', toastText: 'JSON copied', cls: 'btn sm ghost icon-only' }),
        h('button', { type: 'button', class: 'btn sm ghost icon-only', title: 'Download', onclick: () => download(filename, text()) }, icon('download', { size: 15 })))),
    body);
  return { el, input, set(next) { value = next; tree.set(next); if (input.value.trim()) show(tree.search(input.value)); }, text };
}
