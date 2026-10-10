// Shield: who is knocking on this Traefik and what it does about it. Every source address comes in
// from its own direction; what Traefik stops at the edge (rate limits, allow lists, CrowdSec, auth,
// unknown hosts) breaks on the shield, what gets through reaches the core. Below: the numbers, the
// loudest sources, what they aim at, CrowdSec's bans and every attack so far.
import { h, icon } from '../lib/dom.js';
import { store, api } from '../lib/store.js';
import { card, stat, badge, segmented, tabs, drawer, kv, copyButton, table, empty, banner } from '../lib/components.js';
import { timeChart } from '../lib/charts.js';
import { num, rate, pct, time, dateTime, duration, ago } from '../lib/format.js';
import { barList, liveSpark, guide, code } from '../lib/observe.js';

const KINDS = [
  { id: 'pass', label: 'Got through', short: 'through', cssVar: '--ok' },
  { id: 'error', label: 'Backend failed', short: 'failed', cssVar: '--ember' },
  { id: 'limit', label: 'Rate limited', short: '429', cssVar: '--warn' },
  { id: 'block', label: 'Blocked', short: '403', cssVar: '--bad' },
  { id: 'auth', label: 'Asked to log in', short: '401', cssVar: '--violet' },
  { id: 'miss', label: 'Unknown host', short: 'no route', cssVar: '--muted' },
];
const STOPPED = ['limit', 'block', 'auth', 'miss'];
const TAU = Math.PI * 2;

const regionName = (() => {
  try { const dn = new Intl.DisplayNames(['en'], { type: 'region' }); return (cc) => { try { return dn.of(cc) ?? cc; } catch { return cc; } }; } catch { return (cc) => cc; }
})();

function fnv(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return (x >>> 0) / 4294967296;
}
// a source always comes from the same direction, so a loud one draws a visible stream
const angleOf = (ip) => fnv(ip) * TAU;
const angDist = (a, b) => { const d = Math.abs(a - b) % TAU; return d > Math.PI ? TAU - d : d; };
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888888';
function rgba(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

// ── the stage ────────────────────────────────────────────────────────────────

function makeStage() {
  const canvas = h('canvas', { class: 'sh-canvas', role: 'img', 'aria-label': 'Requests arriving at Traefik: stopped at the shield or let through to the core' });
  const ctx = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const C = {};
  const NSEG = 72;
  const heat = new Float32Array(NSEG);
  const heatColor = new Array(NSEG).fill(null);
  let W = 0; let H = 0; let dpr = 1; let cx = 0; let cy = 0; let R = 100; let coreR = 30;
  let particles = []; let sparks = []; let ripples = []; let locks = []; let queue = [];
  const labels = new Map();
  let level = 'calm';
  let coreGlow = 0; let coreHurt = 0; let attackT = 0;
  let last = performance.now(); let raf = 0; let alive = true;
  let paused = false;
  let stars = []; let hex = null;
  let avoid = [];   // the overlay boxes, so labels stay out from under them

  function readColors() {
    for (const k of KINDS) C[k.id] = cssVar(k.cssVar);
    Object.assign(C, { torch: cssVar('--torch'), violet: cssVar('--violet'), text: cssVar('--text'), muted: cssVar('--muted'), bad: cssVar('--bad'), warn: cssVar('--warn'), panel: cssVar('--panel-solid') });
    C.light = document.documentElement.dataset.theme === 'light';
  }

  function hexPattern() {
    const s = 10; const w = Math.sqrt(3) * s;
    const off = document.createElement('canvas');
    off.width = Math.round(w); off.height = Math.round(3 * s);
    const g = off.getContext('2d');
    g.strokeStyle = rgba(C.violet, C.light ? 0.22 : 0.16);
    g.lineWidth = 1;
    const at = (x, y) => {
      g.beginPath();
      for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; const px = x + s * Math.cos(a); const py = y + s * Math.sin(a); if (i) g.lineTo(px, py); else g.moveTo(px, py); }
      g.closePath(); g.stroke();
    };
    for (const [x, y] of [[0, 0], [w, 0], [w / 2, 1.5 * s], [0, 3 * s], [w, 3 * s]]) at(x, y);
    return ctx.createPattern(off, 'repeat');
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    cx = W / 2; cy = H / 2;
    R = Math.min(W * 0.3, H * 0.3);
    coreR = R * 0.32;
    stars = Array.from({ length: Math.round((W * H) / 7000) }, () => [Math.random() * W, Math.random() * H, 0.3 + Math.random() * 1.1, Math.random() * TAU]);
    readColors();
    hex = hexPattern();
    if (reduced) draw(performance.now() / 1000);
  }

  // where a direction leaves the canvas: sources enter from the border, never from inside
  function edge(a, inset = -10) {
    const dx = Math.cos(a); const dy = Math.sin(a);
    const t = Math.min(Math.abs((W / 2 - inset) / (dx || 1e-9)), Math.abs((H / 2 - inset) / (dy || 1e-9)));
    return [cx + dx * t, cy + dy * t, t];
  }

  function spawn(kind, a, w) {
    if (particles.length > 720) return;
    const aa = a + (Math.random() - 0.5) * 0.07;
    const [sx, sy] = edge(aa);
    const ux = Math.cos(aa); const uy = Math.sin(aa);
    const rx = cx + ux * R; const ry = cy + uy * R;
    const dist = Math.hypot(sx - rx, sy - ry);
    const speed = (STOPPED.includes(kind) ? 250 : 210) * (0.75 + Math.random() * 0.5) * (level === 'attack' ? 1.2 : 1);
    particles.push({ kind, sx, sy, rx, ry, ux, uy, nx: -uy, ny: ux, x: sx, y: sy, px: sx, py: sy, p: 0, dur: Math.max(0.4, dist / speed), bend: (Math.random() - 0.5) * 70, r: Math.min(4.4, 1.4 + Math.sqrt(w) * 0.45), phase: 'in', t: 0 });
  }

  function burst(x, y, color, k, speed, ux, uy) {
    for (let i = 0; i < k; i++) {
      const a = Math.atan2(uy, ux) + (Math.random() - 0.5) * 2.2;
      const v = speed * (0.4 + Math.random() * 0.8);
      sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.5 + Math.random() * 0.4, max: 0.9, color, r: 0.8 + Math.random() * 1.3 });
    }
  }

  function warm(a, amount, color) {
    const i = Math.floor((((a % TAU) + TAU) % TAU) / TAU * NSEG);
    for (const [j, f] of [[i, 1], [(i + 1) % NSEG, 0.45], [(i + NSEG - 1) % NSEG, 0.45]]) {
      heat[j] = Math.min(1.4, heat[j] + amount * f);
      heatColor[j] = color;
    }
  }

  function hit(p) {
    const a = Math.atan2(p.uy, p.ux);
    const col = C[p.kind];
    if (p.kind === 'pass' || p.kind === 'error') { p.phase = 'core'; p.t = 0; return; }
    if (p.kind === 'block') {
      warm(a, 0.55, col);
      burst(p.rx, p.ry, col, 7, 150, p.ux, p.uy);
      p.phase = 'dead';
      return;
    }
    if (p.kind === 'miss') {
      burst(p.rx, p.ry, col, 2, 50, p.ux, p.uy);
      p.phase = 'fade'; p.t = 0;
      return;
    }
    // limit, auth: bounce back out
    warm(a, 0.35, col);
    burst(p.rx, p.ry, col, 3, 110, p.ux, p.uy);
    p.phase = 'out'; p.t = 0;
    p.vx = p.ux * (80 + Math.random() * 60) + p.nx * (Math.random() - 0.5) * 140;
    p.vy = p.uy * (80 + Math.random() * 60) + p.ny * (Math.random() - 0.5) * 140;
  }

  function update(dt) {
    for (const p of particles) {
      p.px = p.x; p.py = p.y;
      if (p.phase === 'in') {
        p.p += dt / p.dur;
        const k = Math.min(1, p.p);
        const bend = Math.sin(k * Math.PI) * p.bend;
        p.x = p.sx + (p.rx - p.sx) * k + p.nx * bend;
        p.y = p.sy + (p.ry - p.sy) * k + p.ny * bend;
        if (p.p >= 1) hit(p);
      } else if (p.phase === 'core') {
        p.t += dt / 0.45;
        const k = Math.min(1, p.t);
        p.x = p.rx + (cx - p.rx) * k; p.y = p.ry + (cy - p.ry) * k;
        if (k >= 1) { p.phase = 'dead'; coreGlow = Math.min(1.6, coreGlow + 0.03 * p.r); if (p.kind === 'error') coreHurt = Math.min(1, coreHurt + 0.12); }
      } else if (p.phase === 'out') {
        p.t += dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vx *= 0.985; p.vy *= 0.985;
        if (p.t > 0.9) p.phase = 'dead';
      } else if (p.phase === 'fade') {
        p.t += dt;
        if (p.t > 0.4) p.phase = 'dead';
      }
    }
    particles = particles.filter((p) => p.phase !== 'dead');
    for (const s of sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.vx *= 0.93; s.vy *= 0.93; s.life -= dt; }
    sparks = sparks.filter((s) => s.life > 0);
    for (const r of ripples) r.t += dt;
    ripples = ripples.filter((r) => r.t < r.dur);
    for (const l of locks) l.t += dt;
    locks = locks.filter((l) => l.t < 4);
    for (let i = 0; i < NSEG; i++) heat[i] *= Math.pow(0.18, dt);
    coreGlow *= Math.pow(0.35, dt);
    coreHurt *= Math.pow(0.3, dt);
    for (const l of labels.values()) l.alpha = l.target ? l.alpha + (1 - l.alpha) * Math.min(1, dt * 4) : Math.max(0, l.alpha - dt * 3);
    for (const [k, l] of labels) if (l.target === 0 && l.alpha < 0.02) labels.delete(k);
    attackT += dt;
  }

  function draw(t) {
    if (!W) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const tone = level === 'attack' ? C.bad : level === 'elevated' ? C.warn : C.violet;
    const pulse = level === 'attack' ? 0.5 + 0.5 * Math.sin(t * 4) : 0;

    // sky
    for (const [x, y, r, ph] of stars) {
      ctx.fillStyle = rgba(C.light ? C.muted : '#c7cbe6', (C.light ? 0.25 : 0.35) * (0.5 + 0.5 * Math.sin(t * 0.8 + ph)));
      ctx.fillRect(x, y, r, r);
    }
    if (level === 'attack') {
      const v = ctx.createRadialGradient(cx, cy, R * 1.2, cx, cy, Math.hypot(W, H) / 1.6);
      v.addColorStop(0, rgba(C.bad, 0));
      v.addColorStop(1, rgba(C.bad, 0.10 + 0.08 * pulse));
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    }
    // radar rings and the sweep
    ctx.lineWidth = 1;
    for (const k of [1.55, 2.2, 2.9, 3.7]) {
      ctx.strokeStyle = rgba(tone, C.light ? 0.10 : 0.08);
      ctx.beginPath(); ctx.arc(cx, cy, R * k, 0, TAU); ctx.stroke();
    }
    if (ctx.createConicGradient) {
      const sweep = (t * 0.55) % TAU;
      const g = ctx.createConicGradient(sweep, cx, cy);
      g.addColorStop(0, rgba(tone, C.light ? 0.10 : 0.13));
      g.addColorStop(0.08, rgba(tone, 0));
      g.addColorStop(1, rgba(tone, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, Math.hypot(W, H) / 2, 0, TAU); ctx.fill();
    }

    // the shield: a force field of hexagons inside a ring of segments that light up where they are hit
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R - 4, 0, TAU); ctx.clip();
    const inner = ctx.createRadialGradient(cx, cy, coreR, cx, cy, R);
    inner.addColorStop(0, rgba(tone, 0.02));
    inner.addColorStop(1, rgba(tone, C.light ? 0.10 : 0.14 + 0.1 * pulse));
    ctx.fillStyle = inner; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    if (hex) { ctx.globalAlpha = level === 'attack' ? 0.8 + 0.2 * pulse : 0.65; ctx.fillStyle = hex; ctx.fillRect(cx - R, cy - R, R * 2, R * 2); ctx.globalAlpha = 1; }
    ctx.restore();

    const gap = 0.012;
    for (let i = 0; i < NSEG; i++) {
      const a0 = (i / NSEG) * TAU + gap; const a1 = ((i + 1) / NSEG) * TAU - gap;
      ctx.lineWidth = 5;
      ctx.strokeStyle = rgba(tone, (C.light ? 0.35 : 0.3) + 0.25 * pulse);
      ctx.beginPath(); ctx.arc(cx, cy, R, a0, a1); ctx.stroke();
      const q = heat[i];
      if (q > 0.03 && heatColor[i]) {
        ctx.lineWidth = 4 + q * 7;
        ctx.strokeStyle = rgba(heatColor[i], Math.min(0.95, 0.25 + q * 0.6));
        ctx.beginPath(); ctx.arc(cx, cy, R + q * 2, a0, a1); ctx.stroke();
        ctx.lineWidth = 14 + q * 16;
        ctx.strokeStyle = rgba(heatColor[i], Math.min(0.22, q * 0.16));
        ctx.beginPath(); ctx.arc(cx, cy, R, a0, a1); ctx.stroke();
      }
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(tone, 0.25);
    ctx.beginPath(); ctx.arc(cx, cy, R + 10, 0, TAU); ctx.stroke();
    ctx.setLineDash([2, 6]);
    ctx.beginPath(); ctx.arc(cx, cy, R - 12, t * 0.2, t * 0.2 + TAU); ctx.stroke();
    ctx.setLineDash([]);

    // the core: what is behind Traefik, glowing with what gets through
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * (2.1 + coreGlow));
    const coreCol = coreHurt > 0.15 ? C.error : C.pass;
    glow.addColorStop(0, rgba(C.torch, 0.55));
    glow.addColorStop(0.35, rgba(coreCol, 0.18 + Math.min(0.35, coreGlow * 0.2)));
    glow.addColorStop(1, rgba(coreCol, 0));
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(cx, cy, coreR * (2.1 + coreGlow), 0, TAU); ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(C.torch, 0.55);
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, TAU); ctx.stroke();
    ctx.setLineDash([10, 8]);
    ctx.strokeStyle = rgba(C.torch, 0.3);
    ctx.beginPath(); ctx.arc(cx, cy, coreR * 0.78, -t * 0.4, -t * 0.4 + TAU); ctx.stroke();
    ctx.setLineDash([]);

    // requests
    ctx.globalCompositeOperation = C.light ? 'source-over' : 'lighter';
    for (const p of particles) {
      const col = C[p.kind];
      const fade = p.phase === 'out' ? Math.max(0, 1 - p.t / 0.9) : p.phase === 'fade' ? Math.max(0, 1 - p.t / 0.4) : p.phase === 'core' ? 1 - p.t * 0.6 : 1;
      const tx = p.x - (p.x - p.px) * 5; const ty = p.y - (p.y - p.py) * 5;
      ctx.lineWidth = p.r;
      ctx.lineCap = 'round';
      ctx.strokeStyle = rgba(col, 0.28 * fade);
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.fillStyle = rgba(col, 0.95 * fade);
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (p.phase === 'core' ? 1 - p.t * 0.5 : 1), 0, TAU); ctx.fill();
    }
    for (const s of sparks) {
      ctx.fillStyle = rgba(s.color, Math.max(0, s.life / s.max));
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const r of ripples) {
      const k = r.t / r.dur;
      ctx.lineWidth = r.w * (1 - k) + 0.5;
      ctx.strokeStyle = rgba(r.color, 0.6 * (1 - k));
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * (1 - (1 - k) ** 3), 0, TAU); ctx.stroke();
    }

    // CrowdSec bans: a lock where the source comes from
    for (const l of locks) {
      const pop = Math.min(1, l.t / 0.25);
      const s = 7 * (pop < 1 ? 0.6 + 0.6 * pop : 1) * (l.t > 3.4 ? Math.max(0, (4 - l.t) / 0.6) : 1);
      const x = cx + Math.cos(l.a) * R * 1.32; const y = cy + Math.sin(l.a) * R * 1.32;
      ctx.fillStyle = rgba(C.bad, 0.92); ctx.strokeStyle = rgba(C.bad, 0.92); ctx.lineWidth = s * 0.28;
      ctx.beginPath(); ctx.arc(x, y - s * 0.35, s * 0.55, Math.PI, 0); ctx.stroke();
      ctx.fillRect(x - s * 0.8, y - s * 0.35, s * 1.6, s * 1.15);
    }

    // the loudest sources, labelled where they come in
    ctx.font = '600 11px ui-monospace, "JetBrains Mono", Consolas, monospace';
    ctx.textBaseline = 'middle';
    for (const l of labels.values()) {
      if (l.alpha < 0.02) continue;
      const text = l.text;
      const w = ctx.measureText(text).width + 16;
      const cos = Math.cos(l.a); const sin = Math.sin(l.a);
      // on the first radar ring, where the stream comes in; pulled closer if an overlay is in the way
      let x = 0; let y = 0; let clear = false;
      for (let rr = R * 1.62; rr >= R * 1.14; rr -= 8) {
        const px = cx + cos * rr; const py = cy + sin * rr;
        x = Math.min(W - w - 6, Math.max(6, cos > 0.35 ? px : cos < -0.35 ? px - w : px - w / 2));
        y = Math.min(H - 14, Math.max(14, py));
        if (!avoid.some((b) => x < b.x + b.w && x + w > b.x && y - 10 < b.y + b.h && y + 10 > b.y)) { clear = true; break; }
      }
      if (!clear) continue;
      ctx.globalAlpha = l.alpha;
      ctx.fillStyle = rgba(C.panel, C.light ? 0.92 : 0.82);
      ctx.strokeStyle = rgba(l.banned ? C.bad : l.color, 0.6);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect?.(x, y - 10, w, 20, 10); ctx.fill(); ctx.stroke();
      ctx.fillStyle = l.banned ? C.bad : C.text;
      ctx.fillText(text, x + 8, y + 0.5);
      ctx.globalAlpha = 1;
    }
  }

  function frame(now) {
    raf = 0;
    if (!alive) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    while (queue.length && queue[0].at <= now) { const q = queue.shift(); spawn(q.kind, q.a, q.w); }
    update(dt);
    draw(now / 1000);
    raf = requestAnimationFrame(frame);
  }

  function setLabels(src) {
    // the loudest few get a label; one that already has one keeps it while it stays near the top
    const cands = src.slice(0, 14).filter((r) => r[1] >= 1).map(([ip, n, , , , , , , cc, banned]) => ({ ip, a: angleOf(ip), n, cc, banned }));
    const chosen = [];
    const fits = (c) => !chosen.some((x) => angDist(x.a, c.a) < 0.34)
      && ![...labels].some(([ip, l]) => ip !== c.ip && l.target === 0 && l.alpha > 0.2 && angDist(l.a, c.a) < 0.34);
    for (const c of cands) if (labels.get(c.ip)?.target && chosen.length < 6 && fits(c)) chosen.push(c);
    for (const c of cands) if (!chosen.includes(c) && chosen.length < 6 && fits(c)) chosen.push(c);
    const keep = new Set(chosen.map((c) => c.ip));
    for (const [ip, l] of labels) if (!keep.has(ip)) l.target = 0;
    for (const c of chosen) {
      const l = labels.get(c.ip) ?? { a: c.a, alpha: 0, rate: c.n };
      l.rate = l.rate * 0.5 + c.n * 0.5;
      l.target = 1;
      l.banned = Boolean(c.banned);
      l.color = C.text;
      l.text = `${c.ip}${c.cc ? `  ${c.cc}` : ''}  ${rate(l.rate)}/s${c.banned ? '  banned' : ''}`;
      labels.set(c.ip, l);
    }
  }

  return {
    canvas,
    start() {
      readColors();
      const ro = new ResizeObserver(resize);
      ro.observe(canvas);
      this.ro = ro;
      if (!reduced) raf = requestAnimationFrame(frame);
    },
    setPaused(v) { paused = v; if (v) queue = []; },
    setAvoid(list) { avoid = list; },
    feed(tk) {
      const was = level;
      level = tk.level;
      if (!W) return;
      if (level === 'attack' && was !== 'attack') ripples.push({ x: cx, y: cy, r0: R, r1: Math.hypot(W, H) / 2, t: 0, dur: 1.6, w: 6, color: C.bad });
      setLabels(tk.src);
      if (reduced) {
        for (const [ip, , , limit, block, auth] of tk.src) { const a = angleOf(ip); if (limit) warm(a, Math.min(1, limit / 20), C.limit); if (block) warm(a, Math.min(1, block / 20), C.block); if (auth) warm(a, Math.min(1, auth / 20), C.auth); }
        draw(performance.now() / 1000);
        return;
      }
      if (paused || document.hidden) { queue = []; return; }
      const now = performance.now();
      const budget = W < 600 ? 110 : 230;
      const items = [];
      let total = 0;
      for (const [ip, , pass, limit, block, auth, miss, error] of tk.src) {
        const a = angleOf(ip);
        for (const [kind, c] of [['pass', pass], ['error', error], ['limit', limit], ['block', block], ['auth', auth], ['miss', miss]]) if (c) { items.push([kind, a, c]); total += c; }
      }
      // passing traffic the log does not name (filtered to errors, or no log at all): from anywhere
      const anon = tk.anon ?? 0;
      total += anon;
      const scale = total > budget ? budget / total : 1;
      const push = (kind, a, c) => {
        const m = c * scale;
        let k = Math.floor(m) + (Math.random() < m % 1 ? 1 : 0);
        if (!k && Math.random() < 0.6) k = 1;
        for (let i = 0; i < k; i++) queue.push({ at: now + Math.random() * 980, kind, a, w: c / Math.max(1, k) });
      };
      for (const [kind, a, c] of items) push(kind, a, c);
      if (anon) {
        const m = anon * scale;
        const k = Math.floor(m) + (Math.random() < m % 1 ? 1 : 0);
        for (let i = 0; i < k; i++) queue.push({ at: now + Math.random() * 980, kind: 'pass', a: Math.random() * TAU, w: anon / Math.max(1, k) });
      }
      queue.sort((x, y) => x.at - y.at);
      if (queue.length > 900) queue = queue.slice(-900);
    },
    ban(ip) {
      const a = angleOf(ip);
      locks.push({ a, t: 0 });
      ripples.push({ x: cx + Math.cos(a) * R * 1.32, y: cy + Math.sin(a) * R * 1.32, r0: 4, r1: 46, t: 0, dur: 1.1, w: 3, color: C.bad });
      const l = labels.get(ip);
      if (l) { l.banned = true; l.text = l.text.includes('banned') ? l.text : `${l.text}  banned`; }
    },
    destroy() { alive = false; cancelAnimationFrame(raf); this.ro?.disconnect(); },
  };
}

// ── helpers for the page ─────────────────────────────────────────────────────

const countryLabel = (cc) => (cc ? `${cc} · ${regionName(cc)}` : 'Unknown');
const stoppedOf = (c) => STOPPED.reduce((s, k) => s + (c[k] ?? 0), 0);

function splitBar(c) {
  const total = Math.max(1, c.n ?? KINDS.reduce((s, k) => s + (c[k.id] ?? 0), 0));
  return h('span', { class: 'sh-split', title: KINDS.filter((k) => c[k.id]).map((k) => `${k.label}: ${num(c[k.id])}`).join('\n') },
    ...KINDS.filter((k) => c[k.id]).map((k) => h('i', { style: { width: `${(c[k.id] / total) * 100}%`, background: `var(${k.cssVar})` } })));
}

function sourceCell(r) {
  return h('div', { class: 'sh-src' },
    h('span', { class: 'mono bold' }, r.ip),
    r.cc ? h('span', { class: 'sh-cc', title: regionName(r.cc) }, r.cc) : null,
    r.ban ? badge('banned', 'bad', { title: `${r.ban.scenario} · until ${dateTime(r.ban.until)}` }) : null);
}

const cscliBan = (ip) => `cscli decisions add --ip ${ip} --duration 24h --reason "seen in Enodia"`;

async function openSource(ip) {
  const body = h('div', { class: 'col sh-drawer' }, h('div', { class: 'muted small' }, 'Loading…'));
  drawer(ip, body);
  let d;
  try { d = await api(`shield/source?ip=${encodeURIComponent(ip)}`); } catch (e) { body.replaceChildren(empty('Could not load this source', e.message, 'alert')); return; }
  const c = d.c ?? {};
  const mins = (d.mins ?? []).map(([, n]) => n);
  const spark = liveSpark({ color: 'var(--torch)', width: 320, height: 54, cls: 'sh-mini' });
  spark.set(mins.length ? mins : [0]);
  body.replaceChildren(
    h('div', { class: 'row wrap' },
      d.cc ? badge(countryLabel(d.cc)) : null,
      d.ban ? badge(`banned by CrowdSec · ${d.ban.scenario}`, 'bad') : null,
      d.cloudflare ? badge('a Cloudflare address', 'warn', { title: 'Traefik sees Cloudflare instead of the visitor here: trust Cloudflare\'s ranges in forwardedHeaders.trustedIPs' }) : null),
    d.seen ? h('div', { class: 'col' },
      h('div', { class: 'sh-dstats' },
        h('div', {}, h('b', {}, num(c.n)), h('span', {}, 'requests, 15 min')),
        h('div', {}, h('b', { class: 'bad-text' }, pct(c.n ? stoppedOf(c) / c.n : 0)), h('span', {}, 'stopped at the edge')),
        h('div', {}, h('b', {}, ago(d.last)), h('span', {}, `first seen ${time(d.first)}`))),
      splitBar(c),
      h('div', { class: 'sh-legend-inline' }, ...KINDS.filter((k) => c[k.id]).map((k) => h('span', {}, h('i', { style: { background: `var(${k.cssVar})` } }), `${k.label} ${num(c[k.id])}`))),
      h('div', { class: 'sh-sub' }, 'Requests a minute'), spark,
      d.paths?.length ? h('div', { class: 'col' }, h('div', { class: 'sh-sub' }, 'Paths'), ...d.paths.map((p) => h('div', { class: 'row sh-kvrow' }, h('span', { class: 'mono ellipsis grow' }, p.key), h('span', { class: 'tnum muted' }, num(p.n))))) : null,
      d.hosts?.length ? h('div', { class: 'col' }, h('div', { class: 'sh-sub' }, 'Hosts'), ...d.hosts.map((p) => h('div', { class: 'row sh-kvrow' }, h('span', { class: 'mono ellipsis grow' }, p.key), h('span', { class: 'tnum muted' }, num(p.n))))) : null,
      d.ua?.length ? h('div', { class: 'col' }, h('div', { class: 'sh-sub' }, 'User agents'), ...d.ua.map((p) => h('div', { class: 'row sh-kvrow' }, h('span', { class: 'ellipsis grow' }, p.key), h('span', { class: 'tnum muted' }, num(p.n))))) : null)
      : h('div', { class: 'muted small' }, 'Not in the last 15 minutes of the access log.'),
    d.ban ? kv([['Banned by', d.ban.origin], ['Scenario', d.ban.scenario], ['Until', dateTime(d.ban.until)]]) : null,
    d.log?.length ? h('div', { class: 'col' }, h('div', { class: 'sh-sub' }, 'Latest requests'),
      h('div', { class: 'sh-log' }, ...d.log.slice(0, 25).map((e) => h('div', { class: 'sh-logrow' },
        h('span', { class: 'muted tnum' }, time(e.t)), h('span', { class: `sh-st s${String(e.status)[0]}` }, String(e.status ?? '')),
        h('span', { class: 'mono ellipsis' }, `${e.method ?? ''} ${e.host ?? ''}${e.path ?? ''}`))))) : null,
    h('div', { class: 'col sh-actions' },
      h('a', { class: 'btn sm', href: `#/logs?client=${encodeURIComponent(ip)}` }, icon('logs', { size: 14 }), 'Every request in the access log'),
      h('div', { class: 'row wrap' },
        h('a', { class: 'btn sm ghost', href: `https://www.abuseipdb.com/check/${encodeURIComponent(ip)}`, target: '_blank', rel: 'noreferrer' }, icon('external', { size: 13 }), 'AbuseIPDB'),
        h('a', { class: 'btn sm ghost', href: `https://ipinfo.io/${encodeURIComponent(ip)}`, target: '_blank', rel: 'noreferrer' }, icon('external', { size: 13 }), 'ipinfo')),
      d.ban ? null : h('div', { class: 'sh-cmd' }, h('div', { class: 'small muted' }, 'Ban it with CrowdSec (Enodia never changes anything itself):'),
        h('div', { class: 'row' }, h('code', { class: 'grow ellipsis' }, cscliBan(ip)), copyButton(cscliBan(ip), 'Copy command')))));
}

async function openAttack(id) {
  const body = h('div', { class: 'col sh-drawer' }, h('div', { class: 'muted small' }, 'Loading…'));
  const dr = drawer('Attack', body);
  let a;
  try { a = await api(`shield/attack?id=${encodeURIComponent(id)}`); } catch (e) { body.replaceChildren(empty('Could not load this attack', e.message, 'alert')); return; }
  const chart = timeChart([
    { key: 'total', label: 'All requests', color: cssVar('--torch'), values: a.series.map(([t, v]) => ({ t, v })) },
    { key: 'stopped', label: 'Stopped at the edge', color: cssVar('--bad'), values: a.series.map(([t, , v]) => ({ t, v })) },
  ], { height: 170, area: true, yFormat: rate });
  const list = (title, rows, fmt = (k) => k) => (rows?.length ? h('div', { class: 'col' }, h('div', { class: 'sh-sub' }, title),
    ...rows.map((r) => h('div', { class: 'row sh-kvrow' }, h('span', { class: 'mono ellipsis grow' }, fmt(r.key)), h('span', { class: 'tnum muted' }, num(r.n))))) : null);
  body.replaceChildren(
    h('div', { class: 'row wrap' }, a.live ? badge('happening now', 'bad') : badge(dateTime(a.start)), badge(duration(a.durationS)), badge(`${a.sources} sources`)),
    h('div', { class: 'sh-dstats' },
      h('div', {}, h('b', {}, `${rate(a.peak)}/s`), h('span', {}, 'at the peak')),
      h('div', {}, h('b', {}, num(a.requests)), h('span', {}, 'requests')),
      h('div', {}, h('b', { class: 'ok-text' }, pct(a.stoppedPct)), h('span', {}, 'stopped at the edge'))),
    a.series.length > 1 ? chart.el : null,
    a.top?.length ? h('div', { class: 'col' }, h('div', { class: 'sh-sub' }, 'Loudest sources'),
      ...a.top.map((s) => h('button', { type: 'button', class: 'row sh-kvrow sh-pick', onclick: () => { dr.close(); openSource(s.ip); } },
        h('span', { class: 'mono grow ellipsis' }, s.ip), s.cc ? h('span', { class: 'sh-cc' }, s.cc) : null,
        h('span', { class: 'tnum muted' }, `${num(s.n)} · ${pct(s.n ? s.stopped / s.n : 0)} stopped`)))) : null,
    list('What they asked for', a.paths),
    list('Countries', a.countries, countryLabel),
    list('User agents', a.uas),
    a.bans?.length ? h('div', { class: 'col' }, h('div', { class: 'sh-sub' }, `Banned by CrowdSec during it (${a.bans.length})`),
      ...a.bans.slice(0, 20).map((b) => h('div', { class: 'row sh-kvrow' }, h('span', { class: 'mono grow' }, b.ip), h('span', { class: 'muted small ellipsis' }, b.scenario)))) : null);
}

// ── the page ─────────────────────────────────────────────────────────────────

export default {
  render(ctx) {
    ctx.setCrumbs([['Shield']]);
    const meta = store.meta ?? {};
    let snap = null;
    let windowKey = 'm5';
    let targetKey = 'paths';
    let paused = false;
    let chartMinutes = 15;
    const lastNoted = new Map();
    const hist = { total: [], stopped: [], limit: [], block: [], sources: [], bans: [] };
    const push = (k, v) => { hist[k].push(v); if (hist[k].length > 60) hist[k].shift(); };

    // stage and its overlays
    const stage = makeStage();
    const levelEl = h('div', { class: 'sh-level' });
    const coreNum = h('div', { class: 'sh-core-num tnum' }, '—');
    const coreSub = h('div', { class: 'sh-core-sub' }, 'req/s');
    const legendRows = new Map(KINDS.map((k) => [k.id, h('span', { class: 'tnum' }, '0')]));
    const legend = h('div', { class: 'sh-legend' }, ...KINDS.map((k) => h('div', { class: 'sh-legend-row' }, h('i', { style: { background: `var(${k.cssVar})` } }), h('span', { class: 'grow' }, k.label), legendRows.get(k.id))));
    const feedEl = h('div', { class: 'sh-feed', 'aria-live': 'polite' });
    const csChip = h('div', { class: 'sh-cs', hidden: true });
    const stageEl = h('section', { class: 'card sh-stage' }, stage.canvas,
      h('div', { class: 'sh-core' }, coreNum, coreSub), levelEl, legend, feedEl, csChip);

    function note(text, tone = '', ic = 'shield') {
      const row = h('div', { class: `sh-note ${tone}`.trim() }, icon(ic, { size: 13 }), h('span', { class: 'muted tnum' }, time(Date.now())), h('span', { class: 'ellipsis' }, text));
      feedEl.prepend(row);
      while (feedEl.children.length > 4) feedEl.lastChild.remove();
    }

    // tiles
    const tile = (label, ic, color) => { const sp = liveSpark({ color, height: 46, width: 240 }); const el = stat({ label, value: '—', icon: ic, spark: sp }); el.sp = sp; el.foot = h('div', { class: 'stat-foot' }); el.valueEl.after(el.foot); return el; };
    const tTotal = tile('Requests / second', 'activity', 'var(--torch)');
    const tStopped = tile('Stopped at the edge', 'shield', 'var(--bad)');
    const tLimit = tile('Rate limited (429)', 'clock', 'var(--warn)');
    const tBlock = tile('Blocked (403)', 'xcircle', 'var(--bad)');
    const tSources = tile('Sources, 5 minutes', 'globe', 'var(--sky)');
    const tBans = tile('CrowdSec bans', 'lock', 'var(--violet)');

    // chart
    // the chart draws on canvas, which needs real colors rather than CSS variables
    const series = KINDS.map((k) => ({ key: k.id, label: k.label, color: cssVar(k.cssVar), values: [] }));
    const makeChart = () => timeChart(series, { height: 240, stacked: true, area: true, yFormat: rate, tipFormat: (v) => `${rate(v)}/s`, windowMs: chartMinutes * 60_000 });
    let chart = makeChart();
    const chartCard = card({ title: 'What Traefik did with each request', sub: 'Per second, stacked: what got through on the bottom, what was stopped on top', icon: 'traffic',
      tools: [segmented([[5, '5m'], [15, '15m']], chartMinutes, (v) => { chartMinutes = v; rebuildChart(); })], cls: 'span2' }, chart.el);
    function rebuildChart() {
      const old = chart;
      chart = makeChart();
      old.el.replaceWith(chart.el);
      old.destroy();
    }

    // attack card
    const attackBody = h('div', { class: 'col' });
    const attackCard = card({ title: 'Attacks', icon: 'zap' }, attackBody);

    // sources
    const srcTable = table([
      { key: 'ip', label: 'Source', render: sourceCell, sort: (r) => r.ip },
      { key: 'n', label: 'Requests', num: true, sort: (r) => r.n, render: (r) => num(r.n) },
      { key: 'stopped', label: 'Stopped', num: true, sort: (r) => (r.n ? r.stopped / r.n : 0), render: (r) => h('div', { class: 'sh-stopcell' }, splitBar(r.c), h('span', { class: 'tnum' }, pct(r.n ? r.stopped / r.n : 0))) },
      { key: 'path', label: 'Mostly asks for', render: (r) => h('span', { class: 'mono ellipsis sh-path', title: `${r.host ?? ''}${r.path ?? ''}` }, `${r.host ?? ''}${r.path ?? ''}` || '—') },
      { key: 'ua', label: 'User agent', render: (r) => h('span', { class: 'ellipsis sh-ua', title: r.ua ?? '' }, r.ua ?? '—') },
      { key: 'last', label: 'Last seen', sort: (r) => r.last, render: (r) => h('span', { class: 'muted small' }, ago(r.last)) },
    ], [], { rowClick: (r) => openSource(r.ip), rowKey: (r) => r.ip, empty: 'No sources yet', sortBy: 'n', desc: true });
    const srcCount = h('span', { class: 'muted small' });
    const srcCard = card({ title: 'Loudest sources', sub: 'Every address in the access log; click one for what it did', icon: 'globe', cls: 'span2 sh-src-card',
      tools: [srcCount, segmented([['m5', '5 min'], ['m15', '15 min']], windowKey, (v) => { windowKey = v; paintSnap(); })] }, srcTable.el);

    // countries and agents
    const countries = barList({ format: (v) => num(v), emptyText: 'No country information' });
    const countryHint = h('div', { class: 'small muted sh-hint', hidden: true },
      'Behind Cloudflare? Traefik can keep its country header: ', code('--accesslog.fields.headers.names.Cf-Ipcountry=keep'), '.');
    const uas = barList({ format: (v) => num(v), emptyText: 'No user agents yet' });
    const whoCard = card({ title: 'Where they come from', icon: 'globe' }, countries, countryHint, h('div', { class: 'sh-sub' }, 'User agents'), uas);

    // targets
    const targets = barList({ format: (v) => num(v), emptyText: 'Nothing yet' });
    const targetCard = card({ title: 'What they aim at', sub: 'Recent requests, fading over a few minutes', icon: 'tester',
      tools: [segmented([['paths', 'Paths'], ['hosts', 'Hosts'], ['routers', 'Routers']], targetKey, (v) => { targetKey = v; paintSnap(); })] }, targets);

    // crowdsec
    const csBody = h('div', { class: 'col' });
    const csCard = card({ title: 'CrowdSec', icon: 'lock' }, csBody);

    // notes on top: what this Traefik's setup means for the page
    const notes = h('div', { class: 'col sh-notes' });

    const pauseBtn = h('button', { type: 'button', class: 'btn sm', onclick: () => { paused = !paused; stage.setPaused(paused); paintPause(); } });
    const paintPause = () => pauseBtn.replaceChildren(icon(paused ? 'play' : 'pause', { size: 14 }), paused ? 'Resume' : 'Pause');
    paintPause();

    const el = h('div', { class: 'page sh-page' },
      h('div', { class: 'page-head' },
        h('div', { class: 'grow' },
          h('h1', { class: 'page-title' }, icon('shield', { size: 24, cls: 'torch-text' }), 'Shield'),
          h('p', { class: 'page-sub' }, 'Who is knocking on this Traefik, and what it does about it. Every source comes in from its own direction: what Traefik stops at the edge breaks on the shield, what gets through reaches your services.')),
        h('div', { class: 'row wrap' }, pauseBtn)),
      notes,
      stageEl,
      h('div', { class: 'grid g6 sh-tiles' }, tTotal, tStopped, tLimit, tBlock, tSources, tBans),
      h('div', { class: 'grid g3' }, chartCard, attackCard),
      h('div', { class: 'grid g3' }, srcCard, whoCard),
      h('div', { class: 'grid g2' }, targetCard, csCard));

    // ── painting ──

    function paintLevel(tk) {
      const lv = tk?.level ?? 'calm';
      levelEl.className = `sh-level ${lv}`;
      const base = tk?.baseline;
      const sub = tk?.warm ? 'learning what is normal here…'
        : lv === 'attack' && tk.attack ? `since ${time(tk.attack.start, false)} · peak ${rate(tk.attack.peak)}/s · ${num(tk.attack.sources)} sources`
          : base !== null && base !== undefined ? `normal here is about ${rate(base)} req/s` : '';
      levelEl.replaceChildren(
        h('div', { class: 'sh-level-title' }, h('span', { class: 'sh-level-dot' }), lv === 'attack' ? 'Under attack' : lv === 'elevated' ? 'Busier than usual' : 'Calm'),
        sub ? h('div', { class: 'sh-level-sub' }, sub) : null);
    }

    function onTick(tk) {
      const base = stage.canvas.getBoundingClientRect();
      stage.setAvoid([levelEl, legend, feedEl, csChip].filter((x) => !x.hidden && x.offsetParent).map((x) => {
        const r = x.getBoundingClientRect();
        return { x: r.left - base.left - 6, y: r.top - base.top - 6, w: r.width + 12, h: r.height + 12 };
      }).filter((b) => b.w > 12 && b.h > 12));
      stage.feed(tk);
      paintLevel(tk);
      const c = tk.c ?? {};
      const through = (c.pass ?? 0) + (tk.anon ?? 0);
      coreNum.textContent = rate(tk.total);
      coreSub.textContent = tk.stopped ? `req/s · ${rate(tk.stopped)} stopped` : 'req/s';
      for (const k of KINDS) legendRows.get(k.id).textContent = rate(k.id === 'pass' ? through : c[k.id] ?? 0);

      push('total', tk.total); push('stopped', tk.stopped); push('limit', c.limit ?? 0); push('block', c.block ?? 0);
      tTotal.valueEl.textContent = rate(tk.total); tTotal.sp.set(hist.total);
      tTotal.foot.textContent = tk.baseline !== null && tk.baseline !== undefined ? `usually ~${rate(tk.baseline)}/s` : '';
      tStopped.valueEl.textContent = rate(tk.stopped); tStopped.sp.set(hist.stopped);
      tStopped.foot.textContent = tk.total ? `${pct(tk.stopped / Math.max(tk.total, tk.stopped))} of all requests` : '';
      tLimit.valueEl.textContent = rate(c.limit ?? 0); tLimit.sp.set(hist.limit);
      tBlock.valueEl.textContent = rate(c.block ?? 0); tBlock.sp.set(hist.block);
      tBlock.foot.textContent = c.auth ? `+ ${rate(c.auth)}/s asked to log in` : '';

      // chart: one point a second
      const t = tk.t;
      const vals = { pass: tk.filtered ? Math.max(0, tk.total - tk.stopped - (c.error ?? 0)) : c.pass ?? 0, error: c.error ?? 0, limit: c.limit ?? 0, block: c.block ?? 0, auth: c.auth ?? 0, miss: c.miss ?? 0 };
      for (const sr of series) { sr.values.push({ t, v: vals[sr.key] }); while (sr.values.length && sr.values[0].t < t - 15 * 60_000) sr.values.shift(); }
      chart.update(series);

      // the feed: bans, attacks starting and ending, sources that suddenly get stopped a lot
      for (const b of tk.bans ?? []) {
        stage.ban(b.ip);
        note(`${b.ip} banned by CrowdSec · ${String(b.scenario).replace(/^crowdsecurity\//, '')}`, 'bad', 'lock');
      }
      if (tk.level === 'attack' && lastLevel !== 'attack') note(`Attack: ${rate(tk.total)} req/s`, 'bad', 'zap');
      if (tk.level !== 'attack' && lastLevel === 'attack') note('Attack over, back to normal', 'ok', 'ok');
      lastLevel = tk.level;
      const now = Date.now();
      for (const [ip, n, , limit, block, auth, , , cc] of tk.src.slice(0, 8)) {
        const st = limit + block + auth;
        if (st < 8 || now - (lastNoted.get(ip) ?? 0) < 20_000) continue;
        lastNoted.set(ip, now);
        const what = block >= limit && block >= auth ? 'blocked' : limit >= auth ? 'rate limited' : 'asked to log in';
        note(`${ip}${cc ? ` (${cc})` : ''} · ${rate(st)}/s ${what}${n > st ? `, ${rate(n - st)}/s through` : ''}`, block >= limit ? 'bad' : 'warn', 'shield');
      }
      if (lastNoted.size > 500) lastNoted.clear();
      if (tk.attack && snap) attackLive(tk.attack);
    }
    let lastLevel = store.shield?.level ?? 'calm';

    function attackLive(a) {
      const el2 = attackBody.querySelector('.sh-attack-live');
      if (!el2) { paintAttacks(); return; }
      el2.querySelector('[data-k="peak"]').textContent = `${rate(a.peak)}/s`;
      el2.querySelector('[data-k="req"]').textContent = num(a.requests);
      el2.querySelector('[data-k="stopped"]').textContent = pct(a.stoppedPct);
      el2.querySelector('[data-k="src"]').textContent = num(a.sources);
      el2.querySelector('[data-k="dur"]').textContent = duration((Date.now() - a.start) / 1000);
    }

    function paintAttacks() {
      const live = store.shield?.attack ?? (snap?.attack ? { ...snap.attack } : null);
      const list = snap?.attacks ?? [];
      const th = snap?.thresholds;
      const rows = list.slice(0, 6).map((a) => h('button', { type: 'button', class: 'sh-attack-row', onclick: () => openAttack(a.id) },
        h('div', { class: 'grow col' }, h('span', { class: 'bold small' }, dateTime(a.start)), h('span', { class: 'muted tiny' }, `${duration(a.durationS)} · ${num(a.sources)} sources${a.top?.[0] ? ` · loudest ${a.top[0].ip}` : ''}`)),
        h('div', { class: 'col sh-attack-nums' }, h('span', { class: 'bold tnum' }, `${rate(a.peak)}/s`), h('span', { class: 'tiny ok-text' }, `${pct(a.stoppedPct)} stopped`))));
      attackBody.replaceChildren(
        live ? h('button', { type: 'button', class: 'sh-attack-live', onclick: () => openAttack(live.id) },
          h('div', { class: 'row' }, h('span', { class: 'sh-level-dot' }), h('b', { class: 'grow' }, 'Happening now'), h('span', { class: 'tnum', 'data-k': 'dur' }, duration((Date.now() - live.start) / 1000))),
          h('div', { class: 'sh-attack-grid' },
            h('div', {}, h('b', { 'data-k': 'peak' }, `${rate(live.peak)}/s`), h('span', {}, 'peak')),
            h('div', {}, h('b', { 'data-k': 'req' }, num(live.requests)), h('span', {}, 'requests')),
            h('div', {}, h('b', { 'data-k': 'stopped' }, pct(live.stoppedPct)), h('span', {}, 'stopped')),
            h('div', {}, h('b', { 'data-k': 'src' }, num(live.sources)), h('span', {}, 'sources'))))
          : h('div', { class: 'sh-calm' }, icon('ok', { size: 20, cls: 'ok-text' }), h('div', {}, h('div', { class: 'bold' }, 'No attack right now'),
            th ? h('div', { class: 'small muted' }, th.fixed ? `An attack opens above ${th.attack} req/s, or when more than ${th.stopped} req/s get stopped at the edge, for 5 seconds.`
              : `An attack opens when traffic stays above ${th.attack} req/s (well over the usual), or more than ${th.stopped} req/s get stopped at the edge, for 5 seconds.`) : null)),
        list.length ? h('div', { class: 'sh-sub' }, 'Earlier') : h('div', { class: 'small muted' }, snap?.alerts ? 'Attacks are kept here and sent to your webhook.' : 'Attacks are kept here. Set ENODIA_WEBHOOK_URL to hear about them on Discord or Slack.'),
        ...rows);
    }

    function paintCrowdsec() {
      const cs = snap?.crowdsec;
      if (!cs?.enabled) {
        csChip.hidden = true;
        csBody.replaceChildren(
          h('p', { class: 'small muted' }, 'If CrowdSec guards this Traefik, Enodia can show who it banned, why and until when, and mark those sources here. It reads with a bouncer key, which can only read decisions.'),
          h('ol', { class: 'sh-steps' },
            h('li', {}, 'Create a key for Enodia: ', code('docker exec crowdsec cscli bouncers add enodia')),
            h('li', {}, 'Give it to Enodia: ', code('CROWDSEC_LAPI_URL=http://crowdsec:8080'), ' and ', code('CROWDSEC_BOUNCER_KEY=<the key>')),
            h('li', {}, 'Put Enodia on a network CrowdSec is on, and restart it.')));
        tBans.valueEl.textContent = '—';
        tBans.foot.textContent = 'not connected';
        return;
      }
      csChip.hidden = false;
      csChip.replaceChildren(icon('lock', { size: 13 }), cs.ok ? `CrowdSec · ${num(cs.local)} bans` : 'CrowdSec unreachable');
      csChip.classList.toggle('bad', !cs.ok);
      tBans.valueEl.textContent = num(cs.local ?? 0);
      push('bans', cs.local ?? 0); tBans.sp.set(hist.bans);
      tBans.foot.textContent = cs.community ? `+ ${num(cs.community)} from community lists` : '';
      const scen = barList({ format: (v) => num(v) });
      scen.set((cs.scenarios ?? []).map((s) => ({ key: s.name, label: s.name.replace(/^crowdsecurity\//, ''), value: s.n, color: 'var(--violet)', title: s.name })));
      csBody.replaceChildren(
        cs.ok ? null : banner('bad', 'CrowdSec does not answer', cs.error),
        h('div', { class: 'sh-dstats' },
          h('div', {}, h('b', {}, num(cs.local)), h('span', {}, 'local bans')),
          h('div', {}, h('b', {}, num(cs.community)), h('span', {}, 'community blocklist')),
          h('div', {}, h('b', {}, cs.checkedAt ? ago(cs.checkedAt) : '—'), h('span', {}, 'last checked'))),
        cs.scenarios?.length ? h('div', { class: 'sh-sub' }, 'Why they were banned') : null,
        cs.scenarios?.length ? scen : null,
        cs.recent?.length ? h('div', { class: 'sh-sub' }, 'Latest bans') : null,
        ...(cs.recent ?? []).slice(0, 8).map((d) => h('button', { type: 'button', class: 'row sh-kvrow sh-pick', onclick: () => openSource(d.value) },
          icon('lock', { size: 13, cls: 'bad-text' }), h('span', { class: 'mono' }, d.value), h('span', { class: 'muted small ellipsis grow' }, d.scenario.replace(/^crowdsecurity\//, '')),
          h('span', { class: 'tiny muted' }, `until ${time(d.until, false)}`))));
    }

    function paintNotes() {
      const out = [];
      if (!meta.features?.logs && !snap?.logs?.enabled) {
        out.push(guide({ icon: 'logs', title: 'Shield sees totals only', tone: 'torch',
          text: 'Without the access log Enodia knows how much traffic there is (from the metrics) but not who sends it or what Traefik does with it. Share the log and every source shows up here.',
          steps: [{ title: 'Write the access log as JSON, to a volume', snippets: [{ label: 'Flags', lang: 'sh', text: '--accesslog=true\n--accesslog.format=json\n--accesslog.filepath=/logs/access.log' }] },
            { title: 'Mount the same volume into Enodia, read-only, at /traefik-logs', snippets: [{ label: 'Compose', lang: 'yaml', text: 'volumes:\n  - traefik-logs:/traefik-logs:ro' }] }] }));
      } else if (snap?.logs?.filtered) {
        out.push(banner('info', 'This Traefik logs only some status codes', 'So traffic that gets through comes from the metrics and has no source; the sources below are the requests that were logged, usually the stopped ones.'));
      }
      notes.replaceChildren(...out);
    }

    function paintSnap() {
      if (!snap) return;
      const rows = snap.sources[windowKey];
      srcTable.update(rows.rows);
      srcCount.textContent = `${num(rows.count)} addresses`;
      tSources.valueEl.textContent = num(snap.sources.m5.count);
      push('sources', snap.sources.m5.count); tSources.sp.set(hist.sources);
      tSources.foot.textContent = `${num(snap.sources.m15.count)} in 15 minutes`;
      countries.set(snap.countryList.map((c) => ({ key: c.key, label: countryLabel(c.key), value: c.n, color: 'var(--sky)' })));
      countryHint.hidden = snap.countries;
      uas.set(snap.uas.map((u) => ({ key: u.key, label: u.key, value: u.n, color: 'var(--violet)', title: u.key })));
      targets.set(snap.targets[targetKey].map((x) => ({ key: x.key, label: x.key, value: x.n, color: 'var(--torch)', title: x.key })));
      paintAttacks();
      paintCrowdsec();
      paintNotes();
    }

    let seeded = false;
    async function refresh() {
      try { snap = await api('shield'); } catch { return; }
      // the first answer fills the chart with the 15 minutes before the page opened
      if (!seeded) {
        seeded = true;
        const first = series[0].values[0]?.t ?? Infinity;
        const older = snap.series.filter(([t]) => t < first - 1000);
        for (const sr of series) {
          const i = { pass: 2, limit: 3, block: 4, auth: 5, miss: 6, error: 7 }[sr.key];
          sr.values.unshift(...older.map((row) => ({ t: row[0], v: row[i] })));
        }
        chart.update(series);
      }
      paintSnap();
    }

    paintLevel(store.shield);
    refresh();
    const timer = setInterval(refresh, 10_000);
    requestAnimationFrame(() => stage.start());

    return {
      el,
      update(event, data) {
        if (event === 'shield') onTick(data);
      },
      destroy() {
        clearInterval(timer);
        stage.destroy();
        chart.destroy();
      },
    };
  },
};
