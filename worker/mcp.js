// Remote MCP tools (stateless; every call names its session). The agent reads the project files
// itself, hands their contents to open_animation, sends the user the session link, and writes the
// edited file back to disk when wait_for_save returns it.
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { describe, kindOf, modelFromText } from '../src/css.js';

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

async function call(env, id, path, body) {
  const res = await sessionStub(env, id).fetch(new Request(`https://session.invalid${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}));
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const fileSchema = z.object({ path: z.string().describe('Path relative to the project, e.g. "css/styles.css"'), content: z.string().describe('Full text content of the file') });

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
        'Afterwards call wait_for_save with the returned session id: it returns the edited file when the user saves, and you write it back to disk. ' +
        'Pass `session` to update a session that is already open in a tab (e.g. after you changed the file).',
      inputSchema: z.object({
        files: z.array(fileSchema).min(1).describe('The file with the @keyframes and, ideally, the HTML page that uses it plus linked CSS'),
        file: z.string().describe('Path (as given in files) of the file that contains the @keyframes to edit'),
        animation: z.string().optional().describe('Name of the @keyframes to select. Defaults to the first one.'),
        preview: z.string().optional().describe('Path (as given in files) of the HTML page to preview on. Defaults to an uploaded .html that references the file.'),
        session: z.string().optional().describe('Existing session id to reuse'),
      }),
    },
    async ({ files, file, animation, preview, session }) => {
      try {
        const id = session && /^[a-z0-9]{8,32}$/.test(session) ? session : newId();
        const r = await call(env, id, '/internal/open', { files, file, animation, preview });
        const list = r.animations
          .map((a) => `- ${a.name}${a.usage ? ` (used by ${a.usage.selector}, ${a.timing.duration}ms)` : ' (not used by any rule)'}`)
          .join('\n');
        return text(
          [
            `Opened "${r.animation}" from ${r.file} in anni.`,
            `Session: ${id}`,
            `Link for the user: ${sessionUrl(env, origin, id)}`,
            r.clients ? 'An editor tab is already open on this session and switched to it.' : 'Ask the user to open the link.',
            `Preview: ${r.preview ?? 'demo box (no HTML page among the files)'}`,
            '',
            'Animations in this file:',
            list,
            '',
            `Next: call wait_for_save with session "${id}". When it returns saved=true, write its content to ${r.file} on disk.`,
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
        since_rev: z.number().int().optional().describe('Only return a save newer than this revision (from a previous result). Defaults to the latest.'),
        timeout_seconds: z.number().int().min(1).max(300).optional().describe('How long to wait (default 60)'),
      }),
    },
    async ({ session, since_rev, timeout_seconds }) => {
      try {
        const state = await call(env, session, '/internal/state');
        if (!state.hasSession) throw new Error(`Unknown session "${session}"`);
        const since = since_rev ?? state.rev;
        const r = await call(env, session, `/internal/wait?since=${since}&timeout=${(timeout_seconds ?? 60) * 1000}`);
        if (!r.saved) return text(`No save yet (timeout). The editor ${r.dirty ? 'has unsaved edits' : 'has no pending edits'}. Call wait_for_save again to keep waiting.`);
        return {
          content: [
            { type: 'text', text: `Saved revision ${r.rev}. Write the following content to ${r.file} (full file):` },
            { type: 'text', text: r.content },
            { type: 'text', text: `Current animations:\n${r.state}` },
          ],
        };
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
      inputSchema: z.object({ session: z.string().describe('Session id from open_animation') }),
    },
    async ({ session }) => {
      try {
        return text((await call(env, session, '/internal/state')).text);
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
