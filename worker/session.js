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
};
const EDITOR_ASSETS = new Set(['/', '/index.html', '/app.js', '/props.js', '/style.css']);

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const text = (body, type, status = 200) => new Response(body, { status, headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
const ext = (p) => (p.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();

export class AnniSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.streams = new Set(); // SSE controllers of open editor tabs
    this.waiters = new Set(); // agents blocked in wait_for_save
    this.live = null; // last model the editor sent (may hold unsaved edits)
    this.dirty = false;
    this.ready = ctx.storage.get(['files', 'meta']).then((m) => {
      this.files = m.get('files') || {};
      this.meta = m.get('meta') || null; // { file, preview, animation, rev, savedAt }
    });
  }

  /* ---------- helpers ---------- */

  model() {
    return modelFromText(this.files[this.meta.file], kindOf(this.meta.file), this.meta.file);
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

  async persist() {
    await this.ctx.storage.put({ files: this.files, meta: this.meta });
  }

  stateText() {
    if (!this.meta) return 'This anni session has no animation open.';
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
    const fresh = this.model();
    const model = this.dirty && this.live ? { ...fresh, animations: this.live.animations } : fresh;
    const site = (p) => `${base}/site/${p.split('/').map(encodeURIComponent).join('/')}`;
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
#anni-demo { width: 96px; height: 96px; border-radius: 18px; background: #3d9bff; color: #fff;
  display: grid; place-items: center; font: 600 28px/1 system-ui, sans-serif; }
</style></head><body><div id="anni-demo">Aa</div></body></html>`;
  }

  /* ---------- agent side (called by the MCP tools through the stub) ---------- */

  async open({ files, file, preview, animation }) {
    const map = {};
    for (const f of files) map[f.path.replace(/^\.?\//, '')] = f.content;
    file = file.replace(/^\.?\//, '');
    if (!(file in map)) throw new Error(`"${file}" is not among the uploaded files`);
    const model = modelFromText(map[file], kindOf(file), file);
    if (!model.animations.length) throw new Error(`No @keyframes found in ${file}`);
    if (animation && !model.animations.some((a) => a.name === animation)) {
      throw new Error(`No @keyframes "${animation}" in ${file}. Found: ${model.animations.map((a) => a.name).join(', ')}`);
    }
    if (preview) preview = preview.replace(/^\.?\//, '');
    else if (kindOf(file) === 'html') preview = file;
    else preview = Object.keys(map).find((p) => /\.html?$/i.test(p) && map[p].includes(file.split('/').pop())) || null;
    if (preview && !(preview in map)) throw new Error(`Preview page "${preview}" is not among the uploaded files`);
    this.files = map;
    this.meta = { file, preview, animation: animation || model.animations[0].name, rev: this.meta?.rev || 0, savedAt: null, openedAt: Date.now() };
    this.live = null;
    this.dirty = false;
    await this.persist();
    this.broadcast('session', { file, animation: this.meta.animation });
    return { file, preview, animation: this.meta.animation, animations: model.animations, clients: this.streams.size, rev: this.meta.rev };
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
    return { saved, rev: this.meta.rev, dirty: this.dirty, file: this.meta.file, content: this.files[this.meta.file], state: this.stateText() };
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
        const { model, dirty } = await request.json();
        this.live = model;
        this.dirty = !!dirty;
        return json({ css: renderText(this.files[this.meta.file], kindOf(this.meta.file), model, this.meta.file).css });
      }
      if (route === 'POST /api/save') {
        const { model } = await request.json();
        const before = this.files[this.meta.file];
        const after = applyModel(before, kindOf(this.meta.file), model, this.meta.file);
        const changed = after !== before;
        this.files[this.meta.file] = after;
        this.live = null;
        this.dirty = false;
        if (changed) {
          this.meta.rev++;
          this.meta.savedAt = Date.now();
        }
        await this.persist();
        for (const w of this.waiters) w.resolve(true);
        this.waiters.clear();
        return json({ changed, model: this.model(), rev: this.meta.rev });
      }

      if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
      if (url.pathname === '/demo' && this.meta) return text(this.demoPage(base), MIME['.html']);
      if (url.pathname.startsWith('/site/')) {
        const p = decodeURIComponent(url.pathname.slice('/site/'.length));
        if (!(p in this.files)) return text('Not found', 'text/plain', 404);
        let body = this.files[p];
        // Tag the <style> blocks of the edited HTML file so the editor can swap their contents live.
        if (p === this.meta?.file && kindOf(p) === 'html') {
          let i = 0;
          body = body.replace(STYLE_OPEN_RE, (_, open, css, close) => open.replace(/^<style/i, `<style data-anni-src="${i++}"`) + css + close);
        }
        return text(body, MIME[ext(p)] || 'application/octet-stream');
      }
      if (EDITOR_ASSETS.has(url.pathname)) {
        return this.env.ASSETS.fetch(new Request(new URL(url.pathname === '/' ? '/index.html' : url.pathname, 'https://assets.invalid'), { headers: request.headers }));
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
