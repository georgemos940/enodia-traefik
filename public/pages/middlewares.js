// Middlewares: what happens to a request between the router and the service. Each kind gets its own
// explanation; the ones that rewrite or redirect come with a tester.
import { h, stagger } from '../lib/dom.js';
import { glyph } from '../lib/glyphs.js';
import { store, api, live, findingsFor } from '../lib/store.js';
import { card, stat, badge, statusBadge, providerBadge, tabs, segmented, searchInput, copyButton, empty, banner, hrefFor, pageHead } from '../lib/components.js';
import { split, plural, qualify } from '../lib/format.js';
import { middlewares, findMiddleware, mwUsage, routerChain, routerService, protoCounts, isInternal } from '../lib/model.js';
import { GROUPS, kindOf, summaryOf, renderKind, sanitize, headerGrade, tone, rawView } from '../lib/mwkinds.js';
import { tile, filterChip, fmtRps, errTone } from '../lib/gparts.js';
import { pct } from '../lib/format.js';

const PROTOS = [['http', 'HTTP'], ['tcp', 'TCP']];
const AUTH = new Set(['basicAuth', 'digestAuth', 'forwardAuth', 'ipAllowList', 'ipWhiteList']);

export default {
  render(ctx) {
    const [proto, name] = ctx.params;
    return name ? detail(ctx, proto, name) : list(ctx);
  },
};

/** Chains that list this middleware: [chain middleware]. */
function chainsWith(name, proto) {
  return middlewares(proto).filter((m) => m.chain && (m.chain.middlewares ?? []).some((x) => qualify(x, m.provider) === name));
}
const usageOf = (m, proto) => mwUsage(m.name, proto);
const isUnused = (m, proto) => !usageOf(m, proto).length && !(m.usedBy ?? []).length;

function cfgOf(m) {
  const k = kindOf(m);
  return m[k.key] ?? m[Object.keys(m).find((x) => x.toLowerCase() === k.key.toLowerCase())] ?? {};
}

// ── list ─────────────────────────────────────────────────────────────────────

function list(ctx) {
  ctx.setCrumbs([['Middlewares']]);
  const q = ctx.query;
  let proto = PROTOS.some(([p]) => p === q.get('proto')) ? q.get('proto') : 'http';
  let filter = q.get('q') ?? '';
  let kind = q.get('kind') ?? '';
  let unusedOnly = q.get('unused') === '1';
  let showInternal = false;
  let mode = 'group';

  const el = h('div', { class: 'col gap-lg' });
  const sub = h('span');
  const tiles = {
    count: stat({ label: 'Middlewares', icon: 'middleware', value: '—' }),
    used: stat({ label: 'In use', icon: 'link', value: '—' }),
    auth: stat({ label: 'Routers behind access control', icon: 'shield', value: '—' }),
    headers: stat({ label: 'Routers with security headers', icon: 'lock', value: '—' }),
  };
  const tabsHost = h('div', { class: 'gr-tabs-host' });
  const chips = h('div', { class: 'gr-fchips' });
  const meta = h('div', { class: 'tiny muted gr-meta' });
  const body = h('div', { class: 'gr-mw-body' });

  el.append(
    pageHead({ title: 'Middlewares', icon: 'middleware', sub }),
    stagger(h('div', { class: 'grid g4' }, ...Object.values(tiles))),
    card({ flush: true, cls: 'gr-list-card' },
      h('div', { class: 'gr-toolbar' }, tabsHost,
        h('div', { class: 'gr-toolbar-right row', style: { gap: '8px' } },
          segmented([['group', 'By kind'], ['az', 'A–Z']], mode, (v) => { mode = v; paint(); }),
          h('div', { class: 'grow' }, searchInput({ placeholder: 'Filter by name, kind or router…', value: filter, oninput: (v) => { filter = v; paint(); } })))),
      h('div', { class: 'gr-toolbar gr-toolbar-2' }, chips, meta),
      body));

  function paintTiles() {
    const all = PROTOS.flatMap(([p]) => middlewares(p).map((m) => ({ m, p })));
    const unused = all.filter(({ m, p }) => isUnused(m, p) && !isInternal(m));
    const kinds = new Set(all.map(({ m }) => kindOf(m).key));
    sub.textContent = `What happens to a request between the router and the service: ${plural(all.length, 'middleware')} of ${plural(kinds.size, 'kind')}.`;
    tiles.count.valueEl.textContent = String(all.length);
    foot(tiles.count, `${kinds.size} kinds`);
    tiles.used.valueEl.replaceChildren(String(all.length - unused.length), h('small', {}, `/ ${all.length}`));
    foot(tiles.used, unused.length ? h('a', { class: 'warn-text', href: '#/middlewares', onclick: (e) => { e.preventDefault(); unusedOnly = true; kind = ''; paint(); } }, `${unused.length} unused`) : h('span', { class: 'ok-text' }, 'every one is used'));
    const routers = (store.state?.http?.routers ?? []).filter((r) => r.provider !== 'internal');
    const kindsOf = (r) => routerChain(r, 'http').map((x) => findMiddleware(x.name, 'http')).filter(Boolean).map((m) => kindOf(m).key);
    const authed = routers.filter((r) => kindsOf(r).some((k) => AUTH.has(k)));
    const graded = routers.filter((r) => routerChain(r, 'http').some((x) => { const m = findMiddleware(x.name, 'http'); return m?.headers && headerGrade(m.headers); }));
    tiles.auth.valueEl.replaceChildren(String(authed.length), h('small', {}, `/ ${routers.length}`));
    foot(tiles.auth, 'basic, digest, forward auth or an IP list');
    tiles.headers.valueEl.replaceChildren(String(graded.length), h('small', {}, `/ ${routers.length}`));
    foot(tiles.headers, 'HSTS, framing, nosniff and friends');
  }
  const foot = (t, node) => { t.querySelector('.stat-foot')?.remove(); t.querySelector('.stat-value').after(h('div', { class: 'stat-foot' }, node)); };

  function paintTabs() {
    const c = protoCounts('middlewares');
    tabsHost.replaceChildren(tabs(PROTOS.map(([p, l]) => [p, l, c[p]]), proto, (v) => { proto = v; kind = ''; paint(); }));
  }

  function mwCard(m) {
    const k = kindOf(m);
    const use = usageOf(m, proto);
    const chains = chainsWith(m.name, proto);
    const unused = isUnused(m, proto);
    const { base, provider } = split(m.name);
    const routers = [...new Map(use.map((u) => [u.router.name, u])).values()];
    const bad = m.status && m.status !== 'enabled';
    return h('a', { class: `card gr-mw gr-tone ${unused ? 'unused' : ''} ${bad ? 'bad' : ''}`.trim(), style: tone(k.hue), href: hrefFor('middlewares', m.name, proto) },
      h('div', { class: 'gr-mw-top' },
        tile(k.glyph, k.hue, { size: 36, icon: 18 }),
        h('div', { class: 'grow col', style: { gap: '1px', minWidth: '0' } },
          h('div', { class: 'cell-title' }, h('span', { class: 'ellipsis', title: m.name }, base), provider ? h('span', { class: 'faint tiny' }, `@${provider}`) : null),
          h('span', { class: 'gr-mw-kind' }, k.label)),
        bad ? statusBadge(m.status) : unused ? h('span', { class: 'badge warn' }, 'unused') : null),
      h('div', { class: 'gr-mw-sum' }, summaryOf(m)),
      h('div', { class: 'gr-mw-use' },
        routers.length ? [
          ...routers.slice(0, 3).map((u) => h('span', { class: 'gr-mw-router', title: `${u.router.name}: position ${u.index} of ${u.total}${u.via ? ` (via ${u.via})` : ''}` },
            glyph('router', { size: 11 }), h('span', { class: 'ellipsis' }, split(u.router.name).base), h('b', {}, `${u.index}/${u.total}`))),
          routers.length > 3 ? h('span', { class: 'tiny muted' }, `+${routers.length - 3}`) : null,
        ] : chains.length ? h('span', { class: 'tiny muted' }, `only inside ${chains.map((c) => split(c.name).base).join(', ')}`) : h('span', { class: 'tiny faint' }, 'no router uses it')));
  }

  function paint() {
    const listAll = middlewares(proto);
    const internalN = listAll.filter(isInternal).length;
    const unusedN = listAll.filter((m) => isUnused(m, proto) && !isInternal(m)).length;
    const counts = new Map();
    for (const m of listAll) { if (!showInternal && isInternal(m)) continue; const k = kindOf(m).key; counts.set(k, (counts.get(k) ?? 0) + 1); }
    chips.replaceChildren(
      filterChip({ label: 'All', count: listAll.length - (showInternal ? 0 : internalN), on: !kind && !unusedOnly, onclick: () => { kind = ''; unusedOnly = false; paint(); } }),
      ...[...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, n]) => {
        const k = kindOf(key);
        return filterChip({ label: k.label, glyph: k.glyph, hue: k.hue, count: n, on: kind === key, onclick: () => { kind = kind === key ? '' : key; paint(); } });
      }),
      unusedN ? filterChip({ label: 'Unused', glyph: 'ghost', hue: 40, count: unusedN, on: unusedOnly, onclick: () => { unusedOnly = !unusedOnly; paint(); } }) : null,
      internalN ? filterChip({ label: 'Internal', glyph: showInternal ? 'eye' : 'eyeOff', count: internalN, on: showInternal, onclick: () => { showInternal = !showInternal; paint(); } }) : null);

    const f = filter.trim().toLowerCase();
    const shown = listAll.filter((m) => {
      if (!showInternal && isInternal(m)) return false;
      const k = kindOf(m);
      if (kind && k.key !== kind) return false;
      if (unusedOnly && !isUnused(m, proto)) return false;
      if (f && ![m.name, k.label, k.key, summaryOf(m), ...usageOf(m, proto).map((u) => u.router.name)].some((v) => String(v).toLowerCase().includes(f))) return false;
      return true;
    });
    meta.textContent = `Showing ${shown.length} of ${listAll.length}${!showInternal && internalN ? ` · ${internalN} internal hidden` : ''}`;

    if (!listAll.length) body.replaceChildren(empty(`No ${proto.toUpperCase()} middlewares`, proto === 'tcp' ? 'TCP routers can use inFlightConn and ipAllowList.' : 'Add rateLimit, headers, basicAuth and more to a router\'s middlewares.', 'middleware'));
    else if (!shown.length) body.replaceChildren(empty('No middleware matches', 'Try another filter.', 'search'));
    else if (mode === 'az') body.replaceChildren(stagger(h('div', { class: 'gr-mw-grid' }, ...shown.sort((a, b) => split(a.name).base.localeCompare(split(b.name).base)).map(mwCard))));
    else {
      const groups = Object.entries(GROUPS).map(([g, info]) => [g, info, shown.filter((m) => kindOf(m).group === g)]).filter(([, , ms]) => ms.length);
      body.replaceChildren(...groups.map(([, info, ms]) => h('section', { class: 'gr-mw-group' },
        h('div', { class: 'gr-mw-group-head' }, glyph(info.glyph, { size: 15 }), h('span', {}, info.label), h('span', { class: 'gr-fchip-n' }, String(ms.length))),
        stagger(h('div', { class: 'gr-mw-grid' }, ...ms.sort((a, b) => kindOf(a).label.localeCompare(kindOf(b).label) || a.name.localeCompare(b.name)).map(mwCard))))));
    }
    paintTabs();
    paintTiles();
  }

  paint();
  return {
    el,
    update(event) { if (event === 'state' || event === 'diagnostics') paint(); },
  };
}

// ── detail ───────────────────────────────────────────────────────────────────

function detail(ctx, proto, name) {
  const { base } = split(name);
  ctx.setCrumbs([['Middlewares', `#/middlewares${proto !== 'http' ? `?proto=${proto}` : ''}`], [base]]);
  const el = h('div', { class: 'col gap-lg' });
  let m = findMiddleware(name, proto);
  if (!m) {
    const refs = (store.state?.[proto]?.routers ?? []).filter((r) => routerChain(r, proto).some((x) => x.name === name));
    el.append(empty(`No ${proto.toUpperCase()} middleware named ${name}`, refs.length ? `${plural(refs.length, 'router')} still ${refs.length === 1 ? 'asks' : 'ask'} for it, so ${refs.length === 1 ? 'it is' : 'they are'} not serving.` : 'It may have been removed.', 'middleware'),
      refs.length ? h('div', { class: 'row wrap', style: { justifyContent: 'center' } }, ...refs.map((r) => h('a', { class: 'chip gr-chip-link', href: hrefFor('routers', r.name, proto) }, glyph('router', { size: 12 }), split(r.name).base))) : null,
      h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '12px' } }, h('a', { class: 'btn', href: '#/middlewares' }, 'All middlewares')));
    return { el, update(ev) { if (ev === 'state' && findMiddleware(name, proto)) window.dispatchEvent(new HashChangeEvent('hashchange')); } };
  }
  m = { ...m, proto };

  const heroBox = h('div');
  const cfgBox = h('div', { class: 'col gap-lg' });
  const useBox = h('div', { class: 'col', style: { gap: '10px' } });
  const findBox = h('div', { class: 'col', style: { gap: '8px' } });
  const sibBox = h('div', { class: 'col', style: { gap: '6px' } });
  const rawBox = h('div');
  let lastSig = '';

  function paintHero() {
    const k = kindOf(m);
    const unused = isUnused(m, proto);
    heroBox.replaceChildren(h('section', { class: `card gr-hero gr-tone ${m.status === 'disabled' ? 'bad' : ''}`.trim(), style: tone(k.hue) },
      tile(k.glyph, k.hue, { size: 58, icon: 28, cls: 'gr-hero-tile' }),
      h('div', { class: 'grow col', style: { gap: '6px', minWidth: '0' } },
        h('div', { class: 'row wrap', style: { gap: '10px' } }, h('h1', { class: 'gr-hero-title' }, base), statusBadge(m.status), unused ? h('span', { class: 'badge warn' }, 'unused') : null),
        h('div', { class: 'gr-hero-sum' }, summaryOf(m)),
        h('div', { class: 'muted small' }, k.desc),
        h('div', { class: 'row wrap', style: { gap: '6px', marginTop: '4px' } },
          h('span', { class: 'badge gr-kind-badge' }, glyph(k.glyph, { size: 12 }), k.label), providerBadge(name), h('span', { class: 'badge' }, proto.toUpperCase()),
          h('span', { class: 'badge' }, glyph('router', { size: 12 }), plural(new Set(usageOf(m, proto).map((u) => u.router.name)).size, 'router')))),
      h('div', { class: 'gr-hero-actions' },
        h('a', { class: 'btn sm', href: `#/topology?proto=${proto}&mw=1&q=${encodeURIComponent(name)}` }, glyph('topology', { size: 14 }), 'Topology'),
        copyButton(name, 'Copy name'))));
  }

  function paintConfig() {
    const k = kindOf(m);
    let nodes;
    try { nodes = renderKind(m); } catch (e) { console.error(e); nodes = [rawView(cfgOf(m))]; }
    cfgBox.replaceChildren(
      m.error?.length ? banner('bad', 'Traefik reports an error', m.error.join('; ')) : null,
      card({ title: k.label, icon: 'config', sub: 'What it does to a request', cls: 'gr-tone gr-cfg-card' }, h('div', { class: 'col gap-lg gr-tone', style: tone(k.hue) }, ...nodes)));
  }

  function paintUsage() {
    const use = usageOf(m, proto);
    const chains = chainsWith(name, proto);
    if (!use.length) {
      useBox.replaceChildren(h('div', { class: 'gr-unused' }, glyph('ghost', { size: 26 }),
        h('div', { class: 'col', style: { gap: '2px' } }, h('b', {}, 'No router uses it'),
          h('span', { class: 'small muted' }, chains.length ? `It is listed in ${chains.map((c) => split(c.name).base).join(', ')}, but no router uses ${chains.length === 1 ? 'that chain' : 'those chains'}.` : 'It is loaded and ready, but does nothing until a router lists it in its middlewares.'))));
      return;
    }
    useBox.replaceChildren(...use.map((u) => {
      const r = u.router;
      const l = proto === 'http' ? live('router', r.name) : null;
      const svc = routerService(r);
      return h('div', { class: `gr-use ${r.status !== 'enabled' ? 'bad' : ''}`.trim() },
        h('div', { class: 'row wrap', style: { gap: '8px' } },
          h('a', { class: 'bold gr-link', href: hrefFor('routers', r.name, proto) }, split(r.name).base),
          r.status !== 'enabled' ? statusBadge(r.status) : null,
          ...(r.entryPoints ?? []).map((ep) => h('span', { class: 'badge mono' }, ep)),
          h('span', { class: 'grow' }),
          h('span', { class: 'badge torch' }, `${u.index} of ${u.total}`),
          l ? h('span', { class: `tiny tnum ${errTone(l.errorRate) ? `${errTone(l.errorRate)}-text` : 'muted'}` }, `${fmtRps(l.rps)}${l.rps ? ` · ${pct(l.errorRate)} 5xx` : ''}`) : null),
        h('div', { class: 'gr-pipe' },
          h('span', { class: 'gr-pipe-end' }, glyph('entrypoint', { size: 13 }), 'request'),
          ...u.chain.flatMap((n) => {
            const mm = findMiddleware(n, proto);
            const kk = mm ? kindOf(mm) : null;
            const here = n === name || n === u.via;
            return [h('span', { class: 'gr-pipe-arrow' }, glyph('chevron', { size: 13 })),
              mm ? h('a', { class: `gr-pipe-step gr-tone ${here ? 'here' : ''}`.trim(), style: tone(kk.hue), href: hrefFor('middlewares', n, proto), title: `${kk.label}: ${summaryOf(mm)}` },
                glyph(kk.glyph, { size: 13 }), h('span', { class: 'ellipsis' }, split(n).base), n === u.via ? h('span', { class: 'tiny muted' }, `contains ${base}`) : null)
                : h('span', { class: 'gr-pipe-step missing' }, glyph('ghost', { size: 13 }), split(n).base, badge('missing', 'bad'))];
          }),
          h('span', { class: 'gr-pipe-arrow' }, glyph('chevron', { size: 13 })),
          svc ? h('a', { class: 'gr-pipe-end gr-pipe-svc', href: hrefFor('services', svc, proto) }, glyph('service', { size: 13 }), split(svc).base) : h('span', { class: 'gr-pipe-end' }, 'service')));
    }));
  }

  function paintFindings() {
    const f = findingsFor('middleware', name);
    findBox.replaceChildren(...(f.length ? f.map((x) => h('a', { href: `#/health?q=${encodeURIComponent(name)}`, class: `gr-finding ${x.severity}` },
      glyph(x.severity === 'critical' ? 'xcircle' : x.severity === 'warning' ? 'alert' : 'info', { size: 16 }),
      h('div', { class: 'grow col', style: { gap: '2px', minWidth: '0' } }, h('b', { class: 'small' }, x.title), h('span', { class: 'tiny muted' }, x.detail))))
      : [h('div', { class: 'row muted small' }, glyph('ok', { size: 16, cls: 'ok-text' }), 'Nothing to fix here.')]));
  }

  function paintSiblings() {
    const k = kindOf(m);
    const sibs = middlewares(proto).filter((x) => x.name !== name && kindOf(x).key === k.key);
    sibBox.replaceChildren(...(sibs.length ? sibs.slice(0, 8).map((x) => h('a', { class: 'gr-rrow', href: hrefFor('middlewares', x.name, proto) },
      tile(k.glyph, k.hue, { size: 26, icon: 13 }),
      h('div', { class: 'grow col', style: { gap: '0', minWidth: '0' } }, h('b', { class: 'small ellipsis' }, split(x.name).base), h('span', { class: 'tiny muted ellipsis' }, summaryOf(x))),
      isUnused(x, proto) ? h('span', { class: 'badge warn' }, 'unused') : null))
      : [h('div', { class: 'muted small' }, `No other middleware of this kind.`)]));
  }

  const paintRaw = () => rawBox.replaceChildren(rawView(Object.fromEntries(Object.entries(m).filter(([key]) => key !== 'proto'))));

  function paintAll() {
    const sig = JSON.stringify(m);
    if (sig === lastSig) return;
    lastSig = sig;
    paintHero(); paintConfig(); paintUsage(); paintSiblings(); paintRaw();
  }

  const k0 = kindOf(m);
  el.append(
    heroBox,
    stagger(h('div', { class: 'grid g3' },
      h('div', { class: 'span2 col gap-lg' }, cfgBox),
      h('div', { class: 'col gap-lg' },
        card({ title: 'Used by', icon: 'router', sub: 'Where it runs in each router\'s chain' }, useBox),
        card({ title: 'Findings', icon: 'health' }, findBox),
        card({ title: `Other ${k0.label} middlewares`, icon: 'layers' }, sibBox)))),
    card({ title: 'Raw configuration', icon: 'code', cls: 'gr-raw', sub: 'As Traefik reports it, secrets masked', tools: [copyButton(() => JSON.stringify(sanitize(m), null, 2), 'Copy JSON'),
      h('a', { class: 'btn sm ghost', href: `#/explorer?path=${encodeURIComponent(`/api/${proto}/middlewares/${name}`)}` }, glyph('code', { size: 13 }), 'API explorer'),
      h('button', { class: 'btn sm ghost', onclick: async (e) => {
        const btn = e.currentTarget; btn.disabled = true;
        try { const raw = await api(`raw?path=${encodeURIComponent(`/api/${proto}/middlewares/${name}`)}`); rawBox.replaceChildren(rawView(raw)); } catch (x) { rawBox.prepend(banner('bad', 'Could not ask Traefik', x.message)); }
        btn.disabled = false;
      } }, glyph('refresh', { size: 13 }), 'Fetch from Traefik')] }, rawBox),
  );

  paintAll(); paintFindings();
  return {
    el,
    update(event) {
      if (event === 'state') { const next = findMiddleware(name, proto); if (next) { m = { ...next, proto }; paintAll(); } }
      else if (event === 'diagnostics') paintFindings();
      else if (event === 'metrics') paintUsage();
    },
  };
}

