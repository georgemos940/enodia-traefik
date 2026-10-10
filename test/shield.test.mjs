import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../server/shield.mjs';
import { isCloudflare, inRanges, cidr } from '../server/netmatch.mjs';

test('requests are sorted by what Traefik did with them', () => {
  assert.equal(classify({ status: 200, originStatus: 200, router: 'shop' }), 'pass');
  assert.equal(classify({ status: 404, originStatus: 404, router: 'shop' }), 'pass');       // the app said 404
  assert.equal(classify({ status: 308, originStatus: 0, router: 'shop-http' }), 'pass');    // a redirect is not an attack
  assert.equal(classify({ status: 429, originStatus: 0, router: 'login' }), 'limit');
  assert.equal(classify({ status: 403, originStatus: 0, router: 'login' }), 'block');       // allow list or CrowdSec plugin
  assert.equal(classify({ status: 403, originStatus: 403, router: 'app' }), 'pass');        // the app refused, not Traefik
  assert.equal(classify({ status: 401, originStatus: 0, router: 'admin' }), 'auth');
  assert.equal(classify({ status: 404, originStatus: 0, router: null }), 'miss');           // no router for that host
  assert.equal(classify({ status: 502, originStatus: 0, router: 'api' }), 'error');
  assert.equal(classify({ status: 500, originStatus: 500, router: 'api' }), 'error');
});

test('cloudflare and other ranges', () => {
  assert.ok(isCloudflare('104.16.1.1'));
  assert.ok(isCloudflare('2606:4700::6810:84e5'));
  assert.ok(isCloudflare('::ffff:172.67.1.1'));
  assert.ok(!isCloudflare('1.1.1.1'));
  assert.ok(!isCloudflare('not an address'));
  assert.ok(inRanges('10.20.30.40', [cidr('10.0.0.0/8')]));
  assert.ok(!inRanges('10.20.30.40', [cidr('10.20.30.41/32')]));
  assert.ok(inRanges('2001:db8::1', [cidr('2001:db8::/32')]));
});
