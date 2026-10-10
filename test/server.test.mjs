import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrometheus, histogramQuantile } from '../server/prom.mjs';
import { normalize } from '../server/logs.mjs';

test('prometheus: labels, escapes and special values', () => {
  const text = [
    '# HELP traefik_router_requests_total How many HTTP requests are processed on a router.',
    '# TYPE traefik_router_requests_total counter',
    'traefik_router_requests_total{code="200",method="GET",protocol="http",router="shop@docker",service="shop@docker"} 42',
    'traefik_tls_certs_not_after{cn="a.example",sans="a.example,b.example",serial="1"} 1.795122115e+09',
    'odd_metric{path="C:\\\\temp\\"x\\""} +Inf',
    'no_labels 3.5',
  ].join('\n');
  const s = parsePrometheus(text);
  assert.equal(s.length, 4);
  assert.deepEqual(s[0].labels, { code: '200', method: 'GET', protocol: 'http', router: 'shop@docker', service: 'shop@docker' });
  assert.equal(s[0].value, 42);
  assert.equal(s[1].labels.sans, 'a.example,b.example');
  assert.equal(s[1].value, 1795122115);
  assert.equal(s[2].labels.path, 'C:\\temp"x"');
  assert.equal(s[2].value, Infinity);
  assert.deepEqual(s[3], { name: 'no_labels', labels: {}, value: 3.5 });
});

test('histogram quantile: linear inside the bucket', () => {
  const buckets = [{ le: 0.1, count: 50 }, { le: 0.3, count: 90 }, { le: 1.2, count: 100 }, { le: Infinity, count: 100 }];
  assert.equal(histogramQuantile(0.5, buckets), 0.1);
  assert.ok(Math.abs(histogramQuantile(0.7, buckets) - 0.2) < 1e-9);
  assert.ok(Math.abs(histogramQuantile(0.95, buckets) - 0.75) < 1e-9);
  assert.equal(histogramQuantile(0.5, [{ le: 0.1, count: 0 }, { le: Infinity, count: 0 }]), null);
  // beyond the last finite bucket the best answer is that bucket's bound
  assert.equal(histogramQuantile(0.99, [{ le: 0.1, count: 1 }, { le: Infinity, count: 10 }]), 0.1);
});

test('access log: a Traefik JSON line becomes an entry', () => {
  const e = normalize({
    ClientHost: '10.0.0.7', DownstreamStatus: 502, OriginStatus: 0, Duration: 1_234_567, RequestHost: 'shop.example',
    RequestMethod: 'POST', RequestPath: '/cart', RouterName: 'shop@docker', ServiceName: 'shop@docker', ServiceURL: 'http://10.1.0.3:80',
    entryPointName: 'websecure', StartUTC: '2026-10-10T21:02:54Z', 'request_User-Agent': 'curl/8', RetryAttempts: 2, ClientUsername: '-',
  });
  assert.equal(e.status, 502);
  assert.equal(e.durationMs, 1.2);
  assert.equal(e.client, '10.0.0.7');
  assert.equal(e.router, 'shop@docker');
  assert.equal(e.ua, 'curl/8');
  assert.equal(e.user, null);
  assert.equal(e.retries, 2);
});
