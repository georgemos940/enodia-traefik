// Live traffic: requests, errors, latency and bandwidth for the whole proxy, one entry point, router or
// service, from Traefik's Prometheus metrics. Charts and lists move with every scrape, nothing is rebuilt.
import { h, icon, stagger } from '../lib/dom.js';
import { store, api, find } from '../lib/store.js';
import { card, stat, badge, hrefFor, segmented, tabs, empty, banner, statusBadge } from '../lib/components.js';
import { timeChart, countTo } from '../lib/charts.js';
import { ruleView } from '../lib/rules.js';
import { rate, pct, ms, bytes, duration, num, split, ago, time, dateTime } from '../lib/format.js';
import { liveSpark, liveDonut, meter, barList, picker, thin, resolve, oicon, guide, code, setHashQuery, hashQuery, statusText, classColor, METHOD_COLOR, motionOk } from '../lib/observe.js';

const WINDOWS = [[5, '5m'], [15, '15m'], [60, '1h']];
const CLASSES = [['r2', '2xx', 'var(--c2xx)'], ['r3', '3xx', 'var(--c3xx)'], ['r4', '4xx', 'var(--c4xx)'], ['r5', '5xx', 'var(--c5xx)']];
const KINDS = { total: ['Whole proxy', 'globe'], ep: ['Entry point', 'entrypoint'], router: ['Router', 'router'], service: ['Service', 'service'] };
const CMP_METRICS = [['rps', 'Req/s'], ['err', 'Errors'], ['p95', 'p95'], ['out', 'Bandwidth']];
// compare colours go to a series when it is added and stay with it until it is removed
const CMP_COLORS = ['var(--torch)', 'var(--violet)', 'var(--sky)', 'hsl(330 80% 66%)', 'hsl(170 70% 46%)', 'hsl(20 90% 62%)', 'hsl(270 70% 74%)', 'hsl(55 85% 55%)'];
const TLS_COLOR = { '1.3': 'var(--ok)', '1.2': 'var(--sky)', '1.1': 'var(--warn)', '1.0': 'var(--bad)' };

const kindOf = (key) => (key === 'total' ? 'total' : key.slice(0, key.indexOf(':')));
const nameOf = (key) => (key === 'total' ? '' : key.slice(key.indexOf(':') + 1));
const shortMs = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}s` : `${Math.round(v)}ms`);
// axis labels have room for about five characters
const shortBytes = (v) => (v < 1000 ? `${Math.round(v)}B` : v < 1024 * 1000 ? `${(v / 1024).toFixed(v < 10 * 1024 ? 1 : 0)}KB` : v < 1024 ** 3 ? `${(v / 1024 ** 2).toFixed(v < 10 * 1024 ** 2 ? 1 : 0)}MB` : `${(v / 1024 ** 3).toFixed(1)}GB`);
const pctTxt = (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
const availTxt = (f) => (f >= 0.9995 ? '100%' : `${(f * 100).toFixed(f >= 0.995 ? 2 : 1)}%`);
const CMP = {
  rps: { value: (p) => p.rps, format: rate, minMax: 0 },
  err: { value: (p) => p.errorRate * 100, format: pctTxt, minMax: 1 },
  p95: { value: (p) => p.p95, format: shortMs, minMax: 10 },
  out: { value: (p) => p.outBps, format: shortBytes, minMax: 1024 },
};

function displayName(key) {
  if (key === 'total') return { base: 'Whole proxy', provider: '' };
  return kindOf(key) === 'ep' ? { base: nameOf(key), provider: '' } : split(nameOf(key));
}

const hrefOf = (key) => {
  const k = kindOf(key);
  if (k === 'ep') return hrefFor('entrypoints', nameOf(key));
  if (k === 'router' || k === 'service') return hrefFor(`${k}s`, nameOf(key));
  return null;
};

/** The access log, filtered to this scope (and anything else given). */
function logsHref(scope, extra = {}) {
  const k = kindOf(scope);
  const qs = new URLSearchParams({ ...(k === 'router' ? { router: nameOf(scope) } : k === 'service' ? { service: nameOf(scope) } : {}), ...extra }).toString();
  return `#/logs${qs ? `?${qs}` : ''}`;
}

function metricsGuide(error) {
  return guide({
    icon: 'traffic',
    title: error ? 'Enodia cannot read Traefik\'s metrics yet' : 'Turn on Traefik\'s metrics to see live traffic',
    text: 'Enodia reads Traefik\'s Prometheus endpoint every few seconds and keeps an hour of history in memory. No Prometheus server is needed.',
    steps: [
      {
        title: 'Enable Prometheus metrics in Traefik',
        text: 'Give metrics their own entry point so they are never public, and turn on per-router labels: Traefik leaves those off by default.',
        snippets: [
          { label: 'traefik.yml', lang: 'yaml', text: 'entryPoints:\n  metrics:\n    address: ":8082"\n\nmetrics:\n  prometheus:\n    entryPoint: metrics\n    addEntryPointsLabels: true\n    addRoutersLabels: true     # per-router numbers\n    addServicesLabels: true\n    buckets: [0.05, 0.1, 0.3, 1.2, 5.0]' },
          { label: 'CLI flags', lang: 'sh', text: '--entryPoints.metrics.address=:8082\n--metrics.prometheus=true\n--metrics.prometheus.entryPoint=metrics\n--metrics.prometheus.addRoutersLabels=true\n--metrics.prometheus.addServicesLabels=true' },
        ],
      },
      {
        title: 'Point Enodia at the endpoint',
        text: ['Enodia looks for it on its own: on the API address, then on the entry point Traefik names for Prometheus. If Traefik lives elsewhere, say where with ', code('TRAEFIK_METRICS_URL'), '.'],
        snippets: [{ label: 'docker-compose.yml', lang: 'yaml', text: 'services:\n  enodia:\n    image: ghcr.io/georgemos940/enodia:latest\n    environment:\n      TRAEFIK_API_URL: http://traefik:8080\n      TRAEFIK_METRICS_URL: http://traefik:8082/metrics' }],
      },
      { title: 'Watch it fill in', text: 'Charts start with the second scrape, a few seconds after Traefik answers. Every entry point, router and service gets its own numbers.' },
    ],
    foot: error ? banner('warn', 'Last attempt', error) : null,
  });
}

export default {
  render(ctx) {
    ctx.setCrumbs([['Live traffic']]);
    const el = h('div', { class: 'col gap-lg ob ob-traffic' });
    if (store.meta?.features?.metrics === false) { el.append(metricsGuide()); return { el }; }

    const q = hashQuery();
    let scope = /^(total|(ep|router|service):.+)$/.test(q.get('scope') ?? '') ? q.get('scope') : 'total';
    let minutes = WINDOWS.some(([m]) => m === Number(q.get('m'))) ? Number(q.get('m')) : 15;
    let compare = (q.get('cmp') || '').split(',').filter((k) => /^(router|service|ep):./.test(k)).slice(0, CMP_COLORS.length);
    let cmpPinned = compare.length > 0;
    let cmpMetric = 'rps';
    let lbKind = 'router';
    let lbSort = 'rps';
    let lbAll = false;
    let codesMode = 'start';
    let paused = false;
    let pausedAt = 0;
    let gen = 0;
    let tick = 0;
    let ready = false;
    let internal = new Set();
    let top = { router: [], service: [], ep: [] };
    const cache = new Map();     // series key -> points inside the window
    const loading = new Set();
    const slots = new Map();     // compare key -> colour slot
    const snaps = [];            // recent totals, for the "last minute" breakdown
    const hist = { mem: [], cpu: [], gor: [], conns: [] }; // gauges since the page opened
    const step = () => store.meta?.pollSeconds ?? 5;
    compare.forEach((k, i) => slots.set(k, i));

    // ── series ──

    async function ensure(keys) {
      const g = gen;
      const want = [...new Set(keys)].filter((k) => k && !cache.has(k) && !loading.has(k));
      if (!want.length) return true;
      want.forEach((k) => loading.add(k));
      try {
        for (let i = 0; i < want.length; i += 30) {
          const chunk = want.slice(i, i + 30);
          const r = await api(`series?keys=${chunk.map(encodeURIComponent).join(',')}&minutes=${minutes}`);
          if (g !== gen) return false;
          for (const k of chunk) cache.set(k, r.series?.[k] ?? []);
        }
      } catch { return false; } finally { want.forEach((k) => loading.delete(k)); }
      return g === gen;
    }
    function append(latest) {
      const since = Date.now() - minutes * 60_000;
      for (const [k, list] of cache) {
        const p = latest?.[k];
        if (p && (!list.length || p.t > list[list.length - 1].t)) list.push(p);
        let cut = 0;
        while (cut < list.length && list[cut].t < since) cut++;
        if (cut) list.splice(0, cut);
      }
    }
    const pts = (k) => cache.get(k) ?? [];
    const latestOf = (k) => store.metrics?.latest?.[k] ?? pts(k).at(-1) ?? null;

    // ── head ──

    function scopeGroups() {
      const latest = store.metrics?.latest ?? {};
      const item = (k) => {
        const p = latest[k];
        const { base, provider } = displayName(k);
        return { value: k, label: base, sub: provider ? `@${provider}` : '', hint: p ? `${rate(p.rps)}/s` : '', icon: KINDS[kindOf(k)][1], rps: p?.rps ?? 0, faint: kindOf(k) === 'ep' && internal.has(nameOf(k)) };
      };
      const keys = Object.keys(latest);
      if (!keys.includes(scope)) keys.push(scope);
      const of = (kind) => keys.filter((k) => kindOf(k) === kind).map(item).sort((a, b) => b.rps - a.rps || a.label.localeCompare(b.label));
      return [
        { name: 'Whole proxy', items: [{ ...item('total'), label: 'Whole proxy', sub: 'every entry point' }] },
        { name: 'Entry points', items: of('ep') },
        { name: 'Routers', items: of('router') },
        { name: 'Services', items: of('service') },
      ].filter((g) => g.items.length);
    }
    const scopeButton = (it) => {
      const k = kindOf(it.value);
      const { base, provider } = displayName(it.value);
      return [h('span', { class: 'ob-pick-kind' }, icon(KINDS[k][1], { size: 14 })), h('span', { class: 'ob-pick-label ellipsis' }, base, provider ? h('span', { class: 'faint' }, `@${provider}`) : null), k === 'total' ? null : h('span', { class: 'ob-pick-tag' }, KINDS[k][0])];
    };
    const scopePick = picker({ value: scope, cls: 'ob-scope-pick', title: 'Show traffic for…', placeholder: 'Find an entry point, router or service…', groups: scopeGroups, button: scopeButton, onchange: (v) => setScope(v) });
    const windowSeg = segmented(WINDOWS, minutes, (v) => setWindow(v));
    const pauseBtn = h('button', { type: 'button', class: 'btn ob-pause', onclick: () => setPaused(!paused) });
    const paintPause = () => {
      pauseBtn.classList.toggle('primary', paused);
      pauseBtn.replaceChildren(icon(paused ? 'play' : 'pause', { size: 14 }), h('span', { class: 'ob-hide-sm' }, paused ? 'Resume' : 'Pause'));
      pauseBtn.title = paused ? `Paused at ${time(new Date(pausedAt).toISOString())}` : 'Freeze the charts (P)';
    };
    paintPause();
    const head = h('div', { class: 'page-head ob-head' },
      h('div', { class: 'grow' },
        h('h1', { class: 'page-title' }, icon('traffic', { size: 24, cls: 'torch-text' }), 'Live traffic'),
        h('p', { class: 'page-sub' }, `Requests, errors, latency and bandwidth from Traefik's metrics, refreshed every ${step()} seconds.`)),
      h('div', { class: 'ob-head-tools' }, scopePick, windowSeg, pauseBtn));
    const notes = h('div', { class: 'col', style: { gap: '0' } });

    // ── hero ──

    const heroIcon = h('div', { class: 'ob-scope-icon' });
    const heroKind = h('div', { class: 'ob-eyebrow' });
    const heroName = h('h2', { class: 'ob-scope-name' });
    const heroMeta = h('div', { class: 'ob-scope-meta' });
    const heroLinks = h('div', { class: 'ob-scope-links' });
    const heroHot = h('div', { class: 'ob-hot' });
    const liveNum = h('span', { class: 'ob-big tnum' }, '—');
    const liveFoot = h('div', { class: 'ob-big-foot' });
    const shareRing = meter({ size: 92, thickness: 8, label: 'of traffic' });
    const availRing = meter({ size: 92, thickness: 8, label: 'no 5xx' });
    const shareBox = h('div', { class: 'ob-ring-box', title: 'This scope\'s share of every request the proxy serves right now' }, shareRing);
    const availBox = h('div', { class: 'ob-ring-box', title: 'Requests over the window that did not end in a server error (5xx)' }, availRing);
    const hero = h('section', { class: 'card ob-hero' },
      h('div', { class: 'ob-hero-id' }, heroIcon, h('div', { class: 'ob-hero-text' }, heroKind, heroName, heroMeta, heroHot, heroLinks)),
      h('div', { class: 'ob-hero-nums' },
        h('div', { class: 'ob-big-box' }, h('div', { class: 'ob-eyebrow' }, h('span', { class: 'dot ok pulse' }), 'Right now'),
          h('div', { class: 'ob-big-row' }, liveNum, h('span', { class: 'ob-big-unit' }, 'req/s')), liveFoot),
        shareBox, availBox));

    // ── tiles ──

    const mkTile = (label, ic, color) => {
      const t = stat({ label, icon: ic, value: '—', foot: ' ' });
      t.classList.add('ob-tile');
      t.footEl = t.querySelector('.stat-foot');
      if (color) { t.spark = liveSpark({ color }); t.append(t.spark); }
      return t;
    };
    const T = {
      rps: mkTile('Requests / second', 'zap', 'var(--torch)'),
      err: mkTile('Server errors (5xx)', 'alert', 'var(--c5xx)'),
      cli: mkTile('Client errors (4xx)', 'xcircle', 'var(--c4xx)'),
      p95: mkTile('Latency p95', 'clock', 'var(--violet)'),
      out: mkTile('Bandwidth out', 'download', 'var(--sky)'),
      served: mkTile('Requests served', 'layers', null),
    };
    const splitBar = h('div', { class: 'ob-split' });
    T.served.append(splitBar);

    // ── charts ──

    function legend(items) {
      const vals = {};
      const node = h('div', { class: 'legend ob-legend' }, ...items.map(([k, l, c]) => h('span', {}, h('i', { style: { background: c } }), l, vals[k] = h('b', { class: 'tnum' }))));
      node.vals = vals;
      return node;
    }
    const reqChart = timeChart([], { height: 330, stacked: true, yFormat: rate });
    const errChart = timeChart([], { height: 190, yFormat: pctTxt, minMax: 1 });
    const latChart = timeChart([], { height: 190, area: false, yFormat: shortMs, minMax: 10 });
    const bwChart = timeChart([], { height: 190, yFormat: shortBytes, minMax: 1024 });
    const reqLegend = legend(CLASSES);
    const errLegend = legend([['e5', '5xx', 'var(--c5xx)'], ['e4', '4xx', 'var(--c4xx)']]);
    const latLegend = legend([['p50', 'p50', 'var(--sky)'], ['p95', 'p95', 'var(--violet)'], ['p99', 'p99', 'var(--ember)']]);
    const bwLegend = legend([['out', 'Out', 'var(--sky)'], ['in', 'In', 'var(--violet)']]);
    const chartCards = [
      card({ title: 'Requests by status', icon: 'traffic', sub: 'Requests a second, stacked by status class', cls: 'ob-chart-card ob-wait' }, reqChart.el, h('div', { class: 'mt-sm' }, reqLegend)),
      card({ title: 'Error rate', icon: 'alert', sub: 'Share of requests that failed', cls: 'ob-chart-card ob-wait' }, errChart.el, h('div', { class: 'mt-sm' }, errLegend)),
      card({ title: 'Latency', icon: 'clock', sub: 'Percentiles of the time Traefik took', cls: 'ob-chart-card ob-wait' }, latChart.el, h('div', { class: 'mt-sm' }, latLegend)),
      card({ title: 'Bandwidth', icon: 'download', sub: 'Bytes a second through the proxy', cls: 'ob-chart-card ob-wait' }, bwChart.el, h('div', { class: 'mt-sm' }, bwLegend)),
    ];

    // ── status codes ──

    const codesDonut = liveDonut({ size: 132, thickness: 14 });
    const codesList = barList({
      format: (v, r) => `${num(v)}  ${r.share}`, emptyText: 'No requests yet', cls: 'ob-bars-sm',
      onpick: (r) => { location.hash = logsHref(scope, { status: String(r.key) }); },
      onhover: (r) => codesDonut.highlight(r ? r.key : null),
    });
    const codesSub = h('span');
    const codesCard = card({
      title: [oicon('hash', { size: 15 }), 'Status codes'], sub: codesSub,
      tools: [segmented([['start', 'All time'], ['live', '1 min']], codesMode, (v) => { codesMode = v; paintCodes(); })],
    }, h('div', { class: 'ob-codes' }, codesDonut, codesList), h('div', { class: 'tiny muted mt-sm' }, 'Click a code to see those requests in the access log.'));

    // ── leaderboard ──

    const lbList = h('div', { class: 'ob-lb-body' });
    const lbRows = new Map();
    const lbMore = h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { lbAll = !lbAll; paintBoard(); } });
    const lbHead = h('div', { class: 'ob-lb-row ob-lb-head' }, h('span', {}, '#'), h('span', {}, 'Name'), h('span', { class: 'ob-lb-spark' }, 'Trend'), h('span', { class: 'num' }, 'Req/s'),
      h('span', { class: 'ob-lb-share' }, 'Share'), h('span', { class: 'num' }, 'Errors'), h('span', { class: 'num ob-lb-p95' }, 'Peak p95'), h('span'));
    const lbSub = h('span');
    const boardCard = card({
      title: 'Leaderboard', icon: 'activity', sub: lbSub,
      tools: [segmented([['rps', 'Busiest'], ['err', 'Errors'], ['p95', 'Slowest']], lbSort, (v) => { lbSort = v; paintBoard(); })],
    }, tabs([['router', 'Routers'], ['service', 'Services'], ['ep', 'Entry points']], lbKind, (v) => { lbKind = v; lbRows.clear(); lbList.replaceChildren(); paintBoard(true); }),
    h('div', { class: 'ob-lb' }, lbHead, lbList), h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '6px' } }, lbMore));

    function boardRow(key) {
      const { base, provider } = displayName(key);
      const rank = h('span', { class: 'ob-lb-rank tnum' });
      const spark = liveSpark({ color: 'var(--torch)', width: 120, height: 28, cls: 'ob-lb-sparksvg' });
      const rpsEl = h('span', { class: 'num tnum bold' });
      const shareFill = h('i');
      const shareTxt = h('span', { class: 'tnum' });
      const errEl = h('span', { class: 'num tnum' });
      const p95El = h('span', { class: 'num tnum ob-lb-p95' });
      const cmpBtn = h('button', { type: 'button', class: 'ob-cmp-toggle', onclick: (e) => { e.stopPropagation(); toggleCompare(key); } }, oicon('compare', { size: 14 }));
      const href = hrefOf(key);
      const node = h('div', { class: 'ob-lb-row', role: 'button', tabindex: '0', title: `Show ${base} above`, onclick: () => setScope(key, true), onkeydown: (e) => { if (e.key === 'Enter') setScope(key, true); } },
        rank,
        h('span', { class: 'ob-lb-name' }, h('span', { class: 'ellipsis' }, base, provider ? h('span', { class: 'faint tiny' }, `@${provider}`) : null)),
        h('span', { class: 'ob-lb-spark' }, spark),
        rpsEl,
        h('span', { class: 'ob-lb-share' }, h('span', { class: 'ob-mini-bar' }, shareFill), shareTxt),
        errEl, p95El,
        h('span', { class: 'ob-lb-act' }, cmpBtn, href ? h('a', { class: 'btn sm ghost icon-only', href, title: `Open ${base}`, onclick: (e) => e.stopPropagation() }, icon('chevron', { size: 14 })) : null));
      return {
        el: node,
        spark,
        update(r, i, sum) {
          rank.textContent = String(i + 1);
          rpsEl.textContent = rate(r.rps);
          const share = sum ? r.rps / sum : 0;
          shareFill.style.width = `${Math.max(2, share * 100)}%`;
          shareTxt.textContent = pct(share);
          errEl.textContent = r.errorRate > 0 ? pct(r.errorRate) : '0%';
          errEl.className = `num tnum ${r.errorRate >= 0.05 ? 'bad-text bold' : r.errorRate > 0.01 ? 'warn-text' : 'muted'}`;
          p95El.textContent = r.p95 === null ? '—' : ms(r.p95);
          node.classList.toggle('on', key === scope);
          const inCmp = compare.includes(key);
          cmpBtn.classList.toggle('on', inCmp);
          cmpBtn.style.setProperty('--c', inCmp ? CMP_COLORS[slots.get(key) ?? 0] : 'transparent');
          cmpBtn.title = inCmp ? 'Remove from the comparison' : 'Add to the comparison';
        },
      };
    }

    function paintBoard(fresh = false) {
      let rows = [...(top[lbKind] ?? [])];
      if (lbKind === 'ep') rows = rows.filter((r) => !internal.has(r.name));
      const by = { rps: (r) => r.rps, err: (r) => r.errorRate, p95: (r) => r.p95 ?? -1 }[lbSort];
      rows.sort((a, b) => by(b) - by(a) || b.rps - a.rps || a.name.localeCompare(b.name));
      const shown = rows.slice(0, lbAll ? rows.length : 8);
      const sum = rows.reduce((a, r) => a + r.rps, 0);
      const before = fresh || !motionOk() ? new Map() : new Map([...lbRows].map(([k, r]) => [k, r.el.getBoundingClientRect().top]));
      const nodes = shown.map((r, i) => {
        const key = `${lbKind}:${r.name}`;
        let row = lbRows.get(key);
        if (!row) { row = boardRow(key); lbRows.set(key, row); }
        row.update(r, i, sum);
        return row.el;
      });
      const keep = new Set(shown.map((r) => `${lbKind}:${r.name}`));
      for (const k of [...lbRows.keys()]) if (!keep.has(k)) lbRows.delete(k);
      if (!shown.length) lbList.replaceChildren(empty(ready ? 'No traffic in this window' : 'Loading…', ready ? 'Rows appear as soon as requests arrive.' : '', 'traffic'));
      else lbList.replaceChildren(...nodes);
      for (const [k, row] of lbRows) {
        const b = before.get(k);
        if (b === undefined) continue;
        const a = row.el.getBoundingClientRect().top;
        if (Math.abs(a - b) > 1) row.el.animate([{ transform: `translateY(${b - a}px)` }, { transform: 'none' }], { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
      lbMore.hidden = rows.length <= 8;
      lbMore.replaceChildren(lbAll ? 'Show the top 8' : `Show all ${rows.length}`, icon(lbAll ? 'up' : 'down', { size: 13 }));
      paintHot();
      lbSub.textContent = `Averages over the last ${minutes === 60 ? 'hour' : `${minutes} minutes`}. Click a row to focus on it.`;
      paintBoardSparks();
      ensure(shown.map((r) => `${lbKind}:${r.name}`)).then((ok) => { if (ok) paintBoardSparks(); });
    }
    // for the whole proxy: the routers worth a look, one click away
    function paintHot() {
      const rows = (top.router ?? []).filter((r) => r.rps > 0.02);
      if (kindOf(scope) !== 'total' || !rows.length) { heroHot.replaceChildren(); return; }
      const pickMax = (f) => rows.reduce((a, r) => (f(r) > f(a) ? r : a), rows[0]);
      const busiest = pickMax((r) => r.rps);
      const errs = pickMax((r) => r.errorRate);
      const slow = pickMax((r) => r.p95 ?? -1);
      const chip = (label, ic, r, value, tone) => h('button', { type: 'button', class: `ob-hot-chip ${tone}`.trim(), title: `Show ${r.name}`, onclick: () => setScope(`router:${r.name}`) },
        icon(ic, { size: 13 }), h('span', { class: 'ob-hot-label' }, label), h('b', {}, split(r.name).base), h('span', { class: 'tnum' }, value));
      heroHot.replaceChildren(
        chip('Busiest', 'zap', busiest, `${rate(busiest.rps)}/s`, ''),
        errs.errorRate > 0 ? chip('Most errors', 'alert', errs, pct(errs.errorRate), errs.errorRate >= 0.05 ? 'bad' : 'warn') : null,
        slow.p95 !== null ? chip('Slowest', 'clock', slow, ms(slow.p95), slow.p95 >= 1000 ? 'warn' : '') : null);
    }
    function paintBoardSparks() {
      for (const [k, row] of lbRows) row.spark.set(thin(pts(k).map((p) => p.rps), 60));
    }
    async function loadTop() {
      const g = gen;
      try {
        const [router, service, ep] = await Promise.all(['router', 'service', 'ep'].map((k) => api(`top?kind=${k}&minutes=${minutes}&limit=100`).then((r) => r.rows)));
        if (g !== gen) return;
        top = { router, service, ep };
      } catch { /* the next tick tries again */ }
    }

    // ── compare ──

    const cmpChips = h('div', { class: 'ob-cmp-chips' });
    const cmpAdd = picker({
      value: null, cls: 'ob-cmp-add', placeholder: 'Add a router, service or entry point…',
      groups: () => scopeGroups().filter((g) => g.name !== 'Whole proxy').map((g) => ({ ...g, items: g.items.filter((it) => !compare.includes(it.value)) })).filter((g) => g.items.length),
      button: () => [oicon('plus', { size: 14 }), h('span', {}, 'Add')],
      onchange: (v) => { cmpAdd.set(null); toggleCompare(v); },
    });
    let cmpChart = makeCmpChart();
    const cmpBox = h('div', {}, cmpChart.el);
    const cmpEmpty = h('div', { class: 'ob-cmp-empty', hidden: true }, oicon('compare', { size: 22 }), h('div', {}, 'Pick routers, services or entry points to draw them on one chart.'));
    const compareCard = card({
      title: 'Compare', icon: 'layers', sub: 'Several routers, services or entry points on one chart',
      tools: [segmented(CMP_METRICS, cmpMetric, (v) => { cmpMetric = v; cmpChart.destroy(); cmpChart = makeCmpChart(); cmpBox.replaceChildren(cmpChart.el); paintCompare(); })],
      cls: 'ob-chart-card',
    }, cmpChips, cmpBox, cmpEmpty);
    function makeCmpChart() { return timeChart([], { height: 260, area: false, yFormat: CMP[cmpMetric].format, minMax: CMP[cmpMetric].minMax }); }
    function paintCompare() {
      const m = CMP[cmpMetric];
      cmpChips.replaceChildren(...compare.map((k) => {
        const { base, provider } = displayName(k);
        const p = latestOf(k);
        const v = p ? m.value(p) : null;
        return h('span', { class: 'ob-cmp-chip', style: { '--c': CMP_COLORS[slots.get(k) ?? 0] } },
          h('i', { class: 'ob-sw' }),
          h('button', { type: 'button', class: 'ob-cmp-name', title: `Show ${base} above`, onclick: () => setScope(k, true) }, h('span', { class: 'ob-cmp-kind' }, KINDS[kindOf(k)][0]), base, provider ? h('span', { class: 'faint' }, `@${provider}`) : null),
          h('b', { class: 'tnum' }, v === null || v === undefined ? '—' : m.format(v)),
          h('button', { type: 'button', class: 'ob-cmp-x', title: 'Remove', onclick: () => toggleCompare(k) }, icon('x', { size: 12 })));
      }), compare.length < CMP_COLORS.length ? cmpAdd : null);
      cmpEmpty.hidden = compare.length > 0;
      cmpBox.hidden = compare.length === 0;
      cmpChart.update(compare.map((k) => ({
        key: k, label: displayName(k).base, color: resolve(CMP_COLORS[slots.get(k) ?? 0]),
        values: pts(k).map((p) => ({ t: p.t, v: m.value(p) })).filter((x) => x.v !== null && x.v !== undefined),
      })));
    }
    function toggleCompare(key) {
      if (compare.includes(key)) { compare = compare.filter((k) => k !== key); slots.delete(key); }
      else if (compare.length < CMP_COLORS.length) {
        compare.push(key);
        const used = new Set(slots.values());
        slots.set(key, CMP_COLORS.findIndex((_, i) => !used.has(i)));
      }
      cmpPinned = true;
      syncUrl();
      paintCompare();
      paintBoard();
      ensure([key]).then(() => paintCompare());
    }

    // ── gauges ──

    const methodsList = barList({ format: (v, r) => `${num(v)}  ${r.share}`, emptyText: 'No requests yet' });
    const tlsList = barList({ format: (v, r) => `${num(v)}  ${r.share}`, emptyText: 'No TLS requests yet' });
    const methodsDonut = liveDonut({ size: 112, thickness: 12 });
    const tlsDonut = liveDonut({ size: 112, thickness: 12 });
    const cipherList = barList({ format: (v) => num(v), emptyText: '—', cls: 'ob-bars-sm' });
    const connNum = h('span', { class: 'ob-num tnum' }, '—');
    const connSpark = liveSpark({ color: 'var(--sky)', width: 200, height: 40, cls: 'ob-inline-spark' });
    const connList = barList({ format: (v) => num(v), emptyText: 'No entry points' });
    const methodsSub = h('span');
    const tlsSub = h('span');
    const gaugeCards = [
      card({ title: 'Methods', icon: 'code', sub: methodsSub }, h('div', { class: 'ob-pair' }, methodsDonut, methodsList)),
      card({ title: 'TLS', icon: 'lock', sub: tlsSub }, h('div', { class: 'ob-pair' }, tlsDonut, tlsList), h('div', { class: 'ob-subhead' }, 'Ciphers'), cipherList),
      card({ title: 'Open connections', icon: 'activity', sub: 'Right now, per entry point' },
        h('div', { class: 'ob-conn-top' }, h('div', {}, connNum, h('div', { class: 'tiny muted' }, 'connections, internal ones aside')), connSpark), connList),
    ];

    const P = {};
    const procTile = (key, label, ic, color) => {
      const v = h('div', { class: 'ob-proc-val tnum' }, '—');
      const sub = h('div', { class: 'ob-proc-sub' });
      const sp = color ? liveSpark({ color, width: 160, height: 34, cls: 'ob-proc-spark' }) : null;
      P[key] = { v, sub, sp };
      return h('div', { class: 'ob-proc' }, h('div', { class: 'ob-proc-label' }, oicon(ic, { size: 14 }), label), v, sub, sp);
    };
    const procCard = card({ title: 'Traefik process', icon: 'cpu', sub: 'The proxy itself, as it reports in its metrics. Trends start when this page opens.' },
      stagger(h('div', { class: 'ob-proc-grid' },
        procTile('mem', 'Memory', 'memory', 'var(--violet)'),
        procTile('cpu', 'CPU', 'cpu', 'var(--torch)'),
        procTile('gor', 'Goroutines', 'wave', 'var(--sky)'),
        procTile('fds', 'File descriptors', 'file', null),
        procTile('up', 'Uptime', 'timer', null),
        procTile('rel', 'Config reloads', 'refresh', null))));

    // ── painters ──

    function paintIdentity() {
      const k = kindOf(scope);
      const name = nameOf(scope);
      const { base, provider } = displayName(scope);
      heroIcon.replaceChildren(icon(KINDS[k][1], { size: 24 }));
      heroIcon.dataset.kind = k;
      heroKind.replaceChildren(k === 'total' ? 'All traffic' : KINDS[k][0], paused ? h('span', { class: 'badge warn' }, icon('pause', { size: 11 }), `paused at ${time(new Date(pausedAt).toISOString())}`) : null);
      heroName.replaceChildren(h('span', { class: 'ellipsis' }, base), provider ? h('span', { class: 'ob-provider' }, `@${provider}`) : null);
      const st = store.state;
      const meta = [];
      const links = [];
      if (k === 'total') {
        const eps = (st?.entrypoints ?? []).filter((e) => !internal.has(e.name));
        const routers = (st?.http?.routers ?? []).filter((r) => r.status === 'enabled' && !r.name.endsWith('@internal'));
        meta.push(h('span', { class: 'muted' }, `${eps.length} entry points · ${routers.length} HTTP routers · ${(st?.http?.services ?? []).length} services`));
        links.push(h('a', { class: 'btn sm', href: '#/logs' }, icon('logs', { size: 14 }), 'Access log'));
      } else if (k === 'router') {
        const r = find('routers', name, 'http');
        if (r) {
          meta.push(h('div', { class: 'row wrap', style: { gap: '6px' } }, statusBadge(r.status),
            ...(r.using ?? r.entryPoints ?? []).map((e) => h('a', { class: 'badge mono', href: hrefFor('entrypoints', e) }, e)),
            r.tls ? badge(r.tls.certResolver ? `TLS · ${r.tls.certResolver}` : 'TLS', 'ok') : null,
            r.service ? h('a', { class: 'badge violet', href: hrefFor('services', r.service.includes('@') ? r.service : `${r.service}@${r.provider}`) }, icon('arrow', { size: 11 }), r.service) : null),
          h('div', { class: 'ob-rule' }, ruleView(r.rule)));
        } else meta.push(h('span', { class: 'muted' }, 'Not in Traefik\'s configuration any more.'));
        links.push(h('a', { class: 'btn sm', href: hrefFor('routers', name) }, icon('router', { size: 14 }), 'Router'), h('a', { class: 'btn sm', href: logsHref(scope) }, icon('logs', { size: 14 }), 'Access log'));
      } else if (k === 'service') {
        const s = find('services', name, 'http');
        if (s) {
          const servers = Object.entries(s.serverStatus ?? {});
          const up = servers.filter(([, v]) => v === 'UP').length;
          meta.push(h('div', { class: 'row wrap', style: { gap: '6px' } }, s.type ? badge(s.type) : null,
            servers.length ? badge(`${up}/${servers.length} servers up`, up === servers.length ? 'ok' : up ? 'warn' : 'bad') : null,
            ...(s.usedBy ?? []).slice(0, 5).map((r) => h('a', { class: 'badge', href: hrefFor('routers', r) }, icon('router', { size: 11 }), split(r).base))));
        }
        links.push(h('a', { class: 'btn sm', href: hrefFor('services', name) }, icon('service', { size: 14 }), 'Service'), h('a', { class: 'btn sm', href: logsHref(scope) }, icon('logs', { size: 14 }), 'Access log'));
      } else if (k === 'ep') {
        const e = st?.entrypoints?.find((x) => x.name === name);
        const routers = [...(st?.http?.routers ?? []), ...(st?.tcp?.routers ?? [])].filter((r) => (r.using ?? r.entryPoints ?? []).includes(name));
        if (e) meta.push(h('div', { class: 'row wrap', style: { gap: '6px' } }, h('span', { class: 'badge mono' }, e.address), badge(`${routers.length} router${routers.length === 1 ? '' : 's'}`),
          e.http?.tls ? badge('TLS', 'ok') : null, e.http?.redirections ? badge('redirects', 'info') : null, internal.has(name) ? badge('internal', 'violet') : null));
        links.push(h('a', { class: 'btn sm', href: hrefFor('entrypoints', name) }, icon('entrypoint', { size: 14 }), 'Entry point'));
      }
      if (k !== 'total') {
        const inCmp = compare.includes(scope);
        links.push(h('button', { type: 'button', class: `btn sm ${inCmp ? '' : 'ghost'}`.trim(), onclick: () => { toggleCompare(scope); paintIdentity(); } }, oicon('compare', { size: 14 }), inCmp ? 'In the comparison' : 'Compare'));
        links.push(h('button', { type: 'button', class: 'btn sm ghost', onclick: () => setScope('total') }, icon('x', { size: 13 }), 'Whole proxy'));
      }
      heroMeta.replaceChildren(...meta);
      heroLinks.replaceChildren(...links);
      shareBox.hidden = k === 'total';
    }

    function windowSums(list) {
      let req = 0; let bad = 0; let peak = 0;
      const dt = step();
      for (const p of list) { req += p.rps * dt; bad += p.r5 * dt; if (p.rps > peak) peak = p.rps; }
      return { req, bad, peak, avg: list.length ? req / (list.length * dt) : 0 };
    }

    function paintLive() {
      const list = pts(scope);
      const p = latestOf(scope);
      countTo(liveNum, p?.rps ?? 0, { format: rate });
      const w = windowSums(list);
      liveFoot.replaceChildren(h('span', {}, 'avg ', h('b', { class: 'tnum' }, rate(w.avg)), '/s'), h('span', {}, 'peak ', h('b', { class: 'tnum' }, rate(w.peak)), '/s'), h('span', {}, h('b', { class: 'tnum' }, num(Math.round(w.req))), ` in ${minutes === 60 ? '1 h' : `${minutes} min`}`));
      const tot = latestOf('total')?.rps ?? 0;
      if (kindOf(scope) !== 'total') {
        const share = tot ? Math.min(1, (p?.rps ?? 0) / tot) : 0;
        shareRing.set(share, { color: 'var(--torch)', value: tot ? pct(share) : '—' });
      }
      const avail = w.req ? 1 - w.bad / w.req : null;
      availRing.set(avail ?? 0, { color: avail === null ? 'var(--faint)' : avail >= 0.995 ? 'var(--ok)' : avail >= 0.95 ? 'var(--warn)' : 'var(--bad)', value: avail === null ? '—' : availTxt(avail) });
    }

    function paintTiles() {
      const list = pts(scope);
      const p = latestOf(scope);
      const series = (f) => thin(list.map(f), 80);
      const w = windowSums(list);
      const tone = (tile, cls) => { tile.valueEl.className = `stat-value ${cls}`.trim(); };
      if (p) {
        countTo(T.rps.valueEl, p.rps, { format: rate });
        countTo(T.err.valueEl, p.errorRate * 100, { format: pctTxt });
        countTo(T.cli.valueEl, p.rps ? (p.r4 / p.rps) * 100 : 0, { format: pctTxt });
        if (p.p95 === null) { T.p95.valueEl.textContent = '—'; } else countTo(T.p95.valueEl, p.p95, { format: ms });
        countTo(T.out.valueEl, p.outBps, { format: (x) => bytes(x, true) });
        tone(T.err, p.errorRate >= 0.05 ? 'bad-text' : p.errorRate > 0.01 ? 'warn-text' : '');
        tone(T.p95, p.p95 >= 1000 ? 'warn-text' : '');
        T.rps.footEl.replaceChildren(`avg ${rate(w.avg)}/s · peak ${rate(w.peak)}/s`);
        T.err.footEl.replaceChildren(`${rate(p.r5)}/s · ${num(Math.round(w.bad))} in window`);
        T.cli.footEl.replaceChildren(`${rate(p.r4)}/s`);
        T.p95.footEl.replaceChildren(p.p50 === null ? 'no requests this tick' : `p50 ${ms(p.p50)} · p99 ${ms(p.p99)}`);
        T.out.footEl.replaceChildren(`in ${bytes(p.inBps, true)}`);
      }
      T.rps.spark.set(series((x) => x.rps));
      T.err.spark.set(series((x) => x.errorRate));
      T.cli.spark.set(series((x) => (x.rps ? x.r4 / x.rps : 0)));
      T.p95.spark.set(series((x) => x.p95));
      T.out.spark.set(series((x) => x.outBps));
      const tot = store.metrics?.totals?.[scope];
      if (tot) {
        countTo(T.served.valueEl, tot.requests, { format: (v) => num(Math.round(v)) });
        T.served.footEl.replaceChildren(`since Traefik started${tot.avg !== null && tot.avg !== undefined ? ` · avg ${ms(tot.avg)}` : ''}`);
        const sum = Object.values(tot.classes ?? {}).reduce((a, v) => a + v, 0) || 1;
        splitBar.replaceChildren(...[['2xx', 'var(--c2xx)'], ['3xx', 'var(--c3xx)'], ['4xx', 'var(--c4xx)'], ['5xx', 'var(--c5xx)']]
          .filter(([c]) => tot.classes?.[c]).map(([c, color]) => h('i', { title: `${c}: ${num(tot.classes[c])} (${pct(tot.classes[c] / sum)})`, style: { width: `${(tot.classes[c] / sum) * 100}%`, background: color } })));
      }
    }

    function paintCharts() {
      const list = pts(scope);
      const ser = (key, label, color, f) => ({ key, label, color: resolve(color), values: list.map((p) => ({ t: p.t, v: f(p) })).filter((x) => x.v !== null && x.v !== undefined) });
      reqChart.update(CLASSES.map(([k, l, c]) => ser(k, l, c, (p) => p[k])));
      errChart.update([ser('e4', '4xx', 'var(--c4xx)', (p) => (p.rps ? (p.r4 / p.rps) * 100 : 0)), ser('e5', '5xx', 'var(--c5xx)', (p) => p.errorRate * 100)]);
      latChart.update([ser('p50', 'p50', 'var(--sky)', (p) => p.p50), ser('p95', 'p95', 'var(--violet)', (p) => p.p95), ser('p99', 'p99', 'var(--ember)', (p) => p.p99)]);
      bwChart.update([ser('in', 'In', 'var(--violet)', (p) => p.inBps), ser('out', 'Out', 'var(--sky)', (p) => p.outBps)]);
      const p = latestOf(scope);
      if (p) {
        for (const [k] of CLASSES) reqLegend.vals[k].textContent = `${rate(p[k])}/s`;
        errLegend.vals.e5.textContent = pct(p.errorRate);
        errLegend.vals.e4.textContent = pct(p.rps ? p.r4 / p.rps : 0);
        for (const k of ['p50', 'p95', 'p99']) latLegend.vals[k].textContent = p[k] === null ? '—' : ms(p[k]);
        bwLegend.vals.out.textContent = bytes(p.outBps, true);
        bwLegend.vals.in.textContent = bytes(p.inBps, true);
      }
      if (cache.has(scope)) for (const c of chartCards) c.classList.remove('ob-wait');
    }

    function codesFor(key) {
      const now = store.metrics?.totals?.[key];
      if (codesMode === 'start' || snaps.length < 2) return { codes: now?.codes ?? {}, live: false };
      const then = snaps[0].totals?.[key];
      const out = {};
      for (const [c, n] of Object.entries(now?.codes ?? {})) { const d = n - (then?.codes?.[c] ?? 0); if (d > 0) out[c] = d; }
      return { codes: out, live: true, seconds: Math.round((snaps[snaps.length - 1].t - snaps[0].t) / 1000) };
    }

    function paintCodes() {
      const { codes, live, seconds } = codesFor(scope);
      const entries = Object.entries(codes).map(([c, n]) => [Number(c), n]).sort((a, b) => b[1] - a[1]);
      const total = entries.reduce((a, [, n]) => a + n, 0);
      const seenInClass = {};
      const rows = entries.map(([c, n]) => {
        const cls = Math.floor(c / 100);
        const i = seenInClass[cls] = (seenInClass[cls] ?? -1) + 1;
        const base = classColor(c);
        const color = i === 0 ? base : `color-mix(in srgb, ${base} ${Math.max(38, 100 - i * 24)}%, var(--panel-solid))`;
        return { key: c, label: h('span', {}, h('b', { class: 'tnum' }, String(c)), ' ', h('span', { class: 'muted' }, statusText(c))), title: `${c} ${statusText(c)}`, value: n, share: pct(total ? n / total : 0), color, swatch: color };
      });
      codesDonut.set(rows.map((r) => ({ key: r.key, label: r.title, value: r.value, color: r.color })), { value: num(total), label: live ? `in ${seconds}s` : 'requests' });
      codesList.set(rows.slice(0, 5));
      codesSub.textContent = codesMode === 'live' && !live ? 'Collecting the last minute… showing all time' : live ? `The last ${seconds} seconds` : 'Since Traefik started';
    }

    function paintGauges() {
      const m = store.metrics ?? {};
      const g = m.gauges ?? {};
      const tot = m.totals?.[scope];
      const methods = Object.entries(tot?.methods ?? {}).sort((a, b) => b[1] - a[1]);
      const mSum = methods.reduce((a, [, n]) => a + n, 0) || 1;
      methodsList.set(methods.map(([k, n]) => ({ key: k, label: k, value: n, share: pct(n / mSum), color: METHOD_COLOR[k] ?? 'var(--muted)', swatch: METHOD_COLOR[k] ?? 'var(--muted)' })));
      methodsDonut.set(methods.map(([k, n]) => ({ key: k, label: k, value: n, color: METHOD_COLOR[k] ?? 'var(--muted)' })), { value: methods.length ? pct(methods[0][1] / mSum) : '—', label: methods[0]?.[0] ?? '' });
      methodsSub.textContent = `${kindOf(scope) === 'total' ? 'Every request' : displayName(scope).base}, since Traefik started`;

      const eps = kindOf(scope) === 'ep' ? [nameOf(scope)] : Object.keys(g.tls ?? {});
      const versions = {};
      for (const ep of eps) for (const [v, n] of Object.entries(g.tls?.[ep] ?? {})) versions[v] = (versions[v] ?? 0) + n;
      const vSum = Object.values(versions).reduce((a, n) => a + n, 0) || 1;
      tlsList.set(Object.entries(versions).sort((a, b) => b[0].localeCompare(a[0])).map(([v, n]) => ({ key: v, label: `TLS ${v}`, value: n, share: pct(n / vSum), color: TLS_COLOR[v] ?? 'var(--muted)', swatch: TLS_COLOR[v] ?? 'var(--muted)', sub: Number(v) < 1.2 ? 'outdated' : '' })));
      const vTop = Object.entries(versions).sort((a, b) => b[1] - a[1])[0];
      tlsDonut.set(Object.entries(versions).map(([v, n]) => ({ key: v, label: `TLS ${v}`, value: n, color: TLS_COLOR[v] ?? 'var(--muted)' })), { value: vTop ? pct(vTop[1] / vSum) : '—', label: vTop ? `TLS ${vTop[0]}` : 'no TLS' });
      tlsSub.textContent = kindOf(scope) === 'ep' ? `Requests over TLS on ${nameOf(scope)}` : 'Every TLS request, by protocol version';
      cipherList.set(Object.entries(g.ciphers ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => ({ key: c, label: c.replace(/^TLS_/, '').replaceAll('_', ' '), title: c, value: n, color: 'var(--violet)' })));

      const conns = Object.entries(g.openConnections ?? {});
      const outside = conns.filter(([ep]) => !internal.has(ep)).reduce((a, [, n]) => a + n, 0);
      countTo(connNum, outside, { format: (v) => num(Math.round(v)) });
      connSpark.set(hist.conns.length ? hist.conns : [outside]);
      connList.set(conns.sort((a, b) => b[1] - a[1]).map(([ep, n]) => ({ key: ep, label: ep, sub: internal.has(ep) ? 'internal' : '', value: n, color: internal.has(ep) ? 'var(--faint)' : 'var(--sky)', active: kindOf(scope) === 'ep' && nameOf(scope) === ep })));

      const pr = g.process ?? {};
      P.mem.v.textContent = pr.memory ? bytes(pr.memory) : '—';
      P.mem.sub.textContent = pr.heap ? `heap ${bytes(pr.heap)}` : 'resident';
      P.mem.sp.set(hist.mem);
      P.cpu.v.textContent = pr.cpu === null || pr.cpu === undefined ? '—' : `${(pr.cpu * 100).toFixed(1)}%`;
      P.cpu.sub.textContent = 'of one core';
      P.cpu.sp.set(hist.cpu);
      P.gor.v.textContent = pr.goroutines ? num(pr.goroutines) : '—';
      P.gor.sub.textContent = 'lightweight threads';
      P.gor.sp.set(hist.gor);
      P.fds.v.textContent = pr.openFds ? num(pr.openFds) : '—';
      P.fds.sub.replaceChildren(pr.maxFds ? h('span', { class: 'col', style: { gap: '6px' } }, `of ${num(pr.maxFds)} allowed`, h('span', { class: 'bar' }, h('span', { style: { width: `${Math.max(1.5, (pr.openFds / pr.maxFds) * 100)}%`, background: pr.openFds / pr.maxFds > 0.8 ? 'var(--bad)' : 'var(--sky)' } }))) : 'open');
      const start = pr.startTime ? pr.startTime * 1000 : store.state?.version?.startDate ? Date.parse(store.state.version.startDate) : null;
      P.up.v.textContent = start ? duration((Date.now() - start) / 1000) : '—';
      P.up.sub.textContent = start ? `since ${dateTime(new Date(start).toISOString())}` : '';
      P.rel.v.textContent = g.reloads === null || g.reloads === undefined ? '—' : num(g.reloads);
      P.rel.sub.replaceChildren(g.lastReloadSuccess ? `last success ${ago(g.lastReloadSuccess * 1000)}` : 'no reload yet');
    }

    function paintAll() {
      paintLive(); paintTiles(); paintCharts(); paintCodes(); paintGauges(); paintCompare();
      if (lbRows.size) paintBoardSparks();
    }

    // ── actions ──

    function syncUrl() {
      setHashQuery('traffic', { scope: scope === 'total' ? '' : scope, m: minutes === 15 ? '' : minutes, cmp: cmpPinned ? compare.join(',') : '' });
    }
    function setScope(key, scroll = false) {
      if (scroll) window.scrollTo({ top: 0, behavior: motionOk() ? 'smooth' : 'auto' });
      if (key === scope) return;
      scope = key;
      scopePick.set(key);
      syncUrl();
      paintIdentity();
      if (!cache.has(key)) for (const c of chartCards) c.classList.add('ob-wait');
      paintAll();
      paintBoard();
      ensure([key]).then(() => paintAll());
    }
    function setWindow(m) {
      minutes = m;
      gen++;
      cache.clear();
      syncUrl();
      for (const c of chartCards) c.classList.add('ob-wait');
      Promise.all([ensure([scope, 'total', ...compare]), loadTop()]).then(() => { paintAll(); paintBoard(true); });
    }
    function setPaused(v) {
      paused = v;
      pausedAt = Date.now();
      paintPause();
      paintIdentity();
      el.classList.toggle('ob-paused', paused);
      if (!paused) { paintAll(); paintBoard(); }
    }

    const onKey = (e) => {
      if (!el.isConnected) { document.removeEventListener('keydown', onKey); return; }
      if (e.key !== 'p' || e.ctrlKey || e.metaKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      setPaused(!paused);
    };
    document.addEventListener('keydown', onKey);

    // ── layout ──

    el.append(
      head,
      notes,
      hero,
      stagger(h('div', { class: 'grid g6 ob-tiles' }, T.rps, T.err, T.cli, T.p95, T.out, T.served)),
      stagger(h('div', { class: 'grid g3' }, h('div', { class: 'span2' }, chartCards[0]), codesCard)),
      stagger(h('div', { class: 'grid g3' }, chartCards[1], chartCards[2], chartCards[3])),
      boardCard,
      compareCard,
      stagger(h('div', { class: 'grid g3' }, ...gaugeCards)),
      procCard,
    );

    async function boot() {
      paintIdentity();
      paintBoard(true);
      paintCompare();
      let info = null;
      try { info = await api('metrics'); } catch { /* shown below */ }
      internal = new Set(info?.internalEntrypoints ?? []);
      const keys = Object.keys(info?.latest ?? store.metrics?.latest ?? {});
      if (info && !info.ok && !keys.length) {
        el.replaceChildren(head, metricsGuide(info.error ?? 'Traefik\'s metrics endpoint did not answer.'));
        return;
      }
      if (info && !info.ok) notes.append(banner('warn', 'The last scrape failed', `${info.error ?? ''} Showing what was collected before.`));
      if (keys.length && !keys.some((k) => k.startsWith('router:'))) {
        notes.append(banner('info', 'Routers have no numbers of their own', h('span', {}, 'Traefik only labels metrics by router when asked: add ', code('--metrics.prometheus.addRoutersLabels=true'), ' to its static configuration.')));
      }
      if (!compare.length) {
        const latest = info?.latest ?? store.metrics?.latest ?? {};
        compare = keys.filter((k) => k.startsWith('router:')).sort((a, b) => (latest[b]?.rps ?? 0) - (latest[a]?.rps ?? 0)).slice(0, 3);
        compare.forEach((k, i) => slots.set(k, i));
      }
      await Promise.all([ensure([scope, 'total', ...compare]), loadTop()]);
      ready = true;
      paintIdentity();
      paintAll();
      paintBoard(true);
    }
    boot();

    return {
      el,
      update(event, data) {
        if (!el.isConnected) return;
        if (event === 'metrics' && data?.latest) {
          append(data.latest);
          const now = Date.now();
          snaps.push({ t: now, totals: data.totals });
          while (snaps.length > 2 && snaps[0].t < now - 62_000) snaps.shift();
          const pr = data.gauges?.process ?? {};
          const conns = Object.entries(data.gauges?.openConnections ?? {}).filter(([ep]) => !internal.has(ep)).reduce((a, [, n]) => a + n, 0);
          for (const [k, v] of [['mem', pr.memory], ['cpu', pr.cpu], ['gor', pr.goroutines], ['conns', conns]]) {
            if (v === null || v === undefined) continue;
            hist[k].push(v);
            if (hist[k].length > 120) hist[k].shift();
          }
          tick++;
          if (!ready) return;
          if (!paused) paintAll();
          if (tick % 3 === 0) loadTop().then(() => { if (!paused) paintBoard(); });
          if (!cache.has(scope)) ensure([scope]).then(() => { if (!paused) paintAll(); });
        } else if (event === 'state' && ready && !paused) paintIdentity();
      },
      destroy() {
        document.removeEventListener('keydown', onKey);
        reqChart.destroy(); errChart.destroy(); latChart.destroy(); bwChart.destroy(); cmpChart.destroy();
      },
    };
  },
};
