#!/usr/bin/env node
// Local MCP sidecar for the hosted anni (stdio). The model only ever passes file PATHS and gets
// back short diffs: this process reads the files, uploads them to anni over HTTP, opens the
// browser tab, and writes the edited file to disk itself when the user saves. File bytes never
// travel through the model's context. Never write to stdout here: it is the MCP channel.
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { describe, loadModel, usageLine } from './css.js';
import { openBrowser } from './server.js';
import { WAIT_DESCRIPTION, waitSeconds } from './wait.js';

const ANNI_URL = (process.env.ANNI_URL || 'https://anni.run').replace(/\/$/, '');
const server = new McpServer({ name: 'anni', version: '0.2.0' });
const sessions = new Map(); // id -> { file (abs path), rel, uploaded (text), rev }
let lastSession = null;

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (e) => ({ ...text(`Error: ${e.message}`), isError: true });

// MCP clients drop a request after 60 s. A wait asks anni for at most WAIT_MAX_S (50 s), so 55 s leaves room for the
// round trip; if anni.run still hasn't answered, the call ends here instead of the client killing it.
const API_TIMEOUT_MS = 55_000;

class ApiTimeout extends Error {}

async function api(method, route, body) {
  let res;
  let data;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.ANNI_TOKEN) headers.Authorization = `Bearer ${process.env.ANNI_TOKEN}`; // private instances
    const signal = AbortSignal.timeout(API_TIMEOUT_MS);
    res = await fetch(ANNI_URL + route, { method, headers, body: body && JSON.stringify(body), signal });
    data = await res.json().catch((e) => {
      if (e.name === 'TimeoutError') throw e; // the body can run out of time too
      return {};
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new ApiTimeout(`anni at ${ANNI_URL} did not answer within ${API_TIMEOUT_MS / 1000} s`);
    throw new Error(`Cannot reach anni at ${ANNI_URL}: ${e.cause?.code || e.message}`);
  }
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

/** Long-polls a session for a save. A slow anni counts as "nothing saved yet", so callers simply wait again. */
async function waitApi(session, rev, seconds) {
  try {
    return await api('GET', `/api/sessions/${session}/wait?since=${rev}&timeout=${waitSeconds(seconds) * 1000}`);
  } catch (e) {
    if (e instanceof ApiTimeout) return { saved: false, late: true };
    throw e;
  }
}

const noSaveYet = (r, again) =>
  `No save yet (${r.late ? 'anni answered late' : 'timeout'}). ${r.late ? '' : `The editor ${r.dirty ? 'has unsaved edits' : 'has no pending edits'}. `}Call ${again} again to keep waiting.`;

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

const TEXT_EXT = /\.(html?|css|js|mjs|json|svg|txt|map)$/i;
const isRelative = (ref) => !/^(https?:)?\/\//i.test(ref) && !ref.startsWith('/') && !ref.startsWith('data:') && !ref.startsWith('#');

/** Everything a local page or stylesheet references relatively (stylesheets, scripts, images, fonts), recursively. */
function linkedAssets(file, seen = new Set()) {
  const out = [];
  const dir = path.dirname(file);
  const text = fs.readFileSync(file, 'utf8');
  const refs = /\.html?$/i.test(file)
    ? [...text.matchAll(/<(?:link|script|img|source|video|audio)\b[^>]*?(?:href|src)="([^"#?]+)"/g)].map((m) => m[1])
    : [...text.matchAll(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (!isRelative(ref)) continue;
    const abs = path.resolve(dir, ref.split(/[?#]/)[0]);
    if (seen.has(abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    seen.add(abs);
    out.push(abs);
    if (/\.css$/i.test(abs)) out.push(...linkedAssets(abs, seen));
  }
  return out;
}

/** A file as the upload API wants it: text, or base64 for binaries. */
const readUpload = (abs, rel) => (TEXT_EXT.test(abs) ? { path: rel, content: fs.readFileSync(abs, 'utf8') } : { path: rel, content: fs.readFileSync(abs).toString('base64'), encoding: 'base64' });

/** Minimal unified diff (line LCS), capped so it stays a summary. */
function unifiedDiff(a, b, label, maxLines = 80) {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) ops.push([' ', A[i], i++, j++]);
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) ops.push(['+', B[j++]]);
    else ops.push(['-', A[i++]]);
  }
  const lines = [`--- ${label}`, `+++ ${label} (anni)`];
  let changed = 0;
  for (let k = 0; k < ops.length; k++) {
    if (ops[k][0] === ' ') continue;
    const start = Math.max(0, k - 2);
    let end = k;
    while (end < ops.length && (ops[end][0] !== ' ' || (ops[end + 1] && ops[end + 1][0] !== ' ') || (ops[end + 2] && ops[end + 2][0] !== ' '))) end++;
    end = Math.min(ops.length - 1, end + 2);
    lines.push('@@');
    for (let q = start; q <= end; q++) lines.push(`${ops[q][0]}${ops[q][1]}`);
    changed += ops.slice(start, end + 1).filter((o) => o[0] !== ' ').length;
    k = end;
    if (lines.length > maxLines) {
      lines.push(`… (diff truncated; ${changed}+ changed lines)`);
      break;
    }
  }
  return lines.join('\n');
}

server.registerTool(
  'open_animation',
  {
    title: 'Open animation in anni',
    description:
      'Opens a CSS animation (@keyframes) from a local file in anni (the hosted timeline editor): the user scrubs, drags keyframes and edits ' +
      'values and timing in the browser. Pass PATHS only – this tool reads and uploads the files itself and opens the browser tab. ' +
      'Afterwards call wait_for_save: it writes the edited file back to disk when the user saves and returns a short diff. ' +
      'The file can be a .css file or an .html file with <style> blocks.',
    inputSchema: {
      file: z.string().describe('Path to the .css or .html file containing the @keyframes (absolute, or relative to the working directory)'),
      animation: z.string().optional().describe('Name of the @keyframes to select. Defaults to the first one in the file.'),
      preview: z.string().optional().describe('HTML page to preview on (for .css files). Defaults to an .html next to the CSS that links it, else a demo box.'),
      extra_files: z.array(z.string()).optional().describe('Additional files the preview page needs (other CSS, scripts). Stylesheets/scripts linked relatively by the page are included automatically.'),
      session: z.string().optional().describe('Existing session id to reuse (the open tab switches to the new content).'),
    },
  },
  async (args) => {
    try {
      const { lines } = await openAnimation(args);
      return text([...lines, '', 'Next: call wait_for_save. It writes the edited file to disk when the user saves and returns the diff.'].join('\n'));
    } catch (e) {
      return fail(e);
    }
  },
);

/** Uploads a file (plus its preview page and what that links) to anni and opens the editor. Shared by the tool and `anni-mcp open`. */
async function openAnimation({ file, animation, preview, extra_files = [], session }) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  const prev = /\.html?$/i.test(abs) ? abs : preview ? path.resolve(preview) : findPreviewFor(abs);
  const b = bundle([abs, ...(prev ? [prev, ...linkedAssets(prev)] : []), ...extra_files]);
  const { files, rel } = b;
  const r = await api('POST', '/api/sessions', { files, file: rel(abs), animation, preview: prev ? rel(prev) : undefined, session });
  const local = Object.fromEntries(b.abs.map((p) => [rel(p), p]));
  const uploaded = Object.fromEntries(files.filter((f) => !f.encoding).map((f) => [f.path, f.content]));
  sessions.set(r.session, { file: abs, rel: rel(abs), uploaded, local, rev: r.rev });
  lastSession = r.session;
  const browser = !r.clients && !process.env.ANNI_NO_BROWSER;
  if (browser) openBrowser(r.url);
  const lines = [
    `Opened "${r.animation}" from ${abs} in anni: ${r.url}`,
    r.clients ? 'The editor tab that was already open switched to it.' : browser ? 'Opened a new browser tab (share the link if it did not appear).' : 'No browser tab opened (ANNI_NO_BROWSER) – open the link.',
    `Preview: ${prev ?? 'demo box (no HTML page found)'} · uploaded ${files.length} file${files.length > 1 ? 's' : ''}${r.skipped?.length ? ` · skipped (too large): ${r.skipped.join(', ')}` : ''}`,
    `Session: ${r.session}`,
    '',
    'Animations in this file:',
    r.animations.map(usageLine).join('\n'),
  ];
  return { r, lines };
}

/** One long-poll for a save in an animation session; on save writes the changed files to disk. Returns { saved, text }. */
async function waitForSave(session, seconds, again = 'wait_for_save') {
  const s = session && sessions.get(session);
  if (!s) throw new Error(session ? `Unknown session "${session}" (sessions are tracked per sidecar process)` : 'No session open – call open_animation first');
  const r = await waitApi(session, s.rev, seconds);
  if (!r.saved) return { saved: false, text: noSaveYet(r, again) };
  s.rev = r.rev;
  // Every uploaded file anni changed (the animation file, and stylesheets edited in the Editor view) comes back whole.
  const out = [`Saved revision ${r.rev}.`];
  for (const f of r.files || [{ path: s.rel, content: r.content }]) {
    const abs = s.local[f.path];
    const was = s.uploaded[f.path];
    if (!abs || was === undefined) {
      out.push('', `${f.path}: changed in anni but not tracked locally – full content:`, f.content);
      continue;
    }
    const diff = unifiedDiff(was, f.content, f.path);
    if (fs.readFileSync(abs, 'utf8') !== was) {
      out.push('', `${abs} changed on disk since it was uploaded, so it was NOT overwritten. Apply this diff yourself:`, diff);
      continue;
    }
    fs.writeFileSync(abs, f.content);
    s.uploaded[f.path] = f.content;
    out.push('', `Written to ${abs}:`, diff);
  }
  const manual = (r.changes || []).filter((c) => !c.applied);
  if (manual.length) out.push('', 'Edits anni could not place in the uploaded files – apply these yourself:', JSON.stringify(manual.map(({ id, label, from, to, source, reason }) => ({ id, label, from, to, source, reason })), null, 2));
  out.push('', 'Current animations:', r.state);
  return { saved: true, text: out.join('\n') };
}

server.registerTool(
  'wait_for_save',
  {
    title: 'Wait for the user to save in anni',
    description:
      'Blocks until the user saves in anni (or the timeout passes). On save it writes the edited file to disk and returns a short diff – ' +
      'you do not need to touch the file. Returns a timeout note if nothing was saved yet; call again while the user is still working.',
    inputSchema: {
      session: z.string().optional().describe('Session id from open_animation (defaults to the last opened one)'),
      timeout_seconds: z.number().int().min(1).optional().describe(WAIT_DESCRIPTION),
    },
  },
  async ({ session = lastSession, timeout_seconds }) => {
    try {
      return text((await waitForSave(session, timeout_seconds)).text);
    } catch (e) {
      return fail(e);
    }
  },
);

/* ---------- schema sessions: the agent describes controls, anni renders them, the sidecar applies code wires ---------- */

/** Uploads local files so a page's relative links keep working; returns { files, rel } with paths relative to their common root. */
function bundle(paths) {
  const abs = [...new Set(paths.map((p) => path.resolve(p)))];
  for (const p of abs) if (!fs.existsSync(p)) throw new Error(`File not found: ${p}`);
  const root = abs.length
    ? abs
        .map((p) => path.dirname(p))
        .reduce((r, d) => {
          while (!d.startsWith(r + path.sep) && d !== r) r = path.dirname(r);
          return r;
        })
    : process.cwd();
  const rel = (p) => path.relative(root, path.resolve(p)).split(path.sep).join('/');
  return { files: abs.map((p) => readUpload(p, rel(p))), rel, abs };
}

/* ---------- snapshot_page: a rendered route of a running app as static files anni can show ---------- */

async function fetchBuf(url) {
  const res = await fetch(url, { headers: { Accept: '*/*' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

const safeName = (u) => {
  const base = decodeURIComponent(new URL(u).pathname.split('/').pop() || 'index').replace(/[^\w.-]+/g, '_');
  let h = 0;
  for (const ch of u) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `${h.toString(36)}-${base}`.slice(0, 80);
};

/** Fetches a page and what it needs (stylesheets, fonts, images) into `out`, rewriting references to local paths. */
async function snapshotPage(url, out, { stripScripts = true } = {}) {
  fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
  const report = { css: 0, assets: 0, skipped: [], failed: [] };
  let html = (await fetchBuf(url)).toString('utf8');
  const saved = new Map(); // absolute url -> local relative path (from the page)
  const save = async (abs, rewrite) => {
    if (saved.has(abs)) return saved.get(abs);
    try {
      let buf = await fetchBuf(abs);
      if (buf.length > 1.5 * 1024 * 1024) {
        report.skipped.push(abs);
        return null;
      }
      const name = safeName(abs);
      if (rewrite) buf = Buffer.from(await rewrite(buf.toString('utf8'), abs), 'utf8');
      fs.writeFileSync(path.join(out, 'assets', name), buf);
      saved.set(abs, `assets/${name}`);
      report.assets++;
      return `assets/${name}`;
    } catch (e) {
      report.failed.push(`${abs} (${e.message})`);
      return null;
    }
  };
  // CSS: pull in fonts/images referenced with url(); the rewritten css sits next to them in assets/.
  const rewriteCss = async (css, cssUrl) => {
    const refs = [...new Set([...css.matchAll(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/g)].map((m) => m[1]).filter((r) => !r.startsWith('data:') && !r.startsWith('#')))];
    for (const ref of refs) {
      const local = await save(new URL(ref, cssUrl).href);
      if (local) css = css.split(`(${ref})`).join(`(${local.slice('assets/'.length)})`).split(`('${ref}')`).join(`('${local.slice('assets/'.length)}')`).split(`("${ref}")`).join(`("${local.slice('assets/'.length)}")`);
    }
    return css;
  };
  const links = [...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]);
  for (const tag of links) {
    const href = tag.match(/href="([^"]+)"/)?.[1];
    if (!href) continue;
    const isStyle = /rel="[^"]*stylesheet/.test(tag) || /as="style"/.test(tag);
    if (isStyle) {
      const local = await save(new URL(href, url).href, rewriteCss);
      if (local) {
        html = html.replace(tag, tag.replace(href, local));
        report.css++;
      }
    } else if (/rel="[^"]*(icon|preload|modulepreload|prefetch|preconnect|dns-prefetch)/.test(tag)) html = html.replace(tag, '');
  }
  for (const m of [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)]) {
    if (m[1].startsWith('data:')) continue;
    const local = await save(new URL(m[1], url).href);
    if (local) html = html.split(`src="${m[1]}"`).join(`src="${local}"`);
  }
  html = html.replace(/\bsrcset="[^"]*"/g, '');
  if (stripScripts) html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<script\b[^>]*\/>/gi, '');
  html = html.replace(/<base\b[^>]*>/i, '');
  fs.writeFileSync(path.join(out, 'page.html'), html);
  return { page: path.join(out, 'page.html'), html, ...report };
}

server.registerTool(
  'snapshot_page',
  {
    title: 'Snapshot a rendered page',
    description:
      'Fetches a route of a running app (dev server, staging, any URL) and writes it as static files anni can show: page.html plus its stylesheets, fonts and images ' +
      'with references rewritten, scripts removed. Use the returned page path as `preview` for open_animation or present – the preview then looks like the real app ' +
      'and anni can edit CSS in it live. Works for any framework that renders to the browser. Reports which @keyframes and source stamps (data-src) the page has.',
    inputSchema: {
      url: z.string().describe('URL of the page, e.g. http://localhost:3000/'),
      out: z.string().optional().describe('Directory to write into (default .anni/snapshot-<host>-<path>)'),
      keep_scripts: z.boolean().optional().describe('Keep <script> tags (default false: a static snapshot is more faithful than a half-hydrated app)'),
    },
  },
  async ({ url, out, keep_scripts = false }) => {
    try {
      const u = new URL(url);
      const dir = path.resolve(out || path.join('.anni', `snapshot-${u.host.replace(/[^\w.-]+/g, '_')}${u.pathname.replace(/[^\w-]+/g, '_').replace(/_+$/, '') || ''}`));
      const r = await snapshotPage(u.href, dir, { stripScripts: !keep_scripts });
      const cssText = fs
        .readdirSync(path.join(dir, 'assets'))
        .filter((n) => /\.css$/i.test(n))
        .map((n) => fs.readFileSync(path.join(dir, 'assets', n), 'utf8'))
        .join('\n');
      const keyframes = [...new Set([...cssText.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]))];
      const stamps = (r.html.match(/\bdata-src="/g) || []).length;
      return text(
        [
          `Snapshot of ${u.href} written to ${dir}`,
          `page: ${r.page} (${(r.html.length / 1024).toFixed(0)} KB) · ${r.css} stylesheet${r.css === 1 ? '' : 's'} · ${r.assets - r.css} fonts/images`,
          keyframes.length ? `@keyframes in its CSS: ${keyframes.join(', ')}` : 'No @keyframes in its CSS (use present, or create animations in the editor).',
          stamps ? `${stamps} elements carry data-src="file:line:col" source stamps – use them as code wires.` : 'No data-src source stamps on elements.',
          r.skipped.length ? `Skipped (too large): ${r.skipped.join(', ')}` : null,
          r.failed.length ? `Failed: ${r.failed.join(', ')}` : null,
          '',
          `Next: open_animation(file, preview: "${r.page}") or present(..., preview: "${r.page}").`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

const fill = (tpl, value) => tpl.replaceAll('{{value}}', value);

/** Applies one change to a local file through its source wire. Returns the diff, or throws with a precise reason. */
function applyWire(change, cwd) {
  const s = change.source;
  const file = path.resolve(cwd, s.file);
  const before = fs.readFileSync(file, 'utf8');
  let after;
  if (s.find) {
    const n = before.split(s.find).length - 1;
    if (n !== 1) throw new Error(`"${s.find}" occurs ${n} times in ${s.file} (must be exactly once)`);
    let replacement;
    if (s.replace) replacement = fill(s.replace, change.to);
    else if (s.find.includes(change.from)) replacement = s.find.replace(change.from, change.to);
    else throw new Error(`the old value "${change.from}" does not occur inside find="${s.find}" and no replace template was given`);
    after = before.replace(s.find, replacement);
  } else if (s.range) {
    const [a, b] = s.range;
    after = before.slice(0, a) + fill(s.template || '{{value}}', change.to) + before.slice(b);
  } else throw new Error('source wire needs find or range');
  fs.writeFileSync(file, after);
  return unifiedDiff(before, after, s.file, 24);
}

server.registerTool(
  'present',
  {
    title: 'Present controls in anni',
    description:
      'Turns values from code into a touchable panel: describe controls (number, length, color, enum, boolean, text), each with an optional ' +
      'preview wire (how it shows on the page: a CSS declaration `css: {selector, prop}`, a custom property `var: {name}` or an element\'s `text: {selector}`) ' +
      'and a source wire (`source: {file, find, replace?}` or `{file, range, template?}`, where the value lives in code). Pass the preview page and the ' +
      'files it links as local PATHS; this tool uploads them, opens the browser, and wait_for_changes later applies the source wires to your files itself. ' +
      'A rendered route of a running app (fetch its HTML + CSS to files) makes a faithful preview; without a page the controls still work.',
    inputSchema: {
      schema: z.object({
        title: z.string(),
        groups: z.array(
          z.object({
            label: z.string().optional(),
            controls: z.array(
              z.object({
                id: z.string(),
                label: z.string().optional(),
                type: z.enum(['number', 'length', 'color', 'enum', 'boolean', 'text']),
                value: z.union([z.string(), z.number(), z.boolean()]),
                min: z.number().optional(),
                max: z.number().optional(),
                step: z.number().optional(),
                unit: z.string().optional(),
                units: z.array(z.string()).optional(),
                options: z.array(z.union([z.string(), z.object({ value: z.string(), label: z.string().optional() })])).optional(),
                preview: z
                  .object({
                    css: z.object({ selector: z.string(), prop: z.string(), important: z.boolean().optional() }).optional(),
                    var: z.object({ name: z.string(), scope: z.string().optional() }).optional(),
                    text: z.object({ selector: z.string() }).optional(),
                  })
                  .optional(),
                source: z
                  .object({
                    file: z.string(),
                    find: z.string().optional(),
                    replace: z.string().optional(),
                    range: z.array(z.number().int()).length(2).optional(),
                    template: z.string().optional(),
                  })
                  .optional(),
              }),
            ),
          }),
        ),
      }),
      files: z.array(z.string()).optional().describe('Local paths: the preview page and what it links (stylesheets, scripts, images)'),
      preview: z.string().optional().describe('Local path of the HTML page to show (defaults to the first .html in files)'),
      session: z.string().optional().describe('Existing session id to update in place'),
    },
  },
  async ({ schema, files = [], preview, session }) => {
    try {
      const prev = preview ? path.resolve(preview) : files.map((p) => path.resolve(p)).find((p) => /\.html?$/i.test(p)) || null;
      const all = [...files, ...(prev ? [prev, ...linkedAssets(prev)] : [])];
      const b = bundle(all);
      const r = await api('POST', '/api/sessions', { files: b.files, preview: prev ? b.rel(prev) : undefined, schema, title: schema.title, session });
      sessions.set(r.session, { kind: 'schema', cwd: process.cwd(), rev: r.rev });
      lastSession = r.session;
      if (!r.clients && !process.env.ANNI_NO_BROWSER) openBrowser(r.url);
      return text(
        [
          `Presented "${r.title}" (${r.controls} controls) in anni: ${r.url}`,
          r.clients ? 'The editor tab that was already open switched to it.' : 'Opened a new browser tab (share the link if it did not appear).',
          `Preview: ${prev ?? 'none – controls only'}${b.files.length ? ` · uploaded ${b.files.length} file${b.files.length > 1 ? 's' : ''}` : ''}`,
          `Session: ${r.session}`,
          '',
          'Next: call wait_for_changes. When the user saves it applies the source wires to your files and returns the diffs.',
        ].join('\n'),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'wait_for_changes',
  {
    title: 'Wait for the user to save changed values',
    description:
      'Blocks until the user saves in a present() session (or the timeout passes). Applies every changed control that has a source wire to the local ' +
      'file and returns the diffs; changes without a source wire are listed for you to apply. Call again while the user keeps working.',
    inputSchema: {
      session: z.string().optional().describe('Session id from present (defaults to the last opened one)'),
      timeout_seconds: z.number().int().min(1).optional().describe(WAIT_DESCRIPTION),
    },
  },
  async ({ session = lastSession, timeout_seconds }) => {
    try {
      const s = session && sessions.get(session);
      if (!s) throw new Error(session ? `Unknown session "${session}" (sessions are tracked per sidecar process)` : 'No session open – call present first');
      const r = await waitApi(session, s.rev, timeout_seconds);
      if (!r.saved) return text(noSaveYet(r, 'wait_for_changes'));
      if (r.kind !== 'schema') throw new Error('This session is an animation session – use wait_for_save');
      s.rev = r.rev;
      const out = [`Saved revision ${r.rev} – ${r.changes.length} change${r.changes.length === 1 ? '' : 's'}.`];
      const manual = [];
      for (const c of r.changes) {
        if (!c.source) {
          manual.push(c);
          continue;
        }
        try {
          out.push('', `${c.label}: ${c.from} → ${c.to}  (applied to ${c.source.file})`, applyWire(c, s.cwd));
        } catch (e) {
          out.push('', `${c.label}: ${c.from} → ${c.to}  NOT applied: ${e.message}`);
          manual.push(c);
        }
      }
      if (manual.length) out.push('', 'Apply these yourself:', JSON.stringify(manual.map(({ id, label, from, to, source }) => ({ id, label, from, to, source })), null, 2));
      return text(out.join('\n'));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'get_animation_state',
  {
    title: 'Read anni editor state',
    description: 'Returns the animations of the open anni session as CSS, including edits the user has not saved yet, and whether there are unsaved changes.',
    inputSchema: { session: z.string().optional().describe('Session id (defaults to the last opened one)') },
  },
  async ({ session = lastSession }) => {
    try {
      if (!session) throw new Error('No session open – call open_animation first');
      return text((await api('GET', `/api/sessions/${session}/state`)).text);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'list_animations',
  {
    title: 'List animations in a file',
    description: 'Lists all @keyframes in a local .css or .html file with their keyframes and timing, without opening the editor.',
    inputSchema: { file: z.string().describe('Path to the .css or .html file') },
  },
  async ({ file }) => {
    try {
      const model = loadModel(path.resolve(file));
      return text(model.animations.length ? model.animations.map(describe).join('\n\n') : 'No @keyframes found.');
    } catch (e) {
      return fail(e);
    }
  },
);

const USAGE = `anni-mcp – sidecar for the hosted anni editor (${ANNI_URL})

  anni-mcp                          run as an MCP server over stdio (what \`claude mcp add anni -- npx -y anni-mcp\` starts)
  anni-mcp open <file> [animation]  open a .css/.html file in anni without an agent, write saves back until Ctrl+C

Same upload, editor and write-back as the MCP tools – use \`open\` when the anni tools are not loaded yet
(an MCP server added mid-session only loads in a new session). ANNI_URL / ANNI_TOKEN select a self-hosted instance.`;

/** `anni-mcp open`: the open_animation + wait_for_save loop, for a terminal or an agent without the tools. */
async function runOpen(file, animation) {
  const { lines } = await openAnimation({ file, animation });
  console.log([...lines, '', `Waiting for saves – they are written back to ${path.resolve(file)}. Ctrl+C to stop.`].join('\n'));
  for (;;) {
    try {
      const r = await waitForSave(lastSession);
      if (r.saved) console.log(`\n${r.text}`);
    } catch (e) {
      console.error(`${e.message} – retrying in 5 s`);
      await new Promise((done) => setTimeout(done, 5000));
    }
  }
}

const [command, ...rest] = process.argv.slice(2);
if (!command) {
  console.error(`anni sidecar → ${ANNI_URL}`);
  await server.connect(new StdioServerTransport());
} else if (command === 'open' && rest[0]) {
  try {
    await runOpen(rest[0], rest[1]);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
} else {
  const help = ['help', '--help', '-h'].includes(command);
  (help ? console.log : console.error)(USAGE);
  process.exit(help ? 0 : 1);
}
