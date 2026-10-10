// The shell: login, sidebar, top bar, routing, the command palette and keyboard shortcuts.
import { h, icon, brandMark, $ } from './lib/dom.js';
import { store, connect, api, all } from './lib/store.js';
import { rate, split } from './lib/format.js';
import { hrefFor, navigate, modal, toast, copyButton, badge } from './lib/components.js';
import { markdown } from './lib/markdown.js';
import { PAGES } from './pages/index.js';

const root = $('#root');

// ── theme ────────────────────────────────────────────────────────────────────

const THEME_KEY = 'enodia-theme';
const storedTheme = () => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } };
let theme = storedTheme() || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
const applyTheme = () => { document.documentElement.dataset.theme = theme; document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f5fa' : '#07080d'); };
applyTheme();
function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private window */ }
  applyTheme();
  store.emit('theme', theme);
}

// ── login ────────────────────────────────────────────────────────────────────

function showLogin(meta) {
  let err;
  const input = h('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'current-password', style: { width: '100%' } });
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api('login', { method: 'POST', body: { password: input.value } });
      boot();
    } catch (x) {
      err.textContent = x.message;
      input.select();
    }
  };
  root.replaceChildren(h('div', { class: 'login' },
    h('form', { class: 'card login-card page-enter', onsubmit: submit },
      brandMark(),
      h('h1', { style: { margin: '6px 0 2px', fontSize: '22px' } }, 'Enodia'),
      h('p', { class: 'muted', style: { marginTop: 0 } }, meta?.instanceName ? `Traefik · ${meta.instanceName}` : 'A dashboard for Traefik'),
      h('div', { class: 'col', style: { marginTop: '18px' } }, input, h('button', { class: 'btn primary', type: 'submit' }, icon('lock', { size: 15 }), 'Log in'),
        err = h('div', { class: 'bad-text small' })))));
  setTimeout(() => input.focus(), 50);
}

// ── layout ───────────────────────────────────────────────────────────────────

let nav;
let crumbsEl;
let livePill;
let pageEl;
let current = null;    // { page, view, path }
let appEl;

function counts() {
  const st = store.state;
  if (!st) return {};
  const f = store.findings;
  const bad = (kind) => f.filter((x) => x.severity === 'critical' && x.resource?.kind?.endsWith(kind)).length;
  const crit = f.filter((x) => x.severity === 'critical').length;
  const warn = f.filter((x) => x.severity === 'warning').length;
  return {
    routers: [all('routers').length, bad('router') ? 'bad' : ''],
    services: [all('services').length, bad('service') ? 'bad' : ''],
    middlewares: [all('middlewares').length, bad('middleware') ? 'bad' : ''],
    entrypoints: [st.entrypoints?.length ?? 0, ''],
    certificates: store.metrics?.certs?.warn ? [store.metrics.certs.warn, store.metrics.certs.critical ? 'bad' : 'warn'] : [store.metrics?.certs?.total || undefined, ''],
    health: crit ? [crit, 'bad'] : warn ? [warn, 'warn'] : [0, ''],
    changes: [store.history.length || undefined, ''],
    shield: store.shield?.level === 'attack' ? ['!', 'bad'] : store.shield?.level === 'elevated' ? ['!', 'warn'] : [undefined, ''],
  };
}

function renderNav() {
  if (!nav) return;
  const c = counts();
  const active = current?.page.id;
  const groups = [];
  for (const p of PAGES) {
    let g = groups.find((x) => x.name === p.group);
    if (!g) groups.push(g = { name: p.group, pages: [] });
    g.pages.push(p);
  }
  nav.replaceChildren(...groups.flatMap((g) => [
    g.name ? h('div', { class: 'nav-group' }, g.name) : null,
    ...g.pages.map((p) => {
      const [n, tone] = c[p.id] ?? [];
      return h('a', { href: `#/${p.id === 'overview' ? '' : p.id}`, class: p.id === active ? 'active' : '', onclick: () => appEl.classList.remove('nav-open') },
        icon(p.icon, { size: 17 }), p.title,
        n !== undefined && n !== 0 ? h('span', { class: `count ${tone}`.trim() }, String(n)) : null);
    }),
  ]));
}

function renderLive() {
  if (!livePill) return;
  const total = store.metrics?.latest?.total;
  const ok = store.connected && store.state?.ok;
  const attack = ok && store.shield?.level === 'attack';
  livePill.classList.toggle('under-attack', attack);
  livePill.onclick = attack ? () => navigate('#/shield') : null;
  if (attack) {
    livePill.replaceChildren(h('span', { class: 'dot bad pulse' }), h('span', { class: 'label' }, 'Under attack'), h('span', { class: 'muted' }, `· ${rate(store.shield.total)} req/s`));
    livePill.title = 'Open Shield';
    return;
  }
  livePill.replaceChildren(
    h('span', { class: `dot ${ok ? 'ok pulse' : store.connected ? 'bad pulse' : 'warn'}` }),
    h('span', { class: 'label' }, !store.connected ? 'Reconnecting…' : !store.state?.ok ? 'Traefik unreachable' : 'Live'),
    total ? h('span', { class: 'muted' }, `· ${rate(total.rps)} req/s`) : null);
  livePill.title = store.state?.error ?? (store.state?.fetchedAt ? `Last poll ${new Date(store.state.fetchedAt).toLocaleTimeString()}` : '');
}

function setCrumbs(list) {
  crumbsEl.replaceChildren(...list.flatMap(([label, href], i) => [
    i ? h('span', { class: 'sep' }, '/') : null,
    href && i < list.length - 1 ? h('a', { href }, label) : h('span', { class: 'here' }, label),
  ]));
  document.title = `${list[list.length - 1]?.[0] ?? 'Enodia'} · Enodia${store.meta?.instanceName ? ` · ${store.meta.instanceName}` : ''}`;
}

function layout() {
  nav = h('nav', { class: 'nav' });
  crumbsEl = h('div', { class: 'crumbs' });
  livePill = h('div', { class: 'live' });
  pageEl = h('main', { class: 'page' });
  const meta = store.meta ?? {};
  appEl = h('div', { class: 'app' },
    h('aside', { class: 'side' },
      h('a', { class: 'brand', href: '#/' }, brandMark(), h('div', { class: 'brand-name' }, 'Enodia', h('small', {}, meta.instanceName || 'for Traefik'))),
      nav,
      h('div', { class: 'side-foot' },
        h('span', { class: 'grow tiny' }, `v${meta.version ?? ''}`, store.state?.version ? ` · Traefik ${store.state.version.Version}` : ''),
        h('a', { class: 'btn sm ghost icon-only', href: 'https://github.com/georgemos940/enodia-traefik', target: '_blank', rel: 'noreferrer', title: 'Enodia on GitHub' }, icon('github', { size: 15 })),
        meta.auth === 'password' ? h('button', { class: 'btn sm ghost icon-only', title: 'Log out', onclick: async () => { await api('logout', { method: 'POST' }).catch(() => {}); location.reload(); } }, icon('logout', { size: 15 })) : null)),
    h('div', { class: 'main' },
      h('header', { class: 'topbar' },
        h('button', { class: 'btn ghost icon-only menu-btn', onclick: () => appEl.classList.toggle('nav-open'), 'aria-label': 'Menu' }, icon('menu')),
        crumbsEl,
        h('div', { class: 'spacer' }),
        updatePill = h('span', { class: 'update-slot' }),
        livePill,
        h('button', { class: 'search-btn', onclick: openPalette, 'aria-label': 'Search' }, icon('search', { size: 15 }), h('span', { class: 'label' }, 'Search routers, services…'), h('span', { class: 'kbd' }, 'Ctrl K')),
        h('button', { class: 'btn ghost icon-only', onclick: toggleTheme, title: 'Theme', 'aria-label': 'Theme' }, icon(theme === 'dark' ? 'sun' : 'moon'))),
      pageEl));
  root.replaceChildren(appEl);
  renderUpdate();
}

// ── updates ──────────────────────────────────────────────────────────────────

let updatePill;
const REPO = 'georgemos940/enodia-traefik';
const INSTALL_SH = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;

/** The update command for how this copy was installed. */
function updateSteps(method) {
  const steps = {
    script: [['Update with the installer (keeps your settings)', `curl -fsSL ${INSTALL_SH} | bash -s -- update`]],
    docker: [
      ['Docker Compose: pull the new image and recreate', 'docker compose pull enodia && docker compose up -d enodia'],
      ['Plain docker run: pull, then start it again with the same options', 'docker pull ghcr.io/georgemos940/enodia:latest'],
    ],
    source: [['From a git checkout: fetch the new version and restart', 'git pull --ff-only && npm start']],
    kubernetes: [['Kubernetes: restart the deployment, which pulls the new image', 'kubectl -n traefik rollout restart deployment/enodia']],
  };
  return steps[method] ?? [...steps.script, ...steps.docker];
}

const dismissedKey = (v) => `enodia-update-dismissed-${v}`;
const isDismissed = (v) => { try { return localStorage.getItem(dismissedKey(v)) === '1'; } catch { return false; } };

function renderUpdate() {
  if (!updatePill) return;
  const u = store.meta?.updates;
  const mine = u?.enodia?.newer ? u.enodia : null;
  const theirs = u?.traefik?.newer ? u.traefik : null;
  if (!mine && !theirs) { updatePill.replaceChildren(); return; }
  if (mine && isDismissed(mine.latest) && !theirs) { updatePill.replaceChildren(); return; }
  updatePill.replaceChildren(h('button', {
    class: `update-pill ${mine && !isDismissed(mine.latest) ? 'hot' : ''}`.trim(),
    title: mine ? `Enodia ${mine.latest} is out` : `Traefik ${theirs.latest} is out`,
    onclick: openUpdate,
  }, icon('download', { size: 14 }), h('span', { class: 'label' }, mine ? `Enodia ${mine.latest}` : `Traefik ${theirs.latest}`)));
}

function openUpdate() {
  const u = store.meta?.updates ?? {};
  const mine = u.enodia?.newer ? u.enodia : null;
  const theirs = u.traefik?.newer ? u.traefik : null;
  const method = store.meta?.install ?? 'unknown';
  const cmd = (label, text) => h('div', { class: 'col', style: { gap: '6px' } },
    h('div', { class: 'small muted' }, label),
    h('div', { class: 'row', style: { gap: '6px' } }, h('pre', { class: 'json grow', style: { margin: '0', padding: '10px 12px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, text), copyButton(text, 'Copy the command')));
  const { close } = modal(h('div', { style: { padding: '20px 22px', maxHeight: '78vh', overflow: 'auto' } },
    h('div', { class: 'row', style: { marginBottom: '6px' } }, icon('download', { size: 20, cls: 'torch-text' }), h('h3', { style: { margin: '0' }, class: 'grow' }, mine ? `Enodia ${mine.latest} is available` : `Traefik ${theirs.latest} is available`),
      h('button', { class: 'btn sm ghost icon-only', onclick: () => close() }, icon('x'))),
    mine ? h('div', { class: 'col', style: { gap: '14px' } },
      h('div', { class: 'row wrap' }, badge(`you run ${mine.current}`), badge(`latest ${mine.latest}`, 'torch'), mine.publishedAt ? h('span', { class: 'tiny muted' }, `released ${new Date(mine.publishedAt).toLocaleDateString()}`) : null,
        mine.url ? h('a', { class: 'btn sm ghost', href: mine.url, target: '_blank', rel: 'noreferrer' }, 'Release page', icon('external', { size: 13 })) : null),
      mine.notes ? h('div', { class: 'card', style: { padding: '4px 16px' } }, markdown(mine.notes)) : null,
      h('div', { class: 'bold' }, 'How to update'),
      ...updateSteps(method).map(([label, text]) => cmd(label, text)),
      h('div', { class: 'tiny muted' }, 'Settings, history and your password stay as they are: they live in the environment and the data volume, not in the image. Want updates on their own? Run Watchtower, or a scheduled `install.sh update`.'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }), h('button', { class: 'btn sm ghost', onclick: () => { try { localStorage.setItem(dismissedKey(mine.latest), '1'); } catch { /* private window */ } renderUpdate(); close(); } }, 'Remind me at the next version'))) : null,
    theirs ? h('div', { class: 'col', style: { gap: '10px', marginTop: mine ? '22px' : '0' } },
      h('div', { class: 'bold' }, `Traefik ${theirs.latest} is out`),
      h('div', { class: 'small muted' }, `This Traefik runs ${theirs.current}. Read the release notes first, then raise the image tag (for example traefik:v${theirs.latest}) and recreate the container.`),
      theirs.url ? h('a', { class: 'btn sm', href: theirs.url, target: '_blank', rel: 'noreferrer' }, 'Traefik release notes', icon('external', { size: 13 })) : null) : null));
}

// ── routing ──────────────────────────────────────────────────────────────────

async function route() {
  // only the path is decoded here; the query stays raw so values may contain & and =
  const raw = location.hash.replace(/^#\/?/, '');
  const at = raw.indexOf('?');
  const path = decodeURIComponent(at < 0 ? raw : raw.slice(0, at));
  const qs = at < 0 ? undefined : raw.slice(at + 1);
  const page = PAGES.find((p) => (p.route ?? new RegExp(`^${p.id}$`)).test(path)) ?? PAGES[0];
  const params = (page.route ?? new RegExp(`^${page.id}$`)).exec(path)?.slice(1) ?? [];
  const key = `${page.id}|${path}|${qs ?? ''}`;
  if (current?.key === key) return;
  current?.view?.destroy?.();
  current = { page, key, view: null };
  renderNav();
  setCrumbs([[page.title]]);
  let mod;
  try {
    mod = (await page.load()).default;
  } catch (e) {
    pageEl.replaceChildren(h('div', { class: 'empty' }, icon('alert', { size: 28 }), h('div', { class: 'empty-title' }, 'This page failed to load'), h('div', { class: 'small' }, e.message)));
    return;
  }
  if (current.key !== key) return; // navigated away while loading
  const ctx = { params, query: new URLSearchParams(qs ?? ''), setCrumbs, page };
  try {
    const view = mod.render(ctx);
    current.view = view;
    const wrapper = h('div', { class: 'page-enter' }, view.el);
    pageEl.replaceChildren(wrapper);
    window.scrollTo({ top: 0 });
  } catch (e) {
    console.error(e);
    pageEl.replaceChildren(h('div', { class: 'empty' }, icon('alert', { size: 28 }), h('div', { class: 'empty-title' }, 'This page hit an error'), h('div', { class: 'small mono' }, e.message)));
  }
}

// ── command palette ──────────────────────────────────────────────────────────

function paletteItems() {
  const items = PAGES.map((p) => ({ group: 'Pages', label: p.title, icon: p.icon, hint: 'page', go: `#/${p.id === 'overview' ? '' : p.id}` }));
  for (const r of all('routers')) items.push({ group: 'Routers', label: r.name, icon: 'router', hint: `${r.proto} router`, go: hrefFor('routers', r.name, r.proto), extra: r.rule ?? '' });
  for (const s of all('services')) items.push({ group: 'Services', label: s.name, icon: 'service', hint: `${s.proto} ${s.type ?? 'service'}`, go: hrefFor('services', s.name, s.proto) });
  for (const m of all('middlewares')) items.push({ group: 'Middlewares', label: m.name, icon: 'middleware', hint: m.type ?? 'middleware', go: hrefFor('middlewares', m.name, m.proto) });
  for (const e of store.state?.entrypoints ?? []) items.push({ group: 'Entry points', label: e.name, icon: 'entrypoint', hint: e.address, go: hrefFor('entrypoints', e.name) });
  items.push({ group: 'Actions', label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`, icon: theme === 'dark' ? 'sun' : 'moon', hint: 'action', run: toggleTheme });
  items.push({ group: 'Actions', label: 'Test which router answers a URL', icon: 'tester', hint: 'action', go: '#/tester' });
  return items;
}

function score(item, q) {
  if (!q) return 1;
  const hay = `${item.label} ${item.extra ?? ''} ${item.hint ?? ''}`.toLowerCase();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let total = 0;
  for (const w of words) {
    const i = hay.indexOf(w);
    if (i < 0) {
      // letters in order, for "shpweb" -> "shop-web"
      let j = 0;
      for (const ch of hay) if (ch === w[j]) j++;
      if (j < w.length) return 0;
      total += 1;
    } else total += i === 0 || /[\s@./-]/.test(hay[i - 1]) ? 10 : 5;
  }
  return total + (item.group === 'Pages' ? 2 : 0);
}

let paletteOpen = false;
function openPalette() {
  if (paletteOpen) return;
  paletteOpen = true;
  const items = paletteItems();
  let sel = 0;
  let shown = [];
  const list = h('div', { class: 'palette-list' });
  const input = h('input', { class: 'palette-input', placeholder: 'Search pages, routers, services, middlewares, entry points…', autocomplete: 'off', spellcheck: false });
  const { close } = modal(h('div', {},
    h('div', { style: { position: 'relative' } }, h('span', { style: { position: 'absolute', left: '17px', top: '18px' }, class: 'muted' }, icon('search', { size: 18 })), input),
    list,
    h('div', { class: 'palette-foot' }, h('span', {}, h('span', { class: 'kbd' }, '↑↓'), ' move'), h('span', {}, h('span', { class: 'kbd' }, 'Enter'), ' open'), h('span', {}, h('span', { class: 'kbd' }, 'Esc'), ' close'))),
  { onclose: () => { paletteOpen = false; } });

  const run = (item) => { close(); if (item.run) item.run(); else navigate(item.go); };
  const paint = () => {
    const q = input.value.trim();
    shown = items.map((it) => [it, score(it, q)]).filter(([, sc]) => sc > 0).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([it]) => it);
    if (sel >= shown.length) sel = Math.max(0, shown.length - 1);
    let lastGroup = null;
    list.replaceChildren(...shown.flatMap((it, i) => {
      const g = it.group !== lastGroup ? h('div', { class: 'palette-group' }, it.group) : null;
      lastGroup = it.group;
      const { base, provider } = split(it.label);
      return [g, h('div', { class: `palette-item ${i === sel ? 'on' : ''}`, onmouseenter: () => { sel = i; mark(); }, onclick: () => run(it) },
        icon(it.icon, { size: 16, cls: 'muted' }),
        h('span', { class: 'ellipsis' }, it.group === 'Pages' || it.group === 'Actions' ? it.label : base, provider && it.group !== 'Pages' ? h('span', { class: 'faint tiny' }, `@${provider}`) : null),
        h('span', { class: 'hint' }, it.hint ?? ''))];
    }));
    if (!shown.length) list.replaceChildren(h('div', { class: 'empty' }, 'Nothing matches'));
  };
  const mark = () => {
    list.querySelectorAll('.palette-item').forEach((el, i) => el.classList.toggle('on', i === sel));
    list.querySelectorAll('.palette-item')[sel]?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { sel = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
    else if (e.key === 'Enter' && shown[sel]) { e.preventDefault(); run(shown[sel]); }
  });
  paint();
  setTimeout(() => input.focus(), 30);
}

// ── keys ─────────────────────────────────────────────────────────────────────

const GO = { o: '', r: 'routers', s: 'services', m: 'middlewares', e: 'entrypoints', t: 'traffic', d: 'shield', l: 'logs', c: 'certificates', h: 'health', x: 'changes', p: 'topology' };
let pendingG = 0;
document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') { const f = pageEl?.querySelector('input[type="search"]'); if (f) { e.preventDefault(); f.focus(); } return; }
  if (e.key === 'g') { pendingG = Date.now(); return; }
  if (Date.now() - pendingG < 1200 && GO[e.key] !== undefined) { pendingG = 0; navigate(`#/${GO[e.key]}`); return; }
  if (e.key === '?') {
    modal(h('div', { style: { padding: '20px' } }, h('h3', { style: { marginTop: 0 } }, 'Keyboard shortcuts'),
      h('div', { class: 'kv' }, ...[['Ctrl K', 'Search everything'], ['/', 'Filter the current list'], ...Object.entries(GO).map(([k, p]) => [`g ${k}`, `Go to ${p || 'overview'}`]), ['?', 'This help']]
        .flatMap(([k, v]) => [h('dt', {}, h('span', { class: 'kbd' }, k)), h('dd', {}, v)]))));
  }
});

// ── boot ─────────────────────────────────────────────────────────────────────

let wired = false;
async function boot() {
  let session;
  try { session = await api('session'); } catch { session = { mode: 'none', user: 'anyone' }; }
  store.meta = session.meta;
  if (session.mode !== 'none' && !session.user) return showLogin(session.meta);
  root.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'col', style: { alignItems: 'center' } }, brandMark('brand-mark spin-slow'), h('div', { class: 'muted small' }, 'Reaching Traefik…'))));
  if (!wired) {
    wired = true;
    store.on('ready', () => { if (!appEl || !document.body.contains(appEl)) { layout(); route(); } renderNav(); renderLive(); });
    store.on('state', () => { renderNav(); renderLive(); current?.view?.update?.('state', store.state); });
    let certKey = '';
    store.on('metrics', (d) => {
      renderLive();
      const k = JSON.stringify(d?.certs ?? null);
      if (k !== certKey) { certKey = k; renderNav(); }
      current?.view?.update?.('metrics', d);
    });
    store.on('diagnostics', (d) => { renderNav(); current?.view?.update?.('diagnostics', d); });
    store.on('logs', (d) => current?.view?.update?.('logs', d));
    let shieldLevel = 'calm';
    store.on('shield', (d) => {
      if (d.level !== shieldLevel) { shieldLevel = d.level; renderNav(); renderLive(); }
      current?.view?.update?.('shield', d);
    });
    store.on('history', (d) => { renderNav(); current?.view?.update?.('history', d); });
    // charts read colors when drawn, so the page is rebuilt in the new theme
    store.on('theme', () => { if (appEl) { const k = current?.key; current?.view?.destroy?.(); current = null; layout(); if (k) route(); } });
    store.on('connection', (up) => { renderLive(); if (!up) toast('Connection to Enodia lost, reconnecting…', 'warn'); });
    store.on('unauthorized', () => showLogin(store.meta));
    store.on('update', (u) => {
      renderUpdate();
      current?.view?.update?.('update', u);
      if (u?.enodia?.newer && !isDismissed(u.enodia.latest)) toast(`Enodia ${u.enodia.latest} is available`, 'ok');
    });
    window.addEventListener('hashchange', route);
  }
  connect();
}

boot();
