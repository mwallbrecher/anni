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
export const kindOf = (file) => (isHtml(file) ? 'html' : 'css');

/** Splits text into CSS chunks: the whole text for css, every <style> block for html. */
export function sourcesOf(text, kind) {
  if (kind !== 'html') return { text, sources: [{ start: 0, end: text.length, css: text }] };
  const sources = [];
  for (const m of text.matchAll(STYLE_RE)) {
    const start = m.index + m[1].length;
    sources.push({ start, end: start + m[2].length, css: m[2] });
  }
  return { text, sources };
}

export function readSources(file) {
  return sourcesOf(fs.readFileSync(file, 'utf8'), kindOf(file));
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
          // Timing this rule doesn't set itself – a shared rule (`.stage * { animation-duration: 4s }`), a
          // utility class, a custom property – stays at the CSS initial value here; the editor reads the real
          // value off the running element and keeps it as the baseline (see `timingBase`).
          const missing = [];
          for (const [key, prop] of Object.entries(LONGHANDS)) {
            const v = longhandValue(rule, prop, index);
            if (v === null || /var\(|env\(/i.test(v)) {
              missing.push(key);
              continue;
            }
            if (key === 'duration' || key === 'delay') {
              const t = parseTime(v);
              if (Number.isNaN(t.ms)) {
                missing.push(key);
                continue;
              }
              timing[key] = t.ms;
              if (key === 'duration') unit = t.unit;
            } else timing[key] = v;
          }
          f.usage = { kind: 'longhand', src, rule, decl, index, timing, unit, missing };
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
      selector: node.selector, // kept so untouched offsets are written back verbatim (from/to stay from/to)
      decls: node.nodes
        .filter((d) => d.type === 'decl')
        .map((d) => ({ prop: d.prop, value: d.value, ...(d.important ? { important: true } : {}) })),
    });
  });
  return blocks;
}

function parseText(text, kind, from) {
  const { sources } = sourcesOf(text, kind);
  const roots = sources.map((s) => postcss.parse(s.css, { from }));
  return { text, sources, roots, found: analyze(roots) };
}

const parseFile = (file) => parseText(fs.readFileSync(file, 'utf8'), kindOf(file), file);

/** JSON model of all animations in a css/html text. `file` is only a label. */
export function modelFromText(text, kind, file = kind === 'html' ? 'page.html' : 'styles.css') {
  const { found } = parseText(text, kind, file);
  const animations = [...found].map(([name, f]) => ({
    name,
    keyframes: keyframesOf(f.at),
    timing: f.usage ? { ...f.usage.timing } : { ...DEFAULT_TIMING, duration: 1000, iterations: 'infinite' },
    usage: f.usage ? { selector: f.usage.rule.selector, kind: f.usage.kind, ...(f.usage.missing?.length ? { missing: f.usage.missing } : {}) } : null,
  }));
  return { file, kind, animations };
}

/** One list line for an animation of a model. A duration the rule doesn't set itself is not reported as 0 ms. */
export function usageLine(a) {
  if (!a.usage) return `- ${a.name} (not used by any rule)`;
  const duration = a.usage.missing?.includes('duration') ? 'duration set outside this rule' : `${a.timing.duration}ms`;
  return `- ${a.name} (used by ${a.usage.selector}, ${duration})`;
}

/** JSON model of all animations in the file. */
export function loadModel(file) {
  return modelFromText(fs.readFileSync(file, 'utf8'), kindOf(file), file);
}

const normKeyframes = (blocks) =>
  JSON.stringify(blocks.map((b) => ({ offsets: b.offsets, decls: b.decls.map((d) => [d.prop, d.value, !!d.important]) })));

function writeKeyframes(at, blocks) {
  const sampleRule = at.nodes.find((n) => n.type === 'rule');
  const sampleDecl = sampleRule?.nodes.find((n) => n.type === 'decl');
  at.removeAll();
  const sorted = [...blocks].sort((a, b) => Math.min(...a.offsets) - Math.min(...b.offsets));
  for (const b of sorted) {
    const offsets = [...b.offsets].sort((x, y) => x - y);
    const sameAsSource = b.selector && JSON.stringify(b.selector.split(',').map(parseOffset).sort((x, y) => x - y)) === JSON.stringify(offsets);
    const rule = postcss.rule({ selector: sameAsSource ? b.selector : offsets.map(fmtOffset).join(', ') });
    if (sampleRule) rule.raws = { ...sampleRule.raws };
    else rule.raws = { before: '\n  ', after: '\n  ' }; // fresh @keyframes: postcss would otherwise copy the blank line between top-level rules
    for (const d of b.decls) {
      if (!d.prop.trim()) continue;
      const decl = postcss.decl({ prop: d.prop.trim(), value: d.value.trim(), important: !!d.important });
      if (sampleDecl) decl.raws = { before: sampleDecl.raws.before, between: sampleDecl.raws.between };
      rule.append(decl);
    }
    at.append(rule);
  }
}

/** Writes the timing keys that differ from `base` (what the file – or, for inherited values, the page – had). */
function writeTiming(name, usage, timing, base = usage.timing) {
  if (usage.kind === 'shorthand') {
    const entries = splitTop(usage.decl.value, ',');
    entries[usage.index] = formatShorthandEntry(name, timing, usage.unit, usage.paused);
    usage.decl.value = entries.join(', ');
    return;
  }
  for (const [key, prop] of Object.entries(LONGHANDS)) {
    if (timing[key] === base[key]) continue;
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

const findDecl = (rule, prop) => {
  let found = null;
  rule.each((n) => {
    if (n.type === 'decl' && n.prop.toLowerCase() === prop) found = n;
  });
  return found;
};

/**
 * Adds an `animation` entry for `name` to the rule with exactly this selector (a new rule at the end
 * if there is none). An existing rule gets the entry appended to its shorthand / longhands so
 * animations already on it keep working.
 */
function attachAnimation(parsed, selector, name, t) {
  let rule = null;
  for (const r of parsed.roots) {
    r.each((n) => {
      if (n.type === 'rule' && n.selector === selector) rule = n;
    });
  }
  const shorthand = rule && findDecl(rule, 'animation');
  const nameDecl = rule && findDecl(rule, 'animation-name');
  if (shorthand) shorthand.value = `${shorthand.value}, ${formatShorthandEntry(name, t, 'ms', false)}`;
  else if (nameDecl) {
    // Longhand lists must stay aligned: pad missing longhands with their defaults for the existing entries.
    const count = splitTop(nameDecl.value, ',').length;
    const values = { name, duration: fmtTime(t.duration, 'ms'), delay: fmtTime(t.delay, 'ms'), easing: t.easing, iterations: t.iterations, direction: t.direction, fill: t.fill };
    const defaults = { duration: '0s', delay: '0s', easing: 'ease', iterations: '1', direction: 'normal', fill: 'none' };
    for (const [key, prop] of Object.entries({ name: 'animation-name', ...LONGHANDS })) {
      const decl = findDecl(rule, prop);
      if (decl) decl.value = `${decl.value}, ${values[key]}`;
      else if (key === 'name' || values[key] !== defaults[key]) rule.append({ prop, value: [...Array(count).fill(defaults[key]), values[key]].join(', ') });
    }
  } else {
    rule = postcss.rule({ selector });
    rule.raws.before = '\n\n';
    rule.append({ prop: 'animation', value: formatShorthandEntry(name, t, 'ms', false) });
    parsed.roots[parsed.roots.length - 1].append(rule);
  }
}

/** Adds a brand-new animation (created in the editor for a picked element): the @keyframes block plus its `animation` entry. */
function createAnimation(parsed, anim) {
  const root = parsed.roots[parsed.roots.length - 1];
  if (!root) return;
  attachAnimation(parsed, anim.usage.selector, anim.name, anim.timing);
  const at = postcss.atRule({ name: 'keyframes', params: anim.name, nodes: [] });
  at.raws.before = '\n\n';
  root.append(at);
  writeKeyframes(at, anim.keyframes);
}

/** Applies the model to a fresh parse of the text and returns the CSS of every source. */
export function renderText(text, kind, model, from = model.file) {
  const parsed = parseText(text, kind, from);
  for (const anim of model.animations) {
    const f = parsed.found.get(anim.name);
    // `applied` (set by the editor): further selectors that should run this existing animation too.
    if (parsed.roots.length) for (const selector of anim.applied || []) attachAnimation(parsed, selector, anim.name, anim.timing);
    if (!f) {
      if (anim.usage?.create) createAnimation(parsed, anim);
      continue;
    }
    if (normKeyframes(anim.keyframes) !== normKeyframes(keyframesOf(f.at))) writeKeyframes(f.at, anim.keyframes);
    // `timingBase` (set by the editor) holds the values the page really used, including ones inherited from
    // other rules; only changes against it are written, so resolving them never adds declarations by itself.
    const base = anim.timingBase || f.usage?.timing;
    if (f.usage && timingChanged(anim.timing, base)) writeTiming(anim.name, f.usage, anim.timing, base);
  }
  return { ...parsed, css: parsed.roots.map((r) => r.toString()) };
}

export function render(file, model) {
  return renderText(fs.readFileSync(file, 'utf8'), kindOf(file), model, file);
}

/** The full text with the model applied – everything outside the edited parts stays byte-identical. */
export function applyModel(text, kind, model, from) {
  const { sources, css } = renderText(text, kind, model, from);
  let out = text;
  for (let i = sources.length - 1; i >= 0; i--) out = out.slice(0, sources[i].start) + css[i] + out.slice(sources[i].end);
  return out;
}

/** Writes the model back into the file. Returns true if the file content changed. */
export function save(file, model) {
  const text = fs.readFileSync(file, 'utf8');
  const out = applyModel(text, kindOf(file), model, file);
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
  const entry = formatShorthandEntry(anim.name, anim.timing, 'ms', false);
  const usage = anim.usage ? `${anim.usage.selector} { animation: ${entry}; }` : '(no rule uses this animation)';
  const applied = (anim.applied || []).map((s) => `\n${s} { animation: ${entry}; } (applied in the editor)`).join('');
  return `@keyframes ${anim.name} {\n${blocks}\n}\n${usage}${applied}`;
}
