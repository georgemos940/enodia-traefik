// Small pieces the services, middlewares and topology pages share: tinted type tiles, server health
// pills, filter chips and a few formatters.
import { h } from './dom.js';
import { glyph } from './glyphs.js';
import { pct, ms, rate } from './format.js';

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** A rounded square with a glyph, tinted by hue. */
export function tile(glyphName, hue, { size = 34, icon = 17, cls = '' } = {}) {
  return h('span', { class: `gr-tile gr-tone ${cls}`.trim(), style: { '--h': hue, width: `${size}px`, height: `${size}px` } }, glyph(glyphName, { size: icon }));
}

/** Server health as a row of pills. servers: [{ key, status }] */
export function healthPills(servers, { max = 12, onclick } = {}) {
  if (!servers.length) return h('span', { class: 'faint small' }, 'no servers');
  const shown = servers.slice(0, max);
  return h('div', { class: 'gr-pills' },
    ...shown.map((x) => h(onclick ? 'button' : 'span', {
      class: `gr-pill ${x.status === 'UP' ? 'up' : x.status === 'DOWN' ? 'down' : 'unknown'}`,
      title: `${x.key}: ${x.status ?? 'no health check'}`,
      onclick: onclick ? (e) => { e.stopPropagation(); onclick(x); } : undefined,
    })),
    servers.length > max ? h('span', { class: 'tiny muted' }, `+${servers.length - max}`) : null);
}

export const HEALTH = {
  up: { label: 'healthy', tone: 'ok' },
  partial: { label: 'degraded', tone: 'warn' },
  down: { label: 'down', tone: 'bad' },
  unknown: { label: 'no health check', tone: '' },
  missing: { label: 'missing', tone: 'bad' },
};
export const healthDot = (hl) => h('span', { class: `dot ${HEALTH[hl]?.tone ?? ''} ${hl === 'down' || hl === 'missing' ? 'pulse' : ''}`.trim(), title: HEALTH[hl]?.label ?? hl });

/** A toggleable chip for filters: { label, glyph, hue, count, on, onclick } */
export function filterChip({ label, glyph: g, hue, count, on, onclick, title }) {
  return h('button', { type: 'button', class: `gr-fchip ${hue !== undefined ? 'gr-tone' : ''} ${on ? 'on' : ''}`.trim(), style: hue !== undefined ? { '--h': hue } : undefined, onclick, title, 'aria-pressed': on ? 'true' : 'false' },
    g ? glyph(g, { size: 14 }) : null, h('span', {}, label), count !== undefined ? h('span', { class: 'gr-fchip-n' }, String(count)) : null);
}

export const errTone = (r) => (r >= 0.05 ? 'bad' : r >= 0.01 ? 'warn' : '');
export const fmtErr = (r) => (r === null || r === undefined ? '—' : pct(r));
export const fmtRps = (v) => (v === null || v === undefined ? '—' : `${rate(v)}/s`);
export const fmtMs = (v) => (v === null || v === undefined ? '—' : ms(v));

/** "a few seconds ago" for access-log timestamps, short. */
export function shortAgo(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
