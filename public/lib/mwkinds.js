// Every Traefik v3 middleware kind: a name, an icon and colour, a one-line summary and a detail view.
// Detail views explain what the middleware does to a request, with testers for the ones that rewrite.
import { h, s } from './dom.js';
import { glyph } from './glyphs.js';
import { badge, kv, jsonView, hrefFor } from './components.js';
import { bytes, num, qualify, split, rate, plural } from './format.js';
import { hostsOf } from './rules.js';
import { live } from './store.js';
import { findService, findMiddleware, healthOf, mwKind, mwUsage } from './model.js';

// ── small helpers ────────────────────────────────────────────────────────────

/** A Go duration ("1m30s", "100ms") or nanoseconds as milliseconds. */
export function goDur(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v / 1e6;
  const mult = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let total = 0; let any = false;
  for (const m of String(v).matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) { total += parseFloat(m[1]) * mult[m[2]]; any = true; }
  if (any) return total;
  return Number.isFinite(Number(v)) ? Number(v) / 1e6 : null;
}
export function durText(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') return v;
  const ms = goDur(v);
  if (ms >= 3_600_000) return `${+(ms / 3_600_000).toFixed(2)}h`;
  if (ms >= 60_000) return `${+(ms / 60_000).toFixed(2)}m`;
  if (ms >= 1000) return `${+(ms / 1000).toFixed(2)}s`;
  return `${+ms.toFixed(2)}ms`;
}
const humanMs = (msv) => {
  if (msv === null || msv === undefined) return '—';
  if (msv >= 3_600_000) return `${+(msv / 3_600_000).toFixed(1)} h`;
  if (msv >= 60_000) return `${+(msv / 60_000).toFixed(1)} min`;
  if (msv >= 1000) return `${+(msv / 1000).toFixed(msv >= 10_000 ? 0 : 1)} s`;
  return `${Math.round(msv)} ms`;
};

// keys whose values are secrets; URL query names are matched a little more broadly
const SECRET = /pass|secret|token|apikey|api_key|(^|[_-])key$|credential|bearer|signature|private|^authorization$|^cookie$|^x-api-key$/i;
const SECRET_QUERY = /pass|secret|token|key|auth|sig|credential|session/i;

/** A URL with its password and secret-looking query values hidden. */
export function maskUrl(u) {
  if (!u || typeof u !== 'string') return u;
  try {
    const url = new URL(u);
    if (url.password) url.password = '••••';
    for (const k of [...url.searchParams.keys()]) if (SECRET_QUERY.test(k)) url.searchParams.set(k, '••••');
    return decodeURI(url.toString());
  } catch { return u.replace(/\/\/([^:/@]+):[^@/]+@/, '//$1:••••@'); }
}

/** A deep copy with secrets masked, for raw views. */
export function sanitize(v, key = '') {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) {
    if (/^users$/i.test(key)) return v.map((u) => maskUser(String(u)));
    return v.map((x) => sanitize(x, key));
  }
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sanitize(x, k)]));
  if (typeof v === 'string') {
    if (/^(address|url|endpoint)$/i.test(key)) return maskUrl(v);
    if (SECRET.test(key) && v) return '••••••';
  }
  return v;
}
function maskUser(line) {
  const parts = line.split(':');
  return parts.length > 1 ? `${parts.slice(0, -1).join(':')}:${hashHint(parts[parts.length - 1])}` : '••••••';
}
function hashHint(hash) {
  const m = /^(\$[a-z0-9]+\$|\{[A-Z0-9]+\})/i.exec(hash);
  return `${m ? m[1] : ''}••••••••`;
}
function hashAlgo(hash) {
  if (/^\$apr1\$/.test(hash)) return 'MD5 (apr1)';
  if (/^\$2[aby]?\$/.test(hash)) return 'bcrypt';
  if (/^\{SHA\}/i.test(hash)) return 'SHA-1';
  if (/^\$5\$/.test(hash)) return 'SHA-256 crypt';
  if (/^\$6\$/.test(hash)) return 'SHA-512 crypt';
  if (/^[a-f0-9]{32}$/i.test(hash)) return 'MD5 digest';
  return 'hash';
}
const weakAlgo = (a) => a === 'SHA-1' || a === 'MD5 (apr1)';

/** Go's regexp syntax, close enough for testing: (?i) flags, (?P<name>), ${1} replacements. */
export function goRegex(src, extra = '') {
  let flags = extra;
  let body = String(src ?? '');
  const m = /^\(\?([imsU]+)\)/.exec(body);
  if (m) {
    for (const f of m[1]) if ('ims'.includes(f) && !flags.includes(f)) flags += f;
    body = body.slice(m[0].length);
  }
  body = body.replace(/\(\?P</g, '(?<').replace(/\\z/g, '$').replace(/\\A/g, '^');
  return new RegExp(body, flags);
}
export const goReplacement = (rep) => String(rep ?? '').replace(/\$\{(\d+)\}/g, '$$$1').replace(/\$\{(\w+)\}/g, '$$<$1>');

export const tone = (hue) => ({ '--h': hue });

/** JSON with secrets masked here (the generic masking would hide whole objects such as passTLSClientCert). */
export const rawView = (v) => jsonView(sanitize(v), { mask: false });

// ── shared bits of UI ────────────────────────────────────────────────────────

export function section(title, ...children) {
  return h('div', { class: 'gr-sec' }, title ? h('div', { class: 'gr-sec-title' }, title) : null, ...children);
}
const chipList = (items, cls = '') => h('div', { class: 'chips' }, ...items.map((x) => (x instanceof Node ? x : h('span', { class: `chip mono ${cls}`.trim() }, String(x)))));
const yes = (v, on = 'yes', off = 'no') => h('span', { class: v ? 'ok-text bold' : 'muted' }, v ? on : off);
const mono = (v) => h('span', { class: 'mono' }, String(v));
const note = (text, t = 'info') => h('div', { class: `gr-note ${t}` }, glyph(t === 'warn' ? 'alert' : t === 'bad' ? 'xcircle' : 'info', { size: 14 }), h('span', {}, text));

/** A row of numbered steps (request flow): items [{ title, sub, tone, glyph }]. */
function flow(items) {
  return h('div', { class: 'gr-flow' }, ...items.flatMap((it, i) => [
    i ? h('div', { class: 'gr-flow-arrow' }, glyph('arrow', { size: 16 })) : null,
    h('div', { class: `gr-flow-step ${it.tone ?? ''}`.trim() }, it.glyph ? glyph(it.glyph, { size: 16 }) : null, h('div', { class: 'col', style: { gap: '0', minWidth: '0' } }, h('b', { class: 'ellipsis' }, it.title), it.sub ? h('span', { class: 'tiny muted ellipsis' }, it.sub) : null)),
  ]));
}

/** An input with a live result underneath. run(value) -> { tone, label, value, rows } */
export function tester({ title = 'Try it', placeholder = '', value = '', run, help }) {
  const input = h('input', { class: 'input mono', value, placeholder, spellcheck: false, autocomplete: 'off', 'aria-label': title });
  const out = h('div', { class: 'gr-test-out' });
  const paint = () => {
    let r;
    try { r = run(input.value.trim()); } catch (e) { r = { tone: 'bad', label: 'Error', value: e.message }; }
    out.className = `gr-test-out ${r.tone ?? ''}`.trim();
    out.replaceChildren(
      h('div', { class: 'row', style: { gap: '8px', alignItems: 'flex-start' } },
        glyph(r.tone === 'ok' ? 'arrow' : r.tone === 'bad' ? 'xcircle' : 'minus', { size: 15 }),
        h('div', { class: 'grow col', style: { gap: '2px' } },
          h('span', { class: 'tiny gr-test-label' }, r.label),
          r.value !== undefined && r.value !== null ? h('code', { class: 'gr-test-value' }, r.value) : null)),
      ...(r.rows ?? []).map(([k, v]) => h('div', { class: 'gr-test-row' }, h('span', { class: 'muted' }, k), h('code', {}, v))));
  };
  input.addEventListener('input', paint);
  paint();
  return h('div', { class: 'gr-test' },
    h('div', { class: 'gr-test-head' }, glyph('terminal', { size: 14 }), h('span', { class: 'bold' }, title), help ? h('span', { class: 'muted tiny' }, help) : null),
    input, out);
}

/** Pick a URL to start a tester with: the first host of the routers using the middleware. */
function sampleHosts(mw) {
  if (!mw) return [];
  const hosts = mwUsage(mw.name, mw.proto ?? 'http').flatMap((u) => hostsOf(u.router.rule ?? ''));
  return [...new Set(hosts)].filter((x) => !/[*{]/.test(x));
}

// ── IP ranges ────────────────────────────────────────────────────────────────

function ip4(str) {
  const p = str.split('.');
  if (p.length !== 4) return null;
  let n = 0n;
  for (const x of p) { if (!/^\d{1,3}$/.test(x) || Number(x) > 255) return null; n = (n << 8n) | BigInt(Number(x)); }
  return n;
}
function ip6(str) {
  let t = str.split('%')[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (v4) {
    const n = ip4(v4[1]);
    if (n === null) return null;
    t = `${t.slice(0, -v4[1].length)}${((n >> 16n) & 0xffffn).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const halves = t.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) { if (!/^[0-9a-f]{1,4}$/i.test(g)) return null; n = (n << 16n) | BigInt(parseInt(g, 16)); }
  return n;
}
export function parseIP(str) {
  const t = String(str ?? '').trim().replace(/^\[|\]$/g, '');
  if (!t) return null;
  if (t.includes(':')) { const n = ip6(t); return n === null ? null : { v: 6, n }; }
  const n = ip4(t);
  return n === null ? null : { v: 4, n };
}
export function parseCIDR(str) {
  const [addr, b] = String(str).trim().split('/');
  const ip = parseIP(addr);
  if (!ip) return null;
  const width = ip.v === 4 ? 32 : 128;
  const bits = b === undefined ? width : Number(b);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return null;
  const mask = bits === 0 ? 0n : ((1n << BigInt(width)) - 1n) ^ ((1n << BigInt(width - bits)) - 1n);
  return { v: ip.v, bits, width, mask, net: ip.n & mask, text: str.trim() };
}
export const cidrHas = (c, ip) => c && ip && c.v === ip.v && (ip.n & c.mask) === c.net;

const RANGES = [
  ['0.0.0.0/0', 'everyone', 'bad'], ['::/0', 'everyone', 'bad'],
  ['127.0.0.0/8', 'loopback', 'ok'], ['::1/128', 'loopback', 'ok'],
  ['10.0.0.0/8', 'private', 'ok'], ['172.16.0.0/12', 'private', 'ok'], ['192.168.0.0/16', 'private', 'ok'], ['fc00::/7', 'private', 'ok'],
  ['100.64.0.0/10', 'CGNAT / Tailscale', 'info'], ['169.254.0.0/16', 'link-local', 'info'], ['fe80::/10', 'link-local', 'info'],
].map(([c, label, t]) => ({ c: parseCIDR(c), label, t }));

function classify(c) {
  if (!c) return { label: 'invalid', t: 'bad' };
  if (c.bits === 0) return { label: 'everyone', t: 'bad' };
  for (const r of RANGES) if (r.c.bits > 0 && r.c.v === c.v && c.bits >= r.c.bits && (c.net & r.c.mask) === r.c.net) return r;
  return { label: 'public', t: 'warn' };
}
function sizeOf(c) {
  const host = c.width - c.bits;
  if (host === 0) return '1 address';
  if (host > 40) return `2^${host} addresses`;
  return `${num(2 ** host, 1)} addresses`;
}

// ── headers ──────────────────────────────────────────────────────────────────

const lowerKeys = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

export function headerChecks(c) {
  const resp = lowerKeys(c.customResponseHeaders);
  const has = (k) => resp[k] !== undefined && resp[k] !== '';
  const removed = (k) => resp[k] === '';
  const sts = Number(c.stsSeconds ?? 0);
  const csp = c.contentSecurityPolicy || resp['content-security-policy'] || '';
  const frame = c.frameDeny ? 'DENY' : c.customFrameOptionsValue || resp['x-frame-options'] || (/frame-ancestors/i.test(csp) ? 'via CSP frame-ancestors' : '');
  const referrer = c.referrerPolicy || resp['referrer-policy'] || '';
  const perms = c.permissionsPolicy || resp['permissions-policy'] || '';
  return [
    { id: 'hsts', label: 'HTTPS only (HSTS)', weight: 25, ok: sts >= 15_552_000 || has('strict-transport-security'), partial: sts > 0 && sts < 15_552_000,
      value: sts ? `max-age=${sts}${c.stsIncludeSubdomains ? '; includeSubDomains' : ''}${c.stsPreload ? '; preload' : ''}` : resp['strict-transport-security'],
      note: sts > 0 && sts < 15_552_000 ? 'Shorter than six months.' : 'Browsers refuse plain HTTP for this host.' },
    { id: 'frame', label: 'No framing (X-Frame-Options)', weight: 15, ok: Boolean(frame), value: frame, note: 'Stops clickjacking through iframes.' },
    { id: 'nosniff', label: 'No MIME sniffing', weight: 15, ok: Boolean(c.contentTypeNosniff || resp['x-content-type-options'] === 'nosniff'), value: c.contentTypeNosniff ? 'nosniff' : resp['x-content-type-options'], note: 'X-Content-Type-Options: nosniff.' },
    { id: 'csp', label: 'Content-Security-Policy', weight: 20, ok: Boolean(csp), partial: !csp && Boolean(c.contentSecurityPolicyReportOnly), value: csp || c.contentSecurityPolicyReportOnly, note: csp ? 'Limits where scripts and content load from.' : c.contentSecurityPolicyReportOnly ? 'Report-only: violations are reported, not blocked.' : 'The strongest defence against XSS.' },
    { id: 'referrer', label: 'Referrer-Policy', weight: 10, ok: Boolean(referrer), value: referrer, note: 'Keeps URLs from leaking to other sites.' },
    { id: 'perms', label: 'Permissions-Policy', weight: 10, ok: Boolean(perms), value: perms, note: 'Turns off camera, microphone and other browser features.' },
    { id: 'powered', label: 'Hides X-Powered-By / Server', weight: 5, ok: removed('x-powered-by') || removed('server'), value: [removed('x-powered-by') ? 'X-Powered-By' : '', removed('server') ? 'Server' : ''].filter(Boolean).join(', ') || null, note: 'Gives attackers less to go on.' },
    { id: 'xss', label: 'X-XSS-Protection', weight: 0, legacy: true, ok: Boolean(c.browserXssFilter || has('x-xss-protection')), value: c.browserXssFilter ? '1; mode=block' : resp['x-xss-protection'], note: 'Legacy: modern browsers ignore it.' },
  ];
}
export function headerGrade(c) {
  const checks = headerChecks(c);
  const active = checks.filter((x) => x.ok && !x.legacy);
  if (!active.length && !c.browserXssFilter) return null;
  const score = checks.reduce((a, x) => a + (x.ok ? x.weight : x.partial ? x.weight / 2 : 0), 0);
  const letter = score >= 95 ? 'A+' : score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F';
  const t = score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'bad';
  return { score, letter, tone: t, checks };
}
const CORS_KEYS = ['accessControlAllowOriginList', 'accessControlAllowOriginListRegex', 'accessControlAllowMethods', 'accessControlAllowHeaders', 'accessControlExposeHeaders', 'accessControlAllowCredentials', 'accessControlMaxAge'];
const hasCors = (c) => CORS_KEYS.some((k) => c[k] !== undefined);

function headersSummary(c) {
  const parts = [];
  const sec = headerChecks(c).filter((x) => x.ok).length;
  if (sec) parts.push(`Adds ${sec} security header${sec === 1 ? '' : 's'}`);
  if (hasCors(c)) {
    const o = [...(c.accessControlAllowOriginList ?? []), ...(c.accessControlAllowOriginListRegex ?? [])];
    parts.push(o.includes('*') ? 'CORS for any origin' : `CORS for ${plural(o.length, 'origin')}`);
  }
  const req = Object.entries(c.customRequestHeaders ?? {});
  const res = Object.entries(c.customResponseHeaders ?? {}).filter(([k, v]) => !(v === '' && /^(x-powered-by|server)$/i.test(k)));
  const set = req.filter(([, v]) => v !== '').length + res.filter(([, v]) => v !== '').length;
  const rm = req.filter(([, v]) => v === '').length + res.filter(([, v]) => v === '').length;
  if (!sec && set) parts.push(`Sets ${plural(set, 'header')}`);
  if (!sec && rm) parts.push(`removes ${rm}`);
  if (c.allowedHosts?.length) parts.push(`${plural(c.allowedHosts.length, 'allowed host')}`);
  return parts.join(', ') || 'Headers';
}

function headersView(c) {
  const out = [];
  const g = headerGrade(c);
  if (g) {
    const r = 30; const circ = 2 * Math.PI * r;
    const arc = s('circle', { cx: 36, cy: 36, r, fill: 'none', 'stroke-width': 7, 'stroke-linecap': 'round', class: `gr-grade-arc ${g.tone}`, 'stroke-dasharray': circ, 'stroke-dashoffset': circ, transform: 'rotate(-90 36 36)' });
    requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute('stroke-dashoffset', String(circ * (1 - g.score / 100)))));
    const passed = g.checks.filter((x) => x.ok && !x.legacy).length;
    out.push(h('div', { class: 'gr-grade' },
      h('div', { class: 'gr-grade-ring' }, s('svg', { width: 72, height: 72, viewBox: '0 0 72 72' }, s('circle', { cx: 36, cy: 36, r, fill: 'none', 'stroke-width': 7, class: 'gr-grade-track' }), arc), h('b', { class: `${g.tone}-text` }, g.letter)),
      h('div', { class: 'col', style: { gap: '2px' } }, h('div', { class: 'bold' }, `Security headers: ${g.letter}`), h('div', { class: 'muted small' }, `${passed} of ${g.checks.filter((x) => !x.legacy).length} protections, ${g.score} / 100 points.`),
        h('div', { class: 'tiny faint' }, 'Graded like securityheaders.com: HSTS and CSP count most.'))));
    out.push(h('div', { class: 'gr-checks' }, ...g.checks.map((x) => h('div', { class: `gr-check ${x.ok ? 'on' : x.partial ? 'part' : 'off'} ${x.legacy ? 'legacy' : ''}`.trim() },
      h('span', { class: 'gr-check-ic' }, glyph(x.ok ? 'check' : x.partial ? 'minus' : 'x', { size: 13, stroke: 2.4 })),
      h('div', { class: 'grow col', style: { gap: '1px', minWidth: '0' } },
        h('div', { class: 'row', style: { gap: '8px' } }, h('span', { class: 'bold small' }, x.label), x.legacy ? badge('legacy') : null),
        x.value ? h('code', { class: 'tiny gr-check-val' }, String(x.value)) : h('span', { class: 'tiny muted' }, x.note))))));
  }
  if (hasCors(c)) {
    const origins = [...(c.accessControlAllowOriginList ?? []), ...(c.accessControlAllowOriginListRegex ?? []).map((x) => `/${x}/`)];
    const warn = [];
    if (c.accessControlAllowCredentials && origins.includes('*')) warn.push(note('Credentials with any origin: browsers refuse this combination, and it would let every site read user data.', 'bad'));
    else if (origins.includes('*')) warn.push(note('Any site can read responses from this service with JavaScript.', 'warn'));
    out.push(section('Cross-origin requests (CORS)',
      kv([
        ['Origins', origins.length ? chipList(origins) : h('span', { class: 'muted' }, 'none')],
        c.accessControlAllowMethods ? ['Methods', chipList(c.accessControlAllowMethods)] : null,
        c.accessControlAllowHeaders ? ['Request headers', chipList(c.accessControlAllowHeaders)] : null,
        c.accessControlExposeHeaders ? ['Exposed headers', chipList(c.accessControlExposeHeaders)] : null,
        ['Credentials', yes(c.accessControlAllowCredentials, 'allowed', 'not allowed')],
        c.accessControlMaxAge !== undefined ? ['Preflight cache', `${num(c.accessControlMaxAge)} s`] : null,
        c.addVaryHeader !== undefined ? ['Vary: Origin', yes(c.addVaryHeader)] : null,
      ]), ...warn));
  }
  const table = (title, obj) => {
    const rows = Object.entries(obj ?? {});
    if (!rows.length) return null;
    return section(title, h('div', { class: 'gr-hdrs' }, ...rows.map(([k, v]) => h('div', { class: 'gr-hdr' },
      h('code', { class: 'gr-hdr-k' }, k), v === '' ? h('span', { class: 'badge bad' }, 'removed') : h('code', { class: 'gr-hdr-v' }, SECRET.test(k) ? '••••••' : String(v))))));
  };
  out.push(table('Request headers sent to the service', c.customRequestHeaders));
  out.push(table('Response headers sent to the client', c.customResponseHeaders));
  const misc = [
    c.allowedHosts?.length ? ['Allowed hosts', chipList(c.allowedHosts)] : null,
    c.hostsProxyHeaders?.length ? ['Host proxy headers', chipList(c.hostsProxyHeaders)] : null,
    c.sslProxyHeaders ? ['TLS proxy headers', chipList(Object.entries(c.sslProxyHeaders).map(([k, v]) => `${k}: ${v}`))] : null,
    c.forceSTSHeader !== undefined ? ['HSTS over HTTP too', yes(c.forceSTSHeader)] : null,
    c.isDevelopment ? ['Development mode', h('span', { class: 'warn-text bold' }, 'on: host checks are off')] : null,
    c.publicKey ? ['Public-Key-Pins', h('span', { class: 'muted' }, 'set (deprecated)')] : null,
    c.featurePolicy ? ['Feature-Policy', h('span', { class: 'muted' }, 'set (deprecated, use permissionsPolicy)')] : null,
  ].filter(Boolean);
  if (misc.length) out.push(section('Other', kv(misc)));
  if (!out.filter(Boolean).length) out.push(h('div', { class: 'muted' }, 'This headers middleware sets nothing.'));
  return out;
}

// ── visuals ──────────────────────────────────────────────────────────────────

/** Token bucket for rateLimit: burst slots, refilled at the average rate. */
function bucketVisual(avgPerSec, burst) {
  const shown = Math.min(48, Math.max(1, burst));
  const cells = Array.from({ length: shown }, (_, i) => h('i', { style: { '--i': i, '--n': shown } }));
  return h('div', { class: 'gr-bucket' },
    h('div', { class: 'gr-bucket-refill' }, glyph('down', { size: 14 }), h('span', {}, avgPerSec ? `refills ${rate(avgPerSec)} / s` : 'no refill')),
    h('div', { class: 'gr-bucket-box' }, ...cells),
    h('div', { class: 'tiny muted' }, `${num(burst)} request${burst === 1 ? '' : 's'} can arrive at once${burst > shown ? ` (${shown} shown)` : ''}; each takes a token.`));
}

function slots(amount, label) {
  const shown = Math.min(40, Math.max(1, amount));
  return h('div', { class: 'col', style: { gap: '8px' } },
    h('div', { class: 'gr-slots' }, ...Array.from({ length: shown }, (_, i) => h('i', { style: { '--i': i } })), amount > shown ? h('span', { class: 'tiny muted' }, `+${num(amount - shown)}`) : null),
    h('div', { class: 'tiny muted' }, label));
}

/** A 100-599 strip with the status ranges an errors middleware catches. */
function statusStrip(ranges) {
  const spans = ranges.flatMap((r) => String(r).split(',')).map((r) => {
    const [a, b] = r.trim().split('-').map(Number);
    return [a, Number.isFinite(b) ? b : a];
  }).filter(([a]) => Number.isFinite(a));
  const pos = (v) => `${((Math.max(100, Math.min(599, v)) - 100) / 500) * 100}%`;
  return h('div', { class: 'gr-strip' },
    h('div', { class: 'gr-strip-bar' },
      ...[1, 2, 3, 4, 5].map((c) => h('span', { class: `gr-strip-zone z${c}`, style: { left: pos(c * 100), width: '20%' } }, `${c}xx`)),
      ...spans.map(([a, b]) => h('span', { class: 'gr-strip-hit', style: { left: pos(a), width: `calc(${pos(b + 1)} - ${pos(a)})` }, title: a === b ? String(a) : `${a}-${b}` }))),
    h('div', { class: 'row wrap tiny muted', style: { gap: '6px', marginTop: '6px' } }, 'Catches', ...spans.map(([a, b]) => h('span', { class: 'chip mono' }, a === b ? String(a) : `${a}–${b}`))));
}

/** The states of a circuit breaker. */
function breakerVisual(c) {
  const fb = durText(c.fallbackDuration) ?? '10s';
  const rc = durText(c.recoveryDuration) ?? '10s';
  const cp = durText(c.checkPeriod) ?? '100ms';
  const node = (t, sub, cls) => h('div', { class: `gr-state ${cls}` }, h('b', {}, t), h('span', { class: 'tiny' }, sub));
  return h('div', { class: 'gr-states' },
    node('Closed', `checks every ${cp}`, 'ok'),
    h('div', { class: 'gr-state-arrow' }, h('span', { class: 'tiny' }, 'condition true'), glyph('arrow', { size: 16 })),
    node('Open', `answers ${c.responseCode ?? 503} for ${fb}`, 'bad'),
    h('div', { class: 'gr-state-arrow' }, h('span', { class: 'tiny' }, 'after'), glyph('arrow', { size: 16 })),
    node('Recovering', `lets traffic back over ${rc}`, 'warn'));
}

export function humanExpr(expr = '') {
  return String(expr)
    .replace(/NetworkErrorRatio\(\)\s*>\s*([\d.]+)/g, (_, v) => `network errors > ${Math.round(v * 100)}%`)
    .replace(/ResponseCodeRatio\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)\s*>\s*([\d.]+)/g, (_, a, b, c, d, v) => `${a === '500' && b === '600' ? '5xx' : `${a}-${Number(b) - 1}`} > ${Math.round(v * 100)}%${c === '0' && d === '600' ? '' : ` of ${c}-${Number(d) - 1}`}`)
    .replace(/LatencyAtQuantileMS\(\s*([\d.]+)\s*\)\s*>\s*([\d.]+)/g, (_, q, v) => `p${Number(q)} latency > ${v} ms`)
    .replace(/&&/g, 'and').replace(/\|\|/g, 'or');
}

function retryVisual(attempts, initialMs) {
  const n = Math.max(1, Math.min(12, attempts));
  const mult = n > 1 ? 2 ** (1 / (n - 1)) : 1;
  const waits = [];
  let w = initialMs ?? 0;
  for (let i = 1; i < n; i++) { waits.push(w); w *= mult; }
  const total = waits.reduce((a, b) => a + b, 0);
  return h('div', { class: 'gr-retry' },
    h('div', { class: 'gr-retry-line' }, ...Array.from({ length: n }, (_, i) => h('div', { class: 'gr-retry-step', style: { '--i': i } },
      h('span', { class: `gr-retry-dot ${i === 0 ? 'first' : ''}` }, String(i + 1)),
      i < n - 1 ? h('span', { class: 'gr-retry-gap' }, initialMs ? `≈${humanMs(waits[i])}` : 'at once') : null))),
    h('div', { class: 'tiny muted' }, initialMs ? `Waits grow from ${humanMs(initialMs)} to ${humanMs(waits[waits.length - 1] ?? initialMs)} (randomised ±50%); about ${humanMs(total)} of waiting in the worst case.` : 'No initial interval: retries happen immediately.'));
}

// ── the kinds ────────────────────────────────────────────────────────────────

export const GROUPS = {
  auth: { label: 'Access control', glyph: 'shield' },
  traffic: { label: 'Traffic shaping', glyph: 'gauge' },
  path: { label: 'Paths and redirects', glyph: 'redirect' },
  content: { label: 'Headers and content', glyph: 'heading' },
  compose: { label: 'Chains and plugins', glyph: 'link' },
};

const stripTest = (prefixes) => (p) => {
  if (!p) return { tone: 'muted', label: 'Type a path' };
  const path = p.startsWith('/') ? p : `/${p}`;
  for (const pre of prefixes) {
    if (path.startsWith(pre)) {
      let rest = path.slice(pre.length);
      if (!rest.startsWith('/')) rest = `/${rest}`;
      return { tone: 'ok', label: 'The service sees', value: rest, rows: [['X-Forwarded-Prefix', pre]] };
    }
  }
  return { tone: 'muted', label: 'No prefix matches: the path is passed on unchanged', value: path };
};

export const KINDS = {
  addPrefix: {
    label: 'Add prefix', glyph: 'prefixAdd', hue: 168, group: 'path', desc: 'Puts a prefix in front of the path before the request reaches the service.',
    summary: (c) => `Adds ${c.prefix ?? '?'}`,
    render: (c) => [
      flow([{ title: '/users', sub: 'request', glyph: 'globe' }, { title: `${c.prefix ?? ''}/users`, sub: 'service sees', glyph: 'server', tone: 'on' }]),
      tester({ title: 'Try a path', value: '/users/42', run: (p) => (p ? { tone: 'ok', label: 'The service sees', value: `${(c.prefix ?? '').replace(/\/$/, '')}${p.startsWith('/') ? p : `/${p}`}` } : { tone: 'muted', label: 'Type a path' }) }),
    ],
  },
  basicAuth: {
    label: 'Basic auth', glyph: 'userLock', hue: 265, group: 'auth', desc: 'Asks for a user name and password (HTTP Basic) before letting a request through.',
    summary: (c) => (c.users?.length ? `${plural(c.users.length, 'user')}${c.realm ? ` · realm ${c.realm}` : ''}` : c.usersFile ? 'Users from a file' : 'No users'),
    render: (c) => authView(c, 'basic'),
  },
  digestAuth: {
    label: 'Digest auth', glyph: 'fingerprint', hue: 280, group: 'auth', desc: 'HTTP Digest authentication: like basic auth, without sending the password itself.',
    summary: (c) => (c.users?.length ? plural(c.users.length, 'user') : c.usersFile ? 'Users from a file' : 'No users'),
    render: (c) => authView(c, 'digest'),
  },
  forwardAuth: {
    label: 'Forward auth', glyph: 'shieldArrow', hue: 248, group: 'auth', desc: 'Asks another service whether each request is allowed: SSO, OAuth proxies, Authelia, Authentik.',
    summary: (c) => { try { return `Asks ${new URL(c.address).host}`; } catch { return c.address ? `Asks ${maskUrl(c.address)}` : 'No address'; } },
    render: (c) => {
      let host = c.address;
      try { host = new URL(c.address).host; } catch { /* not a URL */ }
      return [
        flow([{ title: 'Request', sub: 'arrives', glyph: 'globe' }, { title: host ?? '?', sub: 'auth server', glyph: 'shieldArrow', tone: 'on' }, { title: '2xx', sub: 'passed on to the service', glyph: 'check', tone: 'ok' }]),
        h('div', { class: 'tiny muted' }, 'Any other answer from the auth server goes straight back to the client, with its body and headers.'),
        section('Auth server', kv([
          ['Address', h('code', { class: 'small' }, maskUrl(c.address ?? ''))],
          ['Trust X-Forwarded-*', c.trustForwardHeader ? h('span', { class: 'warn-text bold' }, 'yes') : yes(false)],
          c.forwardBody !== undefined ? ['Sends the body', yes(c.forwardBody)] : null,
          c.maxBodySize !== undefined ? ['Max body', c.maxBodySize < 0 ? 'unlimited' : bytes(c.maxBodySize)] : null,
          c.preserveRequestMethod !== undefined ? ['Keeps the method', yes(c.preserveRequestMethod)] : null,
          c.preserveLocationHeader !== undefined ? ['Keeps Location', yes(c.preserveLocationHeader)] : null,
          c.addAuthCookiesToResponse?.length ? ['Cookies to client', chipList(c.addAuthCookiesToResponse)] : null,
          c.headerField ? ['User header', mono(c.headerField)] : null,
          c.tls ? ['TLS', h('span', {}, [c.tls.ca ? 'custom CA' : null, c.tls.cert ? 'client cert' : null, c.tls.insecureSkipVerify ? h('span', { class: 'bad-text bold' }, 'verification off') : null].filter(Boolean).flatMap((x, i) => [i ? ' · ' : '', x]))] : null,
        ])),
        c.authRequestHeaders?.length ? section('Headers sent to the auth server', chipList(c.authRequestHeaders)) : section('Headers sent to the auth server', h('span', { class: 'muted small' }, 'All of the request\'s headers.')),
        c.authResponseHeaders?.length || c.authResponseHeadersRegex ? section('Headers copied to the request', chipList([...(c.authResponseHeaders ?? []), ...(c.authResponseHeadersRegex ? [`/${c.authResponseHeadersRegex}/`] : [])])) : null,
        c.trustForwardHeader ? note('trustForwardHeader passes the client\'s own X-Forwarded-* headers on: only safe behind a proxy you trust.', 'warn') : null,
        c.tls?.insecureSkipVerify ? note('TLS verification is off: anyone in between could answer as the auth server.', 'bad') : null,
      ];
    },
  },
  ipAllowList: {
    label: 'IP allow list', glyph: 'listCheck', hue: 199, group: 'auth', desc: 'Lets in only clients from the listed addresses and ranges; everyone else gets 403.',
    summary: (c) => ipSummary(c), render: (c) => ipView(c),
  },
  ipWhiteList: {
    label: 'IP allow list (legacy name)', glyph: 'listCheck', hue: 199, group: 'auth', desc: 'The old name of ipAllowList, removed in Traefik v3: rename it.',
    summary: (c) => ipSummary(c), render: (c) => [note('ipWhiteList is the v2 name: Traefik v3 calls it ipAllowList.', 'warn'), ...ipView(c)],
  },
  passTLSClientCert: {
    label: 'Pass client certificate', glyph: 'idCard', hue: 186, group: 'auth', desc: 'Forwards the client\'s TLS certificate (mTLS) to the service in a header.',
    summary: (c) => (c.pem ? 'Forwards the certificate (PEM)' : c.info ? 'Forwards certificate details' : 'Forwards nothing'),
    render: (c) => {
      const info = c.info ?? {};
      const flat = [];
      for (const [k, v] of Object.entries(info)) {
        if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v)) flat.push([`${k}.${k2}`, v2]);
        else flat.push([k, v]);
      }
      return [
        kv([['PEM certificate', yes(c.pem, 'X-Forwarded-Tls-Client-Cert', 'no')], ['Details', flat.some(([, v]) => v) ? mono('X-Forwarded-Tls-Client-Cert-Info') : h('span', { class: 'muted' }, 'none')]]),
        flat.length ? section('Details included', h('div', { class: 'chips' }, ...flat.map(([k, v]) => h('span', { class: `chip ${v ? 'gr-chip-on' : 'gr-chip-off'}` }, glyph(v ? 'check' : 'x', { size: 12 }), k)))) : null,
      ];
    },
  },

  rateLimit: {
    label: 'Rate limit', glyph: 'gauge', hue: 36, group: 'traffic', desc: 'Caps how fast each client can send requests; the rest get 429 Too Many Requests.',
    summary: (c) => {
      const per = goDur(c.period ?? '1s') || 1000;
      if (!c.average) return 'No limit (average 0)';
      return per === 1000 ? `${num(c.average)} req/s, burst ${num(c.burst ?? 1)}` : `${num(c.average)} per ${durText(c.period)}, burst ${num(c.burst ?? 1)}`;
    },
    render: (c, mw) => {
      const per = goDur(c.period ?? '1s') || 1000;
      const avg = c.average ? (c.average / per) * 1000 : 0;
      const burst = c.burst ?? 1;
      const use = mw ? mwUsage(mw.name, mw.proto ?? 'http') : [];
      return [
        h('div', { class: 'gr-big3' },
          h('div', {}, h('b', {}, c.average ? rate(avg) : '∞'), h('span', {}, 'requests / s sustained')),
          h('div', {}, h('b', {}, num(burst)), h('span', {}, 'burst')),
          h('div', {}, h('b', {}, durText(c.period ?? '1s')), h('span', {}, `period (${num(c.average ?? 0)} per period)`))),
        bucketVisual(avg, burst),
        section('Counted per', h('div', { class: 'small' }, criterionText(c.sourceCriterion))),
        use.length ? section('Traffic now, on the routers using it', ...use.map((u) => {
          const p = live('router', u.router.name);
          const v = p?.rps ?? 0;
          const fill = h('span', { class: v > avg && avg ? 'over' : '', style: { width: '0%' } });
          requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${Math.max(1.5, Math.min(100, avg ? (v / avg) * 100 : 0))}%`; }));
          return h('a', { class: 'gr-meter', href: hrefFor('routers', u.router.name, mw.proto ?? 'http') },
            h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('span', { class: 'small bold' }, split(u.router.name).base), h('span', { class: 'tiny muted tnum' }, `${rate(v)} / ${rate(avg)} req/s`)),
            h('div', { class: 'gr-meter-bar' }, fill));
        }), h('div', { class: 'tiny faint' }, 'Totals across all clients: the limit applies to each client on its own.')) : null,
        c.redis ? section('Shared state', kv([['Redis', chipList(c.redis.endpoints ?? [])], c.redis.db !== undefined ? ['Database', String(c.redis.db)] : null])) : null,
      ];
    },
  },
  inFlightReq: {
    label: 'In-flight requests', glyph: 'hourglass', hue: 22, group: 'traffic', desc: 'Caps how many requests from one source can be in progress at once.',
    summary: (c) => `${num(c.amount ?? 0)} at once per ${criterionShort(c.sourceCriterion)}`,
    render: (c) => [slots(c.amount ?? 0, `${num(c.amount ?? 0)} requests can be in progress at once; request ${num((c.amount ?? 0) + 1)} gets 429 until one finishes.`), section('Counted per', h('div', { class: 'small' }, criterionText(c.sourceCriterion)))],
  },
  inFlightConn: {
    label: 'In-flight connections', glyph: 'cable', hue: 22, group: 'traffic', desc: 'Caps how many TCP connections one client IP can hold open at once.',
    summary: (c) => `${num(c.amount ?? 0)} connections per IP`,
    render: (c) => [slots(c.amount ?? 0, `${num(c.amount ?? 0)} open connections per client IP; more are closed straight away.`)],
  },
  circuitBreaker: {
    label: 'Circuit breaker', glyph: 'plug', hue: 4, group: 'traffic', desc: 'Stops sending traffic to a struggling service for a while, so it can recover.',
    summary: (c) => (c.expression ? `Opens when ${humanExpr(c.expression)}` : 'No condition'),
    render: (c) => [
      h('div', { class: 'gr-expr' }, h('span', { class: 'tiny muted' }, 'Opens when'), h('b', {}, humanExpr(c.expression ?? '')), h('code', { class: 'tiny faint' }, c.expression ?? '')),
      breakerVisual(c),
      kv([['Check period', durText(c.checkPeriod) ?? '100ms (default)'], ['Fallback', durText(c.fallbackDuration) ?? '10s (default)'], ['Recovery', durText(c.recoveryDuration) ?? '10s (default)'], ['Answer while open', String(c.responseCode ?? 503)]]),
    ],
  },
  retry: {
    label: 'Retry', glyph: 'retry', hue: 52, group: 'traffic', desc: 'Tries the request again, on another server, when the network fails before an answer arrives.',
    summary: (c) => `${num(c.attempts ?? 0)} attempts${c.initialInterval ? `, backoff from ${durText(c.initialInterval)}` : ''}`,
    render: (c) => [
      retryVisual(c.attempts ?? 1, goDur(c.initialInterval)),
      note('Only network errors are retried, never an HTTP error answer: a 500 from the server goes straight to the client.'),
    ],
  },
  buffering: {
    label: 'Buffering', glyph: 'inbox', hue: 96, group: 'traffic', desc: 'Reads whole requests (and responses) into memory or disk first, and can cap their size.',
    summary: (c) => {
      if (c.maxRequestBodyBytes) return `Request body up to ${bytes(c.maxRequestBodyBytes)}`;
      if (c.maxResponseBodyBytes) return `Response body up to ${bytes(c.maxResponseBodyBytes)}`;
      return 'Buffers bodies, no size limit';
    },
    render: (c) => {
      const row = (label, max, mem) => h('div', { class: 'gr-buf' },
        h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('span', { class: 'bold small' }, label), h('span', { class: 'tiny muted' }, max ? `over ${bytes(max)} → ${label === 'Request' ? '413' : '500'}` : 'no size limit')),
        h('div', { class: 'gr-buf-bar' }, h('span', { class: 'mem', style: { width: max ? `${Math.min(100, ((mem ?? 1_048_576) / max) * 100)}%` : '30%' } }, 'memory'), h('span', { class: 'disk' }, max ? 'disk' : 'disk, unbounded')),
        h('div', { class: 'tiny muted' }, `Kept in memory up to ${bytes(mem ?? 1_048_576)}, then on disk.`));
      return [row('Request', c.maxRequestBodyBytes, c.memRequestBodyBytes), row('Response', c.maxResponseBodyBytes, c.memResponseBodyBytes),
        c.retryExpression ? section('Retries when', h('code', { class: 'small' }, c.retryExpression)) : null];
    },
  },

  stripPrefix: {
    label: 'Strip prefix', glyph: 'scissors', hue: 150, group: 'path', desc: 'Removes a prefix from the path, so a service mounted at /api sees /.',
    summary: (c) => `Strips ${(c.prefixes ?? []).join(', ') || 'nothing'}`,
    render: (c) => [
      section('Prefixes, tried in order', chipList(c.prefixes ?? [])),
      tester({ title: 'Try a path', value: `${(c.prefixes ?? ['/'])[0].replace(/\/$/, '')}/users/42`, run: stripTest(c.prefixes ?? []) }),
      c.forceSlash !== undefined ? note('forceSlash is deprecated and ignored in Traefik v3.', 'warn') : null,
    ],
  },
  stripPrefixRegex: {
    label: 'Strip prefix (regex)', glyph: 'regex', hue: 142, group: 'path', desc: 'Removes the part of the path that a regular expression matches at its start.',
    summary: (c) => `Strips ${(c.regex ?? []).join(', ')}`,
    render: (c) => [
      section('Expressions', chipList(c.regex ?? [])),
      tester({ title: 'Try a path', value: '/api/v2/users', run: (p) => {
        if (!p) return { tone: 'muted', label: 'Type a path' };
        for (const src of c.regex ?? []) {
          const m = goRegex(src).exec(p);
          if (m && m.index === 0 && m[0]) {
            let rest = p.slice(m[0].length);
            if (!rest.startsWith('/')) rest = `/${rest}`;
            return { tone: 'ok', label: 'The service sees', value: rest, rows: [['X-Forwarded-Prefix', m[0]], ['matched', src]] };
          }
        }
        return { tone: 'muted', label: 'No expression matches at the start: unchanged', value: p };
      } }),
    ],
  },
  replacePath: {
    label: 'Replace path', glyph: 'swap', hue: 176, group: 'path', desc: 'Swaps the whole path for a fixed one; the original goes in X-Replaced-Path.',
    summary: (c) => `Replaces the path with ${c.path ?? '?'}`,
    render: (c) => [
      flow([{ title: '/any/path', sub: 'request', glyph: 'globe' }, { title: c.path ?? '?', sub: 'service sees', glyph: 'server', tone: 'on' }]),
      tester({ title: 'Try a path', value: '/old/page', run: (p) => (p ? { tone: 'ok', label: 'The service sees', value: c.path, rows: [['X-Replaced-Path', p]] } : { tone: 'muted', label: 'Type a path' }) }),
    ],
  },
  replacePathRegex: {
    label: 'Replace path (regex)', glyph: 'regex', hue: 182, group: 'path', desc: 'Rewrites the path with a regular expression and a replacement.',
    summary: (c) => `${c.regex ?? '?'} → ${c.replacement ?? ''}`,
    render: (c) => [
      kv([['Regex', h('code', { class: 'small' }, c.regex ?? '')], ['Replacement', h('code', { class: 'small' }, c.replacement ?? '')]]),
      tester({ title: 'Try a path', value: guessPath(c.regex), run: (p) => {
        if (!p) return { tone: 'muted', label: 'Type a path' };
        const re = goRegex(c.regex, 'g');
        if (!goRegex(c.regex).test(p)) return { tone: 'muted', label: 'No match: unchanged', value: p };
        return { tone: 'ok', label: 'The service sees', value: p.replace(re, goReplacement(c.replacement)), rows: [['X-Replaced-Path', p]] };
      } }),
    ],
  },
  redirectRegex: {
    label: 'Redirect (regex)', glyph: 'redirect', hue: 322, group: 'path', desc: 'Sends the client elsewhere when the full URL matches a regular expression.',
    summary: (c) => `${shortUrlRe(c.regex)} → ${String(c.replacement ?? '').replace(/\$\{?\w+\}?/g, '*')}${c.permanent ? ', permanent' : ''}`,
    render: (c, mw) => {
      const re = (() => { try { return goRegex(c.regex); } catch { return null; } })();
      const hosts = sampleHosts(mw);
      const start = hosts.flatMap((x) => [`https://${x}/products?id=7`, `http://${x}/`]).find((u) => re?.test(u)) ?? guessUrl(c.regex);
      return [
        kv([['Regex', h('code', { class: 'small' }, c.regex ?? '')], ['Replacement', h('code', { class: 'small' }, c.replacement ?? '')], ['Status', permText(c.permanent)]]),
        tester({ title: 'Try a URL', value: start, help: 'the full URL: scheme, host, path and query', run: (u) => {
          if (!u) return { tone: 'muted', label: 'Type a URL' };
          if (!re) return { tone: 'bad', label: 'This regex does not compile in JavaScript' };
          if (!re.test(u)) return { tone: 'muted', label: 'No match: the request goes on to the service', value: u };
          return { tone: 'ok', label: `Redirects (${c.permanent ? '301 / 308' : '302 / 307'}) to`, value: u.replace(goRegex(c.regex, 'g'), goReplacement(c.replacement)) };
        } }),
      ];
    },
  },
  redirectScheme: {
    label: 'Redirect scheme', glyph: 'lockArrow', hue: 332, group: 'path', desc: 'Sends the client to the same URL with another scheme, usually http to https.',
    summary: (c) => `Redirects to ${c.scheme ?? 'https'}${c.port ? `:${c.port}` : ''}, ${c.permanent ? 'permanent' : 'temporary'}`,
    render: (c, mw) => {
      const host = sampleHosts(mw)[0] ?? 'example.com';
      return [
        flow([{ title: `http://${host}/`, sub: 'request', glyph: 'unlock' }, { title: `${c.scheme ?? 'https'}://${host}${c.port ? `:${c.port}` : ''}/`, sub: permText(c.permanent, true), glyph: 'lock', tone: 'ok' }]),
        kv([['Scheme', mono(c.scheme ?? 'https')], ['Port', c.port ? mono(c.port) : h('span', { class: 'muted' }, 'the scheme\'s default')], ['Status', permText(c.permanent)]]),
        tester({ title: 'Try a URL', value: `http://${host}/login?next=/`, run: (u) => {
          let url;
          try { url = new URL(u); } catch { return { tone: 'muted', label: 'Type a full URL' }; }
          const want = c.scheme ?? 'https';
          if (url.protocol === `${want}:` && (!c.port || url.port === String(c.port))) return { tone: 'muted', label: `Already ${want}: no redirect`, value: u };
          url.protocol = `${want}:`;
          url.port = c.port ? String(c.port) : '';
          return { tone: 'ok', label: `Redirects (${c.permanent ? '301 / 308' : '302 / 307'}) to`, value: url.toString() };
        } }),
      ];
    },
  },

  headers: {
    label: 'Headers', glyph: 'heading', hue: 212, group: 'content', desc: 'Adds, changes or removes headers: security headers, CORS, custom headers.',
    summary: (c) => headersSummary(c), render: (c) => headersView(c),
  },
  compress: {
    label: 'Compress', glyph: 'shrink', hue: 128, group: 'content', desc: 'Compresses responses (gzip, Brotli, zstd) for clients that accept it.',
    summary: (c) => `${(c.encodings ?? ['gzip', 'br', 'zstd']).join(', ')}${c.minResponseBodyBytes ? `, from ${bytes(c.minResponseBodyBytes)}` : ''}`,
    render: (c) => [
      section('Encodings, preferred first', h('div', { class: 'chips' }, ...(c.encodings ?? ['gzip', 'br', 'zstd']).map((e, i) => h('span', { class: 'chip mono' }, h('b', { class: 'faint' }, String(i + 1)), e)))),
      kv([
        ['Smallest compressed', bytes(c.minResponseBodyBytes ?? 1024)],
        c.defaultEncoding ? ['When the client names none', mono(c.defaultEncoding)] : null,
        c.excludedContentTypes?.length ? ['Never compressed', chipList(c.excludedContentTypes)] : null,
        c.includedContentTypes?.length ? ['Only compressed', chipList(c.includedContentTypes)] : null,
      ]),
      h('div', { class: 'tiny muted' }, 'Responses that are already compressed (images, video, zip) or carry Content-Encoding are left alone.'),
    ],
  },
  contentType: {
    label: 'Content type', glyph: 'fileType', hue: 110, group: 'content', desc: 'Decides whether Traefik guesses a missing Content-Type header.',
    summary: (c) => (c.autoDetect ? 'Guesses a missing Content-Type' : 'Never guesses Content-Type'),
    render: (c) => [kv([['Auto-detect', yes(c.autoDetect, 'on', 'off')]]), h('div', { class: 'small muted' }, c.autoDetect ? 'When a response has no Content-Type, Traefik sniffs the body and sets one.' : 'Responses without a Content-Type keep none, which is what nosniff expects.')],
  },
  grpcWeb: {
    label: 'gRPC-Web', glyph: 'radio', hue: 232, group: 'content', desc: 'Translates gRPC-Web calls from browsers into gRPC for the service.',
    summary: (c) => (c.allowOrigins?.length ? `gRPC-Web for ${c.allowOrigins.join(', ')}` : 'gRPC-Web'),
    render: (c) => [kv([['Allowed origins', c.allowOrigins?.length ? chipList(c.allowOrigins) : h('span', { class: 'muted' }, 'none set')]]), c.allowOrigins?.includes('*') ? note('Any origin can call this service from a browser.', 'warn') : null],
  },
  errors: {
    label: 'Error pages', glyph: 'octagon', hue: 356, group: 'content', desc: 'Replaces error answers from the service with a page from another service.',
    summary: (c) => `${(c.status ?? []).join(', ')} → ${split(c.service ?? '?').base}${c.query ?? ''}`,
    render: (c, mw) => {
      const svcName = c.service ? qualify(c.service, mw?.provider ?? 'file') : null;
      const svc = svcName ? findService(svcName, 'http') : null;
      const health = svcName ? healthOf(svcName, 'http') : 'missing';
      const sample = (c.query ?? '/{status}').replace('{status}', '503').replace('{url}', encodeURIComponent('/page')).replace('{originalStatus}', '503');
      return [
        statusStrip(c.status ?? []),
        flow([{ title: 'Service answers 503', sub: 'error', glyph: 'xcircle', tone: 'bad' }, { title: split(svcName ?? '?').base, sub: `GET ${sample}`, glyph: 'service', tone: svc ? 'on' : 'bad' }, { title: 'Client', sub: 'gets that page, status 503', glyph: 'globe' }]),
        kv([
          ['Error service', svcName ? h('a', { class: 'gr-link', href: hrefFor('services', svcName, 'http') }, split(svcName).base, h('span', { class: `dot ${health === 'up' ? 'ok' : health === 'down' || health === 'missing' ? 'bad' : health === 'partial' ? 'warn' : ''}` })) : '—'],
          ['Query', h('code', { class: 'small' }, c.query ?? '/')],
          c.statusRewrites ? ['Status rewrites', chipList(Object.entries(c.statusRewrites).map(([k, v]) => `${k} → ${v}`))] : null,
        ]),
        !svc && svcName ? note(`The error service ${svcName} does not exist.`, 'bad') : null,
      ];
    },
  },

  chain: {
    label: 'Chain', glyph: 'link', hue: 44, group: 'compose', desc: 'A named list of middlewares, reused as one.',
    summary: (c) => `${plural((c.middlewares ?? []).length, 'middleware')}: ${(c.middlewares ?? []).map((x) => split(x).base).join(' → ')}`,
    render: (c, mw) => [h('div', { class: 'gr-pipe' }, ...(c.middlewares ?? []).flatMap((n, i) => {
      const q = qualify(n, mw?.provider ?? 'file');
      const m = findMiddleware(q, mw?.proto ?? 'http');
      const k = m ? kindOf(m) : null;
      return [i ? h('span', { class: 'gr-pipe-arrow' }, glyph('chevron', { size: 14 })) : null,
        m ? h('a', { class: 'gr-pipe-step gr-tone', style: tone(k.hue), href: hrefFor('middlewares', q, mw?.proto ?? 'http') }, h('span', { class: 'gr-pipe-n' }, String(i + 1)), glyph(k.glyph, { size: 14 }), h('span', { class: 'ellipsis' }, split(q).base))
          : h('span', { class: 'gr-pipe-step missing' }, h('span', { class: 'gr-pipe-n' }, String(i + 1)), glyph('ghost', { size: 14 }), h('span', {}, split(q).base), badge('missing', 'bad'))];
    }))],
  },
  plugin: {
    label: 'Plugin', glyph: 'puzzle', hue: 296, group: 'compose', desc: 'A middleware from a Traefik plugin (Yaegi or WebAssembly).',
    summary: (c) => `Plugin ${Object.keys(c ?? {})[0] ?? '?'}`,
    render: (c) => {
      const [name, cfg] = Object.entries(c ?? {})[0] ?? ['?', {}];
      return [kv([['Plugin', h('b', {}, name)], ['Settings', String(Object.keys(cfg ?? {}).length)]]), rawView(cfg ?? {})];
    },
  },
};

const UNKNOWN = { label: 'Middleware', glyph: 'middleware', hue: 220, group: 'compose', desc: '', summary: () => '', render: (c) => [rawView(c)] };

/** The kind of a middleware object (or a kind name). */
export function kindOf(m) {
  const k = typeof m === 'string' ? m : mwKind(m);
  if (KINDS[k]) return { key: k, ...KINDS[k] };
  const found = Object.keys(KINDS).find((x) => x.toLowerCase() === String(k).toLowerCase() || x.toLowerCase() === String(m?.type ?? '').toLowerCase());
  return found ? { key: found, ...KINDS[found] } : { key: k, ...UNKNOWN, label: k };
}

export function summaryOf(m) {
  const k = kindOf(m);
  const cfg = m[k.key] ?? m[Object.keys(m).find((x) => x.toLowerCase() === k.key.toLowerCase())] ?? {};
  try { return k.summary(cfg, m) || k.label; } catch { return k.label; }
}

export function renderKind(m) {
  const k = kindOf(m);
  const cfg = m[k.key] ?? m[Object.keys(m).find((x) => x.toLowerCase() === k.key.toLowerCase())] ?? {};
  return k.render(cfg, m).flat().filter(Boolean);
}

// ── helpers used above ───────────────────────────────────────────────────────

function authView(c, mode) {
  const users = (c.users ?? []).map((line) => {
    const parts = String(line).split(':');
    const hash = parts[parts.length - 1] ?? '';
    return { user: parts[0], realm: mode === 'digest' ? parts[1] : null, algo: mode === 'digest' ? 'MD5 digest' : hashAlgo(hash), hint: hashHint(hash) };
  });
  const weak = users.filter((u) => weakAlgo(u.algo));
  return [
    users.length ? section(`${plural(users.length, 'user')}`, h('div', { class: 'gr-users' }, ...users.map((u) => h('div', { class: 'gr-user' },
      h('span', { class: 'gr-avatar' }, (u.user || '?').slice(0, 1).toUpperCase()),
      h('div', { class: 'grow col', style: { gap: '0', minWidth: '0' } }, h('b', { class: 'ellipsis' }, u.user), h('code', { class: 'tiny faint' }, u.hint)),
      u.realm ? badge(u.realm) : null,
      badge(u.algo, weakAlgo(u.algo) ? 'warn' : 'ok'))))) : null,
    kv([
      c.usersFile ? ['Users file', h('code', { class: 'small' }, c.usersFile)] : null,
      ['Realm', c.realm ? mono(c.realm) : h('span', { class: 'muted' }, 'traefik (default)')],
      ['Strips Authorization', yes(c.removeHeader, 'yes, the service never sees it', 'no, the service sees it')],
      c.headerField ? ['User name header', mono(c.headerField)] : null,
    ]),
    weak.length ? note(`${weak.length === users.length ? 'Every' : `${weak.length} of ${users.length}`} password hash${weak.length === 1 ? ' uses' : 'es use'} ${weak[0].algo}, which is fast to crack: htpasswd -B makes bcrypt hashes.`, 'warn') : null,
    h('div', { class: 'tiny faint' }, 'Password hashes are never shown in full.'),
  ];
}

function ipSummary(c) {
  const r = c.sourceRange ?? [];
  if (!r.length) return 'Allows nobody';
  return `Allows ${r.slice(0, 2).join(', ')}${r.length > 2 ? ` +${r.length - 2}` : ''}`;
}

function ipView(c) {
  const ranges = (c.sourceRange ?? []).map((t) => ({ t, c: parseCIDR(t) }));
  const st = c.ipStrategy;
  const strategy = !st ? 'The address of the TCP connection (the client, or the proxy in front of Traefik).'
    : st.ipv6Subnet ? `IPv6 clients grouped by /${st.ipv6Subnet}.`
      : st.depth ? `The ${ordinal(st.depth)} address from the right in X-Forwarded-For.`
        : st.excludedIPs?.length ? `The first address in X-Forwarded-For that is not ${st.excludedIPs.join(', ')}.` : 'The connection address.';
  return [
    h('div', { class: 'gr-cidrs' }, ...ranges.map(({ t, c: cc }) => {
      const k = classify(cc);
      return h('div', { class: 'gr-cidr', dataset: { cidr: t } },
        h('code', { class: 'bold' }, t),
        h('span', { class: `badge ${k.t}` }, k.label),
        h('span', { class: 'tiny muted grow', style: { textAlign: 'right' } }, cc ? sizeOf(cc) : 'not a valid range'));
    })),
    ranges.some((r) => r.c?.bits === 0) ? note('0.0.0.0/0 or ::/0 lets everyone in: the list does nothing.', 'bad') : null,
    tester({ title: 'Is this address allowed?', value: '10.1.2.3', placeholder: '203.0.113.7 or 2001:db8::1', run: (v) => {
      if (!v) return { tone: 'muted', label: 'Type an IP address' };
      const ip = parseIP(v);
      if (!ip) return { tone: 'bad', label: 'Not an IP address' };
      const hit = ranges.find((r) => cidrHas(r.c, ip));
      return hit ? { tone: 'ok', label: 'Allowed by', value: hit.t } : { tone: 'bad', label: `Rejected with ${c.rejectStatusCode ?? 403}`, value: 'no range matches' };
    } }),
    section('Client address taken from', h('div', { class: 'small' }, strategy)),
    c.rejectStatusCode ? kv([['Rejected with', String(c.rejectStatusCode)]]) : null,
  ];
}

const ordinal = (n) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

function criterionText(sc) {
  if (!sc) return 'Client IP (the connection address).';
  if (sc.requestHeaderName) return `The value of the ${sc.requestHeaderName} header.`;
  if (sc.requestHost) return 'The requested host: one budget per site.';
  if (sc.ipStrategy?.depth) return `Client IP, the ${ordinal(sc.ipStrategy.depth)} from the right in X-Forwarded-For.`;
  if (sc.ipStrategy?.excludedIPs?.length) return `Client IP from X-Forwarded-For, skipping ${sc.ipStrategy.excludedIPs.join(', ')}.`;
  return 'Client IP.';
}
function criterionShort(sc) {
  if (sc?.requestHeaderName) return sc.requestHeaderName;
  if (sc?.requestHost) return 'host';
  return 'client IP';
}

const permText = (p, short = false) => (p ? (short ? 'permanent (301/308)' : 'permanent: 301, or 308 for non-GET') : (short ? 'temporary (302/307)' : 'temporary: 302, or 307 for non-GET'));

function shortUrlRe(re = '') {
  return String(re).replace(/^\^/, '').replace(/\$$/, '').replace(/\\\./g, '.').replace(/\\\//g, '/').replace(/https\?:\/\//, '').replace(/\(\.\*\)/g, '*').slice(0, 48);
}
function guessUrl(re = '') {
  let u = String(re).replace(/^\^/, '').replace(/\$$/, '').replace(/https\?/, 'https').replace(/\\\./g, '.').replace(/\\\//g, '/')
    .replace(/\(\.\*\)|\.\*/g, 'products').replace(/\(\.\+\)|\.\+/g, 'products').replace(/\[[^\]]*\]\+?\*?/g, 'a').replace(/[()?]/g, '');
  if (!/^https?:\/\//.test(u)) u = `https://example.com${u.startsWith('/') ? '' : '/'}${u}`;
  return u;
}
function guessPath(re = '') {
  const p = String(re ?? '').replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/').replace(/\(\.\*\)|\.\*/g, 'users/42').replace(/\(\.\+\)|\.\+/g, 'users').replace(/\[[^\]]*\]\+?\*?/g, '1').replace(/[()?]/g, '');
  return p.startsWith('/') ? p : `/${p}`;
}
