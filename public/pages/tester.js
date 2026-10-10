// The route tester: describe a request (or a TCP connection) and see which router Traefik picks, what
// its middlewares do to the request, where it ends up, and why every other router did not match.
import { h, icon, stagger } from '../lib/dom.js';
import { store, all, find } from '../lib/store.js';
import { card, kv, empty, banner, hrefFor, copy, skeleton } from '../lib/components.js';
import { split, plural } from '../lib/format.js';
import { ruleViewEval, buildRequest, buildConnection, guessEntrypoint, rankRouters, simulate, epIsUdp, fmtPriority, explainRule, syntaxOf } from '../lib/rules.js';
import { sampleRequest, epsOf, liveOf, codeTone, rebuildable } from './routers.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const COMMON_HEADERS = ['Host', 'Authorization', 'User-Agent', 'Accept', 'Accept-Language', 'Cookie', 'Origin', 'Referer', 'Access-Control-Request-Method', 'X-Forwarded-For', 'X-Forwarded-Proto', 'X-Real-IP', 'Content-Type'];
const STATUS_TEXT = { 200: 'OK', 301: 'Moved Permanently', 302: 'Found', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 502: 'Bad Gateway', 503: 'Service Unavailable' };

/** The query of the hash, read raw: the shell decodes the whole hash once, which breaks URLs in values. */
function hashQuery() {
  const raw = location.hash.replace(/^#\/?/, '');
  const i = raw.indexOf('?');
  return new URLSearchParams(i < 0 ? '' : raw.slice(i + 1));
}

const lookup = (proto) => ({
  middleware: (n) => find('middlewares', n, proto),
  service: (n) => find('services', n, proto),
});

/** How far a router got: the share of its top-level conditions that hold (for "closest miss"). */
function closeness(row) {
  const ev = row.ev;
  if (!ev?.ast) return 0;
  const items = ev.ast.type === 'and' ? ev.ast.items : [ev.ast];
  return items.filter((x) => ev.results.get(x.id)).length / items.length;
}

function render(ctx, rebuild) {
  ctx.setCrumbs([['Route tester']]);
  const el = h('div', { class: 'col gap-lg tt-page' });
  el.append(h('div', { class: 'page-head' },
    h('div', { class: 'grow' },
      h('h1', { class: 'page-title' }, icon('tester', { size: 24, cls: 'torch-text' }), 'Route tester'),
      h('p', { class: 'page-sub' }, 'Describe a request and Enodia evaluates every rule the way Traefik does: which router answers, what its middlewares do to the request, where it ends up, and why the others did not match. Nothing is sent to Traefik.'))));

  if (!store.state) {
    el.append(card({}, skeleton(5, 20)));
    return { el, update(ev) { if (ev === 'state' && store.state) rebuild(); } };
  }

  // ── state ──
  const q = hashQuery();
  const firstRouter = all('routers').filter((r) => r.proto === 'http' && r.status === 'enabled' && r.provider !== 'internal' && r.rule).sort((a, b) => (liveOf(b.name)?.rps ?? 0) - (liveOf(a.name)?.rps ?? 0) || a.name.localeCompare(b.name))[0];
  const seed = firstRouter ? sampleRequest(firstRouter) : { url: 'http://example.com/', method: 'GET', headers: [] };
  const st = {
    mode: q.get('mode') === 'tcp' ? 'tcp' : 'http',
    url: q.get('url') ?? (q.has('mode') || q.has('ep') ? 'http://example.com/' : seed.url),
    method: (q.get('method') ?? (q.has('url') ? 'GET' : seed.method)).toUpperCase(),
    headers: q.getAll('h').length ? q.getAll('h').map((x) => { const i = x.indexOf(':'); return i < 0 ? [x.trim(), ''] : [x.slice(0, i).trim(), x.slice(i + 1).trim()]; }) : q.has('url') ? [] : seed.headers ?? [],
    ip: q.get('ip') ?? '203.0.113.10',
    ep: q.get('ep') ?? '',
    sni: q.get('sni') ?? '',
    tls: q.get('tls') !== '0',
    alpn: q.get('alpn') ?? '',
  };
  let lastWinner = null;
  let showAll = false;

  // ── the request form ──
  const modeSeg = h('div', { class: 'seg tt-mode', role: 'tablist' });
  const paintMode = () => modeSeg.replaceChildren(...[['http', 'HTTP request', 'globe'], ['tcp', 'TCP connection', 'tcp']].map(([v, l, ic]) => h('button', { type: 'button', class: st.mode === v ? 'on' : '', onclick: () => { if (st.mode === v) return; st.mode = v; paintMode(); paintForm(); run(true); } }, icon(ic, { size: 13 }), l)));
  paintMode();

  const methodSel = h('select', { class: 'input tt-method', 'aria-label': 'Method' }, ...METHODS.map((m) => h('option', { value: m }, m)));
  if (!METHODS.includes(st.method)) methodSel.append(h('option', { value: st.method }, st.method));
  methodSel.value = st.method;
  methodSel.addEventListener('change', () => { st.method = methodSel.value; methodSel.dataset.m = st.method; run(); });
  methodSel.dataset.m = st.method;
  const urlInput = h('input', { class: 'input tt-url', type: 'text', value: st.url, placeholder: 'https://shop.example.com/cart?id=3', spellcheck: false, autocomplete: 'off', 'aria-label': 'URL' });
  urlInput.addEventListener('input', () => { st.url = urlInput.value; run(); });
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(true, true); } });
  const goBtn = h('button', { class: 'btn primary tt-go', type: 'button', onclick: () => run(true, true) }, icon('play', { size: 14 }), 'Test');

  const sniInput = h('input', { class: 'input tt-url', type: 'text', value: st.sni, placeholder: 'db.example.com (the TLS server name)', spellcheck: false, autocomplete: 'off', 'aria-label': 'Server name' });
  sniInput.addEventListener('input', () => { st.sni = sniInput.value; run(); });
  sniInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(true, true); });
  const tlsToggle = h('button', { type: 'button', class: 'tt-toggle', role: 'switch', onclick: () => { st.tls = !st.tls; paintTls(); run(); } });
  const paintTls = () => { tlsToggle.classList.toggle('on', st.tls); tlsToggle.setAttribute('aria-checked', String(st.tls)); tlsToggle.replaceChildren(h('span', { class: 'tt-knob' }), st.tls ? 'TLS' : 'plain TCP'); sniInput.disabled = !st.tls; };
  paintTls();
  const alpnInput = h('input', { class: 'input', type: 'text', value: st.alpn, placeholder: 'h2, http/1.1', spellcheck: false, 'aria-label': 'ALPN' });
  alpnInput.addEventListener('input', () => { st.alpn = alpnInput.value; run(); });

  const epSel = h('select', { class: 'input', 'aria-label': 'Entry point' });
  const epHint = h('div', { class: 'tt-hint' });
  epSel.addEventListener('change', () => { st.ep = epSel.value; run(); });
  const ipInput = h('input', { class: 'input mono', type: 'text', value: st.ip, placeholder: '203.0.113.10', spellcheck: false, 'aria-label': 'Client IP' });
  const ipHint = h('div', { class: 'tt-hint' });
  ipInput.addEventListener('input', () => { st.ip = ipInput.value; run(); });

  const hdrList = h('div', { class: 'tt-headers' });
  const hdrNames = h('datalist', { id: 'tt-header-names' });
  const ruleHeaders = new Set();
  for (const r of all('routers')) for (const m of String(r.rule ?? '').matchAll(/Headers?(?:Regexp)?\(\s*[`"]([^`"]+)[`"]/g)) ruleHeaders.add(m[1]);
  hdrNames.append(...[...new Set([...ruleHeaders, ...COMMON_HEADERS])].map((n) => h('option', { value: n })));
  function paintHeaders() {
    hdrList.replaceChildren(...st.headers.map((pair, i) => {
      const k = h('input', { class: 'input mono', type: 'text', value: pair[0], placeholder: 'Header', list: 'tt-header-names', spellcheck: false, 'aria-label': 'Header name' });
      const v = h('input', { class: 'input mono', type: 'text', value: pair[1], placeholder: 'value', spellcheck: false, 'aria-label': 'Header value' });
      k.addEventListener('input', () => { pair[0] = k.value; run(); });
      v.addEventListener('input', () => { pair[1] = v.value; run(); });
      return h('div', { class: 'tt-hrow' }, k, v, h('button', { type: 'button', class: 'btn ghost icon-only', title: 'Remove', 'aria-label': 'Remove header', onclick: () => { st.headers.splice(i, 1); paintHeaders(); run(); } }, icon('x', { size: 14 })));
    }), h('button', { type: 'button', class: 'btn sm ghost tt-add', onclick: () => { st.headers.push(['', '']); paintHeaders(); hdrList.querySelector('.tt-hrow:last-of-type input')?.focus(); } }, icon('arrow', { size: 13 }), 'Add a header'));
  }
  paintHeaders();

  const tryChips = h('div', { class: 'tt-try' });
  function paintTry() {
    const routers = all('routers').filter((r) => r.proto === st.mode && r.provider !== 'internal' && r.status !== 'disabled' && r.rule)
      .sort((a, b) => (liveOf(b.name)?.rps ?? 0) - (liveOf(a.name)?.rps ?? 0) || a.name.localeCompare(b.name)).slice(0, 12);
    tryChips.replaceChildren(routers.length ? h('span', { class: 'rt-label' }, 'Try one of yours') : null, ...routers.map((r) => h('button', {
      type: 'button', class: 'tt-chip', title: r.rule,
      onclick: () => {
        const x = sampleRequest(r);
        if (st.mode === 'tcp') { st.sni = x.sni || ''; st.tls = Boolean(r.tls); sniInput.value = st.sni; paintTls(); } else {
          st.url = x.url; st.method = x.method; st.headers = x.headers.map((p) => [...p]);
          urlInput.value = st.url; methodSel.value = st.method; methodSel.dataset.m = st.method; paintHeaders();
        }
        st.ep = ''; run(true, true);
      },
    }, icon(st.mode === 'tcp' ? 'tcp' : 'router', { size: 12 }), split(r.name).base)));
  }

  const form = h('section', { class: 'card tt-form' });
  function paintForm() {
    const eps = (store.state?.entrypoints ?? []).filter((e) => !epIsUdp(e));
    epSel.replaceChildren(h('option', { value: '' }, 'Auto'), ...eps.map((e) => h('option', { value: e.name }, `${e.name}  ${e.address ?? ''}`)));
    epSel.value = eps.some((e) => e.name === st.ep) ? st.ep : '';
    const field = (label, control, hint, cls = '') => h('label', { class: `tt-field ${cls}`.trim() }, h('span', { class: 'rt-label' }, label), control, hint ?? null);
    form.replaceChildren(
      h('div', { class: 'tt-form-top' }, modeSeg, h('div', { class: 'grow' }), h('div', { class: 'row tt-share' },
        h('button', { type: 'button', class: 'btn sm ghost', onclick: () => copy(location.href, 'Link copied') }, icon('copy', { size: 13 }), 'Copy link'),
        st.mode === 'http' ? h('button', { type: 'button', class: 'btn sm ghost', onclick: () => copy(curl(), 'curl command copied') }, icon('code', { size: 13 }), 'Copy as curl') : null)),
      st.mode === 'http'
        ? h('div', { class: 'tt-bar' }, methodSel, urlInput, goBtn)
        : h('div', { class: 'tt-bar' }, tlsToggle, sniInput, goBtn),
      h('div', { class: 'tt-fields' },
        field('Entry point', epSel, epHint),
        field('Client IP', ipInput, ipHint),
        st.mode === 'tcp' ? field('ALPN', alpnInput, h('div', { class: 'tt-hint' }, 'Protocols the client offers, comma separated')) : null),
      st.mode === 'http' ? h('div', { class: 'tt-field tt-hfield' }, h('span', { class: 'rt-label' }, 'Headers'), hdrList, hdrNames) : null,
      tryChips);
    paintTry();
  }
  paintForm();
  el.append(form);

  // ── results ──
  const verdictBox = h('div', { class: 'tt-verdict-box' });
  const stepsBox = h('div');
  const seenBox = h('div');
  const decideBox = h('div', { class: 'tt-decide' });
  const decideSub = h('div', { class: 'card-sub' });
  const tcpNote = h('div');
  el.append(verdictBox, tcpNote,
    stagger(h('div', { class: 'grid g3' },
      h('div', { class: 'span2' }, card({ title: 'What happens to it', icon: 'topology', sub: 'Middlewares in order, then the service' }, stepsBox)),
      card({ title: 'As Traefik reads it', icon: 'search' }, seenBox))),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', { class: 'grow' }, h('div', { class: 'card-title' }, icon('layers', { size: 15 }), 'How Traefik decided'), decideSub)),
      h('div', { class: 'card-body' }, decideBox)));

  function curl() {
    const parts = ['curl -i'];
    if (st.method !== 'GET') parts.push(st.method === 'HEAD' ? '-I' : `-X ${st.method}`);
    for (const [k, v] of st.headers) if (k.trim()) parts.push(`-H '${k.trim()}: ${String(v).replace(/'/g, "'\\''")}'`);
    if (/^https:/i.test(st.url)) parts.push('-k');
    parts.push(`'${st.url.replace(/'/g, "'\\''")}'`);
    return parts.join(' ');
  }

  let saveTimer = 0;
  function saveUrl() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const p = new URLSearchParams();
      if (st.mode === 'tcp') {
        p.set('mode', 'tcp');
        if (st.sni) p.set('sni', st.sni);
        if (!st.tls) p.set('tls', '0');
        if (st.alpn) p.set('alpn', st.alpn);
      } else {
        p.set('url', st.url);
        if (st.method !== 'GET') p.set('method', st.method);
        for (const [k, v] of st.headers) if (k.trim()) p.append('h', `${k.trim()}: ${v}`);
      }
      if (st.ip) p.set('ip', st.ip);
      if (st.ep) p.set('ep', st.ep);
      const next = `#/tester?${p.toString()}`;
      if (location.hash !== next) history.replaceState(history.state, '', next);
    }, 250);
  }

  // ── evaluation ──
  let timer = 0;
  function run(now = false, celebrate = false) {
    clearTimeout(timer);
    if (now) evaluate(celebrate);
    else timer = setTimeout(() => evaluate(false), 140);
  }

  function evaluate(celebrate) {
    saveUrl();
    const state = store.state;
    const eps = (state?.entrypoints ?? []).filter((e) => !epIsUdp(e));
    const internal = store.metrics?.internalEntrypoints ?? [];
    let req;
    try {
      req = st.mode === 'tcp'
        ? { ...buildConnection({ sni: st.sni, tls: st.tls, clientIP: st.ip, alpn: st.alpn }), port: '' }
        : buildRequest({ url: st.url, method: st.method, headers: st.headers, clientIP: st.ip });
    } catch (e) {
      verdictBox.replaceChildren(h('section', { class: 'card tt-verdict tone-warn' }, h('div', { class: 'tt-v-ic' }, icon('alert', { size: 30 })), h('div', { class: 'tt-v-main' }, h('div', { class: 'tt-kicker' }, 'Cannot test this'), h('h2', { class: 'tt-v-title' }, e.message), h('div', { class: 'tt-v-sub' }, 'Type a full URL such as https://shop.example.com/cart'))));
      stepsBox.replaceChildren(empty('Nothing to show yet', '', 'topology'));
      seenBox.replaceChildren(empty('Nothing to show yet', '', 'search'));
      decideBox.replaceChildren();
      decideSub.textContent = '';
      tcpNote.replaceChildren();
      return;
    }

    // which entry point
    const guess = st.mode === 'http' ? guessEntrypoint(req, eps, internal) : null;
    const epName = st.ep || guess?.name || (st.mode === 'tcp' ? eps.find((e) => (state.tcp?.routers ?? []).some((r) => epsOf(r).includes(e.name)))?.name : '') || eps[0]?.name || '';
    const ep = eps.find((e) => e.name === epName) ?? null;
    epHint.replaceChildren(!st.ep && guess ? h('span', {}, h('b', {}, guess.name), ` · ${guess.how}`) : !st.ep && st.mode === 'tcp' && ep ? h('span', {}, h('b', {}, ep.name), ' · the first one with TCP routers') : ep ? h('span', {}, `${ep.address ?? ''}${ep.http?.tls ? ' · TLS for every router' : ''}`) : 'No entry point');
    const ip = String(st.ip ?? '').trim();
    ipHint.replaceChildren(!ip ? 'Leave empty to test without one' : /^[\d.]+$|:/.test(ip) ? 'Matched by ClientIP() and allow lists' : h('span', { class: 'warn-text' }, 'Not an IP address'));

    // TCP routers on the same entry point see the connection before any HTTP router
    const tcpRouters = (state.tcp?.routers ?? []).map((r) => ({ ...r, proto: 'tcp' }));
    const httpRouters = (state.http?.routers ?? []).map((r) => ({ ...r, proto: 'http' }));
    let tcpFirst = null;
    if (st.mode === 'http' && ep && tcpRouters.some((r) => epsOf(r).includes(ep.name))) {
      const conn = buildConnection({ sni: req.host, tls: req.tls, clientIP: req.clientIP });
      const t = rankRouters(tcpRouters, conn, { proto: 'tcp', entrypoint: ep, staticConfig: state.static });
      if (t.winner) tcpFirst = t.winner;
    }
    const proto = st.mode === 'tcp' || tcpFirst ? 'tcp' : 'http';
    const rank = st.mode === 'tcp'
      ? rankRouters(tcpRouters, req, { proto: 'tcp', entrypoint: ep, staticConfig: state.static })
      : rankRouters(httpRouters, req, { proto: 'http', entrypoint: ep, staticConfig: state.static });
    const winner = tcpFirst ?? rank.winner;
    const sim = winner ? simulate({ router: winner.router, req, entrypoint: proto === 'http' ? ep : null, lookup: lookup(proto), proto }) : null;
    const httpFallback = st.mode === 'tcp' && !rank.winner && ep && httpRouters.some((r) => epsOf(r).includes(ep.name));

    tcpNote.replaceChildren(tcpFirst ? banner('warn', `The TCP router ${tcpFirst.router.name} takes this connection first`, 'On an entry point with both, TCP routers are tried before HTTP routers. The HTTP routers below never see this request.') : null);
    paintVerdict({ req, ep, winner, sim, rank, proto, celebrate, httpFallback });
    paintSteps({ req, ep, winner, sim, proto });
    paintSeen({ req, ep, guess });
    paintDecide({ rank, ep, tcpFirst });
  }

  // ── painters ──
  function particles() {
    return h('span', { class: 'tt-burst', 'aria-hidden': 'true' }, ...Array.from({ length: 14 }, (_, i) => h('i', { style: { '--a': `${(360 / 14) * i + (i % 2) * 9}deg`, '--d': `${46 + (i % 3) * 14}px`, '--t': `${(i % 4) * 40}ms` } })));
  }

  function paintVerdict({ req, ep, winner, sim, rank, proto, celebrate, httpFallback }) {
    const where = ep ? `on ${ep.name}` : 'on no entry point';
    if (!winner) {
      const closest = rank.rows.filter((x) => x.verdict === 'miss').map((x) => [x, closeness(x)]).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])[0]?.[0];
      lastWinner = null;
      verdictBox.replaceChildren(h('section', { class: `card tt-verdict tone-none ${celebrate ? 'pop' : ''}`.trim() },
        h('div', { class: 'tt-v-ic' }, h('span', { class: 'tt-404' }, st.mode === 'tcp' ? icon('xcircle', { size: 30 }) : '404')),
        h('div', { class: 'tt-v-main' },
          h('div', { class: 'tt-kicker' }, 'No router matches'),
          h('h2', { class: 'tt-v-title' }, st.mode === 'tcp' ? (httpFallback ? 'The HTTP routers take over' : 'Traefik closes the connection') : '404 page not found'),
          h('div', { class: 'tt-v-sub' }, st.mode === 'tcp'
            ? (httpFallback ? `No TCP router ${where} takes it, so Traefik hands the connection to the HTTP routers there.` : `None of the ${plural(rank.rows.length, 'TCP router')} ${where} takes this connection.`)
            : rank.rows.length ? `Traefik answers this itself: none of the ${plural(rank.rows.length, 'router')} ${where} match.` : `No router listens ${where}, so every request there gets a 404.`),
          closest ? h('div', { class: 'tt-closest' }, h('span', { class: 'rt-label' }, 'Closest'), h('a', { href: hrefFor('routers', closest.router.name, closest.router.proto) }, split(closest.router.name).base), h('span', { class: 'muted' }, closest.reasons[0] ?? '')) : null)));
      return;
    }
    const r = winner.router;
    const o = sim.outcome;
    const isNew = lastWinner !== `${r.proto}:${r.name}:${o.kind}`;
    lastWinner = `${r.proto}:${r.name}:${o.kind}`;
    const tone = o.kind === 'forward' || o.kind === 'answer' || (o.kind === 'internal' && o.status) ? 'ok' : o.kind === 'redirect' || (o.kind === 'internal' && !o.status) ? 'torch' : o.kind === 'auth' ? 'warn' : 'bad';
    const matching = rank.rows.filter((x) => x.verdict === 'winner' || x.verdict === 'shadowed').length;
    const outcome = (() => {
      if (o.kind === 'forward') {
        return h('div', { class: 'tt-out' },
          h('div', { class: 'tt-kicker' }, proto === 'tcp' ? 'Connects to' : 'Reaches'),
          h('div', { class: 'tt-out-main mono' }, o.backend || split(o.service ?? '').base || '—'),
          h('div', { class: 'tt-out-sub' }, h('a', { href: hrefFor('services', o.service ?? '', proto) }, split(o.service ?? '').base), ` · ${o.text}`, proto === 'http' && o.path !== req.path ? h('span', { class: 'torch-text' }, ` · path ${req.path} becomes ${o.path}`) : null));
      }
      if (o.kind === 'redirect') {
        return h('div', { class: 'tt-out' },
          h('div', { class: 'tt-kicker' }, h('span', { class: 'rt-code info' }, String(o.status)), ` ${STATUS_TEXT[o.status] ?? 'Redirect'}`),
          h('div', { class: 'tt-out-main mono' }, o.location),
          h('div', { class: 'tt-out-sub' }, h('button', { type: 'button', class: 'btn sm', onclick: () => { st.url = o.location; urlInput.value = st.url; st.ep = ''; epSel.value = ''; run(true, true); } }, icon('arrow', { size: 13 }), 'Follow it')));
      }
      return h('div', { class: 'tt-out' },
        h('div', { class: 'tt-kicker' }, o.status ? h('span', { class: `rt-code ${codeTone(o.status)}` }, String(o.status)) : null, o.status ? ` ${STATUS_TEXT[o.status] ?? ''}` : 'Traefik answers itself'),
        h('div', { class: 'tt-out-main' }, o.text));
    })();
    const ic = tone === 'ok' ? 'check' : tone === 'torch' ? 'external' : tone === 'warn' ? 'lock' : 'xcircle';
    verdictBox.replaceChildren(h('section', { class: `card tt-verdict tone-${tone} ${celebrate || isNew ? 'pop' : ''}`.trim() },
      h('div', { class: 'tt-v-ic' }, h('span', { class: 'tt-v-badge' }, icon(ic, { size: 30, stroke: 2.4 })), celebrate || isNew ? particles() : null),
      h('div', { class: 'tt-v-main' },
        h('div', { class: 'tt-kicker' }, proto === 'tcp' ? 'Taken by the TCP router' : 'Answered by'),
        h('h2', { class: 'tt-v-title' }, h('a', { href: hrefFor('routers', r.name, r.proto) }, split(r.name).base), h('span', { class: 'tt-v-prov' }, `@${split(r.name).provider}`)),
        h('div', { class: 'tt-v-sub' }, `${where} · priority ${fmtPriority(winner.priority)} · ${matching > 1 ? `first of ${matching} routers that match` : 'the only router that matches'}`),
        r.rule ? h('div', { class: 'tt-v-rule' }, ruleViewEval(r.rule, winner.ev)) : null),
      outcome));
  }

  function paintSteps({ req, ep, winner, sim, proto }) {
    if (!winner) {
      stepsBox.replaceChildren(h('div', { class: 'tt-steps' },
        step('entrypoint', ep?.name ?? 'entry point', `${ep?.address ?? ''}${req.tls ? ' · TLS' : ''}`, 'Entry point', ''),
        step('xcircle', st.mode === 'tcp' ? 'No TCP router' : 'No router', st.mode === 'tcp' ? 'Nothing takes the connection' : 'Traefik answers 404 page not found', '', 'bad', true)));
      return;
    }
    const r = winner.router;
    const o = sim.outcome;
    const items = [step('entrypoint', ep?.name ?? '?', `${ep?.address ?? ''}${req.tls ? ` · TLS${r.tls?.certResolver ? ` with ${r.tls.certResolver}` : ''}${r.tls?.passthrough ? ' passthrough' : ''}` : ''}`, 'Entry point', '')];
    items.push(step(proto === 'tcp' ? 'tcp' : 'router', split(r.name).base, r.rule ? explainRule(r.rule, { syntax: syntaxOf(r, store.state?.static), proto }) : 'catches everything', 'Router', 'ok', false, hrefFor('routers', r.name, r.proto)));
    for (const s0 of sim.steps) {
      items.push(step(s0.info.icon, split(s0.name).base, s0.effect, `${s0.info.type === 'missing' ? 'Middleware' : s0.info.label}${s0.from && s0.from !== 'router' ? ` · from ${s0.from}` : ''}`, s0.tone, s0.stop, hrefFor('middlewares', s0.name, proto)));
    }
    if (o.kind === 'forward' || o.kind === 'unavailable' || o.kind === 'broken' || o.kind === 'internal') {
      for (const t of o.trail ?? []) items.push(step(t.type === 'weighted' ? 'weight' : t.type === 'mirroring' ? 'mirror' : 'failover', split(t.service).base, t.text, `Service · ${t.type}`, '', false, hrefFor('services', t.service, proto)));
      const servers = o.servers ?? [];
      items.push(step(o.kind === 'internal' ? 'zap' : 'service', split(o.service ?? '').base || 'service', o.kind === 'forward' ? (o.backend ? `${o.text}: ${o.backend}` : o.text) : o.text, o.kind === 'internal' ? 'Traefik internal' : 'Service', o.kind === 'forward' || o.kind === 'internal' ? 'ok' : 'bad', true, o.service ? hrefFor('services', o.service, proto) : undefined,
        servers.length > 1 ? h('div', { class: 'tt-servers' }, ...servers.map((x) => h('span', { class: `tt-server ${x.status === 'DOWN' ? 'bad' : ''}`.trim() }, h('span', { class: `dot ${x.status === 'DOWN' ? 'bad' : x.status === 'UP' ? 'ok' : ''}`.trim() }), x.url))) : null));
    } else if (sim.steps.every((x) => !x.stop)) {
      items.push(step('xcircle', 'Stops', o.text, '', 'bad', true));
    }
    if (o.headers?.length && o.kind === 'forward') items.push(h('div', { class: 'tt-added' }, h('span', { class: 'rt-label' }, 'Headers added on the way'), ...o.headers.map(([k, v]) => h('span', { class: 'chip mono' }, `${k}: ${v}`))));
    stepsBox.replaceChildren(h('div', { class: 'tt-steps' }, ...items));
  }

  function step(ic, title, text, kind, tone = '', stop = false, href, extra) {
    return h('div', { class: `tt-step ${tone ? `t-${tone}` : ''} ${stop ? 'stop' : ''}`.replace(/\s+/g, ' ').trim() },
      h('span', { class: 'tt-step-ic' }, icon(ic, { size: 14 })),
      h('div', { class: 'tt-step-body' },
        h('div', { class: 'tt-step-head' }, href ? h('a', { href, class: 'bold' }, title) : h('span', { class: 'bold' }, title), kind ? h('span', { class: 'tt-step-kind' }, kind) : null, stop && tone !== 'ok' ? h('span', { class: `tt-step-stop ${tone}` }, 'stops here') : null),
        text ? h('div', { class: 'tt-step-text' }, text) : null,
        extra ?? null));
  }

  function paintSeen({ req, ep, guess }) {
    if (st.mode === 'tcp') {
      seenBox.replaceChildren(kv([
        ['TLS', req.tls ? h('span', { class: 'ok-text' }, 'yes') : h('span', { class: 'muted' }, 'no, plain TCP')],
        ['Server name', req.tls ? h('span', { class: 'mono' }, req.sni || '(none)') : h('span', { class: 'muted' }, 'only with TLS')],
        ['ALPN', req.alpn.length ? h('span', { class: 'mono' }, req.alpn.join(', ')) : h('span', { class: 'muted' }, 'none')],
        ['Client IP', req.clientIP ? h('span', { class: 'mono' }, req.clientIP) : h('span', { class: 'muted' }, 'none')],
        ['Entry point', ep ? h('a', { href: hrefFor('entrypoints', ep.name) }, ep.name) : '—'],
      ]));
      return;
    }
    const hostFrom = req.headers.has('host') ? 'from the Host header' : 'from the URL';
    seenBox.replaceChildren(kv([
      ['Method', h('span', { class: 'mono bold' }, req.method)],
      ['Scheme', h('span', {}, req.scheme, req.tls ? h('span', { class: 'muted small' }, ` · TLS, SNI ${req.sni}`) : null)],
      ['Host', h('span', {}, h('span', { class: 'mono' }, req.host || '(none)'), h('span', { class: 'muted small' }, ` ${hostFrom}`))],
      ['Port', h('span', { class: 'mono' }, req.port)],
      ['Path', h('span', { class: 'mono' }, req.path, req.rawPath !== req.path ? h('span', { class: 'muted small' }, ` (sent as ${req.rawPath})`) : null)],
      req.query.size ? ['Query', h('div', { class: 'chips' }, ...[...req.query].flatMap(([k, vs]) => vs.map((v) => h('span', { class: 'chip mono' }, v === '' ? k : `${k} = ${v}`))))] : null,
      req.headers.size ? ['Headers', h('div', { class: 'chips' }, ...[...req.headers].flatMap(([k, vs]) => vs.map((v) => h('span', { class: 'chip mono' }, `${k}: ${v}`))))] : null,
      ['Client IP', req.clientIP ? h('span', { class: 'mono' }, req.clientIP) : h('span', { class: 'muted' }, 'none')],
      ['Entry point', ep ? h('span', {}, h('a', { href: hrefFor('entrypoints', ep.name) }, ep.name), h('span', { class: 'muted small' }, st.ep ? ' · chosen' : guess ? ` · ${guess.how}` : '')) : '—'],
    ]));
  }

  function paintDecide({ rank, ep, tcpFirst }) {
    const rows = rank.rows;
    decideSub.textContent = ep ? `${plural(rows.length, st.mode === 'tcp' ? 'TCP router' : 'router')} on ${ep.name}, in the order Traefik tries them${rank.others ? ` · ${rank.others} on other entry points not considered` : ''}` : '';
    if (!rows.length) { decideBox.replaceChildren(empty(`No ${st.mode === 'tcp' ? 'TCP ' : ''}router on this entry point`, ep ? `Nothing is configured on ${ep.name}.` : 'Pick an entry point.', 'router')); return; }
    const LABEL = { winner: ['Answers', 'ok', 'check'], shadowed: ['Matches too', 'warn', 'layers'], miss: ['No match', 'bad', 'x'], skipped: ['Skipped', 'muted', 'pause'], error: ['Rule error', 'bad', 'alert'] };
    const important = rows.filter((x) => x.verdict === 'winner' || x.verdict === 'shadowed' || x.verdict === 'error');
    const limit = showAll ? rows.length : Math.max(30, rows.indexOf(important[important.length - 1] ?? rows[0]) + 1);
    const shown = rows.slice(0, limit);
    decideBox.replaceChildren(
      ...shown.map((x, i) => {
        const [label, tone, ic] = LABEL[x.verdict];
        const r = x.router;
        const overridden = tcpFirst && x.verdict === 'winner';
        return h('div', { class: `tt-row v-${x.verdict}${overridden ? ' overridden' : ''}`, style: { '--i': String(Math.min(i, 14)) } },
          h('div', { class: 'tt-rank' }, String(i + 1)),
          h('div', { class: 'tt-row-main' },
            h('div', { class: 'tt-row-head' },
              h('a', { class: 'tt-row-name', href: hrefFor('routers', r.name, r.proto) }, split(r.name).base, h('span', { class: 'faint' }, `@${split(r.name).provider}`)),
              h('span', { class: 'tt-prio mono', title: 'Priority' }, fmtPriority(x.priority)),
              h('span', { class: `tt-verdict-pill ${tone}` }, icon(ic, { size: 12 }), overridden ? 'Would answer' : label)),
            r.rule ? ruleViewEval(r.rule, x.ev) : h('span', { class: 'muted small' }, 'no rule'),
            x.reasons.length && x.verdict !== 'winner' ? h('ul', { class: 'tt-reasons' }, ...x.reasons.map((t) => h('li', {}, t))) : null));
      }),
      rows.length > shown.length ? h('button', { type: 'button', class: 'btn sm tt-more', onclick: () => { showAll = true; evaluate(false); } }, `Show ${rows.length - shown.length} more`) : null,
      rank.ties.length ? banner('warn', 'Two routers match with the same priority', `${rank.ties.map((t) => t.router.name).join(', ')} tie with ${rank.winner.router.name}. Traefik does not guarantee which one answers: give one of them an explicit priority.`) : null);
  }

  evaluate(true);
  return {
    el,
    update(ev) {
      if (ev === 'state' || ev === 'diagnostics') { paintTry(); evaluate(false); }
    },
    destroy() { clearTimeout(timer); clearTimeout(saveTimer); },
  };
}

export default {
  render(ctx) { return rebuildable((rebuild) => render(ctx, rebuild)); },
};

