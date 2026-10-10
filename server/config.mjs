// Every setting comes from the environment, so one image serves every Traefik.
const env = process.env;

const num = (v, fallback, min = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : fallback;
};
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

const apiUrl = trimSlash(env.TRAEFIK_API_URL || 'http://traefik:8080');

export const config = {
  port: num(env.PORT, 3000, 1),
  host: env.HOST || '0.0.0.0',
  // where the app is served under, e.g. /enodia when it shares a host with something else
  basePath: trimSlash(env.ENODIA_BASE_PATH || ''),

  traefik: {
    // the API entry point (api.insecure, or a router to api@internal)
    apiUrl,
    // the Prometheus metrics endpoint; empty turns live traffic off
    metricsUrl: env.TRAEFIK_METRICS_URL === undefined ? `${apiUrl}/metrics` : trimSlash(env.TRAEFIK_METRICS_URL),
    // optional credentials when the API sits behind basic auth
    username: env.TRAEFIK_API_USERNAME || '',
    password: env.TRAEFIK_API_PASSWORD || '',
    // extra headers, as JSON: {"X-Token": "..."}
    headers: (() => { try { return JSON.parse(env.TRAEFIK_API_HEADERS || '{}'); } catch { return {}; } })(),
    timeoutMs: num(env.TRAEFIK_TIMEOUT_MS, 5000, 500),
    insecureTls: env.TRAEFIK_INSECURE_TLS === 'true',
  },

  pollSeconds: num(env.ENODIA_POLL_SECONDS, 5, 1),
  // how much traffic history is kept in memory, in minutes
  historyMinutes: num(env.ENODIA_HISTORY_MINUTES, 60, 5),

  // a Traefik access log in JSON format, mounted read-only; empty turns the log explorer off
  accessLog: env.TRAEFIK_ACCESS_LOG || '',
  accessLogKeep: num(env.ENODIA_LOG_KEEP, 10000, 100),

  // where the change history is kept across restarts; empty keeps it in memory only
  dataDir: env.ENODIA_DATA_DIR || '',

  auth: {
    // a password for the built-in login; empty means Enodia trusts whatever is in front of it
    password: env.ENODIA_PASSWORD || '',
    // or trust a header set by a forward-auth proxy (Authelia, oauth2-proxy, Authentik)
    trustHeader: (env.ENODIA_TRUST_HEADER || '').toLowerCase(),
    sessionHours: num(env.ENODIA_SESSION_HOURS, 12, 1),
    secret: env.ENODIA_SECRET || '',
  },

  // certificate warnings, in days
  certWarnDays: num(env.ENODIA_CERT_WARN_DAYS, 21, 1),
  certCriticalDays: num(env.ENODIA_CERT_CRITICAL_DAYS, 7, 1),

  // optional webhook (Discord, Slack-compatible, or any JSON receiver) for new critical findings
  webhookUrl: env.ENODIA_WEBHOOK_URL || '',

  // a friendly name for this Traefik in the header
  instanceName: env.ENODIA_INSTANCE_NAME || '',
};
