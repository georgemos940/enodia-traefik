// CrowdSec, read-only: the decisions its Local API hands to bouncers. With a bouncer key of its own
// (cscli bouncers add enodia) Enodia sees who is banned, by which scenario and until when. A bouncer
// key can only read decisions, so Enodia can never ban or unban anyone.
import { config } from './config.mjs';
import { get } from './http.mjs';
import { cidr, inRanges } from './netmatch.mjs';

const cs = config.crowdsec;
const COMMUNITY = new Set(['capi', 'lists']);

export const crowdsec = {
  enabled: Boolean(cs.url && cs.key),
  url: cs.url,
  ok: false,
  error: null,
  checkedAt: null,
};

const decisions = new Map();     // id -> decision
let ipBans = new Map();          // address -> local decision, for marking sources
let rangeBans = [];              // [{ range, decision }]
let primed = false;
const listeners = new Set();
export const onDecisions = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// Go durations: "3h59m55.756182786s", "-12m3s", "45s"
function goDuration(s) {
  const m = String(s ?? '').match(/^(-)?(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?$/);
  if (!m) return 0;
  const ms = ((+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) * 1000;
  return m[1] ? -ms : ms;
}

function shape(d, now) {
  return {
    id: d.id,
    value: d.value,
    scope: d.scope ?? 'Ip',
    type: d.type ?? 'ban',
    origin: d.origin ?? '',
    scenario: d.scenario ?? '',
    until: d.until ? Date.parse(d.until) : now + goDuration(d.duration),
    seenAt: now,
    community: COMMUNITY.has(String(d.origin ?? '').toLowerCase()),
  };
}

function reindex() {
  const now = Date.now();
  ipBans = new Map();
  rangeBans = [];
  for (const [id, d] of decisions) {
    if (d.until && d.until < now) { decisions.delete(id); continue; }
    if (d.community) continue;
    if (/^ip$/i.test(d.scope)) ipBans.set(d.value, d);
    else if (/^range$/i.test(d.scope)) rangeBans.push({ range: cidr(d.value), decision: d });
  }
}

async function poll() {
  try {
    const r = await get(`${cs.url}/v1/decisions/stream?startup=${primed ? 'false' : 'true'}`, {
      traefik: false, headers: { 'X-Api-Key': cs.key }, insecureTls: cs.insecureTls, timeoutMs: 15000,
    });
    if (r.status === 403 || r.status === 401) throw new Error('CrowdSec refused the key: check CROWDSEC_BOUNCER_KEY (cscli bouncers add enodia)');
    if (r.status !== 200) throw new Error(`CrowdSec answered ${r.status}`);
    const body = JSON.parse(r.body.toString('utf8') || '{}');
    const now = Date.now();
    const fresh = [];
    for (const d of body.deleted ?? []) decisions.delete(d.id);
    for (const d of body.new ?? []) {
      const x = shape(d, now);
      decisions.set(x.id, x);
      if (primed && !x.community) fresh.push(x);
    }
    reindex();
    primed = true;
    crowdsec.ok = true;
    crowdsec.error = null;
    if (fresh.length) for (const fn of listeners) fn(fresh);
  } catch (e) {
    crowdsec.ok = false;
    crowdsec.error = e.code === 'ECONNREFUSED' ? `Nothing answers at ${cs.url}` : e.message;
  }
  crowdsec.checkedAt = new Date().toISOString();
}

export function startCrowdsec() {
  if (!crowdsec.enabled) return;
  poll();
  setInterval(poll, cs.pollSeconds * 1000).unref();
}

/** The local decision covering this address, if any (community blocklists are left out). */
export function banFor(ip) {
  const d = ipBans.get(ip);
  if (d) return d;
  if (!rangeBans.length) return null;
  return rangeBans.find((r) => inRanges(ip, [r.range]))?.decision ?? null;
}

export function crowdsecSummary() {
  if (!crowdsec.enabled) return { enabled: false };
  const byOrigin = {};
  const scenarios = new Map();
  const local = [];
  for (const d of decisions.values()) {
    byOrigin[d.origin] = (byOrigin[d.origin] ?? 0) + 1;
    if (d.community) continue;
    local.push(d);
    scenarios.set(d.scenario, (scenarios.get(d.scenario) ?? 0) + 1);
  }
  local.sort((a, b) => b.id - a.id);
  return {
    enabled: true, ok: crowdsec.ok, error: crowdsec.error, checkedAt: crowdsec.checkedAt, url: crowdsec.url,
    total: decisions.size,
    local: local.length,
    community: decisions.size - local.length,
    byOrigin,
    scenarios: [...scenarios].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, n]) => ({ name, n })),
    recent: local.slice(0, 40).map(({ id, value, scope, type, origin, scenario, until, seenAt }) => ({ id, value, scope, type, origin, scenario, until, seenAt })),
  };
}
