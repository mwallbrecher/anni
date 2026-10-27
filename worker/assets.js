// The editor's own files (index.html, app.js, …), served the same way for the root site and every session.
// Each deploy gets a version (the Worker version id): index.html is never cached and loads app.js / style.css
// as `?v=<version>`, app.js imports its modules the same way, and those URLs are immutable. So a deploy
// reaches every tab on its next load, whatever the browser cached before – and open tabs learn about it
// from /api/version and the session's event stream (see checkVersion in web/app.js).

const EDITOR_ASSETS = new Set(['/', '/index.html', '/app.js', '/props.js', '/example.js', '/style.css']);
export const isEditorAsset = (p) => EDITOR_ASSETS.has(p) || p.startsWith('/brand/') || p.startsWith('/fonts/');

export const versionOf = (env) => env.CF_VERSION_METADATA?.id || 'dev';

/** Immutable caching only on a deployed instance (ANNI_HOST set); in `wrangler dev` every load stays fresh. */
const pinned = (env) => !!env.ANNI_HOST && !!env.CF_VERSION_METADATA?.id;

export async function editorAsset(env, request, pathname) {
  const v = versionOf(env);
  const path = pathname === '/' ? '/index.html' : pathname;
  // No conditional headers: the rewritten files need a full body, and caching is decided below. The page is
  // asked for as `/` – Workers assets answer `/index.html` with a redirect to `/`.
  const res = await env.ASSETS.fetch(new Request(new URL(path === '/index.html' ? '/' : path, 'https://assets.invalid')));
  const headers = new Headers(res.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  if (!res.ok) return new Response(res.body, { status: res.status, headers });

  if (path === '/index.html' || path === '/app.js') headers.delete('ETag'); // rewritten below: the asset's ETag no longer fits
  if (path === '/index.html') {
    const html = (await res.text())
      .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta name="anni-version" content="${v}">`)
      .replace(/(href|src)="(app\.js|style\.css)"/g, `$1="$2?v=${v}"`);
    headers.set('Cache-Control', 'no-store');
    return new Response(html, { headers });
  }

  const current = new URL(request.url).searchParams.get('v') === v;
  headers.set('Cache-Control', current && pinned(env) ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (path === '/app.js') {
    const js = (await res.text()).replace(/(from\s*['"]\.\/[\w-]+\.js)(['"])/g, `$1?v=${v}$2`);
    return new Response(js, { headers });
  }
  return new Response(res.body, { headers });
}
