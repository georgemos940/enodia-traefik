// Numbers, bytes, durations and names, the same way everywhere.

const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat();

export function num(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(digits)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(digits)}k`;
  if (a >= 100 || Number.isInteger(n)) return nf0.format(Math.round(n));
  return nf.format(n);
}

/** Requests a second: 0.0, 2.4, 1.2k. */
export function rate(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n === 0) return '0';
  if (n < 0.1) return n.toFixed(2);
  return num(n);
}

export function pct(x, digits = 1) {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  const v = x * 100;
  if (v > 0 && v < 0.1) return '<0.1%';
  return `${v.toFixed(v >= 10 || v === 0 ? 0 : digits)}%`;
}

export function bytes(n, perSecond = false) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}${perSecond ? '/s' : ''}`;
}

/** Milliseconds as "38 ms", "1.4 s", "2 min". */
export function ms(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n < 1) return `${n.toFixed(2)} ms`;
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`;
  return `${(n / 60_000).toFixed(1)} min`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function ago(iso) {
  if (!iso) return '—';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  const diff = (t - Date.now()) / 1000;
  const a = Math.abs(diff);
  if (a < 45) return rtf.format(Math.round(diff), 'second');
  if (a < 2700) return rtf.format(Math.round(diff / 60), 'minute');
  if (a < 64800) return rtf.format(Math.round(diff / 3600), 'hour');
  if (a < 2592000) return rtf.format(Math.round(diff / 86400), 'day');
  if (a < 31536000) return rtf.format(Math.round(diff / 2592000), 'month');
  return rtf.format(Math.round(diff / 31536000), 'year');
}

export function duration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function time(iso, withSeconds = true) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) });
}
export function dateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** "shop@docker" -> { base: "shop", provider: "docker" } */
export function split(name = '') {
  const i = name.lastIndexOf('@');
  return i > 0 ? { base: name.slice(0, i), provider: name.slice(i + 1) } : { base: name, provider: '' };
}

/** A name relative to a provider ("api" used by "x@file") made absolute. */
export function qualify(name, provider) {
  if (!name) return name;
  return name.includes('@') ? name : `${name}@${provider}`;
}

export const STATUS_CLASS = (code) => (code >= 500 ? 'bad' : code >= 400 ? 'warn' : code >= 300 ? 'info' : code >= 200 ? 'ok' : '');

/** A stable, pleasant colour for a name (charts with many series). */
export function colorFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hues = [38, 255, 160, 200, 330, 12, 280, 95, 185, 225];
  return `hsl(${hues[h % hues.length]} 85% 62%)`;
}

export const plural = (n, word, words = `${word}s`) => `${num(n)} ${n === 1 ? word : words}`;
