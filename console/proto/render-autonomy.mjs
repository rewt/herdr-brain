// Exact full frames for QA, cropped changed regions for the new design study.
import fs from 'node:fs';
import { initialState, key, rowDetail } from './controller.mjs';
import { frame, plain } from './frame.mjs';
import { goals } from './model.mjs';
import { decisions } from './autonomy.mjs';

const folder = new URL('./snapshots/autonomy/', import.meta.url);
const doc = new URL('../../docs/design/console-goals-autonomy-2026-09-19.md', import.meta.url);
const marker = '<!-- GENERATED AUTONOMY: node console/proto/render-autonomy.mjs -->';
const baseline = initialState();
const scenarios = [
  ['goals', 'Rank in the existing cascade',
    { ...baseline, focus: 'goals', goal: 'G-1', cursor: { ...baseline.cursor, goals: 'G-1' } },
    '--goal G-1 --keys Tab,Tab'],
  ['decisions', 'Lasting decision index', key(baseline, 'e'), '--screen decisions'],
  ['decision', 'Why a task was picked', rowDetail(baseline, decisions[0]), '--screen decision'],
  ['authority', 'Current authority, separate from past choices', key(rowDetail(baseline, goals[0]), 'a'), '--screen authority'],
];
let text = fs.readFileSync(doc, 'utf8').split(marker)[0].trimEnd() + `\n\n${marker}\n\n## Exact changed regions\n\nThese are unaltered crops from the same frame Ink renders. Full frames under\n\`console/proto/snapshots/autonomy/\` retain global attention, the session pane\nand navigation. They use 80×30, 100×40 and 140×45. Blank unused body rows are\nomitted here; the old cascade, waiting reader and session table are not redrawn.\nThe original ARCH-3 snapshots remain historical evidence of that design.\n`;
fs.mkdirSync(folder, { recursive: true });
for (const [name, title, s, args] of scenarios) {
  text += `\n### ${title}\n`;
  for (const [w, h] of [[80, 30], [100, 40], [140, 45]]) {
    const f = frame(s, w, h), render = plain(f), lines = render.trimEnd().split('\n');
    fs.writeFileSync(new URL(`${name}-${w}x${h}.txt`, folder), render);
    const end = f.areas.find((a) => a.name === 'sessions').y;
    const crop = lines.slice(4, name === 'goals' ? 12 : name === 'decisions' ? 9 : end - 1);
    while (!crop.at(-1)?.trim() && crop.length) crop.pop();
    text += `\n**${w}×${h}** — \`node console/proto/main.mjs --print ${w}x${h} ${args}\`\n\n\`\`\`text\n${crop.join('\n')}\n\`\`\`\n`;
    text += `\nChanged controls (same frame):\n\n\`\`\`text\n${lines.slice(h - 3).join('\n')}\n\`\`\`\n`;
  }
}
fs.writeFileSync(doc, text);
console.log('Generated 12 autonomy frames and their exact changed regions.');
