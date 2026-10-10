// A sortable table that keeps its rows between updates: a row is rebuilt only when its data changed,
// so live pages do not flicker and hover states survive. On phones every row becomes a small card
// (CSS in css/graph.css): the first column is the title, the others get their label from data-label.
//
// columns: [{ key, label, render(row) -> node, sort(row) -> value, num, tight, cls, mobile: false }]
import { h, icon } from './dom.js';

export function liveTable(columns, { rowKey = (r) => r.name, sig = (r) => JSON.stringify(r), rowClick, rowClass, empty = 'Nothing here', sortBy = null, desc = false, onsort } = {}) {
  let data = [];
  let sort = sortBy;
  let dir = desc ? -1 : 1;
  const cache = new Map(); // key -> { tr, sig }
  const thead = h('thead');
  const tbody = h('tbody');
  const el = h('div', { class: 'table-wrap gr-table-wrap' }, h('table', { class: 'table gr-table' }, thead, tbody));

  function head() {
    thead.replaceChildren(h('tr', {}, ...columns.map((c) => h('th', {
      class: [c.sort ? 'sortable' : '', c.num ? 'num' : '', c.tight ? 'tight' : '', c.cls ?? ''].join(' ').trim(),
      style: c.width ? { width: c.width } : undefined,
      onclick: c.sort ? () => { if (sort === c.key) dir = -dir; else { sort = c.key; dir = c.num ? -1 : 1; } onsort?.(sort, dir); render(); } : undefined,
    }, c.label, sort === c.key ? h('span', { class: 'arrow' }, dir > 0 ? '▲' : '▼') : null))));
  }

  function build(row, flash) {
    const tr = h('tr', {
      class: [rowClick ? 'clickable' : '', rowClass?.(row) ?? '', flash ? 'gr-row-flash' : ''].join(' ').trim(),
      onclick: rowClick ? (e) => { if (!e.target.closest('a,button,input')) rowClick(row); } : undefined,
    }, ...columns.map((c, i) => h('td', {
      class: [c.num ? 'num' : '', c.tight ? 'tight' : '', c.cls ?? '', i === 0 ? 'gr-td-title' : '', c.mobile === false ? 'gr-td-hide' : ''].join(' ').trim(),
      'data-label': c.label || null,
    }, c.render ? c.render(row) : row[c.key])));
    return tr;
  }

  function sorted() {
    const col = columns.find((c) => c.key === sort);
    if (!col?.sort) return data;
    return [...data].sort((a, b) => {
      const x = col.sort(a); const y = col.sort(b);
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x > y ? 1 : -1) * dir;
    });
  }

  function render() {
    head();
    const list = sorted();
    if (!list.length) {
      cache.clear();
      tbody.replaceChildren(h('tr', { class: 'gr-empty-row' }, h('td', { colspan: columns.length }, h('div', { class: 'empty' }, icon('search', { size: 22 }), h('div', {}, empty)))));
      return;
    }
    const keep = new Set();
    const rows = list.map((row) => {
      const k = rowKey(row);
      keep.add(k);
      const sg = sig(row);
      const old = cache.get(k);
      if (old && old.sig === sg) return old.tr;
      const tr = build(row, Boolean(old));
      cache.set(k, { tr, sig: sg });
      return tr;
    });
    for (const k of [...cache.keys()]) if (!keep.has(k)) cache.delete(k);
    // move only what is out of place, so untouched rows keep their DOM and animations
    tbody.querySelector('.gr-empty-row')?.remove();
    rows.forEach((tr, i) => { if (tbody.children[i] !== tr) tbody.insertBefore(tr, tbody.children[i] ?? null); });
    while (tbody.children.length > rows.length) tbody.lastElementChild.remove();
  }

  head();
  return {
    el,
    update(next) { data = next; render(); },
    refresh() { cache.clear(); render(); },
    get sort() { return [sort, dir]; },
  };
}
