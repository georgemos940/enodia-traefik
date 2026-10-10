// A GET with a timeout, optional basic auth and optional self-signed TLS, on node:http(s) so Enodia
// needs no dependencies at all.
import http from 'node:http';
import https from 'node:https';
import { config } from './config.mjs';

const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const keepHttp = new http.Agent({ keepAlive: true });
const keepHttps = new https.Agent({ keepAlive: true });

// Traefik's credentials and headers go only to Traefik: anything else passes traefik: false.
export function get(url, { timeoutMs = config.traefik.timeoutMs, accept = 'application/json', traefik = true, headers: extra = {}, insecureTls = config.traefik.insecureTls } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { Accept: accept, 'User-Agent': 'enodia', ...(traefik ? config.traefik.headers : {}), ...extra };
    if (traefik && config.traefik.username) {
      headers.Authorization = 'Basic ' + Buffer.from(`${config.traefik.username}:${config.traefik.password}`).toString('base64');
    }
    const agent = u.protocol === 'https:' ? (insecureTls ? insecureAgent : keepHttps) : keepHttp;
    const started = Date.now();
    const req = lib.get(u, { headers, agent, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 64 * 1024 * 1024) { req.destroy(new Error('response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), ms: Date.now() - started }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
  });
}

export async function getJson(url, opts) {
  const r = await get(url, opts);
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`Traefik answered ${r.status}: check TRAEFIK_API_USERNAME / TRAEFIK_API_PASSWORD`), { status: r.status });
  if (r.status === 404) throw Object.assign(new Error('not found'), { status: 404 });
  if (r.status >= 400) throw Object.assign(new Error(`Traefik answered ${r.status}`), { status: r.status });
  try {
    return { data: JSON.parse(r.body.toString('utf8')), headers: r.headers, ms: r.ms };
  } catch {
    throw new Error(`Traefik did not answer with JSON at ${url}: is TRAEFIK_API_URL the API entry point?`);
  }
}
