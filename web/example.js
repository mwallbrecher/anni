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
  <link rel="stylesheet" href="motion-example.css">
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

/** The shared example session (<id>.anni.run): set up by the Worker, never expires; everyone else gets a copy. */
export const EXAMPLE_ID = 'motionexample';

/** The session the prompt opens: the same two files an agent would upload. */
export const EXAMPLE_SESSION = {
  files: [
    { path: 'index.html', content: EXAMPLE_HTML },
    { path: 'motion-example.css', content: EXAMPLE_CSS },
  ],
  file: 'motion-example.css',
  preview: 'index.html',
  animation: 'hop',
};

/**
 * What the agent adds when asked in the hero ("add a pulsating rectangle"): the pad the ball lands on, part of
 * the choreography. On hop's keyframes and easing it is small and dim while the ball is up, rises to meet the
 * squashed ball on the impact, wide and bright, gives with the small bounce and settles while the ball rests.
 * Written into the stylesheet and the scene (under the ball), as an agent would.
 */
export const ADD_PROMPT = 'add a pulsating rectangle';
export const ADDITION = {
  html: '<div class="rect"></div>',
  css: `
.rect {
  width: 64px;
  height: 6px;
  translate: 0 26px;
  background: #fafaf9;
  animation: pulse 1.6s cubic-bezier(0.5, 0, 0.5, 1) infinite;
}

@keyframes pulse {
  0%, 100% {
    transform: translateY(0) scale(0.45, 1);
    opacity: 0.3;
  }
  38% {
    transform: translateY(-10px) scale(1.5, 0.5);
    opacity: 1;
  }
  50% {
    transform: translateY(0) scale(0.85, 1);
    opacity: 0.6;
  }
  62% {
    transform: translateY(0) scale(1.15, 0.8);
    opacity: 0.95;
  }
  80% {
    transform: translateY(0) scale(1, 1);
    opacity: 0.85;
  }
}
`,
};
export const withAddition = (html) => html.replace('    <div class="ball"></div>\n', `    ${ADDITION.html}\n    <div class="ball"></div>\n`);

/** The hero preview: the page with its stylesheet inlined, for an srcdoc iframe. */
export const exampleDoc = () => EXAMPLE_HTML.replace('<link rel="stylesheet" href="motion-example.css">', `<style>\n${EXAMPLE_CSS}</style>`);

const kebab = (p) => p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
/** Keyframe members that are timing, not properties. */
export const KEYFRAME_META = new Set(['offset', 'computedOffset', 'easing', 'composite']);

/** `css` (the example's) with @keyframes blocks rewritten from Web Animations keyframes: { name: keyframes[] }. */
export function exampleCssWith(edited, css = EXAMPLE_CSS) {
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
