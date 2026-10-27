// Hosted anni on Cloudflare Workers. One Durable Object per session holds the files an agent
// uploaded, the live model and the editor's event streams; /mcp is the remote MCP endpoint
// agents connect to. Sessions are addressed as <id>.<ANNI_HOST> (isolated origins, preferred)
// or /s/<id>/ (path mode, e.g. on workers.dev where there is no wildcard).
import { createMcpHandler } from 'agents/mcp/server';
import { call, createServer, isSessionId, openSession, sessionStub } from './mcp.js';
import { editorAsset, isEditorAsset, versionOf } from './assets.js';
import { llmsTxt, robotsTxt, sitemapXml } from './seo.js';
import { EXAMPLE_ID } from '../web/example.js';

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
      // The editor's files and version come from this Worker, which is always the current deploy. A session
      // object that is still running an older deploy (an open tab keeps it alive) must not hand out its editor.
      if (request.method === 'GET' && isEditorAsset(inner.pathname)) return editorAsset(env, request, inner.pathname);
      if (inner.pathname === '/api/version') return json({ version: versionOf(env) });
      // The agent side of a session is reached through /api/sessions/<id>/… and /mcp only, never by its URL.
      if (inner.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); // sessions are never indexed
      if (inner.pathname.startsWith('/internal/') || inner.pathname === '/export' || inner.pathname === '/proposal') return json({ error: 'Not found' }, 404);
      const headers = new Headers(request.headers);
      headers.set('x-anni-base', loc.base);
      headers.set('x-anni-version', versionOf(env));
      headers.delete('x-anni-example'); // only this Worker marks the example, never a client
      if (loc.id === EXAMPLE_ID) headers.set('x-anni-example', '1');
      // "Edit a copy": whoever may watch this session gets a new one with the same files, as its owner.
      if (inner.pathname === '/api/fork' && request.method === 'POST') {
        try {
          const res = await sessionStub(env, loc.id).fetch(new Request('https://session.invalid/export', { headers }));
          const data = await res.json();
          if (!res.ok) return json(data, res.status);
          const { name } = await request.json().catch(() => ({}));
          // The copy remembers where it came from and the state it started from, to export changes against.
          const base = data.schema ? { values: Object.fromEntries(data.schema.groups.flatMap((g) => g.controls).map((c) => [c.id, String(c.value)])) } : { file: data.file, content: data.files.find((f) => f.path === data.file)?.content };
          // A copy of the shared example is a plain session of its own: nobody there to export changes to.
          const origin = loc.id === EXAMPLE_ID ? {} : { forkOf: { session: loc.id, rev: data.rev, owner: data.owner }, base };
          const r = await openSession(env, url.origin, { ...data, auth: true, ownerName: name, ...origin });
          return json({ url: r.url, token: r.token, session: r.session });
        } catch (e) {
          return json({ error: e.message }, 400);
        }
      }
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
      const send = () => sessionStub(env, loc.id).fetch(new Request(inner, { method: request.method, headers, body, redirect: 'manual' }));
      try {
        return await send();
      } catch {
        return send(); // an outdated session object resets itself (see AnniSession.fetch); the retry reaches the new one
      }
    }
    if (url.pathname === '/mcp') {
      return createMcpHandler((...a) => createServer(env, url.origin, ...a), {
        allowedHostnames: env.ANNI_HOST ? [env.ANNI_HOST] : undefined,
      })(request, env, ctx);
    }
    // Plain HTTP session API, used by the local sidecar (src/sidecar.js) so file bytes never pass through the model.
    // A session's owner token travels as x-anni-owner (new sessions: { auth: true } returns one).
    const ownerToken = request.headers.get('x-anni-owner') || undefined;
    if (url.pathname === '/api/sessions' && request.method === 'POST') {
      try {
        return json(await openSession(env, url.origin, await request.json(), ownerToken));
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }
    const sm = url.pathname.match(/^\/api\/sessions\/([a-z0-9]+)\/(wait|state|proposals)$/);
    if (sm && request.method === 'GET') {
      if (!isSessionId(sm[1])) return json({ error: 'Bad session id' }, 400);
      try {
        const path = sm[2] === 'wait' ? `/internal/wait?${url.searchParams}` : `/internal/${sm[2]}`;
        return json(await call(env, sm[1], path, undefined, ownerToken));
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }
    // The sidecar syncs edits to the uploaded files on disk into the open session.
    const um = url.pathname.match(/^\/api\/sessions\/([a-z0-9]+)\/update$/);
    if (um && request.method === 'POST') {
      if (!isSessionId(um[1])) return json({ error: 'Bad session id' }, 400);
      try {
        return json(await call(env, um[1], '/internal/update', await request.json(), ownerToken));
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }
    if (url.pathname === '/api/ping') return json({ app: 'anni', hosted: true });
    if (url.pathname === '/api/version') return json({ version: versionOf(env) });
    if (url.pathname === '/api/session') return json({ session: null, hosted: true, mcpUrl: `${url.origin}/mcp`, ttlDays: 7, tokenRequired: !!env.ANNI_TOKEN });
    if (url.pathname === '/api/events') return new Response('retry: 3600000\n\n', { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } }); // nothing to push at the root
    if (url.pathname.startsWith('/api/')) return json({ error: 'No session in this URL' }, 404);
    const doc = { '/robots.txt': ['text/plain', robotsTxt], '/sitemap.xml': ['application/xml', sitemapXml], '/llms.txt': ['text/markdown', llmsTxt] }[url.pathname];
    if (doc) return new Response(doc[1](url.origin), { headers: { 'Content-Type': `${doc[0]}; charset=utf-8`, 'Cache-Control': 'public, max-age=3600' } });
    if (isEditorAsset(url.pathname)) return editorAsset(env, request, url.pathname, url.origin);
    return env.ASSETS.fetch(request);
  },
};
