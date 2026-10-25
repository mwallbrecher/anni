#!/usr/bin/env node
// MCP server (stdio). Lets an agent open a CSS animation in the anni editor and read
// back what the user tuned there. Never write to stdout here: it is the MCP channel.
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { describe, loadModel } from './css.js';
import { call, ensureServer } from './client.js';
import { BASE_URL, openBrowser } from './server.js';

const server = new McpServer({ name: 'anni', version: '0.1.0' });

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (e) => ({ ...text(`Error: ${e.message}`), isError: true });

server.registerTool(
  'open_animation',
  {
    title: 'Open animation in anni',
    description:
      'Opens a CSS animation (@keyframes) in the anni editor, a local web app with a timeline where the user can scrub, ' +
      'drag keyframes and edit timing and values. Use when the user says something like "open the animation in anni". ' +
      'The file can be a .css file or an .html file with <style> blocks. When the user saves in anni, the file on disk is ' +
      'updated in place; use get_animation_state to read their (possibly unsaved) edits.',
    inputSchema: {
      file: z.string().describe('Path to the .css or .html file containing the @keyframes (absolute, or relative to the working directory)'),
      animation: z.string().optional().describe('Name of the @keyframes to select. Defaults to the first one in the file.'),
      preview: z
        .string()
        .optional()
        .describe('HTML page to show the animation on (only for .css files). If omitted, anni looks for an .html next to the CSS that links it, else shows a demo box.'),
    },
  },
  async ({ file, animation, preview }) => {
    try {
      const r = await call('POST', '/api/open', {
        file: path.resolve(file),
        animation,
        preview: preview && path.resolve(preview),
      });
      if (!r.clients) openBrowser(r.url);
      const list = r.animations
        .map((a) => `- ${a.name}${a.usage ? ` (used by ${a.usage.selector}, ${a.timing.duration}ms)` : ' (not used by any rule)'}`)
        .join('\n');
      return text(
        [
          `Opened "${r.animation}" from ${r.file} in anni: ${r.url}`,
          r.clients ? 'The editor tab that was already open switched to it.' : 'Opened a new browser tab.',
          `Preview: ${r.preview ?? 'demo box (no HTML page found)'}`,
          '',
          'Animations in this file:',
          list,
        ].join('\n'),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'get_animation_state',
  {
    title: 'Read anni editor state',
    description:
      'Returns the animation currently open in anni as CSS, including edits the user has not saved yet, and whether there are unsaved changes.',
    inputSchema: {},
  },
  async () => {
    try {
      return text((await call('GET', '/api/state')).text);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'list_animations',
  {
    title: 'List animations in a file',
    description: 'Lists all @keyframes in a .css or .html file with their keyframes and timing, without opening the editor.',
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

// Host the editor right away so http://127.0.0.1:4747 is up while the agent runs.
ensureServer()
  .then((hosting) => console.error(hosting ? `anni editor on ${BASE_URL}` : `anni editor already running on ${BASE_URL}`))
  .catch((e) => console.error(`anni: ${e.message}`));

await server.connect(new StdioServerTransport());
