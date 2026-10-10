// Three ways to protect Enodia: a password (built-in login), a header set by a forward-auth proxy in
// front of it, or nothing, for when Traefik itself guards the route with basicAuth or forwardAuth.
import crypto from 'node:crypto';
import { config } from './config.mjs';

const secret = config.auth.secret ? Buffer.from(config.auth.secret) : crypto.randomBytes(32);
const COOKIE = 'enodia_session';

export const authMode = config.auth.password ? 'password' : config.auth.trustHeader ? 'header' : 'none';

const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim().split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));
}

/** Who is asking, or null. */
export function whoIs(req) {
  if (authMode === 'none') return { user: 'anyone' };
  if (authMode === 'header') {
    const v = req.headers[config.auth.trustHeader];
    return v ? { user: String(v).slice(0, 120) } : null;
  }
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const want = sign(payload);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  const [exp, user] = Buffer.from(payload, 'base64url').toString('utf8').split('|');
  if (!(Number(exp) > Date.now())) return null;
  return { user: user || 'admin' };
}

// a few wrong passwords a minute per address, then a pause
const attempts = new Map();
export function tooManyAttempts(ip) {
  const now = Date.now();
  const a = attempts.get(ip) ?? { n: 0, reset: now + 60_000 };
  if (now > a.reset) { a.n = 0; a.reset = now + 60_000; }
  return a.n >= 8;
}
function failed(ip) {
  const now = Date.now();
  const a = attempts.get(ip) ?? { n: 0, reset: now + 60_000 };
  a.n++;
  attempts.set(ip, a);
}

/** Checks the password and returns the Set-Cookie value, or null. */
export function login(password, ip, secure) {
  const a = crypto.createHash('sha256').update(String(password ?? '')).digest();
  const b = crypto.createHash('sha256').update(config.auth.password).digest();
  if (!crypto.timingSafeEqual(a, b)) { failed(ip); return null; }
  attempts.delete(ip);
  const exp = Date.now() + config.auth.sessionHours * 3600_000;
  const payload = Buffer.from(`${exp}|admin`).toString('base64url');
  const path = `${config.basePath || ''}/`;
  return `${COOKIE}=${payload}.${sign(payload)}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${config.auth.sessionHours * 3600}${secure ? '; Secure' : ''}`;
}

export function logoutCookie() {
  return `${COOKIE}=; Path=${config.basePath || ''}/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
