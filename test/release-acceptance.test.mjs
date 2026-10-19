import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyProduct } from '../lib/product-files.mjs';
import { checkBundle } from '../lib/releases.mjs';
import { releaseEnvironment } from './helpers/release-environment.mjs';
import { writeSummary } from '../acceptance/results.mjs';
import { receiptDirectory } from '../supervisor/context.mjs';

const source = path.resolve(import.meta.dirname, '..');
const summaries = fs.readdirSync(path.join(import.meta.dirname, 'fixtures/release-acceptance')).sort()
  .map(file => fs.readFileSync(path.join(import.meta.dirname, 'fixtures/release-acceptance', file)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pin-acceptance-')));
  const home = path.join(root, 'monitor'), repo = path.join(root, 'project');
  fs.mkdirSync(repo);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = releaseEnvironment(process.env, { HOME: root, HERDR_MONITOR_HOME: home,
    HERDR_MONITOR_FLEET: path.join(root, 'fleet'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key)) delete env[key];
  const run = (exe, args, cwd = repo) => spawnSync(exe, args, { cwd, env, encoding: 'utf8', timeout: 15000 });
  const ok = result => { assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout.trim(); };
  const git = (...args) => ok(run('git', args));
  git('init', '-qb', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('commit', '--allow-empty', '-qm', 'initial');
  const tool = (...args) => run(process.execPath, [path.join(source, 'herdr/releases.mjs'), ...args]);
  const shell = (...args) => run('bash', [path.join(source, 'herdr/release.sh'), ...args]);
  const summaryFile = (summary = summaries[0], name = 'summary.json') => {
    const file = path.join(root, name); fs.writeFileSync(file, Buffer.isBuffer(summary) ? summary : JSON.stringify(summary)); return file;
  };
  const bundle = (id, { live = false, legacy = false, summary = summaries[0] } = {}) => {
    const directory = path.join(home, 'releases', id); copyProduct(source, directory);
    fs.writeFileSync(path.join(directory, '.release-commit'), JSON.parse(summary).candidateCommit + '\n');
    ok(tool('manifest', directory, ...(live ? [summaryFile(summary)] : [])));
    if (legacy) {
      const file = path.join(directory, '.release-manifest.json'), manifest = JSON.parse(fs.readFileSync(file));
      delete manifest.acceptance; fs.writeFileSync(file, JSON.stringify(manifest));
    }
    return directory;
  };
  const accept = id => { fs.writeFileSync(path.join(repo, '.herdr-release.json'), JSON.stringify({ release: id })); git('add', '.'); git('commit', '-qm', 'accept selection'); };
  const status = cwd => JSON.parse(ok(run('bash', [path.join(source, 'herdr/release.sh'), 'pin-status', '--json', cwd ?? repo])));
  return { root, home, repo, env, run, ok, git, tool, shell, summaryFile, bundle, accept, status };
}

test('the acceptance summary handoff preserves the exact evidence bytes without a live harness', t => {
  const f = fixture(t), evidence = path.join(f.root, 'evidence'), output = path.join(f.root, 'build-summary.json');
  fs.mkdirSync(evidence);
  const summary = { ...JSON.parse(summaries[0]), evidence };
  writeSummary(summary, output);
  assert.deepEqual(fs.readFileSync(output), fs.readFileSync(path.join(evidence, 'summary.json')));
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), summary);
});

test('pin refuses offline, missing and mismatched acceptance and accepts both real READY summaries', t => {
  const f = fixture(t), offline = f.bundle('offline');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(offline, '.release-manifest.json'))).acceptance, { ran: false, ready: false });
  const refused = f.shell('pin', 'offline', f.repo);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /acceptance-not-ready/);
  assert.equal(fs.existsSync(path.join(f.repo, '.herdr-release.json')), false);
  f.bundle('legacy', { legacy: true });
  assert.match(f.shell('pin', 'legacy', f.repo).stderr, /acceptance-missing/);
  for (const [index, summary] of summaries.entries()) {
    const id = `ready-${index}`, directory = f.bundle(id, { live: true, summary });
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, '.release-manifest.json')));
    assert.deepEqual(manifest.acceptance, { ran: true, ready: true, counts: JSON.parse(summary).counts,
      candidateCommit: JSON.parse(summary).candidateCommit, elapsedSeconds: JSON.parse(summary).elapsedSeconds, summarySha256: digest(summary) });
    assert.deepEqual(fs.readFileSync(path.join(directory, '.release-acceptance.json')), summary);
    assert.equal(checkBundle(directory, { verifyFiles: true }).commit, manifest.commit, 'protocol-1 headers accept the additive field');
    f.ok(f.shell('pin', id, f.repo));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.repo, '.herdr-release.json'))), { release: id });
    manifest.acceptance.candidateCommit = '0'.repeat(40);
    fs.writeFileSync(path.join(directory, '.release-manifest.json'), JSON.stringify(manifest));
    assert.match(f.shell('pin', id, f.repo).stderr, /acceptance-commit-mismatch/);
  }
});

test('legacy attest validates readiness and commit, stays outside the bundle and is write-once', t => {
  const f = fixture(t), directory = f.bundle('legacy', { legacy: true });
  const before = fs.readFileSync(path.join(directory, '.release-manifest.json'));
  const notReady = { ...JSON.parse(summaries[0]), ready: false };
  assert.match(f.shell('attest', 'legacy', f.summaryFile(notReady)).stderr, /acceptance-not-ready/);
  assert.match(f.shell('attest', 'legacy', f.summaryFile(summaries[1])).stderr, /acceptance-commit-mismatch/);
  assert.equal(fs.existsSync(path.join(f.home, 'acceptance/legacy.json')), false);
  f.ok(f.shell('attest', 'legacy', f.summaryFile()));
  const attestation = fs.readFileSync(path.join(f.home, 'acceptance/legacy.json'));
  assert.equal(JSON.parse(attestation).acceptance.summarySha256, digest(summaries[0]));
  assert.notEqual(f.shell('attest', 'legacy', f.summaryFile()).status, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'acceptance/legacy.json')), attestation);
  assert.deepEqual(fs.readFileSync(path.join(directory, '.release-manifest.json')), before);
  f.ok(f.shell('pin', 'legacy', f.repo)); f.accept('legacy');
  assert.equal(f.status().resolved.acceptance.source, 'attestation');
  f.bundle('offline'); assert.match(f.shell('attest', 'offline', f.summaryFile()).stderr, /acceptance-not-legacy/);
});

test('pin-status reads canonical HEAD, labels a prepared change, and uses the admission resolver', t => {
  const f = fixture(t), blue = f.bundle('blue', { live: true }), green = f.bundle('green', { live: true, summary: summaries[1] });
  fs.symlinkSync(green, path.join(f.home, 'current'));
  f.ok(f.shell('pin', 'blue', f.repo));
  let status = f.status();
  assert.equal(status.committed.release, null); assert.equal(status.committed.commit, f.git('rev-parse', 'HEAD'));
  assert.equal(status.prepared.label, 'prepared, not accepted'); assert.equal(status.resolved.root, green);
  f.accept('blue'); status = f.status();
  assert.equal(status.prepared, null); assert.equal(status.resolved.root, blue); assert.equal(status.current, green);
  assert.equal(status.resolved.manifestCommit, JSON.parse(summaries[0]).candidateCommit);
  assert.equal(status.resolved.acceptance.summarySha256, digest(summaries[0]));
  f.ok(f.shell('pin', 'green', f.repo));
  const lane = path.join(f.root, 'lane'); f.git('worktree', 'add', '-qb', 'lane/fixture', lane);
  status = f.status(lane);
  assert.equal(status.committed.release, 'blue'); assert.equal(status.prepared.config.release, 'green'); assert.equal(status.resolved.root, blue);
  assert.match(f.ok(f.shell('pin-status', f.repo)), /prepared, not accepted/);
  f.ok(f.shell('unpin', f.repo)); assert.equal(f.status().resolved.root, blue);
  f.git('add', '.'); f.git('commit', '-qm', 'accept unpin');
  assert.equal(f.status().resolved.root, green);
});

test('pin-status reports a deleted working-tree pin and the refused admission from canonical HEAD', t => {
  const f = fixture(t); f.bundle('blue', { live: true });
  const green = f.bundle('green', { live: true }); fs.symlinkSync(green, path.join(f.home, 'current'));
  f.accept('blue');
  const file = path.join(f.repo, '.herdr-release.json'), bytes = fs.readFileSync(file, 'utf8'), head = f.git('rev-parse', 'HEAD');
  const lane = path.join(f.root, 'lane'); f.git('worktree', 'add', '-qb', 'lane/fixture', lane);
  fs.unlinkSync(file);
  for (const cwd of [f.repo, lane]) {
    const status = f.status(cwd);
    assert.equal(status.committed.commit, head); assert.equal(status.committed.release, 'blue');
    assert.equal(status.committed.bytes, bytes);
    assert.deepEqual(status.prepared, { label: 'prepared, not accepted', present: false, bytes: null });
    assert.match(status.admissionError, /committed but missing from the canonical working tree/);
    assert.equal(status.resolved, null, 'a failed pin read must never fall back to current'); assert.equal(status.current, green);
  }
  f.git('add', '-u'); assert.equal(f.status().committed.commit, head, 'staged deletion still reads committed HEAD');
  const output = f.ok(f.shell('pin-status', f.repo));
  assert.ok(output.includes(`committed pin bytes: ${JSON.stringify(bytes)}`));
  assert.match(output, /prepared, not accepted/); assert.match(output, /admission refused:/);
  assert.match(f.tool('exec', f.home, 'bin/org.mjs', 'help').stderr, /committed but missing/);
});

for (const [kind, bytes, reason] of [
  ['malformed JSON', '{"release":\n', /JSON/],
  ['invalid schema', '{"release":"blue","extra":true}\n', /invalid .herdr-release.json/],
]) test(`pin-status retains committed bytes and prepared state for ${kind}`, t => {
  const f = fixture(t), green = f.bundle('green', { live: true }); fs.symlinkSync(green, path.join(f.home, 'current'));
  const file = path.join(f.repo, '.herdr-release.json'); fs.writeFileSync(file, bytes);
  f.git('add', '.'); f.git('commit', '-qm', 'invalid pin fixture');
  const head = f.git('rev-parse', 'HEAD');
  let status = f.status();
  assert.equal(status.committed.commit, head); assert.equal(status.committed.bytes, bytes);
  assert.equal(status.prepared.label, 'prepared, not accepted'); assert.equal(status.prepared.bytes, bytes);
  assert.match(status.admissionError, reason); assert.equal(status.resolved, null); assert.equal(status.current, green);
  fs.writeFileSync(file, '{"release":"green"}\n');
  status = f.status();
  assert.equal(status.committed.bytes, bytes); assert.deepEqual(status.prepared.config, { release: 'green' });
  assert.match(status.admissionError, reason); assert.equal(status.resolved, null);
  const output = f.ok(f.shell('pin-status', f.repo));
  assert.ok(output.includes(`committed pin bytes: ${JSON.stringify(bytes)}`)); assert.match(output, /admission refused:/);
});

test('a manually committed unready pin refuses admission with the same reason as read-back', t => {
  const f = fixture(t); f.bundle('offline'); f.accept('offline');
  const result = f.tool('exec', f.home, 'bin/org.mjs', 'help');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /acceptance-not-ready/);
  const status = f.status();
  assert.match(status.admissionError, /acceptance-not-ready/); assert.equal(status.resolved.acceptance.ready, false);
});

test('manifest refuses a non-READY or wrong-commit live summary and pin detects retained-summary damage', t => {
  const f = fixture(t), directory = f.bundle('ready', { live: true });
  assert.match(f.tool('manifest', directory, f.summaryFile({ ...JSON.parse(summaries[0]), ready: false })).stderr, /acceptance-not-ready/);
  assert.match(f.tool('manifest', directory, f.summaryFile(summaries[1])).stderr, /acceptance-commit-mismatch/);
  fs.appendFileSync(path.join(directory, '.release-acceptance.json'), '\n');
  assert.match(f.shell('pin', 'ready', f.repo).stderr, /acceptance-summary-mismatch/);
});

test('record-worker and watcher mutable entry points select the explicit project before freezing children', t => {
  const f = fixture(t), blue = f.bundle('blue', { live: true }), green = f.bundle('green', { live: true });
  fs.symlinkSync(green, path.join(f.home, 'current'));
  // The selected fixture entry is an observable admission oracle; the mutable
  // green entry remains the real implementation under test.
  for (const relative of ['dispatch/record-worker.mjs', 'watch/watch.mjs']) fs.writeFileSync(path.join(blue, relative), `console.log('selected-blue');`);
  f.ok(f.tool('manifest', blue, path.join(blue, '.release-acceptance.json'))); f.accept('blue');
  const org = path.join(f.root, 'org');
  f.ok(f.tool('exec', f.home, 'dispatch/record-worker.mjs', 'R-1', '--cwd', f.repo, '--agent', 'worker', '--pane', 'pane'));
  assert.equal(f.ok(f.run(process.execPath, [path.join(f.home, 'current/dispatch/record-worker.mjs'), 'R-1', '--cwd', f.repo, '--agent', 'worker', '--pane', 'pane'], f.root)), 'selected-blue');
  fs.writeFileSync(path.join(green, 'bin/org.mjs'), `console.log(JSON.stringify({meta:{}}));`);
  assert.equal(f.ok(f.run(process.execPath, [path.join(f.home, 'current/watch/watch.mjs'), 'R-1', '--cwd', f.repo, '--org', org, '--dry-run'], f.root)), 'selected-blue');
  const journal = path.join(f.root, 'dispatch.json');
  fs.writeFileSync(journal, JSON.stringify({ run: 'R-1', release: checkBundle(blue) }));
  fs.writeFileSync(path.join(green, 'bin/org.mjs'), `console.log(JSON.stringify({meta:{dispatch_journal:${JSON.stringify(journal)}}}));`);
  f.accept('green');
  assert.equal(f.ok(f.run(process.execPath, [path.join(f.home, 'current/watch/watch.mjs'), 'R-1', '--cwd', f.repo, '--org', org, '--dry-run'])), 'selected-blue', 're-arming a dispatch reuses its saved bundle after a pin change');
  fs.writeFileSync(journal, JSON.stringify({ run: 'R-1' }));
  assert.match(f.run(process.execPath, [path.join(f.home, 'current/watch/watch.mjs'), 'R-1', '--cwd', f.repo, '--org', org, '--dry-run']).stderr, /operation-release-missing/);
});

for (const adapter of ['arm-watch', 'release-exec']) test(`installed ${adapter} re-arms saved dispatches and tolerates a missing journal`, t => {
  const f = fixture(t), blue = f.bundle('blue', { live: true }), green = f.bundle('green', { live: true });
  fs.symlinkSync(green, path.join(f.home, 'current')); f.accept('blue');
  const org = path.join(f.root, 'org'), journal = path.join(f.root, 'dispatch.json');
  const snapshot = path.join(f.root, 'run.json'), record = path.join(f.root, 'record.cjs');
  const run = { id: 'R-1', item: 'ENG-1', meta: { agent: 'worker', dispatch_journal: journal }, report_path: path.join(f.root, 'report.md') };
  const save = value => fs.writeFileSync(snapshot, JSON.stringify(value)); save(run);
  fs.writeFileSync(record, `#!${process.execPath}\nconsole.log(require('fs').readFileSync(${JSON.stringify(snapshot)},'utf8'));`, { mode: 0o755 });
  fs.writeFileSync(journal, JSON.stringify({ run: run.id, release: checkBundle(blue) }));
  const entry = adapter === 'arm-watch' ? [path.join(green, 'supervisor/arm-watch.sh')]
    : [path.join(green, 'herdr/release.sh'), 'exec', 'watch/watch.mjs'];
  const rearm = () => f.run(adapter === 'arm-watch' ? 'sh' : 'bash', [...entry, run.id, '--cwd', f.repo,
    '--org', org, '--org-cli', record, '--workspace', 'scratch-workspace', '--spawn', '--dry-run'], f.root);
  const watcher = root => `'${path.join(root, 'watch/watch.mjs')}'`;
  // Both watchers are real implementations. Their dry-run spawn command is
  // an oracle for the next child path, without needing filesystem notifications.
  assert.ok(f.ok(rearm()).includes(watcher(blue)));
  f.accept('green');
  const continued = f.ok(rearm());
  assert.ok(continued.includes(watcher(blue)), continued); assert.equal(continued.includes(watcher(green)), false);
  fs.unlinkSync(journal);
  assert.ok(f.ok(rearm()).includes(watcher(green)), 'a missing journal follows normal selection, matching cold-start entry');
  fs.mkdirSync(journal);
  const unreadable = rearm(); assert.notEqual(unreadable.status, 0); assert.match(unreadable.stderr, /EISDIR/);
  fs.rmSync(journal, { recursive: true });
  fs.writeFileSync(journal, '{');
  const malformed = rearm(); assert.notEqual(malformed.status, 0); assert.match(malformed.stderr, /JSON/);
  save({ ...run, meta: { agent: 'worker' } });
  assert.ok(f.ok(rearm()).includes(watcher(green)), 'a new watcher uses the newly accepted pin');
  save(run); fs.writeFileSync(journal, JSON.stringify({ run: run.id }));
  const legacy = rearm(); assert.notEqual(legacy.status, 0); assert.match(legacy.stderr, /operation-release-missing/);
  fs.writeFileSync(journal, JSON.stringify({ run: 'R-2', release: checkBundle(blue) }));
  const mismatch = rearm(); assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /dispatch receipt does not match watched run/);
});

test('supervisor restart re-enters saved promotion requests for retry and completion before consulting a new pin', t => {
  const f = fixture(t), blue = f.bundle('blue', { live: true }), green = f.bundle('green', { live: true });
  fs.symlinkSync(green, path.join(f.home, 'current')); f.accept('green');
  fs.writeFileSync(path.join(blue, 'supervisor/supervisor.mjs'), `console.log('continued-blue');`);
  const org = path.join(f.root, 'org'); fs.mkdirSync(org);
  const identity = f.git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const directory = receiptDirectory(org, identity); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'R-1.json'), JSON.stringify({ identity, org, run: 'R-1',
    release: checkBundle(blue), phase: 'acknowledged', queue: { jobs: [{ id: 'job-a' }] } }));
  for (const args of [['promote', 'R-1', '--retry', '--why', 'fixture'], ['handle', 'R-1'],
    ['handle', '--notice', '[org-report] run=R-1 item=ENG-1 outcome=done headline=ready'],
    ['handle', '--notice', '[promote-queue] id=job-a lane=topic outcome=promoted']]) {
    assert.equal(f.ok(f.run(process.execPath, [path.join(f.home, 'current/supervisor/supervisor.mjs'), ...args,
      '--repo', f.repo, '--org', org, '--role', 'supervisor'], f.root)), 'continued-blue');
  }
  const file = path.join(directory, 'R-1.json'), legacy = JSON.parse(fs.readFileSync(file));
  delete legacy.release; fs.writeFileSync(file, JSON.stringify(legacy));
  assert.match(f.run(process.execPath, [path.join(f.home, 'current/supervisor/supervisor.mjs'), 'promote', 'R-1',
    '--retry', '--why', 'fixture', '--repo', f.repo, '--org', org, '--role', 'supervisor']).stderr, /operation-release-missing/);
});
