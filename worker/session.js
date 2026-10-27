// One editing session: the files an agent handed over, which of them is edited, the live model
// with unsaved edits, SSE streams to open editor tabs, and agents waiting for the next save.
import { applyModel, describe, kindOf, modelFromText, renderText } from '../src/css.js';
import { editorAsset, isEditorAsset, versionOf } from './assets.js';
import { changeMarkdown, changeSummary, cssChanges, lineDiff } from '../src/changes.js';

const STYLE_OPEN_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
const MAX_FILE = 1.5 * 1024 * 1024; // per uploaded file (storage values are capped at 2 MB)
const MAX_TOTAL = 24 * 1024 * 1024;
const MAX_FILES = 300;
const MAX_CONTROLS = 400;
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // a session is wiped after a week without activity

const NOINDEX = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...NOINDEX } });
const text = (body, type, status = 200) => new Response(body, { status, headers: { 'Content-Type': type, ...NOINDEX } });
const ext = (p) => (p.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();

/*
 * Access. Whoever starts a session gets an owner token (the agent's sidecar opens the link with it in the
 * #fragment; the editor keeps it as a cookie). Only its SHA-256 is stored. Other browsers are guests with a
 * token of their own (cookie anni_guest). Modes: public (anyone with the link may watch), request (guests ask,
 * the owner allows or declines), locked (owner only). Only the owner edits, from one tab at a time; everybody
 * else watches and can start their own copy. Sessions from before this, or from a sidecar that doesn't send
 * tokens, have no owner yet: the first browser that opens them claims them, and their agent API stays open.
 */
const MODES = ['public', 'request', 'locked'];
const EDIT_TIMEOUT_MS = 15000;
const toB64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const newToken = () => toB64url(crypto.getRandomValues(new Uint8Array(24)));
async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function cookie(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
const cleanName = (s) => (typeof s === 'string' ? s.trim().slice(0, 60) : '') || null;

export class AnniSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.streams = new Map(); // SSE controller of an open tab -> { tab, role }
    this.editTab = null; // { tab, seen }: the owner tab that may write (one at a time), and when it last spoke
    this.lastLive = 0;
    this.waiters = new Set(); // agents blocked in wait_for_save
    this.live = null; // last model the editor sent (may hold unsaved edits)
    this.dirty = false;
    this.ready = this.restore();
  }

  /** Files are stored one per key (`file:<path>`, text or { b64 }) so a snapshot with fonts fits the per-value limit. */
  async restore() {
    const m = await this.ctx.storage.get(['meta', 'files:index', 'files']);
    this.meta = m.get('meta') || null; // { kind, file, preview, animation, rev, savedAt } or the schema variant
    this.files = m.get('files') || {}; // legacy single-key layout
    const index = m.get('files:index') || [];
    for (let i = 0; i < index.length; i += 100) {
      const chunk = await this.ctx.storage.get(index.slice(i, i + 100).map((p) => `file:${p}`));
      for (const [k, v] of chunk) this.files[k.slice(5)] = v;
    }
  }

  /* ---------- helpers ---------- */

  get isSchema() {
    return this.meta?.kind === 'schema';
  }

  model() {
    return modelFromText(this.files[this.meta.file], kindOf(this.meta.file), this.meta.file);
  }

  controls() {
    return (this.meta.schema.groups || []).flatMap((g) => g.controls || []);
  }

  /** Sends an event to the open tabs, optionally only to those `to(info)` picks ({ tab, role }). */
  broadcast(event, data = {}, to = () => true) {
    const chunk = new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const [c, info] of this.streams) {
      if (!to(info)) continue;
      try {
        c.enqueue(chunk);
      } catch {
        this.streams.delete(c);
      }
    }
  }

  /* ---------- access ---------- */

  mode() {
    return this.meta?.access || 'public'; // sessions from before access control stay public
  }

  /** Who is asking: owner (token matches), viewer (public session or an allowed guest) or none. */
  async who(request) {
    const owner = this.meta?.owner;
    const ownerToken = request.headers.get('x-anni-owner') || cookie(request, 'anni_owner');
    const isOwner = !!(owner && ownerToken && (await hashToken(ownerToken)) === owner.tokenHash);
    const guestToken = cookie(request, 'anni_guest');
    const guestId = guestToken ? await hashToken(guestToken) : null;
    const guest = guestId ? this.meta?.guests?.[guestId] || null : null;
    const role = isOwner ? 'owner' : this.mode() === 'public' || guest?.status === 'approved' ? 'viewer' : 'none';
    const q = new URL(request.url).searchParams;
    const tab = request.headers.get('x-anni-tab') || q.get('tab') || null; // a browser tab, kept across its reloads
    const load = request.headers.get('x-anni-load') || q.get('load') || null; // one page load of it
    return { role, isOwner, guestId, guest, tab, load, claimable: !!this.meta && !owner };
  }

  /** The owner tab that edits; another owner tab takes over when the editing one is gone. */
  editorFor(who) {
    if (!who.isOwner || !who.tab) return false;
    // The editing tab sends a heartbeat every 5 s; after 15 s of silence it counts as gone.
    if (!this.editTab || Date.now() - this.editTab.seen > EDIT_TIMEOUT_MS) this.editTab = { tab: who.tab, load: who.load, seen: Date.now() };
    if (this.editTab.tab === who.tab) this.editTab.load = who.load; // a reload of the editing tab goes on editing
    return this.editTab.tab === who.tab;
  }

  accessInfo(who) {
    const guests = Object.entries(this.meta.guests || {}).map(([id, g]) => ({ id, ...g }));
    return {
      role: who.role,
      editor: this.editorFor(who),
      mode: this.mode(),
      owner: this.meta.owner?.name || null,
      ...(who.isOwner ? { requests: guests.filter((g) => g.status === 'pending'), allowed: guests.filter((g) => g.status === 'approved'), proposals: this.meta.proposals || [], rev: this.meta.rev } : {}),
    };
  }

  /** What a browser without access learns: the mode, whose it is, and how its own request stands. */
  lockedInfo(who) {
    return { mode: this.mode(), owner: this.meta.owner?.name || null, request: who.guest?.status || null };
  }

  /* ---------- exporting changes from a copy (proposals) ---------- */

  /**
   * A copy's changes against the state it was copied from, as the .anni.md a coding agent can apply. Saved state
   * only – the editor saves before it exports.
   */
  async buildExport() {
    const base = await this.ctx.storage.get('base');
    if (!this.meta.forkOf || !base) throw new Error('Only a copy of a session can export its changes');
    const at = Date.now();
    let changes;
    let diff = null;
    let file;
    if (this.isSchema) {
      file = this.meta.title;
      changes = this.controls()
        .filter((c) => (base.values?.[c.id] ?? c.value) !== this.meta.values[c.id])
        .map((c) => ({ id: c.id, label: c.label || c.id, type: c.type, from: base.values?.[c.id] ?? c.value, to: this.meta.values[c.id], source: c.source || null }));
    } else {
      file = this.meta.file;
      const text = this.files[file];
      changes = cssChanges(base.content, text, kindOf(file), file);
      diff = lineDiff(base.content.replace(/\r\n/g, '\n'), text.replace(/\r\n/g, '\n'), file);
    }
    const author = this.meta.owner?.name || null;
    const markdown = changeMarkdown({ author, at, file, parent: this.meta.forkOf.session, rev: this.meta.forkOf.rev, changes, diff, schema: this.isSchema });
    const summary = changeSummary(changes, this.isSchema);
    return { at, author, file, summary, markdown, count: changes.length };
  }

  /** The session a copy came from receives its export. One proposal per copy: a newer export replaces the older. */
  async receiveProposal(p) {
    if (!this.meta) throw new Error('The original session no longer exists');
    const id = p.from;
    const entry = { id, from: p.from, url: p.url || null, author: cleanName(p.author) || 'Someone', at: p.at, summary: String(p.summary || '').slice(0, 300), baseRev: p.baseRev, read: false };
    this.meta.proposals = [entry, ...(this.meta.proposals || []).filter((x) => x.id !== id)].slice(0, 30);
    await this.ctx.storage.put(`proposal:${id}`, String(p.markdown));
    await this.persist();
    this.broadcast('access', {}, (s) => s.role === 'owner');
  }

  /** owner / access / guests survive the agent re-opening the session with new files. */
  carryAccess(prev) {
    return prev ? { owner: prev.owner, access: prev.access, guests: prev.guests, forkOf: prev.forkOf, proposals: prev.proposals, id: prev.id, url: prev.url } : {};
  }

  /** Files and setup of this session, for "Edit a copy". */
  exportSession() {
    const files = Object.entries(this.files).map(([p, c]) => (typeof c === 'string' ? { path: p, content: c } : { path: p, content: c.b64, encoding: 'base64' }));
    if (this.isSchema) {
      // The copy starts from the values as last saved here.
      const schema = { ...this.meta.schema, groups: this.meta.schema.groups.map((g) => ({ ...g, controls: g.controls.map((c) => ({ ...c, value: this.meta.values[c.id] ?? c.value })) })) };
      return { files, preview: this.meta.preview, schema, title: this.meta.title, rev: this.meta.rev, owner: this.meta.owner?.name || null };
    }
    return { files, file: this.meta.file, preview: this.meta.preview, animation: this.meta.animation, rev: this.meta.rev, owner: this.meta.owner?.name || null };
  }

  /** Expiry: every open/save pushes the alarm out; when it fires the session is deleted entirely. */
  async touch() {
    await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
  }

  async alarm() {
    for (const c of this.streams.keys()) {
      try {
        c.close();
      } catch {}
    }
    this.streams.clear();
    for (const w of this.waiters) w.resolve(false);
    this.waiters.clear();
    this.meta = null;
    this.files = {};
    this.live = null;
    await this.ctx.storage.deleteAll();
  }

  async persist() {
    await this.touch();
    const old = (await this.ctx.storage.get('files:index')) || [];
    const paths = Object.keys(this.files);
    const gone = old.filter((p) => !(p in this.files)).map((p) => `file:${p}`);
    if (gone.length) await this.ctx.storage.delete(gone);
    await this.ctx.storage.delete('files'); // legacy layout
    const entries = Object.entries(this.files);
    for (let i = 0; i < entries.length; i += 100) await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 100).map(([p, c]) => [`file:${p}`, c])));
    await this.ctx.storage.put({ meta: this.meta, 'files:index': paths });
  }

  /** Normalises uploaded files: text stays text, base64 uploads become { b64 }; oversize files are skipped and reported. */
  static intake(files) {
    if (files.length > MAX_FILES) throw new Error(`Too many files (${files.length}; the limit is ${MAX_FILES})`);
    const map = {};
    const skipped = [];
    let total = 0;
    for (const f of files) {
      if (typeof f?.path !== 'string' || typeof f?.content !== 'string') throw new Error('each file needs a string path and content');
      if (f.path.includes('..')) throw new Error(`invalid path "${f.path}"`);
      const p = f.path.replace(/^\.?\//, '');
      const size = f.encoding === 'base64' ? Math.floor((f.content.length * 3) / 4) : f.content.length;
      if (size > MAX_FILE || total + size > MAX_TOTAL) {
        skipped.push(`${p} (${(size / 1024).toFixed(0)} KB)`);
        continue;
      }
      total += size;
      map[p] = f.encoding === 'base64' ? { b64: f.content } : f.content;
    }
    return { map, skipped };
  }

  stateText() {
    if (!this.meta) return 'This anni session has nothing open.';
    if (this.isSchema) {
      const lines = [`Schema session "${this.meta.title}" – saved revision ${this.meta.rev}${this.dirty ? ', the editor has UNSAVED edits' : ''}.`, ''];
      for (const g of this.meta.schema.groups || []) {
        lines.push(`${g.label || ''}`);
        for (const c of g.controls || []) lines.push(`  ${c.id} (${c.label || c.id}, ${c.type}): ${this.meta.values[c.id]}${this.meta.values[c.id] !== this.meta.initial[c.id] ? `   [was ${this.meta.initial[c.id]}]` : ''}`);
      }
      return lines.join('\n');
    }
    const model = this.live || this.model();
    const lines = [
      `File: ${this.meta.file}`,
      `Selected animation: ${this.meta.animation}`,
      this.dirty ? 'The editor has UNSAVED changes (shown below; not yet handed back).' : `No unsaved changes. Saved revision: ${this.meta.rev}.`,
      '',
    ];
    for (const anim of model.animations) lines.push(describe(anim), '');
    return lines.join('\n');
  }

  payload(base) {
    if (!this.meta) return { session: null, hosted: true };
    const site = (p) => `${base}/site/${p.split('/').map(encodeURIComponent).join('/')}`;
    if (this.isSchema) {
      return {
        session: { kind: 'schema', title: this.meta.title, file: this.meta.title, previewUrl: this.meta.preview ? site(this.meta.preview) : null, dirty: this.dirty, hosted: true, rev: this.meta.rev, forkOf: this.meta.forkOf || null },
        schema: this.meta.schema,
        values: this.dirty && this.live ? this.live : this.meta.values,
      };
    }
    const fresh = this.model();
    const model = this.dirty && this.live ? { ...fresh, animations: this.live.animations } : fresh;
    return {
      session: {
        file: this.meta.file,
        animation: this.meta.animation,
        kind: model.kind,
        previewUrl: this.meta.preview ? site(this.meta.preview) : null,
        cssUrl: model.kind === 'css' ? site(this.meta.file) : null,
        demoUrl: `${base}/demo`,
        dirty: this.dirty,
        hosted: true,
        rev: this.meta.rev,
        forkOf: this.meta.forkOf || null,
      },
      model,
    };
  }

  demoPage(base) {
    const { css } = renderText(this.files[this.meta.file], kindOf(this.meta.file), this.live || this.model(), this.meta.file);
    const dir = this.meta.file.includes('/') ? this.meta.file.slice(0, this.meta.file.lastIndexOf('/') + 1) : '';
    const styles = css.map((t, i) => `<style data-anni-src="${i}">${t}</style>`).join('\n');
    return `<!doctype html><html><head><meta charset="utf-8"><base href="${base}/site/${dir}">
${styles}
<style>
html, body { margin: 0 !important; height: 100% !important; }
body { display: grid !important; place-items: center !important; background: transparent !important; overflow: hidden; }
#anni-demo { width: 96px; height: 96px; border-radius: 18px; background: #e97130; color: #fafaf9;
  display: grid; place-items: center; font: 600 28px/1 system-ui, sans-serif; }
</style></head><body><div id="anni-demo">Aa</div></body></html>`;
  }

  /* ---------- agent side (called by the MCP tools through the stub) ---------- */

  /**
   * Agent opens (or re-opens) the session. A new session started by a client that handles tokens (`auth`)
   * gets an owner token, returned once; it starts in request mode. Re-opening keeps owner, mode and guests.
   */
  async open(body) {
    const fresh = !this.meta;
    const access = this.carryAccess(this.meta);
    let token = null;
    if (body.id) access.id = body.id; // own id and link, for proposals sent to the session it was copied from
    if (body.url) access.url = body.url;
    if (fresh) {
      access.access = 'request';
      // A copy ("Edit a copy"): where it came from, and the state it started from, to export changes against.
      if (body.forkOf) access.forkOf = { session: body.forkOf.session, rev: body.forkOf.rev, owner: cleanName(body.forkOf.owner), at: Date.now() };
      if (body.auth) {
        token = newToken();
        access.owner = { tokenHash: await hashToken(token), name: cleanName(body.ownerName), api: true, at: Date.now() };
      }
    }
    const r = await this.openFiles(body, access);
    if (fresh && body.forkOf && body.base) await this.ctx.storage.put('base', body.base);
    return token ? { ...r, token } : r;
  }

  async openFiles({ files = [], file, preview, animation, schema, title }, access) {
    const { map, skipped } = AnniSession.intake(files);
    if (preview) preview = preview.replace(/^\.?\//, '');
    if (schema) return { ...(await this.openSchema({ map, preview, schema, title, access })), skipped };
    file = file.replace(/^\.?\//, '');
    if (!(file in map)) throw new Error(`"${file}" is not among the uploaded files${skipped.length ? ` (skipped as too large: ${skipped.join(', ')})` : ''}`);
    if (typeof map[file] !== 'string') throw new Error(`"${file}" must be uploaded as text`);
    const model = modelFromText(map[file], kindOf(file), file);
    if (!model.animations.length) throw new Error(`No @keyframes found in ${file}`);
    if (animation && !model.animations.some((a) => a.name === animation)) {
      throw new Error(`No @keyframes "${animation}" in ${file}. Found: ${model.animations.map((a) => a.name).join(', ')}`);
    }
    if (!preview && kindOf(file) === 'html') preview = file;
    else if (!preview) preview = Object.keys(map).find((p) => /\.html?$/i.test(p) && map[p].includes(file.split('/').pop())) || null;
    if (preview && !(preview in map)) throw new Error(`Preview page "${preview}" is not among the uploaded files`);
    this.files = map;
    this.meta = { kind: 'css', file, preview, animation: animation || model.animations[0].name, rev: this.meta?.rev || 0, savedAt: null, openedAt: Date.now(), ...access };
    this.live = null;
    this.dirty = false;
    await this.persist();
    this.broadcast('session', { file, animation: this.meta.animation });
    return { kind: 'css', file, preview, animation: this.meta.animation, animations: model.animations, clients: this.streams.size, rev: this.meta.rev, skipped };
  }

  /** A schema session: the agent describes controls (with preview and code wires); anni renders them. */
  async openSchema({ map, preview, schema, title, access }) {
    if (!schema || !Array.isArray(schema.groups) || !schema.groups.length) throw new Error('schema.groups must be a non-empty array');
    if (schema.groups.reduce((n, g) => n + (g.controls?.length || 0), 0) > MAX_CONTROLS) throw new Error(`Too many controls (the limit is ${MAX_CONTROLS})`);
    const ids = new Set();
    for (const g of schema.groups) {
      if (!Array.isArray(g.controls)) throw new Error(`group "${g.label}" has no controls[]`);
      for (const c of g.controls) {
        if (!c.id || typeof c.id !== 'string') throw new Error('every control needs a string id');
        if (ids.has(c.id)) throw new Error(`duplicate control id "${c.id}"`);
        ids.add(c.id);
        if (!['number', 'length', 'color', 'enum', 'boolean', 'text'].includes(c.type)) throw new Error(`control "${c.id}": unknown type "${c.type}"`);
        if (c.value === undefined || c.value === null) throw new Error(`control "${c.id}" needs a value`);
        c.value = String(c.value);
      }
    }
    if (preview && !(preview in map)) throw new Error(`Preview page "${preview}" is not among the uploaded files`);
    const values = Object.fromEntries([...schema.groups.flatMap((g) => g.controls)].map((c) => [c.id, c.value]));
    this.files = map;
    this.meta = { kind: 'schema', title: title || schema.title || 'Controls', preview, schema, values, initial: { ...values }, rev: this.meta?.rev || 0, savedAt: null, openedAt: Date.now(), ...access };
    this.live = null;
    this.dirty = false;
    await this.persist();
    this.broadcast('session', { title: this.meta.title });
    return { kind: 'schema', title: this.meta.title, preview, controls: ids.size, clients: this.streams.size, rev: this.meta.rev };
  }

  /** Resolves when the editor saves a revision newer than `since`, or after `timeout` ms. */
  waitForSave(since, timeout) {
    if (this.meta && this.meta.rev > since) return Promise.resolve(this.saveResult(true));
    return new Promise((resolve) => {
      const w = { resolve: (saved) => resolve(this.saveResult(saved)) };
      this.waiters.add(w);
      setTimeout(() => {
        if (this.waiters.delete(w)) w.resolve(false);
      }, timeout);
    });
  }

  saveResult(saved) {
    if (!this.meta) return { saved: false, rev: 0, dirty: false };
    if (this.isSchema) {
      return { saved, rev: this.meta.rev, dirty: this.dirty, kind: 'schema', title: this.meta.title, changes: this.meta.lastChanges || [], values: this.meta.values, state: this.stateText() };
    }
    const files = (this.meta.lastFiles || [this.meta.file]).map((p) => ({ path: p, content: this.files[p] }));
    return { saved, rev: this.meta.rev, dirty: this.dirty, kind: 'css', file: this.meta.file, content: this.files[this.meta.file], files, changes: this.meta.lastChanges || [], state: this.stateText() };
  }

  /**
   * Applies editor-view edits (changed declarations with code wires into uploaded files) to the stored files.
   * Same contract as the sidecar's applyWire: `find` must occur exactly once. Returns what was applied / left for the agent.
   */
  applyEdits(edits) {
    const applied = [];
    const manual = [];
    const touched = new Set();
    for (const e of edits) {
      const s = e.source;
      const file = s?.file?.replace(/^\.?\//, '');
      if (!s || !(file in this.files) || typeof this.files[file] !== 'string') {
        manual.push({ ...e, reason: s ? `${s.file} is not an uploaded text file` : 'no source wire' });
        continue;
      }
      const before = this.files[file];
      let after = null;
      if (s.find) {
        const n = before.split(s.find).length - 1;
        if (n === 1) {
          const repl = s.replace ? s.replace.replaceAll('{{value}}', e.to) : s.find.includes(e.from) ? s.find.replace(e.from, e.to) : null;
          if (repl !== null) after = before.replace(s.find, repl);
        }
      } else if (s.range) after = before.slice(0, s.range[0]) + (s.template || '{{value}}').replaceAll('{{value}}', e.to) + before.slice(s.range[1]);
      if (after === null || after === before) {
        manual.push({ ...e, reason: 'wire did not match exactly once' });
        continue;
      }
      this.files[file] = after;
      touched.add(file);
      applied.push({ id: e.id, label: e.label, from: e.from, to: e.to, file });
    }
    return { applied, manual, touched };
  }

  /** Schema save: records the values, lists what changed since the last save (with each control's code wire). */
  async saveSchema(values) {
    const changes = [];
    for (const c of this.controls()) {
      const to = values[c.id];
      if (to === undefined || to === this.meta.values[c.id]) continue;
      changes.push({ id: c.id, label: c.label || c.id, type: c.type, from: this.meta.values[c.id], to: String(to), source: c.source || null });
      this.meta.values[c.id] = String(to);
    }
    this.live = null;
    this.dirty = false;
    if (changes.length) {
      this.meta.rev++;
      this.meta.savedAt = Date.now();
      this.meta.lastChanges = changes;
    }
    await this.persist();
    for (const w of this.waiters) w.resolve(true);
    this.waiters.clear();
    this.followLive(true);
    return { changed: changes.length > 0, changes, rev: this.meta.rev, values: this.meta.values };
  }

  /* ---------- HTTP (editor + agent via stub.fetch) ---------- */

  async fetch(request) {
    // After a deploy this object can keep running the old code while open tabs hold it alive. The Worker
    // stamps each request with the current version; on a mismatch the object resets itself and the Worker
    // retries, which starts it on the new code (its storage survives, the streams reconnect).
    const want = request.headers.get('x-anni-version');
    if (want && this.env.CF_VERSION_METADATA?.id && want !== versionOf(this.env)) this.ctx.abort('anni was deployed');
    await this.ready;
    const url = new URL(request.url);
    const base = request.headers.get('x-anni-base') || '';
    const route = `${request.method} ${url.pathname}`;
    try {
      const who = await this.who(request);
      if (who.tab && who.tab === this.editTab?.tab) this.editTab.seen = Date.now(); // anything the editing tab sends counts as a heartbeat
      // Agent side (only reachable through the Worker, never from a browser). Sessions whose owner token came
      // from the agent require it; older ones stay open so their sidecars keep working.
      if (url.pathname.startsWith('/internal/')) {
        if (this.meta?.owner?.api && !who.isOwner) return json({ error: 'This anni session belongs to someone else (owner token missing or wrong)' }, 403);
        if (route === 'POST /internal/open') return json(await this.open(await request.json()));
        if (route === 'GET /internal/state') return json({ text: this.stateText(), dirty: this.dirty, hasSession: !!this.meta, rev: this.meta?.rev || 0 });
        if (route === 'GET /internal/wait') {
          const since = Number(url.searchParams.get('since') || 0);
          const timeout = Math.min(Number(url.searchParams.get('timeout') || 45000), 55000); // MCP clients give up at 60 s
          return json(await this.waitForSave(since, timeout));
        }
        if (route === 'GET /internal/proposals') {
          // Changes exported from copies, newest first, as the agent applies them.
          const list = this.meta?.proposals || [];
          const proposals = await Promise.all(list.map(async (p) => ({ ...p, markdown: await this.ctx.storage.get(`proposal:${p.id}`) })));
          return json({ proposals, rev: this.meta?.rev || 0 });
        }
        return json({ error: 'Not found' }, 404);
      }
      // Session to session only (blocked in the Worker): a copy hands its exported changes to its original.
      if (route === 'POST /proposal') {
        await this.receiveProposal(await request.json());
        return json({ ok: true });
      }
      // "Edit a copy" (the Worker creates the new session): anyone who may watch may copy.
      if (route === 'GET /export') {
        if (!this.meta || who.role === 'none') return json({ error: 'No access to this session' }, 403);
        return json(this.exportSession());
      }

      if (route === 'GET /api/ping') return json({ app: 'anni', hosted: true });
      if (route === 'GET /api/version') return json({ version: versionOf(this.env) });
      if (route === 'GET /api/session') {
        if (!this.meta) return json(this.payload(base));
        if (who.claimable) return json({ session: null, hosted: true, claimable: true });
        if (who.role === 'none') return json({ session: null, hosted: true, locked: this.lockedInfo(who) });
        return json({ ...this.payload(base), access: this.accessInfo(who) });
      }
      if (!this.meta && url.pathname.startsWith('/api/')) return json({ error: 'No animation open in this session' }, 409);

      // A session without an owner yet (from before access control, or from an older sidecar): the first browser takes it.
      if (route === 'POST /api/claim') {
        if (!who.claimable) return json({ error: 'This session already has an owner' }, 409);
        const { token, name } = await request.json();
        if (typeof token !== 'string' || token.length < 20) return json({ error: 'Bad token' }, 400);
        this.meta.owner = { tokenHash: await hashToken(token), name: cleanName(name), api: false, at: Date.now() };
        await this.persist();
        return json({ ok: true });
      }
      // A guest asks for access (request mode only).
      if (route === 'POST /api/request') {
        if (who.role !== 'none') return json({ ok: true });
        if (this.mode() !== 'request') return json({ error: 'This session is locked' }, 403);
        if (!who.guestId) return json({ error: 'Missing guest id' }, 400);
        const { name, note } = await request.json();
        const prev = this.meta.guests?.[who.guestId];
        if (prev?.status === 'denied') return json({ error: 'Your request was declined' }, 403);
        this.meta.guests = { ...this.meta.guests, [who.guestId]: { name: cleanName(name) || 'Someone', note: typeof note === 'string' ? note.slice(0, 280) : '', status: 'pending', at: Date.now() } };
        await this.persist();
        this.broadcast('access', {}, (s) => s.role === 'owner');
        return json({ ok: true });
      }

      if (who.role === 'none') return json({ error: 'No access to this session' }, 403);
      if (route === 'GET /api/events') return this.events(who);
      if (route === 'POST /api/alive') return json({ editor: this.editorFor(who) }); // the editing tab's heartbeat
      if (route === 'POST /api/bye') {
        this.dropLoad(who.load); // sent by a page that is being closed or reloaded
        return json({ ok: true });
      }
      if (route === 'GET /api/state') return json({ text: this.stateText(), dirty: this.dirty, hasSession: true });

      // Proposals from copies: the owner reads (marks read) or dismisses them.
      if (route === 'GET /api/proposal' || route === 'POST /api/proposal/dismiss') {
        if (!who.isOwner) return json({ error: 'Only the owner can do this' }, 403);
        const id = route === 'GET /api/proposal' ? url.searchParams.get('id') : (await request.json()).id;
        const entry = this.meta.proposals?.find((p) => p.id === id);
        if (!entry) return json({ error: 'No such proposal' }, 404);
        if (route === 'GET /api/proposal') {
          entry.read = true;
          await this.persist();
          this.broadcast('access', {}, (s) => s.role === 'owner');
          return json({ ...entry, markdown: await this.ctx.storage.get(`proposal:${id}`), rev: this.meta.rev });
        }
        this.meta.proposals = this.meta.proposals.filter((p) => p.id !== id);
        await this.ctx.storage.delete(`proposal:${id}`);
        await this.persist();
        this.broadcast('access', {}, (s) => s.role === 'owner');
        return json({ ok: true, access: this.accessInfo(who) });
      }
      // A copy's owner exports its changes: they go to the original session's owner and come back as a file.
      if (route === 'POST /api/export') {
        if (!who.isOwner) return json({ error: 'Only the owner of this copy can export it' }, 403);
        const r = await this.buildExport();
        let delivered = false;
        try {
          const parent = this.env.ANNI_SESSION.get(this.env.ANNI_SESSION.idFromName(this.meta.forkOf.session));
          const res = await parent.fetch(
            new Request('https://session.invalid/proposal', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: this.meta.id, url: this.meta.url, author: r.author, at: r.at, summary: r.summary, markdown: r.markdown, baseRev: this.meta.forkOf.rev }),
            }),
          );
          delivered = res.ok;
        } catch {}
        this.meta.forkOf.exportedAt = r.at;
        await this.persist();
        return json({ ...r, delivered, owner: this.meta.forkOf.owner });
      }

      // Owner-only settings.
      if (['/api/access', '/api/answer', '/api/revoke', '/api/name', '/api/take'].includes(url.pathname)) {
        if (!who.isOwner) return json({ error: 'Only the owner can do this' }, 403);
        const body = request.method === 'POST' ? await request.json() : {};
        if (url.pathname === '/api/access') {
          if (!MODES.includes(body.mode)) return json({ error: 'Unknown mode' }, 400);
          this.meta.access = body.mode;
        } else if (url.pathname === '/api/answer') {
          const g = this.meta.guests?.[body.guest];
          if (!g) return json({ error: 'No such request' }, 404);
          g.status = body.allow ? 'approved' : 'denied';
        } else if (url.pathname === '/api/revoke') {
          if (this.meta.guests) delete this.meta.guests[body.guest];
        } else if (url.pathname === '/api/name') {
          this.meta.owner.name = cleanName(body.name);
        } else if (url.pathname === '/api/take') {
          this.editTab = { tab: who.tab, load: who.load, seen: Date.now() };
          this.broadcast('access', {}, (s) => s.role === 'owner');
          return json({ ok: true });
        }
        await this.persist();
        this.broadcast('access', {}); // viewers may have just lost (or got) access
        return json({ ok: true, access: this.accessInfo(who) });
      }

      const editor = this.editorFor(who);
      if (route === 'POST /api/select') {
        if (!editor) return json({ ok: true }); // watchers follow along, they don't steer
        this.meta.animation = (await request.json()).animation;
        await this.persist();
        return json({ ok: true });
      }
      if (route === 'POST /api/render') {
        const { model, values, dirty } = await request.json();
        // Only the editing tab's state counts; watchers get their preview CSS and nothing else.
        if (editor) {
          this.dirty = !!dirty;
          this.live = this.isSchema ? values || null : model;
          this.followLive();
        }
        if (this.isSchema) return json({ ok: true }); // the editor applies preview wires itself
        return json({ css: renderText(this.files[this.meta.file], kindOf(this.meta.file), model, this.meta.file).css });
      }
      if (route === 'POST /api/save') {
        if (!editor) return json({ error: who.isOwner ? 'This session is being edited in another tab' : 'Only the owner can save – edit a copy instead' }, 403);
        const { model, values, edits = [] } = await request.json();
        if (this.isSchema) return json(await this.saveSchema(values || {}));
        const before = this.files[this.meta.file];
        const after = model ? applyModel(before, kindOf(this.meta.file), model, this.meta.file) : before;
        const touched = new Set();
        if (after !== before) {
          this.files[this.meta.file] = after;
          touched.add(this.meta.file);
        }
        const r = this.applyEdits(edits);
        for (const f of r.touched) touched.add(f);
        const changed = touched.size > 0;
        this.live = null;
        this.dirty = false;
        if (changed) {
          this.meta.rev++;
          this.meta.savedAt = Date.now();
          this.meta.lastFiles = [...touched];
          this.meta.lastChanges = [...r.applied.map((a) => ({ ...a, applied: true })), ...r.manual.map((m) => ({ id: m.id, label: m.label, from: m.from, to: m.to, source: m.source || null, applied: false, reason: m.reason }))];
        }
        await this.persist();
        for (const w of this.waiters) w.resolve(true);
        this.waiters.clear();
        this.followLive(true);
        return json({ changed, model: this.model(), rev: this.meta.rev, applied: r.applied, manual: r.manual, files: [...touched] });
      }

      if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
      if (url.pathname === '/demo' && this.meta && !this.isSchema) return text(this.demoPage(base), MIME['.html']);
      if (url.pathname.startsWith('/site/')) {
        const p = decodeURIComponent(url.pathname.slice('/site/'.length));
        if (!(p in this.files)) return text('Not found', 'text/plain', 404);
        let body = this.files[p];
        if (typeof body !== 'string') {
          const bytes = Uint8Array.from(atob(body.b64), (c) => c.charCodeAt(0));
          return new Response(bytes, { headers: { 'Content-Type': MIME[ext(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' } });
        }
        // Tag the <style> blocks of the edited HTML file so the editor can swap their contents live.
        if (p === this.meta?.file && !this.isSchema && kindOf(p) === 'html') {
          let i = 0;
          body = body.replace(STYLE_OPEN_RE, (_, open, css, close) => open.replace(/^<style/i, `<style data-anni-src="${i++}"`) + css + close);
        }
        return text(body, MIME[ext(p)] || 'application/octet-stream');
      }
      if (isEditorAsset(url.pathname)) return editorAsset(this.env, request, url.pathname);
      return text('Not found', 'text/plain', 404);
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  }

  /** A page is gone (closed, reloaded, connection lost): forget its streams; if it was editing, another owner tab may take over. */
  dropLoad(load) {
    if (!load) return;
    for (const [c, info] of this.streams) {
      if (info.load !== load) continue;
      this.streams.delete(c);
      try {
        c.close();
      } catch {}
    }
    // Only if the editing tab hasn't been reloaded meanwhile – its new page load keeps editing.
    if (load === this.editTab?.load) {
      this.editTab = null;
      this.broadcast('access', {}, (s) => s.role === 'owner');
    }
  }

  /** Watching tabs (everyone but the editing tab) reload the live state – at most every 250 ms while editing. */
  followLive(now = false) {
    if (!now && Date.now() - this.lastLive < 250) {
      this.liveTimer ||= setTimeout(() => {
        this.liveTimer = null;
        this.followLive(true);
      }, 250);
      return;
    }
    this.lastLive = Date.now();
    this.broadcast('live', {}, (s) => s.tab !== this.editTab?.tab);
  }

  events(who) {
    let controller;
    let ping;
    const stream = new ReadableStream({
      start: (c) => {
        controller = c;
        // A deploy restarts this object and drops the stream; the tab reconnects and learns the new version here.
        c.enqueue(new TextEncoder().encode(`event: version\ndata: ${JSON.stringify({ version: versionOf(this.env) })}\n\n`));
        this.streams.set(c, { tab: who.tab, load: who.load, role: who.role });
        ping = setInterval(() => {
          try {
            c.enqueue(new TextEncoder().encode(': ping\n\n'));
          } catch {
            clearInterval(ping);
            this.streams.delete(c);
            this.dropLoad(who.load);
          }
        }, 25000);
      },
      cancel: () => {
        clearInterval(ping);
        this.streams.delete(controller);
        this.dropLoad(who.load); // if it was editing, the owner's other tabs re-check and one takes over
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' } });
  }
}
