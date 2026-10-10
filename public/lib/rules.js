// Traefik rules: shown with colours on every page, and parsed and matched for real by the route tester.
// Covers the v3 syntax and the v2 one (ruleSyntax: v2). Nothing here touches the DOM until a view is
// built, so the parser, the matcher and the middleware simulation also run in Node (test/rules.test.mjs).

// ── display ──────────────────────────────────────────────────────────────────

/** Tokens: { type: 'fn' | 'arg' | 'op' | 'paren' | 'comma' | 'space' | 'text', value } */
export function tokenize(rule = '') {
  const out = [];
  let i = 0;
  while (i < rule.length) {
    const ch = rule[i];
    if (ch === '`' || ch === '"') {
      const end = rule.indexOf(ch, i + 1);
      const j = end < 0 ? rule.length : end + 1;
      out.push({ type: 'arg', value: rule.slice(i, j) });
      i = j;
    } else if (rule.startsWith('&&', i) || rule.startsWith('||', i)) { out.push({ type: 'op', value: rule.slice(i, i + 2) }); i += 2; }
    else if (ch === '!') { out.push({ type: 'op', value: '!' }); i++; }
    else if (ch === '(' || ch === ')') { out.push({ type: 'paren', value: ch }); i++; }
    else if (ch === ',') { out.push({ type: 'comma', value: ch }); i++; }
    else if (/\s/.test(ch)) { let j = i; while (j < rule.length && /\s/.test(rule[j])) j++; out.push({ type: 'space', value: rule.slice(i, j) }); i = j; }
    else if (/[A-Za-z]/.test(ch)) { let j = i; while (j < rule.length && /[A-Za-z0-9]/.test(rule[j])) j++; out.push({ type: rule[j] === '(' ? 'fn' : 'text', value: rule.slice(i, j) }); i = j; }
    else { out.push({ type: 'text', value: ch }); i++; }
  }
  return out;
}

// a tiny element builder, so importing this file never needs the DOM
function el(tag, cls, children = [], title) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (title) e.title = title;
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

function tokenNodes(text) {
  return tokenize(text).map((t) => {
    if (t.type === 'fn') return el('span', 'fn', [t.value]);
    if (t.type === 'arg') return el('span', 'arg', [t.value]);
    if (t.type === 'op') return el('span', 'op', [t.value === '&&' ? ' && ' : t.value === '||' ? ' || ' : '!']);
    if (t.type === 'paren') return el('span', 'paren', [t.value]);
    if (t.type === 'space') return ' ';
    return t.value;
  });
}

/** A rule as coloured inline code. */
export function ruleView(rule, { cls = '' } = {}) {
  if (!rule) return el('span', 'muted small', ['no rule (catches everything on its entry points)']);
  return el('code', `rule ${cls}`.trim(), tokenNodes(rule));
}

/**
 * A rule with every matcher coloured by how it evaluated: green when it holds, red when it does not.
 * ev is what matchRule() returns; without a parsed rule it falls back to ruleView().
 */
export function ruleViewEval(rule, ev, { cls = '' } = {}) {
  if (!rule || !ev?.ast) return ruleView(rule, { cls });
  const marks = [];
  const walk = (n, underNot) => {
    if (n.type === 'matcher') { if (!underNot) marks.push({ s: n.s, e: n.e, ok: ev.results.get(n.id), node: n }); return; }
    if (n.type === 'not') {
      if (n.expr.type === 'matcher') { marks.push({ s: n.s, e: n.expr.e, ok: ev.results.get(n.id), node: n }); return; }
      marks.push({ s: n.s, e: n.s + 1, ok: ev.results.get(n.id), node: n, bang: true });
      walk(n.expr, false);
      return;
    }
    for (const it of n.items) walk(it, false);
  };
  walk(ev.ast, false);
  marks.sort((a, b) => a.s - b.s);
  const out = [];
  let at = 0;
  for (const m of marks) {
    if (m.s > at) out.push(...tokenNodes(rule.slice(at, m.s)));
    out.push(el('span', `rt-m ${m.ok ? 'ok' : 'bad'}${m.bang ? ' bang' : ''}`, tokenNodes(rule.slice(m.s, m.e)), `${m.ok ? 'Holds' : 'Fails'}: ${explainNode(m.node)}`));
    at = m.e;
  }
  if (at < rule.length) out.push(...tokenNodes(rule.slice(at)));
  return el('code', `rule ${cls}`.trim(), out);
}

/** The hosts a rule names (Host, HostSNI, HostRegexp shown as written). */
export function hostsOf(rule = '') {
  return [...rule.matchAll(/Host(?:SNI|Regexp)?\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/[`"]([^`"]*)[`"]/g)].map((x) => x[1]));
}

/** The paths a rule names (Path, PathPrefix, PathRegexp). */
export function pathsOf(rule = '') {
  return [...rule.matchAll(/Path(?:Prefix|Regexp)?\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/[`"]([^`"]*)[`"]/g)].map((x) => x[1]));
}

// ── IP addresses ─────────────────────────────────────────────────────────────

/** An IPv4 or IPv6 address as { v: 4 | 6, n: BigInt }, or null. IPv4-mapped IPv6 counts as IPv4. */
export function parseIP(input) {
  let s = String(input ?? '').trim();
  if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']'));
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const p = s.split('.').map(Number);
    if (p.some((x) => x > 255)) return null;
    return { v: 4, n: (BigInt(p[0]) << 24n) | (BigInt(p[1]) << 16n) | (BigInt(p[2]) << 8n) | BigInt(p[3]) };
  }
  if (!s.includes(':')) return null;
  const last = s.lastIndexOf(':');
  if (s.slice(last + 1).includes('.')) {
    const v4 = parseIP(s.slice(last + 1));
    if (!v4 || v4.v !== 4) return null;
    s = `${s.slice(0, last + 1)}${(v4.n >> 16n).toString(16)}:${(v4.n & 0xffffn).toString(16)}`;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (parts.length === 1 ? missing !== 0 : missing < 1) return null;
  let n = 0n;
  for (const g of [...head, ...Array(parts.length === 2 ? missing : 0).fill('0'), ...tail]) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn, mapped: true };
  return { v: 6, n };
}

/** "10.0.0.0/8", "::1/128" or a single address, as { ip, len }; null if invalid. */
export function parseCIDR(input) {
  const [addr, bits, extra] = String(input ?? '').trim().split('/');
  if (extra !== undefined) return null;
  const ip = parseIP(addr);
  if (!ip) return null;
  const size = ip.v === 4 ? 32 : 128;
  if (bits === undefined) return { ip, len: size };
  if (!/^\d{1,3}$/.test(bits)) return null;
  let len = Number(bits);
  if (ip.mapped) len -= 96;
  if (len < 0 || len > size) return null;
  return { ip, len };
}

/** Is the address inside the range (CIDR or single address)? */
export function ipInRange(address, range) {
  const ip = typeof address === 'object' && address ? address : parseIP(address);
  const r = typeof range === 'object' && range ? range : parseCIDR(range);
  if (!ip || !r || ip.v !== r.ip.v) return false;
  const shift = BigInt((ip.v === 4 ? 32 : 128) - r.len);
  return ip.n >> shift === r.ip.n >> shift;
}

// ── regular expressions ──────────────────────────────────────────────────────

const POSIX = { alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', space: '\\s', word: '\\w', xdigit: '0-9A-Fa-f', punct: '!-\\/:-@\\[-`{-~', blank: ' \\t', cntrl: '\\x00-\\x1f\\x7f', print: ' -~', graph: '!-~' };

/** A Go (RE2) regular expression as a JS RegExp: leading (?i) flags, (?P<name>), \A, \z, [[:alpha:]]. */
export function goRegExp(src, extraFlags = '') {
  let s = String(src);
  let flags = extraFlags;
  const lead = /^\(\?([imsU]+)\)/.exec(s);
  if (lead) {
    s = s.slice(lead[0].length);
    for (const f of lead[1]) if ('ims'.includes(f) && !flags.includes(f)) flags += f;
  }
  s = s.replace(/\(\?P</g, '(?<').replace(/\\A/g, '^').replace(/\\z/g, '$').replace(/\[:(\^?)([a-z]+):\]/g, (m, neg, name) => (POSIX[name] && !neg ? POSIX[name] : m));
  try {
    return new RegExp(s, flags);
  } catch (e) {
    throw new Error(`invalid regular expression ${JSON.stringify(src)}: ${e.message.replace(/^Invalid regular expression: /, '')}`);
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** A gorilla/mux template (v2 syntax) such as `{sub:[a-z]+}.example.com` or `/users/{id}`. */
function muxTemplate(tpl, defaultPattern, { prefix = false, host = false } = {}) {
  let out = '';
  let i = 0;
  while (i < tpl.length) {
    if (tpl[i] === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < tpl.length && depth) { if (tpl[j] === '{') depth++; else if (tpl[j] === '}') depth--; j++; }
      if (depth) throw new Error(`unbalanced braces in ${JSON.stringify(tpl)}`);
      const inner = tpl.slice(i + 1, j - 1);
      const colon = inner.indexOf(':');
      out += `(?:${colon < 0 ? defaultPattern : goRegExp(inner.slice(colon + 1)).source})`;
      i = j;
    } else { out += escapeRe(tpl[i]); i++; }
  }
  return new RegExp(`^${out}${prefix ? '' : '$'}`, host ? 'i' : '');
}

// ── parsing ──────────────────────────────────────────────────────────────────

export class RuleError extends Error {
  constructor(message, pos = 0, end = pos + 1) { super(message); this.name = 'RuleError'; this.pos = pos; this.end = end; }
}

const ANY = Infinity;
/** Matcher name -> [min args, max args], per protocol and syntax. */
export const MATCHERS = {
  http: {
    v3: { Host: [1, 1], HostRegexp: [1, 1], Path: [1, 1], PathPrefix: [1, 1], PathRegexp: [1, 1], Method: [1, 1], Header: [2, 2], HeaderRegexp: [2, 2], Query: [1, 2], QueryRegexp: [1, 2], ClientIP: [1, 1] },
    v2: { Host: [1, ANY], HostHeader: [1, ANY], HostRegexp: [1, ANY], Path: [1, ANY], PathPrefix: [1, ANY], Method: [1, ANY], Headers: [2, 2], HeadersRegexp: [2, 2], Query: [1, ANY], ClientIP: [1, ANY] },
  },
  tcp: {
    v3: { HostSNI: [1, 1], HostSNIRegexp: [1, 1], ClientIP: [1, 1], ALPN: [1, 1] },
    v2: { HostSNI: [1, ANY], HostSNIRegexp: [1, ANY], ClientIP: [1, ANY], ALPN: [1, ANY] },
  },
};

function lex(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j < 0) throw new RuleError('A string is not closed: a ` is missing', i, src.length);
      toks.push({ t: 'str', v: src.slice(i + 1, j), s: i, e: j + 1 });
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[j + 1];
          v += { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }[n] ?? `\\${n}`;
          j += 2;
        } else v += src[j++];
      }
      if (j >= src.length) throw new RuleError('A string is not closed: a " is missing', i, src.length);
      toks.push({ t: 'str', v, s: i, e: j + 1 });
      i = j + 1;
    } else if (src.startsWith('&&', i) || src.startsWith('||', i)) { toks.push({ t: src.slice(i, i + 2), s: i, e: i + 2 }); i += 2; }
    else if (c === '!' || c === '(' || c === ')' || c === ',') { toks.push({ t: c, s: i, e: i + 1 }); i++; }
    else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /\w/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j), s: i, e: j });
      i = j;
    } else if (c === '&' || c === '|') throw new RuleError(`Use ${c}${c}, not a single ${c}`, i, i + 1);
    else if (c === "'") throw new RuleError('Values go in backticks or double quotes, not single quotes', i, i + 1);
    else throw new RuleError(`Unexpected "${c}"`, i, i + 1);
  }
  return toks;
}

/** Which syntax a router's rule uses: its own ruleSyntax, else the static default, else v3. */
export function syntaxOf(router, staticConfig) {
  const own = String(router?.ruleSyntax ?? '').toLowerCase();
  if (own === 'v2' || own === 'v3') return own;
  return String(staticConfig?.core?.defaultRuleSyntax ?? '').toLowerCase() === 'v2' ? 'v2' : 'v3';
}

/**
 * Parse a rule into a tree:
 *   { type: 'and' | 'or', items } | { type: 'not', expr } | { type: 'matcher', name, args, test(req) }
 * Every node has an id and its position in the source (s, e). Throws RuleError with a position.
 */
export function parseRule(rule, { syntax = 'v3', proto = 'http' } = {}) {
  const src = String(rule ?? '');
  const v = syntax === 'v2' ? 'v2' : 'v3';
  const kind = proto === 'tcp' ? 'tcp' : 'http';
  const table = MATCHERS[kind][v];
  const toks = lex(src);
  if (!toks.length) throw new RuleError('The rule is empty', 0, 0);
  let p = 0;
  let ids = 0;
  const at = () => toks[p];
  const what = (t) => (!t ? 'the end of the rule' : t.t === 'str' ? `the value ${JSON.stringify(t.v)}` : t.t === 'id' ? `"${t.v}"` : `"${t.t}"`);
  const fail = (msg, t) => new RuleError(msg, t?.s ?? src.length, t?.e ?? src.length);
  const expect = (type) => {
    const t = at();
    if (t?.t !== type) throw fail(`Expected "${type}" but found ${what(t)}`, t);
    p++;
    return t;
  };

  function chain(op, next) {
    const first = next();
    if (at()?.t !== op) return first;
    const items = [first];
    while (at()?.t === op) { p++; items.push(next()); }
    return { type: op === '&&' ? 'and' : 'or', items, s: first.s, e: items[items.length - 1].e, id: ids++ };
  }
  const or = () => chain('||', and);
  const and = () => chain('&&', unary);
  function unary() {
    const t = at();
    if (t?.t === '!') {
      p++;
      const expr = unary();
      return { type: 'not', expr, s: t.s, e: expr.e, id: ids++ };
    }
    return primary();
  }
  function primary() {
    const t = at();
    if (t?.t === '(') {
      p++;
      const inner = or();
      const close = expect(')');
      inner.paren = [t.s, close.e];
      return inner;
    }
    if (t?.t === 'id') {
      p++;
      if (at()?.t !== '(') throw fail(`"${t.v}" must be followed by "("`, at() ?? t);
      p++;
      const args = [];
      if (at()?.t !== ')') {
        for (;;) {
          const a = at();
          if (a?.t !== 'str') throw fail(`Expected a value in backticks but found ${what(a)}`, a);
          args.push(a);
          p++;
          if (at()?.t !== ',') break;
          p++;
        }
      }
      const close = expect(')');
      return matcher(t, args, close);
    }
    throw fail(t ? `Expected a matcher such as Host(\`example.com\`) but found ${what(t)}` : 'The rule ends too early', t);
  }
  function matcher(nameTok, argToks, close) {
    const name = nameTok.v;
    const spec = table[name];
    if (!spec) {
      const near = Object.keys(table).find((k) => k.toLowerCase() === name.toLowerCase());
      const otherV = v === 'v3' ? 'v2' : 'v3';
      const other = MATCHERS[kind][otherV][name];
      const msg = near ? `Unknown matcher ${name}: matchers are case sensitive, did you mean ${near}?`
        : other ? `${name} is ${otherV} syntax, but this rule is read as ${v}`
          : kind === 'http' && MATCHERS.tcp.v3[name] ? `${name} only works on TCP routers`
            : kind === 'tcp' && MATCHERS.http.v3[name] ? `${name} only works on HTTP routers`
              : `Unknown matcher ${name}`;
      throw new RuleError(msg, nameTok.s, nameTok.e);
    }
    const args = argToks.map((a) => a.v);
    if (args.length < spec[0] || args.length > spec[1]) {
      const want = spec[0] === spec[1] ? String(spec[0]) : spec[1] === ANY ? `at least ${spec[0]}` : `${spec[0]} or ${spec[1]}`;
      throw new RuleError(`${name} takes ${want} value${spec[1] === 1 ? '' : 's'}, got ${args.length}`, nameTok.s, close.e);
    }
    const node = { type: 'matcher', name, args, s: nameTok.s, e: close.e, id: ids++, syntax: v };
    try {
      node.test = compile(node);
    } catch (e) {
      throw new RuleError(`${name}: ${e.message}`, argToks[0]?.s ?? nameTok.s, close.e);
    }
    return node;
  }

  const ast = or();
  if (p < toks.length) {
    const t = at();
    throw fail(t.t === ')' ? 'There is a ) without a matching (' : `Unexpected ${what(t)}: join matchers with && or ||`, t);
  }
  return ast;
}

const nonAscii = (s) => /[^\x00-\x7f]/.test(s);

function hostEq(reqHost, want) {
  if (!reqHost) return false;
  if (reqHost === want) return true;
  if (want.endsWith('.') && reqHost === want.slice(0, -1)) return true;
  return reqHost.endsWith('.') && reqHost.slice(0, -1) === want;
}

function compile(n) {
  const [a, b] = n.args;
  const v2 = n.syntax === 'v2';
  switch (n.name) {
    case 'Host':
    case 'HostHeader': {
      if (n.args.some(nonAscii)) throw new Error('hosts must be ASCII (use the punycode form)');
      const want = n.args.map((x) => x.toLowerCase());
      return (r) => want.some((x) => hostEq(r.host, x));
    }
    case 'HostRegexp': {
      if (n.args.some(nonAscii)) throw new Error('hosts must be ASCII (use the punycode form)');
      const res = n.args.map((x) => (v2 ? muxTemplate(x, '[^.]+', { host: true }) : goRegExp(x)));
      return (r) => res.some((re) => re.test(r.host ?? ''));
    }
    case 'Path':
    case 'PathPrefix': {
      for (const x of n.args) if (!x.startsWith('/')) throw new Error(`the path ${JSON.stringify(x)} must start with /`);
      if (v2) {
        const res = n.args.map((x) => muxTemplate(x, '[^/]+', { prefix: n.name === 'PathPrefix' }));
        return (r) => res.some((re) => re.test(r.path ?? ''));
      }
      return n.name === 'Path' ? (r) => r.path === a : (r) => (r.path ?? '').startsWith(a);
    }
    case 'PathRegexp': {
      const re = goRegExp(a);
      return (r) => re.test(r.path ?? '');
    }
    case 'Method': {
      const want = n.args.map((x) => x.toUpperCase());
      return (r) => want.includes(String(r.method ?? '').toUpperCase());
    }
    case 'Header':
    case 'Headers': {
      const k = a.toLowerCase();
      return (r) => (r.headers?.get(k) ?? []).includes(b);
    }
    case 'HeaderRegexp':
    case 'HeadersRegexp': {
      const k = a.toLowerCase();
      const re = goRegExp(b);
      return (r) => (r.headers?.get(k) ?? []).some((x) => re.test(x));
    }
    case 'Query': {
      if (v2) {
        const pairs = n.args.map((x) => {
          const i = x.indexOf('=');
          return i < 0 ? [x, null] : [x.slice(0, i), x.slice(i + 1) ? muxTemplate(x.slice(i + 1), '.*') : null];
        });
        return (r) => pairs.every(([k, re]) => r.query?.has(k) && (!re || r.query.get(k).some((x) => re.test(x))));
      }
      const want = b ?? '';
      return (r) => r.query?.get(a)?.includes(want) ?? false;
    }
    case 'QueryRegexp': {
      if (b === undefined) return (r) => r.query?.get(a)?.includes('') ?? false;
      const re = goRegExp(b);
      return (r) => (r.query?.get(a) ?? []).some((x) => re.test(x));
    }
    case 'ClientIP': {
      const ranges = n.args.map((x) => {
        const c = parseCIDR(x);
        if (!c) throw new Error(`${JSON.stringify(x)} is not an IP address or CIDR range`);
        return c;
      });
      return (r) => {
        const ip = parseIP(r.clientIP);
        return Boolean(ip) && ranges.some((c) => ipInRange(ip, c));
      };
    }
    case 'HostSNI': {
      if (n.args.some(nonAscii)) throw new Error('server names must be ASCII (use the punycode form)');
      if (n.args.includes('*')) return () => true;
      const want = n.args.map((x) => x.toLowerCase());
      return (r) => Boolean(r.tls) && want.some((x) => hostEq(String(r.sni ?? '').toLowerCase(), x));
    }
    case 'HostSNIRegexp': {
      const res = n.args.map((x) => goRegExp(x));
      return (r) => Boolean(r.tls) && res.some((re) => re.test(String(r.sni ?? '').toLowerCase()));
    }
    case 'ALPN': {
      if (n.args.includes('acme-tls/1')) throw new Error('acme-tls/1 is reserved for Let\'s Encrypt');
      return (r) => Boolean(r.tls) && (r.alpn ?? []).some((x) => n.args.includes(x));
    }
    default: throw new Error('not supported');
  }
}

/** Evaluate every matcher (no short-circuit, so each one can be coloured). Returns { ok, results: Map(id -> bool) }. */
export function evaluate(ast, req) {
  const results = new Map();
  const walk = (n) => {
    let v;
    if (n.type === 'matcher') v = Boolean(n.test(req));
    else if (n.type === 'not') v = !walk(n.expr);
    else if (n.type === 'and') v = n.items.map(walk).every(Boolean);
    else v = n.items.map(walk).some(Boolean);
    results.set(n.id, v);
    return v;
  };
  return { ok: walk(ast), results };
}

/**
 * Parse and evaluate in one go. Never throws: { ok, ast, results, error, reasons }.
 * reasons are plain sentences saying why the rule did not match.
 */
export function matchRule(rule, req, opts = {}) {
  let ast;
  try {
    ast = parseRule(rule, opts);
  } catch (e) {
    return { ok: false, ast: null, results: new Map(), error: e, reasons: [e.message] };
  }
  const { ok, results } = evaluate(ast, req);
  return { ok, ast, results, error: null, reasons: ok ? [] : whyNot(ast, results, req) };
}

// ── plain words ──────────────────────────────────────────────────────────────

const orList = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);

/** A matcher as subject + object: "path starts with" + "/v1". neg flips it. */
function leaf(n, neg) {
  const [a, b] = n.args;
  const many = orList(n.args);
  const pick = (yes, no, obj) => ({ subj: neg ? no : yes, obj });
  switch (n.name) {
    case 'Host': case 'HostHeader': return pick('host is', 'host is not', many);
    case 'HostRegexp': return pick('host matches', 'host does not match', many);
    case 'Path': return pick('path is', 'path is not', many);
    case 'PathPrefix': return pick('path starts with', 'path does not start with', many);
    case 'PathRegexp': return pick('path matches', 'path does not match', a);
    case 'Method': return pick('method is', 'method is not', orList(n.args.map((x) => x.toUpperCase())));
    case 'Header': case 'Headers': return pick(`header ${a} is`, `header ${a} is not`, b);
    case 'HeaderRegexp': case 'HeadersRegexp': return pick(`header ${a} matches`, `header ${a} does not match`, b);
    case 'Query':
      if (n.syntax === 'v2') return pick('query has', 'query does not have', n.args.join(' and '));
      return b === undefined ? pick('query has', 'query does not have', `${a} (empty)`) : pick(`query parameter ${a} is`, `query parameter ${a} is not`, b);
    case 'QueryRegexp': return b === undefined ? pick('query has', 'query does not have', `${a} (empty)`) : pick(`query parameter ${a} matches`, `query parameter ${a} does not match`, b);
    case 'ClientIP': return n.args.some((x) => x.includes('/')) ? pick('client IP is in', 'client IP is not in', many) : pick('client IP is', 'client IP is not', many);
    case 'HostSNI': return n.args.includes('*') ? { subj: neg ? 'no connection' : 'any connection', obj: '' } : pick('server name (SNI) is', 'server name (SNI) is not', many);
    case 'HostSNIRegexp': return pick('server name (SNI) matches', 'server name (SNI) does not match', many);
    case 'ALPN': return pick('ALPN protocol is', 'ALPN protocol is not', many);
    default: return pick(`${n.name}(${n.args.join(', ')})`, `not ${n.name}(${n.args.join(', ')})`, '');
  }
}

const text = (p) => (p.obj ? `${p.subj} ${p.obj}` : p.subj);

function words(n, neg = false) {
  if (n.type === 'matcher') return text(leaf(n, neg));
  if (n.type === 'not') return words(n.expr, !neg);
  const op = (n.type === 'and') !== neg ? 'and' : 'or';
  const parts = [];
  for (const it of n.items) {
    let x = it;
    let ng = neg;
    while (x.type === 'not') { ng = !ng; x = x.expr; }
    if (x.type === 'matcher') {
      const p = leaf(x, ng);
      const prev = parts[parts.length - 1];
      if (op === 'or' && prev?.leaf && prev.leaf.subj === p.subj && p.obj) { prev.leaf.obj = `${prev.leaf.obj} or ${p.obj}`; continue; }
      parts.push({ leaf: p });
    } else {
      const innerOp = (x.type === 'and') !== ng ? 'and' : 'or';
      const inner = words(x, ng);
      parts.push({ text: innerOp === op ? inner : `${innerOp === 'or' ? 'either' : 'both'} ${inner}` });
    }
  }
  const strs = parts.map((p) => (p.leaf ? text(p.leaf) : p.text));
  if (strs.length === 1) return strs[0];
  if (strs.length === 2) return `${strs[0]} ${op} ${strs[1]}`;
  return `${strs.slice(0, -1).join(', ')}, ${op} ${strs[strs.length - 1]}`;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** One node in words, capitalised: "Path does not start with /public". */
export function explainNode(n) { return cap(words(n)); }

/** A rule in plain words: "Host is shop.localhost or www.shop.localhost". '' when it does not parse. */
export function explainRule(rule, opts = {}) {
  try { return cap(words(parseRule(rule, opts))); } catch { return ''; }
}

/** The top-level conditions of a rule, each in words: every one must hold. */
export function ruleConditions(rule, opts = {}) {
  let ast;
  try { ast = parseRule(rule, opts); } catch (e) { return { error: e, all: [] }; }
  const items = ast.type === 'and' ? ast.items : [ast];
  return { error: null, all: items.map((x) => cap(words(x))) };
}

const quote = (s) => (s === '' ? '(empty)' : s);

/** Why a matcher that failed did, for this request. */
function failText(n, r) {
  const [a, b] = n.args;
  const many = orList(n.args);
  switch (n.name) {
    case 'Host': case 'HostHeader': return r.host ? `Host is ${r.host}, not ${many}` : 'The request has no host';
    case 'HostRegexp': return `Host ${r.host || '(none)'} does not match ${many}`;
    case 'Path': return `Path is ${r.path}, not ${many}`;
    case 'PathPrefix': return `Path ${r.path} does not start with ${many}`;
    case 'PathRegexp': return `Path ${r.path} does not match ${a}`;
    case 'Method': return `Method is ${r.method}, not ${orList(n.args.map((x) => x.toUpperCase()))}`;
    case 'Header': case 'Headers': case 'HeaderRegexp': case 'HeadersRegexp': {
      const vals = r.headers?.get(a.toLowerCase());
      if (!vals?.length) return `There is no ${a} header`;
      return n.name.includes('Regexp') ? `${a} is ${vals.map(quote).join(', ')}, which does not match ${b}` : `${a} is ${vals.map(quote).join(', ')}, not ${quote(b)}`;
    }
    case 'Query': case 'QueryRegexp': {
      if (n.syntax === 'v2') return `The query does not have ${n.args.join(' and ')}`;
      const vals = r.query?.get(a);
      if (!vals) return `There is no ${a} query parameter`;
      if (b === undefined) return `${a} is ${vals.map(quote).join(', ')}, the rule wants it empty`;
      return n.name === 'QueryRegexp' ? `${a} is ${vals.map(quote).join(', ')}, which does not match ${b}` : `${a} is ${vals.map(quote).join(', ')}, not ${quote(b)}`;
    }
    case 'ClientIP': return r.clientIP ? (parseIP(r.clientIP) ? `Client IP ${r.clientIP} is not in ${many}` : `${r.clientIP} is not an IP address`) : 'No client IP given';
    case 'HostSNI': case 'HostSNIRegexp':
      if (!r.tls) return 'A plain TCP connection has no server name (SNI); only HostSNI(`*`) matches it';
      return n.name === 'HostSNI' ? `Server name is ${r.sni || '(none)'}, not ${many}` : `Server name ${r.sni || '(none)'} does not match ${many}`;
    case 'ALPN': return r.tls ? `ALPN is ${(r.alpn ?? []).join(', ') || '(none)'}, not ${many}` : 'ALPN needs TLS';
    default: return `${n.name} does not hold`;
  }
}

/** Plain sentences for why a parsed rule did not match. */
export function whyNot(ast, results, req) {
  const why = (n) => {
    if (results.get(n.id)) return [];
    if (n.type === 'matcher') return [failText(n, req)];
    if (n.type === 'not') return [`${cap(words(n.expr))}, which the rule excludes`];
    if (n.type === 'and') return n.items.flatMap(why);
    // every branch of an || failed: one sentence when they are the same kind of matcher
    const kinds = new Set(n.items.map((x) => (x.type === 'matcher' ? x.name : '')));
    if (kinds.size === 1 && !kinds.has('')) return [failText({ ...n.items[0], args: n.items.flatMap((x) => x.args) }, req)];
    return [`None of the alternatives hold: ${n.items.map((x) => why(x).join(' and ')).join('; ')}`];
  };
  return why(ast);
}

// ── requests ─────────────────────────────────────────────────────────────────

const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };

export function splitHostPort(hp = '') {
  const s = String(hp).trim();
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return { host: s.slice(1, end < 0 ? undefined : end), port: end >= 0 && s[end + 1] === ':' ? s.slice(end + 2) : '' };
  }
  const i = s.lastIndexOf(':');
  if (i >= 0 && s.indexOf(':') === i) return { host: s.slice(0, i), port: s.slice(i + 1) };
  return { host: s, port: '' };
}

/**
 * An HTTP request as the matcher sees it. headers: [[name, value]]. A Host header overrides the URL's
 * host, like curl -H 'Host: ...'. Throws on a URL that cannot be read.
 */
export function buildRequest({ url = '', method = 'GET', headers = [], clientIP = '' } = {}) {
  let raw = String(url).trim() || '/';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = raw.startsWith('/') ? `http://localhost${raw}` : `http://${raw}`;
  let u;
  try { u = new URL(raw); } catch { throw new Error('That is not a URL Traefik could receive'); }
  const scheme = u.protocol.replace(':', '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') throw new Error('Only http:// and https:// URLs reach HTTP routers');
  const hdrs = new Map();
  for (const [k, v] of headers) {
    const key = String(k ?? '').trim().toLowerCase();
    if (!key) continue;
    if (!hdrs.has(key)) hdrs.set(key, []);
    hdrs.get(key).push(String(v ?? ''));
  }
  const hostHeader = hdrs.get('host')?.[0] || u.host;
  const hp = splitHostPort(hostHeader);
  const host = hp.host.toLowerCase();
  const urlPort = u.port || (scheme === 'https' ? '443' : '80');
  let path = u.pathname || '/';
  try { path = decodeURIComponent(path); } catch { /* keep it encoded */ }
  const query = new Map();
  const rawQuery = u.search.replace(/^\?/, '');
  for (const part of rawQuery.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = dec(i < 0 ? part : part.slice(0, i));
    if (!query.has(k)) query.set(k, []);
    query.get(k).push(i < 0 ? '' : dec(part.slice(i + 1)));
  }
  return {
    method: String(method || 'GET').toUpperCase(), scheme, tls: scheme === 'https',
    host, port: urlPort, hostHeader, path, rawPath: u.pathname, rawQuery, query, headers: hdrs,
    clientIP: String(clientIP ?? '').trim(), sni: scheme === 'https' ? host : '',
  };
}

/** A TCP connection as the matcher sees it. */
export function buildConnection({ sni = '', tls = true, clientIP = '', alpn = [] } = {}) {
  return { tls: Boolean(tls), sni: tls ? String(sni).trim().toLowerCase() : '', clientIP: String(clientIP ?? '').trim(), alpn: (Array.isArray(alpn) ? alpn : String(alpn).split(',')).map((x) => x.trim()).filter(Boolean) };
}

// ── entry points and priority ────────────────────────────────────────────────

/** The port an entry point listens on, as a string ("8443"). */
export function epPort(ep) {
  const m = /:(\d+)(?:\/(tcp|udp))?$/i.exec(String(ep?.address ?? ''));
  return m ? m[1] : '';
}
export const epIsUdp = (ep) => /\/udp$/i.test(String(ep?.address ?? ''));

/** The entry point a request most likely arrives on: by port first, then by scheme. */
export function guessEntrypoint(req, entrypoints = [], internal = []) {
  const skip = new Set(internal);
  const tcp = entrypoints.filter((e) => !epIsUdp(e));
  const byPort = tcp.find((e) => epPort(e) === String(req.port));
  if (byPort) return { name: byPort.name, how: `it listens on port ${req.port}` };
  const pub = tcp.filter((e) => !skip.has(e.name));
  const secureName = (e) => /secure|https|tls|ssl/i.test(e.name);
  if (req.tls) {
    const e = pub.find((x) => epPort(x) === '443') ?? pub.find((x) => x.http?.tls) ?? pub.find(secureName);
    if (e) return { name: e.name, how: `nothing listens on ${req.port}; ${e.name} looks like the HTTPS one` };
  } else {
    const e = pub.find((x) => epPort(x) === '80') ?? pub.find((x) => /^(web|http)$/i.test(x.name)) ?? pub.find((x) => !x.http?.tls && !secureName(x));
    if (e) return { name: e.name, how: `nothing listens on ${req.port}; ${e.name} looks like the plain HTTP one` };
  }
  return pub[0] ? { name: pub[0].name, how: 'the first entry point' } : null;
}

export const MAX_PRIORITY = 2 ** 53;

/** The priority Traefik uses: the router's own, else the rule's length. */
export function priorityOf(r) {
  const p = Number(r?.priority);
  if (Number.isFinite(p) && p !== 0) return p;
  return String(r?.rule ?? '').length;
}

/** Highest priority first; huge internal priorities lose precision in JSON, so the longer rule breaks ties. */
export function byPriority(a, b) {
  const pa = priorityOf(a); const pb = priorityOf(b);
  if (pa !== pb) return pb - pa;
  const la = String(a.rule ?? '').length; const lb = String(b.rule ?? '').length;
  if (pa >= MAX_PRIORITY && la !== lb) return lb - la;
  return String(a.name).localeCompare(String(b.name));
}

export const fmtPriority = (p) => (p >= MAX_PRIORITY ? 'max' : String(p));

/**
 * Evaluate every router of an entry point for one request, in Traefik's order. Each row:
 *   { router, priority, verdict: 'winner' | 'shadowed' | 'miss' | 'skipped' | 'error', reasons, ev }
 * opts: { proto: 'http' | 'tcp', entrypoint (object), staticConfig }
 * Returns { rows, winner, ties, others } where others counts routers on other entry points.
 */
export function rankRouters(routers, req, { proto = 'http', entrypoint = null, staticConfig = null } = {}) {
  const ep = entrypoint?.name;
  const epTLS = Boolean(entrypoint?.http?.tls);
  const on = [];
  let others = 0;
  for (const r of routers) {
    const eps = r.using?.length ? r.using : r.entryPoints ?? [];
    if (ep && !eps.includes(ep)) { others++; continue; }
    on.push(r);
  }
  on.sort(byPriority);
  const rows = on.map((router) => {
    const priority = priorityOf(router);
    const row = { router, priority, verdict: 'miss', reasons: [], ev: null };
    const syntax = syntaxOf(router, staticConfig);
    if (proto === 'http') {
      row.ev = matchRule(router.rule ?? '', req, { syntax, proto: 'http' });
      if (router.status === 'disabled') { row.verdict = 'skipped'; row.reasons = [`Not loaded: ${(router.error ?? ['it has an error']).join('; ')}`]; return row; }
      const tlsRouter = Boolean(router.tls) || epTLS;
      if (tlsRouter !== req.tls) {
        row.verdict = 'skipped';
        row.reasons = [tlsRouter ? 'Only serves HTTPS (it has a tls section); this request is plain HTTP' : 'Only serves plain HTTP (no tls section); this request is HTTPS'];
        return row;
      }
    } else {
      row.ev = router.rule ? matchRule(router.rule, req, { syntax, proto: 'tcp' }) : { ok: true, ast: null, results: new Map(), reasons: [] };
      if (router.status === 'disabled') { row.verdict = 'skipped'; row.reasons = [`Not loaded: ${(router.error ?? ['it has an error']).join('; ')}`]; return row; }
      if (router.tls && !req.tls) { row.verdict = 'skipped'; row.reasons = ['Only takes TLS connections; this one is plain TCP']; return row; }
    }
    if (row.ev.error) { row.verdict = 'error'; row.reasons = [row.ev.error.message]; return row; }
    row.verdict = row.ev.ok ? 'match' : 'miss';
    row.reasons = row.ev.reasons;
    return row;
  });
  const winner = rows.find((x) => x.verdict === 'match') ?? null;
  const ties = [];
  for (const x of rows) {
    if (x.verdict !== 'match' || x === winner) continue;
    x.verdict = 'shadowed';
    if (x.priority === winner.priority && x.priority < MAX_PRIORITY) ties.push(x);
    x.reasons = [x.priority === winner.priority && x.priority < MAX_PRIORITY
      ? `Matches too, with the same priority (${x.priority}): which of the two answers is not guaranteed`
      : `Matches too, but ${winner.router.name} comes first (priority ${fmtPriority(winner.priority)} over ${fmtPriority(x.priority)})`];
  }
  if (winner) winner.verdict = 'winner';
  return { rows, winner, ties, others };
}

// ── middlewares ──────────────────────────────────────────────────────────────

const MW = {
  addprefix: ['addPrefix', 'Add prefix', 'code'],
  basicauth: ['basicAuth', 'Basic auth', 'lock'],
  buffering: ['buffering', 'Buffering', 'download'],
  chain: ['chain', 'Chain', 'layers'],
  circuitbreaker: ['circuitBreaker', 'Circuit breaker', 'activity'],
  compress: ['compress', 'Compress', 'zap'],
  contenttype: ['contentType', 'Content type', 'code'],
  digestauth: ['digestAuth', 'Digest auth', 'lock'],
  errors: ['errors', 'Error pages', 'alert'],
  forwardauth: ['forwardAuth', 'Forward auth', 'key'],
  grpcweb: ['grpcWeb', 'gRPC-Web', 'code'],
  headers: ['headers', 'Headers', 'shield'],
  ipallowlist: ['ipAllowList', 'IP allow list', 'filter'],
  ipwhitelist: ['ipWhiteList', 'IP allow list', 'filter'],
  inflightreq: ['inFlightReq', 'In-flight limit', 'activity'],
  inflightconn: ['inFlightConn', 'Connection limit', 'activity'],
  passtlsclientcert: ['passTLSClientCert', 'Client cert', 'cert'],
  ratelimit: ['rateLimit', 'Rate limit', 'clock'],
  redirectregex: ['redirectRegex', 'Redirect', 'external'],
  redirectscheme: ['redirectScheme', 'Redirect scheme', 'external'],
  replacepath: ['replacePath', 'Replace path', 'code'],
  replacepathregex: ['replacePathRegex', 'Replace path', 'code'],
  retry: ['retry', 'Retry', 'refresh'],
  stripprefix: ['stripPrefix', 'Strip prefix', 'code'],
  stripprefixregex: ['stripPrefixRegex', 'Strip prefix', 'code'],
  plugin: ['plugin', 'Plugin', 'layers'],
};

const list = (x) => (Array.isArray(x) ? x : x === undefined || x === null || x === '' ? [] : [x]);
const short = (s, n = 42) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** { type, key, label, icon, config, summary } for a middleware as the Traefik API returns it. */
export function middlewareInfo(mw) {
  if (!mw) return { type: 'missing', key: '', label: 'Missing', icon: 'xcircle', config: null, summary: 'does not exist' };
  const type = String(mw.type ?? '').toLowerCase() || Object.keys(MW).find((t) => mw[MW[t][0]] !== undefined) || 'unknown';
  const [key, label, ic] = MW[type] ?? [type, type, 'middleware'];
  const config = mw[key] ?? Object.entries(mw).find(([k]) => k.toLowerCase() === type)?.[1] ?? {};
  return { type, key, label, icon: ic, config, summary: summarize(type, config) };
}

function summarize(type, c = {}) {
  switch (type) {
    case 'addprefix': return `adds ${c.prefix ?? ''} in front of the path`;
    case 'basicauth': case 'digestauth': { const n = list(c.users).length; return n ? `asks for a password (${n} user${n === 1 ? '' : 's'})` : 'asks for a password'; }
    case 'buffering': return c.maxRequestBodyBytes ? `buffers bodies up to ${Math.round(c.maxRequestBodyBytes / 1e6)} MB` : 'buffers requests and responses';
    case 'chain': return `runs ${list(c.middlewares).length} middlewares`;
    case 'circuitbreaker': return `opens when ${short(c.expression ?? '?', 36)}`;
    case 'compress': return list(c.encodings).length ? list(c.encodings).join(', ') : 'gzip, br, zstd';
    case 'contenttype': return c.autoDetect ? 'guesses Content-Type' : 'keeps Content-Type';
    case 'errors': return `${list(c.status).join(', ')} → ${String(c.service ?? '?').replace(/@.*/, '')}`;
    case 'forwardauth': return `asks ${short(c.address ?? '?', 34)}`;
    case 'headers': {
      const cors = Object.keys(c).some((k) => k.startsWith('accessControl'));
      const sec = ['frameDeny', 'stsSeconds', 'contentTypeNosniff', 'browserXssFilter', 'contentSecurityPolicy', 'referrerPolicy', 'customFrameOptionsValue', 'permissionsPolicy'].filter((k) => c[k]).length;
      const custom = Object.keys(c.customRequestHeaders ?? {}).length + Object.keys(c.customResponseHeaders ?? {}).length;
      return [cors ? 'CORS' : '', sec ? `${sec} security header${sec === 1 ? '' : 's'}` : '', custom ? `${custom} custom` : ''].filter(Boolean).join(' · ') || 'headers';
    }
    case 'ipallowlist': case 'ipwhitelist': return `only ${short(list(c.sourceRange).join(', '), 34)}`;
    case 'inflightreq': return `max ${c.amount ?? '?'} at once`;
    case 'inflightconn': return `max ${c.amount ?? '?'} connections`;
    case 'passtlsclientcert': return 'passes the client certificate';
    case 'ratelimit': return `${c.average ?? '?'}/${String(c.period ?? '1s').replace(/^1(?=[a-z])/, '')}, burst ${c.burst ?? 1}`;
    case 'redirectregex': return `→ ${short(c.replacement ?? '?', 36)}`;
    case 'redirectscheme': return `→ ${c.scheme ?? 'https'}${c.port ? `:${c.port}` : ''}${c.permanent ? ', permanent' : ''}`;
    case 'replacepath': return `path becomes ${c.path ?? '?'}`;
    case 'replacepathregex': return `${short(c.regex ?? '?', 18)} → ${short(c.replacement ?? '?', 18)}`;
    case 'retry': return `${c.attempts ?? '?'} attempts`;
    case 'stripprefix': return `strips ${list(c.prefixes).join(', ')}`;
    case 'stripprefixregex': return `strips ${short(list(c.regex).join(', '), 34)}`;
    case 'plugin': return Object.keys(c ?? {}).join(', ') || 'plugin';
    default: return type;
  }
}

/** Go's regexp replacement ($1, ${1}, ${name}, $$) as a JS one. */
function goReplacement(rep) {
  return String(rep).replace(/\$\$|\$\{(\w+)\}|\$(\w+)/g, (m, braced, bare) => {
    if (m === '$$') return '$$';
    const name = braced ?? bare;
    return /^\d+$/.test(name) ? `$${name}` : `$<${name}>`;
  });
}

export const qualifyName = (name, provider) => (!name || name.includes('@') || !provider ? name : `${name}@${provider}`);
const providerOf = (name) => (String(name).includes('@') ? String(name).slice(String(name).lastIndexOf('@') + 1) : '');

/**
 * What happens to a request after a router matched it: every middleware in order (entry point ones
 * first, chains expanded), then the service. lookup: { middleware(name), service(name) } return the
 * API objects or null.
 *   { steps: [{ name, from, info, effect, tone, stop }], outcome }
 * outcome: { kind: 'redirect' | 'deny' | 'auth' | 'answer' | 'forward' | 'unavailable' | 'internal' | 'broken',
 *            status, location, text, path, query, backend, service, servers, trail, headers }
 */
export function simulate({ router, req, entrypoint = null, lookup, proto = 'http' }) {
  const steps = [];
  const provider = router.provider ?? providerOf(router.name);
  const names = [
    ...list(entrypoint?.http?.middlewares).map((n) => ({ name: n, from: 'entry point' })),
    ...list(router.middlewares).map((n) => ({ name: qualifyName(n, provider), from: 'router' })),
  ];
  const queue = [];
  const expand = (items, depth) => {
    for (const it of items) {
      const mw = lookup.middleware(it.name) ?? lookup.middleware(qualifyName(it.name, provider));
      const info = middlewareInfo(mw);
      if (mw && info.type === 'chain' && depth < 6) {
        queue.push({ ...it, mw, info });
        const prov = mw.provider ?? providerOf(mw.name);
        expand(list(info.config.middlewares).map((n) => ({ name: qualifyName(n, prov), from: `chain ${String(mw.name).replace(/@.*/, '')}` })), depth + 1);
      } else queue.push({ ...it, mw, info });
    }
  };
  expand(names, 0);

  let path = req.path ?? '/';
  const query = req.rawQuery ? `?${req.rawQuery}` : '';
  const headers = new Map([...(req.headers ?? new Map())].map(([k, v]) => [k, [...v]]));
  const addedHeaders = [];
  let outcome = null;
  const redirectStatus = (permanent) => (permanent ? (req.method === 'GET' ? 301 : 308) : (req.method === 'GET' ? 302 : 307));

  for (const q of queue) {
    const step = { name: q.name, from: q.from, info: q.info, effect: '', tone: '', stop: false };
    steps.push(step);
    if (outcome) { step.effect = 'Not reached'; step.tone = 'skip'; continue; }
    const c = q.info.config ?? {};
    switch (q.info.type) {
      case 'missing':
        step.effect = 'This middleware does not exist, so Traefik does not load the router';
        step.tone = 'bad'; step.stop = true;
        outcome = { kind: 'broken', status: 404, text: `${q.name} does not exist` };
        break;
      case 'chain':
        step.effect = `Runs ${list(c.middlewares).length} middlewares in order`;
        break;
      case 'redirectscheme': {
        if (proto !== 'http') break;
        const scheme = c.scheme || 'https';
        const port = c.port && !((scheme === 'http' && String(c.port) === '80') || (scheme === 'https' && String(c.port) === '443')) ? `:${c.port}` : '';
        const oldUrl = `${req.scheme}://${req.hostHeader}${req.rawPath}${query}`;
        const hostOnly = splitHostPort(req.hostHeader).host;
        const newUrl = `${scheme}://${req.hostHeader.startsWith('[') ? `[${hostOnly}]` : hostOnly}${port}${req.rawPath}${query}`;
        if (newUrl !== oldUrl) {
          const status = redirectStatus(c.permanent);
          step.effect = `Redirects to ${newUrl}`;
          step.tone = 'torch'; step.stop = true;
          outcome = { kind: 'redirect', status, location: newUrl, text: `${status} ${c.permanent ? 'permanent' : 'temporary'} redirect` };
        } else step.effect = `Already ${scheme}, passes through`;
        break;
      }
      case 'redirectregex': {
        if (proto !== 'http') break;
        const oldUrl = `${req.scheme}://${req.hostHeader}${req.rawPath}${query}`;
        let re;
        try { re = goRegExp(c.regex ?? '', 'g'); } catch (e) { step.effect = e.message; step.tone = 'bad'; break; }
        if (!re.test(oldUrl)) { step.effect = `${oldUrl} does not match its regex, passes through`; break; }
        re.lastIndex = 0;
        const newUrl = oldUrl.replace(re, goReplacement(c.replacement ?? ''));
        if (newUrl === oldUrl) { step.effect = 'Matches, but the URL stays the same, passes through'; break; }
        const status = redirectStatus(c.permanent);
        step.effect = `Redirects to ${newUrl}`;
        step.tone = 'torch'; step.stop = true;
        outcome = { kind: 'redirect', status, location: newUrl, text: `${status} ${c.permanent ? 'permanent' : 'temporary'} redirect` };
        break;
      }
      case 'stripprefix': {
        const hit = list(c.prefixes).find((p) => path.startsWith(p));
        if (hit) {
          const before = path;
          path = path.slice(hit.length);
          if (!path.startsWith('/')) path = `/${path}`;
          step.effect = `Strips ${hit}: ${before} becomes ${path}`;
          step.tone = 'info';
          addedHeaders.push(['X-Forwarded-Prefix', hit]);
        } else step.effect = `Path does not start with ${list(c.prefixes).join(' or ')}, unchanged`;
        break;
      }
      case 'stripprefixregex': {
        let done = false;
        for (const rx of list(c.regex)) {
          let re;
          try { re = goRegExp(rx); } catch { continue; }
          const m = re.exec(path);
          if (m && m.index === 0 && m[0]) {
            const before = path;
            path = path.slice(m[0].length);
            if (!path.startsWith('/')) path = `/${path}`;
            step.effect = `Strips ${m[0]}: ${before} becomes ${path}`;
            step.tone = 'info';
            addedHeaders.push(['X-Forwarded-Prefix', m[0]]);
            done = true;
            break;
          }
        }
        if (!done) step.effect = 'No prefix matches, unchanged';
        break;
      }
      case 'addprefix': {
        const before = path;
        path = `${c.prefix ?? ''}${path}`;
        step.effect = `${before} becomes ${path}`;
        step.tone = 'info';
        break;
      }
      case 'replacepath': {
        const before = path;
        path = c.path ?? path;
        step.effect = `${before} becomes ${path}`;
        step.tone = 'info';
        addedHeaders.push(['X-Replaced-Path', before]);
        break;
      }
      case 'replacepathregex': {
        let re;
        try { re = goRegExp(c.regex ?? '', 'g'); } catch (e) { step.effect = e.message; step.tone = 'bad'; break; }
        const before = path;
        if (re.test(path)) {
          re.lastIndex = 0;
          path = path.replace(re, goReplacement(c.replacement ?? ''));
          step.effect = `${before} becomes ${path}`;
          step.tone = 'info';
          addedHeaders.push(['X-Replaced-Path', before]);
        } else step.effect = 'Path does not match its regex, unchanged';
        break;
      }
      case 'ipallowlist':
      case 'ipwhitelist': {
        let ip = req.clientIP;
        const depth = Number(c.ipStrategy?.depth ?? 0);
        if (depth > 0) {
          const xff = (headers.get('x-forwarded-for') ?? []).join(',').split(',').map((s) => s.trim()).filter(Boolean);
          ip = xff.length >= depth ? xff[xff.length - depth] : '';
        }
        const ranges = list(c.sourceRange);
        const status = c.rejectStatusCode || 403;
        if (!ip) {
          step.effect = depth ? `Needs ${depth} address${depth === 1 ? '' : 'es'} in X-Forwarded-For: refused` : 'No client IP: refused';
          step.tone = 'bad'; step.stop = true;
          outcome = { kind: 'deny', status, text: 'Forbidden: no client IP to check' };
        } else if (ranges.some((r) => ipInRange(ip, r))) { step.effect = `${ip} is on the list, allowed`; step.tone = 'ok'; } else {
          step.effect = `${ip} is not in ${ranges.join(', ')}: refused`;
          step.tone = 'bad'; step.stop = true;
          outcome = { kind: 'deny', status, text: `Forbidden: ${ip} is not on the allow list` };
        }
        break;
      }
      case 'basicauth':
      case 'digestauth':
        if (!headers.has(String(c.headerField || 'authorization').toLowerCase())) {
          step.effect = 'No Authorization header: asks for a password';
          step.tone = 'warn'; step.stop = true;
          outcome = { kind: 'auth', status: 401, text: 'Unauthorized: the browser asks for a user name and password' };
        } else { step.effect = 'Checks the credentials (not verified here)'; step.tone = 'warn'; }
        break;
      case 'forwardauth':
        step.effect = `Asks ${c.address ?? 'the auth server'} first: a 2xx lets the request through, anything else goes back to the client`;
        step.tone = 'warn';
        break;
      case 'headers': {
        const preflight = req.method === 'OPTIONS' && headers.has('origin') && headers.has('access-control-request-method');
        const cors = Object.keys(c).some((k) => k.startsWith('accessControl'));
        if (preflight && cors) {
          step.effect = 'Answers the CORS preflight itself';
          step.tone = 'ok'; step.stop = true;
          outcome = { kind: 'answer', status: 200, text: 'CORS preflight answered by Traefik' };
          break;
        }
        for (const [k, val] of Object.entries(c.customRequestHeaders ?? {})) {
          if (val === '') headers.delete(k.toLowerCase());
          else { headers.set(k.toLowerCase(), [val]); addedHeaders.push([k, val]); }
        }
        step.effect = `Sets ${q.info.summary}`;
        break;
      }
      case 'ratelimit': step.effect = `Allows ${q.info.summary} per client; above that, 429`; break;
      case 'inflightreq': step.effect = `Allows ${c.amount ?? '?'} requests at once per client; above that, 429`; break;
      case 'inflightconn': step.effect = `Allows ${c.amount ?? '?'} connections at once per client`; break;
      case 'compress': step.effect = `Compresses the response (${q.info.summary}) when the client accepts it`; break;
      case 'retry': step.effect = `Retries up to ${c.attempts ?? '?'} times when the backend cannot be reached`; break;
      case 'circuitbreaker': step.effect = `Answers 503 while ${c.expression ?? 'its expression'} holds`; break;
      case 'errors': step.effect = `Replaces ${list(c.status).join(', ')} answers with ${c.service ?? '?'}${c.query ?? ''}`; break;
      case 'buffering': step.effect = 'Reads the whole request before sending it on'; break;
      default: step.effect = q.info.summary ? cap(q.info.summary) : 'Passes the request on'; break;
    }
  }

  if (!outcome) outcome = serviceOutcome(router, path, query, lookup, provider, proto);
  else { outcome.path = path; outcome.query = query; }
  outcome.headers = addedHeaders;
  return { steps, outcome };
}

/** Where a request ends up inside a service tree. */
function serviceOutcome(router, path, query, lookup, provider, proto) {
  const name = qualifyName(router.service ?? '', provider);
  if (!name) return { kind: 'broken', status: 404, text: 'The router has no service', path, query, trail: [] };
  if (/@internal$/.test(name)) {
    const what = { 'noop@internal': 'Nothing: it only exists so a middleware can answer', 'api@internal': 'Traefik\'s own API', 'dashboard@internal': 'Traefik\'s dashboard', 'ping@internal': 'Traefik\'s ping endpoint', 'prometheus@internal': 'Traefik\'s Prometheus metrics' }[name] ?? 'A Traefik internal service';
    return { kind: 'internal', status: name === 'noop@internal' ? null : 200, service: name, text: what, path, query, trail: [] };
  }
  const trail = [];
  let cur = name;
  let svc = lookup.service(cur);
  for (let depth = 0; svc && depth < 6; depth++) {
    const prov = svc.provider ?? providerOf(svc.name);
    const type = String(svc.type ?? '').toLowerCase();
    if (svc.loadBalancer || type === 'loadbalancer') {
      const servers = list(svc.loadBalancer?.servers).map((s) => ({ url: s.url ?? s.address, status: svc.serverStatus?.[s.url ?? s.address] ?? null }));
      const up = servers.filter((s) => s.status !== 'DOWN');
      if (!up.length && servers.length) return { kind: 'unavailable', status: 503, service: cur, trail, servers, text: `Every server of ${cur} is down, so Traefik answers 503`, path, query };
      const target = up[0]?.url ?? '';
      const backend = proto === 'http' && target ? `${target.replace(/\/$/, '')}${path}${query}` : target;
      return { kind: 'forward', status: null, service: cur, trail, servers, backend, text: servers.length <= 1 ? 'its only server' : up.length === servers.length ? `one of its ${servers.length} servers` : `one of the ${up.length} of ${servers.length} servers that are up`, path, query };
    }
    if (svc.weighted || type === 'weighted') {
      const parts = list(svc.weighted?.services);
      const total = parts.reduce((a, x) => a + Number(x.weight ?? 1), 0) || 1;
      trail.push({ service: cur, type: 'weighted', text: `Splits traffic: ${parts.map((x) => `${x.name} ${Math.round((Number(x.weight ?? 1) / total) * 100)}%`).join(', ')}` });
      const heaviest = [...parts].sort((a, b) => Number(b.weight ?? 1) - Number(a.weight ?? 1))[0];
      cur = qualifyName(heaviest?.name, prov);
    } else if (svc.failover || type === 'failover') {
      const main = qualifyName(svc.failover?.service, prov);
      const fb = qualifyName(svc.failover?.fallback, prov);
      const mainSvc = lookup.service(main);
      const mainDown = mainSvc?.serverStatus && Object.values(mainSvc.serverStatus).length && Object.values(mainSvc.serverStatus).every((s) => s === 'DOWN');
      trail.push({ service: cur, type: 'failover', text: mainDown ? `${main} is down, so the fallback ${fb} answers` : `${main} answers, ${fb} takes over if it goes down` });
      cur = mainDown ? fb : main;
    } else if (svc.mirroring || type === 'mirroring') {
      const mirrors = list(svc.mirroring?.mirrors);
      trail.push({ service: cur, type: 'mirroring', text: `${svc.mirroring?.service} answers${mirrors.length ? `; copies go to ${mirrors.map((m) => `${m.name} (${m.percent ?? 0}%)`).join(', ')}` : ''}` });
      cur = qualifyName(svc.mirroring?.service, prov);
    } else break;
    svc = lookup.service(cur);
  }
  if (!svc) return { kind: 'broken', status: 404, service: cur, trail, text: `Service ${cur} does not exist`, path, query };
  return { kind: 'forward', status: null, service: cur, trail, servers: [], text: cur, path, query };
}
