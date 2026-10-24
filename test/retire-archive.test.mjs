import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, hold, isolatedEnv } from './helpers/retire-fixture.mjs';
import { sweepCommands } from './helpers/retire-sweep-fixture.mjs';
import { integratedLaneDecision } from '../lib/retire.mjs';
import { readRetirementStatus, readRetirementWorktrees } from '../lib/retire-runtime.mjs';
import { readArchivalRetirementPolicy } from '../lib/retire-archive.mjs';

const archivalProbe = ({ exe, args }) => exe === 'git' && (args.includes('cherry') || args.includes('rev-list') ||
  args.includes('--is-shallow-repository') || args.includes('refs/replace') || args.includes('info/grafts') ||
  (args.includes('--verify') && args.includes('refs/heads/lane/topic')));
function boundedSummary(summary) {
  assert.equal(Object.hasOwn(summary, 'patches'), false);
  assert.equal(Object.hasOwn(summary, 'uniqueMerges'), false);
  assert.match(summary.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 1024);
}

test('canonical HOLD skips archival probes in inventory, status and sweep', async t => {
  const f = landed(t);
  hold(f);
  for (const sweep of [false, true]) {
    const commands = sweepCommands(f);
    const trees = readRetirementWorktrees(f.common, { main: 'main', env: f.env, ...commands, sweep, archivalRetirement: true });
    assert.equal(trees.find(row => row.branch === 'lane/topic').archival, undefined);
    assert.deepEqual(commands.calls.filter(archivalProbe), []);
  }
  const commands = sweepCommands(f);
  await readRetirementStatus({ cwd: f.repo, org: f.org, env: f.env, herdr: f.job.herdr, ...commands });
  assert.deepEqual(commands.calls.filter(archivalProbe), []);
  const result = sweep(f);
  kept(f, result, /retirement held/);
  assert.deepEqual(result.calls.filter(archivalProbe), []);
});

test('incomplete archival observations retain their diagnostic in decisions and logs', t => {
  const f = landed(t), commands = sweepCommands(f), command = commands.command, logs = [];
  commands.command = (exe, args, options) => exe === 'git' && args.includes('cherry') ?
    { status: 1, stdout: '', stderr: 'fixture history unavailable' } : command(exe, args, options);
  const tree = readRetirementWorktrees(f.common, { main: 'main', env: f.env, ...commands, archivalRetirement: true }).find(row => row.branch === 'lane/topic');
  const decision = integratedLaneDecision(f.retirement(commands).observe(), tree);
  assert.equal(decision.decision, 'keep');
  assert.equal(decision.archival.error, tree.archival.error);
  assert.match(decision.archival.error, /fixture history unavailable/);
  boundedSummary(decision.archival);
  const results = f.retirement({ ...commands, log: row => logs.push(row) }).sweepIntegratedLanes();
  for (const row of [...results, ...logs].filter(row => row.archival)) assert.equal(row.archival.error, tree.archival.error);
  assert.ok(logs.some(row => row.archival));
  assert.equal(fs.existsSync(f.lane), true);
});

const policy = (f, value = true, extra = {}) => fs.writeFileSync(path.join(f.repo, '.lane.json'),
  JSON.stringify({ retirement: { closeout_queue: false, archival_retirement: value, ...extra } }));
function landed(t, { method = 'cherry-pick', enabled = true, occupied = false } = {}) {
  const f = fixture(t, { merged: false, occupied });
  fs.writeFileSync(path.join(f.repo, 'main-only'), 'independent main work');
  f.git(['add', '.']); f.git(['commit', '-qm', 'main diverges']);
  if (method === 'rebase') {
    f.git(['checkout', '-qb', 'landing', f.head]); f.git(['rebase', 'main']);
    f.git(['checkout', 'main']); f.git(['merge', '--ff-only', 'landing']);
  } else f.git(['cherry-pick', f.head]);
  const mainTip = f.git(['rev-parse', 'main']);
  assert.notEqual(mainTip, f.head);
  assert.match(f.git(['cherry', mainTip, f.head]), /^- /);
  if (enabled) policy(f);
  return { ...f, mainTip };
}
function sweep(f, options = {}) {
  const logs = [], commands = sweepCommands(f, options);
  const retirement = f.retirement({ ...commands, log: row => { logs.push(row); options.log?.(row); } });
  return { results: retirement.sweepIntegratedLanes({ dryRun: options.dryRun }), logs, ...commands };
}
function kept(f, result, pattern, { tag = false, moved = false } = {}) {
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].decision, 'keep', JSON.stringify(result.results));
  assert.match(result.results[0].why, pattern);
  assert.equal(fs.existsSync(f.lane), true);
  if (!moved) assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  assert.equal(result.calls.some(row => row.exe === 'git' && row.args.includes('remove')), false);
  assert.deepEqual(f.read().actions, []);
  if (!tag) assert.equal(f.git(['tag', '--list', 'archive/lane/topic']), '');
}
function evidence(f) {
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n.lane/\n');
  fs.mkdirSync(path.join(f.lane, '.lane'));
  const bytes = Buffer.from('original ignored report and diagnostic bytes\n');
  fs.writeFileSync(path.join(f.lane, '.lane/report.md'), bytes);
  return bytes;
}
const event = (f, row) => {
  const seq = fs.readFileSync(f.eventFile, 'utf8').trim().split('\n').filter(Boolean).length + 1;
  fs.appendFileSync(f.eventFile, JSON.stringify({ ...row, seq, at: '2026-10-19T00:00:00Z', by: 'test' }) + '\n');
};

for (const method of ['cherry-pick', 'rebase']) for (const record of ['terminal', 'no chain']) {
  test(`archival sweep recovers ${method} history with ${record} without changing the ancestry fact`, async t => {
    const f = landed(t, { method }), bytes = evidence(f);
    if (record === 'no chain') fs.writeFileSync(f.eventFile, '');
    const recordBefore = fs.readFileSync(f.eventFile);
    const commands = sweepCommands(f), retirement = f.retirement(commands);
    assert.equal(retirement.observe().git[0].integrated, false);
    const status = await readRetirementStatus({ cwd: f.repo, org: f.org, env: f.env, herdr: f.job.herdr, ...commands });
    const row = status.rows.find(row => row.type === 'worktree' && row.worktree === f.lane);
    assert.equal(row.integrated, false); assert.equal(row.class, null, 'CLOSEOUT.md:23-26 keeps foreground sweep candidates inventory-only without opt-in');
    assert.match(row.nextAction, /eligible for archival retirement/);
    boundedSummary(row.archival);
    const result = sweep(f), proof = result.results[0];
    assert.equal(proof.action, 'lane-removed', JSON.stringify(result.results));
    assert.equal(proof.eligibility, 'archival-retirement'); assert.equal(proof.integrated, false);
    assert.equal(proof.tip, f.head); assert.equal(proof.mainTip, f.mainTip);
    assert.equal(proof.archiveTag, 'archive/lane/topic');
    boundedSummary(proof.archival);
    assert.equal(proof.archival.patchCount, 1); assert.equal(proof.archival.matchedPatchCount, 1);
    assert.equal(proof.archival.unmatchedPatchCount, 0); assert.equal(proof.archival.mergeCount, 0);
    assert.equal(proof.archival.firstMismatch, null); assert.equal(proof.archival.sha256, row.archival.sha256);
    for (const logged of result.logs) if (logged.archival) {
      boundedSummary(logged.archival); assert.deepEqual(logged.archival, proof.archival);
    }
    assert.equal(f.git(['rev-parse', `${proof.archiveTag}^{commit}`]), f.head);
    assert.equal(fs.existsSync(f.lane), false); assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
    assert.equal(createHash('sha256').update(fs.readFileSync(proof.evidence.manifest)).digest('hex'), proof.evidence.sha256);
    assert.deepEqual(fs.readFileSync(path.join(proof.evidence.directory, 'files/.lane/report.md')), bytes);
    const removal = result.calls.findIndex(row => row.exe === 'git' && row.args.includes('remove'));
    const archive = result.calls.findIndex(row => row.exe === 'git' && row.args[2] === 'tag' && row.args[3] === 'archive/lane/topic');
    assert.ok(archive >= 0 && archive < removal); assert.equal(result.calls[archive].locked, true);
    assert.equal(result.calls[removal].locked, true);
    // ENG-530: fresh main proof precedes tag creation; exact archive durability
    // is verified immediately before removal, within that same removal lock.
    const main = result.calls.findLastIndex((row, index) => index < archive && row.exe === 'git' &&
      JSON.stringify(row.args.slice(2)) === JSON.stringify(['rev-parse', '--verify', 'refs/heads/main']));
    assert.ok(main >= 0 && main < archive, 'main is freshly checked before creating the archive');
    assert.deepEqual(result.calls[removal - 1].args.slice(2), ['rev-parse', '--verify', `refs/tags/${proof.archiveTag}^{commit}`]);
    assert.ok(result.calls.slice(main, removal + 1).every(row => row.locked), 'main, archive and removal share the guarded lock');
    assert.deepEqual(f.read().actions, [['workspace', 'close', 'w']]);
    assert.deepEqual(fs.readFileSync(f.eventFile), recordBefore);
    assert.deepEqual(sweep(f).results, []);
  });
}

for (const setting of [false, 'lane copy', 'environment override']) test(`explicit archival opt-out keeps patch-equivalent lanes despite ${setting}`, t => {
  const f = landed(t, { enabled: false });
  policy(f, false);
  if (setting === 'lane copy') {
    fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n.lane.json\n');
    fs.writeFileSync(path.join(f.lane, '.lane.json'), JSON.stringify({ retirement: { archival_retirement: true } }));
  }
  if (setting === 'environment override') {
    const config = path.join(f.scratch, 'override.json');
    fs.writeFileSync(config, JSON.stringify({ retirement: { archival_retirement: true } })); f.env.LANE_CONFIG = config;
  }
  const result = sweep(f);
  kept(f, result, /archival retirement policy is off/);
  assert.deepEqual(result.calls.filter(archivalProbe), []);
  assert.equal(result.calls.some(row => row.locked), false);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
});

for (const method of ['cherry-pick', 'rebase']) test(`opted-in closeout with default ${method} patch proof releases an open item and parent, preserving the exact original tip`, async t => {
  const f = landed(t, { method, enabled: false });
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":true}}');
  event(f, { type: 'item.reopened', id: 'ENG-1' });
  event(f, { type: 'item.added', id: 'ENG-2', role: 'engineer', parent: 'ENG-1' });
  event(f, { type: 'item.added', id: 'REV-1', role: 'reviewer', parent: 'ENG-1' });
  const before = fs.readFileSync(f.eventFile), commands = sweepCommands(f);
  const snapshot = f.retirement(commands).observe();
  assert.equal(snapshot.git[0].integrated, false); assert.equal(snapshot.git[0].patchIntegrated, true);
  const status = await readRetirementStatus({ cwd: f.repo, org: f.org, env: f.env, herdr: f.job.herdr, ...commands });
  assert.equal(status.rows.find(row => row.type === 'worktree' && row.worktree === f.lane).class, 'TERMINAL');
  const result = sweep(f);
  assert.equal(result.results[0].action, 'lane-removed', JSON.stringify(result.results));
  assert.equal(f.git(['rev-parse', 'archive/lane/topic']), f.head);
  assert.deepEqual(fs.readFileSync(f.eventFile), before);
});

for (const sweepMode of [false, true]) for (const [enabled, dirty] of [[false, false], [false, true], [true, true], [true, false]]) {
  test(`archival inventory probes only clean enabled lanes (sweep ${sweepMode}, policy ${enabled}, dirty ${dirty})`, t => {
    const f = landed(t, { enabled });
    if (dirty) fs.writeFileSync(path.join(f.lane, 'seed'), 'unfinished edit');
    const commands = sweepCommands(f);
    const trees = readRetirementWorktrees(f.common, { main: 'main', env: f.env, ...commands,
      sweep: sweepMode, archivalRetirement: enabled });
    const tree = trees.find(tree => tree.branch === 'lane/topic');
    assert.equal(tree.clean, !dirty); assert.equal(tree.integrated, false);
    const probes = commands.calls.filter(archivalProbe);
    const mainReads = commands.calls.filter(row => row.args.includes('--verify') && row.args.includes('refs/heads/main'));
    if (!enabled || dirty) {
      assert.equal(tree.archival, undefined); assert.deepEqual(probes, []);
      assert.equal(mainReads.length, trees.length, 'only the ordinary ancestry snapshots read main');
    } else {
      assert.equal(tree.archival.complete, true);
      for (const probe of ['cherry', 'rev-list', '--is-shallow-repository', 'refs/replace', 'info/grafts'])
        assert.ok(probes.some(row => row.args.includes(probe)), probe);
      assert.equal(mainReads.length, trees.length + 2, 'archival observation binds main before and after its probes');
    }
  });
}

for (const guard of ['invalid lane name', 'untouched preparation', 'unlinked checkout']) test(`an existing inventory keep skips archival probes: ${guard}`, t => {
  const f = landed(t);
  if (guard === 'invalid lane name') f.git(['branch', '-m', 'lane/topic', 'lane/x']);
  if (guard === 'untouched preparation') {
    f.git(['branch', '-m', 'lane/topic', 'lane/previous']);
    f.git(['checkout', '-b', 'lane/topic', f.head], f.lane);
  }
  const commands = sweepCommands(f), command = commands.command;
  if (guard === 'unlinked checkout') commands.command = (exe, args, options) => exe === 'git' && args.includes('--absolute-git-dir') ?
    { status: 0, stdout: f.common + '\n', stderr: '' } : command(exe, args, options);
  const tree = readRetirementWorktrees(f.common, { main: 'main', env: f.env, ...commands, sweep: true, archivalRetirement: true })[0];
  assert.equal(tree.archival, undefined); assert.deepEqual(commands.calls.filter(archivalProbe), []);
  assert.equal(commands.calls.filter(row => row.args.includes('--verify') && row.args.includes('refs/heads/main')).length, 1);
});

test('archival decisions and keep logs retain bounded counts, the first mismatch and a digest of the full history', t => {
  const f = landed(t), commands = sweepCommands(f), command = commands.command, logs = [];
  const patches = Array.from({ length: 1000 }, (_, index) => ({ sign: index === 3 ? '+' : '-', commit: (index + 1).toString(16).padStart(40, '0') }));
  commands.command = (exe, args, options) => exe === 'git' && args.includes('cherry') ?
    { status: 0, stdout: patches.map(patch => `${patch.sign} ${patch.commit}`).join('\n') + '\n', stderr: '' } : command(exe, args, options);
  const tree = readRetirementWorktrees(f.common, { main: 'main', env: f.env, ...commands, sweep: true, archivalRetirement: true })[0];
  const before = JSON.stringify(tree.archival), snapshot = f.retirement(commands).observe();
  const decision = integratedLaneDecision(snapshot, tree), summary = decision.archival;
  assert.equal(decision.decision, 'keep'); assert.match(decision.why, /unmatched changes/);
  boundedSummary(summary);
  assert.equal(summary.patchCount, 1000); assert.equal(summary.matchedPatchCount, 999);
  assert.equal(summary.unmatchedPatchCount, 1); assert.equal(summary.mergeCount, 0);
  assert.deepEqual(summary.firstMismatch, { kind: 'patch', ...patches[3] });
  assert.equal(summary.sha256, createHash('sha256').update(before).digest('hex'));
  assert.equal(JSON.stringify(tree.archival), before, 'summarizing never mutates executor evidence');
  const changed = structuredClone(tree); changed.archival.patches.at(-1).commit = 'a'.repeat(40);
  const changedSummary = integratedLaneDecision(snapshot, changed).archival;
  assert.notEqual(changedSummary.sha256, summary.sha256, 'the digest includes history beyond the first mismatch');
  assert.deepEqual({ ...changedSummary, sha256: summary.sha256 }, summary);
  const merged = structuredClone(tree); merged.archival.uniqueMerges = Array.from({ length: 1000 }, (_, i) => (i + 1001).toString(16).padStart(40, '0'));
  const mergeDecision = integratedLaneDecision(snapshot, merged);
  boundedSummary(mergeDecision.archival); assert.match(mergeDecision.why, /unaccounted merge/);
  assert.equal(mergeDecision.archival.mergeCount, 1000);
  assert.deepEqual(mergeDecision.archival.firstMismatch, { kind: 'merge', commit: merged.archival.uniqueMerges[0] });
  assert.equal(mergeDecision.archival.sha256, createHash('sha256').update(JSON.stringify(merged.archival)).digest('hex'));
  const result = f.retirement({ ...commands, log: row => logs.push(row) }).sweepIntegratedLanes();
  assert.equal(result[0].decision, 'keep');
  for (const row of [...result, ...logs]) {
    assert.deepEqual(row.archival, summary);
    assert.ok(Buffer.byteLength(JSON.stringify(row)) < 2048, 'receipt size does not grow with the patch inventory');
  }
  assert.equal(fs.existsSync(f.lane), true);
});

for (const config of ['malformed', 'wrong type']) test(`archival policy ${config} fails closed`, t => {
  const f = landed(t);
  if (config === 'malformed') fs.writeFileSync(path.join(f.repo, '.lane.json'), '{');
  else policy(f, 'true');
  kept(f, sweep(f), /archival retirement policy is unavailable/);
});

test('a hand-edited unknown desk route holds direct archival policy and the sweep', t => {
  const f = landed(t); isolatedEnv(t, f);
  const file = path.join(f.repo, '.lane.json');
  const config = { retirement: { archival_retirement: true }, routes: { reviewer: { kind: 'codex' } }, settle: { review_route: 'reviewer' } };
  fs.writeFileSync(file, JSON.stringify(config));
  assert.equal(readArchivalRetirementPolicy(f.repo).archivalRetirementPolicy, true);
  config.settle.review_route = 'unknown-hand-edit'; fs.writeFileSync(file, JSON.stringify(config));
  const held = readArchivalRetirementPolicy(f.repo);
  assert.equal(held.archivalRetirementPolicy, false);
  assert.match(held.archivalRetirementPolicyError, /unknown route: unknown-hand-edit.*held/);
  kept(f, sweep(f), /archival retirement policy is unavailable/);
});

test('archival preview has no tag, preservation, lifecycle lock or mutation', t => {
  const f = landed(t); evidence(f);
  const result = sweep(f, { dryRun: true });
  assert.equal(result.results[0].action, 'would-remove-lane'); assert.equal(result.results[0].eligibility, 'archival-retirement');
  assert.equal(result.results[0].mainTip, f.mainTip);
  assert.equal(f.git(['tag', '--list', 'archive/lane/topic']), '');
  assert.equal(result.calls.some(row => row.locked), false); assert.deepEqual(f.read().actions, []);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
});

for (const obligation of ['open run', 'occupied', 'job reference', 'process reference', 'HOLD', 'missing record', 'unreadable record', 'unknown no-chain history', 'untouched preparation']) {
  test(`archival retirement keeps ${obligation}, including historical matches after a revert`, t => {
    const f = landed(t, { occupied: obligation === 'occupied' });
    let pattern, options = {};
    if (obligation === 'open run') { event(f, { type: 'run.started', id: 'R-2', item: 'ENG-1', workspace: f.lane }); pattern = /open recorded run/; }
    if (obligation === 'occupied') pattern = /occupied lane/;
    if (obligation === 'job reference') {
      fs.writeFileSync(path.join(f.org, 'references/job.json'), JSON.stringify({ schema: 'herdr-reference/v1', state: 'running',
        owner: 'test', kind: 'job', job: 'active', item: 'ENG-1', cwd: f.lane,
        created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString() }));
      pattern = /job reference active/;
    }
    if (obligation === 'process reference') { options.cwdReference = true; pattern = /process cwd reference/; }
    if (obligation === 'HOLD') { hold(f); pattern = /retirement held/; }
    if (obligation === 'missing record') { fs.unlinkSync(f.eventFile); pattern = /record is missing or unreadable/; }
    if (obligation === 'unreadable record') { fs.writeFileSync(f.eventFile, 'not JSON\n'); pattern = /invalid event|malformed|JSON/i; }
    if (obligation === 'unknown no-chain history') {
      fs.writeFileSync(f.eventFile, ''); f.git(['reflog', 'expire', '--expire=now', 'refs/heads/lane/topic']); pattern = /branch history is unavailable/;
    }
    if (obligation === 'untouched preparation') {
      fs.writeFileSync(f.eventFile, ''); f.git(['reset', '--hard', `${f.head}^`], f.lane); pattern = /no commits of its own/;
    }
    kept(f, sweep(f, options), pattern, { moved: obligation === 'untouched preparation' });
  });
}

test('an unmatched lane change is kept even with a terminal record', t => {
  const f = landed(t);
  fs.writeFileSync(path.join(f.lane, 'seed'), 'unmatched work'); f.git(['commit', '-am', 'unmatched'], f.lane);
  assert.match(f.git(['cherry', 'main', 'lane/topic']), /\+ /);
  kept(f, sweep(f), /unmatched changes/, { moved: true });
});

test('an untouched patch-equivalent preparation stays kept even with an older terminal record at that path', t => {
  const f = landed(t);
  f.git(['branch', '-m', 'lane/topic', 'lane/previous']);
  f.git(['checkout', '-b', 'lane/topic', f.head], f.lane);
  kept(f, sweep(f), /dispatch preparation kept/);
});

test('an unaccounted merge resolution is kept even when every non-merge patch matches', t => {
  const f = landed(t), base = f.git(['rev-parse', `${f.head}^`]);
  f.git(['checkout', '-qb', 'side', base]); fs.writeFileSync(path.join(f.repo, 'seed'), 'side conflict');
  f.git(['commit', '-am', 'side']); f.git(['checkout', 'main']);
  // A real conflicted merge with a unique manual resolution on the original lane.
  const merge = sweepCommands(f).command('git', ['-C', f.lane, 'merge', '--no-ff', 'side'], { env: f.env, encoding: 'utf8' });
  assert.equal(merge.status, 1); fs.writeFileSync(path.join(f.lane, 'seed'), 'unaccounted resolution');
  f.git(['add', 'seed'], f.lane); f.git(['commit', '-qm', 'unique merge resolution'], f.lane);
  // Main accounts for both non-merge histories, with its own resolution.
  const mainMerge = sweepCommands(f).command('git', ['-C', f.repo, 'merge', '--no-ff', 'side'], { env: f.env, encoding: 'utf8' });
  assert.equal(mainMerge.status, 1); fs.writeFileSync(path.join(f.repo, 'seed'), 'changed');
  f.git(['add', 'seed']); f.git(['commit', '-qm', 'main resolution']);
  assert.ok(f.git(['cherry', 'main', 'lane/topic']).split('\n').every(line => line.startsWith('- ')));
  kept(f, sweep(f), /unaccounted merge commits/, { moved: true });
});

for (const failure of ['cherry fails', 'cherry malformed', 'merge inventory fails', 'ancestry unavailable', 'shallow history']) {
  test(`incomplete Git observation keeps the archival lane: ${failure}`, t => {
    const f = landed(t);
    const options = { before(exe, args) {
      if (exe !== 'git') return;
      if ((failure === 'cherry fails' && args.includes('cherry')) ||
          (failure === 'merge inventory fails' && args.includes('rev-list')) ||
          (failure === 'ancestry unavailable' && args.includes('--is-ancestor'))) throw Error('injected unavailable observation');
    } };
    if (failure === 'shallow history') fs.writeFileSync(path.join(f.common, 'shallow'), f.git(['rev-parse', `${f.head}^`]) + '\n');
    if (failure === 'cherry malformed') {
      const commands = sweepCommands(f), command = commands.command;
      commands.command = (exe, args, options) => exe === 'git' && args.includes('cherry') ? { status: 0, stdout: 'unexpected output', stderr: '' } : command(exe, args, options);
      const results = f.retirement(commands).sweepIntegratedLanes();
      kept(f, { results, calls: commands.calls }, /observation is incomplete/); return;
    }
    kept(f, sweep(f, options), failure === 'ancestry unavailable' ? /unavailable observation/ : /observation is incomplete/);
  });
}

for (const race of ['lane tip', 'main tip', 'policy', 'archive tag', 'record obligation', 'reference', 'occupant', 'evidence']) {
  test(`archival removal rechecks ${race} movement during the locked pass`, t => {
    const f = landed(t), bytes = evidence(f); let changed = false;
    const result = sweep(f, { log(row) {
      if (row.action !== 'lane-preflight') return;
      changed = true;
      if (race === 'lane tip') { fs.writeFileSync(path.join(f.lane, 'seed'), 'reactivated'); f.git(['commit', '-am', 'reactivate'], f.lane); }
      if (race === 'main tip') { fs.writeFileSync(path.join(f.repo, 'main-only'), 'main moved'); f.git(['commit', '-am', 'main moves']); }
      if (race === 'policy') policy(f, false);
      if (race === 'archive tag') f.git(['tag', '-f', 'archive/lane/topic', 'main']);
      if (race === 'record obligation') event(f, { type: 'run.started', id: 'R-2', item: 'ENG-1', workspace: f.lane });
      if (race === 'reference') fs.writeFileSync(path.join(f.org, 'references/late.json'), JSON.stringify({ schema: 'herdr-reference/v1', state: 'running',
        owner: 'test', kind: 'late job', job: 'active', item: 'ENG-1', cwd: f.lane,
        created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString() }));
      if (race === 'occupant') {
        f.state.tabs.push({ tab_id: 'w:t', workspace_id: 'w' });
        f.state.panes.push({ pane_id: 'w:p', tab_id: 'w:t', workspace_id: 'w', terminal_id: 'term' });
        f.state.agents.push({ name: 'worker', agent: 'native', agent_status: 'done', pane_id: 'w:p', tab_id: 'w:t',
          workspace_id: 'w', cwd: f.lane, terminal_id: 'term', agent_session: { value: 'session' }, state_change_seq: 5 });
        f.save();
      }
      if (race === 'evidence') fs.writeFileSync(path.join(row.evidence.directory, 'files/.lane/report.md'), 'corrupt preservation');
    } });
    assert.equal(changed, true);
    kept(f, result, race === 'occupant' ? /occupied lane/ : /changed|snapshot|not contained|policy is off|durability|open (?:recorded )?run|reference|mismatch/,
      { tag: true, moved: race === 'lane tip' });
    assert.deepEqual(fs.readFileSync(path.join(f.lane, '.lane/report.md')), bytes);
    assert.equal(fs.existsSync(path.join(f.common, 'lane-promote.lock')), false);
  });
}

test('main movement during patch observation invalidates the candidate before locking', t => {
  const f = landed(t); let changed = false;
  const result = sweep(f, { before(exe, args) {
    if (!changed && exe === 'git' && args.includes('cherry')) { changed = true; f.git(['update-ref', 'refs/heads/main', `${f.mainTip}^`]); }
  } });
  assert.equal(changed, true); kept(f, result, /Git snapshot changed/);
  assert.equal(result.calls.some(row => row.locked), false);
});

for (const failure of ['tag collision', 'tag creation', 'preservation', 'protected path']) test(`archive recovery must succeed before removal: ${failure}`, t => {
  const f = landed(t); evidence(f);
  if (failure === 'tag collision') f.git(['tag', 'archive/lane/topic', 'main']);
  if (failure === 'protected path') {
    policy(f, true, { protected_paths: ['vault/**'] });
    fs.appendFileSync(path.join(f.common, 'info/exclude'), '\nvault/\n');
    fs.mkdirSync(path.join(f.lane, 'vault')); fs.writeFileSync(path.join(f.lane, 'vault/operator-state'), 'protected');
  }
  if (failure === 'preservation') f.env.LANE_EVIDENCE_MAX_BYTES = '1';
  const result = sweep(f, { before(exe, args) {
    if (failure === 'tag creation' && exe === 'git' && args[2] === 'tag' && args[3] === 'archive/lane/topic') throw Error('injected tag creation failure');
  } });
  kept(f, result, /archive tag collision|tag creation failure|evidence.*(?:budget|limit)|protected/i, { tag: failure === 'tag collision' });
  if (failure === 'tag collision') assert.equal(f.git(['rev-parse', 'archive/lane/topic']), f.mainTip);
});

test('an existing exact tag can be reused, while CLI expected-tip remains ancestry-only', t => {
  const f = landed(t); f.git(['tag', 'archive/lane/topic', f.head]);
  const retirement = f.retirement(sweepCommands(f));
  assert.throws(() => retirement.removeLane({ lane: f.lane, branch: 'lane/topic', expectedTip: f.head, gitOnly: true }), /not contained in main/);
  const result = sweep(f); assert.equal(result.results[0].action, 'lane-removed');
  assert.equal(result.calls.some(row => row.args[2] === 'tag' && row.args[3] === 'archive/lane/topic'), false);
  assert.equal(f.git(['rev-parse', 'archive/lane/topic']), f.head);
});

test('archival planner rejects absent and inconsistent history observations', t => {
  const f = landed(t), commands = sweepCommands(f), snapshot = f.retirement(commands).observe();
  const tree = readRetirementWorktrees(f.common, { main: 'main', env: f.env, ...commands, archivalRetirement: true }).find(t => t.branch === 'lane/topic');
  assert.equal(integratedLaneDecision(snapshot, tree).decision, 'release');
  for (const delta of [{ archival: undefined }, { archival: { ...tree.archival, complete: false } },
    { archival: { ...tree.archival, mainTip: f.head } }, { archival: { ...tree.archival, patches: [] } }]) {
    const decision = integratedLaneDecision(snapshot, { ...tree, ...delta });
    assert.equal(decision.decision, 'keep'); assert.match(decision.why, /incomplete|snapshot changed|no matched patches/);
  }
});
