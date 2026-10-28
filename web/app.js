// anni editor: loads the open session from the local server, shows the preview in an
// iframe (same origin), and drives the selected CSS animation with a paused Web Animation.

import { FNS, KNOWN, LENGTH, defaultOf, fmtColor, fmtFns, fmtNum, fmtTokens, parseFns, parseNum, parseTokens, rangeFor, specOf, splitTop, toHex, toRgba } from './props.js';
import { ADDITION, ADD_PROMPT, EXAMPLE_CSS, EXAMPLE_ID, EXAMPLE_SESSION, KEYFRAME_META, exampleCssWith, exampleDoc, withAddition } from './example.js';

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
  loop: 'loop', // LOOP_MODES
  dir: 1, // playing forward (1) or back (-1, the second half of 'bounce')
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
  mode2: 'animate', // 'editor' (styles of the picked element) | 'animate' (timeline), Rive-style
  editorChanges: new Map(), // control id -> { control, value }: declaration edits not yet saved
  ehistory: [],
  efuture: [],
  fileTexts: {}, // uploaded file path -> text, fetched on demand for code wires
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

/*
 * Who this browser is to a hosted session. The owner link carries #owner=<token>&name=<name>; it is kept as a
 * cookie (so the preview's own requests carry it too) and taken out of the address bar, so the link you
 * then copy or share makes nobody else the owner. Guests get a random token of their own when they ask
 * for access. TAB tells this tab apart from the owner's other tabs: only one of them edits.
 */
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// Kept per browser tab across reloads (sessionStorage), so a reloaded editing tab keeps editing; LOAD is this page load.
const TAB = (() => {
  try {
    return sessionStorage.getItem('anni.tab') || (sessionStorage.setItem('anni.tab', randomToken()), sessionStorage.getItem('anni.tab'));
  } catch {
    return randomToken();
  }
})();
const LOAD = randomToken();
const getCookie = (name) => {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
};
const setCookie = (name, value) =>
  (document.cookie = `${name}=${encodeURIComponent(value)}; Path=${BASE}/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`);
const tokenCookie = (name) => getCookie(name) || (setCookie(name, randomToken()), getCookie(name));
const myName = () => {
  try {
    return localStorage.getItem('anni.name') || '';
  } catch {
    return '';
  }
};
const saveName = (name) => {
  try {
    localStorage.setItem('anni.name', name);
  } catch {}
};
{
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('owner')) {
    setCookie('anni_owner', p.get('owner'));
    if (p.get('name')) saveName(p.get('name'));
    history.replaceState(null, '', location.pathname + location.search);
  }
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'x-anni-tab': TAB, 'x-anni-load': LOAD }, body: body && JSON.stringify(body) });
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

/** What playback does at the end: start over, stop, or turn around. A click on the loop button steps through them. */
const LOOP_MODES = {
  loop: { label: 'Loop', icon: 'M2.5 7.5v-1a2 2 0 0 1 2-2h8M10.5 2.5l2 2-2 2M13.5 8.5v1a2 2 0 0 1-2 2h-8M5.5 13.5l-2-2 2-2' },
  once: { label: 'Play once', icon: 'M2 8h9M8 5l3 3-3 3M13.5 4v8' },
  bounce: { label: 'Back and forth', icon: 'M2.5 5.5h11M11 3l2.5 2.5L11 8M13.5 10.5h-11M5 8l-2.5 2.5L5 13' },
};
const nextLoopMode = (mode) => ({ loop: 'once', once: 'bounce', bounce: 'loop' })[mode];
function showLoopMode(btn, mode) {
  const { label, icon } = LOOP_MODES[mode];
  btn.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icon}"/></svg>`;
  btn.title = `${label} – click for ${LOOP_MODES[nextLoopMode(mode)].label.toLowerCase()}`;
  btn.setAttribute('aria-label', btn.title);
  btn.dataset.mode = mode;
}

function banner(content) {
  const el = $('#banner');
  el.replaceChildren(...(content ? [content].flat() : []));
  el.hidden = !content;
}

/* ---------- loading ---------- */

async function load({ keepTime = false } = {}) {
  const data = await api('GET', '/api/session');
  // No owner yet (a session from before access control): this browser becomes its owner.
  if (data.claimable) {
    await api('POST', '/api/claim', { token: tokenCookie('anni_owner'), name: myName() || null });
    return load({ keepTime });
  }
  if (data.closed) return showLock({ closed: true });
  if (data.locked) return showLock(data.locked);
  stopLockPoll();
  S.access = data.access || null; // hosted only: { role, editor, mode, owner, requests?, allowed? }
  S.session = data.session;
  S.hosted = !!data.hosted;
  const has = !!S.session;
  $('#empty').hidden = has;
  for (const id of ['#workspace', '#timeline']) $(id).hidden = !has;
  for (const id of ['#save', '#undo', '#redo', '#anim-select']) $(id).hidden = !has;
  if (!has) {
    $('#file').textContent = '';
    $('#dirty').hidden = true;
    if (data.hosted) renderHome(data.mcpUrl, data);
    return;
  }
  stopHome();
  if (S.session.kind === 'schema') {
    loadSchema(data);
    applyRole();
    if (S.hosted) listen();
    return;
  }
  S.schema = null;
  S.editorChanges = new Map();
  S.ehistory = [];
  S.efuture = [];
  S.fileTexts = {};
  $('#timeline').hidden = S.mode2 === 'editor';
  $('#anim-select').hidden = false;
  $('#mode').hidden = false;
  $('#view').hidden = false;
  S.model = data.model;
  S.name = S.model.animations.some((a) => a.name === S.session.animation) ? S.session.animation : S.model.animations[0].name;
  S.saved = S.session.dirty ? '' : snapshot();
  S.dirty = S.session.dirty && S.access?.editor !== false; // a watcher has nothing of its own to save
  S.sel = null;
  S.el = null;
  S.picking = false;
  S.history = [];
  S.future = [];
  if (!keepTime) {
    S.t = 0;
    S.sceneLen = 0;
  }
  S.mode = S.session.previewUrl ? 'page' : 'demo';
  $('#file').textContent = S.session.file;
  $('#file').title = S.session.file;
  banner(null);
  renderAll();
  loadPreview();
  push();
  applyRole();
  if (S.hosted) listen();
}

/* ---------- homepage (root of a hosted anni) ---------- */

const PROMPT = 'open my css animation in anni';
// mcp and http open sessions on anni.run, the product; local mode is the exception, for secrets or nothing live.
const MODE_HINTS = {
  mcp: 'On anni.run, where you can share sessions: the sidecar from npm reads and writes your files itself – their contents never pass through the model.',
  local: 'Only on your machine, for code with secrets or when nothing should go live: the editor runs on 127.0.0.1 – no session on anni.run, no sharing.',
  http: 'On anni.run without installing anything, for any Streamable HTTP client – the agent passes file contents itself.',
};
const mcpJson = (server) => JSON.stringify({ mcpServers: { anni: server } }, null, 1).replace(/\n\s*/g, ' '); // one line, spaced
/** The setup line per agent and way to connect. `json` is the mcpServers entry most other clients take. */
const installCommands = (mcpUrl) => ({
  'Claude Code': {
    mcp: 'claude mcp add anni -- npx -y anni-mcp',
    local: 'claude mcp add anni -- npx -y -p anni-mcp anni-mcp-local',
    http: `claude mcp add --transport http anni ${mcpUrl}`,
  },
  Codex: {
    mcp: 'codex mcp add anni -- npx -y anni-mcp',
    local: 'codex mcp add anni -- npx -y -p anni-mcp anni-mcp-local',
    http: `codex mcp add anni --url ${mcpUrl}`,
  },
  'Cursor & co': {
    json: true,
    mcp: mcpJson({ command: 'npx', args: ['-y', 'anni-mcp'] }),
    local: mcpJson({ command: 'npx', args: ['-y', '-p', 'anni-mcp', 'anni-mcp-local'] }),
    http: mcpJson({ url: mcpUrl }),
  },
});

/** The domain to name to an agent: this instance's, or anni.run when it runs locally (an agent can't visit 127.0.0.1). */
const publicHost = (url) => {
  const { host, hostname } = new URL(url);
  return /^(localhost|127(\.\d+){3}|\[::1\])$/.test(hostname) || hostname.endsWith('.localhost') ? 'anni.run' : host;
};

const home = { raf: 0, drift: 0, timers: [] };
function stopBoot() {
  for (const t of home.timers) clearTimeout(t);
  home.timers = [];
}
function stopHome() {
  cancelAnimationFrame(home.raf);
  cancelAnimationFrame(home.drift);
  home.raf = home.drift = 0;
  stopBoot();
  home.spy?.disconnect();
  document.querySelector('#home-nav')?.remove();
}

/** Nothing to edit here: the example loop in an editor window, a conversation with the agent above it, the install line. */
function renderHome(mcpUrl, { tokenRequired = false } = {}) {
  stopHome();
  const card = $('.empty-card');
  card.classList.add('home');
  const demo = homeDemo();
  const chat = homeChat(demo);
  const typed = h('span', {});
  const head = h(
    'div',
    { class: 'home-head' },
    h('p', { class: 'home-intro', 'aria-hidden': 'true' }, h('span', { class: 'prompt-caret' }, '>'), typed, h('i', { class: 'cursor' })),
    h(
      'div',
      { class: 'home-final' },
      h('h1', {}, 'Edit CSS animations in an editor built for it.'),
      h('p', { class: 'lede' }, 'Your agent turns values from your code into controls – animations on a timeline, styles, any literal. You tune them live, it writes them back.'),
      chat,
    ),
  );
  card.replaceChildren(head, demo, homeInstall(installCommands(mcpUrl), tokenRequired, publicHost(mcpUrl)), ...homeHow());
  for (const sec of card.querySelectorAll('.home-sec')) collapsible(sec);
  homeNav(card);
  bootHome(head, typed, demo, chat);
}

/**
 * The top bar's links: Setup (the first screen: intro, demo and setup line) and the sections. A click scrolls
 * there, opening a folded section; the part in view is marked.
 */
function homeNav(card) {
  const root = $('#empty');
  const secs = [...card.querySelectorAll('.home-sec')];
  const label = (s) => s.querySelector('h2').textContent.replace('▾', '').trim();
  const parts = [
    { name: 'Setup', els: [...card.children].filter((el) => !el.classList.contains('home-sec')), go: () => root.scrollTo({ top: 0, behavior: 'smooth' }) },
    ...secs.map((s) => {
      s.id = `s-${label(s).toLowerCase().replace(/[^a-z]+/g, '-')}`;
      return { name: label(s), els: [s], go: () => s.open() };
    }),
  ];
  const links = parts.map((p) => h('a', { href: p.els[0].id ? `#${p.els[0].id}` : '#', onclick: (e) => (e.preventDefault(), p.go()) }, p.name));
  $('.topbar .brand').after(h('nav', { id: 'home-nav', class: 'home-nav', 'aria-label': 'Sections' }, links));
  // The part crossing a band near the top of the page is the current one.
  const inView = new Set();
  home.spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) e.isIntersecting ? inView.add(e.target) : inView.delete(e.target);
      const current = parts.find((p) => p.els.some((el) => inView.has(el)));
      links.forEach((a, i) => a.classList.toggle('on', parts[i] === current));
    },
    { root, rootMargin: '-30% 0px -65% 0px' },
  );
  for (const p of parts) for (const el of p.els) home.spy.observe(el);
}

/** A section starts folded under its heading; a click on it (or Enter / Space) toggles it, and opening brings it into view. */
function collapsible(sec) {
  const h2 = sec.querySelector('h2');
  const inner = h('div', { class: 'sec-inner' });
  while (h2.nextSibling) inner.append(h2.nextSibling);
  sec.append(h('div', { class: 'sec-body' }, inner));
  const set = (closed) => {
    sec.classList.toggle('collapsed', closed);
    h2.setAttribute('aria-expanded', String(!closed));
    inner.inert = closed;
  };
  // Its unfolded height, measured before the unfolding animation runs: open for an instant without transitions.
  const unfolded = () => {
    if (!sec.classList.contains('collapsed')) return sec.offsetHeight;
    sec.classList.add('measuring');
    set(false);
    const full = sec.offsetHeight;
    set(true);
    void sec.offsetHeight;
    sec.classList.remove('measuring');
    return full;
  };
  // Opening centres the section vertically (or puts its top in view when it is taller than the page).
  sec.open = () => {
    const root = $('#empty');
    const full = unfolded();
    set(false);
    sec.style.minHeight = `${full}px`; // the page is that long at once, so the scroll can reach its target
    setTimeout(() => (sec.style.minHeight = ''), 500);
    const top = root.scrollTop + sec.getBoundingClientRect().top - root.getBoundingClientRect().top;
    // The last sections need room below them to reach the middle: the page grows a spacer for that.
    const card = sec.parentElement;
    const short = (root.clientHeight - full) / 2 - (root.scrollHeight - top - full);
    if (short > 0) card.style.paddingBottom = `${(parseFloat(card.style.paddingBottom) || 0) + short}px`;
    root.scrollTo({ top: Math.max(0, full < root.clientHeight ? top + full / 2 - root.clientHeight / 2 : top), behavior: 'smooth' });
  };
  const toggle = () => (sec.classList.contains('collapsed') ? sec.open() : set(true));
  h2.prepend(h('span', { class: 'sec-chevron', 'aria-hidden': 'true' }, '▾'));
  Object.assign(h2, { tabIndex: 0, onclick: toggle, onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle()) });
  h2.setAttribute('role', 'button');
  set(true);
}

/**
 * The intro: at first only the loop and its name, while the prompt types itself out where the heading goes and
 * is sent; the editor unfolds around the loop (timeline from below, panel from the side). Then the title fades in,
 * the typed prompt snaps down to the terminal's first line and the terminal fades in around it, the agent's reply
 * already there. A click (or reduced motion) skips straight to the end.
 */
function bootHome(head, typed, demo, chat) {
  let done = false;
  const finish = (fly) => {
    if (done) return;
    done = true;
    stopBoot();
    typed.textContent = PROMPT;
    demo.classList.add('open');
    const intro = head.querySelector('.home-intro');
    if (fly) intro.style.opacity = '1'; // it flies instead of fading out
    head.classList.add('ready');
    document.querySelector('#home-nav')?.classList.add('on');
    if (!fly) return chat.land(false, intro);
    // Fly: from where it was typed to the first line of the terminal, shrinking to its size; there it stays.
    const caret = intro.firstElementChild;
    const box = intro.getBoundingClientRect();
    const from = caret.getBoundingClientRect();
    const to = chat.first.querySelector('.term-mark').getBoundingClientRect();
    const scale = parseFloat(getComputedStyle(chat.first).fontSize) / parseFloat(getComputedStyle(intro).fontSize);
    intro.style.transformOrigin = `${from.left - box.left}px ${from.top - box.top}px`;
    caret.style.color = 'var(--muted)';
    intro.style.transform = `translate(${to.left - from.left}px, ${to.top + to.height / 2 - (from.top + (scale * from.height) / 2)}px) scale(${scale})`;
    // It stands; the terminal fades in around it, then takes it in as its first message.
    home.timers.push(setTimeout(() => (chat.classList.add('shown'), home.timers.push(setTimeout(() => chat.land(true, intro), 260))), 460));
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return finish(false);
  for (const el of [head, demo]) el.addEventListener('pointerdown', () => finish(false), { once: true });
  const at = (ms, fn) => home.timers.push(setTimeout(fn, ms));
  let t = 700;
  for (let i = 1; i <= PROMPT.length; i++) at((t += 20 + Math.random() * 25), () => (typed.textContent = PROMPT.slice(0, i)));
  at((t += 420), () => {
    head.classList.add('sent');
    demo.classList.add('open');
  });
  at((t += 850), () => finish(true));
}

/**
 * The example in an editor-like window, and a very small anni: its real keyframes as tracks. Click one to see
 * that pose and edit its values in the panel, drag it to retime, click the timeline to scrub. Open takes the
 * edits along (`demo.css()`).
 */
function homeDemo() {
  const time = h('span', { class: 'demo-time' }, '0 ms');
  const play = h('button', { class: 'demo-play', title: 'Play / pause', 'aria-label': 'Play / pause' }, '❚❚');
  const loopBtn = h('button', { class: 'demo-loop' });
  let loop = 'loop';
  showLoopMode(loopBtn, loop);
  const timing = () => (loop === 'once' ? { iterations: 1, direction: 'normal', fill: 'forwards' } : { iterations: Infinity, direction: loop === 'bounce' ? 'alternate' : 'normal', fill: 'none' });
  const reset = h('button', { class: 'demo-reset', hidden: true }, 'reset');
  const undoBtn = h('button', { title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', disabled: true }, '↶');
  const redoBtn = h('button', { title: 'Redo (Ctrl+Shift+Z)', 'aria-label': 'Redo', disabled: true }, '↷');
  const frame = h('iframe', { class: 'demo-frame', title: 'Example animation', tabindex: '-1', srcdoc: exampleDoc() });
  const tl = h('div', { class: 'demo-tl' });
  const panel = h('div', { class: 'demo-panel-in' });
  const demo = h(
    'div',
    { class: 'demo' },
    h('div', { class: 'demo-bar-wrap' }, h('div', { class: 'demo-bar' }, homeWindowControls(), play, loopBtn, h('span', { class: 'name' }, EXAMPLE_SESSION.file), h('span', { class: 'spacer' }), reset, undoBtn, redoBtn, time)),
    frame,
    h('aside', { class: 'demo-panel' }, panel),
    h('div', { class: 'demo-tl-wrap' }, tl),
  );
  let added = false; // the agent added the rectangle ("add a pulsating rectangle")
  const baseCss = () => (added ? EXAMPLE_CSS + ADDITION.css : EXAMPLE_CSS);
  demo.css = baseCss;
  // The session's files as they are now: the edited stylesheet, and the page with whatever the agent added.
  demo.files = () => EXAMPLE_SESSION.files.map((f) => ({ ...f, content: f.path === EXAMPLE_SESSION.file ? demo.css() : added ? withAddition(f.content) : f.content }));
  frame.addEventListener('load', () => {
    const doc = frame.contentDocument;
    const anims = doc.getAnimations();
    if (!anims.length) return;
    const ball = doc.querySelector('.ball');
    const dur = anims[0].effect.getComputedTiming().duration;
    const strip = ({ computedOffset, ...k }) => k;
    const tracks = anims.map((a) => ({ a, name: a.animationName, el: a.effect.target, frames: a.effect.getKeyframes().map(strip), marks: [] }));
    const original = tracks.map((t) => t.frames.map((k) => ({ ...k })));
    let sel = null; // { t, i }: the selected keyframe
    let dirty = false;
    let playing = true;
    demo.css = () => (dirty ? exampleCssWith(Object.fromEntries(tracks.map((t) => [t.name, t.frames])), baseCss()) : baseCss());

    const setPlaying = (on) => {
      playing = on;
      for (const t of tracks) on ? t.a.play() : t.a.pause();
      play.textContent = on ? '❚❚' : '▶';
    };
    // Where the pass stands (ms): 'once' plays to its end and holds there (play starts it over), 'bounce' runs
    // every other pass backwards.
    const pos = () => {
      const now = anims[0].currentTime ?? 0;
      if (loop === 'once') return Math.min(now, dur);
      if (loop === 'bounce') return dur - Math.abs((now % (2 * dur)) - dur);
      return now % dur;
    };
    loopBtn.addEventListener('click', () => {
      const at = pos();
      loop = nextLoopMode(loop);
      showLoopMode(loopBtn, loop);
      for (const t of tracks) {
        t.a.effect.updateTiming(timing());
        t.a.currentTime = at;
      }
    });
    tracks[0].a.addEventListener('finish', () => setPlaying(false));
    const seek = (p) => {
      setPlaying(false);
      for (const t of tracks) t.a.currentTime = Math.min(0.9999, Math.max(0, p)) * dur;
    };
    const apply = (t) => {
      t.a.effect.setKeyframes(t.frames);
      dirty = true;
      reset.hidden = false;
    };

    // Undo: a snapshot of every track's keyframes before each change – a whole drag, one field's typing, a reset.
    const past = [];
    const future = [];
    const snapshot = () => tracks.map((t) => t.frames.map((k) => ({ ...k })));
    const syncHistory = () => {
      undoBtn.disabled = !past.length;
      redoBtn.disabled = !future.length;
    };
    const record = () => {
      past.push(snapshot());
      if (past.length > 100) past.shift();
      future.length = 0;
      syncHistory();
    };
    const restore = (snap) => {
      tracks.forEach((t, n) => {
        if (!snap[n]) return; // a track the agent added after this step keeps its keyframes
        t.frames = snap[n].map((k) => ({ ...k }));
        t.a.effect.setKeyframes(t.frames);
      });
      dirty = JSON.stringify(snapshot()) !== JSON.stringify(original);
      reset.hidden = !dirty;
      build();
      select(sel && { t: sel.t, i: Math.min(sel.i, sel.t.frames.length - 1) });
    };
    const step = (from, to) => {
      if (!from.length) return;
      to.push(snapshot());
      restore(from.pop());
      syncHistory();
    };
    const undo = () => step(past, future);
    const redo = () => step(future, past);
    undoBtn.addEventListener('click', undo);
    redoBtn.addEventListener('click', redo);
    addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      if (!(e.ctrlKey || e.metaKey) || (key !== 'z' && key !== 'y') || !demo.isConnected || e.target.closest?.('.term')) return;
      e.preventDefault();
      key === 'y' || e.shiftKey ? redo() : undo();
    });
    const select = (s) => {
      sel = s;
      for (const t of tracks) t.marks.forEach((m, i) => m.classList.toggle('sel', !!s && s.t === t && s.i === i));
      if (s) seek(s.t.frames[s.i].offset);
      renderPanel();
    };

    // The panel: the live pose of the ball, or the selected keyframe's values as fields (one per transform function).
    const live = { y: h('dd', {}), sx: h('dd', {}), sy: h('dd', {}) };
    const field = (value, onInput, type = 'text') => {
      const input = h('input', { type, value, spellcheck: 'false', autocomplete: 'off' });
      let recorded = false; // one undo step per stretch of typing in a field
      input.addEventListener('focus', () => (recorded = false));
      input.addEventListener('input', () => {
        if (!recorded) record();
        recorded = true;
        onInput(input.value);
      });
      return input;
    };
    const renderPanel = () => {
      if (!sel) {
        panel.replaceChildren(
          h('h3', {}, 'div.ball · hop'),
          h('dl', {}, h('dt', {}, 'translateY'), live.y, h('dt', {}, 'scaleX'), live.sx, h('dt', {}, 'scaleY'), live.sy),
          h('p', { class: 'demo-tip' }, 'Click a keyframe to edit it, drag it to retime, click the timeline to scrub. The session you open takes your edits along.'),
        );
        return;
      }
      const { t, i } = sel;
      const k = t.frames[i];
      // The loop's two ends share their values in the CSS (0%, 100%): editing one edits both.
      const twin = k.offset === 0 ? t.frames.at(-1) : k.offset === 1 ? t.frames[0] : null;
      const rows = [];
      for (const [p, v] of Object.entries(k)) {
        if (KEYFRAME_META.has(p)) continue;
        const linked = twin && twin.offset !== k.offset && twin[p] === v;
        const set = (value) => {
          k[p] = value;
          if (linked) twin[p] = value;
          apply(t);
        };
        // Colours get a picker (just the colour); transforms one field per function; anything else a text field.
        if (/color$/i.test(p)) {
          const rgba = toRgba(v);
          rows.push(h('dt', {}, 'color'), field(rgba ? toHex(rgba) : '#000000', set, 'color'));
          continue;
        }
        const fns = [...String(v).matchAll(/([a-zA-Z]+)\(([^)]*)\)/g)].map((m) => ({ fn: m[1], args: m[2] }));
        if (!fns.length) rows.push(h('dt', {}, p), field(v, set));
        for (const f of fns)
          rows.push(
            h('dt', {}, f.fn),
            field(f.args, (args) => {
              f.args = args;
              set(fns.map((x) => `${x.fn}(${x.args})`).join(' '));
            }),
          );
      }
      panel.replaceChildren(h('h3', {}, `${t.name} · ${+(k.offset * 100).toFixed(1)}%`), h('p', { class: 'demo-el' }, `div.${t.el.classList[0]}`), h('dl', {}, rows));
    };

    // Drag a keyframe between its neighbours; the loop's ends stay put. The pose follows the keyframe.
    const drag = (e, t, i) => {
      e.preventDefault();
      e.stopPropagation();
      select({ t, i });
      const k = t.frames[i];
      if (k.offset === 0 || k.offset === 1) return;
      const lane = e.currentTarget.parentElement.getBoundingClientRect();
      const lo = t.frames[i - 1].offset + 0.01;
      const hi = t.frames[i + 1].offset - 0.01;
      let moved = false;
      const move = (ev) => {
        if (!moved) record();
        moved = true;
        k.offset =Math.round(Math.min(hi, Math.max(lo, (ev.clientX - lane.left) / lane.width)) * 200) / 200;
        t.marks[i].style.left = `${k.offset * 100}%`;
        t.marks[i].title = `${t.name} ${+(k.offset * 100).toFixed(1)}%`;
        apply(t);
        seek(k.offset);
        panel.querySelector('h3').textContent = `${t.name} · ${+(k.offset * 100).toFixed(1)}%`;
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    };

    const build = () => {
      tl.replaceChildren(
        ...tracks.map((t) => {
          t.marks = t.frames.map((k, i) => {
            const m = h('i', { class: `demo-kf${k.offset === 0 || k.offset === 1 ? ' end' : ''}`, style: `left: ${k.offset * 100}%`, title: `${t.name} ${+(k.offset * 100).toFixed(1)}%` });
            m.addEventListener('pointerdown', (e) => drag(e, t, i));
            return m;
          });
          return h('div', { class: 'demo-row' }, h('span', {}, t.name), h('div', { class: 'demo-lane' }, t.marks));
        }),
        h('div', { class: 'demo-playhead' }),
      );
    };
    // Scrub: press anywhere else on the timeline and drag.
    tl.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('demo-kf')) return;
      const lane = tl.querySelector('.demo-lane').getBoundingClientRect();
      const move = (ev) => seek((ev.clientX - lane.left) / lane.width);
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
      };
      select(null);
      move(e);
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
    play.addEventListener('click', () => {
      if (!playing && sel) select(null);
      setPlaying(!playing);
    });
    reset.addEventListener('click', () => {
      record();
      tracks.forEach((t, n) => {
        t.frames = original[n].map((k) => ({ ...k }));
        t.a.effect.setKeyframes(t.frames);
      });
      dirty = false;
      reset.hidden = true;
      build();
      select(null);
      setPlaying(true);
    });
    build();
    renderPanel();

    // The agent writes into the open project: the new element and its @keyframes go into the page at once, on the
    // shared clock. The returned function adds its track to the timeline – a row like the others, to click, drag
    // and edit.
    demo.add = () => {
      if (added) return;
      added = true;
      doc.head.append(h('style', {}, ADDITION.css));
      doc.querySelector('.ball').insertAdjacentHTML('beforebegin', ADDITION.html); // under the ball, like withAddition
      const a = doc.getAnimations().find((x) => !tracks.some((t) => t.a === x));
      if (!a) return;
      const sync = () => {
        a.effect.updateTiming(timing());
        a.currentTime = anims[0].currentTime;
        if (!playing) a.pause();
      };
      sync();
      // Its row comes in later, when the caller says so (once the agent's reply is done).
      return () => {
        sync();
        const t = { a, name: a.animationName, el: a.effect.target, frames: a.effect.getKeyframes().map(strip), marks: [] };
        tracks.push(t);
        original.push(t.frames.map((k) => ({ ...k })));
        build();
        select(sel);
        tl.lastElementChild.previousElementSibling.classList.add('new');
        t.marks.forEach((m, i) => m.style.setProperty('--at', t.frames[i].offset));
      };
    };

    const tick = () => {
      const t = pos();
      tl.style.setProperty('--p', t / dur);
      time.textContent = `${Math.round(t)} / ${dur} ms`;
      for (const tr of tracks) tr.marks.forEach((m, i) => m.classList.toggle('hit', playing && Math.abs(tr.frames[i].offset - t / dur) < 0.025));
      if (!sel) {
        const m = getComputedStyle(ball).transform.match(/matrix\(([^)]+)\)/)?.[1].split(',').map(Number) || [1, 0, 0, 1, 0, 0];
        live.y.textContent = `${Math.round(m[5])} px`;
        live.sx.textContent = m[0].toFixed(2);
        live.sy.textContent = m[3].toFixed(2);
      }
      home.raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(home.raf);
    home.raf = requestAnimationFrame(tick);
  });
  return demo;
}

/** A window's close / minimise / full-screen dots, as on a Mac – only for the look, they do nothing. */
function homeWindowControls() {
  const dot = (cls, glyph) => h('span', { class: cls }, h('span', {}, glyph));
  return h('span', { class: 'win', 'aria-hidden': 'true' }, dot('win-close', '×'), dot('win-min', '−'), dot('win-full', '+'));
}

/**
 * The agent's side, as a terminal conversation in one window: the message that opened the example (the intro's
 * typed prompt lands there) and its reply, which can open the session for real, then a prompt for the next one.
 * "add a pulsating rectangle" has the agent think (the dot breathes), write a new element into the open project –
 * it appears in the demo at once, as a track to edit – and stream its reply. "open in full editor" opens the session
 * in a new tab, with the edits made in the demo and what the agent added, owned by this browser.
 */
function homeChat(demo) {
  const OPEN_PROMPT = 'open in full editor';
  const log = h('div', { class: 'term-log', 'aria-live': 'polite' });
  const say = (who, ...text) => {
    const line = h('p', { class: `term-${who}` }, h('span', { class: 'term-mark', 'aria-hidden': 'true' }, who === 'user' ? '>' : '●'), h('span', {}, ...text));
    log.append(line);
    return line;
  };
  // A fake token stream: the whole reply is laid out at once (so the line doesn't grow), its words show in bursts.
  const stream = (line, parts, then) => {
    const tokens = parts.flatMap((p) => (typeof p === 'string' ? p.match(/\s*\S+\s*/g).map((w) => h('span', {}, w)) : [p]));
    for (const t of tokens) t.classList.add('tok');
    line.lastChild.replaceChildren(...tokens);
    let i = 0;
    const burst = () => {
      for (let n = 1 + Math.floor(Math.random() * 3); n && i < tokens.length; n--) tokens[i++].classList.add('on');
      if (i < tokens.length) home.timers.push(setTimeout(burst, 28 + Math.random() * 45));
      else then?.();
    };
    burst();
  };
  const think = (line, on) => line.classList.toggle('thinking', on);
  const input = h('input', { spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Message to your agent' });
  const go = h('button', { type: 'submit', title: 'Send (Enter)', 'aria-label': 'Send' }, '↵');
  let next = null; // what the next message does: add the rectangle, then open the session (null until asked, and while busy)
  // "add a pulsating rectangle" types itself into the prompt (focusing it or sending completes it);
  // "open in full editor" is just there.
  let typing = 0;
  let suggested = '';
  const typed = () => {
    clearTimeout(typing);
    typing = 0;
    input.value = input.placeholder = suggested;
  };
  input.addEventListener('focus', () => typing && typed());
  // While the agent works the prompt fades out; it comes back with the reply, the next command in it.
  const busy = (on) => {
    go.disabled = input.disabled = on;
    input.closest('form')?.classList.toggle('away', on);
  };
  const ask = (step, animated = true) => {
    next = step;
    suggested = step === 'add' ? ADD_PROMPT : OPEN_PROMPT;
    busy(false);
    if (!animated) return typed();
    input.value = input.placeholder = '';
    let i = 0;
    const key = () => {
      input.value = suggested.slice(0, ++i);
      if (i < suggested.length) home.timers.push((typing = setTimeout(key, 30 + Math.random() * 40)));
      else typed();
    };
    home.timers.push((typing = setTimeout(key, 1000))); // a beat after the terminal is there
  };

  // The session opens in a new tab; this page stays as it is, ready to open another. The tab is opened right away
  // (a popup blocker would stop one opened after the request) and pointed at the session once it exists.
  const openSession = () => {
    const tab = open('', '_blank');
    api('POST', '/api/sessions', { ...EXAMPLE_SESSION, files: demo.files(), auth: true, ownerName: myName() || undefined })
      .then((r) => {
        const url = r.token ? `${r.url}#owner=${encodeURIComponent(r.token)}` : r.url;
        if (!tab) return (location.href = url);
        tab.opener = null;
        tab.location.href = url;
      })
      .catch((err) => {
        tab?.close();
        toast(err.message);
      });
  };
  const send = (e) => {
    e.preventDefault();
    if (!next || (next === 'add' && !demo.add)) return;
    if (typing) typed();
    if (next === 'open') return openSession(); // "open in full editor": a new tab, every time
    say('user', input.value.trim() || input.placeholder);
    input.value = input.placeholder = ''; // sent: the prompt stays empty while the agent works
    next = null;
    busy(true);
    const reply = say('agent');
    think(reply, true);
    demo.classList.add('writing');
    home.timers.push(
      setTimeout(() => {
        const join = demo.add();
        demo.classList.remove('writing');
        think(reply, false);
        stream(reply, ['Put a pad under the ball – ', h('code', {}, '.rect'), ' with ', h('code', {}, '@keyframes pulse'), ', on the jump’s timing. It’s live in the editor: click its keyframes.'], () => {
          home.timers.push(setTimeout(() => join?.(), 600)); // its track joins the timeline a beat after the reply
          home.timers.push(setTimeout(() => ask('open', false), 1600)); // and the prompt a beat after that
        });
      }, 1100),
    );
  };

  const first = say('user', PROMPT);
  // The editor is already open, so its reply is there from the start; its link opens the session in a new tab.
  say('agent', `${EXAMPLE_SESSION.file} is open in anni – the loop below. `, h('button', { class: 'term-link', type: 'button', onclick: () => openSession() }, 'Open the full editor ↗'));
  const term = h(
    'div',
    { class: 'term' },
    h('div', { class: 'term-bar' }, homeWindowControls(), h('span', {}, '~/my-site')),
    log,
    h('form', { class: 'term-input', onsubmit: send }, h('label', {}, h('span', { class: 'term-mark' }, '>'), input), go),
  );
  // The intro's typed prompt arrives here and becomes the first message itself (`first` holds its place till then);
  // then the next command types itself in.
  term.first = first;
  term.land = (animated, intro) => {
    if (intro) {
      intro.querySelector('.cursor')?.remove();
      intro.removeAttribute('style');
      intro.removeAttribute('aria-hidden');
      intro.className = 'term-user';
      const caret = intro.firstElementChild;
      caret.removeAttribute('style');
      caret.className = 'term-mark';
      caret.setAttribute('aria-hidden', 'true');
      first.replaceWith(intro);
    }
    term.classList.add('shown', 'landed');
    ask('add', animated);
  };
  return term;
}

const METRICS = [
  ['100 tokens', 'few 100 tokens per session', 'The model only passes file paths. The sidecar uploads and writes the files itself, so every drag in the editor costs no tokens at all.'],
  ['0 re-prompts', 'to get the feel right', 'No more describing easing and timing to your agent in English and hoping it lands. Drag the keyframes until the motion feels right – the agent writes exactly that.'],
  ['0', 'lines touched besides your edits', 'Save rewrites only the declarations you changed – formatting, comments and the rest of the file stay as they were.'],
  ['not standalone', 'a tool for your project', 'anni is not an animation app of its own. It opens the animations that already live in your project, on your own page, and hands the result straight back to your code.'],
  ['1', 'playhead for every animation', 'Every CSS animation on the page pauses and follows one clock: scrub, step frame by frame or play, and they all move together.'],
];

/**
 * The key points as tags in a panel, each at a fixed place with a small idle sway. The cursor pulls them a
 * little as it moves through the panel, the hovered one most; hovering (or tapping) a tag shows its text below,
 * under it.
 */
function homeMetrics() {
  const caption = h('p', { class: 'metric-caption' });
  let held = null;
  // Always one tag shown: the first ("100 tokens") to begin with, then the one hovered last – it stays when the
  // pointer leaves.
  const show = (card) => {
    held = card;
    for (const c of cards) c.el.classList.toggle('on', c === held);
    caption.textContent = held.text;
    caption.classList.add('on');
    place(held);
  };
  const cards = METRICS.map(([big, unit, text], i) => {
    const card = { text, phase: i * 2.1 + 0.6, x: 0, y: 0, s: 1 };
    card.el = h('div', { class: 'metric', tabindex: '0', onpointerenter: () => show(card), onfocus: () => show(card) }, h('b', {}, big), h('span', {}, unit));
    return card;
  });
  const space = h('div', { class: 'metric-space' }, cards.map((c) => c.el));
  const panel = h('div', { class: 'metrics' }, space, h('div', { class: 'metric-below' }, caption));
  // The caption sits under the tag it explains, kept inside the panel.
  const place = (card) => {
    const w = panel.clientWidth;
    const cw = Math.min(360, w);
    const centre = card.el.offsetLeft + card.el.offsetWidth / 2;
    caption.style.width = `${cw}px`;
    caption.style.left = `${Math.max(0, Math.min(w - cw, centre - cw / 2))}px`;
  };
  const pointer = { x: 0, y: 0, in: false };
  space.addEventListener('pointermove', (e) => {
    const r = space.getBoundingClientRect();
    Object.assign(pointer, { x: e.clientX - r.left, y: e.clientY - r.top, in: true });
  });
  space.addEventListener('pointerleave', () => (pointer.in = false));
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let t = 0;
  let last = 0;
  let visible = false;
  const tick = (now) => {
    t += Math.min(50, now - (last || now)) / 1000;
    last = now;
    for (const c of cards) {
      // Where the cursor pulls the tag: towards it, fading out with distance; the hovered tag follows it most.
      let tx = 0;
      let ty = 0;
      if (pointer.in && !still) {
        const dx = pointer.x - (c.el.offsetLeft + c.el.offsetWidth / 2);
        const dy = pointer.y - (c.el.offsetTop + c.el.offsetHeight / 2);
        const near = Math.max(0, 1 - Math.hypot(dx, dy) / 320);
        const k = c === held ? 0.14 : 0.06 * near;
        tx = Math.max(-14, Math.min(14, dx * k));
        ty = Math.max(-10, Math.min(10, dy * k));
      }
      c.x += (tx - c.x) * 0.12;
      c.y += (ty - c.y) * 0.12;
      c.s += ((c === held ? 1.05 : 1) - c.s) * 0.15;
      const sway = still ? [0, 0] : [2 * Math.sin(t * 1.1 + c.phase), 3 * Math.sin(t * 0.8 + c.phase * 1.3)];
      c.el.style.transform = `translate(${(c.x + sway[0]).toFixed(1)}px, ${(c.y + sway[1]).toFixed(1)}px) scale(${c.s.toFixed(3)})`;
    }
    if (visible) home.drift = requestAnimationFrame(tick);
  };
  // Animate only while the panel is on screen.
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible) place(held); // laid out now
    cancelAnimationFrame(home.drift);
    last = 0;
    if (visible) home.drift = requestAnimationFrame(tick);
  }).observe(space);
  show(cards[0]);
  return panel;
}

// The savings estimate: what getting one animation right costs by re-prompting, against one anni session.
const SAVES = [
  { key: 'rounds', label: 'Re-prompts per animation', min: 1, max: 15, step: 1, value: 4, fmt: (v) => `${v}×` },
  { key: 'tokens', label: 'Tokens per re-prompt', min: 1000, max: 50000, step: 500, value: 6000, fmt: (v) => v.toLocaleString('en-US') },
  { key: 'minutes', label: 'Minutes per re-prompt', min: 0.5, max: 10, step: 0.5, value: 3, fmt: (v) => `${v} min` },
];
const ANNI_TOKENS = 400; // a whole session: the agent passes a path and reads back a short diff

/** What it saves: sliders for how re-prompting goes for you, the tokens and time that anni saves per animation. */
function homeSaves() {
  const v = Object.fromEntries(SAVES.map((f) => [f.key, f.value]));
  const tokens = h('b', {});
  const time = h('b', {});
  const barWithout = h('i', { class: 'bar-without' });
  const barWith = h('i', { class: 'bar-with' });
  const withoutN = h('em', {});
  const fields = SAVES.map((f) => {
    const out = h('output', {}, f.fmt(f.value));
    const input = h('input', { type: 'range', min: f.min, max: f.max, step: f.step, value: f.value, 'aria-label': f.label });
    input.addEventListener('input', () => {
      v[f.key] = +input.value;
      out.textContent = f.fmt(v[f.key]);
      update();
    });
    return h('label', { class: 'saves-field' }, h('span', {}, h('span', {}, f.label), out), input);
  });
  const update = () => {
    const without = v.rounds * v.tokens;
    tokens.textContent = Math.max(0, without - ANNI_TOKENS).toLocaleString('en-US');
    const min = v.rounds * v.minutes;
    time.textContent = min >= 60 ? `${(min / 60).toFixed(1)} h` : `${min} min`;
    withoutN.textContent = without.toLocaleString('en-US');
    barWithout.style.width = '100%';
    barWith.style.width = `${Math.max(1, (ANNI_TOKENS / without) * 100)}%`;
  };
  update();
  return h(
    'section',
    { class: 'saves home-sec late' },
    h('h2', {}, 'What it saves'),
    h(
      'div',
      { class: 'saves-panel' },
      h('div', { class: 'saves-inputs' }, fields),
      h(
        'div',
        { class: 'saves-out' },
        h('div', { class: 'saves-big' }, tokens, h('span', {}, 'tokens saved per animation')),
        h('div', { class: 'saves-big' }, time, h('span', {}, 'of prompting and waiting saved')),
        h(
          'div',
          { class: 'saves-bars' },
          h('div', {}, h('span', {}, 'Re-prompting ', withoutN), h('div', { class: 'saves-track' }, barWithout)),
          h('div', {}, h('span', {}, `anni ~${ANNI_TOKENS}`), h('div', { class: 'saves-track' }, barWith)),
        ),
      ),
    ),
    h('p', { class: 'muted saves-note' }, 'Estimates – set the sliders to how your agent and project behave. A whole anni session costs a few hundred tokens: the agent passes a path and reads back a short diff.'),
  );
}

/** The sections after Setup: the key points, what it saves, the pipeline with its steps, where the files live. */
function homeHow() {
  const c = (s) => h('code', {}, s);
  const step = (n, title, ...body) => h('li', { class: 'how-fact' }, h('h3', {}, h('span', { class: 'how-n' }, n), title), h('p', {}, ...body));
  const node = (name, where) => h('div', { class: 'flow-node' }, h('b', {}, name), h('span', {}, where));
  const edge = (via, what) => h('div', { class: 'flow-edge' }, h('span', {}, via), h('span', {}, what));
  const fact = (title, ...body) => h('div', { class: 'how-fact' }, h('h3', {}, title), h('p', {}, ...body));
  return [
    h('section', { class: 'how home-sec late' }, h('h2', {}, 'What about it'), homeMetrics()),
    homeSaves(),
    h(
      'section',
      { class: 'pipeline home-sec late' },
      h('h2', {}, 'Pipeline'),
      h(
        'div',
        { class: 'flow', 'aria-label': 'Data flow' },
        node('agent', 'Claude Code, Codex …'),
        edge('MCP', 'file path'),
        node('anni-mcp', 'sidecar, your machine'),
        edge('HTTPS', 'files'),
        node('session', 'Durable Object'),
        edge('SSE', 'live edits'),
        node('editor', '<id>.anni.run'),
      ),
      h(
        'ol',
        { class: 'how-steps' },
        step('01', 'Your agent opens it', 'Over MCP your agent calls ', c('open_animation'), ' with a file path. The sidecar on your machine reads the stylesheet, the page that links it and its assets, and uploads them into a new session. File contents never pass through the model – a whole session costs a few hundred tokens.'),
        step('02', 'You tune it on the real page', 'The editor loads your page in a frame and pauses every CSS animation on it with the Web Animations API; the playhead drives them all. Keyframes, timing, easing and styles preview live while you drag.'),
        step('03', 'Save writes it back', 'Save sends the edited file to the agent, which is waiting in ', c('wait_for_save'), '. The sidecar writes only the changed declarations to disk and hands the agent a short diff – the rest of the file stays untouched.'),
      ),
    ),
    h(
      'section',
      { class: 'files home-sec late' },
      h('h2', {}, 'Where your files live'),
      h(
        'div',
        { class: 'how-facts' },
        fact('One Durable Object per session', 'anni runs on a Cloudflare Worker. Every session is its own Durable Object with its own SQLite-backed storage: the uploaded files, the live state of the editor, the open tabs and the agent waiting for a save. Nothing is shared between sessions, and there are no accounts.'),
        fact('Its own origin', 'Each session is served from its own subdomain, ', c('<id>.anni.run'), ', with an unguessable id – an uploaded page can’t script another session. Session pages are never cached or indexed.'),
        fact('Yours, by token', 'The agent’s link carries an owner token in the ', c('#fragment'), ', which browsers never send to a server; the session stores only its SHA-256. Others with the link ask for access, unless you make the session public or lock it. Only you edit.'),
        fact('Gone after 7 days', 'Every open and save pushes an alarm out; 7 days after the last activity the session deletes everything it stored – except the shared example, ', c(`${EXAMPLE_ID}.anni.run`), ', which stays. Closing a session deletes it right away. Uploads are capped at 1.5 MB per file and 24 MB per session.'),
        fact('Or not on Cloudflare at all', 'Local mode runs the same editor on ', c('127.0.0.1'), ' – nothing leaves your machine. Or deploy your own instance with ', c('wrangler deploy'), ' and require a token with ', c('ANNI_TOKEN'), '.'),
      ),
    ),
    h('section', { class: 'pricing home-sec late' }, h('h2', {}, 'Pricing'), h('p', { class: 'pricing-line' }, 'you really thought i would take money for my passion? ', h('span', { class: 'pricing-heart' }, '<3'))),
  ];
}

/** Setup: pick the agent and the way to connect, get one line; a click on the line copies it. */
/**
 * Setup: one line to tell the agent – coding agents set up anni.run on their own from it (anni.run's page and
 * llms.txt tell them how) – and, folded, the setup line per agent and way to connect.
 */
function homeInstall(agents, tokenRequired, host) {
  const stored = (key, fallback, ok) => {
    try {
      const v = localStorage.getItem(key);
      return ok(v) ? v : fallback;
    } catch {
      return fallback;
    }
  };
  let agent = stored('anni.agent', 'Claude Code', (v) => v in agents);
  let mode = stored('anni.install', 'mcp', (v) => v in MODE_HINTS);
  const COPY_ICON = '<svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="4.5" y="4.5" width="8.5" height="8.5"/><path d="M9.5 2.5V1H1v8.5h1.5"/></svg>';
  // A line that copies its text on a click and says so.
  const copyLine = (lead, code, text) => {
    const state = h('span', { class: 'copy-state', 'aria-label': 'Copy' });
    state.innerHTML = COPY_ICON;
    const line = h('button', { class: 'cmdline', title: 'Click to copy' }, lead, code, state);
    line.addEventListener('click', () =>
      navigator.clipboard.writeText(text()).then(
        () => {
          line.classList.add('copied');
          state.textContent = 'Copied';
          clearTimeout(line.t);
          line.t = setTimeout(() => {
            line.classList.remove('copied');
            state.innerHTML = COPY_ICON;
          }, 1600);
        },
        () => toast('Could not copy – select the text instead'),
      ),
    );
    return line;
  };
  // What to tell the agent, per way to connect – it reads the rest on the site (llms.txt) and sets it up.
  const asks = {
    mcp: [`open my css animation in ${host}`, 'It sets anni up on its own and opens your animation.'],
    local: [`set up ${host} but open my css animation locally`, 'It sets anni up and opens your animation only on your machine.'],
    http: [`open my css animation in ${host} without installing anything`, 'It opens your animation without installing anything.'],
  };
  const askCode = h('code', { class: 'ask' });
  const askHint = h('p', { class: 'muted install-hint' });
  const prompt = copyLine(h('span', { class: 'prompt-caret' }, '>'), askCode, () => asks[mode][0]);

  const code = h('code', {});
  const hint = h('p', { class: 'muted install-hint' });
  const dollar = h('span', { class: 'dollar' }, '$');
  const tabs = (items, pick) => h('div', { class: 'seg', role: 'tablist' }, ...items.map((v) => h('button', { 'data-v': v, role: 'tab', onclick: () => pick(v) }, v)));
  const agentSeg = tabs(Object.keys(agents), (v) => set(v, mode));
  const modeSeg = tabs(Object.keys(MODE_HINTS), (v) => set(agent, v));
  const askSeg = tabs(Object.keys(MODE_HINTS), (v) => set(agent, v)); // the same choice, above the fold
  const line = copyLine(dollar, code, () => agents[agent][mode]);
  const set = (a, m) => {
    agent = a;
    mode = m;
    try {
      localStorage.setItem('anni.agent', a);
      localStorage.setItem('anni.install', m);
    } catch {}
    for (const b of agentSeg.children) b.classList.toggle('on', b.dataset.v === a);
    for (const b of [...modeSeg.children, ...askSeg.children]) b.classList.toggle('on', b.dataset.v === m);
    [askCode.textContent, askHint.textContent] = asks[m];
    const json = agents[a].json;
    dollar.hidden = !!json;
    code.textContent = agents[a][m];
    hint.textContent = (json ? 'Add it to your client’s MCP config (mcpServers). ' : '') + MODE_HINTS[m] + (tokenRequired && m === 'http' ? ' This instance requires a token (ANNI_TOKEN).' : '');
  };
  set(agent, mode);
  return h(
    'div',
    { class: 'setup late' },
    h('div', { class: 'setup-head' }, h('h2', {}, 'Setup')),
    h('p', { class: 'ask-label' }, 'Tell your agent'),
    h('div', { class: 'install' }, askSeg, prompt),
    askHint,
    h('p', { class: 'muted install-hint' }, 'By setting it up, you agree to the ', h('a', { href: '/terms' }, 'terms of use'), '.'),
    h('details', { class: 'setup-more' }, h('summary', {}, 'Manual setup'), h('div', { class: 'setup-head' }, agentSeg), h('div', { class: 'install' }, modeSeg, line), hint),
  );
}

/* ---------- access: lock screen, roles, requests, watching (hosted only) ---------- */

const MODE_INFO = {
  public: { label: 'Public', hint: 'Anyone with the link can watch' },
  request: { label: 'Request', hint: 'People ask, you let them in' },
  locked: { label: 'Locked', hint: 'No new people – only you and who you let in' },
};
const LOCK_ICON = '<svg viewBox="0 0 12 14" width="11" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="1" y="6" width="10" height="7" rx="1"/><path d="M3.3 6V4.2a2.7 2.7 0 0 1 5.4 0V6"/></svg>';
const OPEN_ICON = '<svg viewBox="0 0 12 14" width="11" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="1" y="6" width="10" height="7" rx="1"/><path d="M3.3 6V4.2a2.7 2.7 0 0 1 5.3-.6"/></svg>';

let lockPoll = 0;
function stopLockPoll() {
  clearInterval(lockPoll);
  lockPoll = 0;
}

/** A browser without access: what it may do depends on the mode. The page checks back every few seconds. */
function showLock(lock) {
  if (lock.closed) { S.dirty = false; document.title = 'anni'; } // nothing left to save or lose
  S.session = null;
  S.model = null;
  S.access = null;
  events?.close();
  events = null;
  for (const id of ['#workspace', '#timeline', '#save', '#undo', '#redo', '#anim-select', '#view', '#access', '#dirty']) $(id).hidden = true;
  $('#file').textContent = '';
  banner(null);
  accessBar(null);
  $('#empty').hidden = false;
  stopHome();
  const owner = lock.owner || 'the person who shared it';
  const logo = h('img', { class: 'logo big', src: 'brand/anni-logo.png', alt: 'anni' });
  const card = $('.empty-card');
  card.classList.remove('home');
  if (lock.closed) {
    card.replaceChildren(logo, h('h1', {}, 'This session was closed'), h('p', {}, 'Everything in it was deleted.'), h('p', { class: 'muted' }, 'To go on, ask your agent to open the animation in anni again – that starts a new session.'));
  } else if (lock.mode === 'locked') {
    card.replaceChildren(logo, h('h1', {}, 'This session is locked'), h('p', {}, `Only ${owner} can open it right now.`), h('p', { class: 'muted' }, `If you need it, ask ${lock.owner || 'them'} directly to switch it to “Request” or “Public”.`));
  } else if (lock.request === 'pending') {
    card.replaceChildren(logo, h('h1', {}, 'Request sent'), h('p', {}, `Waiting for ${owner} to let you in.`), h('p', { class: 'muted' }, 'This page opens by itself once you are in.'));
  } else if (lock.request === 'denied') {
    card.replaceChildren(logo, h('h1', {}, 'Request declined'), h('p', {}, `${lock.owner || 'The owner'} didn’t let you in. Ask them directly if that was a mistake.`));
  } else {
    const name = h('input', { value: myName(), placeholder: 'Your name', maxlength: 60, spellcheck: 'false' });
    const note = h('input', { placeholder: 'Message (optional)', maxlength: 280 });
    const send = async () => {
      if (!name.value.trim()) return name.focus();
      saveName(name.value.trim());
      tokenCookie('anni_guest');
      try {
        await api('POST', '/api/request', { name: name.value.trim(), note: note.value.trim() });
        showLock({ ...lock, request: 'pending' });
      } catch (e) {
        toast(e.message);
      }
    };
    card.replaceChildren(
      logo,
      h('h1', {}, 'This session is private'),
      h('p', {}, `It belongs to ${owner}. Ask for access to watch it.`),
      h('div', { class: 'lock-form', onkeydown: (e) => e.key === 'Enter' && send() }, name, note, h('button', { class: 'chrome-btn', onclick: send }, 'Request access')),
    );
  }
  if (!lockPoll && !lock.closed) {
    lockPoll = setInterval(async () => {
      try {
        const d = await api('GET', '/api/session');
        if (!d.locked) return load();
        if (d.locked.mode !== lock.mode || d.locked.request !== lock.request) showLock(d.locked);
      } catch {}
    }, 4000);
  }
}

/** Editing rights: only the owner, from one tab. Everybody else watches – the inspector takes no input. */
function applyRole() {
  const a = S.access;
  S.readonly = !!a && !a.editor;
  document.body.classList.toggle('readonly', S.readonly);
  if (S.readonly) S.dirty = false; // a watcher has nothing of its own to save
  for (const id of ['#save', '#undo', '#redo']) $(id).hidden = !S.session || S.readonly;
  showSaveState();
  const btn = $('#access');
  btn.hidden = a?.role !== 'owner';
  const fork = S.session?.forkOf;
  const exp = $('#export');
  exp.hidden = !(fork && a?.editor);
  if (fork) exp.title = `Send your changes to ${fork.owner || 'the original session'} and download them as a file a coding agent can apply`;
  if (!a) return accessBar(null);
  if (a.role === 'owner') {
    const n = a.requests?.length || 0;
    btn.innerHTML = `${a.mode === 'public' ? OPEN_ICON : LOCK_ICON}<span>${MODE_INFO[a.mode].label}</span>${n ? `<b class="count">${n}</b>` : ''}`;
    btn.classList.toggle('alert', n > 0);
    if ($('#access-pop')) renderAccessPop();
  }
  if (a.role === 'viewer') {
    accessBar([h('span', {}, `View only – ${a.owner || 'the owner'} edits this session. To change something, edit your own copy.`), h('button', { class: 'primary', onclick: editCopy }, 'Edit a copy')]);
  } else if (!a.editor) {
    accessBar([h('span', {}, 'This session is being edited in another tab.'), h('button', { onclick: takeOver }, 'Edit here')]);
  } else if (a.requests?.length) {
    const r = a.requests[0];
    const more = a.requests.length - 1;
    accessBar([
      h('span', {}, h('b', {}, r.name), ` asks to watch${r.note ? `: “${r.note}”` : ''}${more ? ` · ${more} more` : ''}`),
      h('button', { class: 'primary', onclick: () => answer(r.id, true) }, 'Allow'),
      h('button', { onclick: () => answer(r.id, false) }, 'Decline'),
      more ? h('button', { class: 'ghost', onclick: () => toggleAccessPop(true) }, 'All requests') : null,
    ]);
  } else if (a.proposals?.some((p) => !p.read)) {
    const fresh = a.proposals.filter((p) => !p.read);
    const p = fresh[0];
    accessBar([
      h('span', {}, h('b', {}, p.author), ` exported changes from their copy: ${p.summary}${fresh.length > 1 ? ` · ${fresh.length - 1} more` : ''}`),
      h('button', { class: 'primary', onclick: () => viewProposal(p.id) }, 'View'),
      fresh.length > 1 ? h('button', { class: 'ghost', onclick: () => toggleAccessPop(true) }, 'All') : null,
    ]);
  } else accessBar(null);
}

/* Exported changes. A copy's owner exports: their change set goes to this session's owner as a proposal and
   comes back to them as a file. Either way it is a .anni.md a coding agent can apply (get_proposals reads them too). */

function downloadText(text, name) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/markdown' })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
}
const changesFileName = (file, at) => `${String(file || 'changes').split('/').pop().replace(/\.[^.]+$/, '')}-${new Date(at).toISOString().slice(0, 16).replace(/[-:T]/g, '')}.anni.md`;

async function exportChanges() {
  try {
    if (S.dirty) await saveNow(); // the export is made from the saved state
    const r = await api('POST', '/api/export', {});
    downloadText(r.markdown, changesFileName(r.file, r.at));
    toast(r.count ? `Exported ${r.summary}${r.delivered ? ` – sent to ${r.owner || 'the original session'} and downloaded` : ' – downloaded'}` : 'Nothing changed yet – exported an empty change set');
  } catch (e) {
    toast(e.message);
  }
}
$('#export').onclick = exportChanges;

/**
 * Closing deletes the session for good (files, access, proposals; the owner's files on disk stay). The owner
 * confirms – and is told about work that hasn't reached the code: unsaved edits, or a save no agent picked up.
 */
function confirmClose() {
  toggleAccessPop(false);
  $('#close-overlay')?.remove();
  const a = S.access || {};
  const close = () => $('#close-overlay')?.remove();
  const warnings = [];
  if (S.dirty) {
    warnings.push(h('li', {}, 'You have unsaved edits – closing throws them away. ', h('button', { onclick: async () => (await saveNow(), confirmClose()) }, 'Save first')));
  }
  if ((a.rev || 0) > (a.deliveredRev || 0)) {
    const schema = S.session?.kind === 'schema';
    warnings.push(
      h(
        'li',
        {},
        `Your last save (revision ${a.rev}) hasn’t reached your code yet – no agent picked it up. `,
        schema ? 'Ask your agent to call wait_for_changes before you close.' : h('button', { onclick: downloadSaved }, 'Download the file'),
      ),
    );
  }
  const doClose = async () => {
    try {
      await api('POST', '/api/close', {});
      close();
      showLock({ closed: true });
    } catch (e) {
      toast(e.message);
    }
  };
  document.body.append(
    h(
      'div',
      { class: 'keys-backdrop', id: 'close-overlay', onclick: (e) => e.target === e.currentTarget && close() },
      h(
        'div',
        { class: 'keys-panel close-panel', role: 'alertdialog', 'aria-label': 'Close the session' },
        h('h2', {}, 'Close this session?'),
        h('p', {}, 'You’re about to close the session. This can’t be undone, but you can always start it in a new session.'),
        h('p', { class: 'muted' }, 'Everything stored for it is deleted – the files, who has access, exported changes. Your own files on disk stay as they are.'),
        warnings.length ? h('ul', { class: 'close-warnings' }, warnings) : null,
        h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { onclick: close }, 'Cancel'), h('button', { class: 'danger-solid', onclick: doClose }, 'Close session')),
      ),
    ),
  );
}

/** The edited file as last saved in the session, for when no agent has picked it up. */
async function downloadSaved() {
  const file = S.session?.file;
  if (!file) return;
  const res = await fetch(`${BASE}/site/${file.split('/').map(encodeURIComponent).join('/')}`);
  downloadText((await res.text()).replace(/ data-anni-src="\d+"/g, ''), file.split('/').pop()); // without the editor's style tags
}

/** The owner reads a proposal: the brief the coding agent gets, to copy, download or dismiss. */
async function viewProposal(id) {
  toggleAccessPop(false);
  let p;
  try {
    p = await api('GET', `/api/proposal?id=${encodeURIComponent(id)}`);
  } catch (e) {
    return toast(e.message);
  }
  const close = () => $('#proposal-overlay')?.remove();
  const behind = p.rev > p.baseRev ? ` · the session has been saved ${p.rev - p.baseRev}× since – the agent checks for conflicts` : '';
  $('#proposal-overlay')?.remove();
  document.body.append(
    h(
      'div',
      { class: 'keys-backdrop', id: 'proposal-overlay', onclick: (e) => e.target === e.currentTarget && close() },
      h(
        'div',
        { class: 'keys-panel proposal-panel', role: 'dialog', 'aria-label': `Changes from ${p.author}` },
        h(
          'header',
          {},
          h('h2', {}, `Changes from ${p.author}`),
          h('span', { class: 'muted small' }, `based on revision ${p.baseRev}${behind}`),
          h('span', { class: 'spacer' }),
          h('button', { onclick: () => navigator.clipboard.writeText(p.markdown).then(() => toast('Copied – paste it to your coding agent')) }, 'Copy'),
          h('button', { onclick: () => downloadText(p.markdown, changesFileName(S.session?.file, p.at)) }, 'Download'),
          p.url ? h('a', { class: 'btn', href: p.url, target: '_blank', rel: 'noopener', title: 'Their copy – it may ask you for access' }, 'Open their copy') : null,
          h('button', { class: 'danger', onclick: () => (close(), ownerAction('/api/proposal/dismiss', { id })) }, 'Dismiss'),
          h('button', { class: 'ghost', title: 'Close (Esc)', onclick: close }, '×'),
        ),
        h('p', { class: 'proposal-hint' }, 'Give this to your coding agent – e.g. “apply these changes but keep my shaking animation”. With anni connected it can also read it itself (get_proposals).'),
        h('pre', { class: 'proposal-md' }, p.markdown),
      ),
    ),
  );
}

function accessBar(content) {
  const el = $('#access-bar');
  el.replaceChildren(...(content ? [content].flat().filter(Boolean) : []));
  el.hidden = !content;
}

async function ownerAction(path, body) {
  try {
    const r = await api('POST', path, body);
    if (r.access) S.access = r.access;
    applyRole();
  } catch (e) {
    toast(e.message);
  }
}
const answer = (guest, allow) => ownerAction('/api/answer', { guest, allow });

/** The owner's access menu: mode, open requests, who has access, own name, share link. */
function renderAccessPop() {
  const a = S.access;
  const pop = $('#access-pop');
  if (!pop || !a) return;
  const shareLink = `${location.origin}${BASE}/`;
  const person = (g, actions) => h('li', {}, h('span', { class: 'who' }, g.name, g.note ? h('span', { class: 'muted' }, ` – “${g.note}”`) : null), ...actions);
  const nameInput = h('input', { value: a.owner || myName(), placeholder: 'Your name', maxlength: 60, onchange: (e) => (saveName(e.target.value.trim()), ownerAction('/api/name', { name: e.target.value.trim() })) });
  const parts = [
    h('h3', {}, 'Who can open the link'),
    h(
      'div',
      { class: 'modes' },
      Object.entries(MODE_INFO).map(([mode, info]) =>
        h('button', { class: `mode${a.mode === mode ? ' on' : ''}`, onclick: () => ownerAction('/api/access', { mode }) }, h('b', {}, info.label), h('span', {}, info.hint)),
      ),
    ),
    a.requests?.length
      ? h('section', {}, h('h3', {}, 'Requests'), h('ul', {}, a.requests.map((g) => person(g, [h('button', { class: 'primary', onclick: () => answer(g.id, true) }, 'Allow'), h('button', { onclick: () => answer(g.id, false) }, 'Decline')]))))
      : null,
    a.proposals?.length
      ? h(
          'section',
          {},
          h('h3', {}, 'Exported from copies'),
          h(
            'ul',
            {},
            a.proposals.map((p) =>
              h(
                'li',
                { class: p.read ? '' : 'unread' },
                h('span', { class: 'who', title: p.summary }, p.author, h('span', { class: 'muted' }, ` – ${p.summary}`)),
                h('button', { class: p.read ? '' : 'primary', onclick: () => viewProposal(p.id) }, 'View'),
              ),
            ),
          ),
        )
      : null,
    h(
      'section',
      {},
      h('h3', {}, 'Can watch'),
      a.mode === 'public' ? h('p', { class: 'muted' }, 'Everyone with the link, while the session is public.') : null,
      a.allowed?.length ? h('ul', {}, a.allowed.map((g) => person(g, [h('button', { onclick: () => ownerAction('/api/revoke', { guest: g.id }) }, 'Remove')]))) : a.mode !== 'public' ? h('p', { class: 'muted' }, 'Nobody else yet.') : null,
    ),
    h('section', {}, h('h3', {}, 'You'), h('label', { class: 'field' }, h('span', {}, 'Name'), nameInput), h('p', { class: 'muted' }, 'Shown to people who ask for access. Only you can edit; others watch and can edit a copy.')),
    h('button', { class: 'chrome-btn share', onclick: () => navigator.clipboard.writeText(shareLink).then(() => toast('Link copied – people have to ask for access unless the session is public')) }, 'Copy link'),
    h('button', { class: 'danger close-session', onclick: confirmClose }, 'Close session …'),
  ];
  pop.replaceChildren(...parts.filter(Boolean)); // replaceChildren would print a null as "null"
}

function toggleAccessPop(open = !$('#access-pop')) {
  $('#access-pop')?.remove();
  if (!open || S.access?.role !== 'owner') return;
  const r = $('#access').getBoundingClientRect();
  const pop = h('div', { class: 'access-pop', id: 'access-pop', style: `top:${r.bottom + 6}px;right:${Math.max(8, innerWidth - r.right)}px` });
  document.body.append(pop);
  renderAccessPop();
}
$('#access').onclick = () => toggleAccessPop();
document.addEventListener('pointerdown', (e) => {
  if ($('#access-pop') && !e.target.closest('#access-pop, #access')) toggleAccessPop(false);
});

/** Watchers: a new session with the same files, owned by this browser, opens in place of this one. */
async function editCopy() {
  try {
    const name = myName();
    const r = await api('POST', '/api/fork', { name: name || null });
    location.href = `${r.url}#owner=${encodeURIComponent(r.token)}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
  } catch (e) {
    toast(e.message);
  }
}

// A closing or reloading tab says goodbye, so the owner's next tab can edit right away.
addEventListener('pagehide', () => {
  if (S.hosted && S.access) navigator.sendBeacon(`${BASE}/api/bye?tab=${TAB}&load=${LOAD}`);
});
// The editing tab's heartbeat (the server gives editing to another owner tab after 15 s of silence); the
// owner's other tabs check whether they can take over.
setInterval(() => {
  if (!S.session || S.access?.role !== 'owner') return;
  if (S.access.editor) api('POST', '/api/alive', {}).then((r) => r.editor === false && refreshAccess()).catch(() => {});
  else refreshAccess().catch(() => {});
}, 5000);

async function takeOver() {
  await api('POST', '/api/take', {});
  load({ keepTime: true });
}

/** Mode, requests or the editing tab changed. */
async function refreshAccess() {
  const d = await api('GET', '/api/session');
  if (d.locked) return showLock(d.locked);
  if (!S.session) return load();
  const wasEditor = S.access?.editor;
  S.access = d.access || null;
  if (wasEditor === false && S.access?.editor) return load({ keepTime: true }); // this tab edits now: start from the server's state
  applyRole();
}

/**
 * Watching tabs follow the editing tab's live state. The session pushes it (model and CSS, rendered once for all
 * watchers); only when it was too large to push does the tab fetch it.
 */
let following = false;
async function followLiveState(pushed) {
  if (!S.readonly) return;
  if (pushed?.values && S.schema) {
    S.values = { ...pushed.values };
    renderSchemaPanel();
    return applySchemaPreview();
  }
  if (pushed?.animations && S.model) {
    if (JSON.stringify(pushed.animations) !== snapshot()) {
      S.model = { ...S.model, animations: pushed.animations };
      if (!anim()) S.name = S.model.animations[0].name;
      if (S.sel && anim().keyframes[S.sel.bi]?.offsets[S.sel.oi] === undefined) S.sel = null;
      renderAll();
    }
    pushSeq++; // a render still on its way is older than this
    S.css = pushed.css;
    return applyCss();
  }
  if (following) return;
  following = true;
  try {
    const d = await api('GET', '/api/session');
    if (d.locked) return showLock(d.locked);
    if (S.schema && d.values) {
      S.values = { ...d.values };
      renderSchemaPanel();
      applySchemaPreview();
    } else if (d.model && S.model && JSON.stringify(d.model.animations) !== snapshot()) {
      S.model = d.model;
      if (!anim()) S.name = S.model.animations[0].name;
      if (S.sel && anim().keyframes[S.sel.bi]?.offsets[S.sel.oi] === undefined) S.sel = null;
      renderAll();
      push();
    }
  } finally {
    following = false;
  }
}

// Watchers can look, scrub and select, but no field, button or slider of the panel takes input.
for (const type of ['pointerdown', 'click', 'keydown', 'beforeinput', 'input', 'change']) {
  $('#inspector').addEventListener(
    type,
    (e) => {
      if (!S.readonly) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
}

/* ---------- schema sessions: controls the agent described, with live preview wires ---------- */

function loadSchema(data) {
  S.model = null;
  S.schema = data.schema;
  S.values = { ...data.values };
  S.dirty = S.session.dirty && S.access?.editor !== false; // a watcher has nothing of its own to save
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
  $('#view').hidden = true;
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
  showSaveState();
  $('#undo').disabled = !S.vhistory.length;
  $('#redo').disabled = !S.vfuture.length;
  document.title = `${S.dirty ? '● ' : ''}${S.session.title} · anni`;
}

const controlsOf = () => S.schema.groups.flatMap((g) => g.controls);

/**
 * Whether two CSS values mean the same, so a control dragged back to where it started counts as unchanged:
 * `8px` = `8.0px`, `#fff` = `white` = `rgb(255, 255, 255)`, spacing and case don't matter.
 */
function sameValue(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const x = String(a).trim().replace(/\s+/g, ' ');
  const y = String(b).trim().replace(/\s+/g, ' ');
  if (x.toLowerCase() === y.toLowerCase()) return true;
  const tx = parseTokens(x);
  const ty = parseTokens(y);
  // Numbers match within half a percent: a slider snaps to its step and can't land exactly on an
  // in-between value it started from (opacity 0.998 → 1).
  const near = (p, q) => Math.abs(p - q) <= Math.max(0.005, 0.005 * Math.max(Math.abs(p), Math.abs(q)));
  if (tx && ty) return tx.length === ty.length && tx.every((t, i) => near(t.n, ty[i].n) && t.unit === ty[i].unit);
  const cx = toRgba(x);
  const cy = cx && toRgba(y);
  return !!(cx && cy) && ['r', 'g', 'b'].every((k) => Math.round(cx[k]) === Math.round(cy[k])) && Math.abs(cx.a - cy.a) < 0.005;
}
const sameValues = (a, b) => !!a && !!b && Object.keys(a).every((k) => sameValue(a[k], b[k]));

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
  S.dirty = !sameValues(S.values, S.savedValues);
  applySchemaPreview();
  renderSchemaHeader();
  for (const row of document.querySelectorAll('#inspector .prop[data-id]')) row.classList.toggle('changed', !S.savedValues || !sameValue(S.values[row.dataset.id], S.savedValues[row.dataset.id]));
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
    reloadIfUpdated();
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
  if (c.type === 'tokens') {
    const toks = parseTokens(value);
    if (!toks) return raw();
    const fields = toks.map((tok) => numField(tok, tok.unit ? [...new Set([tok.unit, ...LENGTH])] : null, undefined, false, () => set(fmtTokens(toks))));
    return h('div', { class: 'editor' }, fields.map((f) => f.num));
  }
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
          const changed = !S.savedValues || !sameValue(value, S.savedValues[c.id]);
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

/**
 * Timing a rule leaves to others (a shared `.stage * { animation-duration: 4s }`, a utility class, a custom
 * property) parses as CSS initial values – 0s, 1 iteration. The page knows the real ones: read them off an
 * element running the animation and keep them as `timingBase`, so the editor shows the truth and saving
 * writes only what the user actually changed.
 */
function resolveLiveTiming() {
  const doc = frame.contentDocument;
  if (!S.model || !doc?.getAnimations) return;
  const wasClean = !S.dirty;
  let changed = false;
  for (const a of S.model.animations) {
    const missing = a.usage?.missing;
    if (!missing?.length || a.timingBase) continue;
    const x = doc.getAnimations().find((y) => y.animationName === a.name && y.effect?.target);
    if (!x) continue;
    const cs = doc.defaultView.getComputedStyle(x.effect.target, x.effect.pseudoElement || null);
    const names = splitTop(cs.animationName, ',');
    const i = Math.max(0, names.indexOf(a.name));
    const pick = (prop) => {
      const list = splitTop(cs.getPropertyValue(prop), ',');
      return list.length ? list[i % list.length].trim() : '';
    };
    const ms = (v) => (/ms$/i.test(v) ? parseFloat(v) : parseFloat(v) * 1000);
    const live = {
      duration: ms(pick('animation-duration')),
      delay: ms(pick('animation-delay')),
      easing: pick('animation-timing-function'),
      iterations: pick('animation-iteration-count'),
      direction: pick('animation-direction'),
      fill: pick('animation-fill-mode'),
    };
    for (const k of missing) if (live[k] !== '' && !Number.isNaN(live[k])) a.timing[k] = typeof live[k] === 'number' ? Math.round(live[k]) : live[k];
    a.timingBase = { ...a.timing };
    changed = true;
  }
  if (!changed) return;
  if (wasClean) {
    S.saved = snapshot();
    S.dirty = false;
  }
  renderAll();
  push();
}

const TIMING_LABELS = { duration: 'duration', delay: 'delay', easing: 'easing', iterations: 'iterations', direction: 'direction', fill: 'fill mode' };

/** Tells where timing comes from when the animation's own rule doesn't set it. */
function timingSourceNote(a) {
  const missing = a.usage?.missing;
  if (!missing?.length) return null;
  const list = missing.map((k) => TIMING_LABELS[k]).join(', ');
  if (a.timingBase) {
    return h('p', { class: 'note' }, `${list[0].toUpperCase()}${list.slice(1)} come${missing.length === 1 ? 's' : ''} from another rule on the page – shown as the page plays it. Changing ${missing.length === 1 ? 'it' : 'one'} writes it into `, h('code', {}, a.usage.selector), '.');
  }
  return h(
    'p',
    { class: 'note warn' },
    `${list[0].toUpperCase()}${list.slice(1)} ${missing.length === 1 ? 'is' : 'are'} set outside `,
    h('code', {}, a.usage.selector),
    ' (a shared rule or a variable), and no element is running this animation right now – the values shown are CSS defaults, not what the page uses.',
  );
}

function checkPreview() {
  if (!S.session || S.schema) return;
  resolveLiveTiming();
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
  pushTimer = setTimeout(pushNow, 30);
}
/** Renders the model on the server and swaps the result into the preview; resolves once the preview is current. */
async function pushNow() {
  const seq = ++pushSeq;
  const { css } = await api('POST', '/api/render', { model: S.model, dirty: S.dirty, fv: S.session.fv });
  if (seq !== pushSeq) return;
  S.css = css;
  applyCss();
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
  applyEditorPreview();
  refreshGroups();
}

/* ---------- Editor view: the styles of the picked element as controls anni generates itself ---------- */

const EDITOR_GROUPS = [
  ['Layout', /^(display|position|top|right|bottom|left|inset|width|height|min-|max-|margin|padding|gap|flex|grid|align|justify|order|z-index|overflow|box-sizing)/],
  ['Typography', /^(font|line-height|letter-spacing|text-|color$|white-space|word-|vertical-align)/],
  ['Appearance', /^(background|border|outline|box-shadow|opacity|filter|backdrop|mix-blend|cursor|visibility)/],
  ['Transform', /^(transform|translate|scale|rotate|perspective|transition|animation)/],
];
const ENUM_PROPS = {
  display: ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'none'],
  position: ['static', 'relative', 'absolute', 'fixed', 'sticky'],
  'text-align': ['left', 'center', 'right', 'justify'],
  'font-style': ['normal', 'italic'],
  'text-transform': ['none', 'uppercase', 'lowercase', 'capitalize'],
  'text-decoration': ['none', 'underline', 'line-through'],
  visibility: ['visible', 'hidden'],
  overflow: ['visible', 'hidden', 'auto', 'scroll'],
  'flex-direction': ['row', 'row-reverse', 'column', 'column-reverse'],
  'justify-content': ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'],
  'align-items': ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'],
  'white-space': ['normal', 'nowrap', 'pre', 'pre-wrap'],
  cursor: ['auto', 'default', 'pointer', 'text', 'move', 'not-allowed', 'grab'],
  'box-sizing': ['content-box', 'border-box'],
};

/** Rough CSS specificity of one (non-list) selector as [ids, classes, elements]. */
function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const classes = (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length;
  const els = (sel.match(/(^|[\s>+~(])[a-zA-Z][\w-]*/g) || []).length + (sel.match(/::[\w-]+/g) || []).length;
  return ids * 10000 + classes * 100 + els;
}

/** Which uploaded file a stylesheet came from, or null (external / unknown). */
function sheetFile(sheet) {
  if (sheet.ownerNode?.dataset?.anniSrc !== undefined) return S.session.file; // the edited file, swapped in live
  if (sheet.href) {
    const p = new URL(sheet.href).pathname;
    const i = p.indexOf('/site/');
    return i >= 0 ? decodeURIComponent(p.slice(i + 6)) : null;
  }
  return S.session.kind === 'html' ? S.session.file : null;
}

/** The declarations that win for `el`, with the rule each comes from. CSSOM is the truth – no styling engine reimplemented. */
function winningDeclarations(el) {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const found = new Map(); // prop -> { value, selector, file, important, score, order }
  let order = 0;
  const visit = (rules, file) => {
    for (const rule of rules) {
      if (!(rule instanceof win.CSSStyleRule)) {
        // Grouping rules (@media, @supports, @layer): descend when they apply; never into @keyframes.
        if (rule instanceof win.CSSKeyframesRule || !rule.cssRules) continue;
        if (rule.media && !win.matchMedia(rule.media.mediaText).matches) continue;
        if (rule instanceof win.CSSSupportsRule && !win.CSS.supports(rule.conditionText)) continue;
        visit(rule.cssRules, file);
        continue;
      }
      if (rule.cssRules?.length) visit(rule.cssRules, file); // CSS nesting
      const parts = rule.selectorText.split(',').map((s) => s.trim());
      let best = -1;
      for (const part of parts) {
        if (/::|:hover|:focus|:active|:visited/.test(part)) continue;
        try {
          if (el.matches(part)) best = Math.max(best, specificity(part));
        } catch {}
      }
      if (best < 0) continue;
      order++;
      // cssText serialises back to the authored shorthands (padding: 8px 16px), which is what the source file holds.
      for (const decl of splitTop(rule.style.cssText, ';')) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        const prop = decl.slice(0, i).trim();
        if (prop.startsWith('--') || /^animation/.test(prop)) continue;
        let value = decl.slice(i + 1).trim();
        const important = /!important$/.test(value);
        if (important) value = value.replace(/\s*!important$/, '');
        const score = (important ? 1e9 : 0) + best * 1000 + order;
        const cur = found.get(prop);
        if (!cur || score >= cur.score) found.set(prop, { value, selector: rule.selectorText, file, important, score, order });
      }
    }
  };
  for (const sheet of doc.styleSheets) {
    const node = sheet.ownerNode;
    if (node?.dataset?.anniOverlay !== undefined || node?.id === 'anni-editor' || node?.id === 'anni-schema') continue; // anni's own styles
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    visit(rules, sheetFile(sheet));
  }
  for (const prop of el.style) found.set(prop, { value: el.style.getPropertyValue(prop), selector: null, file: null, important: true, score: Infinity, order: Infinity, inline: true });
  return found;
}

/** Generates the Editor schema for an element: one control per winning declaration, grouped like a design tool. */
function editorSchemaFor(el) {
  const decls = winningDeclarations(el);
  const groups = EDITOR_GROUPS.map(([label]) => ({ label, controls: [] }));
  const other = { label: 'Other', controls: [] };
  for (const [prop, d] of decls) {
    const selector = d.inline ? S.el?.selector : d.selector;
    const c = { id: `${d.inline ? 'inline' : d.selector}|${prop}`, label: prop, value: d.value, selector, prop, file: d.file, ...controlFor(prop, d.value) };
    c.preview = { css: { selector, prop, important: d.important || d.inline } };
    if (d.file && !d.inline) c.sourceHint = d.file.split('/').pop();
    const gi = EDITOR_GROUPS.findIndex(([, re]) => re.test(prop));
    (gi >= 0 ? groups[gi] : other).controls.push(c);
  }
  return { title: S.el?.tag || 'Element', groups: [...groups, other].filter((g) => g.controls.length) };
}

function controlFor(prop, value) {
  if (/color$|^(fill|stroke|background)$/.test(prop) && toRgba(value)) return { type: 'color' };
  if (prop === 'opacity') return { type: 'number', min: 0, max: 1, step: 0.01 };
  if (prop === 'font-weight' && /^\d+$/.test(value)) return { type: 'number', min: 100, max: 900, step: 100 };
  if (ENUM_PROPS[prop]) return { type: 'enum', options: [...new Set([...ENUM_PROPS[prop], value])] };
  const tok = parseNum(value);
  if (tok.raw === undefined) {
    if (!tok.unit) return { type: 'number', min: 0, max: Math.max(tok.n * 2, 10), step: tok.n >= 10 ? 1 : 0.1 };
    const [lo, hi, step] = rangeFor(tok);
    const canBeNegative = /^(margin|top|right|bottom|left|inset|translate|letter-spacing|text-indent|word-spacing)/.test(prop);
    return { type: 'length', min: canBeNegative ? Math.min(lo, 0) : 0, max: Math.max(hi, tok.n * 2), step, units: [...new Set([tok.unit, ...LENGTH])] };
  }
  if (parseTokens(value)) return { type: 'tokens' }; // "8px 16px", "1px solid" is text, "0 auto" is text
  return { type: 'text' };
}

const editorValue = (c) => S.editorChanges.get(c.id)?.value ?? c.value;

function setEditorValue(c, value) {
  if (S.pendingCommit !== false) {
    if (S.pendingCommit === true) commitEditor();
    S.pendingCommit = 'done';
  } else commitEditor();
  if (sameValue(value, c.value)) S.editorChanges.delete(c.id);
  else S.editorChanges.set(c.id, { control: c, value });
  afterEditorChange();
}
function commitEditor() {
  S.ehistory.push(new Map(S.editorChanges));
  if (S.ehistory.length > 200) S.ehistory.shift();
  S.efuture = [];
}
function afterEditorChange() {
  S.dirty = snapshot() !== S.saved || S.editorChanges.size > 0;
  applyEditorPreview();
  renderHeader();
  for (const row of document.querySelectorAll('#inspector .prop[data-id]')) row.classList.toggle('changed', S.editorChanges.has(row.dataset.id));
}
function undoEditor() {
  if (!S.ehistory.length) return;
  S.efuture.push(new Map(S.editorChanges));
  S.editorChanges = S.ehistory.pop();
  afterEditorChange();
  renderInspector();
}
function redoEditor() {
  if (!S.efuture.length) return;
  S.ehistory.push(new Map(S.editorChanges));
  S.editorChanges = S.efuture.pop();
  afterEditorChange();
  renderInspector();
}

/** All unsaved declaration edits as one <style> in the preview, so they stay visible across element picks. */
function applyEditorPreview() {
  const doc = frame.contentDocument;
  if (!doc?.head || S.schema) return;
  const css = [...S.editorChanges.values()].map(({ control: c, value }) => `${c.preview.css.selector} { ${c.prop}: ${value}${c.preview.css.important ? ' !important' : ''}; }`).join('\n');
  let style = doc.getElementById('anni-editor');
  if (!style && !css) return;
  if (!style) {
    style = doc.createElement('style');
    style.id = 'anni-editor';
    doc.head.append(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normSel = (s) => s.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();

/**
 * Builds the code wire for an edited declaration: a snippet of the file that occurs exactly once and contains
 * `prop: value;` inside the rule with that selector. Expands upwards line by line until unique.
 */
function findSnippet(text, selector, prop, value) {
  const re = new RegExp(`(^|[;{\\s])(${escapeRe(prop)}\\s*:\\s*${escapeRe(value)}\\s*(!important)?\\s*;?)`, 'g');
  const hits = [];
  for (const m of text.matchAll(re)) hits.push({ at: m.index + m[1].length, len: m[2].length });
  if (!hits.length) return null;
  const inRule = hits.filter((h) => {
    const open = text.lastIndexOf('{', h.at);
    const close = Math.max(text.lastIndexOf('}', open), text.lastIndexOf('{', open - 1));
    return open >= 0 && normSel(text.slice(close + 1, open)) === normSel(selector);
  });
  const hit = inRule[0] || (hits.length === 1 ? hits[0] : null);
  if (!hit) return null;
  const declEnd = hit.at + hit.len;
  let start = text.lastIndexOf('\n', hit.at - 1) + 1;
  for (let lines = 0; lines < 8; lines++) {
    const find = text.slice(start, declEnd);
    if (text.split(find).length - 1 === 1) {
      const decl = text.slice(hit.at, declEnd);
      return { find, replace: find.replace(decl, decl.replace(value, '{{value}}')) };
    }
    if (start === 0) break;
    start = text.lastIndexOf('\n', start - 2) + 1;
  }
  return null;
}

async function fileText(p) {
  if (!(p in S.fileTexts)) S.fileTexts[p] = await (await fetch(`${BASE}/site/${p.split('/').map(encodeURIComponent).join('/')}`)).text();
  return S.fileTexts[p];
}

/** The pending declaration edits with their code wires, for /api/save. */
async function pendingEdits() {
  const edits = [];
  for (const { control: c, value } of S.editorChanges.values()) {
    let source = null;
    if (c.file) {
      try {
        const wire = findSnippet(await fileText(c.file), c.selector, c.prop, c.value);
        if (wire) source = { file: c.file, ...wire };
      } catch {}
    }
    edits.push({ id: c.id, label: `${c.selector || 'inline'} ${c.prop}`, type: c.type, from: c.value, to: value, source });
  }
  return edits;
}

function renderEditorView() {
  const inspector = $('#inspector');
  const parts = [];
  if (S.el) parts.push(renderElementSection());
  const doc = frame.contentDocument;
  let el = null;
  try {
    el = S.el && doc ? doc.querySelector(S.el.selector) : null;
  } catch {}
  if (!el) {
    parts.push(h('div', { class: 'section' }, h('h2', {}, 'Styles'), h('p', { class: 'empty-inspector' }, S.el ? 'The picked element is not on the page right now.' : 'Pick an element on the page (V) to edit its styles. Changes preview live and are written to the stylesheet on Save.')));
    inspector.replaceChildren(...parts);
    return;
  }
  const schema = editorSchemaFor(el);
  for (const g of schema.groups) {
    parts.push(
      h(
        'div',
        { class: 'section props' },
        h('h2', {}, g.label),
        h(
          'div',
          { class: 'rows' },
          g.controls.map((c) => {
            const value = editorValue(c);
            return h(
              'div',
              { class: `prop${S.editorChanges.has(c.id) ? ' changed' : ''}${c.type === 'text' || c.type === 'tokens' ? ' wide' : ''}`, 'data-id': c.id },
              h('span', { class: 'name', title: `${c.prop} ← ${c.selector || 'inline style'}` }, c.prop),
              controlEditor(c, value, (v) => setEditorValue(c, v)),
              h('span', { class: 'key dot', title: S.editorChanges.has(c.id) ? 'Changed since the last save' : 'Unchanged' }),
              h('span', { class: 'wire' }, `${c.selector || 'inline'}${c.sourceHint ? ` → ${c.sourceHint}` : c.file ? '' : ' · no source file'}`),
            );
          }),
        ),
      ),
    );
  }
  inspector.replaceChildren(...parts);
}

function setView(view) {
  S.mode2 = view;
  if (!S.schema) $('#timeline').hidden = view === 'editor';
  for (const b of $('#view').children) b.classList.toggle('on', b.dataset.view === view);
  renderAll();
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
  S.history.push({ snap: snapshot(), sel: S.sel, picks: S.picks, name: S.name, sceneLen: S.sceneLen });
  if (S.history.length > 200) S.history.shift();
  S.future = [];
}

/** Applies an edit. `render` controls what gets redrawn (inputs re-render less to keep focus). */
function change(fn, { render = 'all' } = {}) {
  if (S.readonly) return; // watchers don't edit
  if (S.pendingCommit !== false) {
    if (S.pendingCommit === true) commit();
    S.pendingCommit = 'done';
  } else commit();
  fn();
  afterChange(render);
}

function afterChange(render = 'all') {
  S.dirty = snapshot() !== S.saved || S.editorChanges.size > 0;
  if (render === 'all') renderAll();
  else {
    renderTimeline();
    renderHeader();
  }
  push();
}

function restore(entry, from, to) {
  if (!entry || S.readonly) return;
  to.push({ snap: snapshot(), sel: S.sel, picks: S.picks, name: S.name, sceneLen: S.sceneLen });
  S.model.animations = JSON.parse(entry.snap);
  S.sel = entry.sel;
  S.picks = entry.picks;
  if (entry.sceneLen !== undefined && entry.sceneLen !== S.sceneLen) {
    S.sceneLen = entry.sceneLen; // the timeline's length is part of the history too
    resetTimelineView();
  }
  // A multi-keyframe edit may have started in another animation; go back to it with its selection.
  if (entry.name && entry.name !== S.name && animBy(entry.name)) S.name = entry.name;
  if (!anim()) S.name = S.model.animations[0].name; // undo of a freshly created animation
  if (S.sel && anim().keyframes[S.sel.bi]?.offsets[S.sel.oi] === undefined) S.sel = null;
  afterChange();
}
const undo = () => restore(S.history.pop(), S.history, S.future);
const redo = () => restore(S.future.pop(), S.future, S.history);

// Typing in an input should create one undo step per focus, not per keystroke.
// One undo step per edit gesture: from focus to blur while typing, and from press to release while
// dragging – some browsers (Safari) don't focus a slider on click, so focus alone would turn every tick of
// a drag into its own step.
const EDIT_CONTROL = '.inspector input, .inspector select, #time input';
let pressedControl = null;
document.addEventListener('focusin', (e) => {
  if (e.target.matches?.(EDIT_CONTROL)) S.pendingCommit = true;
});
document.addEventListener('focusout', () => {
  if (pressedControl) return; // mid-drag: the gesture ends on release
  S.pendingCommit = false;
  endDurationEdit();
  if (S.model) setTimeout(schedulePanel, 0);
});
document.addEventListener(
  'pointerdown',
  (e) => {
    const el = e.target.closest?.(EDIT_CONTROL);
    if (!el) return;
    pressedControl = el;
    S.pendingCommit = true;
  },
  true,
);
const releaseControl = () => {
  if (!pressedControl) return;
  const el = pressedControl;
  pressedControl = null;
  // Let the release's own input/change events land in this step first; a still-focused field keeps grouping.
  setTimeout(() => {
    if (document.activeElement === el && el.isConnected) return;
    S.pendingCommit = false;
    endDurationEdit();
    if (S.model) schedulePanel();
  }, 0);
};
addEventListener('pointerup', releaseControl, true);
addEventListener('pointercancel', releaseControl, true);

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

/*
 * Multi-selection: S.picks lists every selected keyframe as { name, bi, oi } (they can belong to different
 * animations). S.sel stays the primary one – the keyframe the inspector edits, always of the current animation.
 * Code that sets S.sel alone (keying, save, undo) simply falls back to a single selection.
 */
const pickKey = (p) => `${p.name}|${p.bi}|${p.oi}`;
const parsePick = (key) => {
  const [name, bi, oi] = key.split('|');
  return { name, bi: +bi, oi: +oi };
};
const animBy = (name) => S.model.animations.find((a) => a.name === name);

function picks() {
  if (!S.sel) return [];
  const primary = { name: S.name, bi: S.sel.bi, oi: S.sel.oi };
  const list = (S.picks || []).filter((p) => animBy(p.name)?.keyframes[p.bi]?.offsets[p.oi] !== undefined);
  return list.some((p) => pickKey(p) === pickKey(primary)) ? list : [primary];
}

/** Selects several keyframes. The primary is the first one of the current animation, else the first one. */
function setPicks(list) {
  const seen = new Set();
  list = list.filter((p) => !seen.has(pickKey(p)) && seen.add(pickKey(p)));
  if (!list.length) return select(null);
  const primary = list.find((p) => p.name === S.name) || list[0];
  if (primary.name !== S.name) {
    S.name = primary.name;
    api('POST', '/api/select', { animation: S.name });
  }
  S.sel = { bi: primary.bi, oi: primary.oi };
  S.picks = list;
  renderAll();
}

/** Selects a keyframe; seeks the playhead to it (page time of the edited animation, or `at` ms). */
function select(bi, oi, { seek = true, at } = {}) {
  S.sel = bi === null ? null : { bi, oi };
  S.picks = S.sel ? [{ name: S.name, bi, oi }] : [];
  if (S.sel && seek) S.t = at ?? delayOf() + (anim().keyframes[bi].offsets[oi] / 100) * dur();
  renderTimeline();
  renderInspector();
}

function addKeyframe(p, prop, g) {
  if (S.readonly) return;
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
  // Within one edit gesture, coming back to the value it started at undoes the gesture's auto-key entirely,
  // so a control dragged back to where it was leaves no keyframe, no "keyed" row and no unsaved marker.
  const fresh = S.pendingCommit !== 'done' || S.keyGesture?.prop !== prop || S.keyGesture?.name !== S.name;
  if (fresh) S.keyGesture = { prop, name: S.name, original: valueAt(prop), snap: snapshot(), sel: S.sel };
  if (!fresh && sameValue(value, S.keyGesture.original)) {
    change(
      () => {
        S.model.animations = JSON.parse(S.keyGesture.snap);
        S.sel = S.keyGesture.sel;
      },
      { render: 'light' },
    );
    // The gesture's undo step would now be a no-op: drop it, and let a further move start a new one.
    if (S.history.at(-1)?.snap === S.keyGesture.snap) {
      S.history.pop();
      S.pendingCommit = true;
      renderHeader();
    }
    $('#kf-section')?.replaceWith(renderKeyframeSection(anim()));
    const panel = $('#props');
    if (panel) panel.dataset.key = ''; // the row marked itself keyed while dragging: redraw it once the gesture ends
    return;
  }
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
  S.addOpen = false;
  setAnimation(name);
  toast(`@keyframes ${name} created – change a value to key it`);
}

/** Runs an existing @keyframes on the picked element too; Save adds the `animation` entry to its rule (see attachAnimation in css.js). */
function applyAnimation(name, selector) {
  if (!selector) return toast('Selector missing');
  const a = S.model.animations.find((x) => x.name === name);
  if (!a) return;
  if (a.usage?.selector === selector || a.applied?.includes(selector)) return toast(`${selector} already runs “${name}”`);
  change(() => (a.applied = [...(a.applied || []), selector]));
  if (S.el) S.el.names = [...S.el.names, name];
  S.addOpen = false;
  setAnimation(name);
  toast(`“${name}” applied to ${selector} – Save writes it to the file`);
}

function deleteSelected() {
  const list = picks();
  if (!list.length || S.readonly) return;
  // Highest index first, so removing a keyframe never shifts one that is still to be removed.
  const order = [...list].sort((p, q) => q.bi - p.bi || q.oi - p.oi);
  change(() => {
    for (const p of order) {
      const a = animBy(p.name);
      const block = a.keyframes[p.bi];
      if (block.offsets.length > 1) block.offsets.splice(p.oi, 1);
      else a.keyframes.splice(p.bi, 1);
    }
    S.sel = null; // before the re-render, which would otherwise look up the removed block
    S.picks = [];
  });
  if (list.length > 1) toast(`Deleted ${list.length} keyframes`);
}

/* ---------- copy / paste keyframes ---------- */

/** The selected keyframe as CSS – what lands on the system clipboard, so it can be pasted anywhere. */
function keyframeCss(block, offset) {
  return `${fmtPct(offset)} {\n${block.decls.filter((d) => d.prop).map((d) => `  ${d.prop}: ${d.value}${d.important ? ' !important' : ''};`).join('\n')}\n}`;
}

/** Declarations from clipboard text: a keyframe block (`50% { … }`) or bare `prop: value;` lines. Null if it isn't CSS. */
function parseDecls(text) {
  if (!text) return null;
  const body = text.includes('{') ? text.slice(text.indexOf('{') + 1, text.lastIndexOf('}') > text.indexOf('{') ? text.lastIndexOf('}') : undefined) : text;
  const decls = [];
  for (const part of splitTop(body, ';')) {
    const i = part.indexOf(':');
    if (i < 1) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    let value = part.slice(i + 1).trim();
    if (!/^-?[a-z][a-z0-9-]*$/.test(prop) || !value) return null;
    const important = /!important$/i.test(value);
    if (important) value = value.replace(/\s*!important$/i, '');
    decls.push({ prop, value, ...(important ? { important: true } : {}) });
  }
  return decls.length ? decls : null;
}

/**
 * Copies the selected keyframes. S.clip.items holds each one's declarations and its time relative to the
 * earliest (page time, so keyframes of several animations keep their spacing); S.clip.css is the clipboard text.
 */
function copySelected({ cut = false } = {}) {
  const list = picks();
  if (!list.length) return null;
  const items = list
    .map((p) => {
      const a = animBy(p.name);
      const block = a.keyframes[p.bi];
      const offset = block.offsets[p.oi];
      return { block, offset, label: `${p.name} ${fmtPct(offset)}`, t: a.timing.delay + (offset / 100) * a.timing.duration };
    })
    .sort((x, y) => x.t - y.t);
  const t0 = items[0].t;
  const decls = (it) => it.block.decls.filter((d) => d.prop).map((d) => ({ ...d }));
  S.clip = {
    items: items.map((it) => ({ rel: it.t - t0, decls: decls(it) })),
    from: items.length === 1 ? items[0].label : `${items.length} keyframes`,
    css: items.map((it) => keyframeCss(it.block, it.offset)).join('\n\n'),
  };
  if (cut) deleteSelected();
  else renderInspector();
  const n = S.clip.items[0].decls.length;
  toast(`${cut ? 'Cut' : 'Copied'} ${items.length === 1 ? `keyframe ${S.clip.from} · ${n} value${n === 1 ? '' : 's'}` : S.clip.from}`);
  return S.clip.css;
}

/**
 * Pastes keyframes at the playhead – the first at the playhead, the others at their copied distance from it.
 * Each goes into the keyframe already there (values overwrite, others stay) or becomes a new one. A keyframe
 * shared with other offsets (`0%, 100% {}`) is split first so only this one changes. `items` defaults to the clipboard.
 */
function pasteAtPlayhead(items = S.clip?.items) {
  if (S.readonly) return;
  if (!items?.length) return toast('Nothing to paste – select a keyframe and copy it first');
  const a = anim();
  const p0 = playheadPct();
  const pasted = [];
  let skipped = 0;
  change(() => {
    for (const item of items) {
      const p = Math.round((p0 + (item.rel / dur()) * 100) * 10) / 10;
      if (p > 100.05) {
        skipped++;
        continue;
      }
      let bi = a.keyframes.findIndex((b) => b.offsets.some((o) => Math.abs(o - p) < 0.05));
      let block = a.keyframes[bi];
      if (block && block.offsets.length > 1) {
        block.offsets.splice(block.offsets.findIndex((o) => Math.abs(o - p) < 0.05), 1);
        block = { offsets: [p], decls: block.decls.map((d) => ({ ...d })) };
        a.keyframes.push(block);
        bi = a.keyframes.length - 1;
      }
      if (!block) {
        block = { offsets: [p], decls: [] };
        a.keyframes.push(block);
        bi = a.keyframes.length - 1;
      }
      for (const d of item.decls) {
        const cur = block.decls.find((x) => x.prop === d.prop);
        if (cur) Object.assign(cur, { value: d.value, important: d.important });
        else block.decls.push({ ...d });
      }
      pasted.push({ name: a.name, bi, oi: block.offsets.findIndex((o) => Math.abs(o - p) < 0.05) });
    }
  });
  if (!pasted.length) return toast('Nothing pasted – the playhead is past the end of this animation');
  if (pasted.length === 1) select(pasted[0].bi, pasted[0].oi, { seek: false });
  else setPicks(pasted);
  const what = items.length === 1 ? `${items[0].decls.length} value${items[0].decls.length === 1 ? '' : 's'}` : `${pasted.length} keyframes`;
  const notes = [skipped && `${skipped} past 100% left out`, !playheadInRange() && 'playhead was outside this animation'].filter(Boolean);
  toast(`Pasted ${what} at ${fmtPct(p0)}${notes.length ? ` (${notes.join(', ')})` : ''}`);
}

/** Native clipboard events, so ⌘C / ⌘X / ⌘V work and the CSS text also goes to other apps. */
const keyframeClipboardActive = (e) =>
  S.model && !S.schema && S.mode2 !== 'editor' && !e.target.closest?.('input, select, textarea') && !String(getSelection?.() || '');
document.addEventListener('copy', (e) => {
  if (!keyframeClipboardActive(e) || !S.sel) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', copySelected());
});
document.addEventListener('cut', (e) => {
  if (!keyframeClipboardActive(e) || !S.sel) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', copySelected({ cut: true }));
});
let pastePending = false;
document.addEventListener('paste', (e) => {
  pastePending = false;
  if (!keyframeClipboardActive(e)) return;
  const text = e.clipboardData.getData('text/plain');
  // Our own copy pastes exactly; anything else is parsed as CSS (a keyframe block or declarations).
  const parsed = S.clip && text === S.clip.css ? null : parseDecls(text);
  const items = S.clip && text === S.clip.css ? S.clip.items : parsed ? [{ rel: 0, decls: parsed }] : !text ? S.clip?.items : null;
  if (!items) return;
  e.preventDefault();
  pasteAtPlayhead(items);
});

/* ---------- duration edits ---------- */

/*
 * Two ways to change a duration, one per place:
 * - Timing panel (keepTimes false): CSS's own behaviour – keyframes are percentages, so they stretch with it.
 * - Timeline time box (keepTimes true): keyframes keep their times in ms, like a design tool's work area –
 *   extra time is added at the end (a held 100% keyframe keeps the final state), shortening trims the end.
 * Everything is recomputed from the state at the start of the edit, so typing 2 → 22 → 2200 never squashes
 * keyframes on the way.
 */
let durEdit = null;

function setDuration(v, { keepTimes = false } = {}) {
  const a = anim();
  if (durEdit?.hold) {
    const i = a.keyframes.indexOf(durEdit.hold);
    if (i >= 0) a.keyframes.splice(i, 1);
    durEdit.hold = null;
  }
  if (!durEdit || durEdit.name !== a.name || durEdit.offsets.length !== a.keyframes.length) {
    durEdit = { name: a.name, dur: a.timing.duration, offsets: a.keyframes.map((b) => [...b.offsets]), hold: null, clamped: 0 };
  }
  const next = Math.max(1, Math.round(v));
  a.timing.duration = next;
  if (!keepTimes) {
    a.keyframes.forEach((b, i) => (b.offsets = [...durEdit.offsets[i]]));
    durEdit.clamped = 0;
    return;
  }
  const ratio = durEdit.dur / next;
  let clamped = 0;
  a.keyframes.forEach((b, i) => {
    b.offsets = durEdit.offsets[i].map((o) => {
      const n = Math.round(o * ratio * 100) / 100;
      if (n > 100.001) clamped++;
      return Math.min(100, n);
    });
  });
  durEdit.clamped = clamped;
  // Longer: the old 100% moved inwards; hold its state to the new end so nothing snaps back to the base style.
  const hadEnd = durEdit.offsets.some((offs) => offs.includes(100));
  if (hadEnd && !a.keyframes.some((b) => b.offsets.includes(100))) {
    const hold = { offsets: [100], decls: propsOf(a).map((prop) => ({ prop, value: valueNear(a, prop, 100) })) };
    a.keyframes.push(hold);
    durEdit.hold = hold;
  }
}

function endDurationEdit() {
  if (!durEdit) return;
  if (durEdit.clamped) toast(`${durEdit.clamped} keyframe${durEdit.clamped === 1 ? '' : 's'} past the new end moved to 100% (⌘Z to undo)`);
  durEdit = null;
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

/** Save button / ⌘S. While the request runs the status says "saving …" instead of "unsaved", and Save is off. */
async function saveNow() {
  if (!S.session || S.saving || S.readonly) return;
  S.saving = true;
  showSaveState();
  try {
    return await (S.schema ? saveSchema() : saveModel());
  } finally {
    S.saving = false;
    showSaveState();
  }
}

function showSaveState() {
  const el = $('#dirty');
  el.hidden = S.readonly || (!S.dirty && !S.saving);
  el.textContent = S.saving ? 'saving …' : '● unsaved';
  el.classList.toggle('saving', !!S.saving);
  $('#save').disabled = !!S.saving;
}

async function saveModel() {
  // The saved file is re-read, so keyframe indices may change: remember the selection by offset.
  const kept = picks().map((p) => ({ name: p.name, o: animBy(p.name).keyframes[p.bi].offsets[p.oi], primary: p.name === S.name && p.bi === S.sel.bi && p.oi === S.sel.oi }));
  try {
    const edits = await pendingEdits();
    const r = await api('POST', '/api/save', { model: S.model, edits, fv: S.session.fv });
    S.model = r.model;
    S.saved = snapshot();
    S.dirty = false;
    if (edits.length) {
      S.editorChanges = new Map();
      S.fileTexts = {};
      const manual = r.manual?.length ? ` · ${r.manual.length} could not be placed (handed to the agent)` : '';
      toast(`Saved – ${r.applied?.length || 0} style edit${r.applied?.length === 1 ? '' : 's'} written${manual}`);
      if ((r.files || []).some((f) => f !== S.session.file)) loadPreview(); // other stylesheets changed: reload them
      else {
        frame.contentDocument?.getElementById('anni-editor')?.remove();
        await pushNow(); // the edited stylesheet is swapped in before the panel re-reads the CSSOM
      }
      renderAll();
      resolveLiveTiming(); // the fresh model from the server knows nothing about inherited timing
      reloadIfUpdated();
      return;
    }
    S.sel = null;
    S.picks = [];
    for (const k of kept) {
      const a = animBy(k.name);
      const bi = a ? a.keyframes.findIndex((b) => b.offsets.includes(k.o)) : -1;
      if (bi < 0) continue;
      const p = { name: k.name, bi, oi: a.keyframes[bi].offsets.indexOf(k.o) };
      S.picks.push(p);
      if (k.primary) S.sel = { bi: p.bi, oi: p.oi };
    }
    renderAll();
    await pushNow();
    resolveLiveTiming(); // the fresh model from the server knows nothing about inherited timing
    toast(r.changed ? (S.session.hosted ? 'Saved – your agent can pull it now' : 'Saved to file') : 'No changes');
    reloadIfUpdated();
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
  for (const b of $('#view').children) b.classList.toggle('on', b.dataset.view === S.mode2);
  showSaveState();
  const editing = S.mode2 === 'editor';
  $('#undo').disabled = editing ? !S.ehistory.length : !S.history.length;
  $('#redo').disabled = editing ? !S.efuture.length : !S.future.length;
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
#anni-ov .box { position: absolute; box-sizing: border-box; border: calc(1px / var(--anni-z, 1)) dashed #e97130; }
#anni-ov .box.sel { border-style: solid; box-shadow: 0 0 0 calc(1px / var(--anni-z, 1)) rgba(233, 113, 48, 0.3); }
#anni-ov .box.hover { border-style: solid; background: rgba(233, 113, 48, 0.1); }
#anni-ov .tag { position: absolute; left: 0; bottom: 100%; margin-bottom: 2px; padding: 1px 5px; border-radius: 0;
  background: #e97130; color: #fafaf9; font: 500 10px/1.5 Inter, system-ui, sans-serif; white-space: nowrap;
  transform: scale(calc(1 / var(--anni-z, 1))); transform-origin: 0 100%; }
html.anni-pick, html.anni-pick * { cursor: crosshair !important; }
.anni-hidden { visibility: hidden !important; }`;

/** Overlay layer inside the preview document, installed once per page load. */
function overlay() {
  const doc = frame.contentDocument;
  if (!doc?.body || !doc.head) return null;
  let ov = doc.getElementById('anni-ov');
  if (!ov) {
    const style = doc.createElement('style');
    style.textContent = OVERLAY_CSS;
    style.dataset.anniOverlay = '';
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
  S.addOpen = false;
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
  const toggleAdd = () => ((S.addOpen = !S.addOpen), renderInspector());
  const available = S.model.animations.filter((a) => !el.names.includes(a.name));
  const addPanel = S.addOpen
    ? h(
        'div',
        { class: 'add-anim' },
        h('div', { class: 'add-head' }, 'Apply existing animation', h('span', { class: 'spacer' }), h('button', { class: 'ghost', title: 'Close', onclick: toggleAdd }, '×')),
        h(
          'div',
          { class: 'chips' },
          available.length
            ? available.map((a) => h('button', { class: 'chip apply', title: `Run @keyframes ${a.name} on ${el.selector}`, onclick: () => applyAnimation(a.name, el.selector) }, a.name))
            : h('span', { class: 'muted' }, 'Every animation of this file already runs here.'),
        ),
        h('div', { class: 'add-head' }, 'New animation'),
        h('div', { class: 'row create' }, nameInput, h('button', { class: 'primary', onclick: () => createAnimation(nameInput.value.trim(), el.selector) }, 'Create')),
      )
    : h('div', { class: 'row' }, h('button', { class: 'primary', onclick: toggleAdd }, '+ Animation'));

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
    addPanel,
  );
}

function field(label, input, cls = '') {
  return h('label', { class: `field ${cls}` }, h('span', {}, label), input);
}

function numberInput(value, unit, onValue) {
  const input = h('input', {
    ...NUM_FIELD,
    'data-step': 10,
    value,
    oninput: (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isNaN(v)) onValue(v);
    },
  });
  return h('div', { class: 'unit', 'data-unit': unit }, input);
}

/** Control points of an easing (keywords included), or null when it isn't a cubic Bézier. */
function bezierOf(easing) {
  const m = easing.match(/^cubic-bezier\(([^)]+)\)$/);
  const pts = BEZIER[easing] || (m && m[1].split(',').map(Number));
  return pts && pts.length === 4 && !pts.some(Number.isNaN) ? [...pts] : null;
}

function drawCurve(svg, pts) {
  const W = 280;
  const H = 70;
  const pad = 10;
  const ys = [0, 1, pts[1], pts[3]];
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const x = (v) => pad + v * (W - 2 * pad);
  const y = (v) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
  // The two control points get their own colours, shared with their numbers below the curve.
  svg.innerHTML = `
    <defs><linearGradient id="curve-grad" x1="0" x2="1"><stop offset="0" stop-color="#e97130"/><stop offset="1" stop-color="#f6d3bf"/></linearGradient></defs>
    <path d="M${x(0)} ${y(0)} L${x(pts[0])} ${y(pts[1])}" stroke="#e97130" stroke-opacity="0.45" stroke-width="1"/>
    <path d="M${x(1)} ${y(1)} L${x(pts[2])} ${y(pts[3])}" stroke="#f6d3bf" stroke-opacity="0.45" stroke-width="1"/>
    <path d="M${x(0)} ${y(0)} C${x(pts[0])} ${y(pts[1])} ${x(pts[2])} ${y(pts[3])} ${x(1)} ${y(1)}" fill="none" stroke="url(#curve-grad)" stroke-width="1.5"/>
    <circle cx="${x(pts[0])}" cy="${y(pts[1])}" r="2.5" fill="#e97130"/><circle cx="${x(pts[2])}" cy="${y(pts[3])}" r="2.5" fill="#f6d3bf"/>`;
}

/**
 * Easing graph with its cubic-bezier() values below it – also for keywords (ease = 0.25, 0.1, 0.25, 1).
 * The values are fields: type (comma or point), or ↑/↓ by 0.01 (Shift: 0.1). Each edit redraws the curve and
 * calls onEasing with the new cubic-bezier(…). x values stay within 0–1, as CSS requires.
 */
function curveEditor(easing, onEasing) {
  const pts = bezierOf(easing);
  if (!pts) return h('p', { class: 'note' }, 'No curve preview for this function.');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 280 70');
  svg.setAttribute('class', 'curve');
  drawCurve(svg, pts);
  const num = (v) => String(+v.toFixed(3));
  const fit = (input) => (input.style.width = `${Math.max(1, input.value.length) + 0.6}ch`);
  const commit = () => {
    drawCurve(svg, pts);
    onEasing(`cubic-bezier(${pts.map(num).join(', ')})`);
  };
  const field = (i) => {
    const isX = i % 2 === 0;
    const input = h('input', {
      ...NUM_FIELD, // formulas, and ↑/↓ by 0.01 (Shift: 0.1)
      'data-step': 0.01,
      class: `bz ${i < 2 ? 'p1' : 'p2'}`,
      value: num(pts[i]),
      title: `${isX ? 'x' : 'y'}${i < 2 ? 1 : 2}${isX ? ' (0–1)' : ''}`,
      oninput: (e) => {
        const v = parseFloat(e.target.value.replace(',', '.'));
        fit(e.target);
        if (Number.isNaN(v)) return;
        pts[i] = isX ? clamp(v, 0, 1) : v;
        commit();
      },
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === 'Escape') e.target.blur();
      },
      onblur: (e) => {
        e.target.value = num(pts[i]); // show what was applied (clamped, normalised)
        fit(e.target);
      },
    });
    fit(input);
    return input;
  };
  const sep = () => h('span', { class: 'sep' }, ', ');
  const values = h('div', { class: 'curve-values' }, field(0), sep(), field(1), sep(), field(2), sep(), field(3));
  return h('div', {}, svg, values);
}

function renderInspector() {
  if (S.mode2 === 'editor') return renderEditorView();
  const a = anim();
  const t = a.timing;
  const inspector = $('#inspector');

  const easingText = h('input', {
    value: t.easing,
    oninput: (e) => {
      const v = e.target.value.trim();
      if (!v) return;
      change(() => (t.easing = v), { render: 'light' });
      curveHost.replaceChildren(curveEditor(v, fromCurve));
      easingSelect.value = EASINGS.includes(v) ? v : '';
    },
  });
  // Edits in the curve's value fields: the text field and preset follow, the fields themselves keep focus.
  const fromCurve = (v) => {
    change(() => (t.easing = v), { render: 'light' });
    easingText.value = v;
    easingSelect.value = EASINGS.includes(v) ? v : '';
  };
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
  const curveHost = h('div', {}, curveEditor(t.easing, fromCurve));

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
      Object.assign(field('Animation duration', numberInput(t.duration, 'ms', (v) => change(() => setDuration(v), { render: 'light' }))), {
        title: 'Length of one iteration. Keyframes keep their percentages, so they stretch with it. To add or trim time and keep keyframes at their ms, change the duration in the time box of the timeline.',
      }),
      Object.assign(field('Delay', numberInput(t.delay, 'ms', (v) => change(() => (t.delay = v), { render: 'light' }))), {
        title: 'Wait before the first iteration starts (animation-delay). Moves the whole animation later on the page timeline; repeats do not wait again. A negative delay starts it partway in.',
      }),
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
    timingSourceNote(a),
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
      h('p', { class: 'empty-inspector' }, 'Changing a value above keys it at the playhead. Keyframes in the timeline: click = select, drag on an empty track = select several (Shift adds), drag = move (snaps to the playhead, the other keyframes keep their times; Shift on the first or last keyframe stretches the animation, ⌥ = duplicate, ⌘ = 1 ms steps), double-click a track = new keyframe, ⌘C / ⌘V = copy and paste at the playhead. Scrub in the ruler.'),
      S.clip ? h('div', { class: 'row', style: 'margin-top:10px' }, h('span', { class: 'muted note', style: 'margin:0' }, `Clipboard: ${S.clip.from}`), h('span', { class: 'spacer' }), h('button', { onclick: () => pasteAtPlayhead() }, 'Paste at playhead')) : null,
    );
  }
  const list = picks();
  if (list.length > 1) {
    const names = [...new Set(list.map((p) => p.name))];
    return h(
      'div',
      { class: 'section', id: 'kf-section' },
      h('h2', {}, `${list.length} keyframes`, h('span', { class: 'spacer' }), h('button', { class: 'ghost', title: 'Clear selection (Esc)', onclick: () => select(null) }, '×')),
      h('p', { class: 'note', style: 'margin:0 0 10px' }, 'In ', ...names.flatMap((n, i) => [i ? ', ' : '', h('code', {}, n)]), '. Drag one of them to move all by the same time; click one to edit just that one.'),
      h(
        'div',
        { class: 'row' },
        h('button', { title: 'Copy the selected keyframes with their values (⌘C)', onclick: () => navigator.clipboard?.writeText(copySelected()).catch(() => {}) }, 'Copy'),
        h('button', { title: S.clip ? `Paste ${S.clip.from} at the playhead (⌘V)` : 'Copy a keyframe first', disabled: !S.clip, onclick: () => pasteAtPlayhead() }, 'Paste'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'danger', onclick: deleteSelected }, `Delete ${list.length} keyframes`),
      ),
    );
  }
  const { bi, oi } = S.sel;
  const block = a.keyframes[bi];
  const others = block.offsets.filter((_, i) => i !== oi);

  const offsetInput = h('input', {
    ...NUM_FIELD,
    'data-step': 1,
    value: block.offsets[oi],
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
    h(
      'div',
      { class: 'row' },
      h('button', { title: 'Copy this keyframe with its values (⌘C)', onclick: () => navigator.clipboard?.writeText(copySelected()).catch(() => {}) }, 'Copy'),
      h('button', { title: S.clip ? `Paste ${S.clip.from} at the playhead (⌘V)` : 'Copy a keyframe first', disabled: !S.clip, onclick: () => pasteAtPlayhead() }, 'Paste'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'danger', onclick: deleteSelected }, 'Delete keyframe'),
    ),
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
    ...NUM_FIELD,
    'data-step': step,
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
// While a keyframe is dragged (S.dragView) the window stays where the drag started.
const viewSpan = () => (S.dragView ? S.dragView.span : Math.min(S.view.span ?? sceneDur(), sceneDur()));
const viewStart = () => (S.dragView ? S.dragView.start : S.view.span == null ? 0 : clamp(S.view.start, 0, sceneDur() - viewSpan()));
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
// The empty area below the last row is part of the canvas too: a drag there starts a selection box.
$('#tracks').addEventListener('pointerdown', (e) => e.target === e.currentTarget && startMarquee(e));

/* ---------- resizable panel and timeline ---------- */

/*
 * The panel's left edge and the timeline's top edge can be dragged to give the preview more or less room.
 * Sizes are CSS variables (--panel-w, --tl-h) and are remembered per browser; double-click a handle to reset.
 */
const LAYOUT_KEY = 'anni.layout';
let layout = {};
try {
  layout = JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {};
} catch {}

// The preview keeps at least ~240 px either way; the timeline keeps its transport bar, ruler and one row.
const LIMITS = {
  panel: () => [240, Math.max(240, innerWidth - 240)],
  timeline: () => [90, Math.max(90, innerHeight - 240)],
};

/** Applies the stored sizes, clamped to the current window (a size saved on a big screen still fits a small one). */
function applyLayout() {
  const root = document.documentElement.style;
  for (const [key, prop] of [['panel', '--panel-w'], ['timeline', '--tl-h']]) {
    if (layout[key]) root.setProperty(prop, `${clamp(layout[key], ...LIMITS[key]())}px`);
    else root.removeProperty(prop);
  }
}

function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {}
}

/**
 * A drag handle. The size follows the pointer's travel from where the handle was grabbed (no jump on press),
 * updates once per frame, and the preview iframe keeps its size until release – re-laying out the page on
 * every frame is what made resizing lag.
 */
function resizer(el, key, axis, size, sign) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
    el.classList.add('active');
    // Own class names: a plain `row` on <body> would pick up the panel's `.row` flex layout.
    document.body.classList.add(`resizing-${axis}`);
    const start = size();
    const from = axis === 'col' ? e.clientX : e.clientY;
    const iframe = frame.getBoundingClientRect();
    frame.style.cssText = `position:absolute;left:0;top:0;width:${iframe.width}px;height:${iframe.height}px`;
    let pending = null;
    let raf = 0;
    const move = (ev) => {
      pending = start + sign * ((axis === 'col' ? ev.clientX : ev.clientY) - from);
      raf ||= requestAnimationFrame(() => {
        raf = 0;
        layout[key] = Math.round(clamp(pending, ...LIMITS[key]()));
        applyLayout();
      });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      cancelAnimationFrame(raf);
      if (pending !== null) layout[key] = Math.round(clamp(pending, ...LIMITS[key]()));
      applyLayout();
      frame.style.cssText = ''; // the preview takes its new size once
      el.classList.remove('active');
      document.body.classList.remove(`resizing-${axis}`);
      saveLayout();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
  el.addEventListener('dblclick', () => {
    delete layout[key];
    applyLayout();
    saveLayout();
  });
}

// Dragging left widens the panel, dragging up raises the timeline.
resizer($('#panel-resizer'), 'panel', 'col', () => $('#inspector').getBoundingClientRect().width, -1);
resizer($('#tl-resizer'), 'timeline', 'row', () => $('#timeline').getBoundingClientRect().height, -1);
addEventListener('resize', applyLayout);
applyLayout();
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

/**
 * Tracks one drag gesture from its pointerdown `e`. Like a canvas app it owns the pointer: no native
 * text selection or focus change, and the pointer is captured by #tracks (which survives re-renders)
 * so the drag keeps going when it passes over the preview iframe.
 */
function followPointer(e, onMove, onEnd) {
  e.preventDefault();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  getSelection()?.removeAllRanges();
  try {
    $('#tracks').setPointerCapture(e.pointerId);
  } catch {}
  const move = (ev) => (ev.buttons === 0 ? end() : onMove(ev));
  const end = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    onEnd?.();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
}

/**
 * Scrubbing in the ruler. Within 8 px of a labelled tick (0, 200 ms, 1 s …) or the end, the playhead snaps onto
 * it; elsewhere it lands on whole ms. ⌘/Ctrl held: no snapping.
 */
function startScrub(e, lane) {
  if (e.button !== 0) return;
  const rect = lane.getBoundingClientRect();
  const move = (ev) => {
    const raw = xTime(laneX(ev, rect, true));
    const step = niceStep(viewSpan()); // the ruler's own tick spacing
    const end = viewStart() + viewSpan();
    const near = (t) => (Math.abs(raw - t) / viewSpan()) * rect.width <= 8;
    const tick = Math.round(raw / step) * step;
    S.t = ev.metaKey || ev.ctrlKey ? Math.round(raw) : near(tick) ? tick : near(end) ? end : Math.round(raw);
    updatePlayhead();
  };
  move(e);
  S.playing = false;
  updatePlayButton();
  followPointer(e, move);
}

/**
 * Press on a keyframe. ⌘/Ctrl+click toggles it in the selection, and so does a Shift+click without moving.
 * Dragging moves this keyframe – or, on a keyframe of a multi-selection, all selected ones by the same time
 * (a plain click there selects just that one). The other keyframes keep their times; with Shift held, dragging
 * the first or last keyframe stretches the animation instead (see applyMove). ⌥ leaves copies behind.
 * Keyframes stay within the timeline: from 0 to its length.
 */
function startDrag(e, g, bi, oi) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  if (S.readonly) {
    // Watchers select and seek, they don't move.
    if (g.name !== S.name) setAnimation(g.name);
    return select(bi, oi, { at: g.delay + (anim().keyframes[bi].offsets[oi] / 100) * g.duration });
  }
  const rect = e.currentTarget.parentElement.getBoundingClientRect();
  const key = pickKey({ name: g.name, bi, oi });
  const before = picks();
  const toggle = () => {
    const has = before.some((p) => pickKey(p) === key);
    setPicks(has ? before.filter((p) => pickKey(p) !== key) : [...before, { name: g.name, bi, oi }]);
  };
  if (e.metaKey || e.ctrlKey) return toggle();
  const shiftPress = e.shiftKey; // click: toggle on release; drag: move keeping the other keyframes' times
  const at = (a) => g.delay + (a.keyframes[bi].offsets[oi] / 100) * g.duration;
  const multi = before.length > 1 && before.some((p) => pickKey(p) === key);
  // The playhead stays where it is while dragging, and dragged keyframes snap to it. Only a click on a
  // keyframe (no drag) moves the playhead there, on release.
  const playT = S.t;
  const grab = () => {
    if (multi) {
      // Make the pressed keyframe the primary one without dropping the others.
      if (g.name !== S.name) {
        S.name = g.name;
        api('POST', '/api/select', { animation: g.name });
      }
      S.sel = { bi, oi };
      renderAll();
    } else {
      if (g.name !== S.name) setAnimation(g.name);
      select(bi, oi, { seek: false });
    }
  };
  if (!shiftPress) grab();
  // The scale is frozen while dragging, so rows don't rescale under the pointer. Keyframes can't go past the
  // timeline's length (type a longer one in the time box for more room).
  S.dragView = { start: viewStart(), span: viewSpan() };
  const limit = sceneDur();
  const pageTime = (ev) => S.dragView.start + ((ev.clientX - rect.left) / rect.width) * S.dragView.span;
  const t0 = pageTime(e);
  const x0 = e.clientX;
  const duplicate = e.altKey;
  let moved = false;
  let plan = null;
  followPointer(
    e,
    (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      if (!moved) {
        moved = true;
        if (shiftPress) grab();
        commit();
        if (duplicate) {
          // The originals stay where they are; single-offset copies of them are what moves.
          const copies = picks().map((p) => {
            const a = animBy(p.name);
            const src = a.keyframes[p.bi];
            a.keyframes.push({ offsets: [src.offsets[p.oi]], decls: src.decls.map((d) => ({ ...d })) });
            return { name: p.name, bi: a.keyframes.length - 1, oi: 0, anchor: p.name === g.name && p.bi === bi && p.oi === oi };
          });
          const a = copies.find((c) => c.anchor);
          S.picks = copies.map(({ name, bi: b, oi: o }) => ({ name, bi: b, oi: o }));
          S.sel = { bi: a.bi, oi: a.oi };
          bi = a.bi;
          oi = a.oi;
        }
        plan = planMove(picks(), g, { name: g.name, bi, oi });
      }
      // Snap the pressed keyframe to the playhead when within 8 px of it, else to 10 ms (⌘/Ctrl held: 1 ms);
      // nothing moves before 0 or past the timeline's end. Shift can be pressed or released mid-drag: the
      // move is always recomputed from the start.
      const raw = plan.anchorT + pageTime(ev) - t0;
      const step = ev.metaKey || ev.ctrlKey ? 1 : 10;
      const snapMs = (8 / rect.width) * S.dragView.span;
      const target = Math.abs(raw - playT) <= snapMs ? playT : Math.round(raw / step) * step;
      const dt = clampMove(plan, target - plan.anchorT, limit);
      const keepTimes = !ev.shiftKey;
      if (dt === plan.dt && keepTimes === plan.keepTimes) return;
      plan.dt = dt;
      plan.keepTimes = keepTimes;
      applyMove(plan, dt, keepTimes);
      afterChange(); // the time box turns orange when the keyframe lands on the playhead
    },
    () => {
      S.dragView = null;
      if (moved) return renderTimeline(); // back to the normal scale
      if (shiftPress) return toggle();
      if (multi) select(bi, oi, { seek: false }); // a plain click in a selection narrows it to this keyframe
      S.t = at(anim()); // a click moves the playhead to the keyframe
      renderTimeline();
    },
  );
}

/*
 * Moving keyframes in page time. Every keyframe of an affected animation is noted with its page time and offset;
 * the moved ones shift by dt and only their own animation's delay and duration change:
 * - keepTimes (a plain drag): the other keyframes keep their times and the span is rebuilt around them – an
 *   animation with a 0 % keyframe starts at its earliest keyframe, one with a 100 % keyframe ends at its latest.
 * - Stretch (Shift): dragging the first (0 %) or last (100 %) keyframe moves that edge; the other keyframes keep
 *   their percentages, so they stretch along – what changing a CSS duration does.
 * In both, a keyframe pulled past an edge takes that edge with it.
 */

/** The shared shift dt, limited so no moved keyframe ends up before 0 or after `limit` (the timeline's length). */
const clampMove = (plan, dt, limit) => clamp(dt, -plan.earliest, Math.max(-plan.earliest, limit - plan.latest));
function planMove(list, g, anchor) {
  const plans = new Map();
  for (const p of list) {
    const a = animBy(p.name);
    if (!plans.has(a)) {
      const dur = Math.max(1, a.timing.duration);
      // Page time of this animation's 0 %: the dragged row's own delay (rows can be staggered), else the rule's.
      const base = a.name === g.name ? g.delay : a.timing.delay;
      plans.set(a, {
        a,
        base,
        delay: a.timing.delay,
        dur,
        offsets: a.keyframes.map((b) => [...b.offsets]),
        times: a.keyframes.map((b) => b.offsets.map((o) => base + (o / 100) * dur)),
        moved: a.keyframes.map((b) => b.offsets.map(() => false)),
        hasStart: a.keyframes.some((b) => b.offsets.some((o) => o <= 0.001)),
        hasEnd: a.keyframes.some((b) => b.offsets.some((o) => o >= 99.999)),
        movesStart: false, // is a 0 % / 100 % keyframe among the moved ones?
        movesEnd: false,
      });
    }
    const pl = plans.get(a);
    pl.moved[p.bi][p.oi] = true;
    const o = a.keyframes[p.bi].offsets[p.oi];
    if (o <= 0.001) pl.movesStart = true;
    if (o >= 99.999) pl.movesEnd = true;
  }
  const all = [...plans.values()];
  const movedTimes = all.flatMap((pl) => pl.times.flatMap((ts, bi) => ts.filter((_, oi) => pl.moved[bi][oi])));
  const ap = plans.get(animBy(anchor.name));
  return { plans: all, earliest: Math.min(...movedTimes), latest: Math.max(...movedTimes), anchorT: ap.times[anchor.bi][anchor.oi], dt: null };
}

function applyMove(plan, dt, keepTimes) {
  for (const pl of plan.plans) {
    const times = pl.times.map((ts, bi) => ts.map((t, oi) => (pl.moved[bi][oi] ? t + dt : t)));
    const movedTimes = times.flatMap((ts, bi) => ts.filter((_, oi) => pl.moved[bi][oi]));
    let start;
    let end;
    if (keepTimes) {
      const flat = times.flat();
      start = pl.hasStart ? Math.min(...flat) : Math.min(pl.base, ...flat);
      end = pl.hasEnd ? Math.max(...flat) : Math.max(pl.base + pl.dur, ...flat);
    } else {
      start = Math.min(pl.base + (pl.movesStart ? dt : 0), ...movedTimes);
      end = Math.max(pl.base + pl.dur + (pl.movesEnd ? dt : 0), ...movedTimes);
    }
    pl.a.timing.delay = Math.round(pl.delay + (start - pl.base));
    pl.a.timing.duration = Math.max(1, Math.round(end - start));
    const zero = pl.base + (pl.a.timing.delay - pl.delay); // page time of the new 0 %
    const d = pl.a.timing.duration;
    const offsetOf = (t) => clamp(Math.round(((t - zero) / d) * 10000) / 100, 0, 100);
    pl.a.keyframes.forEach((b, bi) => {
      // Stretch mode: keyframes that weren't moved keep their percentage; with keepTimes, their time.
      b.offsets = times[bi].map((t, oi) => (keepTimes || pl.moved[bi][oi] ? offsetOf(t) : pl.offsets[bi][oi]));
    });
  }
}

/** Drag on an empty track: rubber-band selection. Shift/⌘ adds to the selection, a click without dragging clears it. */
function startMarquee(e) {
  if (e.button !== 0) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  const base = e.shiftKey || e.metaKey || e.ctrlKey ? picks() : [];
  let box = null;
  let keys = new Set(base.map(pickKey));
  followPointer(
    e,
    (ev) => {
      if (!box && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
      if (!box) box = document.body.appendChild(h('div', { class: 'marquee' }));
      const l = Math.min(x0, ev.clientX);
      const t = Math.min(y0, ev.clientY);
      const r = Math.max(x0, ev.clientX);
      const b = Math.max(y0, ev.clientY);
      box.style.cssText = `left:${l}px;top:${t}px;width:${r - l}px;height:${b - t}px`;
      keys = new Set(base.map(pickKey));
      const buttons = $('#tracks').querySelectorAll('.kf[data-pick]');
      for (const btn of buttons) {
        const c = btn.getBoundingClientRect();
        const cx = c.left + c.width / 2;
        const cy = c.top + c.height / 2;
        if (cx >= l && cx <= r && cy >= t && cy <= b) keys.add(btn.dataset.pick);
      }
      // Live feedback without a re-render; the same keyframe can show in several rows.
      for (const btn of buttons) btn.classList.toggle('sel', keys.has(btn.dataset.pick));
    },
    () => {
      if (!box) return base.length ? null : picks().length && select(null, null, { seek: false });
      box.remove();
      setPicks([...keys].map(parsePick));
    },
  );
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
  const nodes = [];
  if (prop) {
    for (let i = 0; i < pts.length - 1; i++) nodes.push(h('div', { class: 'bar', style: `left:${sceneX(g, pts[i].o)}%;width:${sceneX(g, pts[i + 1].o) - sceneX(g, pts[i].o)}%` }));
  }
  for (const pt of pts) {
    const key = pickKey({ name: g.name, bi: pt.bi, oi: pt.oi });
    nodes.push(
      h('button', {
        class: `kf${pickSet.has(key) ? ' sel' : ''}`,
        'data-pick': key,
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
      onpointerdown: startMarquee, // scrubbing is the ruler's job
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

/* Eye toggle: hides a group's elements in the preview only. The class is the state, so it lasts until the page reloads. */
const EYE_OPEN = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
const EYE_SHUT = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 6.5s2.2 3 6 3 6-3 6-3M4 8.6l-1.2 1.6M8 9.5v2M12 8.6l1.2 1.6"/></svg>';
const isHidden = (g) => g.targets.length > 0 && g.targets.every((el) => el.classList.contains('anni-hidden'));

function setHidden(targets, hide) {
  overlay(); // installs the .anni-hidden rule in the preview document
  for (const el of targets) el.classList.toggle('anni-hidden', hide);
}

/** Click toggles the group; Alt+click shows only this group (or everything again if it already was the only one). */
function toggleEye(e, g) {
  e.stopPropagation();
  if (e.altKey) {
    const others = S.groups.filter((o) => o !== g && o.targets.length);
    const solo = !isHidden(g) && others.every(isHidden);
    for (const o of others) setHidden(o.targets, !solo);
    setHidden(g.targets, false);
  } else setHidden(g.targets, !isHidden(g));
  renderTimeline();
}

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
  const hidden = isHidden(g);
  const eye = h('button', { class: `eye${hidden ? ' off' : ''}`, title: hidden ? 'Show in preview' : 'Hide in preview (Alt+click: show only this)', disabled: !g.targets.length, onclick: (e) => toggleEye(e, g) });
  eye.innerHTML = hidden ? EYE_SHUT : EYE_OPEN;
  const label = h('div', { class: 'tl-label', title: g.targets[0] ? `${groupLabel(g)} – ${g.name}` : `${g.name} is not running on any element right now`, onclick: () => focusGroup(g) }, eye, fold, h('span', { class: 'el' }, groupLabel(g)));
  return h('div', { class: `tl-row group${g.name === S.name ? ' current' : ''}${g.anim ? '' : ' foreign'}${hidden ? ' hidden-el' : ''}` }, label, laneFor(g, null, [...span, ...kfs]));
}

function niceStep(total) {
  const target = total / 8;
  return [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 30000].find((s) => s >= target) || 60000;
}

let pickSet = new Set(); // keys of the selected keyframes, refreshed per render

function renderTimeline() {
  pickSet = new Set(picks().map(pickKey));
  const groups = sceneGroups();
  S.groups = groups;
  S.groupsKey = groupsKey(groups);
  // The timeline keeps its length: it grows to fit what's on it, but only the length box makes it shorter –
  // dragging the last keyframe in shortens that animation, not the timeline.
  const D = (S.sceneDur = S.sceneLen = Math.max(1, S.sceneLen || 0, ...groups.map(sceneEnd)));
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
  const now = $('#t-now');
  const total = $('#t-dur');
  if (document.activeElement !== now) now.value = Math.round(S.t);
  now.classList.toggle('on-key', onKeyframe());
  if (document.activeElement !== total) total.value = Math.round(sceneDur());
  total.title = 'Length of the timeline – at least as long as the longest animation; type a longer one for room to drag keyframes later. An animation’s own length changes by dragging its first or last keyframe, or in the Timing panel.';
  schedulePanel();
}

/*
 * Time box: type a time to jump the playhead there; type a length for the timeline (never shorter than its
 * animations). When the playhead sits on the selected keyframe – selecting one puts it there – a new time
 * moves the whole selection along with it, the same way a drag does.
 */
function moveSelectionTo(v) {
  if (S.readonly) return false; // watchers only move the playhead
  const list = picks();
  const g = list.length && S.groups?.find((x) => x.anim && x.name === S.name);
  if (!g) return false;
  const anchor = { name: S.name, bi: S.sel.bi, oi: S.sel.oi };
  const at = g.delay + (anim().keyframes[anchor.bi].offsets[anchor.oi] / 100) * g.duration;
  if (Math.abs(S.t - at) > 0.5) return false;
  change(() => {
    const plan = planMove(list, g, anchor);
    const dt = clampMove(plan, v - plan.anchorT, sceneDur());
    applyMove(plan, dt, true); // like a plain drag: the other keyframes keep their times
    S.t = plan.anchorT + dt;
  });
  return true;
}

$('#t-now').addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if (Number.isNaN(v) || !S.model) return;
  S.playing = false;
  updatePlayButton();
  if (!moveSelectionTo(Math.max(0, v))) S.t = clamp(v, 0, sceneDur());
  ensurePlayheadVisible();
  updatePlayhead();
});
$('#t-dur').addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if (Number.isNaN(v) || !S.model) return;
  const len = Math.max(1, Math.round(v));
  if (len === (S.sceneLen || 0)) return;
  if (S.readonly) {
    // Watchers may make the view longer or shorter; scaling animations would be an edit.
    S.sceneLen = len;
    resetTimelineView();
    return renderTimeline();
  }
  const old = sceneDur();
  let scaled = 0;
  // One undo step. A longer length only adds room; a shorter one scales every animation that would end past it.
  change(() => {
    S.sceneLen = len;
    if (len < old) scaled = scaleToLength(len, old);
  });
  resetTimelineView();
  renderTimeline();
  if (scaled) toast(`Scaled ${scaled} animation${scaled === 1 ? '' : 's'} to ${Math.round((len / old) * 100)} % to fit ${len} ms`);
});

/**
 * Shorter timeline: every animation of the file that ends past `len` is scaled by len / old – delay and
 * duration alike, keyframe percentages unchanged – so it keeps its shape and its place relative to the
 * timeline. Animations that already end within `len` stay as they are. Returns how many were scaled.
 */
function scaleToLength(len, old) {
  const k = len / old;
  const ends = new Map();
  for (const g of S.groups || []) if (g.anim) ends.set(g.anim, Math.max(ends.get(g.anim) ?? 0, sceneEnd(g)));
  let n = 0;
  for (const [a, end] of ends) {
    if (end <= len + 0.5) continue;
    a.timing.delay = Math.round(a.timing.delay * k);
    a.timing.duration = Math.max(1, Math.round(a.timing.duration * k));
    n++;
  }
  return n;
}
for (const input of [$('#t-now'), $('#t-dur')]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') input.blur();
  });
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
    const d = sceneDur();
    S.t += dt * S.speed * S.dir;
    if (S.loop === 'bounce') {
      // Turn around at either end.
      if (S.t >= d) {
        S.t = Math.max(0, 2 * d - S.t);
        S.dir = -1;
      } else if (S.t <= 0) {
        S.t = Math.min(d, -S.t);
        S.dir = 1;
      }
    } else if (S.t >= d) {
      if (S.loop === 'loop') S.t %= d;
      else {
        S.t = d;
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
  S.dir = 1;
  updatePlayhead();
};
$('#loop').onclick = () => {
  S.loop = nextLoopMode(S.loop);
  if (S.loop !== 'bounce') S.dir = 1;
  showLoopMode($('#loop'), S.loop);
};
showLoopMode($('#loop'), S.loop);
$('#speed').onchange = (e) => (S.speed = +e.target.value);
$('#save').onclick = saveNow;
$('#undo').onclick = () => (S.schema ? undoValues() : S.mode2 === 'editor' ? undoEditor() : undo());
$('#redo').onclick = () => (S.schema ? redoValues() : S.mode2 === 'editor' ? redoEditor() : redo());
$('#view').onclick = (e) => e.target.dataset.view && setView(e.target.dataset.view);
$('#add-kf').onclick = () => addKeyframe(playheadPct());
$('#mode').onclick = (e) => e.target.dataset.mode && setMode(e.target.dataset.mode);
$('#pick').onclick = () => setPicking(!S.picking);
$('#anim-select').onchange = (e) => setAnimation(e.target.value);

/* ---------- number fields: formulas and arrow steps ---------- */

/*
 * Every number field (data-expr) takes a formula: "2000-50", "120*1.5", "(300+60)/2", comma or point.
 * A leading operator works on the value the field had: "+50", "*2", "/2", "- 50" (with a space; "-50" stays a
 * negative number). It is worked out on Enter or when the field is left; the field's own input handler then
 * gets the result like a typed number. ↑/↓ step by data-step (Shift: ×10).
 */
const NUM_FIELD = { type: 'text', inputmode: 'decimal', spellcheck: 'false', autocomplete: 'off', 'data-expr': '' };

/** Arithmetic only (+ − × ÷, parentheses, unary minus) – a tiny parser, nothing is eval'd. Null if it isn't one. */
function evalExpr(text, prev) {
  let s = String(text).trim().replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
  if (!s) return null;
  if (/^[+*/]/.test(s) || /^-\s/.test(s)) {
    if (!Number.isFinite(prev)) return null;
    s = `${prev}${s}`;
  }
  let i = 0;
  const ws = () => {
    while (s[i] === ' ') i++;
  };
  const num = () => {
    ws();
    if (s[i] === '(') {
      i++;
      const v = sum();
      ws();
      if (s[i++] !== ')') throw 0;
      return v;
    }
    if (s[i] === '-' || s[i] === '+') return (s[i++] === '-' ? -1 : 1) * num();
    const m = s.slice(i).match(/^\d*\.?\d+(e[+-]?\d+)?/i);
    if (!m) throw 0;
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const product = () => {
    let v = num();
    for (ws(); s[i] === '*' || s[i] === '/'; ws()) v = s[i++] === '*' ? v * num() : v / num();
    return v;
  };
  const sum = () => {
    let v = product();
    for (ws(); s[i] === '+' || s[i] === '-'; ws()) v = s[i++] === '+' ? v + product() : v - product();
    return v;
  };
  try {
    const v = sum();
    ws();
    return i === s.length && Number.isFinite(v) ? +v.toFixed(6) : null;
  } catch {
    return null;
  }
}

/** Puts `v` into the field and lets its own input handler apply it. */
function setField(input, v) {
  input.value = String(v);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function commitExpr(input) {
  const v = evalExpr(input.value, parseFloat(input.dataset.prev));
  if (v === null) input.value = input.dataset.prev ?? input.value; // not a number or formula: back to what it was
  else if (String(v) !== input.value) setField(input, v);
}

const isNumField = (el) => el instanceof HTMLInputElement && el.hasAttribute('data-expr');
// The value before editing, for leading operators and to restore an invalid entry. Noted on focus – or on the
// first key, should focus not have been reported – and dropped when the field is left.
const notePrev = (input) => input.dataset.prev ?? (input.dataset.prev = input.value.replace(',', '.'));
document.addEventListener('focusin', (e) => isNumField(e.target) && (e.target.dataset.prev = e.target.value.replace(',', '.')));
document.addEventListener('focusout', (e) => isNumField(e.target) && delete e.target.dataset.prev);
// Capture phase: the result is in the field before the field's own Enter / change handlers read it.
document.addEventListener('change', (e) => isNumField(e.target) && commitExpr(e.target), true);
document.addEventListener(
  'keydown',
  (e) => {
    const input = e.target;
    if (!isNumField(input)) return;
    notePrev(input);
    if (e.key === 'Enter') return commitExpr(input);
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const step = (parseFloat(input.dataset.step) || 1) * (e.shiftKey ? 10 : 1);
    const base = evalExpr(input.value, parseFloat(input.dataset.prev)) ?? 0;
    const decimals = (String(input.dataset.step || 1).split('.')[1] || '').length;
    setField(input, +(base + (e.key === 'ArrowUp' ? step : -step)).toFixed(decimals));
  },
  true,
);

/* ---------- shortcuts overview (keyboard button top right, or ?) ---------- */

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const KEY_NAMES = { Mod: IS_MAC ? '⌘' : 'Ctrl', Alt: IS_MAC ? '⌥' : 'Alt', Shift: IS_MAC ? '⇧' : 'Shift', Del: IS_MAC ? '⌫' : 'Del' };

/*
 * Every control, by category. A row has one or more alternatives ("or"); an alternative is keys joined by
 * "+". Words in [brackets] are mouse actions, drawn without a key frame.
 */
const SHORTCUTS = [
  {
    title: 'General',
    rows: [
      [['Mod+S'], 'Save to the file'],
      [['Mod+Z'], 'Undo'],
      [['Mod+Shift+Z', 'Mod+Y'], 'Redo'],
      [['Tab'], 'Switch between Editor and Animate'],
      [['?'], 'Show this overview'],
      [['Esc'], 'Clear the selection · cancel picking · close this overview'],
    ],
  },
  {
    title: 'Playback & playhead',
    rows: [
      [['Space'], 'Play / pause'],
      [['←', '→'], 'Playhead by 1 ms – stops at keyframes on the way'],
      [['Shift+←', 'Shift+→'], 'Playhead by 10 ms – stops at keyframes on the way'],
      [['Alt+←', 'Alt+→'], 'Previous / next keyframe of any element'],
      [['Home', 'End'], 'Start / end of the timeline'],
      [['[Drag] in the ruler'], 'Scrub – snaps to the labelled ticks'],
      [['Mod+[Drag] in the ruler'], 'Scrub without snapping'],
      [['[Type] in the time box'], 'Jump the playhead to that time'],
      [['[Type] a length'], 'Make the timeline longer (room to drag keyframes later)'],
    ],
  },
  {
    title: 'Keyframes',
    rows: [
      [['[Click]'], 'Select – the playhead goes there'],
      [['Shift+[Click]', 'Mod+[Click]'], 'Add to / remove from the selection'],
      [['[Drag] on an empty track'], 'Box selection'],
      [['Shift+[Drag] on a track'], 'Add a box selection to the current one'],
      [['Mod+A'], 'Select all keyframes of the animation'],
      [['[Double-click] a track'], 'New keyframe there'],
      [['[Drag]'], 'Move – snaps to the playhead and to 10 ms, stays within the timeline; the other keyframes keep their times'],
      [['Shift+[Drag]'], 'Move the first or last keyframe and stretch the animation – the others scale along'],
      [['Mod+[Drag]'], 'Move in 1 ms steps'],
      [['Alt+[Drag]'], 'Duplicate'],
      [['[Type] in the time box'], 'With the playhead on the selection: move it to that time'],
      [['Del', 'Backspace'], 'Delete'],
      [['Mod+C', 'Mod+X'], 'Copy / cut'],
      [['Mod+V'], 'Paste at the playhead'],
    ],
  },
  {
    title: 'Timeline',
    rows: [
      [['Mod+[Wheel]', '[Pinch]'], 'Zoom'],
      [['Shift+[Wheel]'], 'Pan when zoomed'],
      [['0'], 'Fit the timeline (and reset the preview zoom)'],
      [['[Click] the eye'], 'Hide / show the element in the preview'],
      [['Alt+[Click] the eye'], 'Show only this element'],
      [['[Click] ▸'], 'Show / hide the properties of an element'],
      [['[Drag] an edge'], 'Resize the timeline or the panel'],
      [['[Double-click] an edge'], 'Reset its size'],
    ],
  },
  {
    title: 'Preview',
    rows: [
      [['V'], 'Pick an element on the page'],
      [['Mod+[Wheel]', '[Pinch]'], 'Zoom'],
      [['[Wheel]'], 'Pan when zoomed'],
      [['0', '[Click] the zoom readout'], 'Reset the zoom'],
    ],
  },
  {
    title: 'Fields',
    rows: [
      [['[Type] 2000-50'], 'Formulas in every number field: + − × ÷ and ( ), worked out on Enter or when leaving the field'],
      [['[Type] +50', '[Type] *2'], 'A leading operator uses the field’s value: +50, - 50, *2, /2'],
      [['↑', '↓'], 'One step (ms, %, easing 0.01 …)'],
      [['Shift+↑', 'Shift+↓'], 'Ten steps'],
      [['Enter', 'Esc'], 'Leave the field'],
    ],
  },
];

function keyCombo(combo) {
  return h(
    'span',
    { class: 'combo' },
    combo.split('+').flatMap((part, i) => {
      const mouse = part.match(/^\[(.+?)\](.*)$/);
      const node = mouse ? h('span', { class: 'mouse' }, mouse[1], mouse[2] ? h('span', { class: 'where' }, mouse[2]) : null) : h('kbd', {}, KEY_NAMES[part] || part);
      return i ? [h('span', { class: 'plus' }, '+'), node] : [node];
    }),
  );
}

function shortcutsOverlay() {
  const close = () => toggleShortcuts(false);
  const sections = SHORTCUTS.map((cat) =>
    h(
      'section',
      { class: 'keys-cat' },
      h('h3', {}, cat.title),
      h(
        'dl',
        {},
        cat.rows.flatMap(([alts, label]) => [
          h('dt', {}, alts.flatMap((a, i) => (i ? [h('span', { class: 'or' }, 'or'), keyCombo(a)] : [keyCombo(a)]))),
          h('dd', {}, label),
        ]),
      ),
    ),
  );
  return h(
    'div',
    { class: 'keys-backdrop', id: 'keys-overlay', onclick: (e) => e.target === e.currentTarget && close() },
    h(
      'div',
      { class: 'keys-panel', role: 'dialog', 'aria-label': 'Shortcuts and mouse controls' },
      h('header', {}, h('h2', {}, 'Shortcuts & mouse'), h('span', { class: 'spacer' }), h('button', { class: 'ghost', title: 'Close (Esc)', onclick: close }, '×')),
      h('div', { class: 'keys-grid' }, sections),
    ),
  );
}

function toggleShortcuts(open = !$('#keys-overlay')) {
  $('#keys-overlay')?.remove();
  if (open) document.body.append(shortcutsOverlay());
  $('#keys').classList.toggle('on', open);
}

$('#keys').onclick = () => toggleShortcuts();
// Capture phase, so Esc closes the overview without also clearing the selection – and ? works everywhere.
addEventListener(
  'keydown',
  (e) => {
    if (e.target.matches?.('input, select, textarea')) return;
    if (e.key === 'Escape' && $('#close-overlay')) {
      e.stopImmediatePropagation();
      return $('#close-overlay').remove();
    }
    if (e.key === 'Escape' && $('#proposal-overlay')) {
      e.stopImmediatePropagation();
      return $('#proposal-overlay').remove();
    }
    const open = !!$('#keys-overlay');
    if (e.key === '?' || (open && e.key === 'Escape')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleShortcuts(e.key === '?' ? !open : false);
    }
  },
  true,
);

addEventListener('keydown', (e) => {
  if (!S.model && !S.schema) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    return saveNow();
  }
  const typing = !!e.target.matches?.('input, select, textarea');
  if (S.schema) {
    if (mod && !typing && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
      e.preventDefault();
      return e.key.toLowerCase() === 'y' || e.shiftKey ? redoValues() : undoValues();
    }
    return;
  }
  const editing = S.mode2 === 'editor';
  if (mod && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    return e.shiftKey ? (editing ? redoEditor() : redo()) : editing ? undoEditor() : undo();
  }
  if (mod && e.key.toLowerCase() === 'y' && !typing) {
    e.preventDefault();
    return editing ? redoEditor() : redo();
  }
  if (!typing && !mod && e.key === 'Tab') {
    e.preventDefault();
    return setView(editing ? 'animate' : 'editor');
  }
  if (typing) return;
  // Keyframe clipboard. ⌘C/⌘X write the CSS themselves (some browsers fire no copy event without a text
  // selection); ⌘V lets the native paste event through – it carries external CSS – and falls back to the
  // internal clipboard when the browser sends none.
  if (mod && !editing && !String(getSelection?.() || '')) {
    const k = e.key.toLowerCase();
    if (k === 'a') {
      // ⌘A: every keyframe of the edited animation.
      e.preventDefault();
      return setPicks(anim().keyframes.flatMap((b, bi) => b.offsets.map((_, oi) => ({ name: S.name, bi, oi }))));
    }
    if ((k === 'c' || k === 'x') && S.sel) {
      e.preventDefault();
      const css = copySelected({ cut: k === 'x' });
      navigator.clipboard?.writeText(css).catch(() => {});
      return;
    }
    if (k === 'v') {
      pastePending = true;
      setTimeout(() => {
        if (!pastePending) return;
        pastePending = false;
        pasteAtPlayhead();
      }, 60);
      return;
    }
  }
  if (e.key === ' ') {
    e.preventDefault();
    if (e.target instanceof HTMLButtonElement) e.target.blur(); // Space must not also re-trigger a focused button
    togglePlay();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) {
    deleteSelected();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const dir = e.key === 'ArrowLeft' ? -1 : 1;
    if (e.altKey) jumpToKeyframe(dir);
    else {
      S.playing = false;
      updatePlayButton();
      S.t = clamp(stepToward(S.t, dir, e.shiftKey ? 10 : 1), 0, sceneDur());
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

/**
 * Arrow keys: to the next whole ms (Shift: the next multiple of 10 ms – the grid dragged keyframes snap to),
 * so a playhead left between values by scrubbing lands on round times, and on keyframes.
 */
const stepTime = (t, dir, step) => (dir > 0 ? Math.floor(t / step + 1e-6) * step + step : Math.ceil(t / step - 1e-6) * step - step);

/** One arrow step – but a keyframe lying before the next step catches the playhead first. */
function stepToward(t, dir, step) {
  const next = stepTime(t, dir, step);
  const between = keyframeTimes()
    .map((k) => k.t)
    .filter((k) => (dir > 0 ? k > t + 0.5 && k < next : k < t - 0.5 && k > next));
  if (!between.length) return next;
  return dir > 0 ? Math.min(...between) : Math.max(...between);
}

/** Is the playhead on a keyframe of any element? Its time turns orange then. */
const onKeyframe = () => keyframeTimes().some((k) => Math.abs(k.t - S.t) < 0.5);

/** Every keyframe of the scene as page time, with what it belongs to. */
function keyframeTimes() {
  const out = [];
  for (const g of S.groups || []) {
    if (g.anim) g.anim.keyframes.forEach((b, bi) => b.offsets.forEach((o, oi) => out.push({ t: g.delay + (o / 100) * g.duration, g, bi, oi })));
    else for (const o of g.keyframes) out.push({ t: g.delay + (o / 100) * g.duration, g });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Alt+arrow: playhead to the next/previous keyframe of any element; selects it if it belongs to the edited animation. */
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
  if (S.dirty && !S.readonly) e.preventDefault();
});

$('#prop-list').replaceChildren(...KNOWN.map((p) => h('option', { value: p })));

/*
 * New deploys reach open tabs: the hosted server stamps the page with its version (<meta name="anni-version">)
 * and reports the current one on every event-stream connect (a deploy drops the stream, the tab reconnects)
 * and on /api/version, checked whenever the tab comes back into view. A tab without unsaved edits reloads
 * right away; one with edits says so and reloads after the next save. Local mode has no version: nothing happens.
 */
const BUILD = document.querySelector('meta[name="anni-version"]')?.content;

function checkVersion(version) {
  if (!BUILD || !version || version === BUILD || S.updatePending) return;
  if (!S.dirty) return location.reload();
  S.updatePending = true;
  banner([h('span', {}, 'anni was updated. Save to switch to the new editor – it reloads right after.'), h('button', { class: 'primary', onclick: saveNow }, 'Save')]);
}

function reloadIfUpdated() {
  if (S.updatePending && !S.dirty) setTimeout(() => location.reload(), 800); // let the save toast show first
}

if (BUILD) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    fetch(`${BASE}/api/version`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => checkVersion(d.version))
      .catch(() => {});
  });
}

let events;

/**
 * A hosted session talks over a WebSocket it can hibernate on: while nobody edits, an open tab costs nothing.
 * Same interface as EventSource – addEventListener(type, fn) with fn({ data }), close() – for messages
 * "type\n<json>"; it reconnects by itself (then fires `reconnect`). A ping every 30 s keeps the connection
 * open; the session answers it without waking up.
 */
function socketEvents(path) {
  const handlers = new Map();
  const fire = (type, data = '') => (handlers.get(type) || []).forEach((fn) => fn({ data }));
  const url = new URL(path, location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  let ping;
  let retry = 1000;
  let opened = false;
  let closed = false;
  const connect = () => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 1000;
      if (opened) fire('reconnect');
      opened = true;
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      const i = e.data.indexOf('\n');
      fire(i < 0 ? e.data : e.data.slice(0, i), i < 0 ? '' : e.data.slice(i + 1));
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (closed) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30000);
    };
    ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 30000);
  };
  connect();
  return {
    addEventListener: (type, fn) => handlers.set(type, [...(handlers.get(type) || []), fn]),
    close: () => {
      closed = true;
      clearInterval(ping);
      ws.close();
    },
  };
}

/** Server events (agent opened something, file changed on disk). The hosted root page has no session to follow. */
function listen() {
  if (events) return;
  const path = `${BASE}/api/events?tab=${TAB}&load=${LOAD}`; // neither EventSource nor WebSocket can send headers
  events = S.session?.hosted ? socketEvents(path) : new EventSource(path);
  events.addEventListener('version', (e) => checkVersion(JSON.parse(e.data).version));
  // Back after a dropped connection: catch up on what was missed meanwhile; the editing tab hands its state over again.
  events.addEventListener('reconnect', () => {
    refreshAccess().catch(() => {});
    if (S.readonly) followLiveState({}).catch(() => {});
    else if (S.model || S.schema) push();
  });
  events.addEventListener('access', () => refreshAccess().catch(() => {}));
  events.addEventListener('live', (e) => followLiveState(JSON.parse(e.data || '{}')).catch(() => {}));
  events.addEventListener('closed', () => showLock({ closed: true })); // the owner closed the session
  events.addEventListener('session', () => load());
  // The agent changed the files (a new element, another animation …): show it right away. The server has already
  // moved unsaved edits onto the new text, so nothing is lost.
  events.addEventListener('external-change', (e) => {
    const { conflicts = [] } = JSON.parse(e.data || '{}');
    const kept = S.dirty ? ' – your unsaved edits are kept' : '';
    load({ keepTime: true }).then(() =>
      toast(conflicts.length ? `Your agent changed ${conflicts.join(', ')} too – your unsaved values were kept` : `${S.session?.hosted ? 'Updated by your agent' : 'File changed on disk'}${kept}`),
    );
  });
}

load().then(() => {
  if (S.session || !S.hosted) listen();
});
