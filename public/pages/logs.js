// The access log, live: every request Traefik writes, as it happens. Filters live in the address bar,
// the histogram and the facets follow them, and any line opens with everything Traefik recorded.
import { h, icon } from '../lib/dom.js';
import { store, api, all } from '../lib/store.js';
import { hrefFor, segmented, banner, drawer, kv, jsonView, copy, toast, timeAgo, searchInput } from '../lib/components.js';
import { countTo } from '../lib/charts.js';
import { rate, pct, bytes, num, split } from '../lib/format.js';
import { barList, oicon, guide, code, setHashQuery, hashQuery, statusText, METHOD_COLOR, download, menuButton, showTip, hideTip } from '../lib/observe.js';

const FILTERS = ['q', 'status', 'method', 'router', 'service', 'host', 'client', 'minMs'];
const LABEL = { q: 'search', status: 'status', method: 'method', router: 'router', service: 'service', host: 'host', client: 'client', minMs: 'slower than' };
const DURATIONS = [['', 'Any duration'], ['100', '≥ 100 ms'], ['250', '≥ 250 ms'], ['500', '≥ 500 ms'], ['1000', '≥ 1 s'], ['3000', '≥ 3 s']];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const PAGE = 400;       // entries per fetch
const KEEP = 6000;      // entries the list holds while following
const CSV_COLS = ['t', 'status', 'method', 'scheme', 'host', 'path', 'protocol', 'router', 'service', 'server', 'entrypoint', 'client', 'user', 'durationMs', 'originMs', 'overheadMs', 'size', 'retries', 'tls', 'ua', 'referer'];

const pad = (n, w = 2) => String(n).padStart(w, '0');
const clock = (t) => { const d = new Date(t); return Number.isNaN(d.getTime()) ? '—' : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
const shortMs = (v) => (v === null || v === undefined ? '—' : v < 10 ? `${v.toFixed(1)} ms` : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`);
const durTone = (v) => (v >= 1000 ? 'var(--ob-bad)' : v >= 300 ? 'var(--ob-warn)' : v >= 100 ? 'var(--torch)' : 'var(--ob-ok)');
const durFrac = (v) => Math.min(1, Math.log10(1 + Math.max(0, v ?? 0)) / 4); // 10 s fills the bar
const serverShort = (u) => String(u).replace(/^https?:\/\//, '');
const statusClass = (s) => Math.floor((s ?? 0) / 100);
const clean = (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v !== null && v !== undefined));
const qs = (o) => new URLSearchParams(clean(o)).toString();
const debounce = (fn, wait) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; };

/** The server's filter, in the browser, for lines that arrive live. */
function matcher(f) {
  const needle = (f.q || '').toLowerCase();
  const minMs = Number(f.minMs) || 0;
  return (e) => {
    if (f.status) {
      if (/^[1-5]xx$/.test(f.status)) { if (statusClass(e.status) !== Number(f.status[0])) return false; }
      else if (String(e.status) !== f.status) return false;
    }
    if (f.router && e.router !== f.router) return false;
    if (f.service && e.service !== f.service) return false;
    if (f.client && e.client !== f.client) return false;
    if (f.host && e.host !== f.host) return false;
    if (f.method && e.method !== f.method) return false;
    if (minMs && !(e.durationMs >= minMs)) return false;
    if (needle && ![e.host, e.path, e.client, e.router, e.service, e.ua].some((v) => v && v.toLowerCase().includes(needle))) return false;
    return true;
  };
}

function csv(rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // a spreadsheet must not read a request path as a formula
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [CSV_COLS.join(','), ...rows.map((e) => CSV_COLS.map((c) => cell(e[c])).join(','))].join('\r\n');
}

function curlFor(e) {
  const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
  const parts = ['curl -i'];
  if (e.method && e.method !== 'GET') parts.push(`-X ${e.method}`);
  parts.push(q(`${e.scheme || 'http'}://${e.host ?? 'localhost'}${e.path ?? '/'}`));
  if (e.ua) parts.push(`-H ${q(`User-Agent: ${e.ua}`)}`);
  if (e.referer) parts.push(`-H ${q(`Referer: ${e.referer}`)}`);
  return parts.join(' ');
}

function logsGuide({ error = null, clf = false } = {}) {
  const json = { label: 'traefik.yml', lang: 'yaml', text: 'accessLog:\n  filePath: /var/log/traefik/access.log\n  format: json\n  bufferingSize: 100        # write in small batches\n  fields:\n    headers:\n      names:\n        User-Agent: keep      # headers are dropped unless kept\n        Referer: keep' };
  const flags = { label: 'CLI flags', lang: 'sh', text: '--accesslog=true\n--accesslog.filepath=/var/log/traefik/access.log\n--accesslog.format=json\n--accesslog.fields.headers.names.User-Agent=keep\n--accesslog.fields.headers.names.Referer=keep' };
  const steps = [{
    title: clf ? 'Switch the format to JSON' : 'Write the access log as JSON',
    text: clf
      ? 'Traefik writes the Common Log Format unless told otherwise. It has no router, service or timings, so Enodia skips those lines. Keep the same file and add one setting:'
      : 'JSON lines carry the router, service, backend and timings of every request. Keep the User-Agent and Referer headers to see them here.',
    snippets: [json, flags],
  }];
  if (!clf) {
    steps.push({
      title: 'Share the folder with Enodia',
      text: ['Mount it read-only at ', code('/var/log/traefik'), ', where Enodia looks on its own, or anywhere else with ', code('TRAEFIK_ACCESS_LOG'), ' set to the file. On Kubernetes, run Enodia as a sidecar sharing an emptyDir with Traefik.'],
      snippets: [{ label: 'docker-compose.yml', lang: 'yaml', text: 'services:\n  traefik:\n    image: traefik:v3\n    volumes:\n      - traefik-logs:/var/log/traefik\n\n  enodia:\n    image: ghcr.io/georgemos940/enodia:latest\n    environment:\n      TRAEFIK_ACCESS_LOG: /var/log/traefik/access.log\n    volumes:\n      - traefik-logs:/var/log/traefik:ro\n\nvolumes:\n  traefik-logs:' }],
    });
  }
  steps.push({ title: 'Restart Traefik and watch requests stream in', text: 'Enodia follows the file like tail -F: rotation and truncation are fine. It keeps the most recent 10,000 requests in memory (ENODIA_LOG_KEEP), never the whole file.' });
  return guide({
    icon: 'terminal',
    title: clf ? 'This access log is in the wrong format' : 'See every request as it happens',
    text: clf ? 'Enodia found the access log, but its lines are plain text.' : 'Turn on Traefik\'s access log in JSON and share the file with Enodia: you get a live tail, search, filters, facets and a detail view for every request.',
    steps,
    foot: error ? banner('warn', 'Enodia could not read the log', error) : null,
  });
}

export default {
  render(ctx) {
    ctx.setCrumbs([['Access log']]);
    const el = h('div', { class: 'col gap-lg ob ob-logs' });
    const timers = [];
    const every = (fn, msec) => { const id = setInterval(() => { if (!el.isConnected) { timers.forEach(clearInterval); return; } fn(); }, msec); timers.push(id); };
    let view = null;

    // waits for the log to appear (auto mode finds it on its own) and then builds the explorer
    function showGuide(opts) {
      el.replaceChildren(h('div', { class: 'page-head ob-head' }, h('div', { class: 'grow' }, h('h1', { class: 'page-title' }, icon('logs', { size: 24, cls: 'torch-text' }), 'Access log'))), logsGuide(opts),
        h('div', { class: 'ob-waiting' }, h('span', { class: 'dot warn pulse' }), 'Checking for the log every few seconds…'));
      const id = setInterval(async () => {
        if (!el.isConnected) { clearInterval(id); return; }
        try { const r = await api('logs?limit=1'); if (r.enabled && r.format !== 'clf' && r.ok !== false) { clearInterval(id); view = explorer(); } } catch { /* next time */ }
      }, 6000);
      timers.push(id);
    }

    if (store.meta?.features?.logs === false) showGuide({});
    else view = explorer();

    function explorer() {
      const query = hashQuery();
      const f = Object.fromEntries(FILTERS.map((k) => [k, query.get(k) ?? '']));
      let match = matcher(f);
      let rows = [];               // the filtered list, oldest first
      let gen = 0;
      let paused = false;
      let queued = [];
      let following = true;
      let unseen = 0;
      let hasOlder = false;
      let loadingOlder = false;
      let loading = true;
      let info = {};               // the last /api/logs answer, without entries
      let stats = null;
      let narrow = false;
      let raf = 0;
      const pool = new Map();      // entry id -> row element
      const arrived = new Map();   // entry id -> when it came in live

      // ── head ──

      const liveBtn = h('button', { type: 'button', class: 'btn ob-live-btn', onclick: () => setPaused(!paused) });
      const exportBtn = menuButton(h('button', { type: 'button', class: 'btn' }, icon('download', { size: 14 }), h('span', { class: 'ob-hide-sm' }, 'Export'), icon('down', { size: 13 })), () => [
        { label: 'Download as JSON', icon: 'file', hint: num(rows.length), run: () => exportAs('json') },
        { label: 'Download as CSV', icon: 'file', hint: num(rows.length), run: () => exportAs('csv') },
        '-',
        { label: 'Copy as JSON', icon: 'copy', run: () => copy(JSON.stringify(rows, null, 2), `${num(rows.length)} requests copied`) },
      ]);
      const sub = h('p', { class: 'page-sub' }, 'Every request Traefik writes, live.');
      const head = h('div', { class: 'page-head ob-head' },
        h('div', { class: 'grow' }, h('h1', { class: 'page-title' }, icon('logs', { size: 24, cls: 'torch-text' }), 'Access log'), sub),
        h('div', { class: 'ob-head-tools' }, liveBtn, exportBtn));
      const notes = h('div', { class: 'col', style: { gap: '0' } });

      // ── summary and histogram ──

      const nums = {};
      const numBox = (key, label, tone) => h('div', { class: 'ob-sum-num' }, h('span', { class: 'ob-sum-label' }, label), nums[key] = h('b', { class: `tnum ${tone ?? ''}`.trim() }, '—'));
      const hist = h('div', { class: 'ob-hist', role: 'img', 'aria-label': 'Requests over time' });
      const histAxis = h('div', { class: 'ob-hist-axis' });
      let histCols = [];
      let histData = null;
      const summary = h('section', { class: 'card ob-sum' },
        h('div', { class: 'ob-sum-nums' }, numBox('count', 'Requests'), numBox('rps', 'Per second'), numBox('err', 'Server errors'), numBox('p50', 'p50'), numBox('p95', 'p95'), numBox('p99', 'p99')),
        h('div', { class: 'ob-hist-wrap' }, hist, histAxis),
        h('div', { class: 'legend ob-hist-legend' }, ...[['2xx', 'var(--c2xx)'], ['3xx', 'var(--c3xx)'], ['4xx', 'var(--c4xx)'], ['5xx', 'var(--c5xx)']].map(([l, c]) => h('span', {}, h('i', { style: { background: c } }), l))));

      function paintHist(d) {
        const prev = histData;
        histData = d;
        const max = Math.max(1, ...d.buckets.map((b) => b.n));
        if (histCols.length !== d.buckets.length) {
          histCols = d.buckets.map(() => {
            const segs = [5, 4, 3, 2].map((c) => h('i', { class: `c${c}` }));
            const stack = h('span', { class: 'ob-hist-stack' }, ...segs);
            const col = h('span', { class: 'ob-hist-col' }, stack);
            col.stack = stack;
            col.segs = segs;
            return col;
          });
          hist.replaceChildren(...histCols);
        }
        hist.classList.toggle('shift', Boolean(prev && prev.from !== d.from));
        d.buckets.forEach((b, i) => {
          const col = histCols[i];
          col.stack.style.height = `${b.n ? Math.max(4, (b.n / max) * 100) : 0}%`;
          [5, 4, 3, 2].forEach((c, j) => { col.segs[j].style.flexGrow = String(b[`c${c}`]); });
          col.classList.toggle('now', i === d.buckets.length - 1);
        });
        const label = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', ...(d.step < 60_000 ? { second: '2-digit' } : {}) });
        histAxis.replaceChildren(h('span', {}, label(d.from)), h('span', {}, label(d.from + (d.to - d.from) / 2)), h('span', {}, 'now'));
        const last = d.buckets.length > 1 ? d.buckets[d.buckets.length - 2] : d.buckets[0];
        countTo(nums.rps, last ? last.n / (d.step / 1000) : 0, { format: rate });
      }
      const histTip = (ev) => {
        if (!histData) return;
        const r = hist.getBoundingClientRect();
        const i = Math.max(0, Math.min(histData.buckets.length - 1, Math.floor(((ev.clientX - r.left) / r.width) * histData.buckets.length)));
        const b = histData.buckets[i];
        histCols.forEach((c, j) => c.classList.toggle('hover', j === i));
        const t0 = new Date(b.t).toLocaleTimeString();
        showTip(ev.clientX, r.top,
          h('div', { class: 'small muted', style: { marginBottom: '4px' } }, `${t0} · ${histData.step / 1000}s`),
          ...[['c5', '5xx', 'var(--c5xx)'], ['c4', '4xx', 'var(--c4xx)'], ['c3', '3xx', 'var(--c3xx)'], ['c2', '2xx', 'var(--c2xx)']].filter(([k]) => b[k])
            .map(([k, l, c]) => h('div', { class: 'tip-row' }, h('span', { class: 'row', style: { gap: '6px' } }, h('i', { class: 'sw', style: { background: c } }), l), h('b', {}, num(b[k])))),
          h('div', { class: 'tip-row', style: { marginTop: '3px' } }, h('span', {}, 'per second'), h('b', {}, rate(b.n / (histData.step / 1000)))));
      };
      hist.addEventListener('pointermove', histTip);
      hist.addEventListener('pointerleave', () => { hideTip(); histCols.forEach((c) => c.classList.remove('hover')); });

      // ── filters ──

      const searchBox = searchInput({ placeholder: 'Search host, path, client, router, user agent…', value: f.q, oninput: debounce((v) => setFilter('q', v.trim(), true), 280) });
      const statusHold = h('div', { class: 'ob-status-seg' });
      const sel = (key, label) => h('select', { class: 'input ob-select', 'aria-label': label, onchange: (e) => setFilter(key, e.target.value) });
      const methodSel = sel('method', 'Method');
      const routerSel = sel('router', 'Router');
      const serviceSel = sel('service', 'Service');
      const durSel = sel('minMs', 'Duration');
      const facetsBtn = h('button', { type: 'button', class: 'btn ob-facets-btn', onclick: () => { main.classList.toggle('facets-open'); facetsBtn.classList.toggle('on'); } }, icon('filter', { size: 14 }), 'Facets');
      const chips = h('div', { class: 'ob-chips' });
      const filterBar = h('section', { class: 'card ob-filters' },
        h('div', { class: 'ob-filter-row' }, h('div', { class: 'ob-search' }, searchBox), statusHold),
        h('div', { class: 'ob-filter-row ob-filter-selects' }, facetsBtn, methodSel, routerSel, serviceSel, durSel),
        chips);

      function fillSelect(s, value, options, allLabel) {
        const list = [['', allLabel], ...options.map((o) => (Array.isArray(o) ? o : [o, o]))];
        if (value && !list.some(([v]) => v === value)) list.push([value, value]);
        const sig = JSON.stringify(list) + value;
        if (s.sig === sig) return;
        s.sig = sig;
        s.replaceChildren(...list.map(([v, l]) => h('option', { value: v }, l)));
        s.value = value;
        s.classList.toggle('on', Boolean(value));
      }
      function paintFilters() {
        if (statusHold.sig !== f.status) statusHold.replaceChildren(segmented([['', 'All'], ['2xx', '2xx'], ['3xx', '3xx'], ['4xx', '4xx'], ['5xx', '5xx']], /^[1-5]xx$/.test(f.status) || !f.status ? f.status : null, (v) => setFilter('status', v)));
        statusHold.sig = f.status;
        statusHold.querySelectorAll('button').forEach((b, i) => { if (i) b.classList.add(`ob-seg-s${i + 1}`); });
        fillSelect(methodSel, f.method, [...new Set([...METHODS, ...(stats?.methods ?? []).map((m) => m.key)])], 'Any method');
        const routers = [...new Set([...all('routers').filter((r) => r.proto === 'http').map((r) => r.name), ...(stats?.routers ?? []).map((r) => r.key)])].sort();
        fillSelect(routerSel, f.router, routers.map((r) => [r, split(r).base + (split(r).provider ? ` @${split(r).provider}` : '')]), 'Any router');
        const services = [...new Set([...all('services').filter((s) => s.proto === 'http').map((s) => s.name), ...(stats?.services ?? []).map((s) => s.key)])].sort();
        fillSelect(serviceSel, f.service, services.map((s) => [s, split(s).base + (split(s).provider ? ` @${split(s).provider}` : '')]), 'Any service');
        fillSelect(durSel, f.minMs, DURATIONS.slice(1), DURATIONS[0][1]);
        const active = FILTERS.filter((k) => f[k]);
        chips.replaceChildren(...active.map((k) => h('span', { class: 'ob-chip' }, h('span', { class: 'muted' }, LABEL[k]), h('b', {}, k === 'minMs' ? shortMs(Number(f[k])) : k === 'status' && !/xx$/.test(f[k]) ? `${f[k]} ${statusText(Number(f[k]))}` : f[k]),
          h('button', { type: 'button', title: `Clear ${LABEL[k]}`, onclick: () => setFilter(k, '') }, icon('x', { size: 12 })))),
        active.length > 1 ? h('button', { type: 'button', class: 'btn sm ghost', onclick: clearAll }, 'Clear all') : null);
        chips.hidden = !active.length;
        if (searchBox.querySelector('input') !== document.activeElement) searchBox.querySelector('input').value = f.q;
      }

      // ── the tail ──

      const R = () => (narrow ? 56 : 34);
      const scroller = h('div', { class: 'ob-tail', tabindex: '0', 'aria-label': 'Requests, newest at the bottom' });
      const space = h('div', { class: 'ob-tail-space' });
      const cap = h('div', { class: 'ob-tail-cap' });
      const overlay = h('div', { class: 'ob-tail-overlay', hidden: true });
      space.append(cap);
      scroller.append(space);
      const pill = h('button', { type: 'button', class: 'ob-new-pill', hidden: true, onclick: () => toBottom(true) });
      const footLeft = h('div', { class: 'ob-tail-state' });
      const footRight = h('div', { class: 'ob-tail-meta' });
      const tailHead = h('div', { class: 'ob-row ob-row-head' },
        h('span', { class: 'ob-c-time' }, 'Time'), h('span', { class: 'ob-c-st' }, 'Status'), h('span', { class: 'ob-c-m' }, 'Method'), h('span', { class: 'ob-c-req' }, 'Request'),
        h('span', { class: 'ob-c-router' }, 'Router'), h('span', { class: 'ob-c-svc' }, 'Service → server'), h('span', { class: 'ob-c-client' }, 'Client'),
        h('span', { class: 'ob-c-dur' }, 'Duration'), h('span', { class: 'ob-c-size' }, 'Size'));
      const tail = h('section', { class: 'card ob-tail-card' }, tailHead, h('div', { class: 'ob-tail-box' }, scroller, overlay, pill), h('div', { class: 'ob-tail-foot' }, footLeft, footRight));

      function rowEl(e) {
        const d = e.durationMs;
        const c = statusClass(e.status);
        return h('div', { class: `ob-row s${c}`, dataset: { id: String(e.id) } },
          h('span', { class: 'ob-c-time' }, clock(e.t)),
          h('span', { class: 'ob-c-st' }, h('span', { class: `ob-st s${c}` }, String(e.status ?? '—'))),
          h('span', { class: 'ob-c-m', style: { color: METHOD_COLOR[e.method] ?? 'var(--muted)' } }, e.method ?? ''),
          h('span', { class: 'ob-c-req' }, h('span', { class: 'ob-req-m', style: { color: METHOD_COLOR[e.method] ?? 'var(--muted)' } }, e.method ?? ''), h('span', { class: 'ob-host' }, e.host ?? ''), h('span', { class: 'ob-path' }, e.path ?? '')),
          h('span', { class: 'ob-c-router' }, e.router ? split(e.router).base : h('span', { class: 'faint' }, '—')),
          h('span', { class: 'ob-c-svc' }, e.service ? split(e.service).base : h('span', { class: 'faint' }, '—'), e.server ? h('span', { class: 'ob-server' }, serverShort(e.server)) : null),
          h('span', { class: 'ob-c-client' }, e.client ?? ''),
          h('span', { class: 'ob-c-dur' }, h('span', { class: 'ob-dur' }, h('i', { style: { width: `${Math.max(3, durFrac(d) * 100)}%`, background: durTone(d) } })), h('span', { class: 'tnum' }, shortMs(d))),
          h('span', { class: 'ob-c-size' }, e.size === null || e.size === undefined ? '—' : bytes(e.size)));
      }

      function layoutRows() {
        raf = 0;
        const rh = R();
        const top = rh;   // the cap row above the first entry
        space.style.height = `${top + rows.length * rh}px`;
        const st = scroller.scrollTop;
        const vh = scroller.clientHeight || 600;
        const first = Math.max(0, Math.floor((st - top) / rh) - 12);
        const last = Math.min(rows.length, Math.ceil((st - top + vh) / rh) + 12);
        const keep = new Set();
        const now = Date.now();
        for (let i = first; i < last; i++) {
          const e = rows[i];
          keep.add(e.id);
          let node = pool.get(e.id);
          if (!node) {
            node = rowEl(e);
            if (now - (arrived.get(e.id) ?? 0) < 1500) node.classList.add('ob-new');
            pool.set(e.id, node);
            space.append(node);
          }
          node.style.transform = `translateY(${top + i * rh}px)`;
        }
        for (const [id, node] of pool) if (!keep.has(id)) { node.remove(); pool.delete(id); }
        paintCap();
      }
      const schedule = () => { if (!raf) raf = requestAnimationFrame(layoutRows); };

      function paintCap() {
        cap.replaceChildren(loadingOlder ? h('span', {}, h('span', { class: 'spin ob-spin' }), 'Loading older requests…')
          : hasOlder ? h('span', {}, icon('up', { size: 13 }), 'Scroll up for older requests')
            : rows.length ? h('span', {}, oicon('terminal', { size: 13 }), `Start of what Enodia keeps${info.total ? ` · ${num(info.total)} lines read since it started` : ''}`) : null);
      }

      function toBottom(smooth = false) {
        following = true;
        unseen = 0;
        layoutRows();
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
        paintFoot();
      }

      function paintOverlay() {
        if (loading) {
          overlay.hidden = false;
          overlay.replaceChildren(h('div', { class: 'ob-skel-rows' }, ...Array.from({ length: 9 }, (_, i) => h('div', { class: 'ob-skel-row', style: { '--i': String(i) } },
            h('span', { class: 'skeleton' }), h('span', { class: 'skeleton' }), h('span', { class: 'skeleton' }), h('span', { class: 'skeleton' })))));
          return;
        }
        if (rows.length) { overlay.hidden = true; return; }
        overlay.hidden = false;
        const filtered = FILTERS.some((k) => f[k]);
        overlay.replaceChildren(h('div', { class: 'empty' },
          filtered ? icon('search', { size: 28 }) : h('span', { class: 'ob-radar' }),
          h('div', { class: 'empty-title' }, filtered ? 'No requests match these filters' : 'Waiting for the first request…'),
          h('div', { class: 'small' }, filtered ? 'Matching requests show up here the moment they arrive.' : 'Lines appear here as Traefik writes them.'),
          filtered ? h('button', { type: 'button', class: 'btn sm', onclick: clearAll }, icon('x', { size: 13 }), 'Clear filters') : null));
      }

      function paintFoot() {
        if (paused) footLeft.replaceChildren(h('span', { class: 'dot warn' }), h('span', {}, 'Paused'), queued.length ? h('span', { class: 'muted' }, ` · ${num(queued.length)} waiting`) : null);
        else if (following) footLeft.replaceChildren(h('span', { class: 'dot ok pulse' }), h('span', {}, 'Following'), h('span', { class: 'muted' }, ` · ${num(rows.length)} requests`));
        else footLeft.replaceChildren(h('span', { class: 'dot' }), h('span', {}, 'Scrolled back'), h('span', { class: 'muted' }, ` · ${num(rows.length)} requests`));
        footRight.replaceChildren(rows.length ? h('span', {}, `from ${clock(rows[0].t)}`) : null, h('span', { class: 'ob-hide-sm' }, 'Click a line for details'));
        const n = paused ? 0 : unseen;
        pill.hidden = following || !n;
        pill.replaceChildren(oicon('arrowDown', { size: 14 }), `${num(n)} new request${n === 1 ? '' : 's'}`);
        liveBtn.classList.toggle('primary', paused);
        liveBtn.replaceChildren(paused ? icon('play', { size: 14 }) : h('span', { class: 'dot ok pulse' }), h('span', {}, paused ? `Resume${queued.length ? ` · ${num(queued.length)}` : ''}` : 'Live'));
        liveBtn.title = paused ? 'Show the requests that came in while paused (P)' : 'Pause the stream (P)';
      }

      scroller.addEventListener('scroll', () => {
        const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < R() * 1.5;
        if (atBottom !== following) { following = atBottom; if (following) unseen = 0; paintFoot(); }
        if (scroller.scrollTop < R() * 10) loadOlder();
        schedule();
      }, { passive: true });
      scroller.addEventListener('click', (ev) => {
        const node = ev.target.closest('.ob-row');
        if (!node) return;
        const i = rows.findIndex((e) => e.id === Number(node.dataset.id));
        if (i >= 0) openEntry(i);
      });

      const ro = new ResizeObserver(() => {
        if (!el.isConnected) { ro.disconnect(); return; }
        const w = scroller.clientWidth;
        const was = narrow;
        narrow = w < 640;
        tail.classList.toggle('narrow', narrow);
        tail.classList.toggle('w-md', !narrow && w < 900);
        tail.classList.toggle('w-lg', !narrow && w < 1100);
        if (was !== narrow) { const keepBottom = following; layoutRows(); if (keepBottom) scroller.scrollTop = scroller.scrollHeight; }
        else schedule();
      });
      ro.observe(scroller);

      // ── data ──

      async function reload() {
        const g = ++gen;
        loading = true;
        rows = [];
        arrived.clear();
        for (const node of pool.values()) node.remove();
        pool.clear();
        layoutRows();
        paintOverlay();
        refreshSide();
        try {
          const r = await api(`logs?${qs({ ...f, limit: PAGE })}`);
          if (g !== gen) return;
          if (!r.enabled) { showGuide({}); return; }
          const { entries, ...rest } = r;
          info = rest;
          if (r.format === 'clf') { showGuide({ clf: true }); return; }
          paintNotes();
          rows = entries.reverse();
          hasOlder = entries.length === PAGE;
          queued = [];
        } catch (e) {
          if (g !== gen) return;
          notes.replaceChildren(banner('bad', 'The log could not be loaded', e.message));
        }
        loading = false;
        paintOverlay();
        toBottom();
        paintSub();
      }

      async function loadOlder() {
        if (loadingOlder || !hasOlder || !rows.length || loading) return;
        loadingOlder = true;
        paintCap();
        const g = gen;
        try {
          const r = await api(`logs?${qs({ ...f, before: rows[0].id, limit: PAGE })}`);
          if (g !== gen) return;
          const older = r.entries.reverse();
          hasOlder = r.entries.length === PAGE;
          if (older.length) {
            const prevTop = scroller.scrollTop;
            rows.unshift(...older);
            layoutRows();
            scroller.scrollTop = prevTop + older.length * R();
          }
        } catch { /* try again on the next scroll */ } finally { loadingOlder = false; paintCap(); paintFoot(); }
      }

      function push(list) {
        const now = Date.now();
        for (const e of list) arrived.set(e.id, now);
        if (arrived.size > 4000) for (const [id, t] of arrived) { if (now - t > 3000) arrived.delete(id); }
        rows.push(...list);
        if (following && rows.length > KEEP) { rows.splice(0, rows.length - KEEP); hasOlder = true; }
        if (following) { layoutRows(); scroller.scrollTop = scroller.scrollHeight; } else { unseen += list.length; schedule(); }
        if (!overlay.hidden) paintOverlay();
        paintFoot();
      }

      function addLive(lines) {
        if (loading || !lines?.length) return;
        const lastId = rows.length ? rows[rows.length - 1].id : 0;
        // Enodia restarted: ids start over
        if (lines[lines.length - 1].id < lastId - 1 && !queued.length) { reload(); return; }
        const fresh = lines.filter((e) => e.id > (queued.length ? queued[queued.length - 1].id : lastId) && match(e));
        if (!fresh.length) return;
        if (paused) { queued.push(...fresh); if (queued.length > KEEP) queued.splice(0, queued.length - KEEP); paintFoot(); return; }
        push(fresh);
      }

      async function refreshSide() {
        const g = gen;
        const filters = qs(f);
        try {
          const [s, hd] = await Promise.all([api(`logs/stats?${filters}`), api(`logs/histogram?${qs({ ...f, buckets: 72 })}`)]);
          if (g !== gen || !el.isConnected) return;
          if (!s.enabled) return;
          stats = s;
          paintStats();
          paintFacets();
          if (hd.buckets) paintHist(hd);
          paintFilters();
        } catch { /* the next refresh tries again */ }
      }

      function paintStats() {
        countTo(nums.count, stats.count, { format: (v) => num(Math.round(v)) });
        nums.err.replaceChildren(stats.count ? pct(stats.errors / stats.count) : '—', h('small', {}, stats.errors ? ` ${num(stats.errors)}` : ''));
        nums.err.className = `tnum ${stats.count && stats.errors / stats.count >= 0.05 ? 'bad-text' : stats.errors ? 'warn-text' : ''}`;
        nums.p50.textContent = shortMs(stats.p50);
        nums.p95.textContent = shortMs(stats.p95);
        nums.p99.textContent = shortMs(stats.p99);
        nums.p99.className = `tnum ${stats.p99 >= 1000 ? 'warn-text' : ''}`;
      }

      function paintSub() {
        const span = stats?.oldest && stats?.newest ? (Date.parse(stats.newest) - Date.parse(stats.oldest)) / 1000 : 0;
        sub.replaceChildren('Following ', info.path ? code(info.path) : 'the access log', ' live',
          span ? ` · the last ${span < 120 ? `${Math.round(span)} seconds` : span < 7200 ? `${Math.round(span / 60)} minutes` : `${Math.round(span / 3600)} hours`} of requests in memory` : '', '.');
      }

      function paintNotes() {
        notes.replaceChildren(info.ok === false ? banner('warn', 'The log stopped updating', info.error ?? '') : null);
      }

      // ── facets ──

      const facetsEl = h('aside', { class: 'ob-facets' });
      const facetDefs = [
        ['statuses', 'Status codes'], ['hosts', 'Hosts'], ['paths', 'Paths'], ['routers', 'Routers'], ['services', 'Services'],
        ['clients', 'Clients'], ['agents', 'User agents'], ['methods', 'Methods'], ['slowest', 'Slowest requests'],
      ];
      const facetBody = {};
      const facetLists = {};
      for (const [key, title] of facetDefs) {
        facetBody[key] = h('div', { class: 'ob-facet-body' });
        facetsEl.append(h('section', { class: 'ob-facet' }, h('div', { class: 'ob-facet-title' }, title), facetBody[key]));
      }
      const facetBar = (key, filterKey, value) => {
        facetLists[key] ??= barList({ format: (v) => num(v), emptyText: 'Nothing yet', cls: 'ob-bars-sm', onpick: (r) => r.pick() });
        const list = stats?.[key] ?? [];
        facetLists[key].set(list.slice(0, 6).map((x) => {
          const v = value ? value(x.key) : { [filterKey]: x.key };
          const on = Object.entries(v).every(([k, val]) => f[k] === String(val));
          return { key: x.key, label: key === 'routers' || key === 'services' ? split(x.key).base : x.key, title: x.key, value: x.count, color: on ? 'var(--torch)' : 'var(--violet)', active: on, pick: () => setFilters(on ? Object.fromEntries(Object.keys(v).map((k) => [k, ''])) : v) };
        }));
        if (!facetBody[key].contains(facetLists[key])) facetBody[key].replaceChildren(facetLists[key]);
      };
      function paintFacets() {
        if (!stats) return;
        facetBody.statuses.replaceChildren(h('div', { class: 'ob-code-chips' }, ...(stats.statuses ?? []).map((x) => {
          const on = f.status === String(x.key);
          return h('button', { type: 'button', class: `ob-code-chip s${statusClass(x.key)} ${on ? 'on' : ''}`.trim(), title: `${x.key} ${statusText(x.key)}`, onclick: () => setFilter('status', on ? '' : String(x.key)) },
            h('b', {}, String(x.key)), h('span', { class: 'tnum' }, num(x.count)));
        })));
        facetBar('hosts', 'host');
        facetBar('paths', null, (k) => { const i = k.indexOf('/'); return i > 0 ? { host: k.slice(0, i), q: k.slice(i) } : { q: k }; });
        facetBar('routers', 'router');
        facetBar('services', 'service');
        facetBar('clients', 'client');
        facetBar('agents', 'q');
        facetBody.methods.replaceChildren(h('div', { class: 'ob-code-chips' }, ...(stats.methods ?? []).map((x) => {
          const on = f.method === x.key;
          return h('button', { type: 'button', class: `ob-code-chip ${on ? 'on' : ''}`.trim(), onclick: () => setFilter('method', on ? '' : x.key) },
            h('b', { style: { color: METHOD_COLOR[x.key] ?? 'var(--text)' } }, x.key), h('span', { class: 'tnum' }, num(x.count)));
        })));
        const slow = (stats.slowest ?? []).slice(0, 8);
        facetBody.slowest.replaceChildren(slow.length ? h('div', { class: 'ob-slow' }, ...slow.map((e) => h('button', { type: 'button', class: 'ob-slow-row', onclick: () => openStandalone(e) },
          h('span', { class: `ob-st s${statusClass(e.status)}` }, String(e.status)),
          h('span', { class: 'ob-slow-path' }, h('span', { class: 'ellipsis' }, e.path), h('span', { class: 'ob-slow-host ellipsis' }, `${e.host} · ${clock(e.t)}`)),
          h('b', { class: 'tnum', style: { color: durTone(e.durationMs) } }, shortMs(e.durationMs))))) : h('div', { class: 'ob-bars-empty' }, 'Nothing yet'));
      }

      // ── the detail drawer ──

      function entryView(e, nav) {
        const c = statusClass(e.status);
        const url = `${e.scheme || 'http'}://${e.host ?? ''}${e.path ?? ''}`;
        const origin = e.originMs ?? null;
        const over = e.overheadMs ?? (origin !== null && e.durationMs !== null ? Math.max(0, e.durationMs - origin) : null);
        const total = e.durationMs ?? 0;
        const link = (kind, name) => (name ? h('a', { class: 'ob-link', href: kind === 'entrypoints' ? hrefFor('entrypoints', name) : hrefFor(kind, name) }, split(name).base, split(name).provider && kind !== 'entrypoints' ? h('span', { class: 'faint' }, `@${split(name).provider}`) : null, icon('chevron', { size: 12 })) : null);
        const filterBtn = (label, v) => h('button', { type: 'button', class: 'btn sm', onclick: () => { closeDrawer?.(); setFilters(v, true); } }, icon('filter', { size: 13 }), label);
        return [
          h('div', { class: `ob-entry-hero s${c}` },
            h('div', { class: 'ob-entry-code' }, String(e.status ?? '—')),
            h('div', { class: 'grow', style: { minWidth: '0' } },
              h('div', { class: 'ob-entry-status' }, statusText(e.status) || 'Unknown status', e.originStatus && e.originStatus !== e.status ? h('span', { class: 'badge' }, `backend said ${e.originStatus || 'nothing'}`) : null),
              h('div', { class: 'ob-entry-when' }, timeAgo(e.t), h('span', { class: 'faint' }, ` · ${clock(e.t)}`))),
            nav),
          h('div', { class: 'ob-entry-url' }, h('span', { class: 'ob-entry-method', style: { color: METHOD_COLOR[e.method] ?? 'var(--text)' } }, e.method), h('code', {}, url), h('button', { type: 'button', class: 'btn sm ghost icon-only', title: 'Copy the URL', onclick: () => copy(url, 'URL copied') }, icon('copy', { size: 13 }))),
          h('div', { class: 'ob-timing' },
            h('div', { class: 'ob-timing-head' }, h('span', {}, 'Time taken'), h('b', { class: 'tnum', style: { color: durTone(total) } }, shortMs(e.durationMs))),
            h('div', { class: 'ob-timing-bar' },
              origin !== null ? h('i', { class: 'origin', style: { flexGrow: String(Math.max(origin, 0.001)) }, title: `Backend ${shortMs(origin)}` }) : null,
              over !== null ? h('i', { class: 'over', style: { flexGrow: String(Math.max(over, origin ? 0.001 : 1)) }, title: `Traefik ${shortMs(over)}` }) : null),
            h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'ob-sw', style: { background: 'var(--violet)' } }), 'Backend ', h('b', { class: 'tnum' }, shortMs(origin))), h('span', {}, h('i', { class: 'ob-sw', style: { background: 'var(--torch)' } }), 'Traefik ', h('b', { class: 'tnum' }, shortMs(over))))),
          kv([
            ['Time', h('span', {}, new Date(e.t).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }), ' · ', h('span', { class: 'mono' }, clock(e.t)))],
            ['Entry point', link('entrypoints', e.entrypoint)],
            ['Router', link('routers', e.router)],
            ['Service', link('services', e.service)],
            ['Server', e.server ? h('span', { class: 'mono' }, e.server) : null],
            ['Client', e.client ? h('span', { class: 'mono' }, e.client) : null],
            e.user ? ['User', e.user] : null,
            ['Protocol', [e.protocol, e.scheme, e.tls ? `TLS ${e.tls}` : null].filter(Boolean).join(' · ')],
            ['Response', e.size === null || e.size === undefined ? null : `${bytes(e.size)} (${num(e.size)} bytes)`],
            e.retries ? ['Retries', h('span', { class: 'warn-text bold' }, String(e.retries))] : null,
            ['User agent', e.ua ? h('span', { class: 'small' }, e.ua) : null],
            e.referer ? ['Referer', h('span', { class: 'small mono' }, e.referer)] : null,
          ]),
          h('div', { class: 'ob-entry-actions' },
            e.client ? filterBtn('All from this client', { client: e.client }) : null,
            e.router ? filterBtn('Same router', { router: e.router }) : null,
            e.path ? filterBtn('Same path', { host: e.host ?? '', q: (e.path ?? '').split('?')[0] }) : null,
            filterBtn(`Every ${e.status}`, { status: String(e.status) }),
            h('button', { type: 'button', class: 'btn sm', onclick: () => copy(JSON.stringify(e, null, 2), 'Request copied as JSON') }, icon('copy', { size: 13 }), 'Copy JSON'),
            h('button', { type: 'button', class: 'btn sm', onclick: () => copy(curlFor(e), 'curl command copied') }, oicon('terminal', { size: 13 }), 'Copy as curl')),
          h('details', { class: 'ob-raw' }, h('summary', {}, 'Raw entry'), jsonView(e, { mask: false })),
        ];
      }

      let closeDrawer = null;
      function openDrawer() {
        const body = h('div', { class: 'ob-entry' });
        const title = h('span', { class: 'ob-drawer-title' });
        const { el: panel, close } = drawer(title, body);
        panel.classList.add('ob-drawer');
        closeDrawer = close;
        return { body, title, panel };
      }
      function openStandalone(e) {
        const { body, title } = openDrawer();
        title.replaceChildren(h('span', { class: 'mono' }, `${e.method} ${e.path}`));
        body.replaceChildren(...entryView(e, null));
      }
      function openEntry(index) {
        let i = index;
        const { body, title, panel } = openDrawer();
        const paint = () => {
          const e = rows[i];
          if (!e) return;
          title.replaceChildren(h('span', { class: 'mono' }, `${e.method} ${e.path}`));
          const nav = h('div', { class: 'ob-entry-nav' },
            h('button', { type: 'button', class: 'btn sm icon-only', title: 'Older (↑)', disabled: i <= 0, onclick: () => go(-1) }, icon('up', { size: 14 })),
            h('button', { type: 'button', class: 'btn sm icon-only', title: 'Newer (↓)', disabled: i >= rows.length - 1, onclick: () => go(1) }, icon('down', { size: 14 })));
          body.replaceChildren(...entryView(e, nav));
          for (const node of pool.values()) node.classList.toggle('sel', Number(node.dataset.id) === e.id);
        };
        const go = (d) => {
          const next = Math.max(0, Math.min(rows.length - 1, i + d));
          if (next === i) return;
          i = next;
          paint();
          // keep the selected line in view
          const y = R() + i * R();
          if (y < scroller.scrollTop || y > scroller.scrollTop + scroller.clientHeight - R()) { following = false; scroller.scrollTop = y - scroller.clientHeight / 2; }
        };
        const onKey = (ev) => {
          if (!panel.isConnected) { document.removeEventListener('keydown', onKey); for (const node of pool.values()) node.classList.remove('sel'); return; }
          if (ev.key === 'ArrowUp' || ev.key === 'k') { ev.preventDefault(); go(-1); }
          else if (ev.key === 'ArrowDown' || ev.key === 'j') { ev.preventDefault(); go(1); }
        };
        document.addEventListener('keydown', onKey);
        paint();
      }

      // ── actions ──

      function setFilters(patch, scrollUp = false) {
        let changed = false;
        for (const [k, v] of Object.entries(patch)) { const val = v === null || v === undefined ? '' : String(v); if (f[k] !== val) { f[k] = val; changed = true; } }
        if (!changed) return;
        match = matcher(f);
        setHashQuery('logs', f);
        paintFilters();
        reload();
        if (scrollUp) filterBar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      function setFilter(k, v, typing = false) {
        if (typing && f[k] === v) return;
        setFilters({ [k]: v });
      }
      function clearAll() { setFilters(Object.fromEntries(FILTERS.map((k) => [k, '']))); }

      function setPaused(v) {
        paused = v;
        el.classList.toggle('ob-paused', paused);
        if (!paused && queued.length) { const list = queued; queued = []; push(list); }
        paintFoot();
      }

      function exportAs(kind) {
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        if (kind === 'json') download(`enodia-access-log-${stamp}.json`, JSON.stringify(rows, null, 2));
        else download(`enodia-access-log-${stamp}.csv`, csv(rows), 'text/csv;charset=utf-8');
        toast(`${num(rows.length)} requests exported`);
      }

      const onKey = (e) => {
        if (!el.isConnected) { document.removeEventListener('keydown', onKey); return; }
        if (e.ctrlKey || e.metaKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || document.querySelector('.drawer')) return;
        if (e.key === 'p') setPaused(!paused);
        else if (e.key === 'End' || e.key === 'G') toBottom(true);
      };
      document.addEventListener('keydown', onKey);

      // ── layout ──

      const main = h('div', { class: 'ob-logs-main' }, facetsEl, tail);
      el.replaceChildren(head, notes, summary, filterBar, main);
      paintFilters();
      paintFoot();
      reload();
      every(() => { if (!paused) refreshSide(); }, 5000);
      every(paintSub, 30_000);

      return {
        update(event, data) {
          if (event === 'logs') addLive(data);
          else if (event === 'state') paintFilters();
        },
        destroy() { document.removeEventListener('keydown', onKey); ro.disconnect(); hideTip(); },
      };
    }

    return {
      el,
      update(event, data) { if (el.isConnected) view?.update?.(event, data); },
      destroy() { timers.forEach(clearInterval); view?.destroy?.(); },
    };
  },
};
