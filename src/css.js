// Reads @keyframes + animation timing out of a .css or .html file into a plain JSON
// model, and writes an edited model back while leaving everything else untouched.
import fs from 'node:fs';
import postcss from 'postcss';

const STYLE_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
const EASING_KEYWORDS = new Set(['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end']);
const DIRECTIONS = new Set(['normal', 'reverse', 'alternate', 'alternate-reverse']);
const FILLS = new Set(['none', 'forwards', 'backwards', 'both']);
const PLAY_STATES = new Set(['running', 'paused']);

export const DEFAULT_TIMING = { duration: 0, delay: 0, easing: 'ease', iterations: '1', direction: 'normal', fill: 'none' };

const LONGHANDS = {
  duration: 'animation-duration',
  delay: 'animation-delay',
  easing: 'animation-timing-function',
  iterations: 'animation-iteration-count',
  direction: 'animation-direction',
  fill: 'animation-fill-mode',
};

export const isHtml = (file) => /\.html?$/i.test(file);

/** Splits the file into CSS chunks: the whole file for .css, every <style> block for .html. */
export function readSources(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (!isHtml(file)) return { text, sources: [{ start: 0, end: text.length, css: text }] };
  const sources = [];
  for (const m of text.matchAll(STYLE_RE)) {
    const start = m.index + m[1].length;
    sources.push({ start, end: start + m[2].length, css: m[2] });
  }
  return { text, sources };
}

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

const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
const isTime = (t) => /^-?[\d.]+m?s$/i.test(t);
const isEasing = (t) => EASING_KEYWORDS.has(t) || /^(cubic-bezier|steps|linear)\(/.test(t);

function parseTime(t) {
  const n = parseFloat(t);
  return /ms$/i.test(t) ? { ms: n, unit: 'ms' } : { ms: n * 1000, unit: 's' };
}

function fmtTime(ms, unit) {
  return unit === 'ms' ? `${Math.round(ms)}ms` : `${+(ms / 1000).toFixed(3)}s`;
}

function fmtOffset(o) {
  return `${+o.toFixed(2)}%`;
}

function parseOffset(sel) {
  const s = sel.trim().toLowerCase();
  if (s === 'from') return 0;
  if (s === 'to') return 100;
  return parseFloat(s);
}

/** Parses one entry of the `animation` shorthand into { name, timing, unit, paused }. */
function parseShorthandEntry(entry) {
  const timing = { ...DEFAULT_TIMING };
  let name = null;
  let unit = 's';
  let times = 0;
  let paused = false;
  for (const tok of splitTop(entry, ' ')) {
    if (isTime(tok)) {
      const t = parseTime(tok);
      if (times++ === 0) {
        timing.duration = t.ms;
        unit = t.unit;
      } else timing.delay = t.ms;
    } else if (isEasing(tok)) timing.easing = tok;
    else if (tok === 'infinite' || /^[\d.]+$/.test(tok)) timing.iterations = tok;
    else if (DIRECTIONS.has(tok) && tok !== 'normal') timing.direction = tok;
    else if (FILLS.has(tok) && tok !== 'none') timing.fill = tok;
    else if (PLAY_STATES.has(tok)) paused = tok === 'paused';
    else if (name === null && tok !== 'normal' && tok !== 'none') name = unquote(tok);
  }
  return { name, timing, unit, paused };
}

function formatShorthandEntry(name, t, unit, paused) {
  const parts = [name, fmtTime(t.duration, unit)];
  if (t.easing !== 'ease') parts.push(t.easing);
  if (t.delay) parts.push(fmtTime(t.delay, unit));
  if (t.iterations !== '1') parts.push(t.iterations);
  if (t.direction !== 'normal') parts.push(t.direction);
  if (t.fill !== 'none') parts.push(t.fill);
  if (paused) parts.push('paused');
  return parts.join(' ');
}

function longhandValue(rule, prop, index) {
  let value = null;
  rule.each((n) => {
    if (n.type === 'decl' && n.prop.toLowerCase() === prop) value = n.value;
  });
  if (value === null) return null;
  const list = splitTop(value, ',');
  return list[index % list.length];
}

/** Finds every @keyframes block and the first rule that uses it. Returns live postcss nodes. */
function analyze(roots) {
  const found = new Map();
  roots.forEach((root, src) => {
    root.walkAtRules((at) => {
      if (at.name.toLowerCase() !== 'keyframes') return; // ignore -webkit- duplicates
      found.set(unquote(at.params), { src, at, usage: null });
    });
  });
  roots.forEach((root, src) => {
    root.walkDecls(/^animation(-name)?$/i, (decl) => {
      const rule = decl.parent;
      if (!rule || rule.type !== 'rule') return;
      const entries = splitTop(decl.value, ',');
      entries.forEach((entry, index) => {
        if (decl.prop.toLowerCase() === 'animation') {
          const p = parseShorthandEntry(entry);
          const f = p.name && found.get(p.name);
          if (f && !f.usage) f.usage = { kind: 'shorthand', src, rule, decl, index, timing: p.timing, unit: p.unit, paused: p.paused };
        } else {
          const f = found.get(unquote(entry));
          if (!f || f.usage) return;
          const timing = { ...DEFAULT_TIMING };
          let unit = 's';
          for (const [key, prop] of Object.entries(LONGHANDS)) {
            const v = longhandValue(rule, prop, index);
            if (v === null) continue;
            if (key === 'duration' || key === 'delay') {
              const t = parseTime(v);
              timing[key] = t.ms;
              if (key === 'duration') unit = t.unit;
            } else timing[key] = v;
          }
          f.usage = { kind: 'longhand', src, rule, decl, index, timing, unit };
        }
      });
    });
  });
  return found;
}

function keyframesOf(at) {
  const blocks = [];
  at.each((node) => {
    if (node.type !== 'rule') return;
    blocks.push({
      offsets: node.selectors.map(parseOffset),
      decls: node.nodes
        .filter((d) => d.type === 'decl')
        .map((d) => ({ prop: d.prop, value: d.value, ...(d.important ? { important: true } : {}) })),
    });
  });
  return blocks;
}

function parseFile(file) {
  const { text, sources } = readSources(file);
  const roots = sources.map((s) => postcss.parse(s.css, { from: file }));
  return { text, sources, roots, found: analyze(roots) };
}

/** JSON model of all animations in the file. */
export function loadModel(file) {
  const { found } = parseFile(file);
  const animations = [...found].map(([name, f]) => ({
    name,
    keyframes: keyframesOf(f.at),
    timing: f.usage ? { ...f.usage.timing } : { ...DEFAULT_TIMING, duration: 1000, iterations: 'infinite' },
    usage: f.usage ? { selector: f.usage.rule.selector, kind: f.usage.kind } : null,
  }));
  return { file, kind: isHtml(file) ? 'html' : 'css', animations };
}

const normKeyframes = (blocks) =>
  JSON.stringify(blocks.map((b) => ({ offsets: b.offsets, decls: b.decls.map((d) => [d.prop, d.value, !!d.important]) })));

function writeKeyframes(at, blocks) {
  const sampleRule = at.nodes.find((n) => n.type === 'rule');
  const sampleDecl = sampleRule?.nodes.find((n) => n.type === 'decl');
  at.removeAll();
  const sorted = [...blocks].sort((a, b) => Math.min(...a.offsets) - Math.min(...b.offsets));
  for (const b of sorted) {
    const rule = postcss.rule({ selector: [...b.offsets].sort((x, y) => x - y).map(fmtOffset).join(', ') });
    if (sampleRule) rule.raws = { ...sampleRule.raws };
    for (const d of b.decls) {
      if (!d.prop.trim()) continue;
      const decl = postcss.decl({ prop: d.prop.trim(), value: d.value.trim(), important: !!d.important });
      if (sampleDecl) decl.raws = { before: sampleDecl.raws.before, between: sampleDecl.raws.between };
      rule.append(decl);
    }
    at.append(rule);
  }
}

function writeTiming(name, usage, timing) {
  if (usage.kind === 'shorthand') {
    const entries = splitTop(usage.decl.value, ',');
    entries[usage.index] = formatShorthandEntry(name, timing, usage.unit, usage.paused);
    usage.decl.value = entries.join(', ');
    return;
  }
  for (const [key, prop] of Object.entries(LONGHANDS)) {
    if (timing[key] === usage.timing[key]) continue;
    const value = key === 'duration' || key === 'delay' ? fmtTime(timing[key], usage.unit) : timing[key];
    let decl = null;
    usage.rule.each((n) => {
      if (n.type === 'decl' && n.prop.toLowerCase() === prop) decl = n;
    });
    if (!decl) {
      usage.rule.append({ prop, value });
      continue;
    }
    const list = splitTop(decl.value, ',');
    const count = splitTop(usage.decl.value, ',').length;
    const expanded = Array.from({ length: Math.max(count, list.length) }, (_, i) => list[i % list.length]);
    expanded[usage.index] = value;
    decl.value = expanded.join(', ');
  }
}

const timingChanged = (a, b) => Object.keys(DEFAULT_TIMING).some((k) => a[k] !== b[k]);

/** Applies the model to a fresh parse of the file and returns the CSS of every source. */
export function render(file, model) {
  const parsed = parseFile(file);
  for (const anim of model.animations) {
    const f = parsed.found.get(anim.name);
    if (!f) continue;
    if (normKeyframes(anim.keyframes) !== normKeyframes(keyframesOf(f.at))) writeKeyframes(f.at, anim.keyframes);
    if (f.usage && timingChanged(anim.timing, f.usage.timing)) writeTiming(anim.name, f.usage, anim.timing);
  }
  return { ...parsed, css: parsed.roots.map((r) => r.toString()) };
}

/** Writes the model back into the file. Returns true if the file content changed. */
export function save(file, model) {
  const { text, sources, css } = render(file, model);
  let out = text;
  for (let i = sources.length - 1; i >= 0; i--) out = out.slice(0, sources[i].start) + css[i] + out.slice(sources[i].end);
  if (out === text) return false;
  fs.writeFileSync(file, out);
  return true;
}

/** Readable CSS for one animation of the model, used to report state back to the agent. */
export function describe(anim) {
  const blocks = [...anim.keyframes]
    .sort((a, b) => Math.min(...a.offsets) - Math.min(...b.offsets))
    .map((b) => `  ${b.offsets.map(fmtOffset).join(', ')} { ${b.decls.map((d) => `${d.prop}: ${d.value}${d.important ? ' !important' : ''};`).join(' ')} }`)
    .join('\n');
  const usage = anim.usage ? `${anim.usage.selector} { animation: ${formatShorthandEntry(anim.name, anim.timing, 'ms', false)}; }` : '(no rule uses this animation)';
  return `@keyframes ${anim.name} {\n${blocks}\n}\n${usage}`;
}
