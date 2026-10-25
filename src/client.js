// Shared by the MCP server and the CLI: makes sure exactly one anni HTTP server runs on
// the port (the first process hosts it, later ones reuse it) and talks to it.
import { BASE_URL, startServer } from './server.js';

export async function ping() {
  try {
    const res = await fetch(`${BASE_URL}/api/ping`);
    return (await res.json()).app === 'anni';
  } catch {
    return false;
  }
}

/** Returns true if this process now hosts the server. */
export async function ensureServer() {
  if (await ping()) return false;
  try {
    await startServer();
    return true;
  } catch (e) {
    if (e.code === 'EADDRINUSE' && (await ping())) return false;
    throw e.code === 'EADDRINUSE' ? new Error(`Port ${BASE_URL} is used by another program (set ANNI_PORT).`) : e;
  }
}

export async function call(method, route, body) {
  await ensureServer();
  const res = await fetch(BASE_URL + route, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
