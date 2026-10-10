// Charts without a library: a live time-series chart on canvas (crosshair, tooltip, smooth scrolling as
// points arrive), SVG sparklines, donuts, a health ring and bar lists. All theme aware.
import { h, s } from './dom.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function hexA(color, alpha) {
  // works for hex, rgb() and hsl(): canvas parses all of them; alpha via a temporary context
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = color;
  const v = c.fillStyle; // normalised to #rrggbb or rgba()
  if (v.startsWith('#')) {
    const n = parseInt(v.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  return v.replace(/rgba?\(([^)]+)\)/, (_, p) => `rgba(${p.split(',').slice(0, 3).join(',')}, ${alpha})`);
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * A live time-series chart.
 *   series: [{ key, label, color, values: [{ t, v }] }]
 *   opts: { height, stacked, area, yFormat(v), minMax, windowMs, tooltipTime }
 * Returns { el, update(series), destroy() }.
 */
export function timeChart(series, opts = {}) {
  const o = { height: 220, stacked: false, area: true, yFormat: (v) => String(Math.round(v)), minMax: 0, windowMs: null, ...opts };
  const canvas = h('canvas');
  const tip = h('div', { class: 'tip', hidden: true });
  const el = h('div', { class: 'chart', style: { height: `${o.height}px` } }, canvas);
  let data = series;
  let hover = null;
  let raf = 0;
  let shownMax = null;
  let drawnAt = 0;
  const ctx = canvas.getContext('2d');

  const pad = { l: 46, r: 12, t: 12, b: 24 };

  function extent() {
    let t0 = Infinity; let t1 = -Infinity; let max = 0;
    const stack = new Map();
    for (const sr of data) {
      for (const p of sr.values) {
        if (p.t < t0) t0 = p.t; if (p.t > t1) t1 = p.t;
        const v = p.v ?? 0;
        if (o.stacked) { const nv = (stack.get(p.t) ?? 0) + v; stack.set(p.t, nv); if (nv > max) max = nv; } else if (v > max) max = v;
      }
    }
    if (o.windowMs && Number.isFinite(t1)) t0 = t1 - o.windowMs;
    return { t0, t1, max: Math.max(o.minMax, max) };
  }

  function draw() {
    raf = 0;
    const w = el.clientWidth; const hgt = o.height;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr);
      canvas.style.width = `${w}px`; canvas.style.height = `${hgt}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);

    const { t0, t1, max } = extent();
    const target = niceMax(max);
    // the scale eases toward its new top instead of jumping
    shownMax = shownMax === null || reduced() ? target : shownMax + (target - shownMax) * 0.25;
    if (Math.abs(shownMax - target) > target * 0.002) schedule();
    const yMax = shownMax || 1;
    const W = w - pad.l - pad.r; const H = hgt - pad.t - pad.b;
    const x = (t) => pad.l + (t1 === t0 ? W : ((t - t0) / (t1 - t0)) * W);
    const y = (v) => pad.t + H - (v / yMax) * H;

    // grid and axis
    ctx.font = `11px ${css('--mono') || 'monospace'}`;
    ctx.fillStyle = css('--muted');
    ctx.strokeStyle = css('--line');
    ctx.lineWidth = 1;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = (yMax / 4) * i;
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.setLineDash(i === 0 ? [] : [3, 4]); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
      ctx.fillText(o.yFormat(v), pad.l - 8, yy);
    }
    ctx.setLineDash([]);
    if (Number.isFinite(t0) && t1 > t0) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const ticks = Math.max(2, Math.min(6, Math.floor(W / 110)));
      for (let i = 0; i <= ticks; i++) {
        const t = t0 + ((t1 - t0) / ticks) * i;
        const label = new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        ctx.fillText(label, Math.min(w - pad.r - 18, Math.max(pad.l + 18, x(t))), hgt - pad.b + 7);
      }
    }

    // series, stacked from the bottom
    const base = new Map();
    for (const sr of data) {
      const pts = sr.values.filter((p) => p.t >= t0);
      if (!pts.length) continue;
      const coords = pts.map((p) => {
        const below = o.stacked ? base.get(p.t) ?? 0 : 0;
        const top = below + (p.v ?? 0);
        if (o.stacked) base.set(p.t, top);
        return [x(p.t), y(top), y(below)];
      });
      ctx.beginPath();
      coords.forEach(([cx, cy], i) => (i ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy)));
      if (o.area) {
        const g = ctx.createLinearGradient(0, pad.t, 0, pad.t + H);
        g.addColorStop(0, hexA(sr.color, o.stacked ? 0.55 : 0.32));
        g.addColorStop(1, hexA(sr.color, o.stacked ? 0.28 : 0.0));
        ctx.save();
        for (let i = coords.length - 1; i >= 0; i--) ctx.lineTo(coords[i][0], coords[i][2]);
        ctx.closePath();
        ctx.fillStyle = g; ctx.fill();
        ctx.restore();
        ctx.beginPath();
        coords.forEach(([cx, cy], i) => (i ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy)));
      }
      ctx.strokeStyle = sr.color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round';
      ctx.shadowColor = hexA(sr.color, 0.5); ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // crosshair
    if (hover && Number.isFinite(t0)) {
      const tx = t0 + ((hover.x - pad.l) / W) * (t1 - t0);
      let nearest = null;
      for (const sr of data) for (const p of sr.values) if (p.t >= t0 && (!nearest || Math.abs(p.t - tx) < Math.abs(nearest - tx))) nearest = p.t;
      if (nearest !== null) {
        const cx = Math.round(x(nearest)) + 0.5;
        ctx.strokeStyle = css('--line-2'); ctx.beginPath(); ctx.moveTo(cx, pad.t); ctx.lineTo(cx, pad.t + H); ctx.stroke();
        const rows = [];
        let acc = 0;
        for (const sr of data) {
          const p = sr.values.find((q) => q.t === nearest);
          if (!p) continue;
          acc += p.v ?? 0;
          const yy = y(o.stacked ? acc : p.v ?? 0);
          ctx.fillStyle = sr.color; ctx.beginPath(); ctx.arc(cx, yy, 3.5, 0, Math.PI * 2); ctx.fill();
          rows.push([sr, p.v]);
        }
        tip.replaceChildren(
          h('div', { class: 'small muted', style: { marginBottom: '4px' } }, new Date(nearest).toLocaleTimeString()),
          ...rows.reverse().map(([sr, v]) => h('div', { class: 'tip-row' }, h('span', { class: 'row', style: { gap: '6px' } }, h('i', { class: 'sw', style: { background: sr.color } }), sr.label), h('b', {}, v === null || v === undefined ? '—' : o.yFormat(v)))));
        tip.hidden = false;
        const r = el.getBoundingClientRect();
        const tw = tip.offsetWidth || 160;
        tip.style.left = `${Math.min(window.innerWidth - tw - 8, r.left + cx + 14)}px`;
        tip.style.top = `${r.top + 10}px`;
      }
    } else tip.hidden = true;
    drawnAt = performance.now();
  }

  function schedule() { if (!raf) raf = requestAnimationFrame(draw); }

  canvas.addEventListener('mousemove', (e) => { const r = canvas.getBoundingClientRect(); hover = { x: e.clientX - r.left }; schedule(); });
  canvas.addEventListener('mouseleave', () => { hover = null; schedule(); });
  const ro = new ResizeObserver(schedule);
  ro.observe(el);
  document.body.append(tip);
  schedule();
  void drawnAt;

  return {
    el,
    update(next) { data = next; schedule(); },
    destroy() { ro.disconnect(); tip.remove(); cancelAnimationFrame(raf); },
  };
}

/** A small SVG sparkline that draws itself in. values: numbers. */
export function sparkline(values, { color = 'var(--torch)', height = 46, width = 240, fill = true, cls = 'spark' } = {}) {
  const vals = values.length ? values : [0, 0];
  const max = Math.max(...vals, 1e-9);
  const step = width / Math.max(1, vals.length - 1);
  const pts = vals.map((v, i) => [i * step, height - 3 - (v / max) * (height - 8)]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const id = `sg${Math.random().toString(36).slice(2, 8)}`;
  const line = s('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.6, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke', class: 'spark-line' });
  const svg = s('svg', { class: cls, viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' },
    s('defs', {}, s('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: '0', 'stop-color': color, 'stop-opacity': '0.28' }), s('stop', { offset: '1', 'stop-color': color, 'stop-opacity': '0' }))),
    fill ? s('path', { d: `${d} L${width},${height} L0,${height} Z`, fill: `url(#${id})` }) : null,
    line);
  return svg;
}

/** A donut of parts [{ label, value, color }] with an optional centre text. */
export function donut(parts, { size = 140, thickness = 16, center = null, sub = '' } = {}) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let off = 0;
  const arcs = parts.filter((p) => p.value > 0).map((p) => {
    const len = (p.value / total) * c;
    const arc = s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: p.color, 'stroke-width': thickness, 'stroke-dasharray': `${Math.max(0, len - 2)} ${c}`, 'stroke-dashoffset': -off, 'stroke-linecap': 'butt' });
    arc.append(s('title', {}, `${p.label}: ${p.value}`));
    off += len;
    return arc;
  });
  const svg = s('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, class: 'donut' },
    s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--line)', 'stroke-width': thickness }),
    s('g', { transform: `rotate(-90 ${size / 2} ${size / 2})` }, ...arcs));
  return h('div', { class: 'ring', style: { width: `${size}px`, height: `${size}px` } }, svg,
    center !== null ? h('div', { class: 'ring-val' }, h('b', { style: { fontSize: `${Math.round(size / 6)}px` } }, center), h('span', {}, sub)) : null);
}

/** The health ring: a 0-100 score, coloured by how good it is. Returns the element with .set(score). */
export function healthRing(score, { size = 150, thickness = 12 } = {}) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const arc = s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': thickness, 'stroke-linecap': 'round', 'stroke-dasharray': c, 'stroke-dashoffset': c });
  const val = h('b', {}, '—');
  const label = h('span', {}, 'health');
  const el = h('div', { class: 'ring', style: { width: `${size}px`, height: `${size}px` } },
    s('svg', { width: size, height: size }, s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--line)', 'stroke-width': thickness }), arc),
    h('div', { class: 'ring-val' }, val, label));
  el.set = (v) => {
    const score = Math.max(0, Math.min(100, v ?? 0));
    arc.setAttribute('stroke', score >= 85 ? 'var(--ok)' : score >= 60 ? 'var(--warn)' : 'var(--bad)');
    requestAnimationFrame(() => arc.setAttribute('stroke-dashoffset', String(c * (1 - score / 100))));
    countTo(val, score);
  };
  el.set(score);
  return el;
}

/** Animate a number in an element from its current value to `to`. */
export function countTo(el, to, { format = (v) => String(Math.round(v)), duration = 700 } = {}) {
  const from = Number(el.dataset.v ?? 0);
  el.dataset.v = String(to);
  if (reduced() || !Number.isFinite(from) || !Number.isFinite(to)) { el.textContent = format(to); return; }
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / duration);
    const e = 1 - (1 - k) ** 3;
    el.textContent = format(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Horizontal bars: rows [{ label, value, color, sub, onclick }]. */
export function bars(rows, { format = String, max = null } = {}) {
  const top = max ?? Math.max(1e-9, ...rows.map((r) => r.value));
  return h('div', { class: 'col', style: { gap: '9px' } }, ...rows.map((r) => {
    const fill = h('span', { style: { width: '0%', background: r.color ?? 'var(--torch)' } });
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${Math.max(1.5, (r.value / top) * 100)}%`; }));
    return h(r.onclick ? 'button' : 'div', { class: 'col', style: { gap: '5px', border: '0', background: 'transparent', padding: '0', textAlign: 'left', cursor: r.onclick ? 'pointer' : 'default' }, onclick: r.onclick },
      h('div', { class: 'row', style: { justifyContent: 'space-between', fontSize: '12.5px' } },
        h('span', { class: 'ellipsis', style: { maxWidth: '75%' }, title: r.label }, r.label, r.sub ? h('span', { class: 'muted' }, ` ${r.sub}`) : null),
        h('span', { class: 'tnum bold' }, format(r.value))),
      h('div', { class: 'bar' }, fill));
  }));
}
