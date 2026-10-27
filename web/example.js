// The homepage's example: a short loop that plays in the hero and opens as a real session in the editor
// ("open my animation in anni"). One source for both, so what you see is what you get to edit.

export const EXAMPLE_CSS = `body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #111111;
  overflow: hidden;
}

.scene {
  position: relative;
  width: 220px;
  height: 220px;
  display: grid;
  place-items: center;
}

.scene > * {
  grid-area: 1 / 1;
}

.frame {
  width: 112px;
  height: 112px;
  border: 2px solid #fafaf9;
  animation: turn 1.6s cubic-bezier(0.7, 0, 0.2, 1) infinite;
}

.ripple {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  border: 2px solid #e97130;
  animation: ripple 1.6s cubic-bezier(0.2, 0.6, 0.3, 1) infinite;
}

.ball {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: #e97130;
  animation: hop 1.6s cubic-bezier(0.5, 0, 0.5, 1) infinite, tint 1.6s ease-in-out infinite;
}

@keyframes hop {
  0%, 100% {
    transform: translateY(-96px) scale(0.85, 1.15);
  }
  38% {
    transform: translateY(0) scale(1.4, 0.6);
  }
  50% {
    transform: translateY(-22px) scale(0.9, 1.1);
  }
  62%, 80% {
    transform: translateY(0) scale(1, 1);
  }
}

@keyframes tint {
  0%, 100% {
    background-color: #e97130;
  }
  40% {
    background-color: #ff9550;
  }
  70% {
    background-color: #e05a28;
  }
}

@keyframes turn {
  0%, 36% {
    transform: rotate(0deg) scale(1);
  }
  48% {
    transform: rotate(105deg) scale(1.14);
  }
  62%, 100% {
    transform: rotate(90deg) scale(1);
  }
}

@keyframes ripple {
  0%, 37% {
    transform: scale(0.4);
    opacity: 0;
  }
  40% {
    transform: scale(0.6);
    opacity: 1;
  }
  76%, 100% {
    transform: scale(2.3);
    opacity: 0;
  }
}
`;

export const EXAMPLE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Drop</title>
  <link rel="stylesheet" href="motion.css">
</head>
<body>
  <div class="scene">
    <div class="frame"></div>
    <div class="ripple"></div>
    <div class="ball"></div>
  </div>
</body>
</html>
`;

/** The session the prompt opens: the same two files an agent would upload. */
export const EXAMPLE_SESSION = {
  files: [
    { path: 'index.html', content: EXAMPLE_HTML },
    { path: 'motion.css', content: EXAMPLE_CSS },
  ],
  file: 'motion.css',
  preview: 'index.html',
  animation: 'hop',
};

/** The hero preview: the page with its stylesheet inlined, for an srcdoc iframe. */
export const exampleDoc = () => EXAMPLE_HTML.replace('<link rel="stylesheet" href="motion.css">', `<style>\n${EXAMPLE_CSS}</style>`);

const kebab = (p) => p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
/** Keyframe members that are timing, not properties. */
export const KEYFRAME_META = new Set(['offset', 'computedOffset', 'easing', 'composite']);

/** EXAMPLE_CSS with @keyframes blocks rewritten from Web Animations keyframes: { name: keyframes[] }. */
export function exampleCssWith(edited) {
  let css = EXAMPLE_CSS;
  for (const [name, frames] of Object.entries(edited)) {
    const start = css.indexOf(`@keyframes ${name} {`);
    if (start < 0) continue;
    let end = start;
    for (let i = css.indexOf('{', start), depth = 0; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    const body = frames.map((k) => {
      const decls = Object.entries(k).filter(([p]) => !KEYFRAME_META.has(p)).map(([p, v]) => `    ${kebab(p)}: ${v};`);
      return `  ${+(k.offset * 100).toFixed(1)}% {\n${decls.join('\n')}\n  }`;
    });
    css = `${css.slice(0, start)}@keyframes ${name} {\n${body.join('\n')}\n}${css.slice(end)}`;
  }
  return css;
}
