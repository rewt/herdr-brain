import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { relocate } from '../security.mjs';
import { switches, switchedFiles } from '../cutover.mjs';

export function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-boundary-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [, file] of switches) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `# original ${file}\n`, { mode: file.endsWith('.sh') ? 0o751 : 0o640 });
  }
  return root;
}
export function inventory(t) {
  const root = fixture(t), copy = path.join(root, 'existing/bch-cloak'), candidate = path.join(root, 'candidate');
  const kit = path.resolve(import.meta.dirname, '../../kit/bch-cloak-20261001');
  const spec = { copy, candidate, workspace: 'owned-workspace', target: 'new-target', legacyTarget: 'legacy-target', home: path.join(root, 'home') };
  for (const [, file] of switches) {
    const source = file.replace('.lane/supervisor/', 'supervisor/').replace('scripts/lane/', 'lane/');
    let text = fs.readFileSync(path.join(kit, source), 'utf8');
    // Read-only snapshot of bch-cloak's current document; tests need no live checkout.
    if (file.endsWith('WORK-PATTERN.md')) text = fs.readFileSync(new URL('./fixtures/bch-cloak-WORK-PATTERN-20261004.md', import.meta.url), 'utf8');
    if (file.endsWith('launch-supervisor.mjs')) text = text.replace(/const SETTLE_WATCH = .*;/, `const SETTLE_WATCH = ${JSON.stringify(path.join(candidate, 'contrib/settle-watch.mjs'))};`);
    text = relocate(text, { live: '/Users/rewt/development/bastian/bch-cloak', home: '/Users/rewt', scratchHome: spec.home, copy, candidate, root })
      .replaceAll('wFN', spec.workspace).replaceAll('supervisor-opus', spec.legacyTarget);
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true }); fs.writeFileSync(path.join(copy, file), text);
  }
  return { root, copy, spec, edits: switchedFiles(spec) };
}
