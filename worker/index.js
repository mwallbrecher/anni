// Hosted anni on Cloudflare Workers. One Durable Object per session holds the files an agent
// uploaded, the live model and the editor's event streams; /mcp is the remote MCP endpoint
// agents connect to. Sessions are addressed as <id>.<ANNI_HOST> (isolated origins, preferred)
// or /s/<id>/ (path mode, e.g. on workers.dev where there is no wildcard).
import { createMcpHandler } from 'agents/mcp/server';
import { call, createServer, isSessionId, openSession, sessionStub } from './mcp.js';
import { editorAsset, isEditorAsset, versionOf } from './assets.js';

export { AnniSession } from './session.js';

const ID_RE = /^[a-z0-9]{8,32}$/;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** Session id + base path for a request, or null when it targets the root site. */
function locate(url, env) {
  const base = (env.ANNI_HOST || '').toLowerCase();
  if (base && url.host.toLowerCase().endsWith(`.${base}`)) {
    const id = url.host.slice(0, -(base.length + 1)).toLowerCase();
    if (ID_RE.test(id)) return { id, base: '' };
  }
  const m = url.pathname.match(/^\/s\/([a-z0-9]{8,32})(\/.*)?$/i);
  if (m) return { id: m[1].toLowerCase(), base: `/s/${m[1].toLowerCase()}`, rest: m[2] };
  return null;
}

/** With ANNI_TOKEN set (wrangler secret), agents must send it as a bearer token; session pages stay link-capability. */
function authorized(request, env) {
  if (!env.ANNI_TOKEN) return true;
  const h = request.headers.get('authorization') || '';
  return h === `Bearer ${env.ANNI_TOKEN}`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const loc = locate(url, env);
    if ((url.pathname === '/mcp' || url.pathname.startsWith('/api/sessions')) && !authorized(request, env)) {
      return json({ error: 'This anni instance requires a token (Authorization: Bearer …)' }, 401);
    }
    if (loc) {
      if (loc.base && !loc.rest) return Response.redirect(`${url.origin}${loc.base}/`, 302); // relative assets need the trailing slash
      // The DO sees the session as its own root; `x-anni-base` lets it build URLs in path mode.
      const inner = new URL(url);
      inner.pathname = loc.base ? loc.rest : url.pathname;
      const headers = new Headers(request.headers);
      headers.set('x-anni-base', loc.base);
      return sessionStub(env, loc.id).fetch(new Request(inner, { method: request.method, headers, body: request.body, redirect: 'manual' }));
    }
    if (url.pathname === '/mcp') {
      return createMcpHandler((...a) => createServer(env, url.origin, ...a), {
        allowedHostnames: env.ANNI_HOST ? [env.ANNI_HOST] : undefined,
      })(request, env, ctx);
    }
    // Plain HTTP session API, used by the local sidecar (src/sidecar.js) so file bytes never pass through the model.
    if (url.pathname === '/api/sessions' && request.method === 'POST') {
      try {
        return json(await openSession(env, url.origin, await request.json()));
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }
    const sm = url.pathname.match(/^\/api\/sessions\/([a-z0-9]+)\/(wait|state)$/);
    if (sm && request.method === 'GET') {
      if (!isSessionId(sm[1])) return json({ error: 'Bad session id' }, 400);
      try {
        return json(await call(env, sm[1], sm[2] === 'wait' ? `/internal/wait?${url.searchParams}` : '/internal/state'));
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }
    if (url.pathname === '/api/ping') return json({ app: 'anni', hosted: true });
    if (url.pathname === '/api/version') return json({ version: versionOf(env) });
    if (url.pathname === '/api/session') return json({ session: null, hosted: true, mcpUrl: `${url.origin}/mcp`, ttlDays: 7, tokenRequired: !!env.ANNI_TOKEN });
    if (url.pathname === '/api/events') return new Response('retry: 3600000\n\n', { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } }); // nothing to push at the root
    if (url.pathname.startsWith('/api/')) return json({ error: 'No session in this URL' }, 404);
    if (isEditorAsset(url.pathname)) return editorAsset(env, request, url.pathname);
    return env.ASSETS.fetch(request);
  },
};
