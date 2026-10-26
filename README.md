# anni

A small timeline editor for CSS `@keyframes`, driven by an agent over MCP. The agent opens an
animation from your project, you tune timing and values in the browser, hit save – and the
CSS file is updated in place. Not a standalone motion tool: it edits the snippets and
animations that already live in your project, on your own page.

## Setup

```bash
npm install
claude mcp add --scope user anni -- node /path/to/anni/src/mcp.js
```

Then, in Claude Code: *“open the bounce animation from styles.css in anni”*.

Without an agent: `node src/cli.js examples/demo.css`

## MCP tools (local)

| Tool | Purpose |
| --- | --- |
| `open_animation(file, animation?, preview?)` | Opens a `.css` or `.html` (with `<style>`) in the editor. Reuses the open tab if there is one, otherwise opens a new one. |
| `get_animation_state()` | Returns the current animation as CSS – including unsaved edits. |
| `list_animations(file)` | Lists every `@keyframes` in a file with its timing. |

## Hosted anni (connect any agent, nothing to install)

The same editor runs on Cloudflare Workers; the public instance is **https://anni.run**. Two ways to connect:

**Recommended – the sidecar** (`anni-mcp` on npm, a tiny local MCP process):

```bash
claude mcp add anni -- npx -y anni-mcp
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.anni]
command = "npx"
args = ["-y", "anni-mcp"]
```

(From a checkout: `claude mcp add anni -- node /path/to/anni/src/sidecar.js`.)

The model only passes **file paths**; the sidecar reads and uploads the files to anni.run itself (plus the
HTML page and the stylesheets/scripts it links), opens the browser tab, and when you hit **Save** it writes the
edited file back to disk and hands the model a short diff. File contents never travel through the model's
context, so a whole editing session costs a few hundred tokens, and every drag in between costs none.
Tools: `open_animation(file, animation?, preview?, extra_files?, session?)`, `wait_for_save(session?)`,
`get_animation_state(session?)`, `list_animations(file)`, plus `present` / `wait_for_changes` (below) and
`snapshot_page(url)`, which fetches a route of a *running* app – dev server, staging, anything – into static files
(page, stylesheets, fonts, images; scripts stripped) so the preview is the real page. `ANNI_URL` points the sidecar at a
self-hosted instance.

**Zero-install – the remote MCP endpoint** (Streamable HTTP), for clients that can't run a local process:

```bash
claude mcp add --transport http anni https://anni.run/mcp
```

Here the agent does the file I/O itself: it passes file *contents* to `open_animation(files, file, …)` and
writes back what `wait_for_save(session)` returns. Same editor, same sessions – just more tokens.

### Any value, not just keyframes: `present`

The agent can turn *any* values from code into a panel. It describes controls; anni renders them next to the page;
each control carries two wires:

```json
{ "id": "radius", "label": "Radius", "type": "length", "value": "8px", "min": 0, "max": 32,
  "preview": { "css": { "selector": ".primary-button", "prop": "border-radius" } },
  "source":  { "file": "src/app/globals.css",
               "find": "  border-radius: 8px;\n  background: var(--ink);",
               "replace": "  border-radius: {{value}};\n  background: var(--ink);" } }
```

- **preview wire** – how the value shows on the uploaded page, applied live by anni while you drag:
  `css: {selector, prop}` (a declaration), `var: {name, scope?}` (a custom property) or `text: {selector}`.
- **source wire** – where the value lives in code: `find` (a snippet that occurs exactly once) with an optional
  `replace` template, or `range: [start, end]` with a `template`. Omit it and the change is only reported.

Types: `number`, `length`, `color`, `enum`, `boolean`, `text`. The preview page is typically a rendered route of the
running app (fetch its HTML and CSS to files) – so this works for React, Vue, Rails, anything that renders to the browser;
the code wires can point at a `.tsx`, a theme file, Tailwind config, wherever the literal is.

`present(schema, files?, preview?)` → link · `wait_for_changes(session?)` → on Save the sidecar applies every change
with a source wire to your files and returns the diffs; changes without one are listed for the agent. Over the remote
endpoint the agent receives `{id, from, to, source}` and applies them itself.

Sessions are unguessable ids; there are no accounts. A session – the files you opened included – is wiped
**7 days after its last activity**, and anyone with the link can see it until then: don't open secrets, and self-host
for anything sensitive. Uploads are capped (1.5 MB per file, 24 MB per session, 300 files). The HTTP API the sidecar
uses is plain JSON: `POST /api/sessions`, `GET /api/sessions/<id>/wait?since=&timeout=`, `GET /api/sessions/<id>/state`.

**Private instance:** `wrangler secret put ANNI_TOKEN --env production` makes `/mcp` and the session API require
`Authorization: Bearer <token>`. The sidecar sends it from the `ANNI_TOKEN` environment variable; for the remote
endpoint use `claude mcp add --transport http anni https://… --header "Authorization: Bearer <token>"`.

### Deploying your own

```bash
npm install
npm run dev:worker          # http://localhost:8787 – sessions at /s/<id>/
npm run deploy              # wrangler deploy --env production
```

Edit the `production` block in `wrangler.jsonc`:

- `ANNI_HOST` – the host of the root site, e.g. `anni.example.com`.
- `ANNI_URL_MODE` – `subdomain` gives every session its own origin (`<id>.anni.example.com`), which is what isolates
  one user's preview page from another's. It needs the wildcard route in the config **and** a proxied wildcard DNS
  record (`*.anni` → `192.0.2.1`, orange cloud). Note that Cloudflare's free Universal SSL only covers one level
  (`*.example.com`): a second-level wildcard like `*.anni.example.com` needs Advanced Certificate Manager, or run anni
  on its own domain (`ANNI_HOST=anni.run`, sessions at `<id>.anni.run`).
- `path` mode (`/s/<id>/` on one origin) needs no wildcard and works on `workers.dev`, but all sessions share
  an origin, so a malicious page uploaded to one session could script another. Fine for a trusted team, not for the open web.

Everything is one Durable Object per session (files, live model, open tabs, waiting agents); it fits the free plan.

## Editor

- **Preview**: for a `.css` file anni looks for an `.html` next to it that links it (or pass `preview`). If the animation doesn't run there (e.g. only on `:hover`), there's a **demo box**.
- **Pick element** (`V`): click an element right in the preview, like in Figma or Rive. anni jumps to its animation, or creates a new `@keyframes` plus `animation` rule for the chosen selector with `+ Animation` (class, id or path selectable; an existing rule is extended, never overwritten).
- **Editor | Animate** (`Tab`): two views over the same page, Rive-style. *Animate* is the timeline. *Editor* shows the picked element's **winning CSS declarations** – read from the browser's CSSOM, so they're the truth, in their authored shorthand form (`padding: 8px 16px`) – as controls, grouped Layout / Typography / Appearance / Transform, each labelled with the rule and file it comes from. Edits preview live; on Save anni rewrites that declaration in the uploaded stylesheet (a unique snippet is located around it, nothing else is touched) and the sidecar writes the file back. Declarations anni can't place are handed to the agent.
- **Properties** (Figma-style panel): always shows the common properties (`scale`, `rotate`, `translate`, `transform`, `opacity`, `filter`, colors, sizes) with their value **at the playhead** – keyed, interpolated, or the element's base value. Changing a value keys it at the playhead automatically. The diamond after each value shows its state: filled = set in the keyframe at the playhead (row highlighted), outline = animated but interpolated here, grey = not animated; click it to key/unkey. Editors fit the value: sliders for `opacity`/`scale`, number + unit for lengths and angles, color picker + alpha, and a function list for `transform`/`filter` (`translateY`, `scale`, `rotate`, `blur`, …). Click a property name to edit it as text; type any other property into the field at the bottom.
- **Timeline**: one scene on the page's clock. Every animated element in the preview is a group (bar = delay + duration, hatched = further iterations) with its keyframes; expand it for one track per property. The playhead pauses and drives **every** CSS animation on the page – nothing keeps running on the side. Clicking a group selects its animation and element; animations from other files show greyed out. Drag diamonds to move them (Shift = 0.1 %), double-click a track for a new keyframe, click the ruler to scrub.
- **Inspector**: duration, delay, easing (with curve), iterations, direction, fill mode.
- **Duration**, two ways: in the **Timing panel** (*Animation duration*) keyframes keep their percentages and stretch with the duration (plain CSS). In the **time box** next to play they keep their times in ms, like a work area in a design tool – a longer duration adds time at the end (a held 100% keyframe keeps the final state), a shorter one trims it (keyframes past the new end move to 100%). The time box also takes a time to jump the playhead to.
- **Delay** is `animation-delay`: the wait before the first iteration. It moves the animation later on the page timeline; repeats don't wait again, and a negative delay starts it partway in.
- **Zoom** (like After Effects): trackpad pinch or `⌘`/`Ctrl` + wheel zooms whatever is under the cursor – the timeline around that point in time, or the preview around that spot. `Shift` + wheel pans the timeline; a plain wheel pans the zoomed preview. `0` or the zoom readout resets. Arrow steps follow the zoom: one frame (1/60 s) when zoomed in, larger steps when zoomed out.
- **Copy & paste keyframes**: `⌘C` / `⌘X` copies the selected keyframe with all its values (as CSS, so it also pastes into your editor), `⌘V` pastes at the playhead – into the keyframe there (values overwrite, the rest stays) or as a new one, also into another animation. CSS copied from elsewhere (`50% { … }` or plain `prop: value;` lines) pastes the same way. A shared `0%, 100%` keyframe is split so only the one under the playhead changes. `⌥`-drag a keyframe to duplicate it.
- Keys: `Space` play/pause · `←/→` step the playhead · `Shift+←/→` jump to the previous/next keyframe of any element · `Home`/`End` · `0` reset zoom · `V` pick element · `Delete` remove keyframe · `⌘C` / `⌘X` / `⌘V` keyframes · `Ctrl+Z` / `Ctrl+Shift+Z` · `Ctrl+S` save.
- If the agent changes the file, anni reloads it automatically (and asks first when you have unsaved edits).

Only what changed is written – the rest of the file stays untouched.
The server runs on `http://127.0.0.1:4747` (`ANNI_PORT` to change it).
