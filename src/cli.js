#!/usr/bin/env node
// Standalone LOCAL mode without an agent: `node src/cli.js [file.css|file.html] [animation]`.
// Serves the editor bundled in this package on 127.0.0.1 – the hosted anni is `anni-mcp open <file>` (src/sidecar.js).
import path from 'node:path';
import { call, ensureServer } from './client.js';
import { BASE_URL, LOCAL_MODE_NOTE, openBrowser } from './server.js';

const [file, animation] = process.argv.slice(2);
if (['help', '--help', '-h'].includes(file)) {
  console.log(`Usage: anni [file.css|file.html] [animation]\n\n${LOCAL_MODE_NOTE}`);
  process.exit(0);
}
console.log(LOCAL_MODE_NOTE);
const hosting = await ensureServer();
let clients = 0;
if (file) {
  const r = await call('POST', '/api/open', { file: path.resolve(file), animation });
  clients = r.clients;
  console.log(`Opened "${r.animation}" from ${r.file}`);
}
if (!clients) openBrowser(BASE_URL);
console.log(`anni: ${BASE_URL}`);
if (!hosting) process.exit(0);
console.log('Ctrl+C to stop.');
