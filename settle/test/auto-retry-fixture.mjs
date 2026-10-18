import fs from 'node:fs';
import path from 'node:path';

// Inject a concurrent landing at a durable stage boundary, without changing
// settle's journal or intercepting its checks. All Git/record calls stay real.
export function moveMainOnSave(f, run, stage, { afterAutomaticRecapture = false, dirty = false } = {}) {
  const preload = path.join(f.root, 'move-main-on-save.mjs');
  const marker = path.join(f.root, 'move-main-on-save.json');
  fs.writeFileSync(preload, `
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
if (process.argv[1] === ${JSON.stringify(path.join(f.source, 'settle/settle.mjs'))}) {
 const rename = fs.renameSync;
 fs.renameSync = function (from, to) {
  const result = rename.call(this, from, to);
  if (path.resolve(to) === ${JSON.stringify(path.join(f.org, 'settle', `${run}.json`))} && !fs.existsSync(${JSON.stringify(marker)})) {
   const saved = JSON.parse(fs.readFileSync(to));
   if (saved.stage === ${JSON.stringify(stage)} && (!${afterAutomaticRecapture} || saved.automaticBaseRetry && saved.recaptures?.length === 1 && !saved.recapture)) {
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(saved));
    const file = ${JSON.stringify(afterAutomaticRecapture ? 'second-upstream.txt' : 'upstream.txt')};
    fs.writeFileSync(path.join(${JSON.stringify(f.repo)}, file), 'upstream change\\n');
    const git = args => execFileSync('git', ['-C', ${JSON.stringify(f.repo)}, ...args]);
    git(['add', '--', file]); git(['commit', '-qm', 'Move main at saved settle stage']);
    if (${dirty}) fs.writeFileSync(${JSON.stringify(path.join(f.workspace, 'concurrent.txt'))}, 'keep this edit\\n');
   }
  }
  return result;
 };
}
`);
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}`;
  return marker;
}
