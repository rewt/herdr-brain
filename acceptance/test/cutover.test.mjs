import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { auditCopies, copiedSandbox, relocate } from '../security.mjs';
import { waitUntil } from '../load.mjs';
import { fixture, inventory } from './cutover-fixture.mjs';
import { switches, capture, restore, callers, retireContrib, switchedFiles, callerFiles, callerInventory, assertNoticeContract } from '../cutover.mjs';

test('rollback restores every file byte and executable mode', (t) => {
  const root = fixture(t), original = capture(root);
  for (const [, file] of switches) { fs.writeFileSync(path.join(root, file), 'switched'); fs.chmodSync(path.join(root, file), 0o600); }
  restore(root, original);
  assert.deepEqual(capture(root), original);
});
test('contrib cannot retire with an extra executable caller, and scans refuse symlinks', (t) => {
  const root = fixture(t), compat = path.join(root, 'compat.mjs');
  fs.writeFileSync(compat, 'compatibility');
  const caller = path.join(root, '.lane/supervisor/extra.sh');
  fs.writeFileSync(caller, '# historical contrib/settle-watch.mjs\nnode "$CURRENT/contrib/settle-watch.mjs"\n');
  assert.equal(callers(root, 'contrib/settle-watch.mjs').length, 1);
  assert.throws(() => retireContrib(root, compat), /retirement refused/);
  assert.equal(fs.readFileSync(compat, 'utf8'), 'compatibility');
  fs.unlinkSync(caller); fs.symlinkSync(compat, caller);
  assert.throws(() => retireContrib(root, compat), /symlink/);
  fs.unlinkSync(caller); retireContrib(root, compat);
  assert.equal(fs.existsSync(compat), false);
});

test('all current edits apply to relocated inventory scripts and refuse premise drift', (t) => {
  const { copy, spec, edits } = inventory(t);
  assert.equal(Object.keys(edits).length, 13);
  assert.ok(edits.dispatch.includes('arm-watch.sh $RUN'));
  assert.ok(edits.arm.includes(path.join(spec.candidate, 'supervisor/arm-watch.sh')));
  assert.ok(edits.arm.includes(`--org '${path.join(path.dirname(copy), '.org')}'`));
  assert.ok(edits.arm.includes(`--to '${spec.target}'`));
  assert.ok(!edits.dispatch.includes('notify-watch.sh'));
  for (const [key, file] of switches) fs.writeFileSync(path.join(copy, file), edits[key]);
  assert.deepEqual(callers(copy, 'contrib/settle-watch.mjs'), []);
  assert.deepEqual(callers(copy, 'notify-watch.sh'), []);
  assert.throws(() => switchedFiles(spec), /premise drift/);
});

test('current background and exact disown cutover preserves all switches and rollback bytes', (t) => {
  const { copy, spec, edits } = inventory(t);
  const file = path.join(copy, '.lane/supervisor/dispatch.sh');
  const original = fs.readFileSync(file, 'utf8');
  const base = `env -u HERDR_PANE_ID nohup .lane/supervisor/notify-watch.sh $RUN --to ${spec.legacyTarget} > .lane/supervisor/watch-logs/$RUN.log 2>&1 < /dev/null &`;
  const current = base + '\n' + 'disown 2>/dev/null || true  # a fast-exiting watcher may already have left the job table';
  assert.equal(original.split(base + '!').length - 1, 1);
  fs.writeFileSync(file, original.replace(base + '!', current));
  const originals = capture(copy);
  assert.deepEqual(switchedFiles(spec), edits, 'both supported clauses produce the same complete cutover');
  for (const [key, rel] of switches) fs.writeFileSync(path.join(copy, rel), edits[key]);
  assert.deepEqual(callers(copy, 'contrib/settle-watch.mjs'), []);
  assert.deepEqual(callers(copy, 'notify-watch.sh'), []);
  restore(copy, originals);
  assert.deepEqual(capture(copy), originals, 'modern background/disown bytes and executable modes restore exactly');
});

test('watcher launch cutover refuses missing disown, unknown clauses and duplicate launches without writing files', (t) => {
  const { copy, spec, edits } = inventory(t);
  const file = path.join(copy, '.lane/supervisor/dispatch.sh');
  const original = fs.readFileSync(file, 'utf8');
  const base = `env -u HERDR_PANE_ID nohup .lane/supervisor/notify-watch.sh $RUN --to ${spec.legacyTarget} > .lane/supervisor/watch-logs/$RUN.log 2>&1 < /dev/null &`;
  const legacy = base + '!';
  const current = base + '\n' + 'disown 2>/dev/null || true  # a fast-exiting watcher may already have left the job table';
  const arm = 'env -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID .lane/supervisor/arm-watch.sh $RUN';
  for (const clause of [
    base,
    current.replace('|| true', '|| false'),
    current.replace('--to ' + spec.legacyTarget, '--to foreign-target'),
    current.replace('2>&1', '2>/dev/null'),
    legacy + '\n' + legacy,
    current + '\n' + current,
    legacy + '\n' + current,
    legacy + '\n' + arm,
    arm + '\n' + arm,
    legacy + '\n' + current.replace('--to ' + spec.legacyTarget, '--to foreign-target'),
  ]) {
    fs.writeFileSync(file, original.replace(legacy, clause));
    const before = capture(copy);
    assert.throws(() => switchedFiles(spec), /cutover premise drift: watcher launch clause/, clause);
    assert.deepEqual(capture(copy), before, 'refusal must not install a partial switch');
  }
  fs.writeFileSync(file, original);
  assert.deepEqual(switchedFiles(spec), edits, 'ordinary legacy control still passes');
});

test('tidy cutover accepts old and equivalent dry-run calls and refuses unrelated drift', (t) => {
  const { copy, spec, edits } = inventory(t);
  const file = path.join(copy, '.lane/supervisor/tidy-tabs.sh');
  const original = fs.readFileSync(file, 'utf8');
  const before = '/close-finished-agents.sh |';
  assert.ok(original.includes(before));
  for (const call of [
    before,
    '/close-finished-agents.sh $([ "$DRY" = 1 ] && echo --dry-run) |',
    '/close-finished-agents.sh $( [ "$DRY" = 1 ] && echo --dry-run ) |',
  ]) {
    fs.writeFileSync(file, original.replace(before, call));
    const tidy = switchedFiles(spec).tidy;
    assert.equal(tidy, call === before ? edits.tidy : edits.tidy.replace(
      '/close-finished-agents.sh $([ "$DRY" = 1 ] && echo --dry-run) |', call));
    assert.equal(tidy.split('/close-finished-agents.sh').length - 1, 1);
  }
  for (const call of [
    '/close-finished-agents.sh --force |',
    '/close-finished-agents.sh $( [ "$DRY" = 0 ] && echo --dry-run ) |',
    '/close-finished-agents.sh $( [ "$DRY" = 1 ] && echo --force ) |',
    '/different-cleanup.sh |',
  ]) {
    fs.writeFileSync(file, original.replace(before, call));
    assert.throws(() => switchedFiles(spec), /cutover premise drift: \/close-finished-agents.sh \|/);
  }
  fs.writeFileSync(file, original.replace(before,
    '/close-finished-agents.sh $( [ "$DRY" = 1 ] && echo --dry-run ) |')
    + '\n/close-finished-agents.sh --force | cat\n');
  assert.throws(() => switchedFiles(spec), /cutover premise drift: \/close-finished-agents.sh \|/);
});

test('ambiguous deletion and shared labels still require their original premises', (t) => {
  const { copy, spec } = inventory(t), originals = capture(copy);
  const file = path.join(copy, '.lane/supervisor/se-test/run.sh');
  const original = fs.readFileSync(file, 'utf8');
  for (const before of ['; NW=${NW_UNDER_TEST:-$SUPD/notify-watch.sh}',
    'supervisor-events.mjs and notify-watch.sh']) {
    fs.writeFileSync(file, original.replace(before, '# unrelated drift'));
    assert.throws(() => switchedFiles(spec), /cutover premise drift/);
    restore(copy, originals);
  }
  // The unchanged workspace clause remains an identity premise, rather than
  // an edit whose absence can be treated as successful migration.
  const name = path.join(copy, '.lane/supervisor/session-start.sh');
  fs.writeFileSync(name, fs.readFileSync(name, 'utf8').replace(`${spec.workspace}:*`, 'foreign-workspace:*'));
  assert.throws(() => switchedFiles(spec), /cutover premise drift/);
});

test('independently switched exact clauses preserve the same cutover end state', (t) => {
  const { copy, spec, edits } = inventory(t), originals = capture(copy);
  // Apply one complete line/block from the proposed output, leaving the rest
  // of each input legacy. This models individual edits by the adopting project.
  const lines = [
    ['launcher', 'contrib/settle-watch.mjs', 'supervisor/open-session.mjs'],
    ['dispatch', 'env -u HERDR_PANE_ID nohup', 'env -u HERDR_PANE_ID -u HERDR_TAB_ID'],
    ['dispatch', "sed -n 's/.*notify-watch", "sed -n 's/.*watch"],
    ['dispatch', 'org set $RUN agent=$AG', 'dispatch/record-worker.mjs'],
    ['name', `${spec.legacyTarget} >/dev/null`, `${spec.target} >/dev/null`],
    ['tidy', 'LOG=$REPO/.lane/supervisor/notify-log.tsv', 'LOG=$REPO/.lane/supervisor/watch-logs'],
    ['tidy', '[ -f "$LOG" ] && tail', 'find "$LOG" -type f'],
    ['routes', 'for (const script of [continueScript, watchScript])', 'for (const script of [continueScript])'],
    ['notifyTests', `notify target ${spec.legacyTarget} not found`, `notify target ${spec.target} not found`],
    ['events', 'export function notify(msg)', 'export function notify(msg)'],
  ];
  for (const [key, oldMarker, newMarker] of lines) {
    const { file, bytes } = originals.find(v => v.key === key);
    const oldLine = bytes.toString().split('\n').find(line => line.includes(oldMarker));
    const newLine = edits[key].split('\n').find(line => line.includes(newMarker));
    assert.ok(oldLine && newLine, key);
    fs.writeFileSync(path.join(copy, file), bytes.toString().replace(oldLine, newLine));
    assert.deepEqual(switchedFiles(spec), edits, `${key}: ${oldMarker}`);
    fs.writeFileSync(path.join(copy, file), bytes.toString().replace(oldLine, '# unrelated changed clause'));
    assert.throws(() => switchedFiles(spec), /premise drift/, `${key}: unrelated drift`);
    restore(copy, originals);
  }
  const notices = originals.find(v => v.key === 'notices');
  const block = (text, start, end) => {
    const from = text.indexOf(start), to = text.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return text.slice(from, to);
  };
  for (const [oldMarker, newMarker, end] of [
    ['**A finished worker closes itself', '**One-shot cleanup closes finished workers', '\n- **Result:'],
    ['- Reports go to the agent named exactly', '- Reports go to the stable supervisor agent name', '\n\n'],
  ]) {
    const before = block(notices.bytes.toString(), oldMarker, end);
    const after = block(edits.notices, newMarker, end);
    fs.writeFileSync(path.join(copy, notices.file), notices.bytes.toString().replace(before, after));
    assert.deepEqual(switchedFiles(spec), edits, oldMarker);
    restore(copy, originals);
  }
});

test('current live checkout accepts every cutover premise and restores its snapshot', {
  skip: !process.env.ACCEPTANCE_BCH_CLOAK && 'set ACCEPTANCE_BCH_CLOAK to check a read-only live checkout',
}, (t) => {
  const { root, copy, spec, edits, manifest } = inventory(t, { live: process.env.ACCEPTANCE_BCH_CLOAK });
  auditCopies(copy, { root, live: process.env.ACCEPTANCE_BCH_CLOAK, home: '/Users/rewt' });
  const originals = capture(copy);
  assert.equal(Object.keys(edits).length, switches.length);
  assertNoticeContract(edits.protocol, edits.notices);
  for (const [key, file] of switches) fs.writeFileSync(path.join(copy, file), edits[key]);
  assert.deepEqual(callers(copy, 'contrib/settle-watch.mjs'), []);
  assert.deepEqual(callers(copy, 'notify-watch.sh'), []);
  restore(copy, originals);
  assert.deepEqual(capture(copy), originals);
  t.diagnostic(JSON.stringify({ source: process.env.ACCEPTANCE_BCH_CLOAK, manifest }));
});

test('current snapshot covers every switch and active caller and relocates all fixed temp paths', (t) => {
  const { root, copy, spec } = inventory(t);
  const snapshot = path.join(import.meta.dirname, 'fixtures/bch-cloak-20261004');
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, 'manifest.json')));
  for (const { file, sha256 } of manifest.files) {
    const bytes = fs.readFileSync(path.join(snapshot, file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sha256, file);
  }
  for (const [, file] of switches) assert.ok(manifest.files.some(v => v.file === file), file);
  assert.deepEqual(callerInventory(copy).active.map(file => path.relative(copy, file)),
    manifest.files.map(v => v.file).filter(file => !file.endsWith('.md') && !file.endsWith('.json')));
  const settings = { root, live: manifest.source, home: '/Users/rewt' };
  auditCopies(copy, settings);
  // These defaults previously escaped relocation; derived scratch paths stay
  // relative to the test's own temp directory.
  for (const rel of ['dispatch.sh', 'promote.sh', 'notify-watch.sh', 'supervisor-events.mjs', 'se-test/run.sh']) {
    const text = fs.readFileSync(path.join(copy, '.lane/supervisor', rel), 'utf8');
    assert.ok(text.includes(root), rel);
    assert.doesNotMatch(text.replaceAll(root, ''), /(?<![\w$}])\/(?:private\/)?tmp\b/, rel);
  }
  assert.match(fs.readFileSync(path.join(copy, '.lane/supervisor/se-test/run.sh'), 'utf8'), /SE_SLOT_LOCK=\$T\/tmp\/slot.lock/);
  const probe = path.join(copy, 'unrelocated.sh');
  for (const prefix of ['/private/tmp', '/tmp']) {
    fs.writeFileSync(probe, `LOCK=${prefix}/unrecognized-new-lock\n`);
    assert.throws(() => auditCopies(copy, settings), /unrelocated host temp path/);
  }
  fs.unlinkSync(probe);
  // Single-pass mapping must also work when scratch lives under /private/tmp.
  assert.equal(relocate('L=/private/tmp/bch-cloak-dispatch.flock; T=$T/tmp/slot.lock', {
    ...settings, root: '/private/tmp/scratch', copy: '/private/tmp/scratch/copy',
    candidate: spec.candidate, scratchHome: spec.home,
  }), 'L=/private/tmp/scratch/bch-cloak-dispatch.flock; T=$T/tmp/slot.lock');
  const homeRoot = '/Users/rewt/.herdr-monitor/scratch';
  assert.equal(relocate('resolve(homedir(), ".local/share/herdr-monitor/current/contrib/settle-watch.mjs"); L=/tmp/lock', {
    ...settings, root: homeRoot, candidate: `${homeRoot}/candidate`,
    copy: `${homeRoot}/copy`, scratchHome: `${homeRoot}/home`, launcher: true,
  }), `"${homeRoot}/candidate/contrib/settle-watch.mjs"; L=${homeRoot}/lock`);
});

test('mixed se-test retires only legacy notify assertions and strict audit still rejects a new caller', (t) => {
  const { copy, spec, edits } = inventory(t), originals = capture(copy);
  const notify = callers(copy, 'notify-watch.sh');
  assert.ok(notify.some(v => v.file.endsWith('/se-test/run.sh') && v.line === 6));
  assert.ok(notify.some(v => v.file.endsWith('/supervisor-events.mjs') && v.line === 137));
  assert.match(edits.notifyTests, /T1 idle/);
  assert.match(edits.notifyTests, /T15c a grandchild/);
  assert.match(edits.notifyTests, /L1 dispatch.sh refuses/);
  assert.match(edits.notifyTests, /L2 promote.sh refuses/);
  assert.match(edits.notifyTests, /notify target new-target not found/);
  assert.doesNotMatch(edits.notifyTests, /NW_UNDER_TEST|nwrun\(|NW1 valid report|notify-watch\.sh/);
  const testFile = path.join(copy, '.lane/supervisor/se-test/run.sh');
  const before = fs.readFileSync(testFile, 'utf8');
  fs.writeFileSync(testFile, before.replace('# ---- the two kernel locks ', '# ---- changed boundary '));
  assert.throws(() => switchedFiles(spec), /notify test retirement premise drift/);
  fs.writeFileSync(testFile, before);
  for (const [key, file] of switches) fs.writeFileSync(path.join(copy, file), edits[key]);
  assert.deepEqual(callers(copy, 'notify-watch.sh'), []);
  fs.appendFileSync(testFile, '\nsh "$SUPD/notify-watch.sh" R-999\n');
  assert.equal(callers(copy, 'notify-watch.sh').length, 1);
  restore(copy, originals);
  assert.deepEqual(capture(copy), originals);
  assert.deepEqual(callers(copy, 'notify-watch.sh'), notify);
});

test('current legacy notify queues its report in scratch and needs an event-service delivery consumer', (t) => {
  const { root, copy, spec } = inventory(t), bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const report = path.join(root, 'legacy-report.md');
  fs.writeFileSync(report, '---\noutcome: done\nverdict: PASS\n---\nOffline report.\n');
  fs.writeFileSync(path.join(bin, 'org'), `#!/bin/sh
case "$1" in
  show) echo '{"run":{"item":"ENG-offline","meta":{"agent":"offline"},"report_path":"${report}"}}' ;;
  check) echo 'ok: checked' ;;
  *) exit 91 ;;
esac
`, { mode: 0o755 });
  const calls = path.join(root, 'herdr-calls');
  fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$1 $2" in
  'agent wait') exit 0 ;;
  'agent get') echo '{"result":{"agent":{"agent_status":"idle"}}}' ;;
  *) exit 92 ;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH };
  delete env.HERDR_PANE_ID; delete env.NW_OUTBOX; delete env.NW_WAITERS;
  const result = spawnSync('/bin/bash', [path.join(copy, '.lane/supervisor/notify-watch.sh'), 'R-1', '--to', spec.legacyTarget], { cwd: copy, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const outbox = path.join(copy, '.lane/supervisor/outbox');
  const messages = fs.readdirSync(outbox); assert.equal(messages.length, 1);
  assert.match(fs.readFileSync(path.join(outbox, messages[0]), 'utf8'), /\[org-report\] run=R-1 item=ENG-offline outcome=done verdict=PASS/);
  assert.match(result.stdout, /queued for legacy-target/);
  assert.doesNotMatch(fs.readFileSync(calls, 'utf8'), /agent prompt|tab close/);
});

test('relocated dispatch keeps the lock and session cap in baseline and switched copies', async (t) => {
  const { root, copy, spec, edits } = inventory(t), bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'herdr'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const started = path.join(root, 'org-called');
  fs.writeFileSync(path.join(bin, 'org'), `#!/bin/sh\ntouch '${started}'\nexit 91\n`, { mode: 0o755 });
  const psOutput = path.join(root, 'ps-output'); fs.writeFileSync(psOutput, '');
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\ncat '${psOutput}'\n`, { mode: 0o755 });
  const policy = path.join(root, 'copied.sb');
  fs.writeFileSync(policy, copiedSandbox(root, []));
  const script = path.join(copy, '.lane/supervisor/dispatch.sh');
  const original = fs.readFileSync(script, 'utf8');
  const brief = path.join(root, 'brief.md'); fs.writeFileSync(brief, 'offline brief');
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, MAX_SESSIONS: '1', FORCE_DISPATCH: '0' };
  const invoke = () => {
    auditCopies(copy, { root, live: '/Users/rewt/development/bastian/bch-cloak', home: '/Users/rewt' });
    const args = ['/bin/zsh', '-f', script, 'ENG-offline', 'fixture', 'engineer', 'codex', 'scripted', 'low', brief, path.join(root, 'report.md')];
    return process.platform === 'darwin'
      ? spawnSync('/usr/bin/sandbox-exec', ['-f', policy, ...args], { cwd: copy, env, encoding: 'utf8' })
      : spawnSync(args[0], args.slice(1), { cwd: copy, env, encoding: 'utf8' });
  };
  const lock = path.join(root, 'bch-cloak-dispatch.flock');
  fs.writeFileSync(lock, '');
  const ready = path.join(root, 'holder-ready');
  const holder = spawn('/bin/zsh', ['-f', '-c', 'zmodload zsh/system; zsystem flock -f fd "$1" || exit 9; touch "$2"; read -r release', 'holder', lock, ready], { stdio: ['pipe', 'ignore', 'pipe'] });
  const exited = once(holder, 'close');
  try {
    await waitUntil(() => fs.existsSync(ready), 'scratch flock holder', 5000);
    for (const contents of [original, edits.dispatch]) {
      fs.writeFileSync(script, contents);
      const held = invoke(); assert.equal(held.status, 3, held.stderr);
      assert.match(held.stdout, /another dispatch is starting.*no org run started/);
      assert.ok(!fs.existsSync(started));
    }
  } finally {
    holder.stdin.end('release\n'); holder.kill(); await exited;
  }
  for (const [contents, command, target] of [
    [original, `.lane/supervisor/notify-watch.sh R-7 --to ${spec.legacyTarget}`, spec.legacyTarget],
    [edits.dispatch, `node ${spec.candidate}/watch/watch.mjs R-7 --org scratch --cwd ${copy} --to ${spec.target} --idle-grace 900`, spec.target],
  ]) {
    fs.writeFileSync(script, contents);
    fs.writeFileSync(psOutput, command + '\n');
    const capped = invoke(); assert.equal(capped.status, 3, capped.stderr);
    assert.match(capped.stdout, /session cap: 1 runs in flight.*no org run started/);
    fs.writeFileSync(psOutput, command.replace(target, 'foreign-target') + '\n');
    const missing = invoke(); assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stdout, /notify target .*not found.*no org run started/);
    assert.ok(!fs.existsSync(started));
    assert.ok(fs.existsSync(lock));
  }
});

test('cutover rewrites queued-notification cleanup ownership and refuses changed notice premises', (t) => {
  const { copy, spec, edits } = inventory(t);
  const file = path.join(copy, '.lane/supervisor/WORK-PATTERN.md');
  const original = fs.readFileSync(file, 'utf8');
  assert.match(original, /When its watcher has queued the notification/);
  assert.match(edits.notices, /One-shot cleanup closes finished workers/);
  assert.match(edits.notices, /identity-verified reported worker tabs/);
  assert.match(edits.notices, /blocked or needs-human worker keeps its tab/);
  assert.match(original, /Reports go to the agent named exactly/);
  assert.match(edits.notices, /stable supervisor agent name established by session-start.sh/);
  assert.match(edits.notices, /No tab-label fallback is used/);
  assert.doesNotMatch(edits.notices, /worker closes itself|notification cannot be queued|tabs close when their report notification is queued/);
  for (const [before, after] of [
    ['has queued the notification for', 'delivers'],
    ['notification when the input box is empty', 'notification immediately'],
    ['No janitor (retired 2026-10-03)', 'No janitor (retired later)'],
    ['Reports go to the agent named exactly', 'Reports go to the pane'],
    ['Undelivered messages wait', 'Undelivered messages disappear'],
  ]) {
    fs.writeFileSync(file, original.replace(before, after));
    assert.throws(() => switchedFiles(spec), /cutover premise drift/);
  }
});

test('production notice contract accepts rewritten current documents and rejects missing obligations', (t) => {
  const { copy, edits } = inventory(t);
  for (const [key, file] of switches) fs.writeFileSync(path.join(copy, file), edits[key]);
  const protocol = fs.readFileSync(path.join(copy, '.lane/supervisor/SETTLE.md'), 'utf8');
  const grammar = fs.readFileSync(path.join(copy, '.lane/supervisor/WORK-PATTERN.md'), 'utf8');
  assert.doesNotMatch(grammar, /Janitor/);
  assertNoticeContract(protocol, grammar);
  for (const clause of [
    'notice-autopilot/v1', 'supervisor/inbox.log',
    'stop com.rewt.bch-cloak.supervisor-events before arming',
    'never reuse the legacy inbox', 'No separate notice daemon',
    'One-shot cleanup owns finished-tab closure through close-finished-agents.sh',
    'requires a matching recorded launch identity and latest report',
    'preserves blocked/needs_human, open, unknown and unrecorded workers',
    '900',
    '[watch-blocked]', '[watch-no-report]', '[watch-invalid-report]', '[watch-long-running]', '[watch-unavailable]',
  ]) {
    assert.ok(grammar.includes(clause));
    assert.throws(() => assertNoticeContract(protocol, grammar.replaceAll(clause, 'Janitor')), { code: 'ERR_ASSERTION' }, clause);
  }
  for (const clause of ['Retain the original [org-report]', 'retry the same settle.sh']) {
    assert.ok(protocol.includes(clause));
    assert.throws(() => assertNoticeContract(protocol.replaceAll(clause, ''), grammar), { code: 'ERR_ASSERTION' }, clause);
  }
});

test('retirement scans nested Python, executable extensionless and notify entry callers', (t) => {
  const root = fixture(t), compat = path.join(root, 'compat.mjs');
  fs.writeFileSync(compat, 'compatibility');
  for (const rel of ['.lane/supervisor/nested/caller.py', 'scripts/lane/deeper/caller', '.lane/supervisor/notify-watch.sh']) {
    const file=path.join(root,rel); fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file, '# historical contrib/settle-watch.mjs\nnode "$CURRENT/contrib/settle-watch.mjs"\n', {mode:0o755});
    assert.ok(callerFiles(root).includes(file));
    assert.ok(callers(root,'contrib/settle-watch.mjs').some(v=>v.file===file));
    assert.throws(()=>retireContrib(root,compat),/retirement refused/);
    assert.equal(fs.readFileSync(compat,'utf8'),'compatibility'); fs.unlinkSync(file);
  }
  retireContrib(root,compat); assert.equal(fs.existsSync(compat),false);
});

test('installed tidy recovers a bounded tail from each log including a late older run', (t) => {
  const {root,copy,edits}=inventory(t),bin=path.join(root,'bin');fs.mkdirSync(bin);
  for(const name of ['org','herdr'])fs.writeFileSync(path.join(bin,name),`#!/bin/sh\necho '{"runs": [], "result": {"tabs": [], "workspaces": [], "agents": []}}'\n`,{mode:0o755});
  const logs=path.join(copy,'.lane/supervisor/watch-logs');fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs,'R-1.log'),'old\nlate-from-old-run\n');
  fs.writeFileSync(path.join(logs,'R-2.log'),('old-newer-log\n').repeat(100));
  fs.mkdirSync(path.join(root,'existing/.org'),{recursive:true});fs.writeFileSync(path.join(root,'existing/.org/events.jsonl'),'');
  fs.writeFileSync(path.join(copy,'.lane/supervisor/tidy-tabs.sh'),edits.tidy);
  fs.writeFileSync(path.join(copy,'.lane/supervisor/close-finished-agents.sh'),edits.cleanup);fs.chmodSync(path.join(copy,'.lane/supervisor/close-finished-agents.sh'),0o755);
  fs.mkdirSync(path.join(root, 'candidate/supervisor'), {recursive:true});
  fs.writeFileSync(path.join(root, 'candidate/supervisor/tidy-tabs.mjs'), 'console.log("no finished tabs");\n');
  const result=spawnSync('/bin/zsh',['-f',path.join(copy,'.lane/supervisor/tidy-tabs.sh'),'--dry-run','--log-lines','2'],{env:{...process.env,PATH:bin+':'+process.env.PATH},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/late-from-old-run/);
  assert.equal(result.stdout.split('old-newer-log').length-1,2);
});

test('only unreferenced timestamped script backups qualify as historical material', (t) => {
  const root=fixture(t), backup=path.join(root,'.lane/supervisor/old.sh.bak-20261001-copy');
  fs.writeFileSync(backup,'node "$CURRENT/contrib/settle-watch.mjs"\n',{mode:0o755});
  assert.ok(callerInventory(root).historical.includes(backup));
  const active=path.join(root,'scripts/lane/caller.py');
  fs.writeFileSync(active,`import subprocess\nsubprocess.run(['sh', '${backup}'])\n`);
  assert.ok(callerInventory(root).active.includes(backup));
  assert.ok(!callerInventory(root).historical.includes(backup));
  const nested=path.join(root,'.lane/supervisor/nested.py.bak-20261001-copy');
  fs.writeFileSync(nested,'node contrib/settle-watch.mjs\n',{mode:0o755});
  fs.appendFileSync(backup,`python3 ${nested}\n`);
  assert.ok(callerInventory(root).active.includes(nested));
  // Retirement itself has no backup or notify-file exemption.
  const compat=path.join(root,'compat.mjs');fs.writeFileSync(compat,'blob');
  assert.throws(()=>retireContrib(root,compat),/retirement refused/);
});

test('executable shell case arms cannot hide contrib callers or references to historical backups', (t) => {
  const root = fixture(t), compat = path.join(root, 'compat.mjs');
  fs.writeFileSync(compat, 'compatibility blob');
  const script = path.join(root, '.lane/supervisor/case-caller.sh');
  fs.writeFileSync(script, '#!/bin/sh\ncase "$1" in\n  *) node "$CURRENT/contrib/settle-watch.mjs" --open ;;\nesac\n', { mode: 0o755 });
  const active = callers(root, 'contrib/settle-watch.mjs');
  assert.ok(active.some((v) => v.file === script && v.line === 3));
  assert.throws(() => retireContrib(root, compat), /retirement refused/);
  assert.equal(fs.readFileSync(compat, 'utf8'), 'compatibility blob');
  const backup = path.join(root, '.lane/supervisor/old.py.bak-20261002-copy');
  fs.writeFileSync(backup, 'subprocess.run(["node", "contrib/settle-watch.mjs"])\n', { mode: 0o755 });
  fs.writeFileSync(script, `#!/bin/sh\ncase "$1" in\n  *) python3 ${backup} ;;\nesac\n`);
  assert.ok(callerInventory(root).active.includes(backup));
  assert.ok(!callerInventory(root).historical.includes(backup));
  assert.throws(() => retireContrib(root, compat), /retirement refused/);
});

test('referenced mode-0644 script backups are enumerated, retained transitively and prevent retirement', (t) => {
  const root = fixture(t), compat = path.join(root, 'compat.mjs');
  fs.writeFileSync(compat, 'compatibility blob');
  const backup = path.join(root, '.lane/supervisor/old.py.bak-20261002-copy');
  const nested = path.join(root, '.lane/supervisor/nested.mjs.bak-20261002-copy');
  const unused = path.join(root, '.lane/supervisor/unused.sh.bak-20261002-copy');
  fs.writeFileSync(backup, `import subprocess\nsubprocess.run(['node', '${nested}'])\n`);
  fs.writeFileSync(nested, 'invoke("contrib/settle-watch.mjs");\n');
  fs.writeFileSync(unused, 'node contrib/settle-watch.mjs\n');
  for (const file of [backup, nested, unused]) fs.chmodSync(file, 0o644);
  fs.writeFileSync(path.join(root, 'scripts/lane/active.sh'), `#!/bin/sh\npython3 '${backup}'\n`);
  for (const file of [backup, nested, unused]) assert.ok(callerFiles(root).includes(file));
  const inventory = callerInventory(root);
  for (const file of [backup, nested]) {
    assert.ok(inventory.active.includes(file)); assert.ok(!inventory.historical.includes(file));
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  }
  assert.deepEqual(inventory.historical, [unused]);
  assert.ok(callers(root, 'contrib/settle-watch.mjs').some(v => v.file === nested));
  assert.throws(() => retireContrib(root, compat), /retirement refused/);
  assert.equal(fs.readFileSync(compat, 'utf8'), 'compatibility blob');
  // The shared inventory used by the copier must retain the readable Python
  // backup's own compatibility call too, not only the transitive variant.
  fs.writeFileSync(backup, 'invoke("contrib/settle-watch.mjs");\n');
  assert.ok(callers(root, 'contrib/settle-watch.mjs').some(v => v.file === backup));
  assert.throws(() => retireContrib(root, compat), /retirement refused/);
});
