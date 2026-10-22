import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, hold, heldReason } from './helpers/retire-fixture.mjs';
import { sweepCommands } from './helpers/retire-sweep-fixture.mjs';
import { integratedLaneDecision } from '../lib/retire.mjs';
import { readRetirementWorktrees, readRetirementStatus } from '../lib/retire-runtime.mjs';

function sweep(f, options = {}) {
  const logs = [], commands = sweepCommands(f, options);
  const retirement = f.retirement({ ...commands, log: row => { logs.push(row); options.log?.(row); }, ...options.retirement });
  const results = retirement.sweepIntegratedLanes({ dryRun: options.dryRun });
  return { results, logs, ...commands };
}
const kept = (f, result, pattern) => {
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(f.git(['rev-parse', 'refs/heads/lane/topic']), f.head);
  assert.ok(result.results.some(row => row.decision === 'keep' && pattern.test(row.why)), JSON.stringify(result.results));
  assert.equal(result.calls.some(row => row.args.includes('remove')), false);
};

test('an exact archive releases a superseded run under an open item and parent', t => {
  const f = fixture(t, { occupied: false, merged: false });
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":true}}');
  f.git(['tag', 'archive/lane/topic', f.head]);
  const events = f.eventBytes.trim().split('\n').map(JSON.parse).filter(e => e.type !== 'item.closed');
  events[0].parent = 'G-1';
  events.push({ type: 'item.added', id: 'G-1', kind: 'goal' },
    { type: 'run.abandoned', id: 'R-1', note: 'Explicitly superseded attempt' });
  fs.writeFileSync(f.eventFile, events.map((e, i) => JSON.stringify({ ...e, seq: i + 1 }) + '\n').join(''));
  const before = fs.readFileSync(f.eventFile), result = sweep(f);
  assert.equal(result.results[0].action, 'lane-removed', JSON.stringify(result.results));
  assert.equal(result.results[0].eligibility, 'archive-tagged');
  assert.equal(f.git(['rev-parse', 'archive/lane/topic']), f.head);
  assert.deepEqual(fs.readFileSync(f.eventFile), before);
});

for (const record of ['terminal chain', 'open item', 'open review', 'established no chain']) test(`sweep removes an integrated registered lane with ${record}, preserving evidence under the lifecycle lock`, t => {
  const f = fixture(t, { occupied: false });
  if (record === 'established no chain') fs.writeFileSync(f.eventFile, '');
  if (record === 'open item') fs.writeFileSync(f.eventFile, f.eventBytes.trim().split('\n').map(JSON.parse)
    .filter(e => e.type !== 'item.closed').map(e => JSON.stringify(e) + '\n').join(''));
  if (record === 'open review') fs.appendFileSync(f.eventFile, JSON.stringify({ type: 'item.added', id: 'REV-1', parent: 'ENG-1', role: 'reviewer', seq: 5 }) + '\n');
  if (record === 'open item' || record === 'open review')
    fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":true}}');
  const bytes = fs.readFileSync(f.eventFile);
  f.git(['config', 'core.excludesFile', path.join(f.scratch, 'excludes')]);
  fs.writeFileSync(path.join(f.scratch, 'excludes'), '.lane/\n');
  fs.mkdirSync(path.join(f.lane, '.lane'));
  const evidence = Buffer.from('unique ignored report and diagnostics\n');
  fs.writeFileSync(path.join(f.lane, '.lane/report.md'), evidence);
  const result = sweep(f);
  assert.equal(result.results.length, 1); assert.equal(result.results[0].action, 'lane-removed');
  assert.equal(fs.existsSync(f.lane), false); assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
  assert.equal(f.git(['tag', '--list', 'archive/lane/topic']), '', 'merged sweep never archives');
  const proof = result.results[0].evidence;
  assert.equal(createHash('sha256').update(fs.readFileSync(proof.manifest)).digest('hex'), proof.sha256);
  assert.deepEqual(fs.readFileSync(path.join(proof.directory, 'files/.lane/report.md')), evidence);
  const removal = result.calls.findIndex(row => row.exe === 'git' && row.args.includes('remove'));
  assert.ok(removal > 0); assert.equal(result.calls[removal].locked, true);
  assert.deepEqual(result.calls[removal - 1].args.slice(2), ['merge-base', '--is-ancestor', f.head, 'refs/heads/main']);
  assert.equal(result.calls[removal - 1].locked, true);
  assert.deepEqual(f.read().actions, [['workspace', 'close', 'w']]);
  assert.deepEqual(fs.readFileSync(f.eventFile), bytes);
  assert.deepEqual(sweep(f).results, [], 'one removal, with nothing replayed on the next pass');
});

for (const guard of ['dirty', 'unintegrated', 'job reference', 'process reference', 'occupied', 'HOLD', 'bad references', 'missing record', 'unreadable record', 'wrong record', 'ambiguous record', 'lifecycle lock']) {
  test(`integrated sweep keeps ${guard} with its reason`, async t => {
    const f = fixture(t, { occupied: guard === 'occupied', merged: !guard.includes('unintegrated') });
    let pattern, options = {};
    if (guard === 'dirty') { fs.writeFileSync(path.join(f.lane, 'seed'), 'dirty'); pattern = /not clean/; }
    if (guard.includes('unintegrated')) {
      if (guard.startsWith('archived')) f.git(['tag', 'archive/lane/topic', f.head]);
      pattern = /not integrated|unmatched changes/;
    }
    if (guard === 'job reference') {
      fs.writeFileSync(path.join(f.org, 'references/job.json'), JSON.stringify({ schema: 'herdr-reference/v1', state: 'running',
        owner: 'fixture', kind: 'job', job: 'active', item: 'ENG-1', cwd: f.lane,
        created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString() }));
      pattern = /job reference active/;
    }
    if (guard === 'process reference') { options.cwdReference = true; pattern = /process cwd reference/; }
    if (guard === 'occupied') { f.state.agents = []; f.save(); pattern = /occupied lane/; }
    if (guard === 'HOLD') { hold(f); pattern = new RegExp(heldReason.replaceAll('.', '\\.')); }
    if (guard === 'bad references') { fs.writeFileSync(path.join(f.org, 'references/bad.json'), '{}'); pattern = /invalid herdr-reference/; }
    if (guard === 'missing record') { fs.unlinkSync(f.eventFile); pattern = /^retirement record is missing or unreadable; lane kept$/; }
    if (guard === 'unreadable record') { fs.rmSync(f.eventFile); fs.mkdirSync(f.eventFile); pattern = /missing or unreadable/; }
    if (['wrong record', 'ambiguous record'].includes(guard)) {
      const entry = { identity: f.common, checkout: f.repo, record: f.org, worktrees: f.scratch, layers: [] };
      fs.mkdirSync(f.env.HERDR_MONITOR_FLEET);
      fs.writeFileSync(path.join(f.env.HERDR_MONITOR_FLEET, 'fleet.json'), JSON.stringify({ version: 1, session_limit: 6,
        projects: { project: entry, ...(guard === 'ambiguous record' ? { duplicate: entry } : {}) } }));
      if (guard === 'wrong record') {
        const wrong = path.join(f.scratch, 'wrong-record'); fs.mkdirSync(wrong); fs.writeFileSync(path.join(wrong, 'events.jsonl'), '');
        options.retirement = { org: wrong };
      }
      pattern = /differs from canonical project record|ambiguous projects/;
    }
    if (guard === 'lifecycle lock') { fs.mkdirSync(path.join(f.common, 'lane-promote.lock')); pattern = /locked:.*lane-promote/; }
    const result = sweep(f, options); kept(f, result, pattern);
    if (['dirty', 'unintegrated', 'job reference', 'process reference', 'occupied', 'open review', 'open correction', 'bad references'].includes(guard)) {
      const status = await readRetirementStatus({ cwd: f.repo, org: f.org, herdr: f.job.herdr, env: f.env, command: sweepCommands(f, options).command });
      const row = status.rows.find(row => row.type === 'worktree' && row.worktree === f.lane);
      assert.match(row.reason, pattern); assert.equal(row.class, null); assert.match(row.nextAction, pattern);
    }
  });
}

for (const race of ['tip moves', 'main moves', 'HOLD arrives', 'job arrives', 'evidence changes']) test(`sweep rechecks ${race} at the guarded removal edge`, t => {
  const f = fixture(t, { occupied: false });
  let changed = false;
  const change = () => {
    if (changed) return; changed = true;
    if (race === 'tip moves') {
      fs.writeFileSync(path.join(f.lane, 'seed'), 'new tip'); f.git(['commit', '-am', 'reactivate'], f.lane);
    } else if (race === 'main moves') f.git(['update-ref', 'refs/heads/main', f.git(['rev-parse', `${f.head}^`])]);
    else if (race === 'HOLD arrives') hold(f);
    else if (race === 'job arrives') fs.writeFileSync(path.join(f.org, 'references/job.json'), JSON.stringify({ schema: 'herdr-reference/v1', state: 'running',
      owner: 'fixture', kind: 'late job', job: 'active', item: 'ENG-1', cwd: f.lane,
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString() }));
    else fs.writeFileSync(path.join(f.lane, 'seed'), 'changed after preservation');
  };
  const result = sweep(f, {
    before(exe, args) {
      if (race === 'main moves' && exe === 'git' && args[2] === 'merge-base' && args.at(-1) === 'refs/heads/main' && fs.existsSync(path.join(f.common, 'lane-promote.lock'))) change();
    },
    log(row) { if (race !== 'main moves' && row.action === 'lane-preflight') change(); },
  });
  assert.equal(changed, true); assert.equal(fs.existsSync(f.lane), true);
  assert.equal(result.results[0].decision, 'keep');
  assert.equal(result.calls.some(row => row.args.includes('remove')), false);
});

test('dry-run lists the exact lane without evidence writes, locks or removal', t => {
  const f = fixture(t, { occupied: false }), before = fs.readFileSync(f.eventFile);
  const result = sweep(f, { dryRun: true });
  assert.equal(result.results[0].action, 'would-remove-lane'); assert.equal(result.results[0].expectedTip, f.head);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
  assert.equal(result.calls.some(row => row.locked), false);
  assert.equal(fs.existsSync(f.lane), true); assert.deepEqual(f.read().actions, []);
  assert.deepEqual(fs.readFileSync(f.eventFile), before);
});

test('only registered linked lanes of the exact common directory are eligible', t => {
  const f = fixture(t, { occupied: false }), snapshot = f.retirement().observe();
  const tree = readRetirementWorktrees(f.common, { main: 'main', env: f.env }).find(row => row.branch === 'lane/topic');
  assert.equal(integratedLaneDecision(snapshot, tree).decision, 'release');
  for (const delta of [{ identity: '/another/.git' }, { linked: false }, { tip: 'short-tip' }, { branch: 'main' }]) {
    assert.match(integratedLaneDecision(snapshot, { ...tree, ...delta }).why, /registered lane identity/);
  }
  const ordinary = path.join(f.scratch, 'ordinary'); f.git(['worktree', 'add', '-b', 'ordinary', ordinary]);
  const result = sweep(f);
  assert.equal(result.results.length, 1); assert.equal(fs.existsSync(ordinary), true); assert.equal(fs.existsSync(f.repo), true);
});

test('pending promotion cleanup retains its retry caps and is not attempted by the sweep', t => {
  const f = fixture(t, { occupied: false }), queue = f.queue();
  queue.transaction(data => data.results.push({ ...f.job, outcome: 'promoted', cleanup: { state: 'pending', attempts: 5, next_attempt_at: 1e12 } }));
  const before = fs.readFileSync(queue.file);
  kept(f, sweep(f), /promotion queue cleanup pending/);
  assert.deepEqual(fs.readFileSync(queue.file), before);
});

test('a corrupt preserved copy is refused by the existing guarded removal executor', t => {
  const f = fixture(t, { occupied: false });
  fs.writeFileSync(path.join(f.common, 'info/exclude'), '.lane/\n');
  fs.mkdirSync(path.join(f.lane, '.lane')); fs.writeFileSync(path.join(f.lane, '.lane/report.md'), 'unique evidence');
  const result = sweep(f, { log(row) {
    if (row.action === 'lane-preflight') fs.writeFileSync(path.join(row.evidence.directory, 'files/.lane/report.md'), 'corrupt archive');
  } });
  kept(f, result, /evidence copy hash or inventory mismatch/);
  assert.equal(fs.readFileSync(path.join(f.lane, '.lane/report.md'), 'utf8'), 'unique evidence');
});

test('a finite sweep stops when its foreground deadline is reached', t => {
  const f = fixture(t, { occupied: false });
  assert.throws(() => sweep(f, { retirement: { deadline: Date.now() - 1 } }), /retirement deadline reached/);
  assert.equal(fs.existsSync(f.lane), true);
});

for (const record of ['none', 'terminal', 'open']) test(`a lane reset to its opening base keeps only unclaimed dispatch preparation: ${record}`, t => {
  const f = fixture(t, { occupied: false }), base = f.git(['rev-parse', `${f.head}^`]);
  f.git(['reset', '--hard', base], f.lane);
  if (record === 'none') fs.writeFileSync(f.eventFile, '');
  if (record === 'open') fs.writeFileSync(f.eventFile, fs.readFileSync(f.eventFile, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(e => e.type !== 'item.closed').map(e => JSON.stringify(e) + '\n').join(''));
  const tree = readRetirementWorktrees(f.common, { main: 'main', env: f.env, sweep: true })[0];
  assert.equal(tree.baseTip, base); assert.equal(tree.hasOwnCommits, false);
  const result = sweep(f);
  if (record !== 'none') {
    assert.equal(result.results[0].action, 'lane-removed'); assert.equal(fs.existsSync(f.lane), false);
  } else {
    assert.equal(result.results[0].action, 'keep'); assert.equal(fs.existsSync(f.lane), true);
    assert.match(result.results[0].why, /no commits of its own/);
    assert.equal(result.calls.some(row => row.args.includes('remove')), false);
  }
});

test('the sweep rechecks branch work history under the lifecycle lock before removing an unrecorded lane', t => {
  const f = fixture(t, { occupied: false }); fs.writeFileSync(f.eventFile, '');
  const result = sweep(f, { log(row) {
    if (row.action === 'lane-preflight') f.git(['reflog', 'expire', '--expire=now', 'refs/heads/lane/topic']);
  } });
  kept(f, result, /lane branch history is unavailable/);
  assert.equal(result.logs.some(row => row.action === 'lane-preflight'), true);
});

test('sweep inventory visits only lane rows, includes untracked dirt, and never enumerates ignored or untracked counts', t => {
  const f = fixture(t, { occupied: false }), ordinary = path.join(f.scratch, 'ordinary');
  f.git(['worktree', 'add', '-b', 'ordinary', ordinary]);
  fs.writeFileSync(path.join(f.lane, 'untracked'), 'keep me');
  fs.writeFileSync(path.join(f.common, 'info/exclude'), 'cache/\n');
  fs.mkdirSync(path.join(f.lane, 'cache')); fs.writeFileSync(path.join(f.lane, 'cache/ignored'), 'ignored payload');
  const commands = sweepCommands(f), rows = readRetirementWorktrees(f.common, { main: 'main', env: f.env, command: commands.command, sweep: true });
  assert.equal(rows.length, 1); assert.equal(rows[0].branch, 'lane/topic'); assert.equal(rows[0].clean, false);
  assert.equal(rows[0].untracked, null); assert.equal(rows[0].ignored, null); assert.equal(rows[0].hasOwnCommits, true);
  assert.ok(commands.calls.every(row => !row.args.includes('ls-files') && !row.args.includes('--ignored')));
  assert.ok(commands.calls.filter(row => row.args[0] === '-C').every(row => row.args[1] === f.lane), 'non-lane worktrees receive no per-tree commands');
  assert.ok(commands.calls.some(row => row.args.includes('status') && row.args.includes('--untracked-files=all')));
  kept(f, sweep(f), /not clean/);
});

test('repeated post-preservation removal failures discard only the unused verified evidence copy', t => {
  const f = fixture(t, { occupied: false });
  fs.writeFileSync(path.join(f.common, 'info/exclude'), '.lane/\n');
  fs.mkdirSync(path.join(f.lane, '.lane')); const source = path.join(f.lane, '.lane/report.md');
  fs.writeFileSync(source, 'unique evidence');
  const topicArchive = path.join(f.common, 'lane-archive/topic');
  fs.mkdirSync(path.join(topicArchive, 'prior-evidence'), { recursive: true });
  fs.writeFileSync(path.join(topicArchive, 'prior-evidence/report.md'), 'older recovery evidence');
  for (let pass = 0; pass < 3; pass++) {
    const result = sweep(f, { before(exe, args) {
      if (exe === 'git' && args[2] === 'worktree' && args[3] === 'remove') throw Error('injected worktree removal refusal');
    } });
    assert.equal(result.results[0].action, 'keep'); assert.match(result.results[0].why, /worktree removal refusal/);
    assert.equal(result.logs.filter(row => row.action === 'lane-preflight').length, 1);
    assert.equal(result.calls.filter(row => row.exe === 'git' && row.args.includes('remove')).length, 1, 'one removal attempt per lane per pass');
    assert.equal(result.logs.filter(row => row.action === 'lane-evidence-discarded').length, 1);
    assert.deepEqual(fs.readdirSync(topicArchive), ['prior-evidence']);
    assert.equal(fs.readFileSync(source, 'utf8'), 'unique evidence');
    assert.equal(f.git(['rev-parse', 'refs/heads/lane/topic']), f.head);
    assert.equal(fs.existsSync(path.join(f.common, 'lane-promote.lock')), false);
  }
  assert.equal(fs.readFileSync(path.join(topicArchive, 'prior-evidence/report.md'), 'utf8'), 'older recovery evidence');
  const recovered = sweep(f);
  assert.equal(recovered.results[0].action, 'lane-removed'); assert.equal(fs.existsSync(f.lane), false);
  assert.equal(fs.readFileSync(path.join(recovered.results[0].evidence.directory, 'files/.lane/report.md'), 'utf8'), 'unique evidence');
});

test('a branch deletion failure retains evidence after the source worktree has been removed', t => {
  const f = fixture(t, { occupied: false });
  fs.writeFileSync(path.join(f.common, 'info/exclude'), '.lane/\n');
  fs.mkdirSync(path.join(f.lane, '.lane')); fs.writeFileSync(path.join(f.lane, '.lane/report.md'), 'unique evidence');
  const result = sweep(f, { before(exe, args) {
    if (exe === 'git' && args[2] === 'branch' && args[3] === '-D') throw Error('injected branch deletion refusal');
  } });
  assert.match(result.results[0].why, /branch deletion refusal/); assert.equal(fs.existsSync(f.lane), false);
  const proof = result.logs.find(row => row.action === 'lane-preflight').evidence;
  assert.equal(fs.readFileSync(path.join(proof.directory, 'files/.lane/report.md'), 'utf8'), 'unique evidence');
  assert.equal(result.logs.some(row => row.action === 'lane-evidence-discarded'), false);
  assert.deepEqual(sweep(f).results, [], 'absent worktrees are never recopied or retried by the sweep');
});

test('failed removal retains the preserved snapshot when its source evidence changes', t => {
  const f = fixture(t, { occupied: false });
  fs.writeFileSync(path.join(f.common, 'info/exclude'), '.lane/\n');
  fs.mkdirSync(path.join(f.lane, '.lane')); const source = path.join(f.lane, '.lane/report.md'); fs.writeFileSync(source, 'original evidence');
  const result = sweep(f, { log(row) { if (row.action === 'lane-preflight') fs.writeFileSync(source, 'new evidence'); } });
  kept(f, result, /evidence copy hash or inventory mismatch/);
  const proof = result.logs.find(row => row.action === 'lane-preflight').evidence;
  assert.equal(fs.readFileSync(path.join(proof.directory, 'files/.lane/report.md'), 'utf8'), 'original evidence');
  assert.equal(fs.readFileSync(source, 'utf8'), 'new evidence');
  assert.equal(result.logs.some(row => row.action === 'lane-evidence-discarded'), false);
});
