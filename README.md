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

## MCP tools

| Tool | Purpose |
| --- | --- |
| `open_animation(file, animation?, preview?)` | Opens a `.css` or `.html` (with `<style>`) in the editor. Reuses the open tab if there is one, otherwise opens a new one. |
| `get_animation_state()` | Returns the current animation as CSS – including unsaved edits. |
| `list_animations(file)` | Lists every `@keyframes` in a file with its timing. |

## Editor

- **Preview**: for a `.css` file anni looks for an `.html` next to it that links it (or pass `preview`). If the animation doesn't run there (e.g. only on `:hover`), there's a **demo box**.
- **Pick element** (`V`): click an element right in the preview, like in Figma or Rive. anni jumps to its animation, or creates a new `@keyframes` plus `animation` rule for the chosen selector with `+ Animation` (class, id or path selectable; an existing rule is extended, never overwritten).
- **Properties** (Figma-style panel): always shows the common properties (`scale`, `rotate`, `translate`, `transform`, `opacity`, `filter`, colors, sizes) with their value **at the playhead** – keyed, interpolated, or the element's base value. Changing a value keys it at the playhead automatically. The diamond after each value shows its state: filled = set in the keyframe at the playhead (row highlighted), outline = animated but interpolated here, grey = not animated; click it to key/unkey. Editors fit the value: sliders for `opacity`/`scale`, number + unit for lengths and angles, color picker + alpha, and a function list for `transform`/`filter` (`translateY`, `scale`, `rotate`, `blur`, …). Click a property name to edit it as text; type any other property into the field at the bottom.
- **Timeline**: one scene on the page's clock. Every animated element in the preview is a group (bar = delay + duration, hatched = further iterations) with its keyframes; expand it for one track per property. The playhead pauses and drives **every** CSS animation on the page – nothing keeps running on the side. Clicking a group selects its animation and element; animations from other files show greyed out. Drag diamonds to move them (Shift = 0.1 %), double-click a track for a new keyframe, click the ruler to scrub.
- **Inspector**: duration, delay, easing (with curve), iterations, direction, fill mode.
- **Zoom** (like After Effects): trackpad pinch or `⌘`/`Ctrl` + wheel zooms whatever is under the cursor – the timeline around that point in time, or the preview around that spot. `Shift` + wheel pans the timeline; a plain wheel pans the zoomed preview. `0` or the zoom readout resets. Arrow steps follow the zoom: one frame (1/60 s) when zoomed in, larger steps when zoomed out.
- Keys: `Space` play/pause · `←/→` step the playhead · `Shift+←/→` jump to the previous/next keyframe of any element · `Home`/`End` · `0` reset zoom · `V` pick element · `Delete` remove keyframe · `Ctrl+Z` / `Ctrl+Shift+Z` · `Ctrl+S` save.
- If the agent changes the file, anni reloads it automatically (and asks first when you have unsaved edits).

Only what changed is written – the rest of the file stays untouched.
The server runs on `http://127.0.0.1:4747` (`ANNI_PORT` to change it).
