// Findings: what is broken, what is about to break, and what is merely worth a look. Each one names
// the resource it is about and says what to do. Run after every poll and every scrape.
import { config } from './config.mjs';
import { state } from './traefik.mjs';
import { metrics, top } from './metrics.mjs';

const SEV = { critical: 3, warning: 2, info: 1 };
const hostsOf = (rule = '') => [...rule.matchAll(/Host(?:SNI)?\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/`([^`]*)`/g)].map((x) => x[1].toLowerCase()));
const mwType = new Map();

function finding(id, severity, title, detail, resource = null, fix = null) {
  return { id, severity, title, detail, resource, fix };
}

export function diagnose() {
  const out = [];
  if (!state.ok) {
    out.push(finding('api-unreachable', 'critical', 'Traefik API unreachable', state.error ?? 'No answer from the API.', null,
      'Check TRAEFIK_API_URL and that Enodia shares a network with Traefik. With api.insecure the API listens on the "traefik" entry point (:8080).'));
    return out;
  }
  mwType.clear();
  for (const m of state.http.middlewares) mwType.set(m.name, m.type);

  const staticCfg = state.static;
  // known only when the support dump answered; an empty list then means "none at all"
  const resolvers = staticCfg ? Object.keys(staticCfg.certificatesResolvers ?? {}) : null;
  const tlsEntrypoints = new Set(state.entrypoints.filter((e) => e.http?.tls).map((e) => e.name));

  // ── routers ─────────────────────────────────────────────────────────────────
  for (const proto of ['http', 'tcp', 'udp']) {
    for (const r of state[proto].routers) {
      const res = { kind: `${proto}-router`, name: r.name };
      if (r.status === 'disabled' || (r.error && r.error.length)) {
        out.push(finding(`router-error:${r.name}`, 'critical', `Router ${r.name} is not serving`, (r.error ?? []).join('; ') || 'Traefik disabled it.', res,
          'Fix the error above in the router\'s labels or file; Traefik retries on the next configuration change.'));
      } else if (r.status === 'warning') {
        out.push(finding(`router-warning:${r.name}`, 'warning', `Router ${r.name} has a warning`, (r.error ?? []).join('; ') || 'See the router.', res));
      }
      if (proto !== 'http' || r.provider === 'internal') continue;

      if (r.tls?.certResolver && resolvers && !resolvers.includes(r.tls.certResolver)) {
        out.push(finding(`resolver:${r.name}`, 'warning', `${r.name} asks for a certificate resolver that does not exist`,
          `It names "${r.tls.certResolver}"; this Traefik has ${resolvers.length ? resolvers.map((x) => `"${x}"`).join(', ') : 'none'}. It falls back to the default certificate and Traefik logs an error on every reload.`, res,
          `Remove tls.certresolver from the router, or point it at ${resolvers.length ? `"${resolvers[0]}"` : 'a resolver defined in the static configuration'}.`));
      }

      const mws = r.middlewares ?? [];
      const types = mws.map((m) => mwType.get(m) ?? mwType.get(`${m}@${r.provider}`));
      const isApi = r.service === 'api@internal' || r.service === 'dashboard@internal';
      if (isApi && !types.some((t) => ['basicauth', 'digestauth', 'forwardauth', 'ipallowlist', 'ipwhitelist'].includes(t))) {
        out.push(finding(`api-open:${r.name}`, 'critical', `The Traefik API is reachable through ${r.name} without any protection`,
          'Anyone who reaches this router can read your whole configuration.', res, 'Add a basicAuth, forwardAuth or ipAllowList middleware to it.'));
      }

      const onTls = r.tls || (r.entryPoints ?? []).some((e) => tlsEntrypoints.has(e));
      const redirects = types.some((t) => t === 'redirectscheme') || r.service === 'noop@internal';
      if (!onTls && !redirects && hostsOf(r.rule).length && !isApi) {
        const securedTwin = state.http.routers.find((o) => o !== r && o.tls && hostsOf(o.rule).some((h) => hostsOf(r.rule).includes(h)));
        if (securedTwin) {
          out.push(finding(`plain-http:${r.name}`, 'info', `${r.name} serves ${hostsOf(r.rule)[0]} over plain HTTP`,
            `${securedTwin.name} serves the same host over HTTPS, but this router answers on HTTP instead of redirecting.`, res,
            'Add a redirectScheme middleware (scheme: https) or an entry point redirection on web.'));
        }
      }
    }
  }

  // two routers that cannot be told apart: same rule, same priority, a shared entry point
  const seen = new Map();
  for (const r of state.http.routers) {
    if (r.provider === 'internal' || !r.rule) continue;
    for (const ep of r.entryPoints ?? []) {
      const k = `${ep}|${r.priority}|${r.rule.replace(/\s+/g, '')}`;
      if (seen.has(k) && seen.get(k) !== r.name) {
        out.push(finding(`duplicate:${r.name}`, 'warning', `${r.name} and ${seen.get(k)} have the same rule and priority`,
          `On entry point ${ep} Traefik cannot decide between them; which one answers is not defined.`, { kind: 'http-router', name: r.name },
          'Give one of them a higher priority or a narrower rule.'));
      } else seen.set(k, r.name);
    }
  }

  // ── services ───────────────────────────────────────────────────────────────
  const referenced = servicesReferenced();
  for (const proto of ['http', 'tcp', 'udp']) {
    for (const s of state[proto].services) {
      const res = { kind: `${proto}-service`, name: s.name };
      const st = Object.entries(s.serverStatus ?? {});
      const down = st.filter(([, v]) => v !== 'UP');
      if (st.length && down.length === st.length) {
        out.push(finding(`service-down:${s.name}`, 'critical', `Every server of ${s.name} is down`,
          `${down.map(([u]) => u).join(', ')} fail the health check, so the routers that use it answer 503.`, res, 'Check the backend containers and the health check path.'));
      } else if (down.length) {
        out.push(finding(`server-down:${s.name}`, 'warning', `${down.length} of ${st.length} servers of ${s.name} are down`,
          `${down.map(([u]) => u).join(', ')} fail the health check; traffic goes to the others.`, res));
      }
      if (s.status === 'disabled' || (s.error && s.error.length)) {
        out.push(finding(`service-error:${s.name}`, 'critical', `Service ${s.name} has an error`, (s.error ?? []).join('; '), res));
      }
      if (s.provider !== 'internal' && (!s.usedBy || s.usedBy.length === 0) && !referenced.has(s.name)) {
        out.push(finding(`service-unused:${s.name}`, 'info', `Service ${s.name} is not used by any router`, 'It is defined but nothing sends traffic to it.', res, 'Remove it, or it is a leftover from an old router.'));
      }
    }
  }

  // ── middlewares ────────────────────────────────────────────────────────────
  for (const proto of ['http', 'tcp']) {
    for (const m of state[proto].middlewares) {
      const res = { kind: `${proto}-middleware`, name: m.name };
      if (m.status === 'disabled' || (m.error && m.error.length)) {
        out.push(finding(`mw-error:${m.name}`, 'critical', `Middleware ${m.name} has an error`, (m.error ?? []).join('; '), res));
      }
      if (m.provider !== 'internal' && (!m.usedBy || m.usedBy.length === 0)) {
        out.push(finding(`mw-unused:${m.name}`, 'info', `Middleware ${m.name} is not used`, 'No router references it.', res));
      }
    }
  }

  // ── certificates ───────────────────────────────────────────────────────────
  const now = Date.now();
  for (const c of metrics.certs) {
    const days = (Date.parse(c.notAfter) - now) / 86_400_000;
    const res = { kind: 'certificate', name: c.cn || c.sans[0] || c.serial };
    if (days < 0) out.push(finding(`cert-expired:${c.serial}`, 'critical', `Certificate for ${c.cn} has expired`, `It expired ${Math.round(-days)} day(s) ago.`, res, 'Renew it, or check why the resolver did not.'));
    else if (days < config.certCriticalDays) out.push(finding(`cert-critical:${c.serial}`, 'critical', `Certificate for ${c.cn} expires in ${Math.max(0, Math.floor(days))} day(s)`, `Valid until ${c.notAfter}.`, res, 'ACME renews 30 days ahead; if it has not, check the resolver logs.'));
    else if (days < config.certWarnDays) out.push(finding(`cert-warning:${c.serial}`, 'warning', `Certificate for ${c.cn} expires in ${Math.floor(days)} days`, `Valid until ${c.notAfter}.`, res));
  }

  // ── traffic ────────────────────────────────────────────────────────────────
  if (metrics.ok) {
    for (const r of top('router', 5, 200)) {
      if (r.rps >= 0.2 && r.errorRate >= 0.05) {
        out.push(finding(`errors:${r.name}`, r.errorRate >= 0.25 ? 'critical' : 'warning', `${r.name} is failing ${Math.round(r.errorRate * 100)}% of requests`,
          'Server errors (5xx) over the last five minutes.', { kind: 'http-router', name: r.name }, 'Open the router\'s traffic and the access log filtered to it.'));
      }
      if (r.p95 !== null && r.p95 >= 2000 && r.rps >= 0.2) {
        out.push(finding(`slow:${r.name}`, 'warning', `${r.name} is slow`, `95% of requests finish within ${(r.p95 / 1000).toFixed(1)} s, the rest take longer.`, { kind: 'http-router', name: r.name }));
      }
    }
    if (metrics.gauges.lastReloadSuccess && metrics.gauges.process.startTime && metrics.gauges.lastReloadSuccess < metrics.gauges.process.startTime) {
      out.push(finding('reload', 'warning', 'The last configuration reload did not succeed', 'Traefik is running an older configuration than the one on disk.', null, 'Check Traefik\'s log for the provider error.'));
    }
  } else if (metrics.enabled) {
    out.push(finding('metrics-unreachable', 'warning', 'Traefik metrics unreachable', metrics.error ?? '', null,
      'Enable metrics.prometheus in Traefik and set TRAEFIK_METRICS_URL (default: the API URL + /metrics).'));
  }

  // ── setup ──────────────────────────────────────────────────────────────────
  if (staticCfg) {
    const p = staticCfg.metrics?.prometheus;
    if (p && !p.addRoutersLabels) out.push(finding('router-metrics', 'info', 'Per-router traffic is off', 'Traefik only reports traffic per entry point and service.', null, 'Set metrics.prometheus.addRoutersLabels=true to see traffic for every router.'));
    if (staticCfg.global?.sendAnonymousUsage === undefined && staticCfg.global?.checkNewVersion) { /* defaults, nothing to say */ }
    if (staticCfg.api?.insecure && !state.http.routers.some((r) => r.service === 'api@internal' && r.provider !== 'internal')) {
      out.push(finding('api-insecure', 'info', 'The API runs in insecure mode', 'It is served on the "traefik" entry point without authentication. That is fine while that port is not published to the internet.', null,
        'Keep port 8080 unpublished (or bound to 127.0.0.1), or switch to a router for api@internal with an auth middleware.'));
    }
  }

  return out.sort((a, b) => SEV[b.severity] - SEV[a.severity] || a.title.localeCompare(b.title));
}

/**
 * Services that other services or middlewares send traffic to: the parts of a weighted, mirroring or
 * failover service, and an errors middleware's page service. A name without @provider is local to
 * the provider of whatever names it.
 */
export function servicesReferenced() {
  const out = new Set();
  const full = (name, owner) => (!name ? null : name.includes('@') ? name : `${name}@${owner.provider}`);
  for (const proto of ['http', 'tcp', 'udp']) {
    for (const s of state[proto].services) {
      const add = (n) => { const f = full(n, s); if (f) out.add(f); };
      for (const w of s.weighted?.services ?? []) add(w.name);
      if (s.mirroring) { add(s.mirroring.service); for (const m of s.mirroring.mirrors ?? []) add(m.name); }
      if (s.failover) { add(s.failover.service); add(s.failover.fallback); }
    }
  }
  for (const m of state.http.middlewares) if (m.errors?.service) out.add(full(m.errors.service, m));
  return out;
}

/** A 0-100 score: critical findings cost the most. */
export function healthScore(findings) {
  let score = 100;
  for (const f of findings) score -= f.severity === 'critical' ? 20 : f.severity === 'warning' ? 6 : 1;
  return Math.max(0, Math.min(100, score));
}
