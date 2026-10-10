// `npm run lab`: a real Traefik with varied configuration and steady traffic, plus Enodia pointed at
// it, for developing and testing. Uses `traefik` from PATH, or TRAEFIK_BIN, or downloads the release
// for this machine into lab/bin (checksum verified).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = process.env.TRAEFIK_VERSION || '3.6.8';
const exe = process.platform === 'win32' ? 'traefik.exe' : 'traefik';

function onPath(cmd) {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return cmd; } catch { return null; }
}

async function download() {
  const bin = path.join(here, 'bin', exe);
  if (fs.existsSync(bin)) return bin;
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  const os = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
  if (!arch || !os) throw new Error('No Traefik release for this platform: set TRAEFIK_BIN');
  const file = `traefik_v${VERSION}_${os}_${arch}.${os === 'windows' ? 'zip' : 'tar.gz'}`;
  const base = `https://github.com/traefik/traefik/releases/download/v${VERSION}`;
  console.log(`[lab] downloading ${file}`);
  const [archive, sums] = await Promise.all([
    fetch(`${base}/${file}`).then((r) => { if (!r.ok) throw new Error(`download failed: ${r.status}`); return r.arrayBuffer(); }),
    fetch(`${base}/traefik_v${VERSION}_checksums.txt`).then((r) => r.text()),
  ]);
  const want = sums.split('\n').find((l) => l.endsWith(file))?.split(/\s+/)[0];
  const have = crypto.createHash('sha256').update(Buffer.from(archive)).digest('hex');
  if (!want || want !== have) throw new Error('checksum mismatch, refusing to run the download');
  fs.mkdirSync(path.join(here, 'bin'), { recursive: true });
  const tmp = path.join(here, 'bin', file);
  fs.writeFileSync(tmp, Buffer.from(archive));
  execFileSync('tar', ['-xf', tmp, '-C', path.join(here, 'bin'), exe]);
  fs.rmSync(tmp);
  if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
  return bin;
}

function certs() {
  const dir = path.join(here, 'certs');
  fs.mkdirSync(dir, { recursive: true });
  const make = (name, days, sans) => {
    if (fs.existsSync(path.join(dir, `${name}.crt`))) return;
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', String(days), '-subj', `/CN=${sans[0]}`,
        '-addext', `subjectAltName=${sans.map((s) => `DNS:${s}`).join(',')}`, '-keyout', path.join(dir, `${name}.key`), '-out', path.join(dir, `${name}.crt`)],
      { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    } catch { console.log('[lab] openssl not found: the lab runs without its two test certificates'); }
  };
  make('shop', 40, ['shop.localhost', 'www.shop.localhost']);
  make('api', 400, ['api.localhost']);
}

const children = [];
function run(name, cmd, args, cwd = here) {
  const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const tag = (d) => d.toString().split('\n').filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on('data', tag);
  p.stderr.on('data', tag);
  p.on('exit', (code) => console.log(`[${name}] exited ${code}`));
  children.push(p);
  return p;
}
process.on('SIGINT', () => { for (const c of children) c.kill(); process.exit(0); });

const traefik = process.env.TRAEFIK_BIN || onPath('traefik') || (await download());
fs.mkdirSync(path.join(here, 'logs'), { recursive: true });
certs();
run('backends', process.execPath, ['backends.mjs']);
run('traefik', traefik, ['--configFile=traefik.yml']);
run('crowdsec', process.execPath, ['crowdsec.mjs']);
setTimeout(() => run('traffic', process.execPath, ['traffic.mjs', process.env.LAB_RPS || '25']), 2500);
setTimeout(() => {
  process.env.TRAEFIK_API_URL ??= 'http://127.0.0.1:8090';
  process.env.TRAEFIK_METRICS_URL ??= 'http://127.0.0.1:8092/metrics';
  process.env.TRAEFIK_ACCESS_LOG ??= path.join(here, 'logs', 'access.log');
  process.env.ENODIA_DATA_DIR ??= path.join(here, '.enodia-data');
  process.env.ENODIA_INSTANCE_NAME ??= 'Lab';
  process.env.CROWDSEC_LAPI_URL ??= 'http://127.0.0.1:8095';
  process.env.CROWDSEC_BOUNCER_KEY ??= 'lab';
  run('enodia', process.execPath, ['--watch', path.join(here, '..', 'server', 'index.mjs')], path.join(here, '..'));
  console.log('[lab] open http://localhost:3000  ·  npm run attack for a fake attack on the Shield page');
}, 3000);
