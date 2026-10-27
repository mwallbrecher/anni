// What search engines and AI agents get from the root site: the head (description, Open Graph, JSON-LD), a static
// copy of the homepage for clients that don't run scripts (the editor replaces it on load), robots.txt, a sitemap
// and llms.txt. Sessions stay out of all of it (noindex, robots Disallow). Keep the copy in step with renderHome
// in web/app.js.

const TITLE = 'anni – edit CSS animations in an editor built for it';
const DESCRIPTION =
  'Simple, but powerful: your coding agent opens the CSS animations from your project in anni over MCP. You tune keyframes, timing and easing on your real page; the agent writes them back.';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const setup = (origin) => [
  ['Claude Code', 'claude mcp add anni -- npx -y anni-mcp'],
  ['Codex', 'codex mcp add anni -- npx -y anni-mcp'],
  ['Cursor and other MCP clients (mcpServers)', '{ "mcpServers": { "anni": { "command": "npx", "args": [ "-y", "anni-mcp" ] } } }'],
  ['Zero-install, any Streamable HTTP client', `claude mcp add --transport http anni ${origin}/mcp`],
  ['Local mode, offline on 127.0.0.1', 'claude mcp add anni -- npx -y -p anni-mcp anni-mcp-local'],
];

const STEPS = [
  ['Your agent opens it', 'Over MCP your agent calls open_animation with a file path. The sidecar on your machine reads the stylesheet, the page that links it and its assets, and uploads them into a new session. File contents never pass through the model – a whole session costs a few hundred tokens.'],
  ['You tune it on the real page', 'The editor loads your page in a frame and pauses every CSS animation on it with the Web Animations API; one playhead drives them all. Keyframes, timing, easing and styles preview live while you drag.'],
  ['Save writes it back', 'Save sends the edited file to the agent, which is waiting in wait_for_save. The sidecar writes only the changed declarations to disk and hands the agent a short diff – the rest of the file stays untouched.'],
];

const FAQ = [
  ['What is anni?', 'An editor for the CSS animations that already live in your project. Your coding agent opens them in anni over MCP, you tune keyframes, timing and easing on a timeline over your real page, and the agent writes the result back to your files. It is not a standalone animation app.'],
  ['Why not just prompt the agent?', 'Describing easing and timing in English takes round after round of re-prompts. In anni you drag the keyframes until the motion feels right, and the agent writes exactly that – with zero re-prompts and a few hundred tokens per session.'],
  ['Which agents work with anni?', 'Any MCP client: Claude Code, Codex, Cursor and others, either through the anni-mcp sidecar from npm or the remote Streamable HTTP endpoint.'],
  ['Where are my files stored?', 'Each session is its own Cloudflare Durable Object with its own storage, on its own subdomain with an unguessable id. Only the owner edits. Everything is deleted 7 days after the last activity, or right away when the session is closed. Local mode keeps everything on your machine.'],
];

/** Tags for the root page's <head>. */
export function seoHead(origin) {
  const ld = [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'anni',
      url: `${origin}/`,
      description: DESCRIPTION,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Web, Windows, macOS, Linux',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      image: `${origin}/brand/anni-square.png`,
      author: { '@type': 'Person', name: 'Moritz Wallbrecher', url: 'https://moritzwallbrecher.com' },
      publisher: { '@type': 'Organization', name: 'syntwin', url: 'https://syntwin.ai' },
      sameAs: ['https://github.com/mwallbrecher/anni', 'https://www.npmjs.com/package/anni-mcp'],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    },
  ];
  return [
    `<meta name="description" content="${esc(DESCRIPTION)}">`,
    `<link rel="canonical" href="${origin}/">`,
    `<link rel="alternate" type="text/markdown" title="anni for LLMs" href="${origin}/llms.txt">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="anni">`,
    `<meta property="og:title" content="${esc(TITLE)}">`,
    `<meta property="og:description" content="${esc(DESCRIPTION)}">`,
    `<meta property="og:url" content="${origin}/">`,
    `<meta property="og:image" content="${origin}/brand/anni-square.png">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${esc(TITLE)}">`,
    `<meta name="twitter:description" content="${esc(DESCRIPTION)}">`,
    `<meta name="twitter:image" content="${origin}/brand/anni-square.png">`,
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
  ].join('\n  ');
}

export const seoTitle = TITLE;

/** The homepage as plain HTML, for crawlers and agents that read the page without running it. */
export function seoBody(origin) {
  return `<article class="site-static">
        <h1>Edit CSS animations in an editor built for it.</h1>
        <p>${esc(DESCRIPTION)}</p>
        <h2>Setup</h2>
        <ul>${setup(origin).map(([who, cmd]) => `<li>${esc(who)}: <code>${esc(cmd)}</code></li>`).join('')}</ul>
        <p>Then tell your agent: “open my css animation in anni”.</p>
        <h2>How it works</h2>
        <ol>${STEPS.map(([t, d]) => `<li><strong>${esc(t)}.</strong> ${esc(d)}</li>`).join('')}</ol>
        <h2>Questions</h2>
        <dl>${FAQ.map(([q, a]) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join('')}</dl>
        <p><a href="https://github.com/mwallbrecher/anni">Source on GitHub</a> · <a href="https://www.npmjs.com/package/anni-mcp">anni-mcp on npm</a> · <a href="${origin}/llms.txt">llms.txt</a></p>
      </article>`;
}

export const robotsTxt = (origin) => `User-agent: *
Allow: /$
Allow: /llms.txt
Allow: /brand/
Disallow: /s/
Disallow: /api/
Disallow: /mcp

Sitemap: ${origin}/sitemap.xml
`;

export const sitemapXml = (origin) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>
`;

/** llms.txt (llmstxt.org): what anni is and how an agent connects to it, in Markdown. */
export const llmsTxt = (origin) => `# anni

> Edit CSS animations in an editor built for it. ${DESCRIPTION}

anni is not a standalone animation tool: it edits the keyframes and animations that already live in a project, on the
project's own page, and hands the result back to the code. Instead of re-prompting an agent to describe easing and
timing in English, the user drags keyframes on a timeline until the motion feels right.

## Setup

${setup(origin).map(([who, cmd]) => `- ${who}: \`${cmd}\``).join('\n')}

Then the user says: "open my css animation in anni" (or names a file and an animation).

## MCP tools

- \`open_animation(file, animation?, preview?, extra_files?, session?)\`: opens a .css file (or an .html with <style>) in the editor and returns the link for the user.
- \`wait_for_save(session?)\`: waits for the user to press Save; the sidecar writes the file and returns a short diff.
- \`get_animation_state(session?)\`: the current animation as CSS, including unsaved edits.
- \`list_animations(file)\`: every @keyframes in a file with its timing.
- \`present(schema, files?, preview?)\` and \`wait_for_changes(session?)\`: any values from code (lengths, colours, numbers, text) as live controls, written back on Save.
- \`snapshot_page(url)\`: a route of a running app as static files, so the preview is the real page.
- \`get_proposals(session?)\`: change sets that others exported from a copy of the session.

With the sidecar (\`anni-mcp\`), the model only passes file paths; file contents never travel through its context, so a
session costs a few hundred tokens. Over the remote endpoint (\`${origin}/mcp\`) the agent passes file contents itself.

## How it works

${STEPS.map(([t, d], i) => `${i + 1}. **${t}.** ${d}`).join('\n')}

## Data

${FAQ.slice(3).map(([, a]) => a).join('\n')} Uploads are capped at 1.5 MB per file and 24 MB per session. Self-hosting is
one \`wrangler deploy\`; \`ANNI_TOKEN\` makes an instance require a bearer token.

## Links

- [Homepage](${origin}/)
- [README with the full documentation](https://github.com/mwallbrecher/anni#readme)
- [anni-mcp on npm](https://www.npmjs.com/package/anni-mcp)
`;
