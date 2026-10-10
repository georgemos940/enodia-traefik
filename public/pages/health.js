// Health checks: every finding, worst first, grouped by area, each with what to do about it and,
// where it helps, the configuration to paste.
import { h, s, icon } from '../lib/dom.js';
import { store, api, find, all } from '../lib/store.js';
import { pageHead, hrefFor, timeAgo, empty, searchInput, segmented } from '../lib/components.js';
import { healthRing, countTo } from '../lib/charts.js';
import { split, plural } from '../lib/format.js';
import { hostsOf } from '../lib/rules.js';
import { codeBlock, copyBtn, ticon } from '../lib/tools-ui.js';

const SEVS = [
  { id: 'critical', label: 'Critical', icon: 'xcircle', caption: 'Broken now: fix these first' },
  { id: 'warning', label: 'Warnings', icon: 'alert', caption: 'Risky, or about to break' },
  { id: 'info', label: 'Suggestions', icon: 'info', caption: 'Worth a look when you have a minute' },
];
const AREAS = [
  { id: 'routers', label: 'Routers', icon: 'router' },
  { id: 'services', label: 'Services', icon: 'service' },
  { id: 'middlewares', label: 'Middlewares', icon: 'middleware' },
  { id: 'certificates', label: 'Certificates', icon: 'cert' },
  { id: 'traffic', label: 'Traffic', icon: 'traffic' },
  { id: 'setup', label: 'Setup', icon: 'config' },
];
const AREA_COLOR = { routers: 'var(--torch)', services: 'var(--sky)', middlewares: 'var(--violet)', certificates: 'var(--ok)', traffic: 'var(--ember)', setup: 'var(--muted)' };

const kindOf = (f) => f.id.split(':')[0];

export function areaOf(f) {
  const k = kindOf(f);
  if (k === 'errors' || k === 'slow') return 'traffic';
  if (k.startsWith('cert')) return 'certificates';
  const rk = f.resource?.kind ?? '';
  if (rk.endsWith('router')) return 'routers';
  if (rk.endsWith('service')) return 'services';
  if (rk.endsWith('middleware')) return 'middlewares';
  if (rk === 'certificate') return 'certificates';
  return 'setup';
}

function resourceLink(f) {
  const r = f.resource;
  const k = kindOf(f);
  if (!r) {
    if (k === 'router-metrics' || k === 'api-insecure') return { href: '#/config', label: 'static config', icon: 'config' };
    if (k === 'api-unreachable' || k === 'metrics-unreachable') return { href: '#/settings', label: 'setup', icon: 'layers' };
    if (k === 'reload') return { href: '#/changes', label: 'change history', icon: 'history' };
    return null;
  }
  if (r.kind === 'certificate') return { href: '#/certificates', label: r.name, icon: 'cert', what: 'certificates' };
  const [proto, kind] = r.kind.split('-');
  return { href: hrefFor(`${kind}s`, r.name, proto), label: r.name, icon: kind, what: kind };
}

// ── the configuration to paste, per kind of finding ─────────────────────────

const label = (k, v) => `- "${k}=${v}"`;
const lines = (...l) => l.filter((x) => x !== null && x !== undefined && x !== false).join('\n');

function mwNames(r, extra) {
  const names = (r?.middlewares ?? []).map((m) => { const { base, provider } = split(m); return provider === r.provider ? base : m; });
  return [...names, extra].filter(Boolean);
}
function resolvers() { return Object.keys(store.state?.static?.certificatesResolvers ?? {}); }
function tlsEntrypoint() {
  const eps = store.state?.entrypoints ?? [];
  return (eps.find((e) => e.http?.tls) ?? eps.find((e) => /secure|https|443/i.test(`${e.name} ${e.address}`)))?.name ?? 'websecure';
}
function plainEntrypoint(r) {
  const eps = store.state?.entrypoints ?? [];
  const on = (r?.using ?? r?.entryPoints ?? []).find((n) => !eps.find((e) => e.name === n)?.http?.tls);
  return on ?? eps.find((e) => /^(web|http)$/i.test(e.name) || /:80$/.test(e.address))?.name ?? 'web';
}
const redirectStatic = (from, to) => ({ label: 'Static config', lang: 'yaml', code: lines(
  '# every request on this entry point is redirected to HTTPS',
  'entryPoints:', `  ${from}:`, '    http:', '      redirections:', '        entryPoint:', `          to: ${to}`, '          scheme: https') });
const ordered = (provider, tabs) => (provider === 'file' ? [...tabs.filter((t) => t.label === 'File provider'), ...tabs.filter((t) => t.label !== 'File provider')] : tabs);

function snippetsFor(f) {
  const k = kindOf(f);
  const name = f.resource?.name ?? '';
  const { base: b, provider } = split(name);
  const r = f.resource?.kind === 'http-router' ? find('routers', name, 'http') : null;
  const res = resolvers();

  switch (k) {
    case 'api-open': return ordered(provider, [
      { label: 'Docker labels', lang: 'labels', code: lines(
        label('traefik.http.middlewares.dashboard-auth.basicauth.users', 'admin:$$2y$$05$$paste-htpasswd-output-here'),
        label(`traefik.http.routers.${b}.middlewares`, mwNames(r, 'dashboard-auth').join(','))) },
      { label: 'File provider', lang: 'yaml', code: lines('http:', '  middlewares:', '    dashboard-auth:', '      basicAuth:', '        users:', '          - "admin:$2y$05$paste-htpasswd-output-here"', '  routers:', `    ${b}:`, `      middlewares: [${mwNames(r, 'dashboard-auth').join(', ')}]`) },
      { label: 'Make a password', lang: 'sh', code: lines("htpasswd -nbB admin 'a-long-random-password'", '# in docker compose labels, write every $ as $$') },
    ]);
    case 'plain-http': return ordered(provider, [
      { label: 'Docker labels', lang: 'labels', code: lines(
        label('traefik.http.middlewares.to-https.redirectscheme.scheme', 'https'),
        label('traefik.http.middlewares.to-https.redirectscheme.permanent', 'true'),
        label(`traefik.http.routers.${b}.middlewares`, mwNames(r, 'to-https').join(','))) },
      { label: 'File provider', lang: 'yaml', code: lines('http:', '  middlewares:', '    to-https:', '      redirectScheme:', '        scheme: https', '        permanent: true', '  routers:', `    ${b}:`, `      middlewares: [${mwNames(r, 'to-https').join(', ')}]`) },
      redirectStatic(plainEntrypoint(r), tlsEntrypoint()),
    ]);
    case 'auth-plain-http': {
      const to = tlsEntrypoint();
      return ordered(provider, [
        { label: 'Docker labels', lang: 'labels', code: lines(
          label(`traefik.http.routers.${b}.entrypoints`, to),
          label(`traefik.http.routers.${b}.tls`, 'true'),
          res.length ? label(`traefik.http.routers.${b}.tls.certresolver`, res[0]) : null) },
        { label: 'File provider', lang: 'yaml', code: lines('http:', '  routers:', `    ${b}:`, `      entryPoints: [${to}]`, res.length ? `      tls:\n        certResolver: ${res[0]}` : '      tls: {}') },
        redirectStatic(plainEntrypoint(r), to),
      ]);
    }
    case 'cert-missing': {
      const host = /covers (\S+)/.exec(f.title)?.[1] ?? hostsOf(r?.rule)[0] ?? 'example.com';
      const resolver = res[0] ?? 'letsencrypt';
      return ordered(provider, [
        { label: 'Docker labels', lang: 'labels', code: label(`traefik.http.routers.${b}.tls.certresolver`, resolver), note: res.length ? '' : `Define the "${resolver}" resolver in the static configuration first (Static config tab).` },
        res.length ? null : { label: 'Static config', lang: 'yaml', code: lines('certificatesResolvers:', `  ${resolver}:`, '    acme:', '      email: you@example.com', '      storage: /letsencrypt/acme.json', '      httpChallenge:', `        entryPoint: ${plainEntrypoint(null)}`) },
        { label: 'File provider', lang: 'yaml', code: lines('# or bring your own certificate', 'tls:', '  certificates:', `    - certFile: /certs/${host}.crt`, `      keyFile: /certs/${host}.key`) },
        { label: 'Check by hand', lang: 'sh', code: `echo | openssl s_client -connect ${host}:443 -servername ${host} 2>/dev/null | openssl x509 -noout -subject -ext subjectAltName` },
      ].filter(Boolean));
    }
    case 'resolver': {
      const asked = r?.tls?.certResolver ?? 'letsencrypt';
      if (res.length) return ordered(provider, [
        { label: 'Docker labels', lang: 'labels', code: label(`traefik.http.routers.${b}.tls.certresolver`, res[0]) },
        { label: 'File provider', lang: 'yaml', code: lines('http:', '  routers:', `    ${b}:`, '      tls:', `        certResolver: ${res[0]}`) },
      ]);
      return [{ label: 'Static config', lang: 'yaml', code: lines(`# or define "${asked}" so the router gets its certificate`, 'certificatesResolvers:', `  ${asked}:`, '    acme:', '      email: you@example.com', '      storage: /letsencrypt/acme.json', '      httpChallenge:', `        entryPoint: ${plainEntrypoint(null)}`) }];
    }
    case 'duplicate': return ordered(provider, [
      { label: 'Docker labels', lang: 'labels', code: label(`traefik.http.routers.${b}.priority`, '100'), note: 'The higher priority wins. By default a router\'s priority is the length of its rule.' },
      { label: 'File provider', lang: 'yaml', code: lines('http:', '  routers:', `    ${b}:`, '      priority: 100') },
    ]);
    case 'no-healthcheck': return ordered(provider, [
      { label: 'Docker labels', lang: 'labels', code: lines(
        label(`traefik.http.services.${b}.loadbalancer.healthcheck.path`, '/health'),
        label(`traefik.http.services.${b}.loadbalancer.healthcheck.interval`, '10s'),
        label(`traefik.http.services.${b}.loadbalancer.healthcheck.timeout`, '3s')) },
      { label: 'File provider', lang: 'yaml', code: lines('http:', '  services:', `    ${b}:`, '      loadBalancer:', '        healthCheck:', '          path: /health', '          interval: 10s', '          timeout: 3s') },
    ]);
    case 'hsts': return ordered(provider, [
      { label: 'Docker labels', lang: 'labels', code: lines(
        label(`traefik.http.middlewares.${b}.headers.stsSeconds`, '31536000'),
        label(`traefik.http.middlewares.${b}.headers.stsIncludeSubdomains`, 'true')) },
      { label: 'File provider', lang: 'yaml', code: lines('http:', '  middlewares:', `    ${b}:`, '      headers:', '        stsSeconds: 31536000', '        stsIncludeSubdomains: true') },
    ]);
    case 'service-down':
    case 'server-down': {
      const svc = find('services', name, f.resource.kind.split('-')[0]);
      const path = svc?.loadBalancer?.healthCheck?.path ?? '/';
      const down = Object.entries(svc?.serverStatus ?? {}).filter(([, v]) => v !== 'UP').map(([u]) => u).slice(0, 4);
      if (!down.length) return null;
      return [{ label: 'Check by hand', lang: 'sh', code: lines('# from the Traefik container or host: what does the backend answer?', ...down.map((u) => `curl -sS -o /dev/null -w '%{http_code} in %{time_total}s\\n' ${u.replace(/\/$/, '')}${path}`)) }];
    }
    case 'router-metrics': return [
      { label: 'Static config', lang: 'yaml', code: lines('metrics:', '  prometheus:', '    addRoutersLabels: true') },
      { label: 'CLI flags', lang: 'sh', code: '--metrics.prometheus.addrouterslabels=true' },
    ];
    case 'metrics-unreachable': return [
      { label: 'Static config', lang: 'yaml', code: lines('metrics:', '  prometheus:', '    entryPoint: traefik    # served next to the API on :8080', '    addRoutersLabels: true') },
      { label: 'Environment', lang: 'env', code: lines('# Enodia finds the metrics on its own; set this only when they live elsewhere', 'TRAEFIK_METRICS_URL=http://traefik:8080/metrics') },
    ];
    case 'api-unreachable': return [
      { label: 'Environment', lang: 'env', code: lines('# Enodia: the API entry point, over the Docker network', 'TRAEFIK_API_URL=http://traefik:8080') },
      { label: 'Static config', lang: 'yaml', code: lines('api:', '  insecure: true    # the API on the "traefik" entry point, :8080; do not publish that port') },
    ];
    case 'api-insecure': return [{ label: 'Docker compose', lang: 'yaml', code: lines('services:', '  traefik:', '    ports:', '      - "80:80"', '      - "443:443"', '      - "127.0.0.1:8080:8080"   # the API, from this host only (or drop the line)') }];
    case 'reload': return [{ label: 'Check by hand', lang: 'sh', code: 'docker logs traefik --since 15m 2>&1 | grep -iE "error|invalid|cannot"' }];
    case 'cert-expired':
    case 'cert-critical':
    case 'cert-warning': {
      const host = (f.resource?.name ?? 'example.com').replace(/^\*\./, 'www.');
      return [{ label: 'Check by hand', lang: 'sh', code: lines('# what does Traefik serve, and until when?', `echo | openssl s_client -connect ${host}:443 -servername ${host} 2>/dev/null | openssl x509 -noout -dates`, '# and what did the resolver say?', 'docker logs traefik 2>&1 | grep -i acme | tail -20') }];
    }
    default: return null;
  }
}

function extraLinks(f) {
  const k = kindOf(f);
  if ((k === 'errors' || k === 'slow') && f.resource) {
    return [
      h('a', { class: 'btn sm', href: '#/traffic' }, icon('traffic', { size: 14 }), 'Live traffic'),
      h('a', { class: 'btn sm', href: `#/logs?router=${encodeURIComponent(f.resource.name)}` }, icon('logs', { size: 14 }), 'Access log'),
    ];
  }
  return [];
}

const asText = (f) => [`[${f.severity}] ${f.title}`, f.detail, f.fix ? `Fix: ${f.fix}` : '', f.resource ? `Resource: ${f.resource.kind} ${f.resource.name}` : ''].filter(Boolean).join('\n');

// ── the page ─────────────────────────────────────────────────────────────────

export default {
  render(ctx) {
    ctx.setCrumbs([['Health checks']]);
    let sev = ['critical', 'warning', 'info'].includes(ctx.query.get('severity')) ? ctx.query.get('severity') : 'all';
    let area = AREAS.some((a) => a.id === ctx.query.get('area')) ? ctx.query.get('area') : 'all';
    let query = ctx.query.get('q') ?? '';
    let findings = store.findings ?? [];
    let lastAt = Date.now();
    let first = true;
    const open = new Set();
    const fresh = new Set();
    const resolved = [];
    const cache = new Map(); // id -> { key, el }

    // ── hero ──
    const ring = healthRing(store.score ?? 100, { size: 148, thickness: 12 });
    const headline = h('h2', { class: 'tl-hero-title' });
    const sub = h('p', { class: 'tl-hero-sub' });
    const checked = h('div', { class: 'tl-hero-foot' });
    const tiles = Object.fromEntries(SEVS.map((x) => {
      const n = h('b', { class: 'tnum' }, '0');
      const el = h('button', { type: 'button', class: `tl-sevtile ${x.id}`, title: `Show only ${x.label.toLowerCase()}`, onclick: () => setSev(sev === x.id ? 'all' : x.id) },
        h('span', { class: 'tl-sevtile-ic' }, icon(x.icon, { size: 16 })),
        h('span', { class: 'tl-sevtile-label' }, x.label), n);
      el.n = n;
      return [x.id, el];
    }));
    const areaBar = h('div', { class: 'tl-areabar' });
    const areaLegend = h('div', { class: 'tl-arealegend' });
    const hero = h('section', { class: 'card glow tl-hero' },
      h('div', { class: 'tl-hero-ring' }, ring),
      h('div', { class: 'tl-hero-main' }, headline, sub, checked),
      h('div', { class: 'tl-hero-side' },
        h('div', { class: 'tl-sevtiles' }, ...Object.values(tiles)),
        h('div', { class: 'tl-areas' }, h('div', { class: 'tl-mini-label' }, 'By area'), areaBar, areaLegend)));

    // ── toolbar ──
    const sevSeg = h('div', { class: 'tl-seg-wrap' });
    const areaChips = h('div', { class: 'tl-chips' });
    const toggleAll = h('button', { type: 'button', class: 'btn sm ghost tl-toggle-all', onclick: () => {
      const shown = visible();
      const allOpen = shown.length && shown.every((f) => open.has(f.id));
      for (const f of shown) { if (allOpen) open.delete(f.id); else open.add(f.id); }
      paintList();
    } });
    const search = searchInput({ placeholder: 'Search findings, resources, fixes…', value: query, oninput: (v) => { query = v; paintList(); } });
    const toolbar = h('div', { class: 'tl-toolbar' },
      h('div', { class: 'tl-toolbar-row' }, h('div', { class: 'tl-grow-search' }, search), sevSeg, toggleAll),
      areaChips);

    const list = h('div', { class: 'tl-groups' });
    const resolvedBox = h('div');
    const el = h('div', { class: 'col gap-lg tl-page' },
      pageHead({ title: 'Health checks', icon: 'health', sub: 'Enodia checks routers, services, middlewares, certificates and traffic after every poll, and says what to do about anything it finds.' }),
      hero, toolbar, list, resolvedBox);

    function setSev(v) { sev = v; paintHero(); paintTools(); paintList(); }
    function setArea(v) { area = v; paintHero(); paintTools(); paintList(); }

    const matches = (f) => {
      if (!query.trim()) return true;
      const hay = `${f.title} ${f.detail} ${f.fix ?? ''} ${f.resource?.name ?? ''} ${f.resource?.kind ?? ''} ${areaOf(f)} ${f.severity}`.toLowerCase();
      return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
    };
    const visible = () => findings.filter((f) => (sev === 'all' || f.severity === sev) && (area === 'all' || areaOf(f) === area) && matches(f));

    function paintHero() {
      const st = store.state;
      const count = (id) => findings.filter((f) => f.severity === id).length;
      const crit = count('critical'); const warn = count('warning');
      ring.set(store.score ?? 0);
      headline.replaceChildren(!st?.ok ? 'Traefik is not answering' : crit ? `${crit} problem${crit === 1 ? '' : 's'} need${crit === 1 ? 's' : ''} attention` : warn ? `Running, with ${plural(warn, 'warning')}` : 'Everything is healthy');
      headline.className = `tl-hero-title ${!st?.ok || crit ? 'bad' : warn ? 'warn' : 'ok'}`;
      sub.textContent = !st?.ok ? (st?.error ?? 'Enodia cannot reach the Traefik API.') : `Checked ${plural(all('routers').length, 'router')}, ${plural(all('services').length, 'service')} and ${plural(all('middlewares').length, 'middleware')}. The score starts at 100; a critical finding costs 20 points, a warning 6, a suggestion 1.`;
      for (const x of SEVS) { countTo(tiles[x.id].n, count(x.id)); tiles[x.id].classList.toggle('on', sev === x.id); tiles[x.id].classList.toggle('zero', !count(x.id)); }
      const per = AREAS.map((a) => ({ ...a, n: findings.filter((f) => areaOf(f) === a.id).length })).filter((a) => a.n);
      areaBar.replaceChildren(...per.map((a) => h('button', { type: 'button', class: `tl-areaseg ${area === a.id ? 'on' : ''}`, title: `${a.label}: ${a.n}`, 'aria-label': `${a.label}: ${a.n}`, style: { flexGrow: a.n, background: AREA_COLOR[a.id] }, onclick: () => setArea(area === a.id ? 'all' : a.id) })));
      areaBar.classList.toggle('has-on', area !== 'all');
      areaLegend.replaceChildren(...per.map((a) => h('button', { type: 'button', class: `tl-legend-item ${area === a.id ? 'on' : ''}`, onclick: () => setArea(area === a.id ? 'all' : a.id) }, h('i', { style: { background: AREA_COLOR[a.id] } }), a.label, h('b', { class: 'tnum' }, String(a.n)))));
      if (!per.length) areaLegend.replaceChildren(h('span', { class: 'muted small' }, 'Nothing in any area.'));
      checked.replaceChildren(h('span', { class: `dot ${st?.ok ? 'ok pulse' : 'bad'}` }), h('span', {}, `Re-checked after every poll (${store.meta?.pollSeconds ?? 5} s) · last change `), timeAgo(new Date(lastAt).toISOString()));
    }

    function paintTools() {
      const inArea = (f) => area === 'all' || areaOf(f) === area;
      const count = (id) => findings.filter((f) => (id === 'all' || f.severity === id) && inArea(f)).length;
      sevSeg.replaceChildren(segmented([['all', h('span', {}, 'All ', h('i', { class: 'tl-seg-n' }, String(count('all'))))], ['critical', h('span', {}, 'Critical ', h('i', { class: 'tl-seg-n' }, String(count('critical'))))], ['warning', h('span', {}, 'Warning ', h('i', { class: 'tl-seg-n' }, String(count('warning'))))], ['info', h('span', {}, 'Info ', h('i', { class: 'tl-seg-n' }, String(count('info'))))]], sev, (v) => setSev(v)));
      const per = (id) => findings.filter((f) => (sev === 'all' || f.severity === sev) && areaOf(f) === id).length;
      areaChips.replaceChildren(
        h('button', { type: 'button', class: `tl-chip ${area === 'all' ? 'on' : ''}`, onclick: () => setArea('all') }, 'All areas'),
        ...AREAS.map((a) => h('button', { type: 'button', class: `tl-chip ${area === a.id ? 'on' : ''} ${per(a.id) ? '' : 'zero'}`.trim(), onclick: () => setArea(area === a.id ? 'all' : a.id) }, icon(a.icon, { size: 13 }), a.label, h('span', { class: 'tl-chip-n tnum' }, String(per(a.id))))));
    }

    function mark(text) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return text;
      const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
      return String(text).split(re).map((part, i) => (i % 2 ? h('mark', { class: 'tl-hit' }, part) : part));
    }

    function cardFor(f, i) {
      const key = `${JSON.stringify(f)}|${query}`;
      const hit = cache.get(f.id);
      if (hit && hit.key === key) {
        hit.el.classList.toggle('open', open.has(f.id));
        hit.el.firstChild.setAttribute('aria-expanded', String(open.has(f.id)));
        hit.el.classList.remove('tl-rise', 'tl-new');
        return hit.el;
      }
      const link = resourceLink(f);
      const snippets = snippetsFor(f);
      const body = h('div', { class: 'tl-f-body' }, h('div', { class: 'tl-f-inner' },
        f.detail ? h('p', { class: 'tl-f-detail' }, mark(f.detail)) : null,
        f.fix ? h('div', { class: 'tl-fix' }, h('div', { class: 'tl-fix-label' }, ticon('wrench', { size: 14 }), 'How to fix'), h('div', { class: 'tl-fix-text' }, mark(f.fix))) : null,
        snippets ? codeBlock(snippets) : null,
        h('div', { class: 'tl-f-actions' },
          link ? h('a', { class: 'btn sm', href: link.href }, ticon(link.icon, { size: 14 }), link.what ? `Open ${link.what}` : `Open ${link.label}`) : null,
          ...extraLinks(f),
          copyBtn(() => asText(f), { label: 'Copy finding', toastText: 'Finding copied' }),
          h('span', { class: 'grow' }),
          h('code', { class: 'tl-f-id', title: 'Finding id' }, f.id))));
      const toggle = () => {
        const isOpen = !open.has(f.id);
        if (isOpen) open.add(f.id); else open.delete(f.id);
        el.classList.toggle('open', isOpen);
        head.setAttribute('aria-expanded', String(isOpen));
        paintToggleAll();
      };
      const { base, provider } = split(link?.label ?? '');
      const resChip = link && f.resource ? h('a', { class: 'tl-reschip', href: link.href, onclick: (e) => e.stopPropagation(), title: `Open ${f.resource.kind.replace('-', ' ')} ${f.resource.name}` },
        ticon(link.icon, { size: 12 }), h('span', { class: 'ellipsis' }, mark(base)), provider ? h('span', { class: 'faint' }, `@${provider}`) : null) : null;
      const head = h('div', { class: 'tl-f-head', role: 'button', tabindex: '0', 'aria-expanded': String(open.has(f.id)), onclick: toggle, onkeydown: (e) => { if (e.target === head && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); } } },
        h('span', { class: `tl-f-ic ${f.severity}` }, icon(SEVS.find((x) => x.id === f.severity)?.icon ?? 'info', { size: 16 })),
        h('div', { class: 'tl-f-main' },
          h('div', { class: 'tl-f-title' }, mark(f.title)),
          h('div', { class: 'tl-f-meta' }, resChip,
            f.detail ? h('span', { class: 'tl-f-peek' }, f.detail) : null,
            snippets ? h('span', { class: 'tl-f-has', title: 'Comes with configuration to paste' }, ticon('code', { size: 12 }), 'snippet') : null)),
        h('span', { class: 'tl-f-chev' }, icon('down', { size: 16 })));
      const el = h('article', { class: `tl-f ${f.severity} ${open.has(f.id) ? 'open' : ''}`.trim(), dataset: { id: f.id } }, head, body);
      if (first) { el.classList.add('tl-rise'); el.style.setProperty('--i', String(Math.min(i, 14))); }
      if (fresh.has(f.id) && !first) el.classList.add('tl-new');
      cache.set(f.id, { key, el });
      return el;
    }

    function celebration(info) {
      const check = s('svg', { viewBox: '0 0 24 24', width: 44, height: 44, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'tl-clear-check' },
        s('path', { d: 'M20 6 9 17l-5-5', pathLength: '1' }));
      return h('div', { class: 'card tl-clear' },
        h('div', { class: 'tl-clear-art', 'aria-hidden': 'true' },
          h('span', { class: 'tl-clear-ring' }), h('span', { class: 'tl-clear-ring r2' }), h('span', { class: 'tl-clear-ring r3' }),
          ...Array.from({ length: 8 }, (_, i) => h('span', { class: 'tl-spark', style: { '--k': i } })),
          h('div', { class: 'tl-clear-badge' }, check)),
        h('div', { class: 'tl-clear-text' },
          h('h3', {}, 'All clear'),
          h('p', { class: 'muted' }, 'Nothing is broken and nothing is about to break. Enodia keeps watching and re-checks after every poll.'),
          info ? h('p', { class: 'small tl-clear-more' }, `${plural(info, 'suggestion')} below ${info === 1 ? 'is' : 'are'} worth a look when you have a minute.`) : null),
        h('ul', { class: 'tl-clear-list' }, ...[
          [`${plural(all('routers').filter((r) => r.status === 'enabled').length, 'router')} serving`, 'router'],
          ['Every backend answering', 'server'],
          ['Certificates valid', 'cert'],
          ['No error spikes', 'traffic'],
        ].map(([t, ic], k) => h('li', { style: { '--k': k } }, h('span', { class: 'tl-clear-tick' }, icon('check', { size: 12, stroke: 3 })), icon(ic, { size: 14 }), t))));
    }

    function paintToggleAll() {
      const shown = visible();
      const allOpen = shown.length && shown.every((f) => open.has(f.id));
      toggleAll.replaceChildren(ticon(allOpen ? 'fold' : 'unfold', { size: 14 }), h('span', { class: 'tl-hide-sm' }, allOpen ? 'Collapse all' : 'Expand all'));
      toggleAll.disabled = !shown.length;
    }

    function paintList() {
      const shown = visible();
      const crit = findings.filter((f) => f.severity === 'critical').length;
      const warn = findings.filter((f) => f.severity === 'warning').length;
      const info = findings.filter((f) => f.severity === 'info').length;
      paintToggleAll();
      let i = 0;
      const groups = SEVS.map((x) => {
        const items = shown.filter((f) => f.severity === x.id);
        if (!items.length) return null;
        return h('section', { class: `tl-sev ${x.id}` },
          h('div', { class: 'tl-sev-head' }, h('span', { class: `tl-sev-dot ${x.id}` }), h('h3', {}, x.label), h('span', { class: 'tl-sev-n tnum' }, String(items.length)), h('span', { class: 'muted small tl-hide-sm' }, x.caption)),
          ...AREAS.map((a) => {
            const fs = items.filter((f) => areaOf(f) === a.id);
            if (!fs.length) return null;
            return h('div', { class: 'tl-area' },
              h('div', { class: 'tl-area-head' }, icon(a.icon, { size: 13 }), a.label, h('span', { class: 'tl-area-n tnum' }, String(fs.length))),
              h('div', { class: 'tl-f-list' }, ...fs.map((f) => cardFor(f, i++))));
          }));
      });
      const clear = store.state?.ok && !crit && !warn && sev !== 'info' && !query.trim();
      const nothing = !shown.length && !clear
        ? h('div', { class: 'card' }, query.trim() || sev !== 'all' || area !== 'all'
          ? empty('No finding matches', 'Try another search, or clear the filters.', 'search')
          : empty('No findings', 'Nothing to report.', 'ok'))
        : null;
      list.replaceChildren(clear ? celebration(info) : null, nothing, ...groups);
      first = false;
      fresh.clear();
    }

    function paintResolved() {
      if (!resolved.length) { resolvedBox.replaceChildren(); return; }
      resolvedBox.replaceChildren(h('section', { class: 'card tl-resolved' },
        h('div', { class: 'card-head' }, h('div', { class: 'grow' }, h('div', { class: 'card-title' }, icon('ok', { size: 15 }), 'Resolved while you watched'), h('div', { class: 'card-sub' }, 'Findings that went away since this page opened')),
          h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { resolved.length = 0; paintResolved(); } }, 'Clear')),
        h('div', { class: 'card-body tl-resolved-list' }, ...resolved.slice(0, 12).map(({ f, at }) => h('div', { class: 'tl-resolved-row' },
          h('span', { class: `tl-sev-dot ${f.severity}` }), h('span', { class: 'grow ellipsis' }, h('s', {}, f.title)), h('span', { class: 'tiny muted nowrap' }, timeAgo(new Date(at).toISOString())))))));
    }

    function onFindings(next) {
      const prev = new Set(findings.map((f) => f.id));
      const ids = new Set(next.map((f) => f.id));
      const gone = findings.filter((f) => !ids.has(f.id));
      for (const f of next) if (!prev.has(f.id)) fresh.add(f.id);
      for (const f of gone) { resolved.unshift({ f, at: Date.now() }); cache.delete(f.id); open.delete(f.id); }
      if (resolved.length > 50) resolved.length = 50;
      if (gone.length || fresh.size) lastAt = Date.now();
      findings = next;
      const leaving = gone.map((f) => list.querySelector(`.tl-f[data-id="${CSS.escape(f.id)}"]`)).filter(Boolean);
      const done = () => { paintHero(); paintTools(); paintList(); paintResolved(); };
      if (leaving.length) {
        leaving.forEach((x) => { x.style.setProperty('--h', `${x.offsetHeight}px`); x.classList.add('tl-leave'); });
        setTimeout(done, 420);
      } else done();
    }

    paintHero(); paintTools(); paintList();
    // on a direct load the stream may not have said hello yet
    if (!store.state) api('diagnostics').then((d) => { if (!store.state) { findings = d.findings ?? []; store.score = d.score; first = true; paintHero(); paintTools(); paintList(); } }).catch(() => {});

    return {
      el,
      update(event, data) {
        if (event === 'diagnostics') onFindings(data?.findings ?? store.findings ?? []);
        else if (event === 'state') paintHero();
      },
    };
  },
};
