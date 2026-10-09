import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { relocate } from '../security.mjs';
import { switches, switchedFiles } from '../cutover.mjs';
import { copyExistingProject } from '../existing-project.mjs';

export function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-boundary-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [, file] of switches) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `# original ${file}\n`, { mode: file.endsWith('.sh') ? 0o751 : 0o640 });
  }
  return root;
}
export function inventory(t, { live } = {}) {
  const root = fixture(t), copy = path.join(root, 'existing/bch-cloak'), candidate = path.join(root, 'candidate');
  const snapshot = path.resolve(import.meta.dirname, 'fixtures/bch-cloak-20261004');
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, 'manifest.json')));
  const spec = { copy, candidate, workspace: 'owned-workspace', target: 'new-target', legacyTarget: 'legacy-target', home: path.join(root, 'copy-home') };
  const source = live ? path.join(root, 'raw') : snapshot;
  const selected = live ? copyExistingProject({ live, copy: path.join(root, 'raw'), backup: path.join(root, 'backup') }) : manifest;
  for (const { file, mode } of selected.files) {
    const text = relocate(fs.readFileSync(path.join(source, file), 'utf8'), {
      live: live ?? manifest.source, home: '/Users/rewt', scratchHome: spec.home, copy, candidate, root,
      launcher: file === 'scripts/lane/launch-supervisor.mjs',
    }).replaceAll('wFN', spec.workspace).replaceAll('supervisor-opus', spec.legacyTarget);
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
    fs.writeFileSync(path.join(copy, file), text, { mode });
  }
  return { root, copy, spec, edits: switchedFiles(spec), manifest: selected };
}
