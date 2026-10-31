// Property knowledge for the inspector: which properties to offer, how to split their
// values into editable pieces (numbers, units, transform functions, colors) and which
// slider ranges make sense. Pure helpers, no DOM except the color probe.

export const LENGTH = ['px', '%', 'em', 'rem', 'vw', 'vh'];
export const ANGLE = ['deg', 'turn', 'rad'];
const NONE = [''];

/** Known properties, grouped; feeds the autocomplete of the "add property" field. */
export const GROUPS = [
  ['Transform', ['transform', 'translate', 'scale', 'rotate']],
  ['Sichtbarkeit', ['opacity', 'visibility', 'filter']],
  ['Farbe', ['color', 'background-color', 'border-color', 'box-shadow']],
  ['Box', ['width', 'height', 'border-radius', 'margin', 'padding', 'top', 'left', 'right', 'bottom']],
  ['Text', ['font-size', 'font-weight', 'letter-spacing', 'line-height', 'text-shadow']],
];
export const KNOWN = GROUPS.flatMap(([, props]) => props);

// kind: 'fns' (list of functions), 'color', 'enum', 'text' (no structured editor), default: numeric tokens.
// range: slider [min, max, step] for single-number values, or one per unit ({ px: [...], em: [...] }). units: selectable
// units. def: value for a new declaration.
const PROPS = {
  opacity: { range: [0, 1, 0.01], def: '1' },
  scale: { range: [0, 3, 0.01], def: '1' },
  rotate: { units: ANGLE, def: '0deg' },
  translate: { units: LENGTH, def: '0px 0px' },
  transform: { kind: 'fns', def: 'none' },
  filter: { kind: 'fns', def: 'none' },
  visibility: { kind: 'enum', options: ['visible', 'hidden'], def: 'visible' },
  color: { kind: 'color', def: '#ffffff' },
  'background-color': { kind: 'color', def: '#6d5efc' },
  'border-color': { kind: 'color', def: '#000000' },
  'box-shadow': { kind: 'text', def: '0 4px 12px rgba(0, 0, 0, 0.25)' },
  'text-shadow': { kind: 'text', def: '0 1px 2px rgba(0, 0, 0, 0.4)' },
  width: { units: LENGTH, def: '100px' },
  height: { units: LENGTH, def: '100px' },
  'border-radius': { units: LENGTH, def: '0px' },
  margin: { units: LENGTH, def: '0px' },
  padding: { units: LENGTH, def: '0px' },
  top: { units: LENGTH, def: '0px' },
  left: { units: LENGTH, def: '0px' },
  right: { units: LENGTH, def: '0px' },
  bottom: { units: LENGTH, def: '0px' },
  'font-size': { units: ['px', 'em', 'rem', '%'], range: { px: [4, 120, 1], em: [0.25, 6, 0.05], rem: [0.25, 6, 0.05], '%': [25, 400, 1] }, def: '16px' },
  'font-weight': { range: [100, 900, 1], def: '400' }, // step 1: variable fonts take any weight, static ones snap to theirs
  'letter-spacing': { units: ['px', 'em'], range: { px: [-10, 40, 0.1], em: [-0.2, 1, 0.005] }, def: '0px' },
  'line-height': { units: ['', 'px', 'em'], range: { '': [0.5, 3, 0.05], px: [0, 160, 1], em: [0.5, 3, 0.05] }, def: '1.2' },
};
export const specOf = (prop) => PROPS[prop] || {};
export const defaultOf = (prop) => specOf(prop).def ?? '0';

/** Functions offered inside `transform` / `filter`. def: args of a freshly added function. */
export const FNS = {
  transform: {
    translate: { def: ['0px', '0px'], units: LENGTH },
    translateX: { def: ['0px'], units: LENGTH },
    translateY: { def: ['0px'], units: LENGTH },
    translateZ: { def: ['0px'], units: ['px'] },
    scale: { def: ['1'], units: NONE, range: [0, 3, 0.01] },
    scaleX: { def: ['1'], units: NONE, range: [0, 3, 0.01] },
    scaleY: { def: ['1'], units: NONE, range: [0, 3, 0.01] },
    rotate: { def: ['0deg'], units: ANGLE },
    rotateX: { def: ['0deg'], units: ANGLE },
    rotateY: { def: ['0deg'], units: ANGLE },
    rotateZ: { def: ['0deg'], units: ANGLE },
    skew: { def: ['0deg', '0deg'], units: ANGLE, range: [-90, 90, 1] },
    skewX: { def: ['0deg'], units: ANGLE, range: [-90, 90, 1] },
    skewY: { def: ['0deg'], units: ANGLE, range: [-90, 90, 1] },
    perspective: { def: ['500px'], units: ['px'], range: [0, 2000, 10] },
  },
  filter: {
    blur: { def: ['0px'], units: ['px'], range: [0, 40, 0.5] },
    brightness: { def: ['1'], units: NONE, range: [0, 3, 0.01] },
    contrast: { def: ['1'], units: NONE, range: [0, 3, 0.01] },
    saturate: { def: ['1'], units: NONE, range: [0, 3, 0.01] },
    grayscale: { def: ['0'], units: NONE, range: [0, 1, 0.01] },
    sepia: { def: ['0'], units: NONE, range: [0, 1, 0.01] },
    invert: { def: ['0'], units: NONE, range: [0, 1, 0.01] },
    opacity: { def: ['1'], units: NONE, range: [0, 1, 0.01] },
    'hue-rotate': { def: ['0deg'], units: ANGLE, range: [0, 360, 1] },
    'drop-shadow': { def: ['0 4px 6px rgba(0, 0, 0, 0.4)'] },
  },
};

/** Slider range by unit when neither property nor function says otherwise. */
const UNIT_RANGE = {
  '': [0, 3, 0.01],
  px: [-300, 300, 1],
  '%': [-100, 200, 1],
  em: [-5, 5, 0.05],
  rem: [-5, 5, 0.05],
  vw: [-100, 100, 1],
  vh: [-100, 100, 1],
  deg: [-360, 360, 1],
  turn: [-2, 2, 0.01],
  rad: [-6.3, 6.3, 0.01],
  s: [0, 5, 0.05],
  ms: [0, 5000, 10],
};
export const rangeFor = (tok, range) => (Array.isArray(range) ? range : range?.[tok.unit]) || UNIT_RANGE[tok.unit] || UNIT_RANGE[''];

/** Splits on a top-level separator (',' or whitespace), ignoring separators inside parentheses. */
export function splitTop(str, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    const isSep = sep === ' ' ? /\s/.test(ch) : ch === sep;
    if (depth === 0 && isSep) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const NUM_RE = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i;

/** "12.5px" -> { n: 12.5, unit: 'px' }; anything else -> { raw }. */
export function parseNum(tok) {
  const m = tok.trim().match(NUM_RE);
  return m ? { n: parseFloat(m[1]), unit: m[2].toLowerCase() } : { raw: tok.trim() };
}
export const fmtNum = (a) => a.raw ?? `${+a.n.toFixed(3)}${a.unit}`;

/** Space-separated numeric tokens ("10px 20px"), or null if any token isn't a plain number. */
export function parseTokens(value) {
  const toks = splitTop(value, ' ').map(parseNum);
  return toks.length && toks.length <= 4 && toks.every((t) => t.raw === undefined) ? toks : null;
}
export const fmtTokens = (toks) => toks.map(fmtNum).join(' ');

/** "translateY(-10px) scale(1.2)" -> [{ name, args }], "none" -> [], unparseable -> null. */
export function parseFns(value) {
  const v = value.trim();
  if (!v || v === 'none') return [];
  const fns = [];
  let end = 0;
  for (const m of v.matchAll(/([a-z][a-z0-9-]*)\(([^()]*)\)/gi)) {
    if (v.slice(end, m.index).trim()) return null;
    end = m.index + m[0].length;
    fns.push({ name: m[1], args: splitTop(m[2], ',').map(parseNum) });
  }
  return v.slice(end).trim() ? null : fns;
}
export const fmtFns = (fns) => (fns.length ? fns.map((f) => `${f.name}(${f.args.map(fmtNum).join(', ')})`).join(' ') : 'none');

let probe;
/** Resolves any CSS color the browser understands to { r, g, b, a }, or null. */
export function toRgba(css) {
  if (!probe) {
    probe = document.createElement('i');
    probe.hidden = true;
    document.body.append(probe);
  }
  probe.style.color = '';
  probe.style.color = css;
  if (!probe.style.color) return null;
  const m = getComputedStyle(probe).color.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return null;
  const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).map(parseFloat);
  return { r, g, b, a };
}
export const toHex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
export const fmtColor = (c) => (c.a < 1 ? `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${+c.a.toFixed(2)})` : toHex(c));
