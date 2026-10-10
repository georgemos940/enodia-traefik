// Static configuration: what Traefik was started with (entry points, providers, certificate
// resolvers, API, metrics, tracing, logs, transports), read from its support dump and explained.
import { h, icon } from '../lib/dom.js';
import { store, all } from '../lib/store.js';
import { pageHead, tabs, empty, timeAgo, hrefFor } from '../lib/components.js';
import { bytes, plural } from '../lib/format.js';
import { codeBlock, copyBtn, download, jsonPanel, maskEmail, maskDeep, ticon, SECRET } from '../lib/tools-ui.js';

// ── values ───────────────────────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isSet = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
const HIDDEN = 'xxxx';

const pill = (text, tone = '') => h('span', { class: `tl-pill ${tone}`.trim() }, h('i'), text);
const onOff = (v, { on = 'On', off = 'Off', onTone = 'ok', offTone = '' } = {}) => pill(v ? on : off, v ? onTone : offTone);
const mono = (v) => h('code', { class: 'tl-mono' }, String(v));
const hidden = () => h('span', { class: 'tl-anon', title: 'Traefik leaves this value out of the support dump' }, ticon('eyeOff', { size: 12 }), 'hidden by Traefik');
const chips = (arr) => h('span', { class: 'tl-vchips' }, ...arr.map((x) => h('code', { class: 'tl-vchip' }, typeof x === 'object' ? JSON.stringify(x) : String(x))));
const none = (t = 'none') => h('span', { class: 'tl-none' }, t);

/** Go durations without the zero tails: 1m0s -> 1m, 2h0m0s -> 2h. */
const prettyDur = (v) => String(v).replace(/(\d)m0s$/, '$1m').replace(/(\d)h0m$/, '$1h');
const dur = (v) => (!isSet(v) || v === '0s' || v === 0 || v === '0' ? none('no limit') : mono(prettyDur(v)));
const str = (v) => (v === HIDDEN ? hidden() : mono(v));

function value(key, v) {
  if (key && SECRET.test(key) && isSet(v) && typeof v !== 'boolean') return h('span', { class: 'tl-anon' }, ticon('eyeOff', { size: 12 }), 'set, hidden');
  if (typeof v === 'boolean') return onOff(v);
  if (Array.isArray(v)) return v.length ? chips(v) : none('empty');
  if (isObj(v)) return Object.keys(v).length ? mono(JSON.stringify(v)) : pill('enabled', 'ok');
  if (v === HIDDEN) return hidden();
  if (typeof v === 'string' && /^\d+(\.\d+)?(ns|us|µs|ms|s|m|h)(\d|$)/.test(v)) return dur(v);
  return mono(v);
}

/** Every leaf of an object as [dotted.path, value]; empty objects count as leaves ("enabled"). */
function flat(o, prefix = '') {
  if (!isObj(o) || !Object.keys(o).length) return [[prefix, o]];
  return Object.entries(o).flatMap(([k, v]) => (isObj(v) && Object.keys(v).length && !SECRET.test(k) ? flat(v, prefix ? `${prefix}.${k}` : k) : [[prefix ? `${prefix}.${k}` : k, v]]));
}

const humanize = (k) => {
  const last = k.split('.').pop();
  const t = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// what a setting means, by its key
const HELP = {
  watch: 'Reloads as soon as the source changes.',
  exposedByDefault: 'false: a container needs traefik.enable=true to get a router.',
  network: 'The network Traefik uses to reach containers. Without it Traefik picks one of the container\'s networks, which breaks when it shares none with Traefik.',
  constraints: 'Only what matches this expression is read.',
  endpoint: 'Where Traefik reads from.',
  defaultRule: 'The rule a router gets when it does not set one.',
  useBindPortIP: 'Route to the host IP and port the container is published on, not its own address.',
  allowEmptyServices: 'Keep routers whose service has no healthy server (they answer 503 instead of 404).',
  filename: 'The file Traefik reads.',
  directory: 'Every file in this directory is read.',
  namespaces: 'Namespaces watched; empty means all of them.',
  labelSelector: 'Only objects with these labels are read.',
  ingressClass: 'Only Ingresses of this class are read.',
  allowCrossNamespace: 'Lets a route use services and middlewares of other namespaces.',
  allowExternalNameServices: 'Allows ExternalName services, which can point anywhere.',
  throttleDuration: 'Changes are applied at most this often.',
  refreshSeconds: 'How often the source is polled.',
  pollInterval: 'How often the endpoint is polled.',
  rootKey: 'Keys under this prefix hold the configuration.',
  prefix: 'Tags start with this prefix.',
  httpClientTimeout: 'Timeout for calls to the Docker API.',
};

// ── building blocks ──────────────────────────────────────────────────────────

function row(label, val, { help = '', key = '', tone = '' } = {}) {
  if (val === undefined || val === null) return null;
  const el = h('div', { class: `tl-row ${tone}`.trim() },
    h('div', { class: 'tl-row-k' }, h('div', { class: 'tl-row-label' }, label, key && key !== label ? h('code', { class: 'tl-row-key' }, key) : null), help ? h('div', { class: 'tl-row-help' }, help) : null),
    h('div', { class: 'tl-row-v' }, val));
  el.dataset.q = el.textContent.toLowerCase();
  return el;
}

const genericRows = (o, skip = []) => flat(o).filter(([k]) => k && !skip.includes(k.split('.')[0])).map(([k, v]) => row(humanize(k), value(k.split('.').pop(), v), { key: k, help: HELP[k.split('.').pop()] ?? '' }));

function section(id, title, ic, sub, body, { count, tools = [] } = {}) {
  const el = h('section', { class: 'card tl-sec', id: `cfg-${id}` },
    h('header', { class: 'tl-sec-head' },
      h('span', { class: 'tl-sec-ic' }, ticon(ic, { size: 17 })),
      h('div', { class: 'grow' }, h('h3', {}, title, count !== undefined ? h('span', { class: 'tl-sec-n tnum' }, String(count)) : null), sub ? h('p', {}, sub) : null),
      ...tools),
    h('div', { class: 'tl-sec-body' }, body));
  el.dataset.q = `${title} ${sub ?? ''}`.toLowerCase();
  el.dataset.title = title;
  return el;
}
const rows = (...r) => h('div', { class: 'tl-rows' }, ...r.flat().filter(Boolean));
const off = (text, snippet) => h('div', { class: 'tl-off' }, h('div', { class: 'row', style: { gap: '8px' } }, pill('Off'), h('span', { class: 'muted' }, text)), snippet ? codeBlock(snippet, { compact: true }) : null);

// ── sections ─────────────────────────────────────────────────────────────────

function entrypointCard(ep, cfg) {
  const tr = ep.transport ?? {};
  const rt = tr.respondingTimeouts ?? {};
  const lc = tr.lifeCycle ?? {};
  const http = ep.http ?? {};
  const udp = /\/udp$/.test(ep.address ?? '');
  const roles = [];
  if (cfg?.metrics?.prometheus?.entryPoint === ep.name) roles.push('metrics');
  if (cfg?.ping && (cfg.ping.entryPoint ?? 'traefik') === ep.name) roles.push('ping');
  if (cfg?.api?.insecure && ep.name === 'traefik') roles.push('API');
  const routers = all('routers').filter((r) => (r.using ?? r.entryPoints ?? []).includes(ep.name)).length;
  const fh = ep.forwardedHeaders ?? {};
  const pp = ep.proxyProtocol;
  const redir = http.redirections?.entryPoint;
  const line = (k, v, tone = '') => h('div', { class: `tl-epl ${tone}`.trim() }, h('span', { class: 'tl-epl-k' }, k), h('span', { class: 'tl-epl-v' }, v));
  const card = h('div', { class: 'tl-ep tl-row' },
    h('div', { class: 'tl-ep-head' },
      h('a', { class: 'tl-ep-name', href: hrefFor('entrypoints', ep.name) }, icon('entrypoint', { size: 15 }), ep.name),
      h('code', { class: 'tl-ep-addr' }, ep.address === HIDDEN ? 'hidden' : ep.address ?? '—'),
      h('span', { class: 'grow' }),
      h('span', { class: `tl-proto ${udp ? 'udp' : 'tcp'}` }, udp ? 'UDP' : 'TCP'),
      ep.http3 ? h('span', { class: 'tl-proto h3', title: 'HTTP/3 over QUIC (UDP) on the same port' }, 'HTTP/3') : null,
      http.tls ? h('span', { class: 'tl-proto tls' }, icon('lock', { size: 11 }), 'TLS') : null,
      ep.asDefault ? h('span', { class: 'tl-proto' }, 'default') : null),
    h('div', { class: 'tl-ep-sub' }, roles.length ? `Serves Traefik's ${roles.join(', ')}` : udp ? 'UDP routers only' : `${plural(routers, 'router')} attached`),
    h('div', { class: 'tl-ep-lines' },
      redir ? line('Redirects', h('span', {}, 'to ', h('b', {}, redir.to), ` (${redir.scheme ?? 'https'}${redir.permanent === false ? ', temporary' : ', permanent'})`), 'torch') : null,
      http.tls ? line('Default TLS', h('span', {}, http.tls.certResolver ? ['resolver ', h('b', {}, http.tls.certResolver)] : 'on', http.tls.options ? ` · options ${http.tls.options}` : '', http.tls.domains?.length ? ` · ${http.tls.domains.map((d) => d.main).join(', ')}` : '')) : null,
      http.middlewares?.length ? line('Middlewares', chips(http.middlewares)) : null,
      !udp ? line('Timeouts', h('span', { class: 'tl-timeouts' }, h('span', {}, 'read ', dur(rt.readTimeout)), h('span', {}, 'write ', dur(rt.writeTimeout)), h('span', {}, 'idle ', dur(rt.idleTimeout)))) : null,
      udp ? line('UDP timeout', dur(ep.udp?.timeout)) : null,
      line('Graceful stop', h('span', {}, dur(lc.graceTimeOut), lc.requestAcceptGraceTimeout ? [' · accepts for ', dur(lc.requestAcceptGraceTimeout)] : null)),
      tr.keepAliveMaxRequests || tr.keepAliveMaxTime ? line('Keep-alive', h('span', {}, tr.keepAliveMaxRequests ? `${tr.keepAliveMaxRequests} requests` : '', tr.keepAliveMaxTime ? [' · ', dur(tr.keepAliveMaxTime)] : '')) : null,
      !udp ? line('Forwarded headers', fh.insecure ? pill('trusted from anyone', 'warn') : fh.trustedIPs?.length ? h('span', { class: 'tl-vchips' }, pill(`trusted from ${fh.trustedIPs.length}`, 'ok'), chips(fh.trustedIPs)) : pill('ignored from clients', ''), fh.insecure ? 'warn' : '') : null,
      pp ? line('Proxy protocol', pp.insecure ? pill('from anyone', 'warn') : chips(pp.trustedIPs ?? []), pp.insecure ? 'warn' : '') : null,
      !udp && (http.maxHeaderBytes || http.sanitizePath !== undefined) ? line('Requests', h('span', {}, http.maxHeaderBytes ? `headers up to ${bytes(http.maxHeaderBytes)}` : '', http.sanitizePath === false ? ' · paths not cleaned' : ' · paths cleaned', http.encodeQuerySemicolons ? ' · ; kept in queries' : '')) : null,
      !udp && ep.http2?.maxConcurrentStreams ? line('HTTP/2', `${ep.http2.maxConcurrentStreams} streams per connection`) : null,
      ep.http3?.advertisedPort ? line('HTTP/3', `advertised on port ${ep.http3.advertisedPort}`) : null,
      ep.observability && Object.values(ep.observability).some((v) => v === false) ? line('Observability', h('span', {}, 'off for ', Object.entries(ep.observability).filter(([, v]) => v === false).map(([k]) => k).join(', '))) : null));
  card.dataset.q = card.textContent.toLowerCase();
  return card;
}

const PROVIDERS = {
  docker: ['Docker', 'box', 'Reads the labels of running containers and turns them into routers and services.'],
  swarm: ['Docker Swarm', 'box', 'Reads the labels of Swarm services.'],
  file: ['File', 'file', 'Reads routers, services and middlewares from a YAML or TOML file or directory.'],
  kubernetesCRD: ['Kubernetes CRD', 'layers', 'IngressRoute, Middleware and the other Traefik resources.'],
  kubernetesIngress: ['Kubernetes Ingress', 'layers', 'Standard Ingress objects.'],
  kubernetesGateway: ['Kubernetes Gateway API', 'layers', 'HTTPRoute, GRPCRoute, TCPRoute and TLSRoute objects.'],
  kubernetesIngressNGINX: ['Kubernetes Ingress NGINX', 'layers', 'Ingresses written for ingress-nginx, with their annotations.'],
  consulCatalog: ['Consul Catalog', 'service', 'Services registered in Consul, configured with tags.'],
  nomad: ['Nomad', 'service', 'Nomad services, configured with tags.'],
  ecs: ['Amazon ECS', 'box', 'ECS tasks, configured with labels.'],
  http: ['HTTP', 'globe', 'Polls an endpoint that answers with the dynamic configuration as JSON.'],
  redis: ['Redis', 'key', 'Reads the configuration from keys under a root key.'],
  etcd: ['etcd', 'key', 'Reads the configuration from keys under a root key.'],
  consul: ['Consul KV', 'key', 'Reads the configuration from keys under a root key.'],
  zooKeeper: ['ZooKeeper', 'key', 'Reads the configuration from keys under a root key.'],
  rest: ['REST', 'code', 'Takes the configuration through PUT requests on the API.'],
  plugin: ['Plugins', 'plug', 'Providers that come from plugins.'],
};
const DEFAULT_TRUE = { docker: ['exposedByDefault', 'watch'], swarm: ['exposedByDefault', 'watch'], file: ['watch'], consulCatalog: ['exposedByDefault'], nomad: ['exposedByDefault'], ecs: ['exposedByDefault'] };

function providerCard(key, conf) {
  const [title, ic, about] = PROVIDERS[key] ?? [humanize(key), 'layers', 'A provider of dynamic configuration.'];
  const c = isObj(conf) ? conf : {};
  const name = key.toLowerCase();
  const nRouters = all('routers').filter((r) => r.provider === name).length;
  const nServices = all('services').filter((s) => s.provider === name).length;
  const special = [];
  for (const k of DEFAULT_TRUE[key] ?? []) {
    const v = c[k] ?? true;
    if (k === 'exposedByDefault') special.push(row('Exposed by default', v ? pill('every container', 'warn') : pill('only opted-in', 'ok'), { key: k, help: v ? 'Each container gets a router unless it sets traefik.enable=false. exposedByDefault=false is safer.' : 'A container needs traefik.enable=true to get a router.', tone: v ? 'warn' : '' }));
    if (k === 'watch') special.push(row('Watch', onOff(v), { key: k, help: HELP.watch + (c[k] === undefined ? ' (default)' : '') }));
  }
  if (key === 'docker' && !c.network) special.push(row('Network', none('not set'), { key: 'network', help: HELP.network, tone: 'info' }));
  const skip = DEFAULT_TRUE[key] ?? [];
  const body = rows(special, genericRows(c, skip));
  const el = h('div', { class: 'tl-prov tl-row' },
    h('div', { class: 'tl-prov-head' }, h('span', { class: 'tl-prov-ic' }, ticon(ic, { size: 16 })), h('div', { class: 'grow' }, h('div', { class: 'bold' }, title), h('div', { class: 'small muted' }, about)),
      nRouters || nServices ? h('div', { class: 'tl-prov-stat' }, h('b', { class: 'tnum' }, String(nRouters)), ' routers · ', h('b', { class: 'tnum' }, String(nServices)), ' services') : null),
    body.children.length ? body : h('div', { class: 'small muted' }, 'Runs with its defaults.'));
  el.dataset.q = el.textContent.toLowerCase();
  return el;
}

function caLabel(ca) {
  if (!ca) return [pill("Let's Encrypt", 'ok'), 'production (default)'];
  if (/staging/i.test(ca)) return [pill('Staging', 'warn'), 'test certificates: browsers do not trust them'];
  if (/acme-v02\.api\.letsencrypt\.org/.test(ca)) return [pill("Let's Encrypt", 'ok'), 'production'];
  if (/zerossl/i.test(ca)) return [pill('ZeroSSL', 'ok'), ''];
  if (/pki\.goog/.test(ca)) return [pill('Google Trust Services', 'ok'), ''];
  let host = ca;
  try { host = new URL(ca).host; } catch { /* as written */ }
  return [pill('Custom CA', 'info'), host];
}

function resolverCard(name, r) {
  const acme = r.acme;
  const users = all('routers').filter((x) => x.tls?.certResolver === name).length + (store.state?.entrypoints ?? []).filter((e) => e.http?.tls?.certResolver === name).length;
  let body;
  if (acme) {
    const [caPill, caText] = caLabel(acme.caServer);
    const ch = acme.dnsChallenge ? ['DNS-01', `through ${acme.dnsChallenge.provider ?? 'a DNS provider'}: works behind firewalls and for wildcards`]
      : acme.tlsChallenge ? ['TLS-ALPN-01', 'answered on port 443']
        : acme.httpChallenge ? ['HTTP-01', `answered on entry point ${acme.httpChallenge.entryPoint ?? '?'} (port 80 must reach it)`] : null;
    const dns = acme.dnsChallenge ?? {};
    body = rows(
      row('Certificate authority', h('span', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, caPill, caText ? h('span', { class: 'muted small' }, caText) : null), { key: 'caServer', tone: /staging/i.test(acme.caServer ?? '') ? 'warn' : '' }),
      row('Account email', acme.email ? (acme.email === HIDDEN ? hidden() : h('code', { class: 'tl-mono', title: 'Masked' }, maskEmail(acme.email))) : none('not set'), { key: 'email', help: 'Let\'s Encrypt writes here before a certificate expires.' }),
      row('Challenge', ch ? h('span', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, pill(ch[0], 'info'), h('span', { class: 'muted small' }, ch[1])) : none('not set'), { key: acme.dnsChallenge ? 'dnsChallenge' : acme.tlsChallenge ? 'tlsChallenge' : 'httpChallenge', tone: ch ? '' : 'warn' }),
      dns.resolvers?.length ? row('DNS resolvers', chips(dns.resolvers), { key: 'dnsChallenge.resolvers', help: 'Asked to confirm the TXT record before validation.' }) : null,
      dns.delayBeforeCheck || dns.propagation ? row('Propagation', value('', dns.delayBeforeCheck ?? dns.propagation?.delayBeforeChecks ?? JSON.stringify(dns.propagation)), { key: 'dnsChallenge.propagation' }) : null,
      row('Storage', acme.storage ? str(acme.storage) : mono('acme.json'), { key: 'storage', help: 'Keep it on a volume, or every restart asks for new certificates and hits the rate limits.' }),
      acme.keyType ? row('Key type', mono(acme.keyType), { key: 'keyType' }) : null,
      acme.certificatesDuration ? row('Certificate lifetime', mono(`${acme.certificatesDuration} h`), { key: 'certificatesDuration' }) : null,
      acme.preferredChain ? row('Preferred chain', mono(acme.preferredChain), { key: 'preferredChain' }) : null,
      acme.eab ? row('External account', h('span', {}, mono(acme.eab.kid ?? 'set'), ' ', h('span', { class: 'tl-anon' }, ticon('eyeOff', { size: 12 }), 'HMAC hidden')), { key: 'eab' }) : null,
      ...genericRows(Object.fromEntries(Object.entries(acme).filter(([k]) => !['caServer', 'email', 'dnsChallenge', 'tlsChallenge', 'httpChallenge', 'storage', 'keyType', 'certificatesDuration', 'preferredChain', 'eab'].includes(k)))));
  } else if (r.tailscale !== undefined) {
    body = h('p', { class: 'muted small', style: { margin: 0 } }, 'Gets certificates for *.ts.net names from the Tailscale daemon on the host.');
  } else body = rows(genericRows(r));
  const el = h('div', { class: 'tl-prov tl-row' },
    h('div', { class: 'tl-prov-head' }, h('span', { class: 'tl-prov-ic' }, ticon('cert', { size: 16 })), h('div', { class: 'grow' }, h('div', { class: 'bold' }, name), h('div', { class: 'small muted' }, acme ? 'ACME' : r.tailscale !== undefined ? 'Tailscale' : 'resolver')),
      h('div', { class: 'tl-prov-stat' }, h('b', { class: 'tnum' }, String(users)), users === 1 ? ' user' : ' users')),
    body);
  el.dataset.q = el.textContent.toLowerCase();
  return el;
}

// ── the page ─────────────────────────────────────────────────────────────────

export default {
  render(ctx) {
    ctx.setCrumbs([['Static config']]);
    let tab = ctx.query.get('tab') === 'raw' ? 'raw' : 'overview';
    let query = '';
    const el = h('div', { class: 'col gap-lg tl-page' });
    const body = h('div', { class: 'col gap-lg' });
    let raw = null;

    function paint() {
      const st = store.state;
      const cfg = st?.static ?? null;
      const head = pageHead({
        title: 'Static configuration', icon: 'config',
        sub: 'What Traefik was started with: entry points, providers, certificate resolvers, API, metrics, tracing and logs. Read from its support dump; it changes only when Traefik restarts.',
        actions: cfg ? [
          copyBtn(() => JSON.stringify(maskDeep(cfg), null, 2), { label: 'Copy JSON', toastText: 'Static configuration copied', cls: 'btn sm' }),
          h('button', { type: 'button', class: 'btn sm', onclick: () => download('traefik-static-config.json', JSON.stringify(maskDeep(cfg), null, 2)) }, icon('download', { size: 14 }), 'Download'),
        ] : [],
      });
      const meta = h('div', { class: 'tl-cfg-meta' },
        st?.version ? h('span', { class: 'badge torch' }, `Traefik ${st.version.Version}`) : null,
        cfg && st.staticAt ? h('span', { class: 'small muted' }, 'Read ', timeAgo(st.staticAt)) : null,
        cfg ? h('span', { class: 'small muted tl-hide-sm' }, '· addresses and paths Traefik leaves out show as ', hidden()) : null);
      el.replaceChildren(head, meta, tabs([['overview', 'Explained'], ['raw', 'Raw JSON']], tab, (v) => { tab = v; paintBody(); }), body);
      paintBody();
    }

    function paintBody() {
      const st = store.state;
      const cfg = st?.static ?? null;
      if (tab === 'raw') {
        if (!cfg) { body.replaceChildren(missing()); return; }
        raw = jsonPanel(cfg, { filename: 'traefik-static-config.json', depth: 2 });
        body.replaceChildren(h('div', { class: 'tl-fade' }, raw.el));
        return;
      }
      const sections = buildSections(cfg);
      const nav = h('div', { class: 'tl-chips tl-cfg-nav' }, ...sections.map((s) => h('button', { type: 'button', class: 'tl-chip', onclick: () => s.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, s.dataset.title)));
      const input = h('input', { class: 'input', type: 'search', placeholder: 'Search settings, values, explanations…', value: query, autocomplete: 'off', spellcheck: false });
      const counter = h('span', { class: 'tl-jp-count' });
      const list = h('div', { class: 'tl-secs' }, ...sections);
      const filter = () => {
        const q = query.trim().toLowerCase();
        let shown = 0;
        for (const s of sections) {
          const whole = q && s.dataset.q.includes(q);
          let any = false;
          for (const r of s.querySelectorAll('.tl-row')) {
            const hit = !q || whole || r.dataset.q.includes(q);
            r.hidden = !hit;
            r.classList.toggle('tl-match', Boolean(q) && !whole && hit);
            if (hit) { any = true; shown++; }
          }
          s.hidden = Boolean(q) && !whole && !any;
        }
        counter.textContent = q ? `${shown} match${shown === 1 ? '' : 'es'}` : '';
        counter.classList.toggle('none', Boolean(q) && !shown);
        noMatch.hidden = !q || sections.some((s) => !s.hidden);
      };
      const noMatch = h('div', { class: 'card', hidden: true }, empty('No setting matches', 'Try another word, or look in the raw JSON.', 'search'));
      input.addEventListener('input', () => { query = input.value; filter(); });
      body.replaceChildren(
        !cfg ? missing() : null,
        cfg ? glance(cfg) : null,
        h('div', { class: 'tl-toolbar' }, h('div', { class: 'tl-toolbar-row' }, h('label', { class: 'input-wrap tl-grow-search' }, icon('search', { size: 15 }), input, counter)), nav),
        list, noMatch);
      filter();
    }

    function missing() {
      return h('div', { class: 'card tl-missing' },
        h('div', { class: 'tl-missing-ic' }, ticon('eyeOff', { size: 24 })),
        h('div', { class: 'col', style: { gap: '6px' } },
          h('h3', {}, 'Traefik did not hand over its static configuration'),
          h('p', { class: 'muted' }, 'Enodia reads it from the support dump (', h('code', {}, '/api/support-dump'), '), which recent Traefik v3 releases serve next to the rest of the API. This Traefik did not answer it: it may be older, or a proxy in front of the API blocks that path. The entry points below come from the regular API, so they are always here.'),
          h('p', { class: 'small muted' }, 'Try it by hand from the Enodia container:'),
          codeBlock({ lang: 'sh', code: `curl -s -o /dev/null -w '%{http_code}\\n' ${store.meta?.traefikApi ?? 'http://traefik:8080'}/api/support-dump` }, { compact: true })));
    }

    function glance(cfg) {
      const prov = Object.keys(cfg.providers ?? {}).filter((k) => k !== 'providersThrottleDuration');
      const res = Object.keys(cfg.certificatesResolvers ?? {});
      const metrics = Object.keys(cfg.metrics ?? {}).filter((k) => k !== 'addInternals');
      const tracing = cfg.tracing ? Object.keys(cfg.tracing).find((k) => isObj(cfg.tracing[k])) ?? 'on' : null;
      const tile = (id, label, val, sub, tone = '') => h('button', { type: 'button', class: `tl-glance ${tone}`.trim(), onclick: () => document.getElementById(`cfg-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
        h('span', { class: 'tl-glance-label' }, label), h('span', { class: 'tl-glance-v' }, val), h('span', { class: 'tl-glance-sub' }, sub));
      const eps = store.state?.entrypoints ?? [];
      return h('div', { class: 'tl-glances' },
        tile('entrypoints', 'Entry points', String(eps.length), eps.slice(0, 4).map((e) => e.name).join(', ') + (eps.length > 4 ? '…' : '')),
        tile('providers', 'Providers', String(prov.length), prov.map((p) => PROVIDERS[p]?.[0] ?? p).join(', ') || 'none'),
        tile('resolvers', 'Cert resolvers', String(res.length), res.join(', ') || 'files or default only', res.length ? '' : 'muted'),
        tile('api', 'API', cfg.api ? (cfg.api.insecure ? 'insecure' : 'on') : 'off', cfg.api?.dashboard === false ? 'no dashboard' : 'with dashboard', cfg.api?.insecure ? 'warn' : ''),
        tile('metrics', 'Metrics', metrics.length ? metrics.map((m) => m[0].toUpperCase() + m.slice(1)).join(', ') : 'off', cfg.metrics?.prometheus ? (cfg.metrics.prometheus.addRoutersLabels ? 'per router' : 'no router labels') : 'live traffic needs Prometheus', metrics.length ? '' : 'warn'),
        tile('logs', 'Logs', (cfg.log?.level ?? 'ERROR').toUpperCase(), cfg.accessLog ? `access log: ${cfg.accessLog.format ?? 'common'}` : 'no access log', ''),
        tile('tracing', 'Tracing', tracing ? tracing.toUpperCase() : 'off', tracing ? `sample ${Math.round((cfg.tracing.sampleRate ?? 1) * 100)}%` : 'not configured', tracing ? '' : 'muted'));
    }

    function buildSections(cfg) {
      const c = cfg ?? {};
      const out = [];
      const eps = store.state?.entrypoints ?? [];
      out.push(section('entrypoints', 'Entry points', 'entrypoint', 'The ports Traefik listens on, with their timeouts and defaults.',
        eps.length ? h('div', { class: 'tl-ep-grid' }, ...eps.map((e) => entrypointCard(e, cfg))) : empty('No entry points', '', 'entrypoint'), { count: eps.length }));
      if (!cfg) return out;

      const prov = Object.entries(c.providers ?? {}).filter(([k]) => k !== 'providersThrottleDuration');
      out.push(section('providers', 'Providers', 'layers', 'Where the dynamic configuration (routers, services, middlewares) comes from.',
        h('div', { class: 'col' },
          prov.length ? h('div', { class: 'tl-prov-grid' }, ...prov.map(([k, v]) => providerCard(k, v))) : empty('No providers', 'Only Traefik\'s internal routers exist.', 'layers'),
          c.providers?.providersThrottleDuration ? rows(row('Throttle', mono(prettyDur(c.providers.providersThrottleDuration)), { key: 'providersThrottleDuration', help: 'Changes from a provider are applied at most this often.' })) : null),
        { count: prov.length }));

      const res = Object.entries(c.certificatesResolvers ?? {});
      out.push(section('resolvers', 'Certificate resolvers', 'cert', 'How Traefik gets certificates on its own (ACME, Tailscale).',
        res.length ? h('div', { class: 'tl-prov-grid' }, ...res.map(([k, v]) => resolverCard(k, v)))
          : off('No resolver: certificates come from files (tls.certificates) or Traefik\'s default certificate.', { label: 'Static config', lang: 'yaml', code: ['certificatesResolvers:', '  letsencrypt:', '    acme:', '      email: you@example.com', '      storage: /letsencrypt/acme.json', '      httpChallenge:', '        entryPoint: web'].join('\n') }),
        { count: res.length }));

      const api = c.api;
      out.push(section('api', 'API & dashboard', 'code', 'The API Enodia reads, and Traefik\'s own dashboard.',
        api ? rows(
          row('Insecure mode', api.insecure ? pill('on', 'warn') : pill('off', 'ok'), { key: 'insecure', help: api.insecure ? 'Served on the "traefik" entry point (:8080) without authentication. Fine while that port is not published.' : 'Reach it through a router to api@internal, with an auth middleware.', tone: api.insecure ? 'warn' : '' }),
          row('Dashboard', onOff(api.dashboard !== false), { key: 'dashboard' }),
          api.debug !== undefined ? row('Debug endpoints', api.debug ? pill('on', 'warn') : pill('off', ''), { key: 'debug', help: api.debug ? 'Serves Go profiling under /debug: keep it private.' : '', tone: api.debug ? 'warn' : '' }) : null,
          api.basePath ? row('Base path', mono(api.basePath), { key: 'basePath' }) : null,
          ...genericRows(Object.fromEntries(Object.entries(api).filter(([k]) => !['insecure', 'dashboard', 'debug', 'basePath'].includes(k))))) : off('The API is off. Enodia needs it.'),
        { tools: [c.ping ? h('span', { class: 'badge ok' }, 'ping on') : null].filter(Boolean) }));

      const m = c.metrics ?? {};
      const p = m.prometheus;
      out.push(section('metrics', 'Metrics', 'traffic', 'What Traefik measures, and where it sends it. Enodia reads the Prometheus endpoint.',
        Object.keys(m).length ? rows(
          p ? [
            row('Prometheus', pill('on', 'ok'), { key: 'prometheus', help: `Served on entry point ${p.entryPoint ?? 'traefik'}${p.manualRouting ? ', routed by hand (manualRouting)' : ''}.` }),
            row('Per entry point', onOff(p.addEntryPointsLabels !== false), { key: 'addEntryPointsLabels' }),
            row('Per router', onOff(Boolean(p.addRoutersLabels), { offTone: 'warn' }), { key: 'addRoutersLabels', help: p.addRoutersLabels ? '' : 'Enodia shows traffic per router only with this on.', tone: p.addRoutersLabels ? '' : 'warn' }),
            row('Per service', onOff(p.addServicesLabels !== false), { key: 'addServicesLabels' }),
            p.buckets ? row('Latency buckets', chips(p.buckets.map((b) => `${b}s`)), { key: 'buckets', help: 'Percentiles are estimated between these bounds.' }) : null,
            ...genericRows(Object.fromEntries(Object.entries(p).filter(([k]) => !['entryPoint', 'addEntryPointsLabels', 'addRoutersLabels', 'addServicesLabels', 'buckets', 'manualRouting'].includes(k)))).map((r) => r),
          ] : null,
          ...Object.entries(m).filter(([k]) => k !== 'prometheus').flatMap(([k, v]) => (isObj(v) ? [row(humanize(k), pill('on', 'ok'), { key: k }), ...genericRows(v).map((r) => { r.classList.add('tl-sub'); return r; })] : [row(humanize(k), value(k, v), { key: k })]))) :
          off('No metrics: Enodia\'s live traffic needs Prometheus.', { label: 'Static config', lang: 'yaml', code: ['metrics:', '  prometheus:', '    addRoutersLabels: true'].join('\n') }),
        { count: Object.keys(m).filter((k) => isObj(m[k])).length }));

      const t = c.tracing;
      out.push(section('tracing', 'Tracing', 'activity', 'Distributed traces of every request (OpenTelemetry).',
        t ? rows(
          t.sampleRate !== undefined ? row('Sample rate', mono(`${Math.round(t.sampleRate * 100)}%`), { key: 'sampleRate', help: 'The share of requests that get a trace.' }) : null,
          ...genericRows(Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'sampleRate')))) : off('No tracing.')));

      const lg = c.log ?? {};
      const al = c.accessLog;
      const level = (lg.level ?? 'ERROR').toUpperCase();
      out.push(section('logs', 'Logs', 'logs', 'Traefik\'s own log, and the access log of every request.',
        h('div', { class: 'tl-prov-grid' },
          h('div', { class: 'tl-prov tl-row' },
            h('div', { class: 'tl-prov-head' }, h('span', { class: 'tl-prov-ic' }, ticon('terminal', { size: 16 })), h('div', { class: 'grow' }, h('div', { class: 'bold' }, 'Traefik log'), h('div', { class: 'small muted' }, 'What Traefik itself says.'))),
            rows(
              row('Level', pill(level, level === 'DEBUG' || level === 'TRACE' ? 'warn' : level === 'ERROR' ? '' : 'info'), { key: 'log.level', help: level === 'DEBUG' || level === 'TRACE' ? 'Very verbose: fine while debugging, costly in production.' : lg.level ? '' : 'The default.' }),
              row('Format', mono(lg.format ?? 'common'), { key: 'log.format' }),
              row('Written to', lg.filePath ? str(lg.filePath) : mono('stdout'), { key: 'log.filePath' }),
              ...genericRows(Object.fromEntries(Object.entries(lg).filter(([k]) => !['level', 'format', 'filePath'].includes(k)))))),
          h('div', { class: 'tl-prov tl-row' },
            h('div', { class: 'tl-prov-head' }, h('span', { class: 'tl-prov-ic' }, ticon('list', { size: 16 })), h('div', { class: 'grow' }, h('div', { class: 'bold' }, 'Access log'), h('div', { class: 'small muted' }, 'One line per request. Enodia\'s log explorer reads it.')), al ? pill('on', 'ok') : pill('off', 'warn')),
            al ? rows(
              row('Format', al.format === 'json' ? pill('json', 'ok') : pill(al.format ?? 'common', 'warn'), { key: 'accessLog.format', help: al.format === 'json' ? 'Enodia gets router, service and timings from it.' : 'Enodia needs format: json to show routers, services and timings.', tone: al.format === 'json' ? '' : 'warn' }),
              row('Written to', al.filePath ? str(al.filePath) : mono('stdout'), { key: 'accessLog.filePath', help: al.filePath ? 'Mount this file into Enodia read-only and set TRAEFIK_ACCESS_LOG.' : 'Enodia can only read a file.' }),
              al.bufferingSize ? row('Buffer', mono(`${al.bufferingSize} lines`), { key: 'accessLog.bufferingSize' }) : null,
              al.filters && Object.keys(al.filters).length ? row('Only logs', h('span', { class: 'tl-vchips' }, al.filters.statusCodes ? chips(al.filters.statusCodes.map((x) => `status ${x}`)) : null, al.filters.retryAttempts ? h('code', { class: 'tl-vchip' }, 'retried') : null, al.filters.minDuration ? h('code', { class: 'tl-vchip' }, `slower than ${prettyDur(al.filters.minDuration)}`) : null), { key: 'accessLog.filters' }) : row('Only logs', none('everything'), { key: 'accessLog.filters' }),
              al.fields ? row('Fields', h('span', {}, `default ${al.fields.defaultMode ?? 'keep'}`, al.fields.headers ? ` · headers ${al.fields.headers.defaultMode ?? 'drop'}${al.fields.headers.names ? ` (${Object.entries(al.fields.headers.names).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}` : ''), { key: 'accessLog.fields' }) : null) :
              off('No access log.', { label: 'Static config', lang: 'yaml', code: ['accessLog:', '  filePath: /logs/access.log', '  format: json'].join('\n') })))));

      const sts = c.serversTransport;
      const tcpSts = c.tcpServersTransport;
      if (sts || tcpSts) {
        out.push(section('transports', 'Servers transports', 'server', 'How Traefik talks to your backends by default.',
          h('div', { class: 'tl-prov-grid' },
            sts ? h('div', { class: 'tl-prov tl-row' }, h('div', { class: 'tl-prov-head' }, h('span', { class: 'tl-prov-ic' }, ticon('globe', { size: 16 })), h('div', { class: 'grow' }, h('div', { class: 'bold' }, 'HTTP'), h('div', { class: 'small muted' }, 'serversTransport'))),
              rows(
                row('Verify backend certificates', sts.insecureSkipVerify ? pill('no', 'warn') : pill('yes', 'ok'), { key: 'insecureSkipVerify', help: sts.insecureSkipVerify ? 'Any certificate is accepted from HTTPS backends.' : '', tone: sts.insecureSkipVerify ? 'warn' : '' }),
                row('Idle connections per host', mono(sts.maxIdleConnsPerHost ?? 2), { key: 'maxIdleConnsPerHost' }),
                sts.forwardingTimeouts ? row('Timeouts', h('span', { class: 'tl-timeouts' }, h('span', {}, 'dial ', dur(sts.forwardingTimeouts.dialTimeout)), h('span', {}, 'response ', dur(sts.forwardingTimeouts.responseHeaderTimeout)), h('span', {}, 'idle ', dur(sts.forwardingTimeouts.idleConnTimeout))), { key: 'forwardingTimeouts' }) : null,
                sts.rootCAs?.length ? row('Root CAs', mono(`${sts.rootCAs.length} file${sts.rootCAs.length === 1 ? '' : 's'}`), { key: 'rootCAs' }) : null,
                ...genericRows(Object.fromEntries(Object.entries(sts).filter(([k]) => !['insecureSkipVerify', 'maxIdleConnsPerHost', 'forwardingTimeouts', 'rootCAs'].includes(k)))))) : null,
            tcpSts ? h('div', { class: 'tl-prov tl-row' }, h('div', { class: 'tl-prov-head' }, h('span', { class: 'tl-prov-ic' }, ticon('tcp', { size: 16 })), h('div', { class: 'grow' }, h('div', { class: 'bold' }, 'TCP'), h('div', { class: 'small muted' }, 'tcpServersTransport'))),
              rows(genericRows(tcpSts))) : null)));
      }

      const exp = c.experimental;
      if (exp && Object.keys(exp).length) {
        const plugins = Object.entries(exp.plugins ?? {});
        const local = Object.entries(exp.localPlugins ?? {});
        out.push(section('plugins', 'Experimental & plugins', 'plug', 'Plugins from the catalog or from disk, and features still in the oven.',
          h('div', { class: 'col' },
            plugins.length || local.length ? h('div', { class: 'tl-plugins' }, ...[...plugins.map(([n, v]) => [n, v, 'catalog']), ...local.map(([n, v]) => [n, v, 'local'])].map(([n, v, where]) => {
              const card = h('div', { class: 'tl-plugin tl-row' }, h('span', { class: 'tl-prov-ic' }, ticon('plug', { size: 15 })), h('div', { class: 'grow', style: { minWidth: '0' } }, h('div', { class: 'bold' }, n), h('code', { class: 'small muted ellipsis', style: { display: 'block' } }, v.moduleName ?? '')), v.version ? h('span', { class: 'badge violet' }, v.version) : h('span', { class: 'badge' }, where));
              card.dataset.q = card.textContent.toLowerCase();
              return card;
            })) : null,
            rows(genericRows(Object.fromEntries(Object.entries(exp).filter(([k]) => !['plugins', 'localPlugins'].includes(k))))))));
      }

      const g = c.global ?? {};
      const known = ['global', 'serversTransport', 'tcpServersTransport', 'entryPoints', 'providers', 'api', 'metrics', 'ping', 'log', 'accessLog', 'tracing', 'certificatesResolvers', 'experimental'];
      const rest = Object.fromEntries(Object.entries(c).filter(([k]) => !known.includes(k)));
      out.push(section('global', 'Global & other settings', 'globe', 'Version checks, anonymous usage, ping and the rest.',
        rows(
          row('Check for new versions', onOff(Boolean(g.checkNewVersion)), { key: 'global.checkNewVersion' }),
          row('Send anonymous usage', onOff(Boolean(g.sendAnonymousUsage), { onTone: 'info' }), { key: 'global.sendAnonymousUsage' }),
          c.ping ? row('Ping', h('span', {}, pill('on', 'ok'), ' ', h('span', { class: 'muted small' }, `on entry point ${c.ping.entryPoint ?? 'traefik'}, answers ${c.ping.terminatingStatusCode ?? 503} while stopping`)), { key: 'ping' }) : row('Ping', pill('off'), { key: 'ping' }),
          ...genericRows(rest))));
      return out;
    }

    let lastAt = store.state?.staticAt ?? null;
    paint();
    return {
      el,
      update(event) {
        if (event !== 'state') return;
        // the static configuration changes only on a restart; repaint when it shows up or changes
        const at = store.state?.staticAt ?? null;
        if (at !== lastAt) { lastAt = at; if (tab === 'raw' && raw && store.state?.static) raw.set(store.state.static); else paintBody(); }
      },
    };
  },
};
