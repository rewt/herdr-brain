// Executed only against audited scratch copies. No live migration command.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export const switches = [
  ['launcher', 'scripts/lane/launch-supervisor.mjs'],
  ['continue', '.lane/supervisor/continue.sh'],
  ['arm', '.lane/supervisor/arm-watch.sh'],
  ['dispatch', '.lane/supervisor/dispatch.sh'],
  ['tidy', '.lane/supervisor/tidy-tabs.sh'],
  ['name', '.lane/supervisor/session-start.sh'],
  ['protocol', '.lane/supervisor/SETTLE.md'],
  ['notices', '.lane/supervisor/WORK-PATTERN.md'],
  ['routes', 'scripts/lane/routing.test.mjs'],
  ['retire', '.lane/supervisor/notify-watch.sh'],
];
const q = (v) => "'" + v.replaceAll("'", "'\\''") + "'";
function replace(text, before, after) {
  assert.ok(text.includes(before), `cutover premise drift: ${before}`);
  return text.replace(before, after);
}
export function switchedFiles({ copy, candidate, workspace, target, legacyTarget, home }) {
  const contents = Object.fromEntries(switches.map(([key, file]) => [key, fs.readFileSync(path.join(copy, file), 'utf8')]));
  contents.launcher = replace(contents.launcher, JSON.stringify(path.join(candidate, 'contrib/settle-watch.mjs')), JSON.stringify(path.join(candidate, 'supervisor/open-session.mjs')));
  contents.continue = '# open-session refuses busy sessions; retain the request and retry after the named session stops.\n' + contents.continue;
  contents.arm = `#!/bin/sh\nset -eu\nRUN=\${1:?run required}; shift\n# This wrapper delivers reports only; routed fresh sessions use launch-supervisor.mjs separately.\nexec node ${q(path.join(candidate, 'watch/watch.mjs'))} "$RUN" --org ${q(path.join(path.dirname(copy), '.org'))} --cwd ${q(copy)} --to ${q(target)} --idle-grace 900 "$@" --detach --log ${q(path.join(copy, '.lane/supervisor/watch-logs'))}/"$RUN".log\n`;
  contents.dispatch = replace(contents.dispatch, `env -u HERDR_PANE_ID nohup .lane/supervisor/notify-watch.sh $RUN --to ${legacyTarget} > .lane/supervisor/watch-logs/$RUN.log 2>&1 < /dev/null &!`, 'env -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID .lane/supervisor/arm-watch.sh $RUN');
  contents.dispatch = contents.dispatch.replaceAll(legacyTarget, target);
  contents.name = replace(contents.name, `${workspace}:*`, `${workspace}:*`);
  contents.name = replace(contents.name, `${legacyTarget} >/dev/null 2>&1 || true`, `${target} >/dev/null || { echo 'supervisor naming failed' >&2; exit 1; }`);
  // The scheduler belongs to its separate acceptance case. Never start a loop.
  contents.name = contents.name.split('\n').filter((line) => !line.includes('janitor.sh start')).join('\n').replace('janitor running', 'scratch scheduler excluded');
  contents.tidy = replace(contents.tidy, 'LOG=$REPO/.lane/supervisor/notify-log.tsv', 'LOG=$REPO/.lane/supervisor/watch-logs');
  contents.tidy = replace(contents.tidy, '[ -f "$LOG" ] && tail -n "$N" "$LOG" | cut -c1-220 || echo "(no log yet)"', 'find "$LOG" -type f -name "R-*.log" -exec cat {} + 2>/dev/null | tail -n "$N"');
  contents.tidy = replace(contents.tidy, '/close-finished-agents.sh |', '/close-finished-agents.sh $([ \"$DRY\" = 1 ] && echo --dry-run) |');
  contents.protocol = contents.protocol.replace('a watcher that will open the next session', 'a watcher that delivers to the supervisor; fresh session launch is separate');
  contents.notices = replace(contents.notices, '**A finished worker closes itself.** When its watcher delivers an `outcome: done` report, it closes the worker\'s tab.', '**Janitor closes finished workers.** The watcher only delivers; janitor closes done worker tabs.');
  contents.notices = contents.notices.replace('starts each notify watcher', 'starts each standalone watcher');
  const targetStart = contents.notices.indexOf('- Reports go to the pane');
  const targetEnd = contents.notices.indexOf('\n- **Never let', targetStart);
  assert.ok(targetStart >= 0 && targetEnd > targetStart, 'delivery-target protocol drift');
  contents.notices = contents.notices.slice(0, targetStart) + '- Reports go to the stable supervisor agent name established by session-start.sh. Dispatch refuses before record start when that name is absent. No tab-label fallback is used.' + contents.notices.slice(targetEnd);
  contents.protocol += '\n## Scratch cutover protocol\narm-watch delivers only; launch-supervisor invokes open-session separately. Retain the original [org-report] notice on busy refusal, wait for the named session with herdr agent wait NAME --until idle --until done --until blocked, and retry the same settle.sh R-n or continue.sh request. An already recorded report ends the retry.\n';
  contents.notices += '\n## Standalone notices\n[watch-blocked] [watch-no-report] [watch-invalid-report] [watch-long-running] [watch-unavailable] preserve the worker. [org-report] requires run, outcome, headline, check and report; verdict is no longer read. Idle grace is 900 seconds after observed working. session-start establishes the stable supervisor name; missing targets refuse dispatch before record start. Janitor owns finished-tab cleanup and preserves blocked/needs_human workers.\n';
  contents.routes = replace(contents.routes, 'for (const script of [continueScript, watchScript])', 'for (const script of [continueScript])');
  contents.routes += `\ntest('cutover entries select split release modules',()=>{const i=buildSupervisorInvocation(REPO,['--route','executive','--','--open']);assert.equal(i.args[0],${JSON.stringify(path.join(candidate, 'supervisor/open-session.mjs'))});assert.match(readFileSync(resolve(REPO,'.lane/supervisor/arm-watch.sh'),'utf8'),/watch\\/watch.mjs/);assert.doesNotMatch(readFileSync(resolve(REPO,'scripts/lane/launch-supervisor.mjs'),'utf8'),/contrib\\/settle-watch/);});\n`;
  // Retain the original outside the caller tree until canary and rollback pass.
  contents.retire = '#!/bin/sh\necho "notify-watch retired; use arm-watch" >&2\nexit 1\n';
  return contents;
}
export function capture(copy) {
  return switches.map(([key, file]) => ({ key, file, bytes: fs.readFileSync(path.join(copy, file)), mode: fs.statSync(path.join(copy, file)).mode & 0o777 }));
}
export function restore(copy, originals) {
  for (const { file, bytes, mode } of originals) {
    fs.writeFileSync(path.join(copy, file), bytes); fs.chmodSync(path.join(copy, file), mode);
    assert.deepEqual(fs.readFileSync(path.join(copy, file)), bytes);
    assert.equal(fs.statSync(path.join(copy, file)).mode & 0o777, mode);
  }
}
export function callers(copy, needle) {
  const found = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`caller scan refuses symlink ${file}`);
      if (entry.isDirectory()) visit(file);
      else if (/\.(sh|mjs)$/.test(file) && entry.name !== 'notify-watch.sh') {
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (!/^\s*(#|\/\/|\*)/.test(line) && line.includes(needle)) found.push({ file, line: i + 1, text: line });
        });
      }
    }
  }
  for (const dir of ['scripts/lane', '.lane/supervisor']) visit(path.join(copy, dir));
  return found;
}
export function retireContrib(copy, compat) {
  const active = callers(copy, 'contrib/settle-watch.mjs');
  assert.equal(active.length, 0, `contrib retirement refused: ${JSON.stringify(active)}`);
  fs.unlinkSync(compat);
}
