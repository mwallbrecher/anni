// One editing session: the files an agent handed over, which of them is edited, the live model
// with unsaved edits, SSE streams to open editor tabs, and agents waiting for the next save.
import { applyModel, describe, kindOf, modelFromText, renderText } from '../src/css.js';

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
const EDITOR_ASSETS = new Set(['/', '/index.html', '/app.js', '/props.js', '/aurora.js', '/style.css']);
const isEditorAsset = (p) => EDITOR_ASSETS.has(p) || p.startsWith('/brand/') || p.startsWith('/fonts/');

const NOINDEX = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...NOINDEX } });
const text = (body, type, status = 200) => new Response(body, { status, headers: { 'Content-Type': type, ...NOINDEX } });
const ext = (p) => (p.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();

export class AnniSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.streams = new Set(); // SSE controllers of open editor tabs
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

  broadcast(event, data = {}) {
    const chunk = new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const c of this.streams) {
      try {
        c.enqueue(chunk);
      } catch {
        this.streams.delete(c);
      }
    }
  }

  /** Expiry: every open/save pushes the alarm out; when it fires the session is deleted entirely. */
  async touch() {
    await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
  }

  async alarm() {
    for (const c of this.streams) {
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
        session: { kind: 'schema', title: this.meta.title, file: this.meta.title, previewUrl: this.meta.preview ? site(this.meta.preview) : null, dirty: this.dirty, hosted: true, rev: this.meta.rev },
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

  async open({ files = [], file, preview, animation, schema, title }) {
    const { map, skipped } = AnniSession.intake(files);
    if (preview) preview = preview.replace(/^\.?\//, '');
    if (schema) return { ...(await this.openSchema({ map, preview, schema, title })), skipped };
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
    this.meta = { kind: 'css', file, preview, animation: animation || model.animations[0].name, rev: this.meta?.rev || 0, savedAt: null, openedAt: Date.now() };
    this.live = null;
    this.dirty = false;
    await this.persist();
    this.broadcast('session', { file, animation: this.meta.animation });
    return { kind: 'css', file, preview, animation: this.meta.animation, animations: model.animations, clients: this.streams.size, rev: this.meta.rev, skipped };
  }

  /** A schema session: the agent describes controls (with preview and code wires); anni renders them. */
  async openSchema({ map, preview, schema, title }) {
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
    this.meta = { kind: 'schema', title: title || schema.title || 'Controls', preview, schema, values, initial: { ...values }, rev: this.meta?.rev || 0, savedAt: null, openedAt: Date.now() };
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
    return { changed: changes.length > 0, changes, rev: this.meta.rev, values: this.meta.values };
  }

  /* ---------- HTTP (editor + agent via stub.fetch) ---------- */

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const base = request.headers.get('x-anni-base') || '';
    const route = `${request.method} ${url.pathname}`;
    try {
      if (route === 'POST /internal/open') return json(await this.open(await request.json()));
      if (route === 'GET /internal/state') return json({ text: this.stateText(), dirty: this.dirty, hasSession: !!this.meta, rev: this.meta?.rev || 0 });
      if (route === 'GET /internal/wait') {
        const since = Number(url.searchParams.get('since') || 0);
        const timeout = Math.min(Number(url.searchParams.get('timeout') || 60000), 5 * 60 * 1000);
        return json(await this.waitForSave(since, timeout));
      }

      if (route === 'GET /api/ping') return json({ app: 'anni', hosted: true });
      if (route === 'GET /api/session') return json(this.payload(base));
      if (route === 'GET /api/events') return this.events();
      if (!this.meta && url.pathname.startsWith('/api/')) return json({ error: 'No animation open in this session' }, 409);
      if (route === 'GET /api/state') return json({ text: this.stateText(), dirty: this.dirty, hasSession: true });
      if (route === 'POST /api/select') {
        this.meta.animation = (await request.json()).animation;
        await this.persist();
        return json({ ok: true });
      }
      if (route === 'POST /api/render') {
        const { model, values, dirty } = await request.json();
        this.dirty = !!dirty;
        if (this.isSchema) {
          this.live = values || null; // the editor applies preview wires itself; we only remember the unsaved state
          return json({ ok: true });
        }
        this.live = model;
        return json({ css: renderText(this.files[this.meta.file], kindOf(this.meta.file), model, this.meta.file).css });
      }
      if (route === 'POST /api/save') {
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
      if (isEditorAsset(url.pathname)) {
        const res = await this.env.ASSETS.fetch(new Request(new URL(url.pathname === '/' ? '/index.html' : url.pathname, 'https://assets.invalid'), { headers: request.headers }));
        const headers = new Headers(res.headers);
        headers.set('X-Robots-Tag', 'noindex, nofollow');
        return new Response(res.body, { status: res.status, headers });
      }
      return text('Not found', 'text/plain', 404);
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  }

  events() {
    let controller;
    let ping;
    const stream = new ReadableStream({
      start: (c) => {
        controller = c;
        c.enqueue(new TextEncoder().encode(': hi\n\n'));
        this.streams.add(c);
        ping = setInterval(() => {
          try {
            c.enqueue(new TextEncoder().encode(': ping\n\n'));
          } catch {
            clearInterval(ping);
            this.streams.delete(c);
          }
        }, 25000);
      },
      cancel: () => {
        clearInterval(ping);
        this.streams.delete(controller);
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' } });
  }
}
