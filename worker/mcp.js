// Remote MCP tools (stateless; every call names its session). The agent reads the project files
// itself, hands their contents to open_animation, sends the user the session link, and writes the
// edited file back to disk when wait_for_save returns it.
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { describe, kindOf, modelFromText } from '../src/css.js';
import { WAIT_DESCRIPTION, waitSeconds } from '../src/wait.js';
import { versionOf } from './assets.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (e) => ({ ...text(`Error: ${e.message}`), isError: true });

export const sessionStub = (env, id) => env.ANNI_SESSION.get(env.ANNI_SESSION.idFromName(id));

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
}

/** Session URL: its own origin under ANNI_HOST, or a /s/<id>/ path when there is no wildcard domain. */
export function sessionUrl(env, origin, id) {
  if (env.ANNI_URL_MODE === 'subdomain' && env.ANNI_HOST) return `${new URL(origin).protocol}//${id}.${env.ANNI_HOST}/`;
  return `${origin}/s/${id}/`;
}

/** Calls a session's agent side; `token` is its owner token (required once the session was started with one). */
export async function call(env, id, path, body, token) {
  const headers = { 'x-anni-version': versionOf(env), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'x-anni-owner': token } : {}) };
  const send = () => sessionStub(env, id).fetch(new Request(`https://session.invalid${path}`, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers }));
  let res;
  try {
    res = await send();
  } catch {
    res = await send(); // an outdated session object resets itself on the first call (see AnniSession.fetch)
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const isSessionId = (s) => typeof s === 'string' && /^[a-z0-9]{8,32}$/.test(s);

/**
 * Creates (or updates) a session from uploaded files. Shared by the MCP tool and the plain HTTP API the sidecar
 * uses. With `auth` a new session gets an owner token (returned once as `token`); updating an owned session
 * needs that token.
 */
export async function openSession(env, origin, { files = [], file, animation, preview, session, schema, title, auth, ownerName, forkOf, base }, token) {
  if (!Array.isArray(files)) throw new Error('files must be an array');
  if (!schema && (!files.length || typeof file !== 'string')) throw new Error('files[] and file are required');
  const id = isSessionId(session) ? session : newId();
  const url = sessionUrl(env, origin, id);
  const r = await call(env, id, '/internal/open', { files, file, animation, preview, schema, title, auth, ownerName, forkOf, base, id, url }, token);
  return { ...r, session: id, url };
}

/** The link that makes its opener the owner: the token rides in the #fragment, which never reaches a server. */
export const ownerLink = (url, token) => (token ? `${url}#owner=${encodeURIComponent(token)}` : url);

/** Controls the agent can present: two wires each – `preview` (anni applies it live) and `source` (applied to code on save). */
const sourceSchema = z
  .object({
    file: z.string().describe('Path of the source file, relative to the project'),
    find: z.string().optional().describe('A snippet that occurs exactly once in the file and contains the current value'),
    replace: z.string().optional().describe('Replacement for `find` with {{value}} where the new value goes; defaults to swapping the old value inside `find`'),
    range: z.array(z.number().int()).length(2).optional().describe('Alternative to find: [start, end] character offsets of the literal to replace'),
    template: z.string().optional().describe('With range: text written in place of the literal, {{value}} = the new value (default {{value}})'),
  })
  .describe('Where the value lives in code. Omit it and the change is only reported.');
const previewSchema = z
  .object({
    css: z.object({ selector: z.string(), prop: z.string(), important: z.boolean().optional() }).optional().describe('Apply as `selector { prop: value }` in the preview'),
    var: z.object({ name: z.string(), scope: z.string().optional() }).optional().describe('Set a CSS custom property (default scope :root)'),
    text: z.object({ selector: z.string() }).optional().describe('Set the text content of matching elements'),
  })
  .describe('How the value shows in the preview page. Omit it and the control applies on save only.');
export const controlSchema = z.object({
  id: z.string().describe('Unique id, reported back in changes'),
  label: z.string().optional(),
  type: z.enum(['number', 'length', 'color', 'enum', 'boolean', 'text']),
  value: z.union([z.string(), z.number(), z.boolean()]).describe('Current value, as it appears in code (e.g. "8px", "#3b82f6", 0.5, "md")'),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  unit: z.string().optional().describe('number: fixed unit shown after the field'),
  units: z.array(z.string()).optional().describe('length: selectable units (default px, %, em, rem, vw, vh)'),
  options: z.array(z.union([z.string(), z.object({ value: z.string(), label: z.string().optional() })])).optional().describe('enum: the choices'),
  preview: previewSchema.optional(),
  source: sourceSchema.optional(),
});
export const presentSchema = z.object({
  title: z.string().describe('Shown in the editor header, e.g. "Card"'),
  groups: z.array(z.object({ label: z.string().optional(), controls: z.array(controlSchema).min(1) })).min(1),
});

const fileSchema = z.object({
  path: z.string().describe('Path relative to the project, e.g. "css/styles.css"'),
  content: z.string().describe('Full text content of the file (or base64 with encoding "base64" for fonts/images)'),
  encoding: z.enum(['utf8', 'base64']).optional(),
});

export function createServer(env, origin) {
  const server = new McpServer({ name: 'anni', version: '0.2.0' });

  server.registerTool(
    'open_animation',
    {
      title: 'Open animation in anni',
      description:
        'Opens a CSS animation (@keyframes) in anni, a web timeline editor where the user scrubs, drags keyframes and edits values and timing. ' +
        'anni is hosted, so pass FILE CONTENTS: read the .css (or .html with <style>) file yourself and include it, plus the HTML page that uses it ' +
        'and small assets it links (other css) so the preview works. Returns a link the user opens in their browser. ' +
        'Afterwards call wait_for_save with the returned session id and token: it returns the edited file when the user saves, and you write it back to disk. ' +
        'Pass `session` and `token` to update a session that is already open in a tab (e.g. after you changed the file).',
      inputSchema: z.object({
        files: z.array(fileSchema).min(1).describe('The file with the @keyframes and, ideally, the HTML page that uses it plus linked CSS'),
        file: z.string().describe('Path (as given in files) of the file that contains the @keyframes to edit'),
        animation: z.string().optional().describe('Name of the @keyframes to select. Defaults to the first one.'),
        preview: z.string().optional().describe('Path (as given in files) of the HTML page to preview on. Defaults to an uploaded .html that references the file.'),
        session: z.string().optional().describe('Existing session id to reuse'),
        token: z.string().optional().describe('Owner token of that session (from the first open_animation result)'),
        owner_name: z.string().optional().describe("The user's name, shown to people who ask for access (e.g. from git config user.name)"),
      }),
    },
    async ({ files, file, animation, preview, session, token, owner_name }) => {
      try {
        const r = await openSession(env, origin, { files, file, animation, preview, session, auth: true, ownerName: owner_name }, token);
        const id = r.session;
        const owner = r.token || token;
        const list = r.animations
          .map((a) => `- ${a.name}${a.usage ? ` (used by ${a.usage.selector}, ${a.timing.duration}ms)` : ' (not used by any rule)'}`)
          .join('\n');
        return text(
          [
            `Opened "${r.animation}" from ${r.file} in anni.`,
            `Session: ${id}`,
            ...(r.token ? [`Owner token (keep it for later calls on this session): ${r.token}`] : []),
            `Link for the user (makes their browser the owner – give it only to them): ${ownerLink(r.url, owner)}`,
            `Link others can use to ask for access: ${r.url}`,
            r.clients ? 'An editor tab is already open on this session and switched to it.' : 'Ask the user to open the link.',
            `Preview: ${r.preview ?? 'demo box (no HTML page among the files)'}`,
            '',
            'Animations in this file:',
            list,
            '',
            `Next: call wait_for_save with session "${id}"${owner ? ' and the token' : ''}. When it returns saved=true, write its content to ${r.file} on disk.`,
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
        'Blocks until the user saves in the anni session (or the timeout passes) and returns the full edited file content. ' +
        'Write that content to the file on disk, tell the user, and call again if they keep editing. Returns saved=false on timeout – call again while the user is still working.',
      inputSchema: z.object({
        session: z.string().describe('Session id from open_animation'),
        token: z.string().optional().describe('Owner token from open_animation'),
        since_rev: z.number().int().optional().describe('Only return a save newer than this revision (from a previous result). Defaults to the latest.'),
        timeout_seconds: z.number().int().min(1).optional().describe(WAIT_DESCRIPTION),
      }),
    },
    async ({ session, token, since_rev, timeout_seconds }) => {
      try {
        const state = await call(env, session, '/internal/state', undefined, token);
        if (!state.hasSession) throw new Error(`Unknown session "${session}"`);
        const since = since_rev ?? state.rev;
        const r = await call(env, session, `/internal/wait?since=${since}&timeout=${waitSeconds(timeout_seconds) * 1000}`, undefined, token);
        if (!r.saved) return text(`No save yet (timeout). The editor ${r.dirty ? 'has unsaved edits' : 'has no pending edits'}. Call wait_for_save again to keep waiting.`);
        const files = r.files || [{ path: r.file, content: r.content }];
        const manual = (r.changes || []).filter((c) => !c.applied);
        return {
          content: [
            { type: 'text', text: `Saved revision ${r.rev}. Write the following ${files.length === 1 ? 'file' : `${files.length} files`} to disk (full content each):` },
            ...files.flatMap((f) => [{ type: 'text', text: `=== ${f.path} ===` }, { type: 'text', text: f.content }]),
            ...(manual.length ? [{ type: 'text', text: `Edits anni could not place – apply yourself:\n${JSON.stringify(manual, null, 2)}` }] : []),
            { type: 'text', text: `Current animations:\n${r.state}` },
          ],
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'present',
    {
      title: 'Present controls in anni',
      description:
        'Turns values from code into a touchable panel: describe controls (number, length, color, enum, boolean, text), each with an optional ' +
        'preview wire (how it shows on the uploaded page: a CSS declaration, a custom property or an element\'s text) and a source wire (where the ' +
        'value lives in code). anni renders the controls next to the page; the user tunes them live. Then call wait_for_changes: it returns ' +
        '{id, from, to, source} for every control the user changed when they save, and you apply them to the code. Upload the HTML page and the ' +
        'CSS/assets it links as files so the preview looks like the real thing (a rendered route of a running app works well); without a preview page the ' +
        'controls still work and apply on save.',
      inputSchema: z.object({
        schema: presentSchema,
        files: z.array(fileSchema).optional().describe('Preview page and the files it links'),
        preview: z.string().optional().describe('Path (as given in files) of the HTML page to show'),
        session: z.string().optional().describe('Existing session id to update in place'),
        token: z.string().optional().describe('Owner token of that session (from the first present result)'),
        owner_name: z.string().optional().describe("The user's name, shown to people who ask for access"),
      }),
    },
    async ({ schema, files = [], preview, session, token, owner_name }) => {
      try {
        const r = await openSession(env, origin, { files, preview, session, schema, title: schema.title, auth: true, ownerName: owner_name }, token);
        const owner = r.token || token;
        return text(
          [
            `Presented "${r.title}" (${r.controls} controls) in anni.`,
            `Session: ${r.session}`,
            ...(r.token ? [`Owner token (keep it for later calls on this session): ${r.token}`] : []),
            `Link for the user (makes their browser the owner – give it only to them): ${ownerLink(r.url, owner)}`,
            `Link others can use to ask for access: ${r.url}`,
            r.clients ? 'An editor tab is already open on this session and switched to it.' : 'Ask the user to open the link.',
            `Preview: ${r.preview ?? 'none – controls only'}`,
            '',
            `Next: call wait_for_changes with session "${r.session}"${owner ? ' and the token' : ''}; apply the returned changes to the code using each change's source wire.`,
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
        'Blocks until the user saves in a present() session (or the timeout passes) and returns the changed controls as {id, label, from, to, source}. ' +
        'Apply each one to the code at its source wire (find/replace or range). Returns saved=false on timeout – call again while the user is still working.',
      inputSchema: z.object({
        session: z.string().describe('Session id from present'),
        token: z.string().optional().describe('Owner token from present'),
        since_rev: z.number().int().optional(),
        timeout_seconds: z.number().int().min(1).optional().describe(WAIT_DESCRIPTION),
      }),
    },
    async ({ session, token, since_rev, timeout_seconds }) => {
      try {
        const state = await call(env, session, '/internal/state', undefined, token);
        if (!state.hasSession) throw new Error(`Unknown session "${session}"`);
        const r = await call(env, session, `/internal/wait?since=${since_rev ?? state.rev}&timeout=${waitSeconds(timeout_seconds) * 1000}`, undefined, token);
        if (!r.saved) return text(`No save yet (timeout). The editor ${r.dirty ? 'has unsaved edits' : 'has no pending edits'}. Call wait_for_changes again to keep waiting.`);
        if (r.kind !== 'schema') throw new Error('This session is an animation session – use wait_for_save');
        return text(`Saved revision ${r.rev}. Changes:\n${JSON.stringify(r.changes, null, 2)}\n\nAll values now:\n${JSON.stringify(r.values)}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'get_animation_state',
    {
      title: 'Read anni editor state',
      description: 'Returns the animations of an anni session as CSS, including edits the user has not saved yet, and whether there are unsaved changes.',
      inputSchema: z.object({ session: z.string().describe('Session id from open_animation'), token: z.string().optional().describe('Owner token from open_animation') }),
    },
    async ({ session, token }) => {
      try {
        return text((await call(env, session, '/internal/state', undefined, token)).text);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'get_proposals',
    {
      title: 'Read changes exported from copies',
      description:
        'People who watched an anni session can edit a copy of it and export their changes back to it. Returns those exported change sets ' +
        '(newest first), each a markdown brief with before → after values and a diff against the revision the copy started from. Apply them ' +
        'to the code as the brief says: change only what is listed, keep everything else (including later changes), and ask the user about conflicts.',
      inputSchema: z.object({ session: z.string().describe('Session id of the original session'), token: z.string().optional().describe('Owner token of that session') }),
    },
    async ({ session, token }) => {
      try {
        const r = await call(env, session, '/internal/proposals', undefined, token);
        if (!r.proposals.length) return text('No changes have been exported from copies of this session.');
        return text(r.proposals.map((p) => `=== From ${p.author}, ${new Date(p.at).toISOString()} (based on revision ${p.baseRev}; the session is now at revision ${r.rev}) ===\n\n${p.markdown}`).join('\n\n'));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'list_animations',
    {
      title: 'List animations in CSS',
      description: 'Lists all @keyframes in the given css/html content with their keyframes and timing, without opening the editor.',
      inputSchema: z.object({ content: z.string().describe('The css or html text'), filename: z.string().optional().describe('Name, used to tell .css from .html') }),
    },
    async ({ content, filename = 'styles.css' }) => {
      try {
        const model = modelFromText(content, kindOf(filename), filename);
        return text(model.animations.length ? model.animations.map(describe).join('\n\n') : 'No @keyframes found.');
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
