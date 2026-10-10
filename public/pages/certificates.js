// Certificates: every certificate Traefik has loaded, how long each one has left, which routers serve
// it and how it gets renewed. Traefik reports them in its metrics (traefik_tls_certs_not_after).
import { h, icon, stagger } from '../lib/dom.js';
import { store, api, all } from '../lib/store.js';
import { card, stat, badge, hrefFor, segmented, empty, searchInput, drawer, kv, copyButton, dot } from '../lib/components.js';
import { countTo } from '../lib/charts.js';
import { ruleView, hostsOf } from '../lib/rules.js';
import { num, split } from '../lib/format.js';
import { meter, oicon, guide, code, setHashQuery, hashQuery, showTip, hideTip } from '../lib/observe.js';

const DAY = 86_400_000;
const SPAN = 90;            // days the timeline and the rings cover
const ACME_RENEW = 30;      // Traefik renews 90-day ACME certificates this many days before they expire

const pad = (n) => String(n).padStart(2, '0');
const longDate = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
const shortDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const plainHost = (x) => /^[\w*.-]+$/.test(x) && x !== '*';

/** Does a certificate name (maybe *.example.com) cover a host (maybe a *.example.com domain too)? */
function covers(name, host) {
  const n = name.toLowerCase();
  const hst = host.toLowerCase();
  if (n === hst) return true;
  if (n.startsWith('*.') && !hst.startsWith('*.')) {
    const rest = n.slice(1);
    return hst.endsWith(rest) && !hst.slice(0, -rest.length).includes('.') && hst.length > rest.length;
  }
  return false;
}

/** Every router that ends TLS, with the hosts it answers for. */
function tlsRouters() {
  return all('routers').filter((r) => r.tls).map((r) => ({
    ...r,
    hosts: [...new Set([...hostsOf(r.rule ?? ''), ...(r.tls.domains ?? []).flatMap((d) => [d.main, ...(d.sans ?? [])])].filter(Boolean).filter(plainHost))],
  }));
}

function countdown(ms) {
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 86400)}d ${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export default {
  render(ctx) {
    ctx.setCrumbs([['Certificates']]);
    const el = h('div', { class: 'col gap-lg ob ob-certs' });
    const warnDays = store.meta?.certWarnDays ?? 21;
    const critDays = store.meta?.certCriticalDays ?? 7;
    let raw = null;          // certificates as Traefik reports them
    let error = null;
    let sig = '';
    const query = hashQuery();
    let q = query.get('q') ?? '';
    let sort = query.get('sort') === 'name' ? 'name' : 'expiry';
    let show = ['soon', 'ok'].includes(query.get('show')) ? query.get('show') : 'all';
    let tick = 0;

    const toneOf = (days) => (days < 0 || days < critDays ? 'bad' : days < warnDays ? 'warn' : 'ok');
    const colorOf = (tone) => `var(--${tone})`;

    function model(c, routers) {
      const exp = Date.parse(c.notAfter);
      const days = (exp - Date.now()) / DAY;
      const names = [...new Set([...(c.sans ?? []), c.cn].filter(Boolean))];
      const serving = routers.filter((r) => r.hosts.some((host) => names.some((n) => covers(n, host))));
      return {
        ...c, exp, days, names, tone: toneOf(days), serving,
        resolvers: [...new Set(serving.map((r) => r.tls?.certResolver).filter(Boolean))],
        options: [...new Set(serving.map((r) => r.tls?.options || 'default'))],
        title: c.cn || names[0] || 'unnamed certificate',
      };
    }

    // ── head ──

    const search = searchInput({ placeholder: 'Find a name, serial or router…', value: q, oninput: (v) => { q = v.trim(); sync(); paintCards(); } });
    const head = h('div', { class: 'page-head ob-head' },
      h('div', { class: 'grow' },
        h('h1', { class: 'page-title' }, icon('cert', { size: 24, cls: 'torch-text' }), 'Certificates'),
        h('p', { class: 'page-sub' }, 'Every certificate Traefik has loaded, how long it has left and who serves it.')),
      h('div', { class: 'ob-head-tools ob-cert-tools' },
        h('div', { class: 'ob-cert-search' }, search),
        segmented([['expiry', 'Soonest'], ['name', 'Name']], sort, (v) => { sort = v; sync(); paintCards(); }),
        segmented([['all', 'All'], ['soon', 'Expiring'], ['ok', 'Healthy']], show, (v) => { show = v; sync(); paintCards(); })));

    const tiles = {
      count: stat({ label: 'Certificates', icon: 'cert', value: '—', foot: ' ' }),
      next: stat({ label: 'Next to expire', icon: 'clock', value: '—', foot: ' ' }),
      soon: stat({ label: `Expiring within ${warnDays} days`, icon: 'alert', value: '—', foot: ' ' }),
      acme: stat({ label: 'Renewed by ACME', icon: 'refresh', value: '—', foot: ' ' }),
    };
    for (const t of Object.values(tiles)) { t.classList.add('ob-cert-tile'); t.footEl = t.querySelector('.stat-foot'); }
    const tileGrid = stagger(h('div', { class: 'grid g4' }, ...Object.values(tiles)));

    const timeline = h('div', { class: 'ob-tl' });
    const tlCard = card({ title: [oicon('calendar', { size: 15 }), `The next ${SPAN} days`], sub: 'When each certificate runs out. Traefik renews ACME certificates inside the dashed window.' }, timeline);
    const cards = h('div', { class: 'ob-cert-grid' });
    const missing = h('div');
    const renewal = h('div');
    const body = h('div', { class: 'col gap-lg' });

    el.append(head, body);
    body.append(...skeletons());

    function skeletons() {
      const tile = () => h('div', { class: 'card stat' }, h('div', { class: 'skeleton', style: { width: '50%' } }), h('div', { class: 'skeleton', style: { height: '28px', width: '40%', marginTop: '12px' } }));
      const certSkel = () => h('div', { class: 'card ob-cert ob-cert-skel' },
        h('div', { class: 'row', style: { gap: '16px' } },
          h('div', { class: 'skeleton', style: { width: '88px', height: '88px', borderRadius: '50%' } }),
          h('div', { class: 'grow col' }, h('div', { class: 'skeleton', style: { width: '70%', height: '16px' } }), h('div', { class: 'skeleton', style: { width: '45%' } }))));
      return [h('div', { class: 'grid g4' }, ...Array.from({ length: 4 }, tile)), h('div', { class: 'ob-cert-grid' }, ...Array.from({ length: 3 }, certSkel))];
    }

    // ── painters ──

    function models() {
      const routers = tlsRouters();
      return { routers, list: (raw ?? []).map((c) => model(c, routers)) };
    }

    function paint() {
      if (raw === null) return;
      const { routers, list } = models();
      if (!list.length) { paintEmpty(routers); return; }
      head.querySelector('.ob-cert-tools').hidden = false;
      if (!body.contains(tileGrid)) body.replaceChildren(tileGrid, tlCard, cards, stagger(h('div', { class: 'grid g2' }, missing, renewal)));
      paintTiles(list);
      paintTimeline(list);
      paintCards();
      paintMissing(routers, list);
      renewal.replaceChildren(renewalCard());
    }

    function paintTiles(list) {
      const next = [...list].sort((a, b) => a.exp - b.exp)[0];
      const hosts = new Set(list.flatMap((c) => c.names));
      const soon = list.filter((c) => c.days < warnDays);
      const acme = list.filter((c) => c.resolvers.length);
      countTo(tiles.count.valueEl, list.length);
      tiles.count.footEl.replaceChildren(`${num(hosts.size)} name${hosts.size === 1 ? '' : 's'} covered`);
      tiles.next.valueEl.replaceChildren(next.days < 0 ? 'expired' : h('span', {}, String(Math.floor(next.days)), h('small', {}, next.days < 2 ? ' day' : ' days')));
      tiles.next.valueEl.className = `stat-value ${next.tone}-text`;
      tiles.next.footEl.replaceChildren(h('span', { class: 'ellipsis' }, next.title));
      countTo(tiles.soon.valueEl, soon.length);
      tiles.soon.valueEl.className = `stat-value ${soon.some((c) => c.tone === 'bad') ? 'bad-text' : soon.length ? 'warn-text' : 'ok-text'}`;
      tiles.soon.footEl.replaceChildren(soon.length ? soon.map((c) => c.title).join(', ') : 'nothing to do');
      countTo(tiles.acme.valueEl, acme.length);
      tiles.acme.footEl.replaceChildren(acme.length ? [...new Set(acme.flatMap((c) => c.resolvers))].join(', ') : 'the rest come from files');
    }

    function paintTimeline(list) {
      const now = Date.now();
      const within = list.filter((c) => c.days >= 0 && c.days <= SPAN).sort((a, b) => a.days - b.days);
      const later = list.filter((c) => c.days > SPAN).sort((a, b) => a.days - b.days);
      const expired = list.filter((c) => c.days < 0);
      const at = (d) => `${(Math.max(0, Math.min(SPAN, d)) / SPAN) * 100}%`;
      const ticks = [0, 15, 30, 45, 60, 75, 90].map((d) => h('div', { class: 'ob-tl-tick', style: { left: at(d) } }, h('span', {}, d === 0 ? 'today' : shortDate(now + d * DAY))));
      const markers = within.map((c, i) => {
        const m = h('button', { type: 'button', class: `ob-tl-mark ${c.tone}`, style: { left: at(c.days), '--i': String(i) }, onclick: () => openCert(c),
          onpointerenter: (e) => showTip(e.clientX, e.currentTarget.getBoundingClientRect().top, h('b', {}, c.title), h('div', { class: 'small muted' }, `${longDate(c.exp)} · in ${Math.floor(c.days)} days`)),
          onpointerleave: hideTip },
        h('span', { class: 'ob-tl-stem' }), h('span', { class: 'ob-tl-dot' }),
        h('span', { class: 'ob-tl-label' }, h('b', {}, c.title), h('span', {}, `${Math.floor(c.days)} d`)));
        return m;
      });
      timeline.replaceChildren(
        h('div', { class: 'ob-tl-track' },
          h('div', { class: 'ob-tl-zone bad', style: { left: '0', width: at(critDays) }, title: `Under ${critDays} days: critical` }),
          h('div', { class: 'ob-tl-zone warn', style: { left: at(critDays), width: `${((Math.min(warnDays, SPAN) - critDays) / SPAN) * 100}%` }, title: `Under ${warnDays} days: renew soon` }, h('span', {}, `< ${warnDays} d`)),
          h('div', { class: 'ob-tl-acme', style: { left: '0', width: at(ACME_RENEW) } }, h('span', {}, 'ACME renews')),
          h('div', { class: 'ob-tl-axis' }),
          ...ticks,
          ...markers),
        h('div', { class: 'ob-tl-ends' },
          expired.length ? h('span', { class: 'badge bad' }, icon('xcircle', { size: 12 }), `${expired.length} expired: ${expired.map((c) => c.title).join(', ')}`) : h('span'),
          later.length ? h('span', { class: 'ob-tl-later' }, `${later.length} later: `, ...later.flatMap((c, i) => [i ? ', ' : '', h('button', { type: 'button', onclick: () => openCert(c) }, c.title), h('span', { class: 'faint' }, ` (${shortDate(c.exp)})`)]), icon('arrow', { size: 13 })) : null));
      requestAnimationFrame(() => laneOut(markers));
    }

    // labels that would overlap move up a lane
    function laneOut(markers) {
      const track = timeline.querySelector('.ob-tl-track');
      if (!track) return;
      const w = track.clientWidth || 800;
      const lanes = [];
      for (const m of markers) {
        const x = (parseFloat(m.style.left) / 100) * w;
        const lw = (m.querySelector('.ob-tl-label')?.offsetWidth ?? 140) + 14;
        let lane = lanes.findIndex((end) => x > end);
        if (lane < 0) { lane = lanes.length; lanes.push(0); }
        lanes[lane] = x + lw;
        m.style.setProperty('--lane', String(Math.min(lane, 3)));
        m.classList.toggle('flip', x + lw > w);
      }
    }

    function filtered() {
      const { list } = models();
      const needle = q.toLowerCase();
      return list
        .filter((c) => show === 'all' || (show === 'soon' ? c.days < warnDays : c.days >= warnDays))
        .filter((c) => !needle || [c.cn, c.serial, ...c.names, ...c.serving.map((r) => r.name)].some((v) => v && v.toLowerCase().includes(needle)))
        .sort((a, b) => (sort === 'name' ? a.title.localeCompare(b.title) : a.exp - b.exp));
    }

    function certCard(c, i) {
      const ring = meter({ size: 96, thickness: 8, label: c.days < 0 ? 'expired' : 'days left' });
      const left = Math.max(0, c.days);
      ring.set(Math.min(1, left / SPAN), { color: colorOf(c.tone), value: '0' });
      countTo(ring.valueEl, Math.floor(left), { duration: 1100 });
      const sans = c.names.map((n) => h('span', { class: `ob-san ${n.startsWith('*.') ? 'wild' : ''}`.trim(), title: n.startsWith('*.') ? 'Wildcard: one level of subdomains' : n }, n));
      const routers = c.serving.length
        ? c.serving.map((r) => h('a', { class: 'ob-cert-router', href: hrefFor('routers', r.name, r.proto), onclick: (e) => e.stopPropagation(), title: r.rule ?? '' },
          dot(r.status === 'enabled' ? 'ok' : r.status === 'warning' ? 'warn' : 'bad'), h('span', { class: 'ellipsis' }, split(r.name).base), r.proto !== 'http' ? h('span', { class: 'faint tiny' }, r.proto) : null))
        : [h('span', { class: 'muted small' }, 'No router asks for these names')];
      const note = advice(c);
      const node = h('article', { class: `card ob-cert ${c.tone}`, style: { '--i': String(Math.min(i, 12)) }, tabindex: '0', role: 'button', onclick: () => openCert(c), onkeydown: (e) => { if (e.key === 'Enter') openCert(c); } },
        h('div', { class: 'ob-cert-top' }, ring,
          h('div', { class: 'ob-cert-id' },
            h('div', { class: 'ob-cert-cn', title: c.title }, c.title),
            h('div', { class: 'ob-cert-date' }, c.days < 0 ? 'Expired ' : 'Expires ', longDate(c.exp)),
            h('div', { class: 'row wrap', style: { gap: '6px', marginTop: '6px' } },
              h('span', { class: `badge ${c.tone}` }, c.days < 0 ? 'Expired' : c.tone === 'bad' ? 'Renew now' : c.tone === 'warn' ? 'Renew soon' : 'Valid'),
              ...c.resolvers.map((r) => badge(`ACME · ${r}`, 'violet')),
              !c.resolvers.length && c.serving.length ? badge('from a file') : null))),
        h('div', { class: 'ob-cert-sec' }, h('div', { class: 'ob-cert-label' }, `Names · ${c.names.length}`), h('div', { class: 'ob-sans' }, ...sans)),
        h('div', { class: 'ob-cert-sec' }, h('div', { class: 'ob-cert-label' }, 'Served by'), h('div', { class: 'ob-cert-routers' }, ...routers)),
        note ? h('div', { class: `ob-cert-note ${note.tone}` }, icon(note.tone === 'bad' ? 'alert' : 'info', { size: 14 }), h('span', {}, note.text)) : null,
        h('div', { class: 'ob-cert-foot' },
          h('span', { class: 'ob-countdown tnum', dataset: { exp: String(c.exp) } }, countdown(c.exp - Date.now())),
          h('span', { class: 'ob-cert-serial mono ellipsis', title: `Serial ${c.serial}` }, c.serial ? `#${c.serial}` : '')));
      return node;
    }

    function advice(c) {
      if (c.days < 0) return { tone: 'bad', text: 'Browsers refuse this certificate. Replace it, or check why ACME did not renew it.' };
      if (c.resolvers.length && c.days < ACME_RENEW) return { tone: 'bad', text: `ACME should have renewed this ${Math.round(ACME_RENEW - c.days)} days ago. Look for ACME errors in Traefik's log.` };
      if (!c.resolvers.length && c.days < warnDays) return { tone: 'warn', text: 'Not renewed by Traefik: replace the files before the date above.' };
      if (c.resolvers.length && c.days < ACME_RENEW + 7) return { tone: 'info', text: `Traefik renews it in about ${Math.max(0, Math.round(c.days - ACME_RENEW))} days.` };
      return null;
    }

    function paintCards() {
      const list = filtered();
      if (!list.length) { cards.replaceChildren(h('div', { class: 'card ob-cert-none' }, empty('No certificate matches', q ? `Nothing for “${q}”.` : 'Try another filter.', 'search'))); return; }
      cards.classList.toggle('few', list.length <= 2);
      cards.classList.toggle('one', list.length === 1);
      cards.replaceChildren(...list.map(certCard));
    }

    function paintMissing(routers, list) {
      const lacking = routers.filter((r) => r.hosts.length && r.hosts.some((host) => !list.some((c) => c.names.some((n) => covers(n, host)))));
      const rows = lacking.map((r) => {
        const hosts = r.hosts.filter((host) => !list.some((c) => c.names.some((n) => covers(n, host))));
        const why = r.status !== 'enabled' ? 'The router is not serving, so nothing was requested.'
          : r.tls?.certResolver ? `Waiting for ${r.tls.certResolver} to issue one. Check Traefik's log for ACME errors.`
            : 'Traefik answers with its default certificate, which browsers do not trust unless you set one.';
        return h('a', { class: 'ob-miss', href: hrefFor('routers', r.name, r.proto) },
          dot(r.status === 'enabled' ? 'warn' : 'bad'),
          h('div', { class: 'grow', style: { minWidth: '0' } },
            h('div', { class: 'row wrap', style: { gap: '6px' } }, h('b', {}, split(r.name).base), ...hosts.map((x) => h('span', { class: 'ob-san' }, x)), r.tls?.certResolver ? badge(r.tls.certResolver, 'violet') : null),
            h('div', { class: 'tiny muted', style: { marginTop: '3px' } }, why)),
          icon('chevron', { size: 14, cls: 'muted' }));
      });
      missing.replaceChildren(card({ title: 'Routers without a certificate', icon: 'shield', sub: 'TLS routers whose hosts no loaded certificate covers' },
        rows.length ? h('div', { class: 'col', style: { gap: '6px' } }, ...rows) : h('div', { class: 'empty' }, icon('ok', { size: 26, cls: 'ok-text' }), h('div', { class: 'empty-title' }, 'Every TLS host is covered'), h('div', { class: 'small' }, `${routers.length} TLS router${routers.length === 1 ? '' : 's'} checked.`))));
    }

    function renewalCard() {
      const item = (ic, title, text) => h('div', { class: 'ob-how' }, h('div', { class: 'ob-how-ic' }, oicon(ic, { size: 16 })), h('div', {}, h('div', { class: 'bold' }, title), h('div', { class: 'small muted' }, text)));
      return card({ title: 'How renewal works', icon: 'refresh' },
        h('div', { class: 'col', style: { gap: '14px' } },
          item('refresh', 'ACME renews on its own', `For the usual 90-day certificates Traefik starts renewing ${ACME_RENEW} days before the end and checks once a day. A shorter certificatesDuration moves that window.`),
          item('file', 'Files are yours to replace', 'Certificates from tls.certificates are never renewed by Traefik. Swap the files and Traefik reloads them on change.'),
          item('bell', 'Enodia warns early', ['Amber at ', code(`${warnDays} days`), ', red at ', code(`${critDays} days`), '. Change it with ENODIA_CERT_WARN_DAYS and ENODIA_CERT_CRITICAL_DAYS.']),
          item('shield', 'Only loaded certificates show', 'Traefik reports a certificate once it has loaded it. A resolver gets its first one when the router starts or on the first request.')));
    }

    function paintEmpty(routers) {
      head.querySelector('.ob-cert-tools').hidden = true;
      const metricsOff = store.meta?.features?.metrics === false || (error && !raw.length);
      body.replaceChildren(
        metricsOff ? guide({
          icon: 'cert', title: 'Certificates come from Traefik\'s metrics',
          text: 'Traefik reports every loaded certificate and its expiry date on its Prometheus endpoint. Turn metrics on and they appear here, with countdowns and the routers that serve them.',
          steps: [
            { title: 'Enable Prometheus metrics in Traefik', snippets: [{ label: 'traefik.yml', lang: 'yaml', text: 'metrics:\n  prometheus:\n    entryPoint: metrics\n\nentryPoints:\n  metrics:\n    address: ":8082"' }, { label: 'CLI flags', lang: 'sh', text: '--metrics.prometheus=true\n--metrics.prometheus.entryPoint=metrics\n--entryPoints.metrics.address=:8082' }] },
            { title: 'Let Enodia find it', text: ['Enodia looks on the API address and on the metrics entry point. Elsewhere, set ', code('TRAEFIK_METRICS_URL'), '.'] },
          ],
          foot: error ? h('div', { class: 'small muted' }, error) : null,
        }) : h('section', { class: 'card ob-cert-empty' },
          h('div', { class: 'ob-empty-art' }, h('span', { class: 'ob-empty-ring' }), icon('cert', { size: 30 })),
          h('h2', {}, 'No certificates loaded yet'),
          h('p', { class: 'muted' }, 'Traefik reports the certificates it has loaded: from ACME resolvers and from tls.certificates in the file provider. Traefik\'s own default certificate is not one of them.'),
          routers.length ? h('p', { class: 'small muted' }, `${routers.length} router${routers.length === 1 ? ' ends' : 's end'} TLS. Routers with a resolver get their certificate on startup or on the first request.`) : null),
        stagger(h('div', { class: 'grid g2' }, missing, renewal)));
      paintMissing(routers, []);
      renewal.replaceChildren(renewalCard());
    }

    // ── the detail drawer ──

    function openCert(c) {
      hideTip();
      const ring = meter({ size: 120, thickness: 10, label: c.days < 0 ? 'expired' : 'days left' });
      ring.set(Math.min(1, Math.max(0, c.days) / SPAN), { color: colorOf(c.tone), value: String(Math.max(0, Math.floor(c.days))) });
      const note = advice(c);
      const content = h('div', { class: 'ob-entry' },
        h('div', { class: `ob-cert-hero ${c.tone}` }, ring,
          h('div', { class: 'grow', style: { minWidth: '0' } },
            h('div', { class: 'ob-cert-cn' }, c.title),
            h('div', { class: 'ob-cert-date' }, c.days < 0 ? 'Expired ' : 'Valid until ', longDate(c.exp)),
            h('div', { class: 'ob-countdown big tnum', dataset: { exp: String(c.exp) } }, countdown(c.exp - Date.now())))),
        note ? h('div', { class: `ob-cert-note ${note.tone}` }, icon(note.tone === 'bad' ? 'alert' : 'info', { size: 14 }), h('span', {}, note.text)) : null,
        kv([
          ['Common name', c.cn || h('span', { class: 'faint' }, 'none')],
          ['Not after', `${new Date(c.exp).toLocaleString()}`],
          ['Serial', c.serial ? h('span', { class: 'row', style: { gap: '4px' } }, h('span', { class: 'mono small', style: { overflowWrap: 'anywhere' } }, c.serial), copyButton(c.serial, 'Copy the serial')) : null],
          ['Renewal', c.resolvers.length ? `ACME, by ${c.resolvers.join(', ')}` : c.serving.length ? 'By hand: this certificate comes from a file' : 'Unknown: no router uses it'],
          ['TLS options', c.options.length ? c.options.join(', ') : null],
        ]),
        h('div', {}, h('div', { class: 'ob-cert-label' }, `Names · ${c.names.length}`), h('div', { class: 'ob-sans' }, ...c.names.map((n) => h('span', { class: `ob-san ${n.startsWith('*.') ? 'wild' : ''}`.trim() }, n)))),
        h('div', {}, h('div', { class: 'ob-cert-label' }, `Routers · ${c.serving.length}`),
          c.serving.length ? h('div', { class: 'col', style: { gap: '8px' } }, ...c.serving.map((r) => h('a', { class: 'ob-cert-rrow', href: hrefFor('routers', r.name, r.proto) },
            h('div', { class: 'row', style: { gap: '8px' } }, dot(r.status === 'enabled' ? 'ok' : 'bad'), h('b', { class: 'grow ellipsis' }, split(r.name).base, h('span', { class: 'faint tiny' }, ` @${split(r.name).provider}`)),
              ...(r.using ?? r.entryPoints ?? []).map((e) => h('span', { class: 'badge mono' }, e)), r.tls?.certResolver ? badge(r.tls.certResolver, 'violet') : null, badge(`options: ${r.tls?.options || 'default'}`)),
            h('div', { class: 'ob-rule' }, ruleView(r.rule))))) : h('div', { class: 'small muted' }, 'No router asks for these names, so Traefik only uses this certificate if a client asks for it by name.')));
      drawer(c.title, content).el.classList.add('ob-drawer');
    }

    // ── data ──

    async function load() {
      try {
        const m = await api('metrics');
        error = m.ok ? null : m.error;
        const next = m.certs ?? [];
        const s = JSON.stringify(next);
        if (s === sig && raw !== null) return;
        sig = s;
        raw = next;
      } catch (e) {
        error = e.message;
        raw ??= [];
      }
      paint();
    }

    function sync() { setHashQuery('certificates', { q, sort: sort === 'expiry' ? '' : sort, show: show === 'all' ? '' : show }); }

    load();
    const clockId = setInterval(() => {
      if (!el.isConnected) { clearInterval(clockId); return; }
      for (const n of document.querySelectorAll('.ob-countdown[data-exp]')) n.textContent = countdown(Number(n.dataset.exp) - Date.now());
    }, 1000);

    return {
      el,
      update(event) {
        if (!el.isConnected) return;
        if (event === 'metrics' && ++tick % 12 === 0) load();
        else if (event === 'state' && raw) { const { routers, list } = models(); if (list.length) { paintCards(); paintMissing(routers, list); } }
      },
      destroy() { clearInterval(clockId); hideTip(); },
    };
  },
};
