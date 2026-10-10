// Change history: every router, service and middleware that appeared, changed or went away, servers
// going down and coming back, and Traefik restarts, as a timeline with a diff for every change.
import { h, icon } from '../lib/dom.js';
import { store, api, find } from '../lib/store.js';
import { pageHead, hrefFor, timeAgo, empty, searchInput, segmented, banner, skeleton } from '../lib/components.js';
import { split, plural, time } from '../lib/format.js';
import { diffView } from '../lib/diff.js';
import { codeBlock, copyBtn, download, maskDeep, ticon } from '../lib/tools-ui.js';

const TYPES = [
  { id: 'added', label: 'Added', icon: 'plus', tone: 'ok' },
  { id: 'changed', label: 'Changed', icon: 'refresh', tone: 'torch' },
  { id: 'removed', label: 'Removed', icon: 'minus', tone: 'bad' },
  { id: 'server-down', label: 'Server down', icon: 'alert', tone: 'bad' },
  { id: 'server-up', label: 'Server up', icon: 'ok', tone: 'ok' },
  { id: 'restart', label: 'Restarts', icon: 'zap', tone: 'violet' },
];
const KINDS = [['all', 'All'], ['routers', 'Routers'], ['services', 'Services'], ['middlewares', 'Middlewares']];
const PAGE = 60;
const MODE_KEY = 'enodia-diff-mode';

const whereOf = (e) => { const [proto, kind] = String(e.where ?? '').split('.'); return { proto, kind: kind ?? '' }; };
const single = (kind) => ({ routers: 'router', services: 'service', middlewares: 'middleware' }[kind] ?? kind);
const typeOf = (e) => TYPES.find((t) => t.id === e.type) ?? { id: e.type, label: e.type, icon: 'info', tone: '' };
const narrow = () => matchMedia('(max-width: 720px)').matches;

function dayLabel(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86_400_000);
  const long = day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(day.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
  return diff === 0 ? ['Today', long] : diff === 1 ? ['Yesterday', long] : [long, ''];
}

function describe(e) {
  const { proto, kind } = whereOf(e);
  const what = `${proto && proto !== 'http' ? `${proto.toUpperCase()} ` : ''}${single(kind)}`;
  switch (e.type) {
    case 'added': return { verb: `${what} added`, what };
    case 'removed': return { verb: `${what} removed`, what };
    case 'changed': return { verb: `${what} changed`, what };
    case 'server-down': return { verb: 'server went down', what };
    case 'server-up': return { verb: 'server came back', what };
    case 'restart': return { verb: `restarted${e.version ? ` on ${e.version}` : ''}`, what: 'Traefik' };
    default: return { verb: e.type, what };
  }
}

export default {
  render(ctx) {
    ctx.setCrumbs([['Change history']]);
    let events = [];
    let persistent = store.meta?.features?.persistentHistory ?? true;
    let type = TYPES.some((t) => t.id === ctx.query.get('type')) ? ctx.query.get('type') : 'all';
    let kind = KINDS.some(([k]) => k === ctx.query.get('kind')) ? ctx.query.get('kind') : 'all';
    let query = ctx.query.get('q') ?? '';
    let shown = PAGE;
    let loaded = false;
    let animateIn = true;
    let mode = (() => { try { return localStorage.getItem(MODE_KEY) || 'split'; } catch { return 'split'; } })();
    let full = false;
    const open = new Set();
    const fresh = new Set();

    const statsBox = h('div', { class: 'tl-chstats' });
    const activity = h('div', { class: 'tl-activity' });
    const typeChips = h('div', { class: 'tl-chips' });
    const kindSeg = h('div', { class: 'tl-seg-wrap' });
    const timeline = h('div', { class: 'tl-timeline' }, skeleton(6, 18));
    const noteBox = h('div');
    const exportBtn = h('button', { type: 'button', class: 'btn sm', onclick: () => download(`enodia-history-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(visible().map((e) => maskDeep(e)), null, 2)) }, icon('download', { size: 14 }), 'Export');
    const search = searchInput({ placeholder: 'Search names, fields, servers…', value: query, oninput: (v) => { query = v; shown = PAGE; paint(); } });

    const el = h('div', { class: 'col gap-lg tl-page' },
      pageHead({ title: 'Change history', icon: 'history', sub: 'Every router, service and middleware that appeared, changed or went away, as Traefik reported it. Open a change to see exactly what moved.', actions: [exportBtn] }),
      noteBox,
      h('section', { class: 'card tl-chsummary' }, statsBox, activity),
      h('div', { class: 'tl-toolbar' },
        h('div', { class: 'tl-toolbar-row' }, h('div', { class: 'tl-grow-search' }, search), kindSeg),
        typeChips),
      timeline);

    const matches = (e) => {
      if (type !== 'all' && e.type !== type) return false;
      if (kind !== 'all' && whereOf(e).kind !== kind) return false;
      if (!query.trim()) return true;
      const hay = `${e.name ?? ''} ${e.where ?? ''} ${e.type} ${(e.fields ?? []).join(' ')} ${e.server ?? ''} ${e.version ?? ''}`.toLowerCase();
      return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
    };
    const visible = () => events.filter(matches);

    function merge(list) {
      const byId = new Map(events.map((e) => [e.id ?? `${e.at}|${e.type}|${e.name}`, e]));
      for (const e of list) byId.set(e.id ?? `${e.at}|${e.type}|${e.name}`, e);
      events = [...byId.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    }

    function paintNote() {
      if (persistent) { noteBox.replaceChildren(); return; }
      const how = h('div', { class: 'tl-note-how', hidden: true }, codeBlock([
        { label: 'Docker compose', lang: 'yaml', code: ['services:', '  enodia:', '    image: ghcr.io/georgemos940/enodia:latest', '    environment:', '      ENODIA_DATA_DIR: /data      # already set in the official image', '    volumes:', '      - enodia-data:/data', '', 'volumes:', '  enodia-data:'].join('\n') },
        { label: 'Environment', lang: 'env', code: 'ENODIA_DATA_DIR=/var/lib/enodia' },
      ]));
      const btn = h('button', { type: 'button', class: 'btn sm', onclick: () => { how.hidden = !how.hidden; btn.replaceChildren(how.hidden ? 'Show how' : 'Hide'); } }, 'Show how');
      noteBox.replaceChildren(h('div', { class: 'col', style: { gap: '10px' } },
        banner('info', 'This history lives in memory only', 'Enodia forgets it when it restarts. Point ENODIA_DATA_DIR at a directory on a volume and every change is kept in history.json there.', btn), how));
    }

    function paintStats() {
      const count = (id) => events.filter((e) => e.type === id && (kind === 'all' || whereOf(e).kind === kind)).length;
      const last = events[0];
      statsBox.replaceChildren(
        h('div', { class: 'tl-chstat-main' },
          h('div', { class: 'tl-mini-label' }, 'Recorded'),
          h('div', { class: 'tl-chstat-big tnum' }, String(events.length)),
          h('div', { class: 'small muted' }, last ? ['last ', timeAgo(last.at)] : 'nothing yet'),
          h('div', { class: 'tl-chstat-live' }, h('span', { class: 'dot ok pulse' }), `Watching, every ${store.meta?.pollSeconds ?? 5} s`)),
        h('div', { class: 'tl-chstat-types' }, ...TYPES.map((t) => h('button', { type: 'button', class: `tl-chtype ${t.tone} ${type === t.id ? 'on' : ''} ${count(t.id) ? '' : 'zero'}`.trim(), onclick: () => setType(type === t.id ? 'all' : t.id) },
          h('span', { class: 'tl-chtype-ic' }, ticon(t.icon, { size: 14 })), h('span', { class: 'tl-chtype-label' }, t.label), h('b', { class: 'tnum' }, String(count(t.id)))))));
    }

    function paintActivity() {
      const now = Date.now();
      const recent = events.some((e) => now - Date.parse(e.at) < 86_400_000);
      const n = recent ? 24 : 14;
      const step = recent ? 3_600_000 : 86_400_000;
      const end = recent ? Math.ceil(now / step) * step : (() => { const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime(); })();
      const buckets = Array.from({ length: n }, (_, i) => ({ from: end - (n - i) * step, config: 0, servers: 0, restarts: 0 }));
      for (const e of events) {
        const i = Math.floor((Date.parse(e.at) - (end - n * step)) / step);
        if (i < 0 || i >= n) continue;
        if (e.type === 'restart') buckets[i].restarts++;
        else if (e.type.startsWith('server')) buckets[i].servers++;
        else buckets[i].config++;
      }
      const max = Math.max(1, ...buckets.map((b) => b.config + b.servers + b.restarts));
      const fmt = (t) => (recent ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
      activity.replaceChildren(
        h('div', { class: 'tl-activity-head' }, h('span', { class: 'tl-mini-label' }, recent ? 'Last 24 hours' : 'Last 14 days'),
          h('div', { class: 'legend' }, h('span', {}, h('i', { style: { background: 'var(--torch)' } }), 'configuration'), h('span', {}, h('i', { style: { background: 'var(--bad)' } }), 'servers'), h('span', {}, h('i', { style: { background: 'var(--violet)' } }), 'restarts'))),
        h('div', { class: 'tl-activity-bars' }, ...buckets.map((b, i) => {
          const total = b.config + b.servers + b.restarts;
          const seg = (v, cls) => (v ? h('span', { class: cls, style: { height: `${(v / max) * 100}%` } }) : null);
          return h('div', { class: `tl-abar ${total ? '' : 'idle'}`.trim(), title: `${fmt(b.from)}: ${total ? plural(total, 'change') : 'no changes'}`, style: { '--i': i } },
            h('div', { class: 'tl-abar-stack' }, seg(b.restarts, 'r'), seg(b.servers, 's'), seg(b.config, 'c')));
        })),
        h('div', { class: 'tl-activity-axis' }, h('span', {}, fmt(buckets[0].from)), h('span', {}, recent ? 'now' : 'today')));
      // the bars grow in once; live updates just redraw them
      requestAnimationFrame(() => setTimeout(() => activity.classList.add('tl-still'), 1200));
    }

    function paintFilters() {
      const count = (id) => events.filter((e) => (id === 'all' || e.type === id) && (kind === 'all' || whereOf(e).kind === kind)).length;
      typeChips.replaceChildren(
        h('button', { type: 'button', class: `tl-chip ${type === 'all' ? 'on' : ''}`, onclick: () => setType('all') }, 'Everything', h('span', { class: 'tl-chip-n tnum' }, String(count('all')))),
        ...TYPES.map((t) => h('button', { type: 'button', class: `tl-chip ${type === t.id ? 'on' : ''} ${count(t.id) ? '' : 'zero'}`.trim(), onclick: () => setType(type === t.id ? 'all' : t.id) },
          h('span', { class: `tl-chip-dot ${t.tone}` }), t.label, h('span', { class: 'tl-chip-n tnum' }, String(count(t.id))))));
      kindSeg.replaceChildren(segmented(KINDS, kind, (v) => { kind = v; shown = PAGE; paintStats(); paintFilters(); paint(); }));
    }
    function setType(v) { type = v; shown = PAGE; paintStats(); paintFilters(); paint(); }

    function resourceLink(e) {
      const { proto, kind: k } = whereOf(e);
      if (!['routers', 'services', 'middlewares'].includes(k)) return null;
      const exists = find(k, e.name, proto);
      return exists ? hrefFor(k, e.name, proto) : null;
    }

    function diffFor(e) {
      const before = e.type === 'added' ? {} : e.before;
      const after = e.type === 'removed' ? {} : e.after;
      return diffView(before, after, { mode: narrow() ? 'unified' : mode, full: full || e.type !== 'changed' });
    }

    function eventRow(e, i) {
      const t = typeOf(e);
      const { what, verb } = describe(e);
      const { base, provider } = split(e.name ?? '');
      const href = resourceLink(e);
      const diffable = (e.type === 'changed' && e.before && e.after) || (e.type === 'added' && e.after) || (e.type === 'removed' && e.before);
      const isOpen = open.has(e.id);
      const body = h('div', { class: 'tl-ev-body' });
      const fillBody = () => {
        if (!diffable) return;
        const view = diffFor(e);
        const st = view.stats;
        const tools = h('div', { class: 'tl-ev-tools' },
          e.type === 'changed' ? h('div', { class: 'tl-diffstat' }, st.add ? h('span', { class: 'ok-text' }, `+${st.add}`) : null, st.mod ? h('span', { class: 'torch-text' }, `~${st.mod}`) : null, st.del ? h('span', { class: 'bad-text' }, `−${st.del}`) : null, h('span', { class: 'muted' }, plural(st.add + st.mod + st.del, 'value'))) : h('span', { class: 'small muted' }, e.type === 'added' ? 'The new configuration' : 'The configuration it had'),
          h('span', { class: 'grow' }),
          e.type === 'changed' ? h('div', { class: 'tl-hide-sm' }, segmented([['split', h('span', { class: 'row', style: { gap: '5px' } }, ticon('split', { size: 13 }), 'Split')], ['unified', h('span', { class: 'row', style: { gap: '5px' } }, ticon('rows', { size: 13 }), 'Unified')]], mode, (v) => { mode = v; try { localStorage.setItem(MODE_KEY, v); } catch { /* private */ } refreshOpen(); })) : null,
          e.type === 'changed' ? h('button', { type: 'button', class: `btn sm ${full ? 'tl-on' : 'ghost'}`, title: 'Show unchanged fields too', onclick: () => { full = !full; refreshOpen(); } }, ticon(full ? 'fold' : 'unfold', { size: 14 }), full ? 'Only changes' : 'Everything') : null,
          copyBtn(() => JSON.stringify(maskDeep(e.type === 'removed' ? e.before : e.after), null, 2), { label: '', toastText: 'JSON copied', cls: 'btn sm ghost icon-only' }));
        body.replaceChildren(h('div', { class: 'tl-ev-inner' },
          e.type === 'changed' && mode === 'split' && !narrow() ? h('div', { class: 'tl-diff-cols' }, h('span', {}, 'Before'), h('span', {}, 'After ', h('span', { class: 'faint' }, time(e.at)))) : null,
          tools, view));
      };
      if (isOpen) fillBody();
      const toggle = () => {
        if (!diffable) return;
        const now = !open.has(e.id);
        if (now) { open.add(e.id); fillBody(); } else open.delete(e.id);
        row.classList.toggle('open', now);
        head.setAttribute('aria-expanded', String(now));
      };
      const sub = e.type === 'changed' && e.fields?.length
        ? h('div', { class: 'tl-ev-fields' }, ...e.fields.slice(0, 6).map((f) => h('span', { class: 'tl-field' }, f)), e.fields.length > 6 ? h('span', { class: 'tl-field more' }, `+${e.fields.length - 6}`) : null)
        : e.server ? h('div', { class: 'tl-ev-fields' }, h('span', { class: `tl-field mono ${e.type === 'server-down' ? 'bad' : 'ok'}` }, e.server))
          : null;
      const head = h('div', { class: `tl-ev-head ${diffable ? 'clickable' : ''}`.trim(), role: diffable ? 'button' : null, tabindex: diffable ? '0' : null, 'aria-expanded': diffable ? String(isOpen) : null, onclick: toggle, onkeydown: (ev) => { if (ev.target === head && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); toggle(); } } },
        h('div', { class: 'tl-ev-main' },
          h('div', { class: 'tl-ev-title' },
            e.type === 'restart' ? h('span', { class: 'bold' }, 'Traefik') : href
              ? h('a', { class: 'tl-ev-name', href, onclick: (ev) => ev.stopPropagation(), title: `Open ${what} ${e.name}` }, base, provider ? h('span', { class: 'faint' }, `@${provider}`) : null)
              : h('span', { class: 'tl-ev-name gone', title: e.type === 'removed' ? 'No longer exists' : '' }, base, provider ? h('span', { class: 'faint' }, `@${provider}`) : null),
            h('span', { class: 'tl-ev-verb' }, verb)),
          sub),
        h('div', { class: 'tl-ev-time' }, h('span', { class: 'tnum' }, time(e.at)), h('span', { class: 'tiny muted' }, timeAgo(e.at))),
        diffable ? h('span', { class: 'tl-f-chev' }, icon('down', { size: 16 })) : h('span', { class: 'tl-ev-spacer' }));
      const row = h('li', { class: `tl-ev ${t.tone} ${isOpen ? 'open' : ''} ${fresh.has(e.id) ? 'tl-new' : ''}`.trim(), dataset: { id: e.id ?? '' } },
        h('span', { class: `tl-ev-node ${t.tone}`, title: t.label }, ticon(t.icon, { size: 13, stroke: 2.2 })),
        h('div', { class: 'tl-ev-card' }, head, body));
      row.refresh = () => { if (open.has(e.id)) fillBody(); };
      if (i < 16 && animateIn) { row.classList.add('tl-rise'); row.style.setProperty('--i', String(i)); }
      return row;
    }

    function refreshOpen() { timeline.querySelectorAll('.tl-ev.open').forEach((r) => r.refresh?.()); }

    function paint() {
      if (!loaded) return;
      const list = visible();
      if (!events.length) {
        timeline.replaceChildren(h('div', { class: 'card tl-chempty' },
          h('div', { class: 'tl-chempty-art', 'aria-hidden': 'true' }, h('span', {}), h('span', {}), h('span', {}), icon('history', { size: 26 })),
          h('div', { class: 'empty-title' }, 'No changes seen yet'),
          h('p', { class: 'muted small' }, `Enodia compares every poll with the one before. Add, change or remove a router, service or middleware and it shows up here within ${store.meta?.pollSeconds ?? 5} seconds, with a diff of what moved.`)));
        return;
      }
      if (!list.length) { timeline.replaceChildren(h('div', { class: 'card' }, empty('No change matches', 'Try another search, or clear the filters.', 'search'))); return; }
      const days = new Map();
      for (const e of list.slice(0, shown)) {
        const k = new Date(e.at).toDateString();
        if (!days.has(k)) days.set(k, []);
        days.get(k).push(e);
      }
      let i = 0;
      timeline.replaceChildren(
        ...[...days.entries()].map(([k, evs]) => {
          const [title, sub] = dayLabel(k);
          return h('section', { class: 'tl-day' },
            h('div', { class: 'tl-day-head' }, h('span', { class: 'tl-day-dot' }), h('h3', {}, title), sub ? h('span', { class: 'muted small tl-hide-sm' }, sub) : null, h('span', { class: 'tl-sev-n tnum' }, String(evs.length))),
            h('ol', { class: 'tl-evs' }, ...evs.map((e, j) => {
              const row = eventRow(e, i++);
              // changes seen in the same poll share a timestamp: draw them as one burst
              if (j && evs[j - 1].at === e.at) row.classList.add('tl-cont');
              return row;
            })));
        }),
        list.length > shown ? h('div', { class: 'tl-more' }, h('button', { type: 'button', class: 'btn', onclick: () => { shown += PAGE * 2; paint(); } }, `Show more (${list.length - shown} older)`)) : null);
      fresh.clear();
      animateIn = false;
    }

    async function load() {
      try {
        const r = await api('history?limit=1000');
        persistent = r.persistent;
        merge(r.events ?? []);
      } catch { /* the store's session history is still there */ }
      merge(store.history ?? []);
      paintNote();
      loaded = true;
      paintStats(); paintActivity(); paintFilters();
      paint();
    }

    paintStats(); paintActivity(); paintFilters();
    load();

    return {
      el,
      update(event) {
        if (event !== 'history') return;
        const before = new Set(events.map((e) => e.id));
        merge(store.history ?? []);
        for (const e of events) if (!before.has(e.id)) fresh.add(e.id);
        paintStats(); paintActivity(); paintFilters(); paint();
      },
    };
  },
};
