// Entry points: where Traefik listens, what each one does with TLS, redirects and client addresses,
// how much traffic it takes, and which routers answer on it.
import { h, icon, stagger } from '../lib/dom.js';
import { store, api, all } from '../lib/store.js';
import { card, stat, badge, kv, jsonView, empty, banner, hrefFor, copyButton, skeleton, navigate } from '../lib/components.js';
import { donut, countTo } from '../lib/charts.js';
import { rate, pct, num, split, plural } from '../lib/format.js';
import { epPort, epIsUdp } from '../lib/rules.js';
import { HIST, seedHistory, miniSpark, liveTraffic, routerTable, epsOf, rebuildable, errTone } from './routers.js';

const TLS_COLORS = { '1.3': '--ok', '1.2': '--sky', '1.1': '--warn', '1.0': '--bad' };
const ROLE = { 'api@internal': 'API', 'dashboard@internal': 'dashboard', 'ping@internal': 'ping', 'prometheus@internal': 'metrics' };
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** "1m0s" -> "1m", "0s" -> "none". */
function goDur(s) {
  if (s === undefined || s === null || s === '') return null;
  const t = String(s).replace(/([hm])0s$/, '$1').replace(/h0m$/, 'h');
  return /^0[a-z]*$/.test(t) ? 'none' : t;
}

const routersOn = (name) => all('routers').filter((r) => epsOf(r).includes(name));

/** What Traefik itself serves on an entry point, from its internal routers. */
function rolesOf(name) {
  return [...new Set(routersOn(name).filter((r) => r.provider === 'internal' || r.name.endsWith('@internal')).map((r) => ROLE[r.service] ?? (/redirect|to-/.test(r.name) ? 'redirect' : split(r.name).base)))];
}

function isInternal(e) {
  if ((store.metrics?.internalEntrypoints ?? []).includes(e.name)) return true;
  const rs = routersOn(e.name);
  return rs.length > 0 && rs.every((r) => r.provider === 'internal');
}

/** The facts worth a line: redirects, default TLS, forwarded headers, proxy protocol, timeouts. */
function facts(e) {
  const out = [];
  const http = e.http ?? {};
  const red = http.redirections?.entryPoint;
  if (red) out.push({ ic: 'external', tone: 'torch', label: 'Redirects', text: `everything to ${red.to ?? '?'}${red.scheme ? ` (${red.scheme})` : ''}${red.permanent === false ? ', temporary' : ', permanent'}` });
  if (http.tls) out.push({ ic: 'lock', tone: 'ok', label: 'TLS', text: `on for every router${http.tls.certResolver ? ` · resolver ${http.tls.certResolver}` : ''}${http.tls.options ? ` · options ${http.tls.options}` : ''}` });
  if (http.middlewares?.length) out.push({ ic: 'middleware', tone: 'violet', label: 'Middlewares', text: `${http.middlewares.map((m) => split(m).base).join(', ')} on every router` });
  const fh = e.forwardedHeaders ?? {};
  if (!epIsUdp(e)) {
    if (fh.insecure) out.push({ ic: 'alert', tone: 'warn', label: 'X-Forwarded', text: 'trusted from anyone (insecure)' });
    else if (fh.trustedIPs?.length) out.push({ ic: 'shield', tone: '', label: 'X-Forwarded', text: `trusted from ${fh.trustedIPs.length > 2 ? plural(fh.trustedIPs.length, 'range') : fh.trustedIPs.join(', ')}` });
    const pp = e.proxyProtocol;
    if (pp) out.push({ ic: 'shield', tone: pp.insecure ? 'warn' : '', label: 'PROXY protocol', text: pp.insecure ? 'accepted from anyone' : `from ${pp.trustedIPs?.length > 2 ? plural(pp.trustedIPs.length, 'range') : (pp.trustedIPs ?? []).join(', ') || 'no one'}` });
  }
  const t = e.transport?.respondingTimeouts ?? {};
  const parts = epIsUdp(e)
    ? [`session ${goDur(e.udp?.timeout) ?? '3s'}`]
    : [['read', t.readTimeout], ['write', t.writeTimeout], ['idle', t.idleTimeout]].filter(([, v]) => v !== undefined).map(([k, v]) => `${k} ${goDur(v)}`);
  if (parts.length) out.push({ ic: 'clock', tone: '', label: 'Timeouts', text: parts.join(' · ') });
  return out;
}

function flagBadges(e, internal) {
  const http = e.http ?? {};
  return [
    internal ? badge('internal', 'violet') : null,
    epIsUdp(e) ? badge('UDP', 'info') : null,
    http.tls ? h('span', { class: 'badge ok' }, icon('lock', { size: 11 }), 'TLS') : null,
    e.http3 ? badge('HTTP/3', 'torch') : null,
    http.redirections?.entryPoint ? h('span', { class: 'badge torch' }, icon('external', { size: 11 }), 'redirect') : null,
    e.proxyProtocol ? badge('PROXY', '') : null,
  ];
}

function tlsMix(name) {
  const m = store.metrics?.gauges?.tls?.[name] ?? {};
  const total = Object.values(m).reduce((a, b) => a + b, 0);
  return { total, parts: Object.entries(m).sort((a, b) => b[0].localeCompare(a[0])).map(([v, n]) => ({ v, n, share: total ? n / total : 0 })) };
}

function tlsBar(name) {
  const { total, parts } = tlsMix(name);
  if (!total) return null;
  return h('div', { class: 'ep-tls' },
    h('div', { class: 'ep-tls-bar' }, ...parts.map((p) => h('span', { title: `TLS ${p.v}: ${num(p.n)} requests`, style: { width: `${Math.max(2, p.share * 100)}%`, background: `var(${TLS_COLORS[p.v] ?? '--violet'})` } }))),
    h('div', { class: 'ep-tls-legend' }, ...parts.map((p) => h('span', {}, h('i', { style: { background: `var(${TLS_COLORS[p.v] ?? '--violet'})` } }), `TLS ${p.v}`, h('b', {}, pct(p.share))))));
}

const sortEps = (list) => [...list].sort((a, b) => Number(isInternal(a)) - Number(isInternal(b)) || (Number(epPort(a)) || 0) - (Number(epPort(b)) || 0));

// ── list ─────────────────────────────────────────────────────────────────────

function renderList(ctx, rebuild) {
  ctx.setCrumbs([['Entry points']]);
  const el = h('div', { class: 'col gap-lg ep-page' });
  el.append(h('div', { class: 'page-head' },
    h('div', { class: 'grow' },
      h('h1', { class: 'page-title' }, icon('entrypoint', { size: 24, cls: 'torch-text' }), 'Entry points'),
      h('p', { class: 'page-sub' }, 'Where Traefik listens: every address and port, what it does with TLS, redirects and client addresses, and how much traffic it takes right now.')),
    h('div', { class: 'row wrap' }, h('a', { class: 'btn', href: '#/tester' }, icon('tester', { size: 15 }), 'Test a URL'))));

  if (!store.state) {
    el.append(h('div', { class: 'ep-grid' }, ...Array.from({ length: 3 }, () => card({}, skeleton(6, 16)))));
    return { el, update(ev) { if (ev === 'state' && store.state) rebuild(); } };
  }

  const metricsOff = store.meta?.features?.metrics === false;
  const tiles = {
    count: stat({ label: 'Entry points', icon: 'entrypoint', value: '—' }),
    rps: stat({ label: 'Requests / second', icon: 'zap', value: '—' }),
    conns: stat({ label: 'Open connections', icon: 'activity', value: '—' }),
    tls: stat({ label: 'Served over TLS', icon: 'lock', value: '—' }),
  };
  const sumSpark = miniSpark(240, 46);
  sumSpark.dataset.extra = 'spark';
  sumSpark.set([]);
  tiles.rps.append(sumSpark);
  el.append(stagger(h('div', { class: 'grid g4' }, ...Object.values(tiles))));

  const grid = h('div', { class: 'col gap-lg' });
  el.append(grid);
  const cards = new Map();   // name -> { rps, conns, err, spark, tls }

  function buildCard(e, i) {
    const internal = isInternal(e);
    const href = hrefFor('entrypoints', e.name);
    const rs = routersOn(e.name);
    const roles = rolesOf(e.name);
    const ref = { rps: h('b', { class: 'tnum' }, '—'), conns: h('b', { class: 'tnum' }, '—'), err: h('b', { class: 'tnum' }, '—'), spark: miniSpark(300, 40), tls: h('div') };
    ref.spark.set([]);
    const go = () => navigate(href);
    const shown = rs.filter((r) => r.provider !== 'internal').slice(0, 6);
    const el2 = h('div', {
      class: `card hover ep-card ${internal ? 'internal' : ''}`.trim(), role: 'link', tabindex: '0', style: { '--i': String(Math.min(i, 12)) },
      onclick: (ev) => { if (!ev.target.closest('a')) go(); }, onkeydown: (ev) => { if (ev.key === 'Enter') go(); },
    },
    h('div', { class: 'ep-top' },
      h('span', { class: `ep-ic ${epIsUdp(e) ? 'udp' : internal ? 'internal' : ''}`.trim() }, icon(epIsUdp(e) ? 'udp' : internal ? 'zap' : 'entrypoint', { size: 18 })),
      h('div', { class: 'grow', style: { minWidth: '0' } },
        h('a', { class: 'ep-name', href }, e.name),
        h('div', { class: 'ep-addr' }, h('span', { class: 'mono' }, e.address ?? '?'), h('span', { class: 'faint' }, ` · ${epIsUdp(e) ? 'UDP' : 'TCP'}`), roles.length && internal ? h('span', { class: 'faint' }, ` · ${roles.join(', ')}`) : null)),
      h('div', { class: 'ep-flags' }, ...flagBadges(e, internal))),
    epIsUdp(e) ? null : h('div', { class: 'ep-live' },
      h('div', { class: 'ep-req' }, ref.rps, h('span', {}, 'req/s')),
      h('div', {}, ref.conns, h('span', {}, 'open conns')),
      h('div', { class: 'ep-req' }, ref.err, h('span', {}, '5xx')),
      h('div', { class: 'ep-nohttp' }, h('span', {}, internal ? 'Traefik\'s own traffic stays out of the request counts.' : 'No HTTP requests here: Traefik counts TCP connections only.'))),
    epIsUdp(e) ? null : h('div', { class: 'ep-spark' }, ref.spark),
    ref.tls,
    h('div', { class: 'ep-facts' }, ...facts(e).map((f) => h('div', { class: 'ep-fact' }, h('span', { class: `ep-fact-ic ${f.tone}`.trim() }, icon(f.ic, { size: 13 })), h('span', { class: 'ep-fact-k' }, f.label), h('span', { class: 'ep-fact-v' }, f.text)))),
    h('div', { class: 'ep-routers' },
      h('span', { class: 'rt-label' }, plural(rs.length, 'router')),
      ...shown.map((r) => h('a', { class: `ep-rchip ${r.status === 'disabled' ? 'bad' : ''}`.trim(), href: hrefFor('routers', r.name, r.proto) }, h('span', { class: `rt-dot ${r.status === 'enabled' ? 'ok' : r.status === 'warning' ? 'warn' : 'bad'}` }), split(r.name).base)),
      rs.length > shown.length + rs.filter((r) => r.provider === 'internal').length ? h('span', { class: 'faint small' }, `+${rs.length - shown.length - rs.filter((r) => r.provider === 'internal').length}`) : null,
      !shown.length && rs.length ? h('span', { class: 'muted small' }, 'Traefik internal only') : null,
      !rs.length ? h('span', { class: 'muted small' }, 'nothing listens here yet') : null));
    ref.card = el2;
    cards.set(e.name, ref);
    return el2;
  }

  function paintCards() {
    cards.clear();
    const eps = sortEps(store.state?.entrypoints ?? []);
    const pub = eps.filter((e) => !isInternal(e));
    const internal = eps.filter((e) => isInternal(e));
    let i = 0;
    grid.replaceChildren(
      pub.length ? h('div', { class: 'ep-grid stagger' }, ...pub.map((e) => buildCard(e, i++))) : null,
      internal.length ? h('div', { class: 'ep-section' }, h('span', {}, 'Traefik\'s own'), h('span', { class: 'muted small' }, 'API, dashboard, ping and metrics: keep these off the internet')) : null,
      internal.length ? h('div', { class: 'ep-grid stagger' }, ...internal.map((e) => buildCard(e, i++))) : null,
      !eps.length ? card({}, empty('No entry points', 'Traefik reports none.', 'entrypoint')) : null);
    paintLive();
  }

  function paintLive() {
    const latest = store.metrics?.latest ?? {};
    const conns = store.metrics?.gauges?.openConnections ?? {};
    for (const [name, ref] of cards) {
      const p = latest[`ep:${name}`];
      ref.card.classList.toggle('no-http', !p && !store.metrics?.totals?.[`ep:${name}`]);
      ref.rps.textContent = p ? rate(p.rps) : '—';
      ref.conns.textContent = num(conns[name] ?? 0);
      ref.err.textContent = p ? pct(p.errorRate) : '—';
      ref.err.className = `tnum ${p && errTone(p.errorRate) ? `${errTone(p.errorRate)}-text` : ''}`.trim();
      ref.spark.set((HIST.get(`ep:${name}`) ?? []).map((x) => x.rps), p && errTone(p.errorRate) === 'bad' ? 'bad' : '');
      ref.tls.replaceChildren(tlsBar(name) ?? '');
    }
    const eps = store.state?.entrypoints ?? [];
    const pub = eps.filter((e) => !isInternal(e));
    tiles.count.valueEl.textContent = num(eps.length);
    tiles.count.querySelector('.stat-foot')?.remove();
    tiles.count.append(h('div', { class: 'stat-foot' }, `${pub.length} public · ${eps.length - pub.length} internal · ${eps.filter(epIsUdp).length} UDP`));
    if (metricsOff) { tiles.rps.valueEl.textContent = 'off'; tiles.tls.valueEl.textContent = 'off'; }
    else {
      countTo(tiles.rps.valueEl, pub.reduce((a, e) => a + (latest[`ep:${e.name}`]?.rps ?? 0), 0), { format: rate });
      const buckets = [];
      for (const e of pub) for (const pt of HIST.get(`ep:${e.name}`) ?? []) buckets.push(pt);
      buckets.sort((a, b) => a.t - b.t);
      const sum = [];
      for (const pt of buckets) { const last = sum[sum.length - 1]; if (last && pt.t - last.t < 1500) last.rps += pt.rps; else sum.push({ t: pt.t, rps: pt.rps }); }
      sumSpark.set(sum.slice(-36).map((x) => x.rps));
      const totals = store.metrics?.totals ?? {};
      const reqs = pub.reduce((a, e) => a + (totals[`ep:${e.name}`]?.requests ?? 0), 0);
      const tlsReqs = pub.reduce((a, e) => a + tlsMix(e.name).total, 0);
      tiles.tls.valueEl.textContent = reqs ? pct(Math.min(1, tlsReqs / reqs)) : '—';
      tiles.tls.querySelector('.stat-foot')?.remove();
      const all13 = pub.reduce((a, e) => a + (store.metrics?.gauges?.tls?.[e.name]?.['1.3'] ?? 0), 0);
      tiles.tls.append(h('div', { class: 'stat-foot' }, tlsReqs ? `${pct(all13 / tlsReqs)} of it on TLS 1.3` : 'no TLS requests yet'));
    }
    countTo(tiles.conns.valueEl, pub.reduce((a, e) => a + (conns[e.name] ?? 0), 0), { format: (v) => num(Math.round(v)) });
    const busiest = pub.map((e) => [e.name, conns[e.name] ?? 0]).sort((a, b) => b[1] - a[1])[0];
    tiles.conns.querySelector('.stat-foot')?.remove();
    if (busiest?.[1]) tiles.conns.append(h('div', { class: 'stat-foot' }, `most on ${busiest[0]}`));
  }

  paintCards();
  seedHistory().then((did) => { if (did) paintLive(); });
  return {
    el,
    update(ev) {
      if (ev === 'metrics') paintLive();
      else if (ev === 'state') paintCards();
    },
  };
}

// ── detail ───────────────────────────────────────────────────────────────────

function renderDetail(ctx, name, rebuild) {
  ctx.setCrumbs([['Entry points', '#/entrypoints'], [name]]);
  const el = h('div', { class: 'col gap-lg ep-page' });
  const e = store.state?.entrypoints?.find((x) => x.name === name);
  if (!e) {
    el.append(store.state
      ? h('div', { class: 'card' }, empty('No such entry point', `Traefik has no entry point called ${name}.`, 'entrypoint'), h('div', { class: 'row', style: { justifyContent: 'center', paddingBottom: '24px' } }, h('a', { class: 'btn', href: '#/entrypoints' }, icon('entrypoint', { size: 15 }), 'All entry points')))
      : card({}, skeleton(6, 18)));
    return { el, update(ev) { if (ev === 'state' && store.state?.entrypoints?.some((x) => x.name === name)) rebuild(); } };
  }
  const fp = JSON.stringify(e);
  const internal = isInternal(e);
  const udp = epIsUdp(e);
  const roles = rolesOf(name);
  const cleanups = [];
  let destroyed = false;

  el.append(h('section', { class: 'card glow rt-hero' },
    h('div', { class: 'rt-hero-top' },
      h('div', { class: 'rt-hero-ic' }, icon(udp ? 'udp' : 'entrypoint', { size: 26 })),
      h('div', { class: 'grow col', style: { gap: '8px', minWidth: '0' } },
        h('div', { class: 'rt-hero-name' }, h('h1', {}, name), copyButton(name, 'Copy the name')),
        h('div', { class: 'row wrap rt-facts' }, h('span', { class: 'badge mono' }, e.address ?? '?'), badge(udp ? 'UDP' : 'TCP', 'violet'), ...flagBadges(e, internal).filter(Boolean).filter((b) => !/^UDP$/.test(b.textContent)))),
      h('div', { class: 'row wrap rt-hero-actions' },
        udp ? null : h('a', { class: 'btn primary', href: `#/tester?ep=${encodeURIComponent(name)}` }, icon('tester', { size: 15 }), 'Test a request here'),
        h('button', { class: 'btn', type: 'button', onclick: () => el.querySelector('#ep-raw')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, icon('code', { size: 15 }), 'JSON'))),
    h('div', { class: 'ep-summary' }, ...summary(e, internal, roles).map((x) => h('div', { class: 'ep-sum' }, icon(x.ic, { size: 15, cls: x.cls }), h('span', {}, x.text))))));

  // traffic
  const key = `ep:${name}`;
  const hasMetrics = store.meta?.features?.metrics !== false && !udp && (store.metrics?.latest?.[key] || store.metrics?.totals?.[key]);
  const traffic = hasMetrics ? liveTraffic(key, { conns: () => store.metrics?.gauges?.openConnections?.[name] ?? 0 }) : null;
  if (traffic) {
    el.append(traffic.tilesEl, ...traffic.chartEls);
    cleanups.push(() => traffic.destroy());
  } else if (!udp) {
    const conns = store.metrics?.gauges?.openConnections?.[name];
    el.append(banner('info', 'No HTTP traffic measured here', conns !== undefined ? `${plural(conns, 'open connection')} right now. Traefik reports request metrics only for HTTP routers${internal ? ', and Enodia leaves out its own API and metrics entry points' : ''}.` : 'Traefik reports request metrics only for entry points that serve HTTP.'));
  }

  // config + TLS
  const http = e.http ?? {};
  const t = e.transport?.respondingTimeouts ?? {};
  const life = e.transport?.lifeCycle ?? {};
  const fh = e.forwardedHeaders ?? {};
  const pp = e.proxyProtocol;
  const red = http.redirections?.entryPoint;
  const block = (title, pairs) => (pairs.filter(Boolean).length ? h('div', { class: 'ep-block' }, h('div', { class: 'rt-label' }, title), kv(pairs)) : null);
  const list = (xs) => h('div', { class: 'chips' }, ...xs.map((x) => h('span', { class: 'chip mono' }, x)));
  const yes = (v, on = 'on', off = 'off') => (v ? h('span', { class: 'ok-text' }, on) : h('span', { class: 'muted' }, off));
  const configCard = card({ title: 'Configuration', icon: 'config', sub: 'From the entry point\'s static configuration' },
    h('div', { class: 'ep-blocks' },
      block('Listening', [
        ['Address', h('span', { class: 'mono' }, e.address ?? '?')],
        ['Port', epPort(e) || '—'],
        ['Protocol', udp ? 'UDP' : 'TCP (HTTP, HTTPS and TCP routers)'],
        e.reusePort !== undefined ? ['Reuse port', yes(e.reusePort)] : null,
        e.asDefault !== undefined ? ['Default for routers', yes(e.asDefault, 'yes', 'no')] : null,
      ]),
      udp ? block('UDP', [['Session timeout', goDur(e.udp?.timeout) ?? 'default (3s)']]) : block('Timeouts', [
        ['Read', goDur(t.readTimeout) ?? 'default'],
        ['Write', goDur(t.writeTimeout) ?? 'default'],
        ['Idle', goDur(t.idleTimeout) ?? 'default'],
        life.graceTimeOut ? ['Shutdown grace', goDur(life.graceTimeOut)] : null,
        life.requestAcceptGraceTimeout ? ['Accept grace', goDur(life.requestAcceptGraceTimeout)] : null,
        e.transport?.keepAliveMaxRequests ? ['Keep-alive requests', num(e.transport.keepAliveMaxRequests)] : null,
        e.transport?.keepAliveMaxTime ? ['Keep-alive time', goDur(e.transport.keepAliveMaxTime)] : null,
      ]),
      udp ? null : block('Client addresses', [
        ['X-Forwarded-*', fh.insecure ? h('span', { class: 'warn-text' }, 'trusted from anyone') : fh.trustedIPs?.length ? list(fh.trustedIPs) : h('span', { class: 'muted' }, 'not trusted: Traefik sets them itself')],
        ['PROXY protocol', !pp ? h('span', { class: 'muted' }, 'off') : pp.insecure ? h('span', { class: 'warn-text' }, 'accepted from anyone') : list(pp.trustedIPs ?? [])],
      ]),
      udp ? null : block('HTTP', [
        ['Redirect', red ? h('span', {}, `to ${red.to}`, h('span', { class: 'muted' }, ` · ${red.scheme ?? 'https'} · ${red.permanent === false ? 'temporary' : 'permanent'}${red.priority ? ` · priority ${red.priority}` : ''}`)) : h('span', { class: 'muted' }, 'none')],
        ['TLS for all', http.tls ? h('span', {}, 'yes', h('span', { class: 'muted' }, [http.tls.certResolver && ` · resolver ${http.tls.certResolver}`, http.tls.options && ` · options ${http.tls.options}`].filter(Boolean).join(''))) : h('span', { class: 'muted' }, 'no, per router')],
        http.tls?.domains?.length ? ['Domains', list(http.tls.domains.flatMap((d) => [d.main, ...(d.sans ?? [])]).filter(Boolean))] : null,
        ['Middlewares', http.middlewares?.length ? h('div', { class: 'chips' }, ...http.middlewares.map((m) => h('a', { class: 'chip', href: hrefFor('middlewares', m) }, split(m).base))) : h('span', { class: 'muted' }, 'none')],
        http.sanitizePath !== undefined ? ['Sanitize path', yes(http.sanitizePath)] : null,
        http.encodeQuerySemicolons !== undefined ? ['Encode ; in query', yes(http.encodeQuerySemicolons)] : null,
        http.maxHeaderBytes ? ['Max header size', `${Math.round(http.maxHeaderBytes / 1024)} KB`] : null,
        e.http2?.maxConcurrentStreams ? ['HTTP/2 streams', num(e.http2.maxConcurrentStreams)] : null,
        ['HTTP/3', e.http3 ? h('span', { class: 'ok-text' }, 'on', e.http3.advertisedPort ? h('span', { class: 'muted' }, ` · advertised on ${e.http3.advertisedPort}`) : null) : h('span', { class: 'muted' }, 'off')],
      ])));

  const tlsBox = h('div', { class: 'col', style: { gap: '12px' } });
  function paintTls() {
    const { total, parts } = tlsMix(name);
    if (!total) {
      tlsBox.replaceChildren(h('div', { class: 'rt-allgood' }, h('span', { class: 'rt-allgood-ic' }, icon('unlock', { size: 20 })), h('div', {}, h('div', { class: 'bold' }, udp ? 'No TLS for UDP' : 'No TLS requests yet'), h('div', { class: 'small muted' }, udp ? 'Datagrams pass through as they come.' : 'Versions show up here once clients connect over TLS.'))));
      return;
    }
    tlsBox.replaceChildren(h('div', { class: 'rt-codes' },
      donut(parts.map((p) => ({ label: `TLS ${p.v}`, value: p.n, color: cssVar(TLS_COLORS[p.v] ?? '--violet') })), { size: 124, thickness: 14, center: parts[0] ? `${parts[0].v}` : '', sub: 'mostly' }),
      h('div', { class: 'rt-code-list grow' }, ...parts.map((p) => h('div', { class: 'rt-code-row' }, h('span', { class: `rt-code ${p.v === '1.3' ? 'ok' : p.v === '1.2' ? 'info' : 'warn'}` }, p.v), h('div', { class: 'bar grow' }, h('span', { style: { width: `${Math.max(2, p.share * 100)}%`, background: `var(${TLS_COLORS[p.v] ?? '--violet'})` } })), h('span', { class: 'tnum small rt-code-n' }, num(p.n)))))),
    parts.some((p) => p.v === '1.0' || p.v === '1.1') ? banner('warn', 'Old TLS versions in use', 'TLS 1.0 and 1.1 are broken; set minVersion: VersionTLS12 in the TLS options.') : null);
  }
  el.append(stagger(h('div', { class: 'grid g3' }, h('div', { class: 'span2' }, configCard), card({ title: 'TLS versions', icon: 'lock', sub: 'Requests since Traefik started' }, tlsBox))));

  // routers
  const protos = [['http', 'HTTP'], ['tcp', 'TCP'], ['udp', 'UDP']].filter(([p]) => (store.state?.[p]?.routers ?? []).some((r) => epsOf(r).includes(name)));
  if (protos.length) {
    let cur = protos[0][0];
    const table = routerTable({ proto: cur, only: (r) => epsOf(r).includes(name), compact: true, sort: 'priority' });
    const tabsEl = h('div', { class: 'tabs rt-tabs ep-tabs' });
    const paintTabs = () => tabsEl.replaceChildren(...protos.map(([p, label]) => h('button', { type: 'button', class: p === cur ? 'on' : '', onclick: () => { cur = p; table.setProto(p); paintTabs(); } }, label, h('span', { class: 'rt-tab-n' }, String((store.state?.[p]?.routers ?? []).filter((r) => epsOf(r).includes(name)).length)))));
    paintTabs();
    el.append(h('section', { class: 'card rt-list-card' },
      h('div', { class: 'card-head' }, h('div', { class: 'grow' }, h('div', { class: 'card-title' }, icon('router', { size: 15 }), 'Routers on this entry point'), h('div', { class: 'card-sub' }, 'In the order Traefik tries them: highest priority first'))),
      h('div', { class: 'rt-list-top' }, protos.length > 1 ? tabsEl : h('div', { style: { height: '10px' } })),
      table.el));
    el.tableTick = () => table.tick();
    el.tableRefresh = () => table.refresh();
  } else {
    el.append(card({ title: 'Routers on this entry point', icon: 'router' }, empty('No router uses it', 'Requests here get a 404 from Traefik.', 'router')));
  }

  // raw
  const rawBox = h('div', {}, skeleton(6, 14));
  let rawJson = null;
  el.append(card({ title: 'Raw JSON', icon: 'code', sub: `GET /api/entrypoints/${name}`, id: 'ep-raw', tools: [h('a', { class: 'btn sm ghost', href: `#/explorer?path=${encodeURIComponent(`/api/entrypoints/${name}`)}` }, 'API explorer', icon('chevron', { size: 14 })), copyButton(() => JSON.stringify(rawJson ?? e, null, 2), 'Copy JSON')] }, rawBox));
  api(`raw?path=${encodeURIComponent(`/api/entrypoints/${name}`)}`).then((j) => { rawJson = j; if (!destroyed) rawBox.replaceChildren(jsonView(j)); })
    .catch((err) => { if (!destroyed) rawBox.replaceChildren(jsonView(e), h('div', { class: 'tiny muted mt-sm' }, `Enodia's copy (the live API said: ${err.message})`)); });

  traffic?.start();
  paintTls();
  seedHistory().then(() => el.tableTick?.());
  return {
    el,
    update(ev, data) {
      if (ev === 'metrics') { traffic?.tick(data); paintTls(); el.tableTick?.(); }
      else if (ev === 'state') {
        const next = store.state?.entrypoints?.find((x) => x.name === name);
        if (!next || JSON.stringify(next) !== fp) rebuild();
        else el.tableRefresh?.();
      } else if (ev === 'diagnostics') el.tableRefresh?.();
      else if (ev === 'theme') { traffic?.paint(); paintTls(); }
    },
    destroy() { destroyed = true; for (const c of cleanups) c(); },
  };
}

/** A few plain sentences about an entry point, for the top of its page. */
function summary(e, internal, roles) {
  const out = [];
  const rs = routersOn(e.name);
  const user = rs.filter((r) => r.provider !== 'internal');
  if (internal) out.push({ ic: 'zap', cls: 'violet-text', text: `Traefik's own entry point${roles.length ? `, serving ${roles.join(', ')}` : ''}. Keep it off the public internet.` });
  if (epIsUdp(e)) out.push({ ic: 'udp', cls: 'muted', text: `Takes UDP datagrams on port ${epPort(e) || '?'}${user.length ? ` and hands them to ${plural(user.length, 'UDP router')}` : ''}.` });
  else if (user.length) {
    const byProto = (p) => user.filter((r) => r.proto === p).length;
    out.push({ ic: 'router', cls: 'torch-text', text: `${plural(user.length, 'router')} answer${user.length === 1 ? 's' : ''} here (${[['http', 'HTTP'], ['tcp', 'TCP']].filter(([p]) => byProto(p)).map(([p, l]) => `${byProto(p)} ${l}`).join(', ')}), ${user.filter((r) => r.tls).length} of them with TLS.` });
  } else if (!internal) out.push({ ic: 'alert', cls: 'warn-text', text: 'No router uses it: every request gets a 404.' });
  const red = e.http?.redirections?.entryPoint;
  if (red) out.push({ ic: 'external', cls: 'torch-text', text: `Sends every request on to ${red.to} over ${red.scheme ?? 'https'} before any router sees it.` });
  const broken = rs.filter((r) => r.status === 'disabled');
  if (broken.length) out.push({ ic: 'xcircle', cls: 'bad-text', text: `${plural(broken.length, 'router')} here ${broken.length === 1 ? 'is' : 'are'} not serving: ${broken.map((r) => split(r.name).base).join(', ')}.` });
  return out;
}

export default {
  render(ctx) {
    const [name] = ctx.params;
    return rebuildable((rebuild) => (name ? renderDetail(ctx, name, rebuild) : renderList(ctx, rebuild)));
  },
};
