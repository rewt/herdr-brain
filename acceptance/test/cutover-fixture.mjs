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
    // The frozen kit predates the current notification and retired-janitor wording.
    if (file.endsWith('WORK-PATTERN.md')) text = text.replace(`**A finished worker closes itself.** When its watcher delivers an \`outcome: done\` report, it closes the worker's tab.
  A blocked or needs-human worker keeps its tab so the pane can be read.
- **The janitor** (\`janitor.sh start\`; check with \`janitor.sh status\`) runs \`close-finished-agents.sh\` and
  \`tidy-tabs.sh\` every 10 minutes. The log is \`watch-logs/janitor.log\`. It closes:
  - done or idle agents whose run is over, or whose report file already exists;
  - tabs with no live agent, confirmed a minute later, never a workspace's first tab;
  - notify and watch tabs of finished runs;
  - workspaces of closed lanes.`, `**A finished worker closes itself.** When its watcher has queued the notification for an \`outcome: done\` report, it closes the
  worker's tab (the report file is the record; supervisor-events delivers the notification when the input box is empty). If the
  notification cannot be queued, the watcher exits 1 and closes nothing.
  A blocked or needs-human worker keeps its tab so the pane can be read.
- **No janitor (retired 2026-10-03).** Its 60-second tick polled herdr. Finished workers' tabs close when their report notification is queued
  (above). Run \`close-finished-agents.sh\` and \`tidy-tabs.sh\` by hand at each settle or shift end; they are one-shot.`);
    if (file.endsWith('WORK-PATTERN.md')) text = text.replace(`- Reports go to the pane in \`wFN\`'s tab labelled **\`supervisor\`**, whatever its pane id. Each delivery also re-applies
  the name \`supervisor-opus\` to it, and the name is the fallback when no such tab exists. The SessionStart hook
  (\`session-start.sh\`) re-applies it at session start.`, `- Reports go to the agent named exactly **\`supervisor-opus\`** (no fallback since 2026-10-03; the old wFN/cwd fallback could hit
  another session). The SessionStart hook (\`session-start.sh\`) applies the name at session start; if it is missing, run
  \`herdr agent rename <supervisor pane> supervisor-opus\`. Undelivered messages wait in \`.lane/supervisor/outbox/\`.`);
    if (file.endsWith('launch-supervisor.mjs')) text = text.replace(/const SETTLE_WATCH = .*;/, `const SETTLE_WATCH = ${JSON.stringify(path.join(candidate, 'contrib/settle-watch.mjs'))};`);
    text = relocate(text, { live: '/Users/rewt/development/bastian/bch-cloak', home: '/Users/rewt', scratchHome: spec.home, copy, candidate, root })
      .replaceAll('wFN', spec.workspace).replaceAll('supervisor-opus', spec.legacyTarget);
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true }); fs.writeFileSync(path.join(copy, file), text);
  }
  return { root, copy, spec, edits: switchedFiles(spec) };
}
