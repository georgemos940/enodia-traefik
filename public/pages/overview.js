// The first screen: is everything fine, how busy is it, and what needs a look.
import { h, icon, stagger } from '../lib/dom.js';
import { store, api, all } from '../lib/store.js';
import { card, stat, badge, hrefFor, resName, dot, segmented, timeAgo, empty, banner } from '../lib/components.js';
import { timeChart, sparkline, healthRing, countTo, bars } from '../lib/charts.js';
import { rate, pct, ms, bytes, duration, num, split, colorFor } from '../lib/format.js';

const CLASS_COLORS = { r2: 'var(--c2xx)', r3: 'var(--c3xx)', r4: 'var(--c4xx)', r5: 'var(--c5xx)' };
const cssVar = (v) => getComputedStyle(document.documentElement).getPropertyValue(v.slice(4, -1)).trim();

export default {
  render(ctx) {
    ctx.setCrumbs([['Overview']]);
    let minutes = 15;
    let points = [];           // total series
    const el = h('div', { class: 'col gap-lg' });

    // ── hero ──
    const ring = healthRing(store.score ?? 100, { size: 132, thickness: 11 });
    const headline = h('h2', { style: { margin: '0', fontSize: '22px', letterSpacing: '-0.01em' } });
    const sub = h('div', { class: 'muted' });
    const facts = h('div', { class: 'row wrap', style: { gap: '8px', marginTop: '12px' } });
    const hero = h('section', { class: 'card glow', style: { padding: '20px', display: 'flex', gap: '24px', alignItems: 'center', flexWrap: 'wrap' } },
      ring, h('div', { class: 'grow col', style: { gap: '4px', minWidth: '240px' } }, headline, sub, facts));

    // ── tiles ──
    const tiles = {
      rps: stat({ label: 'Requests / second', icon: 'zap', value: '—' }),
      err: stat({ label: 'Server errors (5xx)', icon: 'alert', value: '—' }),
      p95: stat({ label: 'Latency p95', icon: 'clock', value: '—' }),
      out: stat({ label: 'Bandwidth out', icon: 'download', value: '—' }),
      conns: stat({ label: 'Open connections', icon: 'activity', value: '—' }),
      routers: stat({ label: 'Routers', icon: 'router', value: '—', href: '#/routers' }),
    };
    const tileGrid = stagger(h('div', { class: 'grid g6' }, ...Object.values(tiles)));

    // ── main chart ──
    const chart = timeChart([], { height: 260, stacked: true, yFormat: (v) => rate(v) });
    const legend = h('div', { class: 'legend' }, ...[['2xx', 'r2'], ['3xx', 'r3'], ['4xx', 'r4'], ['5xx', 'r5']].map(([l, k]) => h('span', {}, h('i', { style: { background: CLASS_COLORS[k] } }), l)));
    const chartCard = card({
      title: 'Requests by status', icon: 'traffic', sub: 'Every entry point that serves traffic, stacked',
      tools: [segmented([[5, '5m'], [15, '15m'], [60, '1h']], minutes, (v) => { minutes = v; loadSeries(); })],
    }, chart.el, h('div', { class: 'mt-sm' }, legend));

    // ── side columns ──
    const topRouters = h('div');
    const epList = h('div', { class: 'col', style: { gap: '10px' } });
    const findingsBox = h('div', { class: 'col', style: { gap: '8px' } });
    const servicesBox = h('div');
    const certBox = h('div', { class: 'col', style: { gap: '8px' } });
    const changesBox = h('div', { class: 'col', style: { gap: '8px' } });

    const metricsOff = store.meta?.features?.metrics === false;
    el.append(
      metricsOff ? banner('info', 'Live traffic is off', 'Set TRAEFIK_METRICS_URL to Traefik\'s Prometheus endpoint to see requests, errors and latency.') : null,
      hero,
      tileGrid,
      stagger(h('div', { class: 'grid g3' },
        h('div', { class: 'span2' }, chartCard),
        card({ title: 'Busiest routers', icon: 'router', sub: 'Last 5 minutes', tools: [h('a', { class: 'btn sm ghost', href: '#/traffic' }, 'Traffic', icon('chevron', { size: 14 }))] }, topRouters))),
      stagger(h('div', { class: 'grid g3' },
        card({ title: 'Needs a look', icon: 'health', tools: [h('a', { class: 'btn sm ghost', href: '#/health' }, 'All checks', icon('chevron', { size: 14 }))] }, findingsBox),
        card({ title: 'Entry points', icon: 'entrypoint', tools: [h('a', { class: 'btn sm ghost', href: '#/entrypoints' }, 'All', icon('chevron', { size: 14 }))] }, epList),
        card({ title: 'Backends', icon: 'server', sub: 'Servers that answer their health check', tools: [h('a', { class: 'btn sm ghost', href: '#/services' }, 'Services', icon('chevron', { size: 14 }))] }, servicesBox))),
      stagger(h('div', { class: 'grid g2' },
        card({ title: 'Certificates', icon: 'cert', tools: [h('a', { class: 'btn sm ghost', href: '#/certificates' }, 'All', icon('chevron', { size: 14 }))] }, certBox),
        card({ title: 'Recent changes', icon: 'history', tools: [h('a', { class: 'btn sm ghost', href: '#/changes' }, 'History', icon('chevron', { size: 14 }))] }, changesBox))),
    );

    // ── painters ──
    function paintHero() {
      const st = store.state;
      const f = store.findings ?? [];
      const crit = f.filter((x) => x.severity === 'critical').length;
      const warn = f.filter((x) => x.severity === 'warning').length;
      ring.set(store.score ?? 0);
      headline.textContent = !st?.ok ? 'Traefik is not answering' : crit ? `${crit} problem${crit === 1 ? '' : 's'} need${crit === 1 ? 's' : ''} attention` : warn ? `Running, with ${warn} warning${warn === 1 ? '' : 's'}` : 'Everything is running smoothly';
      sub.textContent = !st?.ok ? st?.error ?? '' : `${all('routers').filter((r) => r.status === 'enabled').length} routers serving through ${st.entrypoints.length} entry points, ${all('services').length} services behind them.`;
      const v = st?.version;
      const proc = store.metrics?.gauges?.process ?? {};
      facts.replaceChildren(
        v ? badge(`Traefik ${v.Version}${v.Codename ? ` · ${v.Codename}` : ''}`, 'torch') : null,
        v?.startDate ? badge(`up ${duration((Date.now() - Date.parse(v.startDate)) / 1000)}`) : null,
        ...(st?.overview?.providers ?? []).map((p) => badge(p, 'violet')),
        proc.memory ? badge(`${bytes(proc.memory)} memory`) : null,
        proc.cpu !== undefined && proc.cpu !== null ? badge(`${(proc.cpu * 100).toFixed(1)}% CPU`) : null,
        st?.overview?.features?.accessLog ? badge('access log', 'info') : null,
        st?.overview?.features?.metrics ? badge(`metrics: ${st.overview.features.metrics}`, 'info') : null,
        st?.overview?.features?.tracing ? badge(`tracing: ${st.overview.features.tracing}`, 'info') : null);
    }

    function paintTiles() {
      const m = store.metrics;
      const t = m?.latest?.total;
      const last = points.slice(-60);
      const set = (tile, v, fmt, spark, color) => {
        countTo(tile.valueEl, v ?? 0, { format: fmt });
        tile.querySelector('.spark')?.remove();
        if (spark) tile.append(sparkline(spark, { color }));
      };
      if (t) {
        set(tiles.rps, t.rps, rate, last.map((p) => p.rps), cssVar('var(--torch)'));
        set(tiles.err, t.errorRate * 100, (v) => `${v.toFixed(v >= 10 ? 0 : 1)}%`, last.map((p) => p.r5), cssVar('var(--bad)'));
        set(tiles.p95, t.p95 ?? 0, ms, last.map((p) => p.p95 ?? 0), cssVar('var(--violet)'));
        set(tiles.out, t.outBps, (v) => bytes(v, true), last.map((p) => p.outBps), cssVar('var(--sky)'));
        tiles.err.valueEl.className = `stat-value ${t.errorRate >= 0.05 ? 'bad-text' : t.errorRate > 0.01 ? 'warn-text' : ''}`;
      }
      const conns = m?.gauges?.openConnections ?? {};
      const internal = new Set(store.metrics?.internalEntrypoints ?? []);
      const c = Object.entries(conns).filter(([ep]) => !internal.has(ep)).reduce((a, [, v]) => a + v, 0);
      countTo(tiles.conns.valueEl, c, { format: (v) => num(Math.round(v)) });
      const routers = all('routers');
      const broken = routers.filter((r) => r.status !== 'enabled').length;
      tiles.routers.valueEl.replaceChildren(String(routers.length));
      tiles.routers.querySelector('.stat-foot')?.remove();
      tiles.routers.append(h('div', { class: 'stat-foot' }, broken ? h('span', { class: 'bad-text' }, `${broken} not serving`) : h('span', { class: 'ok-text' }, 'all serving')));
    }

    function paintChart() {
      const keys = ['r2', 'r3', 'r4', 'r5'];
      chart.update(keys.map((k) => ({ key: k, label: k.replace('r', '') + 'xx', color: cssVar(CLASS_COLORS[k]), values: points.map((p) => ({ t: p.t, v: p[k] })) })));
    }

    async function paintTop() {
      if (metricsOff) { topRouters.replaceChildren(empty('No metrics', 'Live traffic is off.', 'traffic')); return; }
      try {
        const { rows } = await api(`top?kind=router&minutes=5&limit=7`);
        if (!rows.length) { topRouters.replaceChildren(empty('No traffic yet', 'Requests appear here as they arrive.', 'traffic')); return; }
        topRouters.replaceChildren(bars(rows.map((r) => ({
          label: split(r.name).base, sub: r.errorRate > 0.01 ? `· ${pct(r.errorRate)} errors` : '', value: r.rps, color: r.errorRate >= 0.05 ? 'var(--bad)' : colorFor(r.name),
          onclick: () => { location.hash = hrefFor('routers', r.name); },
        })), { format: (v) => `${rate(v)}/s` }));
      } catch { /* the next tick tries again */ }
    }

    function paintEntrypoints() {
      const st = store.state;
      if (!st) return;
      const conns = store.metrics?.gauges?.openConnections ?? {};
      const internal = new Set(store.metrics?.internalEntrypoints ?? []);
      epList.replaceChildren(...st.entrypoints.map((e) => {
        const p = store.metrics?.latest?.[`ep:${e.name}`];
        const routers = all('routers').filter((r) => (r.using ?? r.entryPoints ?? []).includes(e.name)).length;
        return h('a', { class: 'row', href: hrefFor('entrypoints', e.name), style: { padding: '8px 10px', borderRadius: '10px', background: 'var(--panel-2)', border: '1px solid var(--line)' } },
          h('span', { class: 'badge mono' }, e.address),
          h('div', { class: 'grow col', style: { gap: '0' } }, h('span', { class: 'bold' }, e.name), h('span', { class: 'tiny muted' }, internal.has(e.name) ? 'internal (API / metrics)' : `${routers} router${routers === 1 ? '' : 's'}${e.http?.tls ? ' · TLS' : ''}${e.http?.redirections ? ' · redirects' : ''}`)),
          h('div', { class: 'col', style: { gap: '0', alignItems: 'flex-end' } }, h('span', { class: 'tnum bold' }, p ? `${rate(p.rps)}/s` : '—'), h('span', { class: 'tiny muted tnum' }, `${num(conns[e.name] ?? 0)} conns`)));
      }));
    }

    function paintFindings() {
      const f = (store.findings ?? []).filter((x) => x.severity !== 'info').slice(0, 5);
      if (!f.length) { findingsBox.replaceChildren(h('div', { class: 'empty' }, icon('ok', { size: 28, cls: 'ok-text' }), h('div', { class: 'empty-title' }, 'Nothing to fix'), h('div', { class: 'small' }, `${(store.findings ?? []).length} suggestions on the health page.`))); return; }
      findingsBox.replaceChildren(...f.map((x) => h('a', { href: '#/health', class: 'row', style: { alignItems: 'flex-start', padding: '9px 10px', borderRadius: '10px', background: 'var(--panel-2)', border: '1px solid var(--line)' } },
        icon(x.severity === 'critical' ? 'xcircle' : 'alert', { size: 17, cls: x.severity === 'critical' ? 'bad-text' : 'warn-text' }),
        h('div', { class: 'grow col', style: { gap: '1px' } }, h('span', { class: 'bold small' }, x.title), h('span', { class: 'tiny muted', style: { overflow: 'hidden', display: '-webkit-box', '-webkit-line-clamp': '2', '-webkit-box-orient': 'vertical' } }, x.detail)))));
    }

    function paintServices() {
      const svcs = all('services').filter((s) => s.serverStatus && Object.keys(s.serverStatus).length);
      if (!svcs.length) { servicesBox.replaceChildren(empty('No load-balanced servers', '', 'server')); return; }
      let up = 0; let down = 0;
      for (const s of svcs) for (const v of Object.values(s.serverStatus)) (v === 'UP' ? up++ : down++);
      const cells = svcs.flatMap((s) => Object.entries(s.serverStatus).map(([url, v]) => h('a', {
        href: hrefFor('services', s.name, s.proto), title: `${s.name}\n${url}: ${v}`,
        style: { width: '18px', height: '18px', borderRadius: '5px', background: v === 'UP' ? 'rgba(52,211,153,.75)' : 'rgba(248,113,113,.9)', boxShadow: v === 'UP' ? '0 0 8px rgba(52,211,153,.35)' : '0 0 10px rgba(248,113,113,.6)' },
      })));
      servicesBox.replaceChildren(
        h('div', { class: 'row', style: { gap: '18px', marginBottom: '12px' } },
          h('div', {}, h('div', { class: 'stat-value ok-text', style: { marginTop: 0 } }, String(up)), h('div', { class: 'tiny muted' }, 'servers up')),
          h('div', {}, h('div', { class: `stat-value ${down ? 'bad-text' : 'muted'}`, style: { marginTop: 0 } }, String(down)), h('div', { class: 'tiny muted' }, 'servers down'))),
        h('div', { class: 'row wrap', style: { gap: '5px' } }, ...cells));
    }

    async function paintCerts() {
      let certs = [];
      try { certs = (await api('metrics')).certs ?? []; } catch { /* metrics off */ }
      if (!certs.length) { certBox.replaceChildren(empty('No certificates reported', 'Traefik reports certificates through its metrics.', 'cert')); return; }
      const warn = store.meta?.certWarnDays ?? 21;
      certBox.replaceChildren(...certs.sort((a, b) => Date.parse(a.notAfter) - Date.parse(b.notAfter)).slice(0, 5).map((c) => {
        const days = Math.floor((Date.parse(c.notAfter) - Date.now()) / 86_400_000);
        const tone = days < 0 ? 'bad' : days < (store.meta?.certCriticalDays ?? 7) ? 'bad' : days < warn ? 'warn' : 'ok';
        const fill = h('span', { style: { width: '0%', background: `var(--${tone})` } });
        requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${Math.max(3, Math.min(100, (days / 90) * 100))}%`; }));
        return h('div', { class: 'col', style: { gap: '5px' } },
          h('div', { class: 'row' }, dot(tone), h('span', { class: 'bold ellipsis grow' }, c.cn || c.sans[0]), h('span', { class: `small ${tone}-text tnum` }, days < 0 ? 'expired' : `${days} days`)),
          h('div', { class: 'bar' }, fill));
      }));
    }

    async function paintChanges() {
      let events = store.history;
      if (!events.length) { try { events = (await api('history?limit=8')).events; } catch { events = []; } }
      if (!events.length) { changesBox.replaceChildren(empty('No changes seen yet', 'Every router, service or middleware that appears, changes or goes away shows up here.', 'history')); return; }
      const ICON = { added: ['ok', 'ok-text'], removed: ['xcircle', 'bad-text'], changed: ['refresh', 'torch-text'], 'server-down': ['alert', 'bad-text'], 'server-up': ['ok', 'ok-text'], restart: ['zap', 'torch-text'] };
      changesBox.replaceChildren(...events.slice(0, 7).map((e) => {
        const [ic, cls] = ICON[e.type] ?? ['info', 'muted'];
        const kind = (e.where ?? '').split('.')[1] ?? '';
        return h('div', { class: 'row', style: { gap: '10px' } }, icon(ic, { size: 15, cls }),
          h('div', { class: 'grow ellipsis small' }, h('span', { class: 'bold' }, split(e.name ?? '').base), ' ', h('span', { class: 'muted' }, e.type === 'changed' ? `${kind.replace(/s$/, '')} changed${e.fields?.length ? ` (${e.fields.slice(0, 3).join(', ')})` : ''}` : e.type === 'server-down' ? `server down: ${e.server}` : e.type === 'server-up' ? `server back: ${e.server}` : e.type === 'restart' ? 'Traefik restarted' : `${kind.replace(/s$/, '')} ${e.type}`)),
          h('span', { class: 'tiny muted nowrap' }, timeAgo(e.at)));
      }));
    }

    async function loadSeries() {
      if (metricsOff) return;
      try {
        const r = await api(`series?keys=total&minutes=${minutes}`);
        points = r.series.total ?? [];
        paintChart(); paintTiles();
      } catch { /* retried on the next metrics tick */ }
    }

    paintHero(); paintTiles(); paintEntrypoints(); paintFindings(); paintServices(); paintCerts(); paintChanges(); paintTop();
    loadSeries();
    let tick = 0;

    return {
      el,
      update(event, data) {
        if (event === 'metrics' && data?.latest?.total) {
          points.push(data.latest.total);
          const since = Date.now() - minutes * 60_000;
          while (points.length && points[0].t < since) points.shift();
          paintChart(); paintTiles(); paintEntrypoints(); paintHero();
          if (++tick % 3 === 0) paintTop();
          if (tick % 12 === 0) paintCerts();
        } else if (event === 'state') { paintHero(); paintEntrypoints(); paintServices(); paintTiles(); }
        else if (event === 'diagnostics') { paintHero(); paintFindings(); }
        else if (event === 'history') paintChanges();
        else if (event === 'theme') paintChart();
      },
      destroy() { chart.destroy(); },
    };
  },
};
