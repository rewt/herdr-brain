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
  ['cleanup', '.lane/supervisor/close-finished-agents.sh'],
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
  const sweepStart = contents.tidy.indexOf('echo "== watcher tabs in $WS"');
  const sweepEnd = contents.tidy.indexOf('LOG=$REPO/.lane/supervisor/notify-log.tsv');
  assert.ok(sweepStart >= 0 && sweepEnd > sweepStart, 'tidy sweep premise drift');
  // Branch absence, display labels and agentless tabs cannot authorize worker
  // deletion. Detached watches need no old watch-tab/workspace sweeper.
  contents.tidy = contents.tidy.slice(0, sweepStart) + '# Worker closures use only the recorded-outcome helper below.\n' + contents.tidy.slice(sweepEnd);
  contents.tidy = replace(contents.tidy, 'LOG=$REPO/.lane/supervisor/notify-log.tsv', 'LOG=$REPO/.lane/supervisor/watch-logs');
  contents.tidy = replace(contents.tidy, '[ -f "$LOG" ] && tail -n "$N" "$LOG" | cut -c1-220 || echo "(no log yet)"', `find "$LOG" -type f -name "R-*.log" -exec sh -c 'printf "\\n== %s\\n" "$1"; tail -n "$2" "$1"' sh {} "$N" \\; 2>/dev/null`);
  contents.tidy = replace(contents.tidy, '/close-finished-agents.sh |', '/close-finished-agents.sh $([ \"$DRY\" = 1 ] && echo --dry-run) |');
  // Cleanup is now an eleventh required edit. A file on disk is not a
  // recorded outcome, and an unknown/agentless pane is not proof of completion.
  assert.ok((/open=\$\((org|node [^\n]+) status --json/.test(contents.cleanup)) && contents.cleanup.includes('# tabs with no live agent'), 'cleanup premise drift');
  const cleanupScope = contents.cleanup.match(/    if .*cwd or a.get\("workspace_id"\)==.*: continue/)?.[0];
  assert.ok(cleanupScope, 'cleanup workspace premise drift');
  contents.cleanup = `#!/bin/zsh
# Cutover cleanup: only a recorded done/abandoned latest run may close an idle
# worker. Preserve blocked, needs_human, open, unknown and unrecorded workers.
set -euo pipefail
DRY=\${1:-}
export ORG_DIR=\${ORG_DIR:-${path.join(path.dirname(copy), '.org')}}
eligible=$(org status --json | python3 -c '
import sys,json
latest={}
for r in json.load(sys.stdin)["runs"]:
    name=(r.get("meta") or {}).get("agent")
    if name and (name not in latest or r["started"]["seq"] > latest[name]["started"]["seq"]): latest[name]=r
for name,r in latest.items():
    report=r.get("report") or {}
    if report.get("outcome") == "done" or (not report and r.get("abandoned") is not None): print(name)')
herdr agent list | python3 -c '
import sys,json
eligible=set(sys.argv[1].split())
agents=json.load(sys.stdin)["result"]["agents"]
protected={a.get("tab_id") for a in agents if a.get("name") not in eligible or a.get("agent_status") not in ("done","idle")}
seen=set()
for a in agents:
    cwd=a.get("cwd","")
${cleanupScope}
    if a.get("agent_status") not in ("done","idle") or a.get("name") not in eligible: continue
    tab=a.get("tab_id")
    if tab and tab not in seen and tab not in protected:
        seen.add(tab); print(tab, a["name"], cwd.rsplit("/",1)[-1])
' "$eligible" | while read -r tab name lane; do
  if [ "$DRY" = --dry-run ]; then echo "would close $tab ($name, $lane)"; else
    herdr tab close "$tab" && echo "closed $tab ($name, $lane)"; fi
done
# No agentless sweep: unknown panes carry no authoritative completion evidence.
`;
  contents.protocol = contents.protocol.replace('a watcher that will open the next session', 'a watcher that delivers to the supervisor; fresh session launch is separate');
  contents.notices = replace(contents.notices, `**A finished worker closes itself.** When its watcher has queued the notification for an \`outcome: done\` report, it closes the
  worker's tab (the report file is the record; supervisor-events delivers the notification when the input box is empty). If the
  notification cannot be queued, the watcher exits 1 and closes nothing.
  A blocked or needs-human worker keeps its tab so the pane can be read.
- **No janitor (retired 2026-10-03).** Its 60-second tick polled herdr. Finished workers' tabs close when their report notification is queued
  (above). Run \`close-finished-agents.sh\` and \`tidy-tabs.sh\` by hand at each settle or shift end; they are one-shot.`,
  `**One-shot cleanup closes finished workers.** The watcher only delivers; close-finished-agents.sh closes recorded done or abandoned worker tabs.
  A blocked or needs-human worker keeps its tab so the pane can be read.
- **No janitor loop.** Run \`close-finished-agents.sh\` and \`tidy-tabs.sh\` by hand at each settle or shift end; they are one-shot.`);
  contents.notices = contents.notices.replace('starts each notify watcher', 'starts each standalone watcher');
  contents.notices = replace(contents.notices, `- Reports go to the agent named exactly **\`${legacyTarget}\`** (no fallback since 2026-10-03; the old ${workspace}/cwd fallback could hit
  another session). The SessionStart hook (\`session-start.sh\`) applies the name at session start; if it is missing, run
  \`herdr agent rename <supervisor pane> ${legacyTarget}\`. Undelivered messages wait in \`.lane/supervisor/outbox/\`.`,
  '- Reports go to the stable supervisor agent name established by session-start.sh. Dispatch refuses before record start when that name is absent. No tab-label fallback is used.');
  contents.protocol += '\n## Scratch cutover protocol\narm-watch delivers only; launch-supervisor invokes open-session separately. Retain the original [org-report] notice on busy refusal, wait for the named session with herdr agent wait NAME --until idle --until done --until blocked, and retry the same settle.sh R-n or continue.sh request. An already recorded report ends the retry.\n';
  contents.notices += '\n## Standalone notices\n[watch-blocked] [watch-no-report] [watch-invalid-report] [watch-long-running] [watch-unavailable] preserve the worker. [org-report] requires run, outcome, headline, check and report; verdict is no longer read. Idle grace is 900 seconds after observed working. session-start establishes the stable supervisor name; missing targets refuse dispatch before record start. One-shot cleanup owns finished-tab closure through close-finished-agents.sh, which requires a recorded done or abandoned latest run and preserves blocked/needs_human, open, unknown and unrecorded workers.\n';
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
const scriptBackup = /\.(sh|mjs|py)\.bak-\d{8}-[^/]+$/;
// The copier and retirement guard share the same recursively enumerated source
// set. Interpreters can invoke recognized script backups without an execute bit.
export function callerFiles(copy) {
  const found = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`caller scan refuses symlink ${file}`);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && (/\.(sh|mjs|py)$/.test(file) || scriptBackup.test(file) || (fs.statSync(file).mode & 0o111))) found.push(file);
    }
  }
  for (const dir of ['scripts/lane', '.lane/supervisor']) visit(path.join(copy, dir));
  return found.sort();
}
// Timestamped old script backups are historical only when no active source
// references them. Retain their bytes outside the executable scratch caller tree.
export function callerInventory(copy) {
  const files = callerFiles(copy);
  const backups = files.filter((file) => scriptBackup.test(file));
  const active = new Set(files.filter((file) => !backups.includes(file)));
  for (;;) {
    const referenced = backups.filter((backup) => !active.has(backup) && [...active].some((file) => fs.readFileSync(file, 'utf8').split('\n')
      .some((line) => !/^\s*(#|\/\/)/.test(line) && line.includes(path.basename(backup)))));
    if (!referenced.length) break;
    for (const file of referenced) active.add(file);
  }
  return { active: files.filter((file) => active.has(file)), historical: backups.filter((file) => !active.has(file)) };
}
export function callers(copy, needle) {
  const found = [];
  for (const file of callerFiles(copy)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      // Only comment-only historical lines are excluded. notify-watch is a
      // real caller until the switch rewrites it, so it has no file exemption.
      if (!/^\s*(#|\/\/)/.test(line) && line.includes(needle)) found.push({ file, line: i + 1, text: line });
    });
  }
  return found;
}
export function retireContrib(copy, compat) {
  const active = callers(copy, 'contrib/settle-watch.mjs');
  assert.equal(active.length, 0, `contrib retirement refused: ${JSON.stringify(active)}`);
  fs.unlinkSync(compat);
}
