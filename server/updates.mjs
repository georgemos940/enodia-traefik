// Is there a newer Enodia, or a newer Traefik? Checked against the GitHub releases a few times a day.
// Only the public releases endpoint is called, with no data about this install. ENODIA_UPDATE_CHECK=false
// turns it off.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { state as traefik } from './traefik.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8'));

const env = process.env;
const enabled = env.ENODIA_UPDATE_CHECK !== 'false';
const repo = env.ENODIA_UPDATE_REPO || 'georgemos940/enodia';
const EVERY_MS = 6 * 3600_000;

/** How this copy was installed: decides which update command the UI shows. */
export const installMethod = env.ENODIA_INSTALL || (fs.existsSync(path.resolve(here, '..', '.git')) ? 'source' : 'unknown');

export const updates = {
  enabled,
  repo,
  installMethod,
  checkedAt: null,
  error: null,
  enodia: { current: pkg.version, latest: null, newer: false, url: null, notes: null, publishedAt: null },
  traefik: { current: null, latest: null, newer: false, url: null, publishedAt: null },
};

const listeners = new Set();
export const onUpdate = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** 1.2.3 vs 1.10.0, ignoring a leading v; pre-releases sort before their release. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v ?? '').trim().replace(/^v/i, '').split('-', 2);
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const x = parse(a); const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function latestRelease(fullName) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://api.github.com/repos/${fullName}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `enodia/${pkg.version}` },
      timeout: 10_000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null); // no release published yet
        if (res.statusCode !== 200) return reject(new Error(`GitHub answered ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub did not answer in time')));
    req.on('error', reject);
  });
}

export async function checkNow() {
  if (!enabled) return updates;
  const before = JSON.stringify([updates.enodia.newer, updates.enodia.latest, updates.traefik.newer, updates.traefik.latest]);
  try {
    const [mine, theirs] = await Promise.all([latestRelease(repo), latestRelease('traefik/traefik').catch(() => null)]);
    if (mine && !mine.draft && !mine.prerelease) {
      updates.enodia = {
        current: pkg.version,
        latest: mine.tag_name?.replace(/^v/i, '') ?? null,
        newer: compareVersions(mine.tag_name, pkg.version) > 0,
        url: mine.html_url ?? null,
        notes: (mine.body ?? '').slice(0, 20_000),
        publishedAt: mine.published_at ?? null,
      };
    }
    const running = traefik.version?.Version ?? null;
    if (theirs && running) {
      updates.traefik = {
        current: running,
        latest: theirs.tag_name?.replace(/^v/i, '') ?? null,
        newer: compareVersions(theirs.tag_name, running) > 0,
        url: theirs.html_url ?? null,
        publishedAt: theirs.published_at ?? null,
      };
    }
    updates.error = null;
  } catch (e) {
    updates.error = e.message;
  }
  updates.checkedAt = new Date().toISOString();
  const after = JSON.stringify([updates.enodia.newer, updates.enodia.latest, updates.traefik.newer, updates.traefik.latest]);
  if (after !== before) for (const fn of listeners) fn(updates);
  return updates;
}

export function startUpdateChecks() {
  if (!enabled) return;
  // the first check waits for Traefik's version to be known
  setTimeout(() => { checkNow(); setInterval(checkNow, EVERY_MS).unref(); }, 20_000).unref();
}
