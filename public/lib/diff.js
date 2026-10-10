// A field-level JSON diff between two versions of a router, service or middleware: nested objects
// are compared key by key, arrays item by item (aligned, so an inserted middleware is one line), and
// the result is drawn side by side or unified with the unchanged parts folded away.
import { h } from './dom.js';

const SECRET = /pass|secret|token|users|key$|apikey|credential/i;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isComposite = (v) => v !== null && typeof v === 'object';
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The diff tree. Node: { t: 'same' | 'add' | 'del' | 'mod' | 'obj' | 'arr', a, b, kids: [{ key, node }] }
 * 'obj' and 'arr' hold changes somewhere below; 'mod' is a value replaced as a whole.
 */
export function diff(a, b) {
  if (same(a, b)) return { t: 'same', a, b };
  if (isObj(a) && isObj(b)) {
    const keys = [...Object.keys(a), ...Object.keys(b).filter((k) => !(k in a))];
    return { t: 'obj', a, b, kids: keys.map((k) => ({ key: k, node: !(k in b) ? { t: 'del', a: a[k] } : !(k in a) ? { t: 'add', b: b[k] } : diff(a[k], b[k]) })) };
  }
  if (Array.isArray(a) && Array.isArray(b)) return { t: 'arr', a, b, kids: alignArrays(a, b) };
  return { t: 'mod', a, b };
}

/** Longest common subsequence of two arrays, then removed+added objects at one spot diffed in place. */
function alignArrays(a, b) {
  const A = a.map((x) => JSON.stringify(x));
  const B = b.map((x) => JSON.stringify(x));
  const ops = [];
  if (a.length * b.length > 250_000) {
    // too big to align: compare by position
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length) ops.push({ t: 'add', j: i });
      else if (i >= b.length) ops.push({ t: 'del', i });
      else ops.push(A[i] === B[i] ? { t: 'same', i, j: i } : { t: 'pair', i, j: i });
    }
  } else {
    const L = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0; let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && A[i] === B[j]) { ops.push({ t: 'same', i: i++, j: j++ }); continue; }
      // a run of removals and additions between two common items
      const dels = []; const adds = [];
      while (i < a.length && (j >= b.length || L[i + 1][j] >= L[i][j + 1]) && !(j < b.length && A[i] === B[j])) dels.push(i++);
      while (j < b.length && !(i < a.length && A[i] === B[j])) adds.push(j++);
      // pair objects at the same spot: a changed server is one nested diff, not a remove and an add
      const n = Math.min(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        if (isComposite(a[dels[k]]) && isComposite(b[adds[k]])) ops.push({ t: 'pair', i: dels[k], j: adds[k] });
        else { ops.push({ t: 'del', i: dels[k] }); ops.push({ t: 'add', j: adds[k] }); }
      }
      for (let k = n; k < dels.length; k++) ops.push({ t: 'del', i: dels[k] });
      for (let k = n; k < adds.length; k++) ops.push({ t: 'add', j: adds[k] });
    }
  }
  return ops.map((op) => {
    if (op.t === 'same') return { key: null, node: { t: 'same', a: a[op.i], b: b[op.j] } };
    if (op.t === 'del') return { key: null, node: { t: 'del', a: a[op.i] } };
    if (op.t === 'add') return { key: null, node: { t: 'add', b: b[op.j] } };
    return { key: null, node: diff(a[op.i], b[op.j]) };
  });
}

/** How many values were added, removed and changed. */
export function stats(node) {
  const out = { add: 0, del: 0, mod: 0 };
  const walk = (n) => {
    if (n.t === 'add') out.add++;
    else if (n.t === 'del') out.del++;
    else if (n.t === 'mod') out.mod++;
    else if (n.kids) n.kids.forEach((k) => walk(k.node));
  };
  walk(node);
  return out;
}

// ── rendering ────────────────────────────────────────────────────────────────

function scalar(v, masked) {
  if (masked && v !== null && v !== '' && typeof v !== 'boolean') return h('span', { class: 'z' }, '"••••••"');
  if (v === null) return h('span', { class: 'z' }, 'null');
  if (typeof v === 'string') return h('span', { class: 's' }, JSON.stringify(v));
  if (typeof v === 'number') return h('span', { class: 'n' }, String(v));
  if (typeof v === 'boolean') return h('span', { class: 'b' }, String(v));
  return h('span', {}, String(v));
}

/** Two strings with the part that differs marked, e.g. Host(`a`) -> Host(`b`). */
function changedStrings(a, b) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let q = 0;
  while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
  const part = (s) => h('span', { class: 's' }, s.slice(0, p), h('mark', { class: 'tl-dx' }, s.slice(p, s.length - q)), s.slice(s.length - q));
  return [part(x), part(y)];
}

const keyEl = (key) => (key === null || key === undefined ? null : [h('span', { class: 'k' }, JSON.stringify(key)), ': ']);

/**
 * The rows of a diff. Row: { d, kind: 'same' | 'add' | 'del' | 'mod' | 'fold', left, right, path }
 * left/right are arrays of nodes; null means "no line on this side".
 */
function rowsOf(node, { full = false, folds = new Set(), mask = true } = {}) {
  const rows = [];
  const line = (d, kind, left, right, extra = {}) => rows.push({ d, kind, left, right, ...extra });

  // a whole value as lines, for one side
  const secret = (key) => mask && key !== null && SECRET.test(key);
  const valueLines = (v, key, d, masked, emit) => {
    const m = masked || secret(key);
    if (!isComposite(v) || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length)) {
      emit(d, [keyEl(key), isComposite(v) ? (Array.isArray(v) ? '[]' : '{}') : scalar(v, m)]);
      return;
    }
    const arr = Array.isArray(v);
    emit(d, [keyEl(key), arr ? '[' : '{']);
    if (arr) v.forEach((x) => valueLines(x, null, d + 1, m, emit));
    else for (const [k, x] of Object.entries(v)) valueLines(x, k, d + 1, m, emit);
    emit(d, [arr ? ']' : '}']);
  };

  const walk = (n, key, d, path, masked) => {
    const m = masked || secret(key);
    if (n.t === 'same') { valueLines(n.a, key, d, m, (dd, parts) => line(dd, 'same', parts, parts)); return; }
    if (n.t === 'add') { valueLines(n.b, key, d, m, (dd, parts) => line(dd, 'add', null, parts)); return; }
    if (n.t === 'del') { valueLines(n.a, key, d, m, (dd, parts) => line(dd, 'del', parts, null)); return; }
    if (n.t === 'mod') {
      if (!isComposite(n.a) && !isComposite(n.b)) {
        const [x, y] = typeof n.a === 'string' && typeof n.b === 'string' && !m ? changedStrings(n.a, n.b) : [scalar(n.a, m), scalar(n.b, m)];
        line(d, 'mod', [keyEl(key), x], [keyEl(key), y]);
      } else {
        valueLines(n.a, key, d, m, (dd, parts) => line(dd, 'del', parts, null));
        valueLines(n.b, key, d, m, (dd, parts) => line(dd, 'add', null, parts));
      }
      return;
    }
    const arr = n.t === 'arr';
    line(d, 'same', [keyEl(key), arr ? '[' : '{'], [keyEl(key), arr ? '[' : '{']);
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const p = `${path}/@${run[0].i}`;
      if (!full && run.length > 1 && !folds.has(p)) {
        line(d + 1, 'fold', null, null, { count: run.length, path: p, arr });
      } else run.forEach(({ key: k, node: c }) => walk(c, arr ? null : k, d + 1, `${path}/${k}`, m));
      run = [];
    };
    n.kids.forEach(({ key: k, node: c }, i) => {
      if (c.t === 'same') run.push({ key: k, node: c, i });
      else { flush(); walk(c, arr ? null : k, d + 1, `${path}/${arr ? i : k}`, m); }
    });
    flush();
    line(d, 'same', [arr ? ']' : '}'], [arr ? ']' : '}']);
  };
  walk(node, null, 0, '', false);
  return rows;
}

/**
 * A diff view of two values. opts: { mode: 'split' | 'unified', full: show unchanged parts too,
 * mask: hide secret-looking values, ignore: top-level keys to leave out }.
 */
export function diffView(before, after, { mode = 'split', full = false, mask = true, ignore = ['serverStatus'] } = {}) {
  const strip = (o) => (isObj(o) ? Object.fromEntries(Object.entries(o).filter(([k]) => !ignore.includes(k))) : o);
  const tree = diff(strip(before ?? {}), strip(after ?? {}));
  const folds = new Set();
  const el = h('div', { class: `tl-diff ${mode}` });

  const paint = () => {
    const rows = rowsOf(tree, { full, folds, mask });
    const cell = (parts, kind, side, d) => h('div', { class: `tl-dc ${parts ? kind : 'none'} ${side}`, style: { '--d': d } },
      h('span', { class: 'tl-dg' }, parts ? (kind === 'add' ? '+' : kind === 'del' ? '−' : kind === 'mod' ? (side === 'l' ? '−' : '+') : '') : ''),
      h('span', { class: 'tl-dt' }, parts ?? ''));
    const out = [];
    // a node can sit in one place only: an unchanged line needs its own copy for the right side
    const clone = (parts) => parts.map((x) => (Array.isArray(x) ? clone(x) : x instanceof Node ? x.cloneNode(true) : x));
    for (const r of rows) {
      if (r.left && r.left === r.right) r.right = clone(r.left);
      if (r.kind === 'fold') {
        out.push(h('button', { type: 'button', class: 'tl-dfold', style: { '--d': r.d }, onclick: () => { folds.add(r.path); paint(); } },
          h('span', { class: 'tl-dfold-dots' }, '⋯'), `${r.count} unchanged ${r.arr ? 'items' : 'fields'}`));
        continue;
      }
      if (mode === 'split') out.push(h('div', { class: `tl-dr ${r.kind}` }, cell(r.left, r.kind, 'l', r.d), cell(r.right, r.kind, 'r', r.d)));
      else if (r.kind === 'mod') { out.push(h('div', { class: 'tl-dr del' }, cell(r.left, 'del', 'u', r.d))); out.push(h('div', { class: 'tl-dr add' }, cell(r.right, 'add', 'u', r.d))); }
      else out.push(h('div', { class: `tl-dr ${r.kind}` }, cell(r.left ?? r.right, r.kind, 'u', r.d)));
    }
    el.replaceChildren(...out);
  };
  paint();
  el.stats = stats(tree);
  return el;
}
