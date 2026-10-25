// anni editor: loads the open session from the local server, shows the preview in an
// iframe (same origin), and drives the selected CSS animation with a paused Web Animation.

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
};

const EASINGS = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'cubic-bezier(0.34, 1.56, 0.64, 1)', 'cubic-bezier(0.65, 0, 0.35, 1)', 'steps(4, end)'];
const BEZIER = { linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1] };

const frame = $('#frame');
const anim = () => S.model.animations.find((a) => a.name === S.name);
const dur = () => Math.max(1, anim().timing.duration);
const fmtPct = (p) => `${+p.toFixed(2)}%`;
const fmtMs = (ms) => (ms >= 1000 ? `${+(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const snapshot = () => JSON.stringify(S.model.animations);

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
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
    return;
  }
  S.model = data.model;
  S.name = S.model.animations.some((a) => a.name === S.session.animation) ? S.session.animation : S.model.animations[0].name;
  S.saved = S.session.dirty ? '' : snapshot();
  S.dirty = S.session.dirty;
  S.sel = null;
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

function loadPreview() {
  S.css = null;
  frame.src = S.mode === 'page' ? S.session.previewUrl : `${S.session.demoUrl}?v=${Date.now()}`;
  renderStageBar();
}

frame.addEventListener('load', () => {
  push();
  setTimeout(checkPreview, 600);
});

function checkPreview() {
  if (!S.session || S.mode !== 'page') return;
  const found = previewAnimations().length;
  $('#stage-info').textContent = found ? `${found} Element${found > 1 ? 'e' : ''} mit „${S.name}“` : '';
  if (!found) {
    banner([
      h('span', {}, `Auf der Seite spielt gerade kein Element „${S.name}“ ab (z. B. erst bei :hover oder per JS).`),
      h('button', { onclick: () => setMode('demo') }, 'Demo-Box zeigen'),
    ]);
  }
}

function setMode(mode) {
  if (mode === S.mode) return;
  S.mode = mode;
  banner(null);
  loadPreview();
}

/* ---------- live preview ---------- */

let pushSeq = 0;
let pushTimer;
function push() {
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
}

function previewAnimations() {
  const doc = frame.contentDocument;
  if (!doc || !doc.getAnimations) return [];
  return doc.getAnimations().filter((x) => x.animationName === S.name);
}

function syncPreview() {
  if (!S.model) return;
  const { delay, direction } = anim().timing;
  const f = Math.min(S.t / dur(), 0.99999);
  const reversed = /reverse/.test(direction);
  for (const x of previewAnimations()) {
    if (x.playState !== 'paused') x.pause();
    const timing = x.effect.getTiming();
    const d = typeof timing.duration === 'number' ? timing.duration : 0;
    if (!d) continue;
    // Elements with an extra delay (e.g. staggered via :nth-child) stay offset against the playhead.
    const shifted = (((f * d - (timing.delay - delay)) % d) + d) % d;
    const local = reversed ? d - shifted : shifted;
    x.currentTime = timing.delay + Math.min(local, d - 0.01);
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

function select(bi, oi, { seek = true } = {}) {
  S.sel = bi === null ? null : { bi, oi };
  if (S.sel && seek) S.t = (anim().keyframes[bi].offsets[oi] / 100) * dur();
  renderTimeline();
  renderInspector();
}

function addKeyframe(p, prop) {
  const a = anim();
  p = Math.round(p * 10) / 10;
  const bi = a.keyframes.findIndex((b) => b.offsets.some((o) => Math.abs(o - p) < 0.05));
  if (bi >= 0) {
    const block = a.keyframes[bi];
    if (prop && !block.decls.some((d) => d.prop === prop)) change(() => block.decls.push({ prop, value: valueNear(a, prop, p) }));
    return select(bi, block.offsets.findIndex((o) => Math.abs(o - p) < 0.05));
  }
  const props = prop ? [prop] : propsOf(a);
  change(() => a.keyframes.push({ offsets: [p], decls: props.map((pr) => ({ prop: pr, value: valueNear(a, pr, p) })) }));
  select(a.keyframes.length - 1, 0);
}

function deleteSelected() {
  if (!S.sel) return;
  const a = anim();
  const { bi, oi } = S.sel;
  change(() => {
    const block = a.keyframes[bi];
    if (block.offsets.length > 1) block.offsets.splice(oi, 1);
    else a.keyframes.splice(bi, 1);
  });
  select(null);
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
    toast(r.changed ? 'In Datei gespeichert' : 'Keine Änderungen');
  } catch (e) {
    toast(`Fehler: ${e.message}`);
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
  $('#stage-info').textContent = S.mode === 'demo' ? 'Animation auf einer Test-Box' : '';
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
  if (!pts || pts.length !== 4 || pts.some(Number.isNaN)) return h('p', { class: 'note' }, 'Keine Kurvenvorschau für diese Funktion.');
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
    <path d="M${x(0)} ${y(0)} L${x(pts[0])} ${y(pts[1])} M${x(1)} ${y(1)} L${x(pts[2])} ${y(pts[3])}" stroke="#4a5266" stroke-width="1"/>
    <path d="M${x(0)} ${y(0)} C${x(pts[0])} ${y(pts[1])} ${x(pts[2])} ${y(pts[3])} ${x(1)} ${y(1)}" fill="none" stroke="#7c6cff" stroke-width="2"/>
    <circle cx="${x(pts[0])}" cy="${y(pts[1])}" r="3" fill="#c9c1ff"/><circle cx="${x(pts[2])}" cy="${y(pts[3])}" r="3" fill="#c9c1ff"/>`;
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
    h('option', { value: '' }, 'Eigene …'),
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
      field('Dauer', numberInput(t.duration, 'ms', (v) => change(() => (t.duration = Math.max(0, v)), { render: 'light' }))),
      field('Verzögerung', numberInput(t.delay, 'ms', (v) => change(() => (t.delay = v), { render: 'light' }))),
      field('Easing', h('div', { class: 'easing-row' }, easingSelect, easingText), 'wide'),
      h('div', { class: 'field wide' }, curveHost),
      field('Wiederholungen', iterInput),
      field('Richtung', select(['normal', 'reverse', 'alternate', 'alternate-reverse'], 'direction')),
      field('Fill-Mode', select(['none', 'forwards', 'backwards', 'both'], 'fill')),
    ),
    h('datalist', { id: 'iter-list' }, ['1', '2', '3', 'infinite'].map((v) => h('option', { value: v }))),
    a.usage
      ? h('p', { class: 'note' }, 'Verwendet in ', h('code', {}, a.usage.selector))
      : h('p', { class: 'note warn' }, 'Keine CSS-Regel nutzt diese Animation – Timing gilt nur für die Vorschau und wird nicht gespeichert.'),
  );

  inspector.replaceChildren(timing, renderKeyframeSection(a));
}

function renderKeyframeSection(a) {
  if (!S.sel) {
    return h(
      'div',
      { class: 'section' },
      h('h2', {}, 'Keyframe'),
      h('p', { class: 'empty-inspector' }, 'Klick auf eine Raute in der Timeline, um Werte zu bearbeiten. Doppelklick in eine Spur legt einen neuen Keyframe an.'),
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
          S.t = (block.offsets[oi] / 100) * dur();
        },
        { render: 'light' },
      );
    },
  });

  const decls = block.decls.map((d, di) =>
    h(
      'div',
      { class: 'decl' },
      h('input', { value: d.prop, placeholder: 'property', spellcheck: 'false', oninput: (e) => change(() => (d.prop = e.target.value.trim()), { render: 'light' }) }),
      h('input', { value: d.value, placeholder: 'value', spellcheck: 'false', oninput: (e) => change(() => (d.value = e.target.value), { render: 'light' }) }),
      h('button', { title: 'Entfernen', onclick: () => change(() => block.decls.splice(di, 1)) }, '×'),
    ),
  );

  return h(
    'div',
    { class: 'section' },
    h('h2', {}, `Keyframe`, h('span', { class: 'spacer' }), h('span', { class: 'muted' }, fmtMs((block.offsets[oi] / 100) * dur()))),
    h('div', { class: 'grid2', style: 'margin-bottom:10px' }, field('Position', h('div', { class: 'unit', 'data-unit': '%' }, offsetInput))),
    others.length
      ? h('p', { class: 'shared' }, `Geteilter Block mit ${others.map(fmtPct).join(', ')} – Werte gelten für alle. `, h('button', { onclick: splitSelected }, 'Trennen'))
      : null,
    h('div', { class: 'decls' }, decls),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          onclick: () => {
            change(() => block.decls.push({ prop: '', value: '' }));
            const inputs = document.querySelectorAll('.decl input');
            inputs[inputs.length - 2]?.focus();
          },
        },
        '+ Eigenschaft',
      ),
      h('span', { class: 'spacer' }),
      h('button', { class: 'danger', onclick: deleteSelected }, 'Keyframe löschen'),
    ),
  );
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
    S.t = (laneX(ev, rect, true) / 100) * dur();
    updatePlayhead();
  };
  move(e);
  S.playing = false;
  updatePlayButton();
  followPointer(move);
}

function startDrag(e, bi, oi) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const rect = e.currentTarget.parentElement.getBoundingClientRect();
  select(bi, oi);
  const x0 = e.clientX;
  let moved = false;
  followPointer((ev) => {
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
    if (!moved) {
      moved = true;
      commit();
    }
    const block = anim().keyframes[bi];
    const p = laneX(ev, rect, ev.shiftKey);
    if (block.offsets[oi] === p) return;
    block.offsets[oi] = p;
    S.t = (p / 100) * dur();
    afterChange();
  });
}

function track(label, cls, points, prop) {
  const lane = h('div', { class: 'lane' });
  const sorted = [...points].sort((x, y) => x.o - y.o);
  if (prop) {
    for (let i = 0; i < sorted.length - 1; i++) {
      lane.append(h('div', { class: 'bar', style: `left:${sorted[i].o}%;width:${sorted[i + 1].o - sorted[i].o}%` }));
    }
  }
  for (const pt of sorted) {
    const isSel = S.sel && S.sel.bi === pt.bi && S.sel.oi === pt.oi;
    lane.append(
      h('button', {
        class: `kf${isSel ? ' sel' : ''}`,
        style: `left:${pt.o}%`,
        title: `${fmtPct(pt.o)}${prop ? ` · ${prop}: ${pt.v}` : ''}`,
        onpointerdown: (e) => startDrag(e, pt.bi, pt.oi),
      }),
    );
  }
  const trackEl = h(
    'div',
    {
      class: 'tl-track',
      onpointerdown: (e) => startScrub(e, lane),
      ondblclick: (e) => {
        if (e.target.classList.contains('kf')) return;
        addKeyframe(laneX(e, lane.getBoundingClientRect(), e.shiftKey), prop);
      },
    },
    lane,
  );
  return h('div', { class: `tl-row ${cls}` }, h('div', { class: 'tl-label', title: label }, label), trackEl);
}

function renderTimeline() {
  const a = anim();
  const d = dur();
  const ruler = h('div', { class: 'lane' });
  for (let p = 0; p <= 100; p += 10) {
    ruler.append(h('div', { class: `tick${p === 100 ? ' end' : ''}`, style: `left:${p}%` }, h('span', {}, `${p}%`), h('em', {}, fmtMs((p / 100) * d))));
  }
  const rulerRow = h(
    'div',
    { class: 'tl-row ruler' },
    h('div', { class: 'tl-label' }, `${fmtMs(d)} · ${a.timing.iterations === 'infinite' ? '∞' : `${a.timing.iterations}×`}`),
    h('div', { class: 'tl-track', onpointerdown: (e) => startScrub(e, ruler) }, ruler),
  );

  const all = [];
  a.keyframes.forEach((b, bi) => b.offsets.forEach((o, oi) => all.push({ o, bi, oi })));
  const rows = [rulerRow, track('Keyframes', 'summary', all, null)];
  for (const prop of propsOf(a)) {
    const pts = [];
    a.keyframes.forEach((b, bi) => {
      const decl = b.decls.find((x) => x.prop === prop);
      if (decl) b.offsets.forEach((o, oi) => pts.push({ o, bi, oi, v: decl.value }));
    });
    rows.push(track(prop, '', pts, prop));
  }
  const layer = h('div', { class: 'playhead-layer' }, h('div', { class: 'playhead', id: 'playhead' }));
  $('#tracks').replaceChildren(...rows, layer);
  updatePlayhead();
}

function updatePlayhead() {
  if (!S.model) return;
  const p = (S.t / dur()) * 100;
  const ph = $('#playhead');
  if (ph) ph.style.left = `${p}%`;
  $('#time').innerHTML = `<b>${Math.round(S.t)}ms</b> / ${Math.round(dur())}ms · ${p.toFixed(1)}%`;
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
    if (S.t >= dur()) {
      if (S.loop) S.t %= dur();
      else {
        S.t = dur();
        S.playing = false;
        updatePlayButton();
      }
    }
    updatePlayhead();
  }
  syncPreview();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* ---------- wiring ---------- */

function togglePlay() {
  if (!S.model) return;
  if (!S.playing && S.t >= dur()) S.t = 0;
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
$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#add-kf').onclick = () => addKeyframe((S.t / dur()) * 100);
$('#mode').onclick = (e) => e.target.dataset.mode && setMode(e.target.dataset.mode);
$('#anim-select').onchange = (e) => {
  for (const x of previewAnimations()) x.play(); // release the old animation
  S.name = e.target.value;
  S.sel = null;
  S.t = 0;
  api('POST', '/api/select', { animation: S.name });
  renderAll();
  push();
  if (S.mode === 'page') setTimeout(checkPreview, 300);
};

addEventListener('keydown', (e) => {
  if (!S.model) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    return saveNow();
  }
  const typing = e.target.matches('input, select, textarea');
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
    togglePlay();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) {
    deleteSelected();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
    S.t = clamp(S.t + (step / 100) * dur(), 0, dur());
    updatePlayhead();
  } else if (e.key === 'Escape') {
    select(null);
  }
});

addEventListener('beforeunload', (e) => {
  if (S.dirty) e.preventDefault();
});

const events = new EventSource('/api/events');
events.addEventListener('session', () => load());
events.addEventListener('external-change', () => {
  if (!S.dirty) return load({ keepTime: true }).then(() => toast('Datei extern geändert – neu geladen'));
  banner([
    h('span', {}, 'Die Datei wurde außerhalb von anni geändert.'),
    h('button', { onclick: () => load({ keepTime: true }) }, 'Neu laden (verwirft deine Änderungen)'),
  ]);
});

load();
