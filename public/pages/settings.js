// Setup & about: what Enodia is connected to, which features are on and how to turn on the rest,
// how to put it next to Traefik, updates, shortcuts, the theme, and where the name comes from.
import { h, icon, brandMark } from '../lib/dom.js';
import { store, api } from '../lib/store.js';
import { pageHead, timeAgo, toast } from '../lib/components.js';
import { ms, plural } from '../lib/format.js';
import { codeBlock, ticon } from '../lib/tools-ui.js';

const REPO_URL = 'https://github.com/georgemos940/enodia-traefik';
const DOCS = 'https://doc.traefik.io/traefik/';
const INSTALL_SH = 'https://raw.githubusercontent.com/georgemos940/enodia-traefik/main/install.sh';

const yaml = (...l) => l.join('\n');

// how to update, per install method
const UPDATE_STEPS = {
  script: [{ label: 'Installer', lang: 'sh', code: `curl -fsSL ${INSTALL_SH} | bash -s -- update` }],
  docker: [
    { label: 'Docker Compose', lang: 'sh', code: 'docker compose pull enodia && docker compose up -d enodia' },
    { label: 'docker run', lang: 'sh', code: 'docker pull ghcr.io/georgemos940/enodia:latest\n# then start it again with the same options' },
  ],
  source: [{ label: 'Git checkout', lang: 'sh', code: 'git pull --ff-only && npm start' }],
  kubernetes: [{ label: 'Kubernetes', lang: 'sh', code: 'kubectl -n traefik rollout restart deployment/enodia' }],
};
const INSTALL_NAME = { script: 'the installer', docker: 'Docker', source: 'a git checkout', kubernetes: 'Kubernetes', unknown: 'an unknown method' };

const ENV = [
  ['TRAEFIK_API_URL', 'http://traefik:8080', 'The Traefik API entry point.'],
  ['TRAEFIK_METRICS_URL', 'auto', 'Prometheus metrics. auto finds them; off turns live traffic off.'],
  ['TRAEFIK_ACCESS_LOG', 'auto', 'The JSON access log, mounted read-only. auto uses the path in Traefik\'s static config; off turns the log explorer off.'],
  ['TRAEFIK_API_USERNAME', '', 'Basic auth in front of the API (with TRAEFIK_API_PASSWORD).'],
  ['TRAEFIK_API_HEADERS', '{}', 'Extra headers for the API, as JSON.'],
  ['TRAEFIK_TIMEOUT_MS', '5000', 'Timeout of each call to Traefik.'],
  ['TRAEFIK_INSECURE_TLS', 'false', 'Accept a self-signed certificate on the API.'],
  ['ENODIA_PASSWORD', '', 'Turns on the built-in login.'],
  ['ENODIA_TRUST_HEADER', '', 'Trust the user header a forward-auth proxy sets, e.g. Remote-User.'],
  ['ENODIA_SESSION_HOURS', '12', 'How long a login lasts.'],
  ['ENODIA_SECRET', 'random', 'Signs sessions; set it and logins survive restarts.'],
  ['ENODIA_DATA_DIR', '/data (image)', 'Keeps the change history across restarts.'],
  ['ENODIA_POLL_SECONDS', '5', 'How often Traefik is polled.'],
  ['ENODIA_HISTORY_MINUTES', '60', 'Traffic history kept in memory.'],
  ['ENODIA_LOG_KEEP', '10000', 'Access log lines kept in memory.'],
  ['ENODIA_CERT_WARN_DAYS', '21', 'Days before expiry a certificate is a warning (ENODIA_CERT_CRITICAL_DAYS: 7).'],
  ['ENODIA_WEBHOOK_URL', '', 'Discord, Slack or any JSON receiver, told about new critical findings and attacks.'],
  ['ENODIA_ATTACK_RPS', 'auto', 'Requests a second that always count as an attack; by default worked out from normal traffic.'],
  ['ENODIA_ATTACK_ALERTS', 'true', 'Send attacks starting and ending to the webhook.'],
  ['CROWDSEC_LAPI_URL', '', "CrowdSec's Local API, e.g. http://crowdsec:8080, for the bans on the Shield page."],
  ['CROWDSEC_BOUNCER_KEY', '', "A bouncer key of Enodia's own: cscli bouncers add enodia. It can only read decisions."],
  ['ENODIA_INSTANCE_NAME', '', 'A name for this Traefik in the header.'],
  ['ENODIA_BASE_PATH', '', 'Serve Enodia under a path, e.g. /enodia.'],
  ['ENODIA_UPDATE_CHECK', 'true', 'Look for new Enodia and Traefik releases.'],
  ['PORT', '3000', 'Where Enodia listens (HOST: 0.0.0.0).'],
];

const SHORTCUTS = [
  ['Ctrl K', 'Search everything'], ['/', 'Filter the current list'], ['?', 'All shortcuts'],
  ['g o', 'Overview'], ['g r', 'Routers'], ['g s', 'Services'], ['g m', 'Middlewares'], ['g e', 'Entry points'], ['g p', 'Topology'],
  ['g t', 'Live traffic'], ['g l', 'Access log'], ['g c', 'Certificates'], ['g h', 'Health checks'], ['g x', 'Change history'],
];

function compose(variant) {
  const auth = {
    basic: [
      '      - traefik.http.middlewares.enodia-auth.basicauth.users=admin:$$2y$$05$$paste-htpasswd-output-here',
      '      - traefik.http.routers.enodia.middlewares=enodia-auth',
    ],
    forward: [
      '      - traefik.http.middlewares.enodia-sso.forwardauth.address=http://authelia:9091/api/authz/forward-auth',
      '      - traefik.http.middlewares.enodia-sso.forwardauth.authResponseHeaders=Remote-User',
      '      - traefik.http.routers.enodia.middlewares=enodia-sso',
    ],
    password: [],
  }[variant];
  const env = {
    basic: [],
    forward: ['      ENODIA_TRUST_HEADER: Remote-User'],
    password: ['      ENODIA_PASSWORD_FILE: /run/secrets/enodia_password'],
  }[variant];
  return yaml(
    'services:',
    '  enodia:',
    '    image: ghcr.io/georgemos940/enodia:latest',
    '    restart: unless-stopped',
    '    environment:',
    '      TRAEFIK_API_URL: http://traefik:8080',
    '      TRAEFIK_ACCESS_LOG: /logs/access.log',
    ...env,
    '    volumes:',
    '      - traefik-logs:/logs:ro',
    '      - enodia-data:/data',
    ...(variant === 'password' ? ['    secrets: [enodia_password]'] : []),
    '    labels:',
    '      - traefik.enable=true',
    '      - traefik.http.routers.enodia.rule=Host(`enodia.example.com`)',
    '      - traefik.http.routers.enodia.entrypoints=websecure',
    '      - traefik.http.routers.enodia.tls=true',
    '      - traefik.http.services.enodia.loadbalancer.server.port=3000',
    ...auth,
    '',
    'volumes:',
    '  traefik-logs:',
    '  enodia-data:',
    ...(variant === 'password' ? ['', 'secrets:', '  enodia_password:', '    file: ./enodia_password.txt'] : []));
}

export default {
  render(ctx) {
    ctx.setCrumbs([['Setup & about']]);
    const el = h('div', { class: 'col gap-lg tl-page' });
    let metricsInfo = null;
    let logsInfo = null;
    let checking = false;
    const offs = [];

    const hero = h('section', { class: 'card glow tl-about-hero' });
    const updatesBox = h('section', { class: 'card tl-set-card' });
    const statusGrid = h('div', { class: 'tl-status-grid' });
    const valuesBox = h('div');

    function paintHero() {
      const m = store.meta ?? {};
      const st = store.state;
      const v = st?.version;
      hero.replaceChildren(
        h('div', { class: 'tl-about-mark' }, brandMark('brand-mark tl-brand'), h('span', { class: 'tl-glow l' }), h('span', { class: 'tl-glow r' })),
        h('div', { class: 'tl-about-main' },
          h('div', { class: 'row wrap', style: { gap: '10px' } }, h('h2', {}, 'Enodia'), h('span', { class: 'badge torch' }, `v${m.version ?? '?'}`), m.instanceName ? h('span', { class: 'badge violet' }, m.instanceName) : null),
          h('p', { class: 'muted' }, 'A fast, friendly dashboard for Traefik: routes, services, live traffic, access logs, certificates and health checks. One small container, no database.'),
          h('div', { class: 'tl-conn' },
            h('span', { class: `dot ${st?.ok ? 'ok pulse' : 'bad pulse'}` }),
            st?.ok ? h('span', {}, 'Connected to ', h('b', {}, `Traefik ${v?.Version ?? ''}`), v?.Codename ? h('span', { class: 'muted' }, ` (${v.Codename})`) : null, ' at ', h('code', {}, m.traefikApi ?? '')) : h('span', {}, 'Cannot reach Traefik at ', h('code', {}, m.traefikApi ?? ''), st?.error ? h('span', { class: 'bad-text' }, ` · ${st.error}`) : null)),
          h('div', { class: 'row wrap', style: { gap: '8px', marginTop: '6px' } },
            h('a', { class: 'btn sm', href: REPO_URL, target: '_blank', rel: 'noreferrer' }, icon('github', { size: 14 }), 'GitHub'),
            h('a', { class: 'btn sm', href: `${REPO_URL}/issues`, target: '_blank', rel: 'noreferrer' }, icon('bell', { size: 14 }), 'Report an issue'),
            h('a', { class: 'btn sm ghost', href: DOCS, target: '_blank', rel: 'noreferrer' }, ticon('book', { size: 14 }), 'Traefik docs', icon('external', { size: 12 })))));
    }

    function paintUpdates() {
      const u = store.meta?.updates;
      const method = store.meta?.install ?? u?.installMethod ?? 'unknown';
      const check = h('button', { type: 'button', class: `btn sm ${checking ? 'tl-busy' : ''}`.trim(), disabled: checking || u?.enabled === false, onclick: checkNow }, ticon('refresh', { size: 14, cls: checking ? 'spin' : '' }), checking ? 'Checking…' : 'Check now');
      const head = h('div', { class: 'card-head' }, h('div', { class: 'grow' }, h('div', { class: 'card-title' }, ticon('download', { size: 15 }), 'Updates'), h('div', { class: 'card-sub' }, u?.checkedAt ? ['Checked ', timeAgo(u.checkedAt)] : 'Not checked yet')), check);
      if (!u || u.enabled === false) {
        updatesBox.replaceChildren(head, h('div', { class: 'card-body' }, h('p', { class: 'muted small', style: { margin: 0 } }, 'Update checks are off (ENODIA_UPDATE_CHECK=false). Enodia does not call out to GitHub.')));
        return;
      }
      const line = (name, cur, info, kind) => {
        const newer = info?.newer;
        return h('div', { class: `tl-upd ${newer ? 'newer' : ''}`.trim() },
          h('span', { class: `tl-upd-ic ${kind}` }, kind === 'enodia' ? brandMark('tl-upd-mark') : ticon('route', { size: 15 })),
          h('div', { class: 'grow', style: { minWidth: '0' } },
            h('div', { class: 'bold' }, name, ' ', h('span', { class: 'tl-mono' }, cur ? `v${String(cur).replace(/^v/, '')}` : '—')),
            h('div', { class: 'small muted' }, newer ? ['Latest is ', h('b', { class: 'torch-text' }, `v${String(info.latest).replace(/^v/, '')}`), info.publishedAt ? [', released ', timeAgo(info.publishedAt)] : null]
              : info?.latest ? 'Up to date' : 'No release published yet')),
          newer && info.url ? h('a', { class: 'btn sm', href: info.url, target: '_blank', rel: 'noreferrer' }, 'Release notes', icon('external', { size: 12 })) : newer ? null : h('span', { class: 'tl-pill ok' }, h('i'), 'current'));
      };
      const steps = UPDATE_STEPS[method] ?? [...UPDATE_STEPS.script, ...UPDATE_STEPS.docker];
      updatesBox.replaceChildren(head, h('div', { class: 'card-body col', style: { gap: '10px' } },
        line('Enodia', u.enodia?.current ?? store.meta?.version, u.enodia, 'enodia'),
        line('Traefik', u.traefik?.current ?? store.state?.version?.Version, u.traefik, 'traefik'),
        u.error ? h('div', { class: 'small bad-text' }, `Last check failed: ${u.error}`) : null,
        h('div', { class: 'tl-mini-label', style: { marginTop: '4px' } }, `Installed with ${INSTALL_NAME[method] ?? method}: to update`),
        codeBlock(steps, { compact: true }),
        h('div', { class: 'tiny muted' }, 'Settings, history and the password stay: they live in the environment and the data volume, not in the image.')));
    }

    async function checkNow() {
      checking = true; paintUpdates();
      try {
        const u = await api('update?check=1');
        if (store.meta) store.meta.updates = u;
        toast(u?.enodia?.newer ? `Enodia ${u.enodia.latest} is available` : 'Enodia is up to date');
      } catch (e) { toast(`Update check failed: ${e.message}`, 'bad'); }
      checking = false; paintUpdates();
    }

    function feature({ title, ic, on, tone, state, about, detail = [], how = null, howTitle = 'Turn it on' }) {
      const t = tone ?? (on ? 'ok' : 'off');
      const body = how ? h('div', { class: 'tl-how', hidden: true }, how) : null;
      const btn = how ? h('button', { type: 'button', class: 'btn sm ghost tl-how-btn', onclick: () => { body.hidden = !body.hidden; btn.classList.toggle('open', !body.hidden); } }, howTitle, icon('down', { size: 13 })) : null;
      if (how) offs.push(() => { body.hidden = false; btn.classList.add('open'); });
      return h('div', { class: `tl-feat ${t}` },
        h('div', { class: 'tl-feat-head' },
          h('span', { class: 'tl-feat-ic' }, ticon(ic, { size: 16 })),
          h('div', { class: 'grow', style: { minWidth: '0' } }, h('div', { class: 'tl-feat-title' }, title), h('div', { class: 'small muted' }, about)),
          h('span', { class: `tl-light ${t}` }, h('i'), state)),
        detail.length ? h('div', { class: 'tl-feat-detail' }, ...detail.filter(Boolean)) : null,
        btn, body);
    }

    function paintStatus() {
      const m = store.meta ?? {};
      const f = m.features ?? {};
      const st = store.state;
      const sc = st?.static;
      const prom = sc?.metrics?.prometheus;
      offs.length = 0;
      const d = (k, v) => h('div', { class: 'tl-fd' }, h('span', { class: 'muted' }, k), h('span', { class: 'tl-fd-v' }, v));
      const cards = [
        feature({
          title: 'Traefik API', ic: 'route', on: st?.ok, tone: st?.ok ? 'ok' : 'bad', state: st?.ok ? 'Connected' : 'Unreachable',
          about: 'Routers, services, middlewares and entry points, polled.',
          detail: [d('URL', h('code', {}, m.traefikApi ?? '')), d('Poll', `every ${m.pollSeconds ?? 5} s`), st?.apiMs !== null && st?.apiMs !== undefined ? d('Last poll', [ms(st.apiMs), ' · ', timeAgo(st.fetchedAt)]) : null, !st?.ok && st?.error ? d('Error', h('span', { class: 'bad-text' }, st.error)) : null],
          how: st?.ok ? null : codeBlock([
            { label: 'Environment', lang: 'env', code: yaml('# the API entry point, reachable from the Enodia container', 'TRAEFIK_API_URL=http://traefik:8080', '# if the API sits behind basic auth', 'TRAEFIK_API_USERNAME=admin', 'TRAEFIK_API_PASSWORD_FILE=/run/secrets/traefik_api_password') },
            { label: 'Traefik static', lang: 'yaml', code: yaml('api:', '  insecure: true   # the API on :8080 inside the Docker network; do not publish the port') },
          ]), howTitle: 'How to fix',
        }),
        feature({
          title: 'Live traffic', ic: 'traffic', on: f.metrics && metricsInfo?.ok !== false, tone: !f.metrics ? 'off' : metricsInfo?.ok === false ? 'bad' : 'ok', state: !f.metrics ? 'Off' : metricsInfo?.ok === false ? 'Error' : 'On',
          about: 'Requests, errors, latency and bandwidth from Prometheus metrics.',
          detail: [metricsInfo?.scrapedAt ? d('Last scrape', timeAgo(metricsInfo.scrapedAt)) : null, metricsInfo?.error ? d('Error', h('span', { class: 'bad-text' }, metricsInfo.error)) : null, d('Kept', `${m.historyMinutes ?? 60} minutes in memory`)],
          how: f.metrics && metricsInfo?.ok !== false ? null : codeBlock([
            { label: 'Traefik static', lang: 'yaml', code: yaml('metrics:', '  prometheus:', '    entryPoint: traefik     # next to the API on :8080', '    addRoutersLabels: true') },
            { label: 'CLI flags', lang: 'sh', code: yaml('--metrics.prometheus=true', '--metrics.prometheus.entryPoint=traefik', '--metrics.prometheus.addRoutersLabels=true') },
            { label: 'Environment', lang: 'env', code: yaml('# Enodia finds the metrics on its own; set this only if they live elsewhere', 'TRAEFIK_METRICS_URL=http://traefik:8080/metrics') },
          ]),
        }),
        feature({
          title: 'Traffic per router', ic: 'router', on: Boolean(prom?.addRoutersLabels), tone: !sc ? 'off' : prom?.addRoutersLabels ? 'ok' : 'warn', state: !sc ? 'Unknown' : prom?.addRoutersLabels ? 'On' : 'Off',
          about: 'Traefik labels its metrics with the router, so every router gets its own numbers.',
          how: prom?.addRoutersLabels ? null : codeBlock([
            { label: 'Traefik static', lang: 'yaml', code: yaml('metrics:', '  prometheus:', '    addRoutersLabels: true') },
            { label: 'CLI flags', lang: 'sh', code: '--metrics.prometheus.addRoutersLabels=true' },
          ]),
        }),
        feature({
          title: 'Access log', ic: 'logs', on: f.logs && logsInfo?.ok !== false, tone: !f.logs ? 'off' : logsInfo?.ok === false ? 'bad' : 'ok', state: !f.logs ? 'Off' : logsInfo?.ok === false ? 'Error' : 'On',
          about: 'Every request with its router, status and timing, searchable.',
          detail: [logsInfo?.format ? d('Format', logsInfo.format === 'json' ? 'JSON' : h('span', { class: 'warn-text' }, `${logsInfo.format}: switch Traefik to JSON for routers and timings`)) : null, logsInfo?.count ? d('In memory', plural(logsInfo.count, 'line')) : null, logsInfo?.error ? d('Error', h('span', { class: 'bad-text' }, logsInfo.error)) : null],
          how: f.logs && logsInfo?.ok !== false ? null : codeBlock([
            { label: 'Traefik static', lang: 'yaml', code: yaml('accessLog:', '  filePath: /logs/access.log', '  format: json') },
            { label: 'Docker compose', lang: 'yaml', code: yaml('services:', '  traefik:', '    volumes:', '      - traefik-logs:/logs', '  enodia:', '    environment:', '      TRAEFIK_ACCESS_LOG: /logs/access.log', '    volumes:', '      - traefik-logs:/logs:ro', 'volumes:', '  traefik-logs:') },
          ]),
        }),
        feature({
          title: 'Change history on disk', ic: 'history', on: f.persistentHistory, state: f.persistentHistory ? 'On' : 'Memory only',
          tone: f.persistentHistory ? 'ok' : 'warn',
          about: 'Every configuration change, kept across restarts.',
          how: f.persistentHistory ? null : codeBlock([
            { label: 'Docker compose', lang: 'yaml', code: yaml('services:', '  enodia:', '    environment:', '      ENODIA_DATA_DIR: /data   # already set in the official image', '    volumes:', '      - enodia-data:/data', 'volumes:', '  enodia-data:') },
            { label: 'Environment', lang: 'env', code: 'ENODIA_DATA_DIR=/var/lib/enodia' },
          ]),
        }),
        feature({
          title: 'Alerts', ic: 'bell', on: f.webhook, state: f.webhook ? 'On' : 'Off',
          about: 'New critical findings sent to Discord, Slack or any JSON webhook.',
          how: f.webhook ? null : codeBlock([{ label: 'Environment', lang: 'env', code: yaml('ENODIA_WEBHOOK_URL=https://discord.com/api/webhooks/…', '# or keep the URL in a secret file', 'ENODIA_WEBHOOK_URL_FILE=/run/secrets/enodia_webhook') }]),
        }),
        feature({
          title: 'Login', ic: 'lock', on: m.auth !== 'none', tone: m.auth === 'none' ? 'warn' : 'ok',
          state: m.auth === 'password' ? 'Password' : m.auth === 'header' ? 'Forward auth' : 'Open',
          about: m.auth === 'password' ? 'Enodia asks for its own password.' : m.auth === 'header' ? 'A proxy in front signs people in; Enodia trusts its header.' : 'Enodia trusts whatever is in front of it. Fine when Traefik guards the route.',
          how: m.auth === 'none' ? codeBlock([
            { label: 'Password', lang: 'env', code: yaml('ENODIA_PASSWORD_FILE=/run/secrets/enodia_password', '# or plainly: ENODIA_PASSWORD=a-long-password', 'ENODIA_SECRET=another-long-random-string   # logins survive restarts') },
            { label: 'Forward auth', lang: 'env', code: yaml('# Authelia, Authentik or oauth2-proxy in front, passing the user on', 'ENODIA_TRUST_HEADER=Remote-User') },
            { label: 'Traefik basicAuth', lang: 'labels', code: yaml('- "traefik.http.middlewares.enodia-auth.basicauth.users=admin:$$2y$$05$$paste-htpasswd-output-here"', '- "traefik.http.routers.enodia.middlewares=enodia-auth"') },
          ]) : null, howTitle: 'Protect it',
        }),
        feature({
          title: 'Static configuration', ic: 'config', on: Boolean(sc), tone: sc ? 'ok' : 'warn', state: sc ? 'Read' : 'Not available',
          about: 'Entry points, providers and resolvers from Traefik\'s support dump.',
          detail: [sc && st.staticAt ? d('Read', timeAgo(st.staticAt)) : null, !sc ? d('Why', 'This Traefik does not serve /api/support-dump, or a proxy blocks it.') : null],
        }),
        feature({
          title: 'Update checks', ic: 'download', on: f.updateCheck !== false, state: f.updateCheck !== false ? 'On' : 'Off',
          about: 'Looks up the latest Enodia and Traefik releases on GitHub. Nothing about this install is sent.',
          how: null,
        }),
      ];
      statusGrid.replaceChildren(...cards);
    }

    function paintValues() {
      const m = store.meta ?? {};
      const rows = [
        ['Version', `v${m.version ?? '?'}`], ['Instance name', m.instanceName || h('span', { class: 'faint' }, 'not set')], ['Traefik API', h('code', {}, m.traefikApi ?? '')],
        ['Poll interval', `${m.pollSeconds ?? 5} s`], ['Traffic history', `${m.historyMinutes ?? 60} minutes`], ['Certificate warnings', `${m.certWarnDays ?? 21} days, critical at ${m.certCriticalDays ?? 7}`],
        ['Login', m.auth ?? 'none'], ['Installed with', INSTALL_NAME[m.install] ?? m.install ?? 'unknown'],
      ];
      const envTable = h('div', { class: 'tl-env', hidden: true },
        h('div', { class: 'tl-env-note' }, ticon('key', { size: 14 }), h('span', {}, 'Every ENODIA_* and TRAEFIK_* variable also takes a ', h('code', {}, '_FILE'), ' suffix, for Docker and Kubernetes secrets: ', h('code', {}, 'ENODIA_PASSWORD_FILE=/run/secrets/enodia_password'), '.')),
        ...ENV.map(([k, def, what]) => h('div', { class: 'tl-env-row' }, h('code', { class: 'tl-env-k' }, k), h('span', { class: 'tl-env-d' }, def ? h('code', {}, def) : h('span', { class: 'faint' }, '—')), h('span', { class: 'tl-env-w' }, what))));
      const toggle = h('button', { type: 'button', class: 'btn sm ghost tl-how-btn', onclick: () => { envTable.hidden = !envTable.hidden; toggle.classList.toggle('open', !envTable.hidden); } }, 'Every environment variable', icon('down', { size: 13 }));
      valuesBox.replaceChildren(h('section', { class: 'card tl-set-card' },
        h('div', { class: 'card-head' }, h('div', { class: 'grow' }, h('div', { class: 'card-title' }, ticon('config', { size: 15 }), 'This Enodia'), h('div', { class: 'card-sub' }, 'Set through the environment; change them and restart the container.'))),
        h('div', { class: 'card-body col', style: { gap: '12px' } },
          h('dl', { class: 'kv tl-kv' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
          toggle, envTable)));
    }

    function guide() {
      const step = (n, title, text, block) => h('li', { class: 'tl-step' },
        h('span', { class: 'tl-step-n' }, String(n)),
        h('div', { class: 'tl-step-body' }, h('div', { class: 'tl-step-title' }, title), h('p', { class: 'muted small' }, text), block));
      return h('section', { class: 'card tl-set-card' },
        h('div', { class: 'card-head' }, h('div', { class: 'grow' }, h('div', { class: 'card-title' }, ticon('plug', { size: 15 }), 'Connect Enodia to Traefik'), h('div', { class: 'card-sub' }, 'Four steps in the Traefik you already run. Nothing here needs a database or an agent.'))),
        h('ol', { class: 'card-body tl-steps' },
          step(1, 'Open the API inside the Docker network', 'Enodia reads Traefik\'s API. api.insecure serves it on the internal "traefik" entry point (:8080); keep that port unpublished.', codeBlock([
            { label: 'traefik.yml', lang: 'yaml', code: yaml('api:', '  insecure: true', '  dashboard: true') },
            { label: 'CLI flags', lang: 'sh', code: yaml('--api.insecure=true', '--api.dashboard=true') },
          ], { compact: true })),
          step(2, 'Turn on Prometheus metrics, per router', 'Live traffic, error rates and latency come from here. With addRoutersLabels every router gets its own numbers.', codeBlock([
            { label: 'traefik.yml', lang: 'yaml', code: yaml('metrics:', '  prometheus:', '    entryPoint: traefik', '    addRoutersLabels: true', '    addServicesLabels: true') },
            { label: 'CLI flags', lang: 'sh', code: yaml('--metrics.prometheus=true', '--metrics.prometheus.entryPoint=traefik', '--metrics.prometheus.addRoutersLabels=true') },
          ], { compact: true })),
          step(3, 'Write the access log as JSON to a shared volume', 'Enodia tails it read-only for the log explorer and the slowest requests.', codeBlock([
            { label: 'traefik.yml', lang: 'yaml', code: yaml('accessLog:', '  filePath: /logs/access.log', '  format: json') },
            { label: 'CLI flags', lang: 'sh', code: yaml('--accesslog=true', '--accesslog.format=json', '--accesslog.filepath=/logs/access.log') },
          ], { compact: true })),
          step(4, 'Run Enodia behind Traefik, with a lock on the door', 'Same network as Traefik, the log volume read-only, history on its own volume. Pick how people sign in:', codeBlock([
            { label: 'basicAuth', lang: 'yaml', code: compose('basic') },
            { label: 'forwardAuth', lang: 'yaml', code: compose('forward') },
            { label: 'Built-in password', lang: 'yaml', code: compose('password') },
          ]))));
    }

    function shortcuts() {
      return h('section', { class: 'card tl-set-card' },
        h('div', { class: 'card-head' }, h('div', { class: 'grow' }, h('div', { class: 'card-title' }, ticon('keyboard', { size: 15 }), 'Keyboard shortcuts'))),
        h('div', { class: 'card-body tl-keys' }, ...SHORTCUTS.map(([k, v]) => h('div', { class: 'tl-key' }, h('span', { class: 'tl-kbds' }, ...k.split(' ').map((x) => h('span', { class: 'kbd' }, x))), h('span', {}, v)))));
    }

    function appearance() {
      const now = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
      const set = (v) => {
        if ((document.documentElement.dataset.theme === 'light' ? 'light' : 'dark') === v) return;
        // the top bar owns the theme; its button keeps everything in step
        document.querySelector('.topbar button[aria-label="Theme"]')?.click();
      };
      return h('section', { class: 'card tl-set-card' },
        h('div', { class: 'card-head' }, h('div', { class: 'grow' }, h('div', { class: 'card-title' }, ticon('sparkles', { size: 15 }), 'Appearance'), h('div', { class: 'card-sub' }, 'Night sky or daylight. Remembered in this browser.'))),
        h('div', { class: 'card-body tl-themes' },
          ...[['dark', 'Night', 'moon'], ['light', 'Day', 'sun']].map(([v, l, ic]) => h('button', { type: 'button', class: `tl-theme ${v} ${now === v ? 'on' : ''}`.trim(), onclick: () => set(v) },
            h('span', { class: 'tl-theme-art' }, h('i'), h('i'), h('i')), h('span', { class: 'row', style: { gap: '6px' } }, icon(ic, { size: 14 }), l)))));
    }

    function aboutName() {
      return h('section', { class: 'card tl-set-card tl-name' },
        h('div', { class: 'tl-name-art', 'aria-hidden': 'true' }, brandMark('brand-mark tl-brand big'), h('span', { class: 'tl-glow l' }), h('span', { class: 'tl-glow r' })),
        h('div', { class: 'card-body' },
          h('div', { class: 'tl-mini-label' }, 'About the name'),
          h('h3', {}, 'Enodia, ', h('span', { class: 'muted' }, 'Ἐνοδία, “of the road”')),
          h('p', {}, 'A Greek goddess of roads, crossroads and gateways, worshipped in Thessaly and later joined with Hecate. She was shown carrying two torches, and her shrines stood at city gates and in front of houses, where she watched who came and went.'),
          h('p', { class: 'muted' }, 'A reverse proxy stands in the same place: at the gate, where every request picks its road. Enodia holds the torch so you can see which way they went.'),
          h('div', { class: 'row wrap', style: { gap: '8px' } },
            h('a', { class: 'btn sm', href: REPO_URL, target: '_blank', rel: 'noreferrer' }, icon('github', { size: 14 }), 'georgemos940/enodia-traefik'),
            h('span', { class: 'tiny muted' }, 'MIT licensed. Not affiliated with Traefik Labs.'))));
    }

    function links() {
      const l = (href, label, sub) => h('a', { class: 'tl-link', href, target: '_blank', rel: 'noreferrer' }, h('div', { class: 'grow' }, h('div', { class: 'bold small' }, label), h('div', { class: 'tiny muted' }, sub)), icon('external', { size: 13 }));
      return h('section', { class: 'card tl-set-card' },
        h('div', { class: 'card-head' }, h('div', { class: 'grow' }, h('div', { class: 'card-title' }, ticon('book', { size: 15 }), 'Read more'))),
        h('div', { class: 'card-body tl-links' },
          l(REPO_URL, 'Enodia on GitHub', 'Code, issues, releases'),
          l(DOCS, 'Traefik documentation', 'doc.traefik.io'),
          l(`${DOCS}operations/api/`, 'Traefik API', 'What Enodia reads'),
          l(`${DOCS}observability/metrics/prometheus/`, 'Prometheus metrics', 'Live traffic'),
          l(`${DOCS}observability/access-logs/`, 'Access logs', 'The log explorer'),
          l(`${DOCS}middlewares/http/basicauth/`, 'BasicAuth middleware', 'Lock Enodia\'s route')));
    }

    const openAll = h('button', { type: 'button', class: 'btn sm', onclick: () => offs.forEach((f) => f()) }, ticon('wrench', { size: 14 }), 'Show every fix');
    el.append(
      pageHead({ title: 'Setup & about', icon: 'layers', sub: 'What Enodia is connected to, which features are on, and exactly how to turn on the rest.' }),
      hero,
      h('div', { class: 'tl-set-grid' },
        h('div', { class: 'col gap-lg tl-set-main' },
          h('section', { class: 'card tl-set-card' },
            h('div', { class: 'card-head' }, h('div', { class: 'grow' }, h('div', { class: 'card-title' }, ticon('power', { size: 15 }), 'Status'), h('div', { class: 'card-sub' }, 'Each feature, live. Anything off says how to turn it on.')), openAll),
            h('div', { class: 'card-body' }, statusGrid)),
          guide(),
          valuesBox),
        h('div', { class: 'col gap-lg tl-set-side' }, updatesBox, appearance(), shortcuts(), aboutName(), links())));

    paintHero(); paintUpdates(); paintStatus(); paintValues();
    Promise.all([api('metrics').catch(() => null), api('logs/stats').catch(() => null)]).then(([mt, lg]) => { metricsInfo = mt; logsInfo = lg; paintStatus(); });
    // the page is rebuilt on a theme switch without destroy(); drop the listener once it is gone
    const off = store.on('update', () => { if (!el.isConnected) { off(); return; } paintUpdates(); });

    let tick = 0;
    return {
      el,
      update(event) {
        if (event === 'state') { paintHero(); if (++tick % 6 === 0) paintStatus(); }
      },
      destroy() { off(); },
    };
  },
};
