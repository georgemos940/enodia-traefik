// The rule parser and matcher behind the route tester, checked against Traefik's own semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize, hostsOf, pathsOf, parseRule, matchRule, explainRule, ruleConditions, RuleError,
  parseIP, parseCIDR, ipInRange, goRegExp, buildRequest, buildConnection, guessEntrypoint,
  rankRouters, priorityOf, simulate, middlewareInfo, syntaxOf,
} from '../public/lib/rules.js';

const req = (url, extra = {}) => buildRequest({ url, ...extra });
const m = (rule, r, opts) => matchRule(rule, r, opts).ok;

test('the display helpers still work', () => {
  assert.deepEqual(tokenize('Host(`a`)').map((t) => t.type), ['fn', 'paren', 'arg', 'paren']);
  assert.deepEqual(hostsOf('Host(`a.com`) || HostSNI(`b.com`)'), ['a.com', 'b.com']);
  assert.deepEqual(pathsOf('PathPrefix(`/v1`) && Path(`/x`)'), ['/v1', '/x']);
});

test('parses precedence like Go: && binds tighter than ||', () => {
  const ast = parseRule('Host(`a`) || Host(`b`) && Path(`/x`)');
  assert.equal(ast.type, 'or');
  assert.equal(ast.items[1].type, 'and');
  assert.ok(m('Host(`a`) || Host(`b`) && Path(`/x`)', req('http://a/y')));
  assert.ok(!m('Host(`a`) || Host(`b`) && Path(`/x`)', req('http://b/y')));
  assert.ok(m('(Host(`a`) || Host(`b`)) && Path(`/x`)', req('http://b/x')));
});

test('negation and nesting', () => {
  const rule = 'Host(`admin.localhost`) && !PathPrefix(`/public`)';
  assert.ok(m(rule, req('http://admin.localhost/')));
  assert.ok(!m(rule, req('http://admin.localhost/public/x')));
  assert.ok(m('!!Host(`a`)', req('http://a/')));
  assert.ok(m('!(Host(`a`) || Host(`b`))', req('http://c/')));
});

test('Host is case-insensitive, ignores the port and tolerates a trailing dot', () => {
  assert.ok(m('Host(`Shop.Localhost`)', req('http://shop.localhost:8081/')));
  assert.ok(m('Host(`shop.localhost`)', req('http://shop.localhost./')));
  assert.ok(!m('Host(`shop.localhost`)', req('http://www.shop.localhost/')));
});

test('a Host header overrides the URL host', () => {
  const r = buildRequest({ url: 'http://127.0.0.1:8081/', headers: [['Host', 'api.localhost:8081']] });
  assert.equal(r.host, 'api.localhost');
  assert.ok(m('Host(`api.localhost`)', r));
});

test('HostRegexp is an unanchored Go regexp in v3', () => {
  assert.ok(m('HostRegexp(`^[a-z]+\\.example\\.com$`)', req('http://shop.example.com/')));
  assert.ok(!m('HostRegexp(`^[a-z]+\\.example\\.com$`)', req('http://a.b.example.com/')));
  assert.ok(m('HostRegexp(`example`)', req('http://www.example.org/')));
  assert.ok(m('HostRegexp(`(?i)^SHOP`)', req('http://shop.x/')));
});

test('Path, PathPrefix and PathRegexp', () => {
  assert.ok(m('Path(`/health`)', req('http://x/health')));
  assert.ok(!m('Path(`/health`)', req('http://x/health/')));
  assert.ok(m('PathPrefix(`/v1`)', req('http://x/v1/orders')));
  assert.ok(m('PathPrefix(`/v1`)', req('http://x/v1')));
  assert.ok(!m('PathPrefix(`/v1`)', req('http://x/v2')));
  assert.ok(m('PathRegexp(`^/users/[0-9]+$`)', req('http://x/users/42')));
  assert.ok(!m('PathRegexp(`^/users/[0-9]+$`)', req('http://x/users/me')));
  // the path is matched decoded
  assert.ok(m('Path(`/a b`)', req('http://x/a%20b')));
});

test('v3 rejects paths without a leading slash', () => {
  assert.throws(() => parseRule('PathPrefix(`api`)'), RuleError);
});

test('Method, Header, HeaderRegexp', () => {
  assert.ok(m('Method(`GET`)', req('http://x/')));
  assert.ok(m('Method(`post`)', req('http://x/', { method: 'POST' })));
  const r = buildRequest({ url: 'http://x/', headers: [['X-Preview', '1'], ['Accept', 'text/html']] });
  assert.ok(m('Header(`x-preview`, `1`)', r));
  assert.ok(!m('Header(`X-Preview`, `0`)', r));
  assert.ok(m('HeaderRegexp(`Accept`, `html`)', r));
  assert.ok(!m('Header(`X-Missing`, ``)', r));
});

test('Query and QueryRegexp, with one or two values', () => {
  assert.ok(m('Query(`mobile`, `true`)', req('http://x/?mobile=true')));
  assert.ok(m('Query(`mobile`, `true`)', req('http://x/?a=1&mobile=false&mobile=true')));
  assert.ok(!m('Query(`mobile`, `true`)', req('http://x/?mobile=yes')));
  assert.ok(m('Query(`debug`)', req('http://x/?debug')));
  assert.ok(!m('Query(`debug`)', req('http://x/?other=1')));
  assert.ok(m('QueryRegexp(`id`, `^[0-9]+$`)', req('http://x/?id=17')));
  assert.ok(m('Query(`q`, `a b`)', req('http://x/?q=a+b')));
});

test('ClientIP with IPv4, IPv6 and CIDR ranges', () => {
  assert.ok(m('ClientIP(`10.0.0.0/8`)', req('http://x/', { clientIP: '10.2.3.4' })));
  assert.ok(!m('ClientIP(`10.0.0.0/8`)', req('http://x/', { clientIP: '11.2.3.4' })));
  assert.ok(m('ClientIP(`192.168.1.7`)', req('http://x/', { clientIP: '192.168.1.7' })));
  assert.ok(m('ClientIP(`2001:db8::/32`)', req('http://x/', { clientIP: '2001:db8:1::5' })));
  assert.ok(!m('ClientIP(`2001:db8::/32`)', req('http://x/', { clientIP: '2001:db9::1' })));
  assert.ok(m('ClientIP(`::1`)', req('http://x/', { clientIP: '[::1]' })));
  assert.throws(() => parseRule('ClientIP(`10.0.0.300/8`)'), RuleError);
});

test('IP helpers', () => {
  assert.equal(parseIP('1.2.3.4').v, 4);
  assert.equal(parseIP('::ffff:1.2.3.4').v, 4);
  assert.equal(parseIP('fe80::1%eth0').v, 6);
  assert.equal(parseIP('1:2:3:4:5:6:7:8:9'), null);
  assert.equal(parseIP('256.1.1.1'), null);
  assert.equal(parseIP('1::2::3'), null);
  assert.equal(parseCIDR('10.0.0.0/33'), null);
  assert.ok(ipInRange('::ffff:10.1.1.1', '10.0.0.0/8'));
  assert.ok(ipInRange('0.0.0.0', '0.0.0.0/0'));
  assert.ok(!ipInRange('10.0.0.1', '::/0'));
});

test('Go regexps become JS ones', () => {
  assert.ok(goRegExp('(?P<sub>[a-z]+)\\.x').test('abc.x'));
  assert.ok(goRegExp('\\Aabc\\z').test('abc'));
  assert.ok(goRegExp('^[[:digit:]]+$').test('123'));
  assert.throws(() => goRegExp('(unclosed'));
});

test('syntax errors carry a position', () => {
  const cases = ['Host(`a`', 'Host(`a`) &&', 'Host(`a`) & Path(`/`)', 'host(`a`)', 'Host(`a`) Path(`/`)', 'Host(a)', 'Host(`a`))', 'Hots(`a`)', 'Header(`x`)', "Host('a')", ''];
  for (const rule of cases) {
    const r = matchRule(rule, req('http://a/'));
    assert.ok(r.error instanceof RuleError, `expected an error for ${rule}`);
    assert.equal(typeof r.error.pos, 'number');
  }
  assert.match(matchRule('host(`a`)', req('http://a/')).error.message, /did you mean Host/);
  assert.match(matchRule('Headers(`a`, `b`)', req('http://a/')).error.message, /v2 syntax/);
  assert.match(matchRule('HostSNI(`a`)', req('http://a/')).error.message, /TCP/);
});

test('double-quoted strings work like backticks', () => {
  assert.ok(m('Host("a.com") && PathPrefix("/x")', req('http://a.com/x/y')));
});

test('v2 syntax: several values per matcher, templates, Headers and key=value queries', () => {
  const v2 = { syntax: 'v2' };
  assert.ok(m('Host(`a.com`, `b.com`)', req('http://b.com/'), v2));
  assert.ok(m('HostRegexp(`{sub:[a-z]+}.example.com`)', req('http://shop.example.com/'), v2));
  assert.ok(!m('HostRegexp(`{sub:[a-z]+}.example.com`)', req('http://a.b.example.com/'), v2));
  assert.ok(m('Path(`/users/{id:[0-9]+}`)', req('http://x/users/12'), v2));
  assert.ok(!m('Path(`/users/{id:[0-9]+}`)', req('http://x/users/12/x'), v2));
  assert.ok(m('PathPrefix(`/api/{v}`)', req('http://x/api/v2/items'), v2));
  assert.ok(m('Headers(`X-A`, `1`)', buildRequest({ url: 'http://x/', headers: [['x-a', '1']] }), v2));
  assert.ok(m('Query(`a=1`, `b`)', req('http://x/?a=1&b=2'), v2));
  assert.ok(!m('Query(`a=1`, `b`)', req('http://x/?a=1'), v2));
  assert.ok(m('Method(`GET`, `POST`)', req('http://x/', { method: 'POST' }), v2));
  assert.ok(m('ClientIP(`10.0.0.0/8`, `::1`)', req('http://x/', { clientIP: '::1' }), v2));
  assert.equal(syntaxOf({ ruleSyntax: 'v2' }), 'v2');
  assert.equal(syntaxOf({}, { core: { defaultRuleSyntax: 'v2' } }), 'v2');
  assert.equal(syntaxOf({ ruleSyntax: 'default' }), 'v3');
});

test('TCP: HostSNI, HostSNIRegexp, ClientIP, ALPN', () => {
  const tcp = { proto: 'tcp' };
  assert.ok(m('HostSNI(`*`)', buildConnection({ tls: false }), tcp));
  assert.ok(m('HostSNI(`db.example.com`)', buildConnection({ sni: 'DB.example.com' }), tcp));
  assert.ok(!m('HostSNI(`db.example.com`)', buildConnection({ sni: 'db.example.com', tls: false }), tcp));
  assert.ok(m('HostSNIRegexp(`^.+\\.example\\.com$`)', buildConnection({ sni: 'a.example.com' }), tcp));
  assert.ok(m('HostSNI(`a.com`) && ClientIP(`10.0.0.0/8`)', buildConnection({ sni: 'a.com', clientIP: '10.0.0.9' }), tcp));
  assert.ok(m('ALPN(`h2`)', buildConnection({ sni: 'a', alpn: 'h2,http/1.1' }), tcp));
  assert.ok(matchRule('Host(`a`)', buildConnection({}), tcp).error);
});

test('plain words', () => {
  assert.equal(explainRule('Host(`shop.localhost`) || Host(`www.shop.localhost`)'), 'Host is shop.localhost or www.shop.localhost');
  assert.equal(explainRule('Host(`admin.localhost`) && !PathPrefix(`/public`)'), 'Host is admin.localhost and path does not start with /public');
  assert.equal(explainRule('Host(`blog.localhost`) && (PathPrefix(`/posts`) || Path(`/`)) && Header(`X-Preview`, `1`)'),
    'Host is blog.localhost, either path starts with /posts or path is /, and header X-Preview is 1');
  assert.equal(explainRule('!(Host(`a`) || Host(`b`))'), 'Host is not a and host is not b');
  assert.equal(explainRule('HostSNI(`*`)', { proto: 'tcp' }), 'Any connection');
  assert.equal(explainRule('Method(`GET`)'), 'Method is GET');
  assert.equal(explainRule('nonsense'), '');
  assert.deepEqual(ruleConditions('Host(`a`) && Path(`/b`)').all, ['Host is a', 'Path is /b']);
});

test('reasons say what failed', () => {
  const r = matchRule('Host(`api.localhost`) && PathPrefix(`/v1`)', req('http://api.localhost/v2'));
  assert.deepEqual(r.reasons, ['Path /v2 does not start with /v1']);
  const r2 = matchRule('Host(`a`) || Host(`b`)', req('http://c/'));
  assert.deepEqual(r2.reasons, ['Host is c, not a or b']);
  const r3 = matchRule('Host(`a`) && !PathPrefix(`/public`)', req('http://a/public'));
  assert.deepEqual(r3.reasons, ['Path starts with /public, which the rule excludes']);
});

const routers = [
  { name: 'shop@file', provider: 'file', rule: 'Host(`shop.localhost`) || Host(`www.shop.localhost`)', priority: 52, tls: { options: 'default' }, using: ['websecure'], service: 'shop', middlewares: ['www-redirect@file'], status: 'enabled' },
  { name: 'shop-http@file', provider: 'file', rule: 'Host(`shop.localhost`) || Host(`www.shop.localhost`)', priority: 52, using: ['web'], service: 'noop@internal', middlewares: ['to-https@file'], status: 'enabled' },
  { name: 'api@file', provider: 'file', rule: 'Host(`api.localhost`) && PathPrefix(`/v1`)', priority: 42, tls: {}, using: ['web', 'websecure'], service: 'api', middlewares: ['strip-v1@file'], status: 'enabled' },
  { name: 'api-health@file', provider: 'file', rule: 'Host(`api.localhost`) && Path(`/health`) && Method(`GET`)', priority: 1000, tls: {}, using: ['web', 'websecure'], service: 'api', status: 'enabled' },
  { name: 'catchall@file', provider: 'file', rule: 'PathPrefix(`/`)', priority: 1, using: ['web', 'websecure'], tls: {}, service: 'api', status: 'enabled' },
  { name: 'legacy@file', provider: 'file', rule: 'Host(`legacy.localhost`)', priority: 24, tls: {}, using: ['websecure'], service: 'shop', status: 'disabled', error: ['middleware "x" does not exist'] },
];
const eps = [{ name: 'web', address: ':8081' }, { name: 'websecure', address: ':8443' }, { name: 'traefik', address: ':8090' }, { name: 'dns', address: ':53/udp' }];

test('entry point guess: port first, then scheme', () => {
  assert.equal(guessEntrypoint(req('http://x:8081/'), eps).name, 'web');
  assert.equal(guessEntrypoint(req('https://x:8443/'), eps).name, 'websecure');
  assert.equal(guessEntrypoint(req('https://x/'), eps, ['traefik']).name, 'websecure');
  assert.equal(guessEntrypoint(req('http://x/'), eps, ['traefik']).name, 'web');
});

test('priority falls back to the rule length', () => {
  assert.equal(priorityOf({ rule: 'Host(`a`)' }), 9);
  assert.equal(priorityOf({ rule: 'Host(`a`)', priority: 5 }), 5);
});

test('ranking: highest priority wins, others are shadowed, TLS and disabled routers are skipped', () => {
  const r = req('https://api.localhost/health');
  const res = rankRouters(routers, r, { entrypoint: eps[1] });
  assert.equal(res.winner.router.name, 'api-health@file');
  const by = Object.fromEntries(res.rows.map((x) => [x.router.name, x.verdict]));
  assert.equal(by['catchall@file'], 'shadowed');
  assert.equal(by['api@file'], 'miss');
  assert.equal(by['legacy@file'], 'skipped');
  assert.equal(res.others, 1);
  // plain HTTP on websecure: every router there has TLS, so nothing answers
  const plain = rankRouters(routers, req('http://api.localhost/health'), { entrypoint: eps[1] });
  assert.equal(plain.winner, null);
});

test('ranking flags ties at the same priority', () => {
  const twins = [
    { name: 'a@file', rule: 'Host(`x`)', priority: 10, using: ['web'] },
    { name: 'b@file', rule: 'PathPrefix(`/`)', priority: 10, using: ['web'] },
  ];
  const res = rankRouters(twins, req('http://x/'), { entrypoint: eps[0] });
  assert.equal(res.ties.length, 1);
});

const mws = {
  'to-https@file': { name: 'to-https@file', provider: 'file', type: 'redirectscheme', redirectScheme: { scheme: 'https', permanent: true } },
  'www-redirect@file': { name: 'www-redirect@file', provider: 'file', type: 'redirectregex', redirectRegex: { regex: '^https?://www\\.shop\\.localhost/(.*)', replacement: 'https://shop.localhost/${1}', permanent: true } },
  'strip-v1@file': { name: 'strip-v1@file', provider: 'file', type: 'stripprefix', stripPrefix: { prefixes: ['/v1'] } },
  'office@file': { name: 'office@file', provider: 'file', type: 'ipallowlist', ipAllowList: { sourceRange: ['10.0.0.0/8'] } },
  'auth@file': { name: 'auth@file', provider: 'file', type: 'basicauth', basicAuth: { users: ['a:b'] } },
  'both@file': { name: 'both@file', provider: 'file', type: 'chain', chain: { middlewares: ['office', 'auth'] } },
};
const svcs = {
  'shop@file': { name: 'shop@file', provider: 'file', type: 'loadbalancer', loadBalancer: { servers: [{ url: 'http://127.0.0.1:9101' }, { url: 'http://127.0.0.1:9102' }] }, serverStatus: { 'http://127.0.0.1:9101': 'UP', 'http://127.0.0.1:9102': 'UP' } },
  'api@file': { name: 'api@file', provider: 'file', type: 'loadbalancer', loadBalancer: { servers: [{ url: 'http://127.0.0.1:9103' }] }, serverStatus: { 'http://127.0.0.1:9103': 'UP' } },
  'down@file': { name: 'down@file', provider: 'file', type: 'loadbalancer', loadBalancer: { servers: [{ url: 'http://127.0.0.1:9198' }] }, serverStatus: { 'http://127.0.0.1:9198': 'DOWN' } },
  'canary@file': { name: 'canary@file', provider: 'file', type: 'weighted', weighted: { services: [{ name: 'api', weight: 9 }, { name: 'shop', weight: 1 }] } },
};
const lookup = { middleware: (n) => mws[n] ?? null, service: (n) => svcs[n] ?? null };

test('simulation: redirectScheme sends plain HTTP to HTTPS', () => {
  const { outcome } = simulate({ router: routers[1], req: req('http://shop.localhost:8081/cart?x=1'), lookup });
  assert.equal(outcome.kind, 'redirect');
  assert.equal(outcome.status, 301);
  assert.equal(outcome.location, 'https://shop.localhost/cart?x=1');
  const post = simulate({ router: routers[1], req: req('http://shop.localhost/cart', { method: 'POST' }), lookup });
  assert.equal(post.outcome.status, 308);
});

test('simulation: redirectRegex with ${1}', () => {
  const { outcome } = simulate({ router: routers[0], req: req('https://www.shop.localhost/a/b'), lookup });
  assert.equal(outcome.kind, 'redirect');
  assert.equal(outcome.location, 'https://shop.localhost/a/b');
  const pass = simulate({ router: routers[0], req: req('https://shop.localhost/a'), lookup });
  assert.equal(pass.outcome.kind, 'forward');
  assert.equal(pass.outcome.backend, 'http://127.0.0.1:9101/a');
});

test('simulation: stripPrefix changes what the backend sees', () => {
  const { outcome, steps } = simulate({ router: routers[2], req: req('https://api.localhost/v1/orders?id=3'), lookup });
  assert.equal(outcome.kind, 'forward');
  assert.equal(outcome.path, '/orders');
  assert.equal(outcome.backend, 'http://127.0.0.1:9103/orders?id=3');
  assert.match(steps[0].effect, /Strips \/v1/);
  const root = simulate({ router: routers[2], req: req('https://api.localhost/v1'), lookup });
  assert.equal(root.outcome.path, '/');
});

test('simulation: chains expand, the allow list and basic auth answer', () => {
  const router = { name: 'admin@file', provider: 'file', service: 'api', middlewares: ['both@file'] };
  const denied = simulate({ router, req: req('http://admin/', { clientIP: '1.2.3.4' }), lookup });
  assert.equal(denied.outcome.kind, 'deny');
  assert.equal(denied.outcome.status, 403);
  assert.equal(denied.steps.length, 3);
  assert.equal(denied.steps[2].tone, 'skip');
  const auth = simulate({ router, req: req('http://admin/', { clientIP: '10.1.1.1' }), lookup });
  assert.equal(auth.outcome.kind, 'auth');
  const ok = simulate({ router, req: buildRequest({ url: 'http://admin/', clientIP: '10.1.1.1', headers: [['Authorization', 'Basic eDp5']] }), lookup });
  assert.equal(ok.outcome.kind, 'forward');
});

test('simulation: services that are down, weighted, missing, internal', () => {
  const r = (service) => ({ name: 't@file', provider: 'file', service });
  assert.equal(simulate({ router: r('down'), req: req('http://x/'), lookup }).outcome.status, 503);
  const w = simulate({ router: r('canary'), req: req('http://x/p'), lookup }).outcome;
  assert.equal(w.service, 'api@file');
  assert.match(w.trail[0].text, /api 90%/);
  assert.equal(simulate({ router: r('nope'), req: req('http://x/'), lookup }).outcome.kind, 'broken');
  assert.equal(simulate({ router: r('api@internal'), req: req('http://x/'), lookup }).outcome.kind, 'internal');
  const missingMw = simulate({ router: { ...r('api'), middlewares: ['ghost@file'] }, req: req('http://x/'), lookup });
  assert.equal(missingMw.outcome.kind, 'broken');
});

test('middleware summaries', () => {
  assert.equal(middlewareInfo(mws['strip-v1@file']).summary, 'strips /v1');
  assert.equal(middlewareInfo(mws['to-https@file']).summary, '→ https, permanent');
  assert.equal(middlewareInfo(null).type, 'missing');
  assert.equal(middlewareInfo({ type: 'ratelimit', rateLimit: { average: 50, burst: 100, period: '1s' } }).summary, '50/s, burst 100');
});
