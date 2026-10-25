// ASCII aurora for the landing page, in the portfolio's voice: a quiet glyph field on a black page,
// twelve density levels of · : ░ ▒ ▓ in the page's foreground colour, and only the two densest
// levels – the peaks – in the accent. Same grid rules as the portfolio (cell = width / 160 clamped to
// 9–14 px, cell aspect 1.55, font 1.15 × cell), same field shape (warped vertical curtains, a drifting
// band envelope, fine rays, eased so most cells stay faint). Still cheap: a sine-based field instead
// of noise tables, one fillText per (row, level) with letterSpacing snapping glyphs to the cell grid,
// ~12 fps, idle while hidden, a still frame under reduced motion.

// [glyph, ink alpha] per level, 1-based; level 0 is empty. Same ramp as the portfolio.
const LEVELS = [
  ['·', 0.24], ['·', 0.36], ['·', 0.52],
  [':', 0.37], [':', 0.54], [':', 0.79],
  ['░', 0.46], ['░', 0.68], ['░', 0.96],
  ['▒', 0.7],
  ['▓', 0.69], ['▓', 1],
];
const ACCENT_FROM = 11; // levels at or above this render in the accent colour
const FG = '250, 250, 249'; // off-white
const ACCENT = '233, 113, 48'; // the logo's orange (the portfolio uses its amber here)
const FG_ALPHA = 0.17;
const ACCENT_ALPHA = 0.22;
const FPS = 12;
const PACE = 0.22; // field time per second – the portfolio idles down to a drift like this
const GRID = { targetColumns: 160, minCell: 9, maxCell: 14, aspect: 1.55, fontScale: 1.15, fieldSpan: 1.25, minFieldWidth: 640 };

let canvas;
let ctx;
let raf = 0;
let last = 0;
let host;
let cols = 0;
let rows = 0;
let cellW = 10;
let cellH = 15;
let fieldScale = 0.001;
const t0 = Math.random() * 100;

/* Cheap pseudo-noise in [-1, 1]: three sines in irrational directions, nothing to precompute. */
function noise(x, y) {
  // Normalised to use the whole range like simplex noise does (the plain sum rarely leaves ±0.6).
  const v = (Math.sin(x * 1.7 + Math.sin(y * 1.3 + x * 0.4)) + Math.sin(y * 1.1 - Math.sin(x * 0.7)) * 0.8 + Math.sin((x - y) * 0.9 + 2.1) * 0.6) / 1.4;
  return v > 1 ? 1 : v < -1 ? -1 : v;
}
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Aurora intensity in [0, 1] at field coordinates (x, y) – the portfolio's sample() with sines for noise. */
function sample(x, y, t) {
  const wx = noise(x * 0.6 + t * 0.5, y * 0.3 - t * 0.15);
  const wy = noise(x * 0.6 - 17.3 - t * 0.25, y * 0.3 + 9.1 + t * 0.35);
  const ux = x + wx * 0.6;
  const uy = y + wy * 0.4;
  const curtain = noise(ux * 2.1, uy * 0.42 + t * 0.45);
  const band = noise(ux * 0.85 + 31.7, uy * 1.15 - t * 0.3);
  const rays = noise(ux * 8.5, uy * 0.22 + t * 0.8);
  const body = smoothstep(-0.5, 0.75, curtain * 0.55 + band * 0.65);
  return body * Math.sqrt(body) * (0.7 + 0.3 * rays);
}

function layout() {
  const r = host.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cellW = Math.min(Math.max(r.width / GRID.targetColumns, GRID.minCell), GRID.maxCell);
  cellH = Math.round(cellW * GRID.aspect * dpr) / dpr;
  cellW = Math.round(cellW * dpr) / dpr; // whole device pixels per cell
  fieldScale = GRID.fieldSpan / Math.max(r.width, GRID.minFieldWidth);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = `${r.width}px`;
  canvas.style.height = `${r.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = `${Math.round(cellW * GRID.fontScale)}px "Departure Mono", monospace`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const advance = ctx.measureText('M').width || cellW * 0.7;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${cellW - advance}px`; // snap the string to the cell grid
  cols = Math.ceil(r.width / cellW);
  rows = Math.ceil(r.height / cellH);
}

function draw(t) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const levels = LEVELS.length;
  for (let y = 0; y < rows; y++) {
    const lines = new Array(levels).fill(null);
    const fy = (y + 0.5) * cellH * fieldScale;
    for (let x = 0; x < cols; x++) {
      const v = sample((x + 0.5) * cellW * fieldScale, fy, t) * 1.08; // only the very densest cores reach the accent levels
      const level = Math.min(levels, Math.floor(v * (levels + 1)));
      if (level < 1) continue;
      if (!lines[level - 1]) lines[level - 1] = new Array(cols).fill(' ');
      lines[level - 1][x] = LEVELS[level - 1][0];
    }
    const py = (y + 0.5) * cellH;
    for (let l = 0; l < levels; l++) {
      if (!lines[l]) continue;
      const peak = l + 1 >= ACCENT_FROM;
      ctx.fillStyle = `rgba(${peak ? ACCENT : FG}, ${(peak ? ACCENT_ALPHA : FG_ALPHA) * LEVELS[l][1]})`;
      ctx.fillText(lines[l].join(''), 0, py);
    }
  }
}

function tick(now) {
  raf = requestAnimationFrame(tick);
  if (now - last < 1000 / FPS) return;
  last = now;
  draw(t0 + (now / 1000) * PACE);
}

export function startAurora(container) {
  if (!container || raf) return;
  host = container;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'aurora-ascii';
    canvas.setAttribute('aria-hidden', 'true');
    ctx = canvas.getContext('2d', { alpha: true });
    addEventListener('resize', () => host && layout());
    document.addEventListener('visibilitychange', () => (document.hidden ? pause() : resume()));
  }
  host.prepend(canvas);
  document.fonts?.load('14px "Departure Mono"').finally(() => {
    layout();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return draw(t0);
    resume();
  });
}

function resume() {
  if (host && !raf && !matchMedia('(prefers-reduced-motion: reduce)').matches) raf = requestAnimationFrame(tick);
}
function pause() {
  cancelAnimationFrame(raf);
  raf = 0;
}

export function stopAurora() {
  pause();
  canvas?.remove();
  host = null;
}
