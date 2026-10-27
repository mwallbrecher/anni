// What a copy of a session changed against the state it was copied from – as a change list a coding agent can
// apply to code it may have changed meanwhile (the .anni.md a copy exports; see worker/session.js).
import { describe, modelFromText } from './css.js';

const pct = (o) => `${+o.toFixed(2)}%`;
const TIMING = ['duration', 'delay', 'easing', 'iterations', 'direction', 'fill'];
const fmtTiming = (k, v) => (k === 'duration' || k === 'delay' ? `${v}ms` : String(v));

/** offset (2 decimals) -> { prop: value } – shared blocks (`0%, 100% {}`) count once per offset. */
function flatten(anim) {
  const map = new Map();
  for (const b of anim.keyframes) {
    for (const o of b.offsets) {
      const k = +o.toFixed(2);
      const decls = map.get(k) || {};
      for (const d of b.decls) if (d.prop) decls[d.prop] = `${d.value}${d.important ? ' !important' : ''}`;
      map.set(k, decls);
    }
  }
  return map;
}

function diffAnimation(base, next) {
  const timing = TIMING.filter((k) => base.timing[k] !== next.timing[k]).map((k) => ({ field: k, from: fmtTiming(k, base.timing[k]), to: fmtTiming(k, next.timing[k]) }));
  const a = flatten(base);
  const b = flatten(next);
  const values = [];
  for (const [o, da] of a) {
    const db = b.get(o);
    if (!db) continue;
    for (const prop of new Set([...Object.keys(da), ...Object.keys(db)])) {
      if (da[prop] !== db[prop]) values.push({ at: o, prop, from: da[prop] ?? null, to: db[prop] ?? null });
    }
  }
  // Keyframes only on one side: same values at another offset = moved, the rest = removed / added.
  const gone = [...a.keys()].filter((o) => !b.has(o));
  const added = [...b.keys()].filter((o) => !a.has(o));
  const moved = [];
  for (const o of [...gone]) {
    const same = added.filter((n) => JSON.stringify(a.get(o)) === JSON.stringify(b.get(n))).sort((x, y) => Math.abs(x - o) - Math.abs(y - o))[0];
    if (same === undefined) continue;
    moved.push({ from: o, to: same, values: a.get(o) });
    gone.splice(gone.indexOf(o), 1);
    added.splice(added.indexOf(same), 1);
  }
  return {
    name: next.name,
    selector: next.usage?.selector || base.usage?.selector || null,
    timing,
    moved,
    values,
    removed: gone.map((o) => ({ at: o, values: a.get(o) })),
    added: added.map((o) => ({ at: o, values: b.get(o) })),
  };
}

/** Changes between two versions of the edited css/html file. */
export function cssChanges(baseText, text, kind, file) {
  const base = modelFromText(baseText, kind, file).animations;
  const next = modelFromText(text, kind, file).animations;
  const changed = [];
  for (const n of next) {
    const b = base.find((x) => x.name === n.name);
    if (!b) {
      changed.push({ name: n.name, selector: n.usage?.selector || null, new: true, css: describe(n) });
      continue;
    }
    const d = diffAnimation(b, n);
    if (d.timing.length || d.moved.length || d.values.length || d.removed.length || d.added.length) changed.push({ ...d, css: describe(n) });
  }
  for (const b of base) if (!next.some((n) => n.name === b.name)) changed.push({ name: b.name, deleted: true });
  return changed;
}

/** Unified diff of two texts (line LCS, 3 lines of context). Big files get a note instead. */
export function lineDiff(a, b, name) {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > 4e6) return null;
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) ops.push([' ', x[i++], j++]);
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push(['-', x[i++]]); // removals first, as diffs read
    else ops.push(['+', y[j++]]);
  }
  // Hunks: changed lines closer than 7 lines apart share one, each with 3 lines of context around it.
  const changedAt = ops.map((op, k) => (op[0] === ' ' ? -1 : k)).filter((k) => k >= 0);
  if (!changedAt.length) return '';
  const hunks = [];
  for (const k of changedAt) {
    const last = hunks[hunks.length - 1];
    if (last && k - last[1] <= 6) last[1] = k;
    else hunks.push([k, k]);
  }
  const out = [`--- a/${name}`, `+++ b/${name}`];
  for (const [first, last] of hunks) {
    out.push('@@');
    for (const op of ops.slice(Math.max(0, first - 3), Math.min(ops.length, last + 4))) out.push(`${op[0]}${op[1]}`);
  }
  return out.join('\n');
}

const valueList = (values) =>
  Object.entries(values)
    .map(([p, v]) => `\`${p}: ${v}\``)
    .join(', ') || '(no values)';

/** The .anni.md a copy exports: instructions for the coding agent, the changes, the resulting CSS, a diff, JSON. */
export function changeMarkdown({ author, at, file, parent, rev, changes, diff, schema }) {
  const when = new Date(at).toISOString().replace('T', ' ').slice(0, 16);
  const who = author || 'someone';
  const lines = [
    `# anni changes${changes.length ? `: ${changes.map((c) => c.name || c.label || c.id).slice(0, 4).join(', ')}` : ''}`,
    '',
    `Proposed by **${who}** in anni on ${when} UTC, in a copy of session \`${parent}\` – based on revision ${rev} of \`${file}\`.`,
    `${who} tuned this in a visual editor and may not have the code. When you apply it:`,
    '',
    '- Change only what is listed below. Keep everything else in the code as it is, including changes made after this revision and other animations.',
    '- Each change says what the value was (**before**) and what it should become (**after**). If the code no longer has the *before* value – it was changed there meanwhile – that is a conflict: don\'t overwrite it silently, tell the user which values conflict and ask which to keep.',
    schema ? '- Each control lists where its value lives in code (its source), as the agent that presented it described it.' : '- Keyframe positions are percentages of the animation\'s duration; "moved" means the same values now sit at another position.',
    '',
  ];
  if (!changes.length) lines.push('_No changes against that revision._', '');
  for (const c of changes) {
    if (schema) continue;
    lines.push(`## @keyframes ${c.name}${c.selector ? ` (used by \`${c.selector}\`)` : ''}`, '');
    if (c.new) lines.push('New animation – add it:', '', '```css', c.css, '```', '');
    else if (c.deleted) lines.push('Removed in the copy. Remove it (and its `animation` entry) only if the user confirms.', '');
    else {
      if (c.timing.length) lines.push('**Timing**', '', ...c.timing.map((t) => `- ${t.field}: ${t.from} → **${t.to}**`), '');
      if (c.moved.length) lines.push('**Moved keyframes**', '', ...c.moved.map((mv) => `- ${pct(mv.from)} → **${pct(mv.to)}** (${valueList(mv.values)})`), '');
      if (c.values.length) {
        lines.push('**Changed values**', '', '| Keyframe | Property | Before | After |', '|---|---|---|---|');
        for (const v of c.values) lines.push(`| ${pct(v.at)} | \`${v.prop}\` | ${v.from === null ? '_(not set)_' : `\`${v.from}\``} | ${v.to === null ? '_(removed)_' : `**\`${v.to}\`**`} |`);
        lines.push('');
      }
      if (c.added.length) lines.push('**Added keyframes**', '', ...c.added.map((k) => `- ${pct(k.at)}: ${valueList(k.values)}`), '');
      if (c.removed.length) lines.push('**Removed keyframes**', '', ...c.removed.map((k) => `- ${pct(k.at)}: ${valueList(k.values)}`), '');
      lines.push('<details><summary>Resulting animation</summary>', '', '```css', c.css, '```', '</details>', '');
    }
  }
  if (schema && changes.length) {
    lines.push('## Changed values', '', '| Control | Before | After | Where in code |', '|---|---|---|---|');
    for (const c of changes) lines.push(`| ${c.label || c.id} | \`${c.from}\` | **\`${c.to}\`** | ${c.source ? `\`${c.source.file}\`${c.source.find ? ` – near \`${c.source.find.split('\n')[0].trim().slice(0, 60)}\`` : ''}` : '_(not wired)_'} |`);
    lines.push('');
  }
  if (diff) lines.push('## Diff against that revision', '', '```diff', diff, '```', '');
  lines.push('<!-- anni-changes', JSON.stringify({ anni: 1, author: who, at, file, base: { session: parent, rev }, changes }), '-->', '');
  return lines.join('\n');
}

/** A one-line summary for lists ("bounce: 2 timing, 3 values · pop: new"). */
export function changeSummary(changes, schema) {
  if (!changes.length) return 'No changes';
  if (schema) return `${changes.length} value${changes.length === 1 ? '' : 's'}`;
  return changes
    .map((c) => {
      if (c.new) return `${c.name}: new`;
      if (c.deleted) return `${c.name}: removed`;
      const parts = [
        c.timing.length && `${c.timing.length} timing`,
        c.moved.length && `${c.moved.length} moved`,
        c.values.length && `${c.values.length} value${c.values.length === 1 ? '' : 's'}`,
        c.added.length && `${c.added.length} added`,
        c.removed.length && `${c.removed.length} removed`,
      ].filter(Boolean);
      return `${c.name}: ${parts.join(', ')}`;
    })
    .join(' · ');
}
