// Local HTTP server: serves the editor UI, the preview pages, and a small JSON API
// that the editor and the MCP tools talk to. Only one session (one file) at a time.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, isHtml, loadModel, render, save } from './css.js';

export const PORT = Number(process.env.ANNI_PORT) || 4747;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const VERSION = JSON.parse(fs.readFileSync(path.join(WEB_DIR, '..', 'package.json'), 'utf8')).version;

// Local mode is easy to mistake for anni.run: say which editor this is, and how to reach the hosted one.
export const LOCAL_MODE_NOTE =
  `anni local mode: the editor bundled with anni-mcp ${VERSION}, served from this machine (not anni.run).\n` +
  'Hosted editor (always current): npx -y anni-mcp open <file>';
const STYLE_OPEN_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

let session = null; // { file, preview, root, animation }
let liveModel = null; // last model the editor sent (may contain unsaved edits)
let dirty = false;
let lastWritten = null;
const clients = new Set();

const toUrlPath = (p) => p.split(path.sep).map(encodeURIComponent).join('/');

function broadcast(event, data = {}) {
  for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Looks next to (and one level above) a CSS file for an HTML page that links it. */
function findPreviewFor(file) {
  const base = path.basename(file);
  for (const dir of [path.dirname(file), path.dirname(path.dirname(file))]) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries.filter((n) => /\.html?$/i.test(n))) {
      const html = path.join(dir, name);
      try {
        if (fs.readFileSync(html, 'utf8').includes(base)) return html;
      } catch {}
    }
  }
  return null;
}

function commonDir(a, b) {
  const pa = path.dirname(a).split(path.sep);
  const pb = path.dirname(b).split(path.sep);
  let i = 0;
  while (i < pa.length && i < pb.length && pa[i].toLowerCase() === pb[i].toLowerCase()) i++;
  return i ? pa.slice(0, i).join(path.sep) || path.sep : null;
}

function unwatch() {
  if (session) fs.unwatchFile(session.file);
}

export function openSession({ file, animation, preview }) {
  file = path.resolve(file);
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const model = loadModel(file);
  if (!model.animations.length) throw new Error(`No @keyframes found in ${file}`);
  if (animation && !model.animations.some((a) => a.name === animation)) {
    throw new Error(`No @keyframes "${animation}" in ${file}. Found: ${model.animations.map((a) => a.name).join(', ')}`);
  }
  preview = isHtml(file) ? file : preview ? path.resolve(preview) : findPreviewFor(file);
  const root = (preview && commonDir(file, preview)) || path.dirname(file);
  if (preview && path.relative(root, preview).startsWith('..')) preview = null;

  unwatch();
  session = { file, preview, root, animation: animation || model.animations[0].name };
  liveModel = null;
  dirty = false;
  fs.watchFile(file, { interval: 400 }, () => {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    if (text === lastWritten) return;
    lastWritten = text;
    broadcast('external-change', { dirty });
  });
  lastWritten = fs.readFileSync(file, 'utf8');
  broadcast('session', { file, animation: session.animation });
  return {
    url: BASE_URL,
    file,
    preview,
    animation: session.animation,
    animations: model.animations,
    clients: clients.size,
  };
}

function sessionPayload() {
  if (!session) return { session: null };
  const fresh = loadModel(session.file);
  const model = dirty && liveModel ? { ...fresh, animations: liveModel.animations } : fresh;
  const site = (p) => `/site/${toUrlPath(path.relative(session.root, p))}`;
  return {
    session: {
      file: session.file,
      animation: session.animation,
      kind: model.kind,
      previewUrl: session.preview ? site(session.preview) : null,
      cssUrl: model.kind === 'css' ? site(session.file) : null,
      demoUrl: '/demo',
      dirty,
    },
    model,
  };
}

export function stateText() {
  if (!session) return 'anni has no animation open.';
  const model = liveModel || loadModel(session.file);
  const lines = [
    `File: ${session.file}`,
    `Selected animation: ${session.animation}`,
    dirty ? 'The editor has UNSAVED changes (shown below; not yet written to the file).' : 'No unsaved changes - the file on disk matches the editor.',
    '',
  ];
  for (const anim of model.animations) lines.push(describe(anim), '');
  return lines.join('\n');
}

function demoPage() {
  const { css } = render(session.file, liveModel || loadModel(session.file));
  const baseDir = path.relative(session.root, path.dirname(session.file));
  const base = `/site/${baseDir ? toUrlPath(baseDir) + '/' : ''}`;
  const styles = css.map((text, i) => `<style data-anni-src="${i}">${text}</style>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><base href="${base}">
${styles}
<style>
html, body { margin: 0 !important; height: 100% !important; }
body { display: grid !important; place-items: center !important; background: transparent !important; overflow: hidden; }
#anni-demo { width: 96px; height: 96px; border-radius: 18px; background: #e97130; color: #fafaf9;
  display: grid; place-items: center; font: 600 28px/1 system-ui, sans-serif; }
</style></head><body><div id="anni-demo">Aa</div></body></html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function serveFile(res, file, transform) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    send(res, 200, transform ? transform(buf.toString('utf8')) : buf, type);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, BASE_URL);
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/ping') return send(res, 200, { app: 'anni' });
  if (route === 'GET /api/session') return send(res, 200, sessionPayload());
  if (route === 'GET /api/state') return send(res, 200, { text: stateText(), dirty, hasSession: !!session });
  if (route === 'POST /api/open') return send(res, 200, openSession(await readBody(req)));

  if (route === 'GET /api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': hi\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (!session && url.pathname.startsWith('/api/')) return send(res, 409, { error: 'No animation open' });

  if (route === 'POST /api/select') {
    session.animation = (await readBody(req)).animation;
    return send(res, 200, { ok: true });
  }
  if (route === 'POST /api/render') {
    const { model, dirty: isDirty } = await readBody(req);
    liveModel = model;
    dirty = !!isDirty;
    return send(res, 200, { css: render(session.file, model).css });
  }
  if (route === 'POST /api/save') {
    const { model } = await readBody(req);
    const changed = save(session.file, model);
    lastWritten = fs.readFileSync(session.file, 'utf8');
    liveModel = model;
    dirty = false;
    return send(res, 200, { changed, model: loadModel(session.file) });
  }

  if (req.method !== 'GET') return send(res, 404, { error: 'Not found' });
  if (url.pathname === '/demo' && session) return send(res, 200, demoPage(), MIME['.html']);

  if (url.pathname.startsWith('/site/') && session) {
    const rel = decodeURIComponent(url.pathname.slice('/site/'.length));
    const file = path.resolve(session.root, rel);
    if (path.relative(session.root, file).startsWith('..')) return send(res, 403, 'Forbidden', 'text/plain');
    // Tag the <style> blocks of the edited HTML file so the editor can swap their contents live.
    const tagStyles =
      file === session.file && isHtml(file)
        ? (text) => {
            let i = 0;
            return text.replace(STYLE_OPEN_RE, (_, open, css, close) => open.replace(/^<style/i, `<style data-anni-src="${i++}"`) + css + close);
          }
        : null;
    return serveFile(res, file, tagStyles);
  }

  const asset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  // Subfolders (brand/, fonts/) are fine; no segment may start with a dot, which rules out `..`.
  if (!/^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*$/.test(asset)) return send(res, 404, 'Not found', 'text/plain');
  return serveFile(res, path.join(WEB_DIR, asset));
}

export function startServer(port = PORT) {
  const server = http.createServer((req, res) =>
    handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, 400, { error: e.message });
    }),
  );
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export function openBrowser(url) {
  // cmd.exe would read & (e.g. in "#owner=…&name=…") as a command separator: escape it with ^.
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url.replace(/[&^|<>]/g, '^$&')]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}
