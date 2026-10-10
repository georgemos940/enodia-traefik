// Address ranges: does an IPv4 or IPv6 address fall in a CIDR block. Used to spot Cloudflare's own
// addresses in the access log (a sign Traefik does not trust it as a proxy) and CrowdSec range bans.

function parse(ip) {
  const s = String(ip ?? '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const p = s.split('.').map(Number);
    if (p.some((x) => x > 255)) return null;
    return { v: 4, n: BigInt(((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) };
  }
  if (!s.includes(':')) return null;
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return parse(mapped[1]);
  const [head, tail = null] = s.split('::');
  if (s.split('::').length > 2) return null;
  const hp = head ? head.split(':') : [];
  const tp = tail !== null && tail ? tail.split(':') : [];
  const groups = tail === null ? hp : [...hp, ...Array(8 - hp.length - tp.length).fill('0'), ...tp];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return { v: 6, n: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n) };
}

export function cidr(block) {
  const [addr, bits] = String(block).split('/');
  const a = parse(addr);
  if (!a) return null;
  const size = a.v === 4 ? 32 : 128;
  const len = bits === undefined ? size : Number(bits);
  if (!(len >= 0 && len <= size)) return null;
  const shift = BigInt(size - len);
  return { v: a.v, shift, base: a.n >> shift };
}

export function inRanges(ip, ranges) {
  const a = parse(ip);
  if (!a) return false;
  return ranges.some((r) => r && r.v === a.v && (a.n >> r.shift) === r.base);
}

export const isIp = (s) => parse(s) !== null;

// https://www.cloudflare.com/ips/
export const CLOUDFLARE = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];
const cf = CLOUDFLARE.map(cidr);
export const isCloudflare = (ip) => inRanges(ip, cf);
