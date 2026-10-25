# anni

Kleiner Timeline-Editor für CSS-`@keyframes`. Ein Agent öffnet eine Animation per MCP,
du justierst im Browser Timings und Werte, speicherst – und die CSS-Datei ist aktualisiert.

## Einrichten

```bash
npm install
claude mcp add --scope user anni -- node C:/Users/morit/Desktop/development/anni/src/mcp.js
```

Danach in Claude Code z. B.: *„öffne die bounce-Animation aus styles.css in anni“*.

Ohne Agent geht's auch: `node src/cli.js examples/demo.css`

## MCP-Tools

| Tool | Zweck |
| --- | --- |
| `open_animation(file, animation?, preview?)` | Öffnet `.css` oder `.html` (mit `<style>`) im Editor. Ist schon ein Tab offen, wechselt der, sonst geht ein neuer auf. |
| `get_animation_state()` | Liefert die aktuelle Animation als CSS – inkl. ungespeicherter Änderungen. |
| `list_animations(file)` | Listet alle `@keyframes` einer Datei mit Timing. |

## Editor

- **Vorschau**: Bei einer `.css` sucht anni eine `.html` daneben, die sie einbindet (oder `preview` angeben). Läuft die Animation dort nicht (z. B. nur bei `:hover`), gibt's die **Demo-Box**.
- **Timeline**: eine Spur pro Property. Rauten ziehen = Position ändern (Shift = 0,1 %), Doppelklick = neuer Keyframe, Klick auf Lineal = scrubben.
- **Inspector**: Dauer, Delay, Easing (mit Kurve), Wiederholungen, Richtung, Fill-Mode; Werte des gewählten Keyframes.
- Tasten: `Leertaste` Play/Pause · `←/→` Playhead (Shift = 10 %) · `Entf` Keyframe löschen · `Strg+Z/Strg+Shift+Z` · `Strg+S` speichern.
- Ändert der Agent die Datei, lädt anni sie automatisch neu (bei ungespeicherten Änderungen wird gefragt).

Gespeichert wird nur, was sich geändert hat – der Rest der Datei bleibt unangetastet.
Der Server läuft auf `http://127.0.0.1:4747` (`ANNI_PORT` zum Ändern).
