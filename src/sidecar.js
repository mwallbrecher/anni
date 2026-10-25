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
import { describe, loadModel } from './css.js';
import { openBrowser } from './server.js';

const ANNI_URL = (process.env.ANNI_URL || 'https://anni.run').replace(/\/$/, '');
const server = new McpServer({ name: 'anni', version: '0.2.0' });
const sessions = new Map(); // id -> { file (abs path), rel, uploaded (text), rev }
let lastSession = null;

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (e) => ({ ...text(`Error: ${e.message}`), isError: true });

async function api(method, route, body) {
  let res;
  try {
    res = await fetch(ANNI_URL + route, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  } catch (e) {
    throw new Error(`Cannot reach anni at ${ANNI_URL}: ${e.cause?.code || e.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
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

/** Stylesheets and scripts a page links with relative URLs, so the preview looks like the real page. */
function linkedAssets(html, dir) {
  const out = [];
  for (const m of html.matchAll(/<(?:link|script)\b[^>]*?(?:href|src)="([^"#?]+)"/g)) {
    const ref = m[1];
    if (/^(https?:)?\/\//.test(ref) || ref.startsWith('/') || ref.startsWith('data:')) continue;
    const abs = path.resolve(dir, ref);
    if (/\.(css|js|mjs|svg|json)$/i.test(abs) && fs.existsSync(abs)) out.push(abs);
  }
  return out;
}

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
  async ({ file, animation, preview, extra_files = [], session }) => {
    try {
      const abs = path.resolve(file);
      if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
      const prev = /\.html?$/i.test(abs) ? abs : preview ? path.resolve(preview) : findPreviewFor(abs);
      const paths = new Set([abs, ...(prev ? [prev, ...linkedAssets(fs.readFileSync(prev, 'utf8'), path.dirname(prev))] : []), ...extra_files.map((p) => path.resolve(p))]);
      // Paths inside the session are relative to the common directory, so the page's relative links keep working.
      const root = [...paths].map((p) => path.dirname(p)).reduce((r, d) => {
        while (!d.startsWith(r + path.sep) && d !== r) r = path.dirname(r);
        return r;
      });
      const rel = (p) => path.relative(root, p).split(path.sep).join('/');
      const files = [...paths].map((p) => ({ path: rel(p), content: fs.readFileSync(p, 'utf8') }));
      const r = await api('POST', '/api/sessions', { files, file: rel(abs), animation, preview: prev ? rel(prev) : undefined, session });
      sessions.set(r.session, { file: abs, rel: rel(abs), uploaded: fs.readFileSync(abs, 'utf8'), rev: r.rev });
      lastSession = r.session;
      if (!r.clients && !process.env.ANNI_NO_BROWSER) openBrowser(r.url);
      const list = r.animations.map((a) => `- ${a.name}${a.usage ? ` (used by ${a.usage.selector}, ${a.timing.duration}ms)` : ' (not used by any rule)'}`).join('\n');
      return text(
        [
          `Opened "${r.animation}" from ${abs} in anni: ${r.url}`,
          r.clients ? 'The editor tab that was already open switched to it.' : 'Opened a new browser tab (share the link if it did not appear).',
          `Preview: ${prev ?? 'demo box (no HTML page found)'} · uploaded ${files.length} file${files.length > 1 ? 's' : ''}`,
          `Session: ${r.session}`,
          '',
          'Animations in this file:',
          list,
          '',
          'Next: call wait_for_save. It writes the edited file to disk when the user saves and returns the diff.',
        ].join('\n'),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'wait_for_save',
  {
    title: 'Wait for the user to save in anni',
    description:
      'Blocks until the user saves in anni (or the timeout passes). On save it writes the edited file to disk and returns a short diff – ' +
      'you do not need to touch the file. Returns a timeout note if nothing was saved yet; call again while the user is still working.',
    inputSchema: {
      session: z.string().optional().describe('Session id from open_animation (defaults to the last opened one)'),
      timeout_seconds: z.number().int().min(1).max(300).optional().describe('How long to wait (default 60)'),
    },
  },
  async ({ session = lastSession, timeout_seconds = 60 }) => {
    try {
      const s = session && sessions.get(session);
      if (!s) throw new Error(session ? `Unknown session "${session}" (sessions are tracked per sidecar process)` : 'No session open – call open_animation first');
      const r = await api('GET', `/api/sessions/${session}/wait?since=${s.rev}&timeout=${timeout_seconds * 1000}`);
      if (!r.saved) return text(`No save yet (timeout). The editor ${r.dirty ? 'has unsaved edits' : 'has no pending edits'}. Call wait_for_save again to keep waiting.`);
      s.rev = r.rev;
      const current = fs.readFileSync(s.file, 'utf8');
      const diff = unifiedDiff(s.uploaded, r.content, s.rel);
      if (current !== s.uploaded) {
        return text(`The user saved in anni (revision ${r.rev}), but ${s.file} changed on disk since it was uploaded, so it was NOT overwritten. Apply this diff yourself:\n\n${diff}`);
      }
      fs.writeFileSync(s.file, r.content);
      s.uploaded = r.content;
      return text(`Saved revision ${r.rev} – written to ${s.file}.\n\n${diff}\n\nCurrent animations:\n${r.state}`);
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

console.error(`anni sidecar → ${ANNI_URL}`);
await server.connect(new StdioServerTransport());
