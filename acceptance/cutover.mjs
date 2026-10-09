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
  ['notifyTests', '.lane/supervisor/se-test/run.sh'],
  ['events', '.lane/supervisor/supervisor-events.mjs'],
];
const q = (v) => "'" + v.replaceAll("'", "'\\''") + "'";
function replace(text, before, after, { acceptSwitched = true } = {}) {
  const drift = `cutover premise drift: ${before}`;
  if (text.includes(before)) text = text.replace(before, after);
  // An empty replacement cannot prove retirement, and a short shared label
  // may appear elsewhere without proving that its original clause was edited.
  else assert.ok(acceptSwitched && after && text.includes(after), drift);
  assert.ok(text.includes(after), drift);
  if (!after.includes(before)) assert.ok(!text.includes(before), drift);
  return text;
}
export function switchedFiles({ copy, candidate, workspace, target, legacyTarget, home }) {
  const contents = Object.fromEntries(switches.map(([key, file]) => [key, fs.readFileSync(path.join(copy, file), 'utf8')]));
  contents.launcher = replace(contents.launcher, JSON.stringify(path.join(candidate, 'contrib/settle-watch.mjs')), JSON.stringify(path.join(candidate, 'supervisor/open-session.mjs')));
  contents.continue = '# open-session refuses busy sessions; retain the request and retry after the named session stops.\n' + contents.continue;
  contents.arm = `#!/bin/sh\nset -eu\nRUN=\${1:?run required}; shift\n# Herdr watch/watch.mjs delivers through the project's record inbox and autopilot.\nexec sh ${q(path.join(candidate, 'supervisor/arm-watch.sh'))} "$RUN" --org ${q(path.join(path.dirname(copy), '.org'))} --cwd ${q(copy)} --to ${q(target)} --idle-grace 900 "$@" --detach --log ${q(path.join(copy, '.lane/supervisor/watch-logs'))}/"$RUN".log\n`;
  contents.dispatch = replace(contents.dispatch, `env -u HERDR_PANE_ID nohup .lane/supervisor/notify-watch.sh $RUN --to ${legacyTarget} > .lane/supervisor/watch-logs/$RUN.log 2>&1 < /dev/null &!`, 'env -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID .lane/supervisor/arm-watch.sh $RUN');
  // Keep the cap and kernel lock; count the detached standalone watcher after
  // the switch. Its --org/--cwd arguments now precede --to.
  contents.dispatch = replace(contents.dispatch,
    `sed -n 's/.*notify-watch\\.sh \\(R-[0-9]*\\) --to ${legacyTarget}.*/\\1/p'`,
    `sed -n 's/.*watch\\/watch\\.mjs \\(R-[0-9]*\\) .*--to ${target} .*/\\1/p'`);
  contents.dispatch = replace(contents.dispatch, 'org set $RUN agent=$AG pane=$PANE >/dev/null',
    `node ${q(path.join(candidate, 'dispatch/record-worker.mjs'))} "$RUN" --org ${q(path.join(path.dirname(copy), '.org'))} --agent "$AG" --pane "$PANE" --cwd "$WT" >/dev/null`);
  contents.dispatch = contents.dispatch.replaceAll(legacyTarget, target);
  contents.name = replace(contents.name, `${workspace}:*`, `${workspace}:*`);
  contents.name = replace(contents.name, `${legacyTarget} >/dev/null 2>&1 || true`, `${target} >/dev/null || { echo 'supervisor naming failed' >&2; exit 1; }`);
  // The scheduler belongs to its separate acceptance case. Never start a loop.
  contents.name = contents.name.split('\n').filter((line) => !line.includes('janitor.sh start')).join('\n').replace('janitor running', 'scratch scheduler excluded');
  const sweepStart = contents.tidy.indexOf('echo "== watcher tabs in $WS"');
  const oldLog = 'LOG=$REPO/.lane/supervisor/notify-log.tsv';
  const newLog = 'LOG=$REPO/.lane/supervisor/watch-logs';
  const sweepEnd = contents.tidy.indexOf(contents.tidy.includes(oldLog) ? oldLog : newLog);
  assert.ok(sweepStart >= 0 && sweepEnd > sweepStart, 'tidy sweep premise drift');
  // Branch absence, display labels and agentless tabs cannot authorize worker
  // deletion. Detached watches need no old watch-tab/workspace sweeper.
  contents.tidy = contents.tidy.slice(0, sweepStart) + '# Worker closures use only the recorded-outcome helper below.\n' + contents.tidy.slice(sweepEnd);
  contents.tidy = replace(contents.tidy, oldLog, newLog);
  contents.tidy = replace(contents.tidy, '[ -f "$LOG" ] && tail -n "$N" "$LOG" | cut -c1-220 || echo "(no log yet)"', `find "$LOG" -type f -name "R-*.log" -exec sh -c 'printf "\\n== %s\\n" "$1"; tail -n "$2" "$1"' sh {} "$N" \\; 2>/dev/null`);
  // bch-cloak may already have applied this safety fix. Whitespace just inside
  // command substitution is equivalent; other flags or conditions are drift.
  const dryRun = /\/close-finished-agents\.sh \$\([ \t]*\[ "\$DRY" = 1 \] && echo --dry-run[ \t]*\) \|/;
  const dryRunCall = contents.tidy.match(dryRun)?.[0]
    ?? '/close-finished-agents.sh $([ "$DRY" = 1 ] && echo --dry-run) |';
  contents.tidy = replace(contents.tidy, '/close-finished-agents.sh |', dryRunCall);
  assert.match(contents.tidy, dryRun, 'cutover premise drift: /close-finished-agents.sh |');
  assert.equal(contents.tidy.split('/close-finished-agents.sh').length - 1, 1,
    'cutover premise drift: /close-finished-agents.sh |');
  // Cleanup is now an eleventh required edit. A file on disk is not a
  // recorded outcome, and an unknown/agentless pane is not proof of completion.
  assert.ok((/open=\$\((org|node [^\n]+) status --json/.test(contents.cleanup)) && contents.cleanup.includes('# tabs with no live agent'), 'cleanup premise drift');
  contents.cleanup = `#!/bin/sh
# Shared cleanup rechecks launch identity, record, Git and every tab occupant.
set -eu
exec node ${q(path.join(candidate, 'supervisor/tidy-tabs.mjs'))} --cwd ${q(copy)} --org ${q(path.join(path.dirname(copy), '.org'))} "$@"
`;
  contents.protocol = contents.protocol.replace('a watcher that will open the next session', 'a watcher that delivers to the supervisor; fresh session launch is separate');
  contents.notices = replace(contents.notices, `**A finished worker closes itself.** When its watcher has queued the notification for an \`outcome: done\` report, it closes the
  worker's tab (the report file is the record; supervisor-events delivers the notification when the input box is empty). If the
  notification cannot be queued, the watcher exits 1 and closes nothing.
  A blocked or needs-human worker keeps its tab so the pane can be read.
- **No janitor (retired 2026-10-03).** Its 60-second tick polled herdr. Finished workers' tabs close when their report notification is queued
  (above). Run \`close-finished-agents.sh\` and \`tidy-tabs.sh\` by hand at each settle or shift end; they are one-shot.`,
  `**One-shot cleanup closes finished workers.** The watcher only delivers; close-finished-agents.sh closes identity-verified reported worker tabs.
  A blocked or needs-human worker keeps its tab so the pane can be read.
- **No janitor loop.** Run \`close-finished-agents.sh\` and \`tidy-tabs.sh\` by hand at each settle or shift end; they are one-shot.`);
  contents.notices = contents.notices.replace('starts each notify watcher', 'starts each standalone watcher');
  contents.notices = replace(contents.notices, `- Reports go to the agent named exactly **\`${legacyTarget}\`** (no fallback since 2026-10-03; the old ${workspace}/cwd fallback could hit
  another session). The SessionStart hook (\`session-start.sh\`) applies the name at session start; if it is missing, run
  \`herdr agent rename <supervisor pane> ${legacyTarget}\`. Undelivered messages wait in \`.lane/supervisor/outbox/\`.`,
  '- Reports go to the stable supervisor agent name established by session-start.sh. Dispatch refuses before record start when that name is absent. No tab-label fallback is used.');
  contents.protocol += '\n## Scratch cutover protocol\narm-watch delivers only; launch-supervisor invokes open-session separately. Retain the original [org-report] notice on busy refusal, wait for the named session with herdr agent wait NAME --until idle --until done --until blocked, and retry the same settle.sh R-n or continue.sh request. An already recorded report ends the retry.\n';
  const org = path.join(path.dirname(copy), '.org');
  const noticeMigration = `\n## Record inbox and autopilot\nNotices are journaled at ${path.join(org, 'supervisor/inbox.log')} with the canonical project identity and recipient ${target}. The notice-autopilot/v1 policy handles routine done reports before input delivery; exceptions reach that named supervisor through the input gate. Automatic actions require tooling=auto in this record's approvals and respect STOP, pause and .supervisor.json. Do not manually settle a handled notice again.\nAt the release-gated quiet switch, account for every pending legacy outbox message, retain the old plain-text inbox and outbox as evidence, and stop com.rewt.bch-cloak.supervisor-events before arming the new watcher. The new JSONL journal must never reuse the legacy inbox. No separate notice daemon is started. On rollback, drain the new journal and stop its owned senders before restoring and re-arming the legacy consumer; never run both delivery paths together.\n`;
  const housekeepingRoutine = `\n## Switched supervisor routine\nAfter the quiet switch, the project supervisor starts housekeeping from the canonical checkout:\n\ncd ${q(copy)}\nnode ${q(path.join(candidate, 'housekeeping/housekeeping.mjs'))} --start\n\nRepeated starts reuse the schedule. Workers never start it. dispatch.sh records launch identity immediately after launch, before arming watch. Missing legacy identities are preserved; never backfill them from the session registry. Manually inspect already-merged lanes once as described in Monitor docs/ADOPTING.md.\n`;
  contents.protocol += housekeepingRoutine;
  contents.notices += housekeepingRoutine;
  contents.protocol += noticeMigration;
  contents.notices += noticeMigration;
  contents.notices += '\n## Standalone notices\n[watch-blocked] [watch-no-report] [watch-invalid-report] [watch-long-running] [watch-unavailable] preserve the worker. [org-report] requires run, outcome, headline, check and report; verdict is no longer read. Idle grace is 900 seconds after observed working. session-start establishes the stable supervisor name; missing targets refuse dispatch before record start. One-shot cleanup owns finished-tab closure through close-finished-agents.sh, which requires a matching recorded launch identity and latest report and preserves blocked/needs_human, open, unknown and unrecorded workers.\n';
  contents.routes = replace(contents.routes, 'for (const script of [continueScript, watchScript])', 'for (const script of [continueScript])');
  contents.routes += `\ntest('cutover entries select split release modules',()=>{const i=buildSupervisorInvocation(REPO,['--route','executive','--','--open']);assert.equal(i.args[0],${JSON.stringify(path.join(candidate, 'supervisor/open-session.mjs'))});assert.ok(readFileSync(resolve(REPO,'.lane/supervisor/arm-watch.sh'),'utf8').includes(${JSON.stringify(path.join(candidate, 'supervisor/arm-watch.sh'))}));assert.doesNotMatch(readFileSync(resolve(REPO,'scripts/lane/launch-supervisor.mjs'),'utf8'),/contrib\\/settle-watch/);});\n`;
  // Retain the original outside the caller tree until canary and rollback pass.
  contents.retire = '#!/bin/sh\necho "notify-watch retired; use arm-watch" >&2\nexit 1\n';
  // se-test is mixed: retain supervisor-events and kernel-lock coverage, but
  // retire the NW_* outbox/verdict/grace assertions with their legacy entry.
  // They cannot test standalone watch's notice and argument contract.
  contents.notifyTests = replace(contents.notifyTests, '; NW=${NW_UNDER_TEST:-$SUPD/notify-watch.sh}', '');
  const notifyStart = contents.notifyTests.indexOf('# ---- notify-watch.sh ');
  const notifyEnd = contents.notifyTests.indexOf('# ---- the two kernel locks ');
  assert.ok(notifyStart >= 0 && notifyEnd > notifyStart, 'notify test retirement premise drift');
  contents.notifyTests = contents.notifyTests.slice(0, notifyStart)
    + '# Legacy notify tests retired with that entry; standalone watch has its own offline suite.\n'
    + contents.notifyTests.slice(notifyEnd);
  contents.notifyTests = replace(contents.notifyTests, 'supervisor-events.mjs and notify-watch.sh', 'supervisor-events.mjs', { acceptSwitched: false });
  contents.notifyTests = replace(contents.notifyTests, `notify target ${legacyTarget} not found`, `notify target ${target} not found`);
  contents.events = replace(contents.events, 'export function notify(msg) { // other scripts do the same with a file: see notify-watch.sh',
    'export function notify(msg) { // Queue event-service notices in its outbox.');
  return contents;
}
export function capture(copy) {
  return switches.map(([key, file]) => ({ key, file, bytes: fs.readFileSync(path.join(copy, file)), mode: fs.statSync(path.join(copy, file)).mode & 0o777 }));
}
// Shared by the release harness and offline checks of the rewritten documents.
export function assertNoticeContract(protocol, grammar) {
  for (const text of [protocol, grammar]) {
    assert.match(text, /notice-autopilot\/v1/);
    assert.match(text, /supervisor\/inbox\.log/);
    assert.match(text, /stop com\.rewt\.bch-cloak\.supervisor-events before arming/);
    assert.match(text, /never reuse the legacy inbox/);
    assert.match(text, /No separate notice daemon/);
  }
  assert.match(protocol, /retain.*original.*org-report/i);
  assert.match(protocol, /retry.*settle.sh/);
  for (const prefix of ['watch-blocked', 'watch-no-report', 'watch-invalid-report', 'watch-long-running', 'watch-unavailable']) assert.ok(grammar.includes(`[${prefix}]`));
  assert.match(grammar, /900/);
  assert.match(grammar, /One-shot cleanup owns finished-tab closure through close-finished-agents\.sh/);
  assert.match(grammar, /requires a matching recorded launch identity and latest report/);
  assert.match(grammar, /preserves blocked\/needs_human, open, unknown and unrecorded workers/);
}
export function restore(copy, originals) {
  for (const { file, bytes, mode } of originals) {
    fs.writeFileSync(path.join(copy, file), bytes); fs.chmodSync(path.join(copy, file), mode);
    assert.deepEqual(fs.readFileSync(path.join(copy, file)), bytes);
    assert.equal(fs.statSync(path.join(copy, file)).mode & 0o777, mode);
  }
}
const scriptFile = /\.(sh|bash|zsh|mjs|cjs|js|py)$/;
const scriptBackup = /\.(sh|bash|zsh|mjs|cjs|js|py)\.bak-\d{8}-[^/]+$/;
// The copier and retirement guard share the same recursively enumerated source
// set. Interpreters can invoke recognized script backups without an execute bit.
export function callerFiles(copy, { exclude = () => false } = {}) {
  const found = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (exclude(file)) continue;
      if (entry.isSymbolicLink()) throw new Error(`caller scan refuses symlink ${file}`);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && (scriptFile.test(file) || scriptBackup.test(file) || (fs.statSync(file).mode & 0o111))) found.push(file);
    }
  }
  for (const dir of ['scripts/lane', '.lane/supervisor']) visit(path.join(copy, dir));
  return found.sort();
}
// Timestamped old script backups are historical only when no active source
// references them. Retain their bytes outside the executable scratch caller tree.
export function callerInventory(copy, options) {
  const files = callerFiles(copy, options);
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
