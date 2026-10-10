// Finds a Traefik and tells the installer what it found, as shell assignments. It asks Traefik itself
// (the API, the entry points, the support dump) instead of reading its flags or files, so it works
// whatever way Traefik was configured: flags, traefik.yml, traefik.toml, Kubernetes, v2 or v3.
//
//   node server/detect.mjs traefik            tries http://traefik:8080, :9000, :8082, :8081, :8090
//   node server/detect.mjs http://10.0.0.5:8080/traefik
//
// Exit code 0 when an API answered, 1 when nothing did.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const PORTS = [8080, 9000, 8082, 8081, 8090, 8099];

function get(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve(null); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout: timeoutMs, rejectUnauthorized: false, headers: { 'User-Agent': 'enodia-detect' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}
const json = (r) => { try { return r && r.status === 200 ? JSON.parse(r.body.toString('utf8')) : null; } catch { return null; } };

function untar(buf) {
  const files = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = buf.subarray(off, off + 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(buf.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    files[name] = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const target = process.argv[2] || 'traefik';
const bases = /^https?:\/\//.test(target) ? [target.replace(/\/+$/, '')] : PORTS.map((p) => `http://${target}:${p}`);

let base = null;
let version = null;
for (const b of bases) {
  version = json(await get(`${b}/api/version`));
  if (version?.Version) { base = b; break; }
}

const out = {};
const set = (k, v) => { out[k] = String(v ?? '').replace(/[^A-Za-z0-9:/._,@+-]/g, ''); };

if (!base) {
  set('DETECT_OK', '0');
} else {
  set('DETECT_OK', '1');
  set('TRAEFIK_API_URL', base);
  set('TRAEFIK_VERSION', version.Version);
  const overview = json(await get(`${base}/api/overview`)) ?? {};
  const entrypoints = json(await get(`${base}/api/entrypoints`)) ?? [];
  set('PROVIDERS', (overview.providers ?? []).join(','));
  set('ACCESSLOG', overview.features?.accessLog ? '1' : '0');

  // which entry point takes HTTPS and which plain HTTP, by port first and name second
  const port = (e) => (e.address ?? '').match(/:(\d+)(?:\/(tcp|udp))?$/)?.[1];
  const tls = entrypoints.find((e) => port(e) === '443') ?? entrypoints.find((e) => /secure|https|tls/i.test(e.name)) ?? entrypoints.find((e) => e.http?.tls);
  const plain = entrypoints.find((e) => port(e) === '80') ?? entrypoints.find((e) => /^(web|http)$/i.test(e.name));
  set('TLS_ENTRYPOINT', tls?.name ?? '');
  set('HTTP_ENTRYPOINT', plain?.name ?? '');
  set('ENTRYPOINTS', entrypoints.map((e) => e.name).join(','));

  // the static configuration (v3): resolvers, the metrics entry point, the access-log format
  let stat = null;
  const dump = await get(`${base}/api/support-dump`, 8000);
  if (dump?.status === 200) {
    try {
      const files = untar(zlib.gunzipSync(dump.body));
      const f = Object.entries(files).find(([k]) => k.endsWith('static-config.json'))?.[1];
      stat = f ? JSON.parse(f.toString('utf8')) : null;
    } catch { /* unreadable dump: the rest still stands */ }
  }
  set('RESOLVERS', Object.keys(stat?.certificatesResolvers ?? {}).join(','));
  set('ACCESSLOG_FORMAT', stat?.accessLog?.format ?? '');
  set('ROUTER_METRICS', stat?.metrics?.prometheus?.addRoutersLabels ? '1' : '0');

  // metrics: on the API's own address, or on the entry point Prometheus is told to use
  const candidates = [`${base}/metrics`];
  const metricsEp = stat?.metrics?.prometheus?.entryPoint;
  for (const e of entrypoints) {
    if (e.name === metricsEp || e.name === 'metrics') {
      const u = new URL(base); u.port = port(e) ?? u.port; u.pathname = '/metrics';
      candidates.push(u.toString());
    }
  }
  let metricsUrl = '';
  for (const c of candidates) {
    const r = await get(c);
    if (r?.status === 200 && r.body.includes('traefik_')) { metricsUrl = c; break; }
  }
  set('METRICS_URL', metricsUrl);
}

for (const [k, v] of Object.entries(out)) process.stdout.write(`${k}='${v}'\n`);
process.exit(base ? 0 : 1);
