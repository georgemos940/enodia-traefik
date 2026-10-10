// API explorer: any read-only endpoint of the Traefik API, live, with timings, paging, a JSON tree
// that folds and searches, and the same request as curl.
import { h, icon } from '../lib/dom.js';
import { store } from '../lib/store.js';
import { pageHead, segmented, banner } from '../lib/components.js';
import { bytes, ms, num } from '../lib/format.js';
import { copyBtn, jsonPanel, parseJson, ticon } from '../lib/tools-ui.js';

const KIND_ABOUT = {
  routers: 'Each router with its rule, entry points, middlewares, service, TLS settings and status.',
  services: 'Each service with its servers, load-balancing settings and the health of every server.',
  middlewares: 'Each middleware with its type, settings and the routers that use it.',
};
const GROUPS = [
  { name: 'General', items: [
    { path: '/api/overview', label: 'Overview', icon: 'overview', about: 'How many routers, services and middlewares exist per protocol, how many have warnings or errors, and the features and providers in use.' },
    { path: '/api/version', label: 'Version', icon: 'info', about: 'The Traefik version, its codename and when it started.' },
    { path: '/api/rawdata', label: 'Raw data', icon: 'braces', about: 'Everything at once: every router, service and middleware with its status, keyed by name. Large on big setups.' },
    { path: '/api/entrypoints', label: 'Entry points', icon: 'entrypoint', list: 'entrypoints', about: 'Every entry point with its address, transport timeouts, forwarded headers and HTTP defaults.' },
  ] },
  ...['http', 'tcp', 'udp'].map((proto) => ({
    name: proto.toUpperCase(),
    items: ['routers', 'services', ...(proto === 'udp' ? [] : ['middlewares'])].map((kind) => ({
      path: `/api/${proto}/${kind}`, label: kind[0].toUpperCase() + kind.slice(1), icon: kind === 'routers' ? 'router' : kind === 'services' ? 'service' : 'middleware', list: `${proto}.${kind}`, proto, kind,
      about: `${proto.toUpperCase()} ${kind}: ${KIND_ABOUT[kind]}`,
    })),
  })),
];
const ALL = GROUPS.flatMap((g) => g.items);
const BY_NAME = [['entrypoints', 'Entry points'], ['http.routers', 'HTTP routers'], ['http.services', 'HTTP services'], ['http.middlewares', 'HTTP middlewares'], ['tcp.routers', 'TCP routers'], ['tcp.services', 'TCP services'], ['tcp.middlewares', 'TCP middlewares'], ['udp.routers', 'UDP routers'], ['udp.services', 'UDP services']];
const ALLOWED = /^\/api\/(overview|version|rawdata|entrypoints(\/[^/]+)?|(http|tcp|udp)\/(routers|services|middlewares)(\/[^/]+)?)$/;

const namesOf = (key) => {
  const st = store.state;
  if (!st) return [];
  if (key === 'entrypoints') return (st.entrypoints ?? []).map((e) => e.name);
  const [proto, kind] = key.split('.');
  return (st[proto]?.[kind] ?? []).map((x) => x.name);
};
const countOf = (item) => (item.list ? namesOf(item.list).length : null);
const pathFor = (key, name) => `${key === 'entrypoints' ? '/api/entrypoints' : `/api/${key.replace('.', '/')}`}/${encodeURIComponent(name).replace(/%40/g, '@')}`;
const statusText = (s) => ({ 200: 'OK', 400: 'Bad request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not found', 500: 'Server error', 502: 'Bad gateway', 503: 'Unavailable' }[s] ?? '');

export default {
  render(ctx) {
    ctx.setCrumbs([['API explorer']]);
    let path = ctx.query.get('path') ?? '/api/overview';
    let params = { search: '', status: '', per_page: '', page: '1' };
    let nameKey = 'http.routers';
    let nameFilter = '';
    let ctrl = null;
    let last = null; // { status, ms, traefikMs, size, nextPage, data, text, url }

    // ── sidebar ──
    const sideList = h('nav', { class: 'tl-ex-nav' });
    const kindSel = h('select', { class: 'input tl-ex-kind', 'aria-label': 'Kind', onchange: (e) => { nameKey = e.target.value; side.classList.add('names-open'); paintNames(); } },
      ...BY_NAME.map(([k, l]) => h('option', { value: k }, l)));
    kindSel.value = nameKey;
    const nameInput = h('input', { class: 'input', type: 'search', placeholder: 'Filter names…', autocomplete: 'off', spellcheck: false, onfocus: () => side.classList.add('names-open'), oninput: (e) => { nameFilter = e.target.value; paintNames(); } });
    const names = h('div', { class: 'tl-ex-names' });
    const side = h('aside', { class: 'card tl-ex-side' },
      sideList,
      h('div', { class: 'tl-ex-byname' },
        h('div', { class: 'tl-mini-label' }, 'By name'),
        kindSel,
        h('label', { class: 'input-wrap' }, icon('search', { size: 14 }), nameInput),
        names));

    // ── request ──
    const pathInput = h('input', { class: 'input tl-ex-path', value: path, spellcheck: false, autocomplete: 'off', 'aria-label': 'Path', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); go(pathInput.value.trim(), true); } } });
    const sendBtn = h('button', { type: 'button', class: 'btn primary tl-ex-send', onclick: () => go(pathInput.value.trim(), false) }, ticon('send', { size: 14 }), h('span', { class: 'tl-hide-sm' }, 'Send'));
    const about = h('p', { class: 'tl-ex-about' });
    const listControls = h('div', { class: 'tl-ex-params' });
    const metaRow = h('div', { class: 'tl-ex-meta' });
    const actions = h('div', { class: 'tl-ex-actions' });
    const result = h('div', { class: 'tl-ex-result' });
    const reqCard = h('section', { class: 'card tl-ex-req' },
      h('div', { class: 'tl-ex-bar' }, h('span', { class: 'tl-ex-method' }, 'GET'), pathInput, sendBtn),
      about, listControls);
    const main = h('div', { class: 'tl-ex-main' }, reqCard, h('div', { class: 'tl-ex-respbar' }, metaRow, actions), result);

    const el = h('div', { class: 'col gap-lg tl-page' },
      pageHead({ title: 'API explorer', icon: 'code', sub: 'Every read-only endpoint of the Traefik API, live. Enodia passes the requests through; nothing can be changed from here.' }),
      h('div', { class: 'tl-ex' }, side, main));

    const current = () => ALL.find((x) => x.path === path.split('?')[0]) ?? null;

    function paintSide() {
      const cur = path.split('?')[0];
      sideList.replaceChildren(...GROUPS.map((g) => h('div', { class: 'tl-ex-group' },
        h('div', { class: 'tl-mini-label' }, g.name),
        ...g.items.map((it) => {
          const n = countOf(it);
          return h('button', { type: 'button', class: `tl-ex-item ${cur === it.path || cur.startsWith(`${it.path}/`) ? 'on' : ''}`.trim(), onclick: () => { params = { search: '', status: '', per_page: '', page: '1' }; go(it.path, true); }, title: it.path },
            ticon(it.icon, { size: 15 }), h('span', { class: 'grow' }, it.label), n !== null ? h('span', { class: 'tl-ex-n tnum' }, num(n)) : null);
        }))));
    }

    function paintNames() {
      const all = namesOf(nameKey);
      const q = nameFilter.trim().toLowerCase();
      const list = all.filter((n) => !q || n.toLowerCase().includes(q));
      const cur = path.split('?')[0];
      names.replaceChildren(...list.slice(0, 300).map((n) => {
        const p = pathFor(nameKey, n);
        const at = n.lastIndexOf('@');
        return h('button', { type: 'button', class: `tl-ex-name ${cur === p ? 'on' : ''}`.trim(), title: p, onclick: () => { side.classList.remove('names-open'); go(p, true); if (matchMedia('(max-width: 960px)').matches) main.scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
          h('span', { class: 'ellipsis' }, at > 0 ? n.slice(0, at) : n), at > 0 ? h('span', { class: 'faint' }, n.slice(at)) : null);
      }), !list.length ? h('div', { class: 'small muted tl-ex-nonames' }, all.length ? 'Nothing matches' : 'None of this kind') : null);
    }

    function paintControls() {
      const it = current();
      about.replaceChildren(it ? it.about : /\/api\/(entrypoints|http|tcp|udp)\/.+\/.+|\/api\/entrypoints\/.+/.test(path) ? 'One resource, by name, exactly as Traefik reports it.' : '');
      if (!it?.list) { listControls.replaceChildren(); listControls.hidden = true; return; }
      listControls.hidden = false;
      const isEp = it.list === 'entrypoints';
      const search = h('input', { class: 'input', type: 'search', placeholder: 'Traefik search (name contains…)', value: params.search, autocomplete: 'off', spellcheck: false, onkeydown: (e) => { if (e.key === 'Enter') { params.search = e.target.value; params.page = '1'; run(); } }, onchange: (e) => { params.search = e.target.value; params.page = '1'; run(); } });
      const perPage = h('select', { class: 'input', 'aria-label': 'Per page', onchange: (e) => { params.per_page = e.target.value; params.page = '1'; run(); } },
        ...[['', 'Per page: default'], ['5', '5 per page'], ['10', '10 per page'], ['25', '25 per page'], ['100', '100 per page']].map(([v, l]) => h('option', { value: v }, l)));
      perPage.value = params.per_page;
      const page = Number(params.page) || 1;
      const next = last?.nextPage && last.nextPage > page ? last.nextPage : null;
      listControls.replaceChildren(
        isEp ? null : h('label', { class: 'input-wrap tl-ex-search' }, icon('search', { size: 14 }), search),
        isEp ? null : segmented([['', 'Any status'], ['enabled', 'Enabled'], ['warning', 'Warning'], ['disabled', 'Disabled']], params.status, (v) => { params.status = v; params.page = '1'; run(); }),
        perPage,
        h('div', { class: 'tl-ex-pager' },
          h('button', { type: 'button', class: 'btn sm icon-only', title: 'Previous page', disabled: page <= 1, onclick: () => { params.page = String(page - 1); run(); } }, icon('chevron', { size: 14, cls: 'tl-flip' })),
          h('span', { class: 'small tnum' }, `Page ${page}`, next ? h('span', { class: 'muted' }, ` · more`) : null),
          h('button', { type: 'button', class: 'btn sm icon-only', title: 'Next page', disabled: !next, onclick: () => { params.page = String(next); run(); } }, icon('chevron', { size: 14 }))));
    }

    const query = () => {
      const it = current();
      if (!it?.list) return '';
      const q = new URLSearchParams();
      if (params.search && it.list !== 'entrypoints') q.set('search', params.search);
      if (params.status && it.list !== 'entrypoints') q.set('status', params.status);
      if (params.per_page) q.set('per_page', params.per_page);
      if (params.page && params.page !== '1') q.set('page', params.page);
      const s = q.toString();
      return s ? `?${s}` : '';
    };

    function go(p, fromNav) {
      let target = p || '/api/overview';
      if (!target.startsWith('/')) target = `/${target}`;
      const [base, qs] = target.split('?');
      if (!fromNav && qs) {
        const q = new URLSearchParams(qs);
        params = { search: q.get('search') ?? '', status: q.get('status') ?? '', per_page: q.get('per_page') ?? '', page: q.get('page') ?? '1' };
      }
      path = base;
      try { history.replaceState(null, '', `#/explorer?path=${encodeURIComponent(path)}`); } catch { /* sandboxed */ }
      paintSide(); paintNames();
      run();
    }

    function curl() {
      const api = store.meta?.traefikApi ?? 'http://traefik:8080';
      return `curl -s '${api}${path}${query()}' | jq .`;
    }

    async function run() {
      const full = `${path}${query()}`;
      pathInput.value = full;
      paintControls();
      if (!ALLOWED.test(path)) {
        last = null;
        metaRow.replaceChildren(h('span', { class: 'tl-ex-status bad' }, 'Not allowed'));
        actions.replaceChildren();
        result.replaceChildren(banner('warn', 'Only the read-only Traefik API paths can be viewed', 'For example /api/overview, /api/http/routers or /api/http/routers/<name>.'));
        return;
      }
      ctrl?.abort();
      ctrl = new AbortController();
      sendBtn.classList.add('busy');
      result.classList.add('loading');
      if (!result.firstChild) result.replaceChildren(h('div', { class: 'card tl-ex-skel' }, ...Array.from({ length: 9 }, (_, i) => h('div', { class: 'skeleton', style: { width: `${30 + ((i * 41) % 55)}%`, marginLeft: `${(i % 4) * 18}px` } }))));
      const started = performance.now();
      try {
        const res = await fetch(`api/raw?path=${encodeURIComponent(full)}`, { credentials: 'same-origin', signal: ctrl.signal });
        const text = await res.text();
        const took = performance.now() - started;
        let data = null;
        try { data = parseJson(text); } catch { /* not JSON */ }
        const tms = res.headers.get('X-Traefik-Ms');
        last = { status: res.status, ms: took, traefikMs: tms !== null && tms !== '' && Number.isFinite(Number(tms)) ? Number(tms) : null, size: new TextEncoder().encode(text).length, nextPage: Number(res.headers.get('X-Next-Page')) || null, data, text };
        paint();
      } catch (e) {
        if (e.name === 'AbortError') return;
        last = null;
        metaRow.replaceChildren(h('span', { class: 'tl-ex-status bad' }, 'Failed'));
        result.replaceChildren(banner('bad', 'The request failed', e.message));
      } finally {
        sendBtn.classList.remove('busy');
        result.classList.remove('loading');
      }
    }

    let panel = null;
    let panelPath = '';
    function paint() {
      const r = last;
      const ok = r.status >= 200 && r.status < 300;
      const items = Array.isArray(r.data) ? r.data.length : r.data && typeof r.data === 'object' ? Object.keys(r.data).length : null;
      metaRow.replaceChildren(
        h('span', { class: `tl-ex-status ${ok ? 'ok' : 'bad'}` }, h('i'), `${r.status} ${statusText(r.status)}`),
        h('span', { class: 'tl-ex-stat', title: 'Time Traefik took, as Enodia measured it' }, ticon('clock', { size: 13 }), 'Traefik ', h('b', {}, r.traefikMs === null ? '—' : r.traefikMs < 1 ? '<1 ms' : ms(r.traefikMs))),
        h('span', { class: 'tl-ex-stat', title: 'Round trip from this browser' }, ticon('zap', { size: 13 }), 'Total ', h('b', {}, ms(r.ms))),
        h('span', { class: 'tl-ex-stat' }, ticon('download', { size: 13 }), h('b', {}, bytes(r.size))),
        items !== null ? h('span', { class: 'tl-ex-stat' }, ticon('list', { size: 13 }), h('b', {}, num(items)), Array.isArray(r.data) ? ` item${items === 1 ? '' : 's'}` : ` key${items === 1 ? '' : 's'}`) : null,
        r.nextPage && current()?.list ? h('span', { class: 'tl-ex-stat', title: 'X-Next-Page header' }, ticon('hash', { size: 13 }), 'next page ', h('b', {}, r.nextPage > (Number(params.page) || 1) ? String(r.nextPage) : 'none')) : null);
      actions.replaceChildren(
        copyBtn(curl, { label: 'curl', toastText: 'curl command copied', cls: 'btn sm' }),
        h('a', { class: 'btn sm ghost icon-only', href: `api/raw?path=${encodeURIComponent(`${path}${query()}`)}`, target: '_blank', rel: 'noreferrer', title: 'Open the raw response in a new tab' }, icon('external', { size: 14 })));
      paintControls();
      if (r.data === null) { result.replaceChildren(h('pre', { class: 'json' }, r.text.slice(0, 20000))); panel = null; return; }
      const name = `traefik${path.replace(/[^a-z0-9@._-]+/gi, '-')}.json`;
      // paging through the same list keeps the tree and its search
      if (panel && panelPath === path && result.contains(panel.el)) { panel.set(r.data); return; }
      panel = jsonPanel(r.data, { filename: name, depth: Array.isArray(r.data) ? 1 : 2 });
      panelPath = path;
      result.replaceChildren(h('div', { class: 'tl-fade' }, panel.el));
    }

    paintSide(); paintNames();
    go(path, false);

    return {
      el,
      update(event) {
        if (event === 'state') { paintSide(); paintNames(); }
      },
      destroy() { ctrl?.abort(); },
    };
  },
};
