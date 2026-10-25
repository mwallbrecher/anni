#!/usr/bin/env node
// Standalone use without an agent: `node src/cli.js [file.css|file.html] [animation]`
import path from 'node:path';
import { call, ensureServer } from './client.js';
import { BASE_URL, openBrowser } from './server.js';

const [file, animation] = process.argv.slice(2);
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
