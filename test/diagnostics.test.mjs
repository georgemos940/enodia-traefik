import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../server/traefik.mjs';
import { metrics } from '../server/metrics.mjs';
import { diagnose, sanCovers } from '../server/diagnostics.mjs';

const ep = (name, http = {}) => ({ name, address: ':1', http });
const router = (name, o) => ({ name, provider: 'file', status: 'enabled', entryPoints: ['web'], service: 's', rule: `Host(\`${name.split('@')[0]}.example.com\`)`, ...o });
const mw = (name, type, key, cfg) => ({ name, provider: 'file', status: 'enabled', type, [key]: cfg, usedBy: ['x'] });
const cert = (cn, sans = [cn]) => ({ cn, sans, serial: cn, notAfter: new Date(Date.now() + 90 * 86_400_000).toISOString() });

function setup(routers, { services = [], middlewares = [], certs = [] } = {}) {
  Object.assign(state, {
    ok: true,
    static: null,
    entrypoints: [ep('web'), ep('websecure'), ep('redirected', { redirections: { entryPoint: { to: 'websecure' } } }), ep('tlsdefault', { tls: {} }), ep('tlsresolver', { tls: { certResolver: 'le' } })],
    http: { routers, services, middlewares },
    tcp: { routers: [], services: [], middlewares: [] },
    udp: { routers: [], services: [] },
  });
  Object.assign(metrics, { certs, ok: false, enabled: false });
  return new Set(diagnose().map((f) => f.id));
}

test('certificate names: exact and one-label wildcards', () => {
  assert.ok(sanCovers('a.example.com', 'A.example.com'));
  assert.ok(sanCovers('*.example.com', 'a.example.com'));
  assert.ok(!sanCovers('*.example.com', 'example.com'));
  assert.ok(!sanCovers('*.example.com', 'a.b.example.com'));
});

test('cert-missing: HTTPS hosts no reported certificate covers, unless a resolver fetches one', () => {
  const ids = setup([
    router('covered@file', { entryPoints: ['websecure'], tls: {}, rule: 'Host(`a.example.com`)' }),
    router('wild@file', { entryPoints: ['websecure'], tls: {}, rule: 'Host(`b.wild.com`)' }),
    router('apex@file', { entryPoints: ['websecure'], tls: {}, rule: 'Host(`wild.com`)' }),
    router('resolver@file', { entryPoints: ['websecure'], tls: { certResolver: 'le' }, rule: 'Host(`none.com`)' }),
    router('epresolver@file', { entryPoints: ['tlsresolver'], rule: 'Host(`none2.com`)' }),
    router('eptls@file', { entryPoints: ['tlsdefault'], rule: 'Host(`none3.com`)' }),
    router('plain@file', { entryPoints: ['web'], rule: 'Host(`none4.com`)' }),
  ], { certs: [cert('a.example.com'), cert('*.wild.com')] });
  for (const id of ['covered', 'wild', 'resolver', 'epresolver', 'plain']) assert.ok(!ids.has(`cert-missing:${id}@file`), id);
  assert.ok(ids.has('cert-missing:apex@file'));
  assert.ok(ids.has('cert-missing:eptls@file'));
  // no certificates reported (metrics off): nothing to compare against
  assert.ok(![...setup([router('apex@file', { entryPoints: ['websecure'], tls: {}, rule: 'Host(`wild.com`)' })])].some((id) => id.startsWith('cert-missing')));
});

test('auth-plain-http: basicAuth on plain HTTP, through chains, unless redirected first', () => {
  const ids = setup([
    router('plain@file', { middlewares: ['auth@file'] }),
    router('tls@file', { tls: {}, middlewares: ['auth@file'] }),
    router('epredirect@file', { entryPoints: ['redirected'], middlewares: ['auth@file'] }),
    router('redirectfirst@file', { middlewares: ['https@file', 'auth@file'] }),
    router('chain@file', { middlewares: ['chain@file'] }),
  ], {
    middlewares: [
      mw('auth@file', 'basicauth', 'basicAuth', { users: ['u:p'] }),
      mw('https@file', 'redirectscheme', 'redirectScheme', { scheme: 'https' }),
      mw('chain@file', 'chain', 'chain', { middlewares: ['auth'] }),
    ],
  });
  assert.ok(ids.has('auth-plain-http:plain@file'));
  assert.ok(ids.has('auth-plain-http:chain@file'));
  for (const id of ['tls', 'epredirect', 'redirectfirst']) assert.ok(!ids.has(`auth-plain-http:${id}@file`), id);
});

test('hsts: security headers on HTTPS without Strict-Transport-Security, once per middleware', () => {
  const findings = (() => {
    setup([
      router('missing@file', { entryPoints: ['websecure'], tls: {}, middlewares: ['sec@file'] }),
      router('missing2@file', { entryPoints: ['websecure'], tls: {}, middlewares: ['sec@file'] }),
      router('withsts@file', { entryPoints: ['websecure'], tls: {}, middlewares: ['sec@file', 'sts@file'] }),
      router('corsonly@file', { entryPoints: ['websecure'], tls: {}, middlewares: ['cors@file'] }),
      router('plainhttp@file', { middlewares: ['sec@file'] }),
    ], {
      middlewares: [
        mw('sec@file', 'headers', 'headers', { frameDeny: true }),
        mw('sts@file', 'headers', 'headers', { stsSeconds: 31536000 }),
        mw('cors@file', 'headers', 'headers', { accessControlAllowMethods: ['GET'] }),
      ],
    });
    return diagnose();
  })();
  const hsts = findings.filter((f) => f.id.startsWith('hsts:'));
  assert.deepEqual(hsts.map((f) => f.id), ['hsts:sec@file']);
  assert.match(hsts[0].detail, /missing@file, missing2@file/);
  assert.doesNotMatch(hsts[0].detail, /withsts|plainhttp/);
  assert.equal(hsts[0].severity, 'info');
});

test('no-healthcheck: two or more servers and no health check', () => {
  const lb = (n, extra = {}) => ({ servers: Array.from({ length: n }, (_, i) => ({ url: `http://10.0.0.${i}` })), ...extra });
  const ids = setup([], {
    services: [
      { name: 'two@file', provider: 'file', status: 'enabled', usedBy: ['x'], loadBalancer: lb(2) },
      { name: 'checked@file', provider: 'file', status: 'enabled', usedBy: ['x'], loadBalancer: lb(3, { healthCheck: { path: '/health' } }) },
      { name: 'one@file', provider: 'file', status: 'enabled', usedBy: ['x'], loadBalancer: lb(1) },
    ],
  });
  assert.ok(ids.has('no-healthcheck:two@file'));
  assert.ok(!ids.has('no-healthcheck:checked@file'));
  assert.ok(!ids.has('no-healthcheck:one@file'));
});
