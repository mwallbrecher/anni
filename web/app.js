// anni editor: loads the open session from the local server, shows the preview in an
// iframe (same origin), and drives the selected CSS animation with a paused Web Animation.

import { FNS, KNOWN, LENGTH, defaultOf, fmtColor, fmtFns, fmtNum, fmtTokens, parseFns, parseNum, parseTokens, rangeFor, specOf, toHex, toRgba } from './props.js';

const $ = (sel) => document.querySelector(sel);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const S = {
  session: null,
  model: null,
  name: null,
  sel: null, // { bi, oi } -> keyframe block index, index into its offsets
  t: 0, // ms within one iteration
  playing: false,
  speed: 1,
  loop: true,
  mode: 'page',
  css: null,
  saved: '',
  dirty: false,
  history: [],
  future: [],
  pendingCommit: false,
  picking: false, // pick mode: hovering/clicking elements in the page preview
  hoverEl: null,
  el: null, // picked element: { selector, candidates, tag, names }
  view: { span: null, start: 0 }, // visible window of the timeline (ms); span null = whole scene
  zoom: { z: 1, x: 0, y: 0 }, // visual zoom of the preview: scale + translation in px
};

const NEW_TIMING = { duration: 1000, delay: 0, easing: 'ease', iterations: '1', direction: 'normal', fill: 'both' };
const FRAME = 1000 / 60;

const EASINGS = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'cubic-bezier(0.34, 1.56, 0.64, 1)', 'cubic-bezier(0.65, 0, 0.35, 1)', 'steps(4, end)'];
const BEZIER = { linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1] };

const frame = $('#frame');
const anim = () => S.model.animations.find((a) => a.name === S.name);
const dur = () => Math.max(1, anim().timing.duration);
const fmtPct = (p) => `${+p.toFixed(2)}%`;
const fmtMs = (ms) => (ms >= 1000 ? `${+(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const snapshot = () => JSON.stringify(S.model.animations);

// Hosted sessions may live under /s/<id>/ on a shared origin; locally and on session subdomains BASE is ''.
const BASE = location.pathname.match(/^\/s\/[^/]+/)?.[0] || '';

async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 1800);
}

function banner(content) {
  const el = $('#banner');
  el.replaceChildren(...(content ? [content].flat() : []));
  el.hidden = !content;
}

/* ---------- loading ---------- */

async function load({ keepTime = false } = {}) {
  const data = await api('GET', '/api/session');
  S.session = data.session;
  const has = !!S.session;
  $('#empty').hidden = has;
  for (const id of ['#workspace', '#timeline']) $(id).hidden = !has;
  for (const id of ['#save', '#undo', '#redo', '#anim-select']) $(id).hidden = !has;
  if (!has) {
    $('#file').textContent = '';
    $('#dirty').hidden = true;
    if (data.hosted) renderConnectCard(data.mcpUrl);
    return;
  }
  if (S.session.kind === 'schema') return loadSchema(data);
  S.schema = null;
  $('#timeline').hidden = false;
  $('#anim-select').hidden = false;
  $('#mode').hidden = false;
  S.model = data.model;
  S.name = S.model.animations.some((a) => a.name === S.session.animation) ? S.session.animation : S.model.animations[0].name;
  S.saved = S.session.dirty ? '' : snapshot();
  S.dirty = S.session.dirty;
  S.sel = null;
  S.el = null;
  S.picking = false;
  S.history = [];
  S.future = [];
  if (!keepTime) S.t = 0;
  S.mode = S.session.previewUrl ? 'page' : 'demo';
  $('#file').textContent = S.session.file;
  $('#file').title = S.session.file;
  banner(null);
  renderAll();
  loadPreview();
  push();
}

/** Root of a hosted anni: nothing to edit here, show how an agent connects. */
function renderConnectCard(mcpUrl) {
  const cmd = `claude mcp add --transport http anni ${mcpUrl}`;
  const codex = `[mcp_servers.anni]\nurl = "${mcpUrl}"`;
  $('.empty-card').replaceChildren(
    h('span', { class: 'logo big' }),
    h('h1', {}, 'Connect your agent to anni'),
    h('p', {}, 'anni is a timeline editor for the CSS animations in your project. Your agent opens one here, you tune it, and the agent writes it back to your files.'),
    h('p', { class: 'cmd' }, h('span', { class: 'muted' }, 'Claude Code'), h('code', {}, cmd), h('button', { onclick: () => navigator.clipboard.writeText(cmd).then(() => toast('Copied')) }, 'Copy')),
    h('p', { class: 'cmd' }, h('span', { class: 'muted' }, 'Codex · ~/.codex/config.toml'), h('code', { class: 'block' }, codex), h('button', { onclick: () => navigator.clipboard.writeText(codex).then(() => toast('Copied')) }, 'Copy')),
    h('p', { class: 'muted' }, 'Then say: “open the bounce animation from styles.css in anni”. Any MCP client that speaks Streamable HTTP works.'),
  );
}

/* ---------- schema sessions: controls the agent described, with live preview wires ---------- */

function loadSchema(data) {
  S.model = null;
  S.schema = data.schema;
  S.values = { ...data.values };
  S.dirty = S.session.dirty;
  S.savedValues = S.dirty ? null : { ...S.values };
  S.vhistory = [];
  S.vfuture = [];
  S.sel = null;
  S.el = null;
  S.picking = false;
  S.mode = 'page';
  $('#timeline').hidden = true;
  $('#anim-select').hidden = true;
  $('#mode').hidden = true;
  $('#pick').hidden = true;
  $('#file').textContent = S.session.title;
  $('#file').title = S.session.title;
  banner(null);
  renderSchemaHeader();
  renderSchemaPanel();
  S.css = null;
  if (S.session.previewUrl) {
    frame.removeAttribute('srcdoc'); // an srcdoc attribute, even empty, wins over src
    frame.src = S.session.previewUrl;
    $('#stage-info').textContent = '';
  } else {
    frame.removeAttribute('src');
    frame.srcdoc = '<!doctype html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#151515;color:#8d8d8d;font:12px system-ui">No preview page – values apply on save</body>';
    $('#stage-info').textContent = 'Controls only';
  }
}

function renderSchemaHeader() {
  $('#dirty').hidden = !S.dirty;
  $('#undo').disabled = !S.vhistory.length;
  $('#redo').disabled = !S.vfuture.length;
  document.title = `${S.dirty ? '● ' : ''}${S.session.title} · anni`;
}

const controlsOf = () => S.schema.groups.flatMap((g) => g.controls);

/** Injects the preview wires as one <style> (css / var) and sets text wires in the preview document. */
function applySchemaPreview() {
  const doc = frame.contentDocument;
  if (!S.schema || !doc?.head) return;
  const rules = [];
  for (const c of controlsOf()) {
    const v = S.values[c.id];
    const p = c.preview || {};
    if (p.css) rules.push(`${p.css.selector} { ${p.css.prop}: ${v}${p.css.important ? ' !important' : ''}; }`);
    if (p.var) rules.push(`${p.var.scope || ':root'} { ${p.var.name}: ${v}; }`);
    if (p.text) for (const el of doc.querySelectorAll(p.text.selector)) if (el.textContent !== v) el.textContent = v;
  }
  let style = doc.getElementById('anni-schema');
  if (!style) {
    style = doc.createElement('style');
    style.id = 'anni-schema';
    doc.head.append(style);
  }
  const css = rules.join('\n');
  if (style.textContent !== css) style.textContent = css;
}

let valuesTimer;
function setValue(id, value) {
  if (S.pendingCommit !== false) {
    if (S.pendingCommit === true) commitValues();
    S.pendingCommit = 'done';
  } else commitValues();
  S.values[id] = value;
  afterValueChange();
}
function commitValues() {
  S.vhistory.push({ ...S.values });
  if (S.vhistory.length > 200) S.vhistory.shift();
  S.vfuture = [];
}
function afterValueChange() {
  S.dirty = !S.savedValues || JSON.stringify(S.values) !== JSON.stringify(S.savedValues);
  applySchemaPreview();
  renderSchemaHeader();
  for (const row of document.querySelectorAll('#inspector .prop[data-id]')) row.classList.toggle('changed', !S.savedValues || S.values[row.dataset.id] !== S.savedValues[row.dataset.id]);
  clearTimeout(valuesTimer);
  valuesTimer = setTimeout(() => api('POST', '/api/render', { values: S.values, dirty: S.dirty }).catch(() => {}), 300);
}
function undoValues() {
  if (!S.vhistory.length) return;
  S.vfuture.push({ ...S.values });
  S.values = S.vhistory.pop();
  afterValueChange();
  renderSchemaPanel();
}
function redoValues() {
  if (!S.vfuture.length) return;
  S.vhistory.push({ ...S.values });
  S.values = S.vfuture.pop();
  afterValueChange();
  renderSchemaPanel();
}

async function saveSchema() {
  try {
    const r = await api('POST', '/api/save', { values: S.values });
    S.savedValues = { ...S.values };
    S.dirty = false;
    renderSchemaHeader();
    renderSchemaPanel();
    toast(r.changed ? `Saved ${r.changes.length} change${r.changes.length === 1 ? '' : 's'} – your agent can pull them now` : 'No changes');
  } catch (e) {
    toast(`Error: ${e.message}`);
  }
}

/** Editor for one control; `set` receives the new value as a string. */
function controlEditor(c, value, set) {
  const raw = () => h('input', { class: 'raw', value, spellcheck: 'false', oninput: (e) => set(e.target.value) });
  if (c.type === 'boolean') return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: value === 'true' || undefined, onchange: (e) => set(e.target.checked ? 'true' : 'false') }), value === 'true' ? 'on' : 'off');
  if (c.type === 'enum') {
    const opts = (c.options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
    return h('select', { onchange: (e) => set(e.target.value) }, opts.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label || o.value)));
  }
  if (c.type === 'color') return colorEditor(value, set) || raw();
  if (c.type === 'text') return raw();
  const tok = parseNum(value);
  if (tok.raw !== undefined) return raw();
  const range = c.min !== undefined && c.max !== undefined ? [c.min, c.max, c.step ?? (c.max - c.min > 20 ? 1 : 0.01)] : undefined;
  const units = c.type === 'length' ? c.units || LENGTH : c.unit ? [c.unit] : null;
  if (units && !units.includes(tok.unit)) tok.unit = tok.unit || units[0];
  const f = numField(tok, units, range, true, () => set(fmtNum(tok)));
  return h('div', { class: 'editor' }, f.slider, f.num);
}

function renderSchemaPanel() {
  const sections = S.schema.groups.map((g) =>
    h(
      'div',
      { class: 'section props' },
      g.label ? h('h2', {}, g.label) : null,
      h(
        'div',
        { class: 'rows' },
        g.controls.map((c) => {
          const value = S.values[c.id];
          const changed = !S.savedValues || value !== S.savedValues[c.id];
          const wire = c.source ? `→ ${c.source.file}` : c.preview ? '' : 'applies on save';
          return h(
            'div',
            { class: `prop${changed ? ' changed' : ''}${c.type === 'text' ? ' wide' : ''}`, 'data-id': c.id },
            h('span', { class: 'name', title: c.id }, c.label || c.id),
            controlEditor(c, value, (v) => setValue(c.id, v)),
            h('span', { class: 'key dot', title: changed ? 'Changed since the last save' : 'Unchanged' }),
            wire ? h('span', { class: 'wire' }, wire) : null,
          );
        }),
      ),
    ),
  );
  $('#inspector').replaceChildren(...sections);
}

function loadPreview() {
  S.css = null;
  frame.removeAttribute('srcdoc');
  frame.src = S.mode === 'page' ? S.session.previewUrl : `${S.session.demoUrl}?v=${Date.now()}`;
  renderStageBar();
}

frame.addEventListener('load', () => {
  push();
  setTimeout(checkPreview, 600);
});

function checkPreview() {
  if (!S.session || S.schema) return;
  renderTimeline(); // the page's animated elements are known now
  if (S.mode !== 'page') return;
  const found = previewAnimations().length;
  $('#stage-info').textContent = found ? `${found} element${found > 1 ? 's' : ''} running “${S.name}”` : '';
  if (!found) {
    banner([
      h('span', {}, `No element on the page is running “${S.name}” right now (maybe only on :hover or via script).`),
      h('button', { onclick: () => setMode('demo') }, 'Show demo box'),
    ]);
  }
}

function setMode(mode) {
  if (mode === S.mode) return;
  S.mode = mode;
  S.picking = false;
  banner(null);
  loadPreview();
}

/** Switches the edited animation (header dropdown, element section, timeline groups). The scene clock stays put. */
function setAnimation(name) {
  S.name = name;
  S.sel = null;
  api('POST', '/api/select', { animation: name });
  renderAll();
  push();
  if (S.mode === 'page') setTimeout(checkPreview, 300);
}

/* ---------- live preview ---------- */

let pushSeq = 0;
let pushTimer;
function push() {
  if (S.schema) return applySchemaPreview();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    const seq = ++pushSeq;
    const { css } = await api('POST', '/api/render', { model: S.model, dirty: S.dirty });
    if (seq !== pushSeq) return;
    S.css = css;
    applyCss();
  }, 30);
}

function shorthand(a) {
  const t = a.timing;
  return `${a.name} ${t.duration}ms ${t.easing} ${t.delay}ms ${t.iterations} ${t.direction} ${t.fill}`;
}

function applyCss() {
  const doc = frame.contentDocument;
  if (!doc || !doc.head || !S.css) return;
  if (S.session.kind === 'css' && S.mode === 'page' && !doc.querySelector('style[data-anni-src]')) {
    // Swap the linked stylesheet for an inline <style> we can rewrite on every edit.
    const target = new URL(S.session.cssUrl, location.href).pathname;
    const link = [...doc.querySelectorAll('link[rel~="stylesheet"]')].find((l) => new URL(l.href, doc.baseURI).pathname === target);
    const style = doc.createElement('style');
    style.dataset.anniSrc = '0';
    if (link) link.replaceWith(style);
    else doc.head.append(style);
  }
  S.css.forEach((css, i) => {
    const el = doc.querySelector(`style[data-anni-src="${i}"]`);
    if (el && el.textContent !== css) el.textContent = css;
  });
  const box = doc.getElementById('anni-demo');
  if (box) box.style.animation = shorthand(anim());
  refreshGroups();
}

function previewAnimations() {
  const doc = frame.contentDocument;
  if (!doc || !doc.getAnimations) return [];
  return doc.getAnimations().filter((x) => x.animationName === S.name);
}

/** The playhead is the page's clock: every CSS animation is paused and set to the same time. */
function syncPreview() {
  if (!S.model) return;
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc?.getAnimations || !win?.CSSAnimation) return;
  for (const x of doc.getAnimations()) {
    if (!(x instanceof win.CSSAnimation)) continue;
    if (x.playState !== 'paused') x.pause();
    if (x.currentTime !== S.t) x.currentTime = S.t;
  }
}

/* ---------- editing ---------- */

function commit() {
  S.history.push({ snap: snapshot(), sel: S.sel });
  if (S.history.length > 200) S.history.shift();
  S.future = [];
}

/** Applies an edit. `render` controls what gets redrawn (inputs re-render less to keep focus). */
function change(fn, { render = 'all' } = {}) {
  if (S.pendingCommit !== false) {
    if (S.pendingCommit === true) commit();
    S.pendingCommit = 'done';
  } else commit();
  fn();
  afterChange(render);
}

function afterChange(render = 'all') {
  S.dirty = snapshot() !== S.saved;
  if (render === 'all') renderAll();
  else {
    renderTimeline();
    renderHeader();
  }
  push();
}

function restore(entry, from, to) {
  if (!entry) return;
  to.push({ snap: snapshot(), sel: S.sel });
  S.model.animations = JSON.parse(entry.snap);
  S.sel = entry.sel;
  if (!anim()) S.name = S.model.animations[0].name; // undo of a freshly created animation
  if (S.sel && anim().keyframes[S.sel.bi]?.offsets[S.sel.oi] === undefined) S.sel = null;
  afterChange();
}
const undo = () => restore(S.history.pop(), S.history, S.future);
const redo = () => restore(S.future.pop(), S.future, S.history);

// Typing in an input should create one undo step per focus, not per keystroke.
document.addEventListener('focusin', (e) => {
  if (e.target.matches('.inspector input, .inspector select')) S.pendingCommit = true;
});
document.addEventListener('focusout', () => (S.pendingCommit = false));

function propsOf(a) {
  const props = [];
  for (const b of a.keyframes) for (const d of b.decls) if (d.prop.trim() && !props.includes(d.prop)) props.push(d.prop);
  return props;
}

/** Value of `prop` at the closest keyframe at or before p (or the first after it). */
function valueNear(a, prop, p) {
  const pts = [];
  for (const b of a.keyframes) {
    const d = b.decls.find((x) => x.prop === prop);
    if (d) for (const o of b.offsets) pts.push({ o, v: d.value });
  }
  pts.sort((x, y) => x.o - y.o);
  const before = pts.filter((x) => x.o <= p).pop();
  return (before || pts[0])?.v ?? '';
}

/** Selects a keyframe; seeks the playhead to it (page time of the edited animation, or `at` ms). */
function select(bi, oi, { seek = true, at } = {}) {
  S.sel = bi === null ? null : { bi, oi };
  if (S.sel && seek) S.t = at ?? delayOf() + (anim().keyframes[bi].offsets[oi] / 100) * dur();
  renderTimeline();
  renderInspector();
}

function addKeyframe(p, prop, g) {
  const a = anim();
  p = Math.round(p * 10) / 10;
  const at = g ? g.delay + (p / 100) * g.duration : undefined;
  const bi = a.keyframes.findIndex((b) => b.offsets.some((o) => Math.abs(o - p) < 0.05));
  if (bi >= 0) {
    const block = a.keyframes[bi];
    if (prop && !block.decls.some((d) => d.prop === prop)) change(() => block.decls.push({ prop, value: valueNear(a, prop, p) }));
    return select(bi, block.offsets.findIndex((o) => Math.abs(o - p) < 0.05), { at });
  }
  const props = prop ? [prop] : propsOf(a);
  change(() => a.keyframes.push({ offsets: [p], decls: props.map((pr) => ({ prop: pr, value: valueNear(a, pr, p) })) }));
  select(a.keyframes.length - 1, 0, { at });
}

/* ---------- values at the playhead / auto-key ---------- */

const delayOf = () => anim().timing.delay;
/** Playhead as offset into the edited animation (0.1 % resolution); clamped, see playheadInRange. */
const rawPct = () => Math.round(((S.t - delayOf()) / dur()) * 1000) / 10;
const playheadPct = () => clamp(rawPct(), 0, 100);
const playheadInRange = () => rawPct() >= -0.05 && rawPct() <= 100.05;

/** Keyframe block sitting at the playhead, if any. */
function blockAtPlayhead() {
  const p = playheadPct();
  const a = anim();
  const bi = a.keyframes.findIndex((b) => b.offsets.some((o) => Math.abs(o - p) < 0.05));
  if (bi < 0) return null;
  const block = a.keyframes[bi];
  return { bi, oi: block.offsets.findIndex((o) => Math.abs(o - p) < 0.05), block };
}

/** Element whose computed style stands in for values that aren't keyed at the playhead. */
function targetEl() {
  const doc = frame.contentDocument;
  if (!doc) return null;
  if (S.mode === 'demo') return doc.getElementById('anni-demo');
  const x = previewAnimations()[0];
  if (x?.effect?.target) return x.effect.target;
  try {
    return S.el ? doc.querySelector(S.el.selector) : null;
  } catch {
    return null;
  }
}

const COMPUTED_NONE = { scale: '1', rotate: '0deg', translate: '0px 0px' };
const isAnimated = (a, prop) => a.keyframes.some((b) => b.decls.some((d) => d.prop === prop));

/**
 * Value shown for `prop` at the playhead: the keyed value if there is a keyframe here, else what the
 * (paused) preview element computes right now – i.e. the interpolated or base value – else a default.
 */
function valueAt(prop, at = blockAtPlayhead()) {
  const keyed = at?.block.decls.find((d) => d.prop === prop);
  if (keyed) return keyed.value;
  const a = anim();
  const animated = isAnimated(a, prop);
  if (prop === 'transform' && animated) return valueNear(a, prop, playheadPct()); // computed would be a matrix()
  const el = targetEl();
  const v = el ? getComputedStyle(el).getPropertyValue(prop).trim() : '';
  if (!v) return animated ? valueNear(a, prop, playheadPct()) : defaultOf(prop);
  if (v === 'none' && COMPUTED_NONE[prop]) return COMPUTED_NONE[prop];
  if (specOf(prop).kind === 'color') {
    const c = toRgba(v);
    if (c) return fmtColor(c);
  }
  return v;
}

/** Writes `value` for `prop` at the playhead: into the keyframe there, or into a new one (auto-key). */
function keyAt(prop, value) {
  const a = anim();
  let at = blockAtPlayhead();
  change(
    () => {
      if (!at) {
        const block = { offsets: [playheadPct()], decls: [] };
        a.keyframes.push(block);
        at = { bi: a.keyframes.length - 1, oi: 0, block };
      }
      const d = at.block.decls.find((x) => x.prop === prop);
      if (d) d.value = value;
      else at.block.decls.push({ prop, value });
    },
    { render: 'light' },
  );
  if (S.sel?.bi !== at.bi || S.sel?.oi !== at.oi) {
    S.sel = { bi: at.bi, oi: at.oi };
    renderTimeline();
  }
  $('#kf-section')?.replaceWith(renderKeyframeSection(a));
}

/** Removes `prop` from the keyframe at the playhead (and the keyframe itself once it is empty). */
function unkey(prop) {
  const at = blockAtPlayhead();
  if (!at) return;
  change(() => {
    at.block.decls = at.block.decls.filter((d) => d.prop !== prop);
    if (!at.block.decls.length) {
      anim().keyframes.splice(at.bi, 1);
      S.sel = null;
    }
  });
}

/** New @keyframes for the picked element; written to the file on save (see createAnimation in css.js). */
function createAnimation(name, selector) {
  if (!/^-?[a-zA-Z_][\w-]*$/.test(name)) return toast('Invalid animation name');
  if (!selector) return toast('Selector missing');
  if (S.model.animations.some((a) => a.name === name)) return toast(`“${name}” already exists`);
  change(() =>
    S.model.animations.push({
      name,
      keyframes: [
        { offsets: [0], decls: [] },
        { offsets: [100], decls: [] },
      ],
      timing: { ...NEW_TIMING },
      usage: { selector, kind: 'shorthand', create: true },
    }),
  );
  if (S.el) S.el.names = [...S.el.names, name];
  setAnimation(name);
  toast(`@keyframes ${name} created – change a value to key it`);
}

function deleteSelected() {
  if (!S.sel) return;
  const a = anim();
  const { bi, oi } = S.sel;
  change(() => {
    const block = a.keyframes[bi];
    if (block.offsets.length > 1) block.offsets.splice(oi, 1);
    else a.keyframes.splice(bi, 1);
    S.sel = null; // before the re-render, which would otherwise look up the removed block
  });
}

function splitSelected() {
  const a = anim();
  const { bi, oi } = S.sel;
  change(() => {
    const block = a.keyframes[bi];
    const [o] = block.offsets.splice(oi, 1);
    a.keyframes.push({ offsets: [o], decls: block.decls.map((d) => ({ ...d })) });
  });
  select(a.keyframes.length - 1, 0);
}

async function saveNow() {
  if (!S.session) return;
  if (S.schema) return saveSchema();
  const selOffset = S.sel ? anim().keyframes[S.sel.bi].offsets[S.sel.oi] : null;
  try {
    const r = await api('POST', '/api/save', { model: S.model });
    S.model = r.model;
    S.saved = snapshot();
    S.dirty = false;
    S.sel = null;
    if (selOffset !== null) {
      const bi = anim().keyframes.findIndex((b) => b.offsets.includes(selOffset));
      if (bi >= 0) S.sel = { bi, oi: anim().keyframes[bi].offsets.indexOf(selOffset) };
    }
    renderAll();
    push();
    toast(r.changed ? (S.session.hosted ? 'Saved – your agent can pull it now' : 'Saved to file') : 'No changes');
  } catch (e) {
    toast(`Error: ${e.message}`);
  }
}

/* ---------- rendering ---------- */

function renderAll() {
  renderHeader();
  renderStageBar();
  renderInspector();
  renderTimeline();
}

function renderHeader() {
  const sel = $('#anim-select');
  sel.replaceChildren(...S.model.animations.map((a) => h('option', { value: a.name, selected: a.name === S.name }, `@keyframes ${a.name}`)));
  $('#dirty').hidden = !S.dirty;
  $('#undo').disabled = !S.history.length;
  $('#redo').disabled = !S.future.length;
  document.title = `${S.dirty ? '● ' : ''}${S.name} · anni`;
}

function renderStageBar() {
  if (!S.session) return;
  for (const b of $('#mode').children) {
    b.classList.toggle('on', b.dataset.mode === S.mode);
    b.disabled = b.dataset.mode === 'page' && !S.session.previewUrl;
  }
  const pick = $('#pick');
  pick.hidden = S.mode !== 'page';
  pick.classList.toggle('on', S.picking);
  $('#stage-info').textContent = S.mode === 'demo' ? 'Animation on a test box' : S.picking ? 'Click an element on the page · Esc cancels' : '';
}

/* ---------- element picking (page preview) ---------- */

const OVERLAY_CSS = `
#anni-ov, #anni-ov * { pointer-events: none !important; }
#anni-ov { position: fixed; inset: 0; z-index: 2147483647; }
#anni-ov .box { position: absolute; box-sizing: border-box; border: calc(1px / var(--anni-z, 1)) dashed #3d9bff; }
#anni-ov .box.sel { border-style: solid; box-shadow: 0 0 0 calc(1px / var(--anni-z, 1)) rgba(61, 155, 255, 0.3); }
#anni-ov .box.hover { border-style: solid; background: rgba(61, 155, 255, 0.1); }
#anni-ov .tag { position: absolute; left: 0; bottom: 100%; margin-bottom: 2px; padding: 1px 5px; border-radius: 2px;
  background: #3d9bff; color: #fff; font: 500 10px/1.5 Inter, system-ui, sans-serif; white-space: nowrap;
  transform: scale(calc(1 / var(--anni-z, 1))); transform-origin: 0 100%; }
html.anni-pick, html.anni-pick * { cursor: crosshair !important; }`;

/** Overlay layer inside the preview document, installed once per page load. */
function overlay() {
  const doc = frame.contentDocument;
  if (!doc?.body || !doc.head) return null;
  let ov = doc.getElementById('anni-ov');
  if (!ov) {
    const style = doc.createElement('style');
    style.textContent = OVERLAY_CSS;
    doc.head.append(style);
    ov = doc.createElement('div');
    ov.id = 'anni-ov';
    doc.body.append(ov);
    doc.addEventListener('mousemove', (e) => S.picking && (S.hoverEl = pickTarget(e)), true);
    doc.addEventListener('mouseleave', () => (S.hoverEl = null));
    doc.addEventListener(
      'click',
      (e) => {
        if (!S.picking) return;
        e.preventDefault();
        e.stopPropagation();
        const el = pickTarget(e);
        if (el) selectElement(el);
        setPicking(false);
      },
      true,
    );
    doc.addEventListener('keydown', (e) => e.key === 'Escape' && setPicking(false));
    doc.addEventListener('wheel', onPreviewWheel, { passive: false, capture: true });
    doc.documentElement.classList.toggle('anni-pick', S.picking);
    drawOverlay.key = '';
  }
  return ov;
}

/* ---------- preview zoom (visual, like zooming the composition view) ---------- */

function applyZoom() {
  const { z, x, y } = S.zoom;
  frame.style.transformOrigin = '0 0';
  frame.style.transform = z === 1 && !x && !y ? '' : `translate(${x}px, ${y}px) scale(${z})`;
  frame.contentDocument?.documentElement.style.setProperty('--anni-z', z); // overlay outlines stay 1px on screen
  const btn = $('#zoom');
  btn.hidden = z === 1;
  btn.textContent = `${Math.round(z * 100)}%`;
}
function resetZoom() {
  S.zoom = { z: 1, x: 0, y: 0 };
  applyZoom();
}
/** Pinch / ⌘-or-Ctrl + wheel zooms around the cursor; once zoomed, a plain wheel pans instead of scrolling the page. */
function onPreviewWheel(e) {
  const { z, x, y } = S.zoom;
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const nz = clamp(z * Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.002)), 0.25, 8);
    // Cursor in frame-wrap pixels: iframe point p maps to x + p * z.
    const cx = x + e.clientX * z;
    const cy = y + e.clientY * z;
    S.zoom = Math.abs(nz - 1) < 0.02 ? { z: 1, x: 0, y: 0 } : { z: nz, x: cx - (cx - x) * (nz / z), y: cy - (cy - y) * (nz / z) };
    applyZoom();
  } else if (z !== 1) {
    e.preventDefault();
    S.zoom = { z, x: x - e.deltaX, y: y - e.deltaY };
    applyZoom();
  }
}
$('#zoom').onclick = resetZoom;

function pickTarget(e) {
  const doc = frame.contentDocument;
  const el = doc.elementFromPoint(e.clientX, e.clientY);
  return !el || el === doc.documentElement || el === doc.body || el.closest('#anni-ov') ? null : el;
}

function setPicking(on) {
  if (on && S.mode !== 'page') return;
  S.picking = on;
  S.hoverEl = null;
  frame.contentDocument?.documentElement.classList.toggle('anni-pick', on);
  if (on) frame.contentWindow?.focus();
  renderStageBar();
}

const describeEl = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].filter((c) => !c.startsWith('anni-')).map((c) => `.${c}`).join('')}`;

/** Short, readable path to the element: stops at the nearest id, adds :nth-child only where siblings are alike. */
function uniquePath(el) {
  const doc = el.ownerDocument;
  const parts = [];
  for (let n = el; n && n !== doc.body && n !== doc.documentElement; n = n.parentElement) {
    if (n.id) {
      parts.unshift(`#${CSS.escape(n.id)}`);
      break;
    }
    let part = n.tagName.toLowerCase() + [...n.classList].filter((c) => !c.startsWith('anni-')).map((c) => `.${CSS.escape(c)}`).join('');
    const parent = n.parentElement;
    if (parent && parent.querySelectorAll(`:scope > ${part}`).length > 1) part += `:nth-child(${[...parent.children].indexOf(n) + 1})`;
    parts.unshift(part);
  }
  return parts.join(' > ');
}

/** Selectors the user can pick from: id, each class, class combo, path. Classes first – in CSS you usually animate the class. */
function selectorCandidates(el) {
  const out = [];
  const add = (s) => s && !out.includes(s) && out.push(s);
  if (el.id) add(`#${CSS.escape(el.id)}`);
  const classes = [...el.classList].filter((c) => !c.startsWith('anni-'));
  for (const c of classes) add(`.${CSS.escape(c)}`);
  if (classes.length > 1) add(classes.map((c) => `.${CSS.escape(c)}`).join(''));
  add(uniquePath(el));
  return out;
}

function elInfo(el) {
  const names = getComputedStyle(el)
    .animationName.split(',')
    .map((s) => s.trim())
    .filter((n) => n && n !== 'none');
  const candidates = selectorCandidates(el);
  return { selector: candidates[0], candidates, tag: describeEl(el), names };
}

function selectElement(el) {
  S.el = elInfo(el);
  const own = S.el.names.find((n) => S.model.animations.some((a) => a.name === n));
  if (own && own !== S.name) setAnimation(own);
  else renderInspector();
}

/** Draws selection/hover boxes in the preview. Called every frame; only touches the DOM when something moved. */
function drawOverlay() {
  if (!S.session || S.mode !== 'page') return;
  const ov = overlay();
  if (!ov) return;
  const doc = frame.contentDocument;
  const items = [];
  if (S.el) {
    let els = [];
    try {
      els = [...doc.querySelectorAll(S.el.selector)].slice(0, 30);
    } catch {}
    els.forEach((el, i) => items.push({ el, cls: 'sel', label: i === 0 ? S.el.selector : '' }));
  } else {
    for (const x of previewAnimations().slice(0, 30)) if (x.effect?.target) items.push({ el: x.effect.target, cls: '', label: '' });
  }
  if (S.picking && S.hoverEl?.isConnected) items.push({ el: S.hoverEl, cls: 'hover', label: describeEl(S.hoverEl) });
  for (const it of items) it.r = it.el.getBoundingClientRect();
  const key = items.map((it) => `${it.cls}|${it.label}|${it.r.left},${it.r.top},${it.r.width},${it.r.height}`).join(';');
  if (key === drawOverlay.key) return;
  drawOverlay.key = key;
  ov.replaceChildren(
    ...items.map((it) => {
      const box = doc.createElement('div');
      box.className = `box ${it.cls}`;
      box.style.cssText = `left:${it.r.left}px;top:${it.r.top}px;width:${it.r.width}px;height:${it.r.height}px`;
      if (it.label) {
        const tag = doc.createElement('span');
        tag.className = 'tag';
        tag.textContent = it.label;
        box.append(tag);
      }
      return box;
    }),
  );
}

/** Suggests `<class>-anim`, `<class>-anim-2`, … for a new animation on the picked element. */
function suggestName(el) {
  const base = (el.selector.match(/[#.]?([a-zA-Z_][\w-]*)/)?.[1] || 'element').toLowerCase();
  let name = `${base}-anim`;
  for (let i = 2; S.model.animations.some((a) => a.name === name); i++) name = `${base}-anim-${i}`;
  return name;
}

function renderElementSection() {
  const el = S.el;
  const doc = frame.contentDocument;
  const hitsText = () => {
    try {
      const n = doc?.querySelectorAll(el.selector).length ?? 0;
      return n === 1 ? 'matches 1 element' : `matches ${n} elements`;
    } catch {
      return 'invalid selector';
    }
  };
  const hits = h('span', { class: 'muted hits' }, hitsText());
  const selInput = h('input', {
    value: el.selector,
    list: 'sel-list',
    spellcheck: 'false',
    oninput: (e) => {
      el.selector = e.target.value.trim();
      hits.textContent = hitsText();
    },
  });
  const inFile = el.names.filter((n) => S.model.animations.some((a) => a.name === n));
  const foreign = el.names.filter((n) => !inFile.includes(n));
  const nameInput = h('input', { value: suggestName(el), spellcheck: 'false', placeholder: 'name' });

  return h(
    'div',
    { class: 'section element' },
    h('h2', {}, 'Element', h('span', { class: 'spacer' }), h('button', { class: 'ghost', title: 'Clear selection', onclick: () => ((S.el = null), renderInspector()) }, '×')),
    h('p', { class: 'el-tag' }, h('code', {}, el.tag)),
    field('Selector', h('div', {}, selInput, hits)),
    h('datalist', { id: 'sel-list' }, el.candidates.map((c) => h('option', { value: c }))),
    h(
      'div',
      { class: 'chips' },
      inFile.map((n) => h('button', { class: `chip${n === S.name ? ' on' : ''}`, onclick: () => setAnimation(n) }, n)),
      foreign.map((n) => h('span', { class: 'chip foreign', title: 'Not defined in this file' }, n)),
      !el.names.length && h('span', { class: 'muted' }, 'No animation on this element yet.'),
    ),
    h('div', { class: 'row create' }, nameInput, h('button', { class: 'primary', onclick: () => createAnimation(nameInput.value.trim(), el.selector) }, '+ Animation')),
  );
}

function field(label, input, cls = '') {
  return h('label', { class: `field ${cls}` }, h('span', {}, label), input);
}

function numberInput(value, unit, onValue) {
  const input = h('input', {
    type: 'number',
    value,
    step: 10,
    oninput: (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isNaN(v)) onValue(v);
    },
  });
  return h('div', { class: 'unit', 'data-unit': unit }, input);
}

function curveSvg(easing) {
  const m = easing.match(/^cubic-bezier\(([^)]+)\)$/);
  const pts = BEZIER[easing] || (m && m[1].split(',').map(Number));
  if (!pts || pts.length !== 4 || pts.some(Number.isNaN)) return h('p', { class: 'note' }, 'No curve preview for this function.');
  const W = 280;
  const H = 70;
  const pad = 10;
  const ys = [0, 1, pts[1], pts[3]];
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const x = (v) => pad + v * (W - 2 * pad);
  const y = (v) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'curve');
  svg.innerHTML = `
    <path d="M${x(0)} ${y(0)} L${x(pts[0])} ${y(pts[1])} M${x(1)} ${y(1)} L${x(pts[2])} ${y(pts[3])}" stroke="#444" stroke-width="1"/>
    <path d="M${x(0)} ${y(0)} C${x(pts[0])} ${y(pts[1])} ${x(pts[2])} ${y(pts[3])} ${x(1)} ${y(1)}" fill="none" stroke="#3d9bff" stroke-width="1.5"/>
    <circle cx="${x(pts[0])}" cy="${y(pts[1])}" r="2.5" fill="#dfe6ee"/><circle cx="${x(pts[2])}" cy="${y(pts[3])}" r="2.5" fill="#dfe6ee"/>`;
  return svg;
}

function renderInspector() {
  const a = anim();
  const t = a.timing;
  const inspector = $('#inspector');

  const easingText = h('input', {
    value: t.easing,
    oninput: (e) => {
      const v = e.target.value.trim();
      if (!v) return;
      change(() => (t.easing = v), { render: 'light' });
      curveHost.replaceChildren(curveSvg(v));
      easingSelect.value = EASINGS.includes(v) ? v : '';
    },
  });
  const easingSelect = h(
    'select',
    {
      onchange: (e) => {
        if (!e.target.value) return;
        change(() => (t.easing = e.target.value));
      },
    },
    h('option', { value: '' }, 'Custom …'),
    EASINGS.map((v) => h('option', { value: v, selected: v === t.easing }, v.replace(/cubic-bezier\(0.34, 1.56, 0.64, 1\)/, 'back-out').replace(/cubic-bezier\(0.65, 0, 0.35, 1\)/, 'smooth-in-out'))),
  );
  const curveHost = h('div', {}, curveSvg(t.easing));

  const iterInput = h('input', {
    value: t.iterations,
    list: 'iter-list',
    oninput: (e) => {
      const v = e.target.value.trim();
      const ok = /^(infinite|\d*\.?\d+)$/.test(v);
      e.target.classList.toggle('invalid', !ok);
      if (ok) change(() => (t.iterations = v), { render: 'light' });
    },
  });

  const select = (options, key) =>
    h(
      'select',
      { onchange: (e) => change(() => (t[key] = e.target.value), { render: 'light' }) },
      options.map((v) => h('option', { value: v, selected: v === t[key] }, v)),
    );

  const timing = h(
    'div',
    { class: 'section' },
    h('h2', {}, 'Timing'),
    h(
      'div',
      { class: 'grid2' },
      field('Duration', numberInput(t.duration, 'ms', (v) => change(() => (t.duration = Math.max(0, v)), { render: 'light' }))),
      field('Delay', numberInput(t.delay, 'ms', (v) => change(() => (t.delay = v), { render: 'light' }))),
      field('Easing', h('div', { class: 'easing-row' }, easingSelect, easingText), 'wide'),
      h('div', { class: 'field wide' }, curveHost),
      field('Iterations', iterInput),
      field('Direction', select(['normal', 'reverse', 'alternate', 'alternate-reverse'], 'direction')),
      field('Fill mode', select(['none', 'forwards', 'backwards', 'both'], 'fill')),
    ),
    h('datalist', { id: 'iter-list' }, ['1', '2', '3', 'infinite'].map((v) => h('option', { value: v }))),
    a.usage
      ? h('p', { class: 'note' }, 'Used by ', h('code', {}, a.usage.selector))
      : h('p', { class: 'note warn' }, 'No CSS rule uses this animation – timing only applies to the preview and is not saved.'),
  );

  inspector.replaceChildren(...(S.el ? [renderElementSection()] : []), timing, renderPropsPanel(), renderKeyframeSection(a));
}

/* ---------- property panel: every value at the playhead, Figma-style ---------- */

const PANEL = [
  ['Transform', ['scale', 'rotate', 'translate', 'transform']],
  ['Appearance', ['opacity', 'filter', 'background-color', 'color']],
  ['Size', ['width', 'height', 'border-radius']],
];
const PANEL_PROPS = PANEL.flatMap(([, props]) => props);
const extraProps = new Set(); // custom properties the user exposed that aren't in any keyframe yet
const rawRows = new Set(); // properties the user switched to plain-text editing
let panelDrag = false;

const panelExtras = (a) => [...new Set([...propsOf(a), ...extraProps])].filter((p) => !PANEL_PROPS.includes(p));
const panelKey = (a, at) =>
  [...PANEL_PROPS, ...panelExtras(a)].map((p) => `${p}${at?.block.decls.some((d) => d.prop === p) ? '*' : isAnimated(a, p) ? '~' : ''}=${valueAt(p, at)}`).join('|') +
  `#${playheadPct()}`;

function renderPropsPanel() {
  const a = anim();
  const at = blockAtPlayhead();
  const rows = [];
  for (const [group, props] of PANEL) rows.push(h('div', { class: 'group' }, group), ...props.map((p) => propRow(p, at)));
  const extras = panelExtras(a);
  if (extras.length) rows.push(h('div', { class: 'group' }, 'Other'), ...extras.map((p) => propRow(p, at)));

  const custom = h('input', { placeholder: 'add property …', list: 'prop-list', spellcheck: 'false', onkeydown: (e) => e.key === 'Enter' && addCustom() });
  const addCustom = () => {
    const p = custom.value.trim();
    if (!p) return;
    extraProps.add(p);
    renderInspector();
  };
  const panel = h(
    'div',
    { class: 'section props', id: 'props' },
    h('h2', {}, 'Properties', h('span', { class: 'spacer' }), h('span', { class: playheadInRange() ? 'muted' : 'warn-text', title: playheadInRange() ? '' : 'The playhead is outside this animation – keys land at its nearest end.' }, `${a.name} at ${fmtPct(playheadPct())}${playheadInRange() ? '' : ' ⚠'}`)),
    h('div', { class: 'rows' }, rows),
    h('div', { class: 'row custom' }, custom, h('button', { onclick: addCustom }, '+')),
  );
  panel.dataset.key = panelKey(a, at);
  return panel;
}

/** Re-renders the panel when the playhead moved – unless the user is typing or dragging in it. */
function refreshPanel() {
  const panel = $('#props');
  if (!panel || !S.model || panelDrag || panel.contains(document.activeElement)) return;
  if (panel.dataset.key === panelKey(anim(), blockAtPlayhead())) return;
  panel.replaceWith(renderPropsPanel());
}
let panelTimer;
let panelLast = 0;
function schedulePanel() {
  clearTimeout(panelTimer);
  const wait = 120 - (performance.now() - panelLast);
  panelTimer = setTimeout(
    () => {
      panelLast = performance.now();
      refreshPanel();
    },
    Math.max(0, wait),
  );
}
document.addEventListener('pointerdown', (e) => (panelDrag = !!e.target.closest('#props')));
document.addEventListener('pointerup', () => (panelDrag = false));

/** One property: key diamond, name (click = toggle plain text), editor showing the value at the playhead. */
function propRow(prop, at) {
  const decl = at?.block.decls.find((d) => d.prop === prop);
  const state = decl ? 'keyed' : isAnimated(anim(), prop) ? 'animated' : '';
  let cur = valueAt(prop, at);
  const spec = specOf(prop);
  const row = h('div', { class: `prop ${state}${spec.kind === 'fns' ? ' wide' : ''}` });

  const key = h('button', {
    class: 'key',
    title: decl ? 'Remove this property from the keyframe' : 'Key this property at the playhead',
    onclick: () => {
      if (decl) unkey(prop);
      else {
        keyAt(prop, cur);
        renderInspector();
      }
    },
  });
  const name = h(
    'span',
    { class: 'name', title: `${prop} – click to edit as text`, onclick: () => (rawRows.has(prop) ? rawRows.delete(prop) : rawRows.add(prop), renderInspector()) },
    prop,
  );
  const set = (v) => {
    cur = v;
    keyAt(prop, v);
    row.classList.add('keyed');
    row.classList.remove('animated');
    key.title = 'Remove this property from the keyframe';
  };
  const raw = h('input', { class: 'raw', value: cur, spellcheck: 'false', oninput: (e) => set(e.target.value) });
  const editor = rawRows.has(prop) ? null : buildEditor(prop, cur, set);
  row.append(name, editor || raw, key); // key diamond after the value, like Rive
  return row;
}

function renderKeyframeSection(a) {
  if (!S.sel) {
    return h(
      'div',
      { class: 'section', id: 'kf-section' },
      h('h2', {}, 'Keyframe'),
      h('p', { class: 'empty-inspector' }, 'Changing a value above keys it at the playhead. Keyframes in the timeline: click = select, drag = move, double-click a track = new keyframe.'),
    );
  }
  const { bi, oi } = S.sel;
  const block = a.keyframes[bi];
  const others = block.offsets.filter((_, i) => i !== oi);

  const offsetInput = h('input', {
    type: 'number',
    value: block.offsets[oi],
    min: 0,
    max: 100,
    step: 1,
    oninput: (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isNaN(v)) return;
      change(
        () => {
          block.offsets[oi] = clamp(v, 0, 100);
          S.t = delayOf() + (block.offsets[oi] / 100) * dur();
        },
        { render: 'light' },
      );
    },
  });

  const keyed = block.decls.map((d) => d.prop).filter(Boolean);
  return h(
    'div',
    { class: 'section', id: 'kf-section' },
    h('h2', {}, `Keyframe`, h('span', { class: 'spacer' }), h('span', { class: 'muted' }, fmtMs(delayOf() + (block.offsets[oi] / 100) * dur()))),
    h('div', { class: 'grid2', style: 'margin-bottom:10px' }, field('Position', h('div', { class: 'unit', 'data-unit': '%' }, offsetInput))),
    others.length
      ? h('p', { class: 'shared' }, `Shared block with ${others.map(fmtPct).join(', ')} – values apply to all. `, h('button', { onclick: splitSelected }, 'Split'))
      : null,
    h('p', { class: 'note', style: 'margin:0 0 10px' }, ...(keyed.length ? ['Sets: ', ...keyed.flatMap((p, i) => [i ? ', ' : '', h('code', {}, p)])] : ['Sets no property yet.'])),
    h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { class: 'danger', onclick: deleteSelected }, 'Delete keyframe')),
  );
}

/* ---------- value editors ---------- */

/** Returns an editor element for the value, or null when only the raw text makes sense. */
function buildEditor(prop, value, set) {
  const spec = specOf(prop);
  if (spec.kind === 'text') return null;
  if (spec.kind === 'enum') {
    return h(
      'div',
      { class: 'editor' },
      h('select', { onchange: (e) => set(e.target.value) }, spec.options.map((o) => h('option', { value: o, selected: o === value.trim() }, o))),
    );
  }
  if (spec.kind === 'color') return colorEditor(value, set);
  if (spec.kind === 'fns') return fnsEditor(FNS[prop], value, set);
  const toks = parseTokens(value);
  if (!toks) return null;
  const emit = () => set(fmtTokens(toks));
  const fields = toks.map((tok) => numField(tok, spec.units, spec.range, toks.length === 1, emit));
  return h('div', { class: 'editor' }, fields.flatMap((f) => [f.slider, f.num]));
}

/**
 * Number input (+ slider for single values, + unit select when units are known), returned as
 * { slider, num } so callers can place them. Mutates `tok`, then calls onChange.
 */
function numField(tok, units, range, withSlider, onChange) {
  const [min, max, step] = rangeFor(tok, range);
  const num = h('input', {
    type: 'number',
    step,
    value: tok.n,
    oninput: (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isNaN(v)) return;
      tok.n = v;
      if (slider) slider.value = v;
      onChange();
    },
  });
  const slider = withSlider
    ? h('input', {
        type: 'range',
        min: Math.min(min, tok.n),
        max: Math.max(max, tok.n),
        step,
        value: tok.n,
        oninput: (e) => {
          tok.n = +e.target.value;
          num.value = tok.n;
          onChange();
        },
      })
    : null;
  const unitOptions = units && [...new Set([...units, tok.unit])].filter(Boolean);
  const unit = unitOptions?.length
    ? h(
        'select',
        {
          onchange: (e) => {
            tok.unit = e.target.value;
            onChange();
          },
        },
        unitOptions.map((u) => h('option', { value: u, selected: u === tok.unit }, u)),
      )
    : tok.unit
      ? h('span', { class: 'u' }, tok.unit)
      : null;
  return { slider, num: h('div', { class: 'num' }, num, unit) };
}

/** Editor for transform/filter: one row per function with typed args, plus a picker to append more. */
function fnsEditor(catalog, value, set) {
  const fns = parseFns(value);
  if (!fns) return null;
  const el = h('div', { class: 'editor fns' });
  const emit = () => set(fmtFns(fns));
  const names = Object.keys(catalog);
  const rebuild = () => {
    const rows = fns.map((f, i) => {
      const spec = catalog[f.name];
      const sliders = [];
      const args = f.args.map((a) => {
        if (a.raw !== undefined) {
          return h('input', {
            value: a.raw,
            spellcheck: 'false',
            oninput: (e) => {
              a.raw = e.target.value;
              emit();
            },
          });
        }
        const field = numField(a, spec?.units, spec?.range, f.args.length === 1, emit);
        if (field.slider) sliders.push(field.slider);
        return field.num;
      });
      return h(
        'div',
        { class: 'fn' },
        h(
          'select',
          {
            class: 'fn-name',
            onchange: (e) => {
              f.name = e.target.value;
              f.args = catalog[f.name].def.map(parseNum);
              emit();
              rebuild();
            },
          },
          [...new Set([...names, f.name])].map((n) => h('option', { value: n, selected: n === f.name }, n)),
        ),
        args,
        h('span', { class: 'spacer' }),
        h('button', {
          title: 'Remove function',
          onclick: () => {
            fns.splice(i, 1);
            emit();
            rebuild();
          },
        }, '×'),
        sliders, // wrap onto their own full-width line
      );
    });
    const adder = h(
      'select',
      {
        class: 'picker',
        onchange: (e) => {
          const name = e.target.value;
          if (!name) return;
          fns.push({ name, args: catalog[name].def.map(parseNum) });
          emit();
          rebuild();
        },
      },
      h('option', { value: '' }, '+ Function …'),
      names.map((n) => h('option', { value: n }, n)),
    );
    el.replaceChildren(...rows, adder);
  };
  rebuild();
  return el;
}

/** Color picker + alpha slider. Writes hex, or rgba() when alpha < 1. */
function colorEditor(value, set) {
  const cur = toRgba(value);
  if (!cur) return null;
  const emit = () => set(fmtColor(cur));
  const picker = h('input', {
    type: 'color',
    value: toHex(cur),
    oninput: (e) => {
      Object.assign(cur, toRgba(e.target.value), { a: cur.a });
      emit();
    },
  });
  const alpha = h('input', {
    type: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    value: cur.a,
    title: 'Alpha',
    oninput: (e) => {
      cur.a = +e.target.value;
      emit();
    },
  });
  return h('div', { class: 'editor' }, picker, alpha);
}

/* ---------- scene: every animated element of the page on one clock ---------- */

/** Animated elements of the page grouped by (animation, timing); plus the edited animation if nothing runs it. */
function sceneGroups() {
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  const groups = new Map();
  if (doc?.getAnimations && win?.CSSAnimation) {
    for (const x of doc.getAnimations()) {
      if (!(x instanceof win.CSSAnimation) || !x.effect?.target) continue;
      const t = x.effect.getTiming();
      const a = S.model.animations.find((m) => m.name === x.animationName) || null;
      const key = `${x.animationName}|${t.delay}|${t.duration}|${t.iterations}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          name: x.animationName,
          anim: a,
          delay: t.delay,
          duration: a ? a.timing.duration : typeof t.duration === 'number' ? t.duration : 0,
          iterations: t.iterations,
          targets: [],
          pseudo: x.effect.pseudoElement || '',
          // Animations defined elsewhere can't be edited, but their keyframes still show for context.
          keyframes: a ? null : x.effect.getKeyframes().map((k) => k.computedOffset * 100),
        };
        groups.set(key, g);
      }
      g.targets.push(x.effect.target);
    }
  }
  const list = [...groups.values()].sort((p, q) => p.delay - q.delay || p.name.localeCompare(q.name));
  if (!list.some((g) => g.name === S.name)) {
    const a = anim();
    list.push({ key: `model|${a.name}`, name: a.name, anim: a, delay: a.timing.delay, duration: a.timing.duration, iterations: a.timing.iterations === 'infinite' ? Infinity : +a.timing.iterations || 1, targets: [], pseudo: '', keyframes: null });
  }
  return list;
}

const groupsKey = (groups) => groups.map((g) => `${g.key}:${g.targets.length}:${g.duration}`).join();
const sceneDur = () => S.sceneDur || 1;
const sceneEnd = (g) => g.delay + g.duration * (Number.isFinite(g.iterations) && g.iterations > 0 ? g.iterations : 1);

/* The timeline shows a window [viewStart, viewStart + viewSpan] of the scene; span null = whole scene. */
const MIN_SPAN = 4 * FRAME;
const viewSpan = () => Math.min(S.view.span ?? sceneDur(), sceneDur());
const viewStart = () => (S.view.span == null ? 0 : clamp(S.view.start, 0, sceneDur() - viewSpan()));
const zoomFactor = () => sceneDur() / viewSpan();
/** Page time -> lane position (%) and back. */
const timeX = (t) => ((t - viewStart()) / viewSpan()) * 100;
const xTime = (x) => viewStart() + (x / 100) * viewSpan();
/** Keyframe offset of group `g` -> lane position (%) and back. */
const sceneX = (g, o) => timeX(g.delay + (o / 100) * g.duration);
const toOffset = (g, x, fine) => {
  const o = clamp(((xTime(x) - g.delay) / Math.max(1, g.duration)) * 100, 0, 100);
  return fine ? Math.round(o * 10) / 10 : Math.round(o);
};

/** Zooms the window by `factor` around page time `t` (zooming out past the scene fits it). */
function zoomTimeline(factor, t) {
  const span = clamp(viewSpan() / factor, MIN_SPAN, sceneDur());
  if (span >= sceneDur()) return resetTimelineView();
  S.view = { span, start: clamp(t - (t - viewStart()) / factor, 0, sceneDur() - span) };
  renderTimeline();
}
function panTimeline(dt) {
  if (S.view.span == null) return;
  S.view.start = clamp(viewStart() + dt, 0, sceneDur() - viewSpan());
  renderTimeline();
}
function resetTimelineView() {
  if (S.view.span == null) return;
  S.view = { span: null, start: 0 };
  renderTimeline();
}
/** Pans the window so the playhead stays in view (arrow keys, keyframe jumps). */
function ensurePlayheadVisible() {
  if (S.view.span == null) return;
  const start = viewStart();
  const span = viewSpan();
  if (S.t < start) panTimeline(S.t - start);
  else if (S.t > start + span) panTimeline(S.t - (start + span));
}

/** Pinch / ⌘-or-Ctrl + wheel zooms around the cursor, Shift + wheel (or a horizontal wheel) pans. Plain wheel scrolls rows. */
function onTimelineWheel(e) {
  const lane = e.target.closest('.tl-track')?.querySelector('.lane') || $('#tracks .lane');
  if (!lane) return;
  const rect = lane.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const frac = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    zoomTimeline(Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.002)), xTime(frac * 100));
  } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    if (S.view.span == null) return;
    e.preventDefault();
    panTimeline(((e.deltaX || e.deltaY) / rect.width) * viewSpan());
  }
}
$('#tracks').addEventListener('wheel', onTimelineWheel, { passive: false });
$('#tl-zoom').onclick = resetTimelineView;

/** Re-renders the timeline when the set of animated elements on the page changed (e.g. started by script). */
function refreshGroups() {
  if (!S.model) return;
  if (groupsKey(sceneGroups()) !== S.groupsKey) renderTimeline();
}

const groupLabel = (g) => (g.targets[0] ? `${describeEl(g.targets[0])}${g.pseudo}${g.targets.length > 1 ? ` ×${g.targets.length}` : ''}` : '(no element)');

/** Makes a group the edited one: its animation in the inspector, its element in the picker. */
function focusGroup(g) {
  if (g.targets[0]) S.el = elInfo(g.targets[0]);
  if (g.anim && g.name !== S.name) setAnimation(g.name);
  else renderAll();
}

/** Lane rects are measured once per gesture: the timeline re-renders while dragging. */
function laneX(e, rect, fine) {
  const p = clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100);
  return fine ? Math.round(p * 10) / 10 : Math.round(p);
}

function followPointer(onMove) {
  const move = (ev) => (ev.buttons === 0 ? end() : onMove(ev));
  const end = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
}

function startScrub(e, lane) {
  if (e.button !== 0) return;
  const rect = lane.getBoundingClientRect();
  const move = (ev) => {
    S.t = xTime(laneX(ev, rect, true));
    updatePlayhead();
  };
  move(e);
  S.playing = false;
  updatePlayButton();
  followPointer(move);
}

function startDrag(e, g, bi, oi) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const rect = e.currentTarget.parentElement.getBoundingClientRect();
  if (g.name !== S.name) setAnimation(g.name);
  select(bi, oi, { at: g.delay + (anim().keyframes[bi].offsets[oi] / 100) * g.duration });
  const x0 = e.clientX;
  let moved = false;
  followPointer((ev) => {
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
    if (!moved) {
      moved = true;
      commit();
    }
    const block = anim().keyframes[bi];
    const o = toOffset(g, laneX(ev, rect, true), ev.shiftKey);
    if (block.offsets[oi] === o) return;
    block.offsets[oi] = o;
    S.t = g.delay + (o / 100) * g.duration;
    afterChange();
  });
}

/** Diamonds of one group's animation on the scene lane; `prop` limits them to keyframes setting that property. */
function keyframeButtons(g, prop) {
  const pts = [];
  g.anim.keyframes.forEach((b, bi) => {
    const decl = prop ? b.decls.find((x) => x.prop === prop) : null;
    if (prop && !decl) return;
    b.offsets.forEach((o, oi) => pts.push({ o, bi, oi, v: decl?.value }));
  });
  pts.sort((x, y) => x.o - y.o);
  const current = g.name === S.name;
  const nodes = [];
  if (prop) {
    for (let i = 0; i < pts.length - 1; i++) nodes.push(h('div', { class: 'bar', style: `left:${sceneX(g, pts[i].o)}%;width:${sceneX(g, pts[i + 1].o) - sceneX(g, pts[i].o)}%` }));
  }
  for (const pt of pts) {
    const isSel = current && S.sel && S.sel.bi === pt.bi && S.sel.oi === pt.oi;
    nodes.push(
      h('button', {
        class: `kf${isSel ? ' sel' : ''}`,
        style: `left:${sceneX(g, pt.o)}%`,
        title: `${fmtPct(pt.o)} · ${fmtMs(g.delay + (pt.o / 100) * g.duration)}${prop ? ` · ${prop}: ${pt.v}` : ''}`,
        onpointerdown: (e) => startDrag(e, g, pt.bi, pt.oi),
      }),
    );
  }
  return nodes;
}

function laneFor(g, prop, children) {
  const lane = h('div', { class: 'lane' }, children);
  return h(
    'div',
    {
      class: 'tl-track',
      onpointerdown: (e) => startScrub(e, lane),
      ondblclick: (e) => {
        if (!g.anim || e.target.classList.contains('kf')) return;
        if (g.name !== S.name) setAnimation(g.name);
        addKeyframe(toOffset(g, laneX(e, lane.getBoundingClientRect(), true), e.shiftKey), prop, g);
      },
    },
    lane,
  );
}

const folded = new Map(); // group key -> user's expand/collapse choice

/** Header row of a group: element name, span bar of the animation, all its keyframes. */
function groupRow(g, open) {
  const D = sceneDur();
  const pct = (ms) => (ms / viewSpan()) * 100;
  const span = [h('div', { class: 'span', style: `left:${timeX(g.delay)}%;width:${pct(g.duration)}%` }, h('span', {}, `${g.name} · ${fmtMs(g.duration)}`))];
  const end = sceneEnd(g);
  if (end > g.delay + g.duration + 1 || !Number.isFinite(g.iterations)) {
    const to = Number.isFinite(g.iterations) ? Math.min(end, D) : D;
    span.push(h('div', { class: 'span more', style: `left:${timeX(g.delay + g.duration)}%;width:${pct(to - g.delay - g.duration)}%`, title: Number.isFinite(g.iterations) ? `${g.iterations}×` : 'infinite' }));
  }
  const kfs = g.anim
    ? keyframeButtons(g, null)
    : g.keyframes.map((o) => h('span', { class: 'kf ghost', style: `left:${sceneX(g, o)}%`, title: `${fmtPct(o)} – not defined in this file` }));
  const fold = h('button', { class: `fold${open ? ' open' : ''}`, title: open ? 'Collapse' : 'Show properties', disabled: !g.anim, onclick: (e) => (e.stopPropagation(), folded.set(g.key, !open), renderTimeline()) }, '▸');
  const label = h('div', { class: 'tl-label', title: g.targets[0] ? `${groupLabel(g)} – ${g.name}` : `${g.name} is not running on any element right now`, onclick: () => focusGroup(g) }, fold, h('span', { class: 'el' }, groupLabel(g)));
  return h('div', { class: `tl-row group${g.name === S.name ? ' current' : ''}${g.anim ? '' : ' foreign'}` }, label, laneFor(g, null, [...span, ...kfs]));
}

function niceStep(total) {
  const target = total / 8;
  return [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 30000].find((s) => s >= target) || 60000;
}

function renderTimeline() {
  const groups = sceneGroups();
  S.groups = groups;
  S.groupsKey = groupsKey(groups);
  const D = (S.sceneDur = Math.max(1, ...groups.map(sceneEnd)));
  const start = viewStart();
  const span = viewSpan();
  const step = niceStep(span);
  const ruler = h('div', { class: 'lane' });
  for (let t = Math.ceil(start / step) * step; t < start + span - step * 0.9; t += step) ruler.append(h('div', { class: 'tick', style: `left:${timeX(t)}%` }, h('span', {}, fmtMs(t))));
  ruler.append(h('div', { class: 'tick end', style: 'left:100%' }, h('span', {}, fmtMs(start + span))));
  const z = zoomFactor();
  const zoomBtn = $('#tl-zoom');
  zoomBtn.hidden = z < 1.01;
  zoomBtn.textContent = `${z < 10 ? z.toFixed(1) : Math.round(z)}× · fit`;
  const n = groups.filter((g) => g.targets.length).length;
  const rulerRow = h('div', { class: 'tl-row ruler' }, h('div', { class: 'tl-label' }, n ? `${n} element${n > 1 ? 's' : ''}` : 'No elements'), h('div', { class: 'tl-track', onpointerdown: (e) => startScrub(e, ruler) }, ruler));

  const rows = [rulerRow];
  for (const g of groups) {
    const open = folded.has(g.key) ? folded.get(g.key) : g.name === S.name;
    rows.push(groupRow(g, open && !!g.anim));
    if (open && g.anim) {
      for (const prop of propsOf(g.anim)) rows.push(h('div', { class: 'tl-row' }, h('div', { class: 'tl-label sub', title: prop }, prop), laneFor(g, prop, keyframeButtons(g, prop))));
    }
  }
  const layer = h('div', { class: 'playhead-layer' }, h('div', { class: 'playhead', id: 'playhead' }));
  $('#tracks').replaceChildren(...rows, layer);
  updatePlayhead();
}

function updatePlayhead() {
  if (!S.model) return;
  const p = timeX(S.t);
  const ph = $('#playhead');
  if (ph) {
    ph.style.left = `${p}%`;
    ph.hidden = p < -0.5 || p > 100.5;
  }
  $('#time').innerHTML = `<b>${Math.round(S.t)}ms</b> / ${Math.round(sceneDur())}ms`;
  schedulePanel();
}

function updatePlayButton() {
  $('#play').textContent = S.playing ? '❚❚' : '▶';
}

/* ---------- playback loop ---------- */

let last = performance.now();
function tick(now) {
  const dt = now - last;
  last = now;
  if (S.model && S.playing) {
    S.t += dt * S.speed;
    if (S.t >= sceneDur()) {
      if (S.loop) S.t %= sceneDur();
      else {
        S.t = sceneDur();
        S.playing = false;
        updatePlayButton();
      }
    }
    updatePlayhead();
  }
  syncPreview();
  drawOverlay();
  if (now - lastGroupCheck > 500) {
    lastGroupCheck = now;
    refreshGroups();
  }
  requestAnimationFrame(tick);
}
let lastGroupCheck = 0;
requestAnimationFrame(tick);

/* ---------- wiring ---------- */

function togglePlay() {
  if (!S.model) return;
  if (!S.playing && S.t >= sceneDur()) S.t = 0;
  S.playing = !S.playing;
  updatePlayButton();
}

$('#play').onclick = togglePlay;
$('#rewind').onclick = () => {
  S.t = 0;
  updatePlayhead();
};
$('#loop').onchange = (e) => (S.loop = e.target.checked);
$('#speed').onchange = (e) => (S.speed = +e.target.value);
$('#save').onclick = saveNow;
$('#undo').onclick = () => (S.schema ? undoValues() : undo());
$('#redo').onclick = () => (S.schema ? redoValues() : redo());
$('#add-kf').onclick = () => addKeyframe(playheadPct());
$('#mode').onclick = (e) => e.target.dataset.mode && setMode(e.target.dataset.mode);
$('#pick').onclick = () => setPicking(!S.picking);
$('#anim-select').onchange = (e) => setAnimation(e.target.value);

addEventListener('keydown', (e) => {
  if (!S.model && !S.schema) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    return saveNow();
  }
  const typing = e.target.matches('input, select, textarea');
  if (S.schema) {
    if (mod && !typing && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
      e.preventDefault();
      return e.key.toLowerCase() === 'y' || e.shiftKey ? redoValues() : undoValues();
    }
    return;
  }
  if (mod && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    return e.shiftKey ? redo() : undo();
  }
  if (mod && e.key.toLowerCase() === 'y' && !typing) {
    e.preventDefault();
    return redo();
  }
  if (typing) return;
  if (e.key === ' ') {
    e.preventDefault();
    if (e.target instanceof HTMLButtonElement) e.target.blur(); // Space must not also re-trigger a focused button
    togglePlay();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) {
    deleteSelected();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const dir = e.key === 'ArrowLeft' ? -1 : 1;
    if (e.shiftKey) jumpToKeyframe(dir);
    else {
      S.playing = false;
      updatePlayButton();
      S.t = clamp(S.t + dir * arrowStep(), 0, sceneDur());
      ensurePlayheadVisible();
      updatePlayhead();
    }
  } else if (e.key === 'Home' || e.key === 'End') {
    S.t = e.key === 'Home' ? 0 : sceneDur();
    ensurePlayheadVisible();
    updatePlayhead();
  } else if (e.key === 'Escape') {
    if (S.picking) setPicking(false);
    else select(null);
  } else if (e.key.toLowerCase() === 'v' && !mod) {
    setPicking(!S.picking);
  } else if (e.key === '0' && !mod) {
    resetTimelineView();
    resetZoom();
  }
});

/** Arrow step: 1 % of the visible window, in whole frames – one frame when zoomed in, bigger steps zoomed out. */
const arrowStep = () => Math.max(1, Math.round(viewSpan() / 100 / FRAME)) * FRAME;

/** Every keyframe of the scene as page time, with what it belongs to. */
function keyframeTimes() {
  const out = [];
  for (const g of S.groups || []) {
    if (g.anim) g.anim.keyframes.forEach((b, bi) => b.offsets.forEach((o, oi) => out.push({ t: g.delay + (o / 100) * g.duration, g, bi, oi })));
    else for (const o of g.keyframes) out.push({ t: g.delay + (o / 100) * g.duration, g });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Shift+arrow: playhead to the next/previous keyframe of any element; selects it if it belongs to the edited animation. */
function jumpToKeyframe(dir) {
  const times = keyframeTimes();
  const hit = dir > 0 ? times.find((k) => k.t > S.t + 0.5) : [...times].reverse().find((k) => k.t < S.t - 0.5);
  if (!hit) return;
  S.playing = false;
  updatePlayButton();
  S.t = hit.t;
  ensurePlayheadVisible();
  if (hit.g.anim && hit.g.name === S.name) select(hit.bi, hit.oi, { seek: false });
  else {
    renderTimeline();
    updatePlayhead();
  }
}

addEventListener('beforeunload', (e) => {
  if (S.dirty) e.preventDefault();
});

$('#prop-list').replaceChildren(...KNOWN.map((p) => h('option', { value: p })));

const events = new EventSource(`${BASE}/api/events`);
events.addEventListener('session', () => load());
events.addEventListener('external-change', () => {
  if (!S.dirty) return load({ keepTime: true }).then(() => toast('File changed on disk – reloaded'));
  banner([
    h('span', {}, 'The file was changed outside of anni.'),
    h('button', { onclick: () => load({ keepTime: true }) }, 'Reload (discards your edits)'),
  ]);
});

load();
