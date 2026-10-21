import test from './helpers/bounded-test.mjs';
import { commandAllowance } from './helpers/command-allowance.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, hold } from './helpers/retire-fixture.mjs';
import { sweepCommands } from './helpers/retire-sweep-fixture.mjs';
import { prepareScratchSweep, SCRATCH_OWNER_FILE } from '../lib/scratch-sweep.mjs';
import { readProcessFileReferences } from '../lib/lane-removal.mjs';
import { discoverArchive } from '../lib/archive.mjs';
import { assertFixtureScratch } from './helpers/scratch-fixture.mjs';
import { loadTimeout } from '../lib/deadline.mjs';

function setup(t, options) {
  const f = fixture(t, { occupied: false, ...options }), root = path.join(f.scratch, 'scratch');
  fs.mkdirSync(root);
  const runs = [{ id: 'R-1', workspace: f.lane, report: { artifacts: [] } }];
  const evidence = { directory: path.join(f.common, 'lane-archive/topic/proof') };
  fs.mkdirSync(evidence.directory, { recursive: true });
  const warnings = [], log = [];
  const prepare = extra => prepareScratchSweep({ common: f.common, canonical: f.repo, lane: f.lane, topic: 'topic',
    tip: f.head, integrated: true, runs, topics: ['topic', 'topic-ds3'], evidence, env: f.env, roots: [root],
    readOpenFiles: () => [], warn: message => warnings.push(message), log: row => log.push(row), ...extra });
  const directory = (name, marker) => {
    const file = path.join(root, name); fs.mkdirSync(file); fs.writeFileSync(path.join(file, 'payload'), 'abc');
    if (marker) fs.writeFileSync(path.join(file, SCRATCH_OWNER_FILE), JSON.stringify({ schema: 'herdr-scratch/v1', common: f.common, ...marker }));
    return file;
  };
  const read = sweep => JSON.parse(fs.readFileSync(sweep.manifest));
  return { ...f, root, runs, evidence, prepare, directory, warnings, log, read };
}

for (const transport of ['runtime', 'CLI']) test(`the ${transport} retirement fixture inventories only its private scratch directory`, t => {
  const f = fixture(t, { occupied: false }), [root] = JSON.parse(f.env.HERDR_TEST_SCRATCH_ROOTS);
  const own = path.join(root, 'topic-review'), outside = path.join(f.scratch, 'topic-other-review');
  fs.mkdirSync(own); fs.mkdirSync(outside);
  let manifest;
  if (transport === 'runtime') manifest = f.retirement({ command: sweepCommands(f).command })
    .removeLane({ lane: f.lane, branch: 'lane/topic', gitOnly: true }).scratchManifest;
  else {
    // The real close includes both cwd and open-file inventories for scratch.
    const result = f.close(true, { [commandAllowance]: loadTimeout(45_000) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    manifest = result.stdout.split('\n').filter(line => line.startsWith('{')).map(JSON.parse)
      .find(row => row.action === 'scratch-manifest').manifest;
  }
  const data = assertFixtureScratch(manifest, f.env);
  assert.deepEqual(data.entries.map(entry => entry.path), [own], 'the private root was actually inventoried');
  assert.ok(fs.existsSync(outside), 'a same-topic directory outside the private root is untouched');
});

test('run marker wins over topic names, manifest precedes removal, and only the closed run is removed', t => {
  const f = setup(t), owned = f.directory('unrelated-name', { run: 'R-1' });
  const active = f.directory('topic-active', { run: 'R-2' }), foreign = f.directory('topic-foreign', { run: 'R-1', common: f.scratch });
  const unknown = f.directory('topic-unknown', { run: 'R-99' });
  const other = f.directory('topic-ds3-review', { run: 'R-1' });
  f.runs.push({ id: 'R-2', workspace: f.lane });
  const sweep = f.prepare();
  assert.equal(f.read(sweep).phase, 'planned'); assert.ok(fs.existsSync(owned));
  // An active run prevents all disposal at execution, even for a reported predecessor.
  sweep.execute(); assert.ok(fs.existsSync(owned));
  f.runs.pop();
  const second = f.prepare(); second.execute();
  assert.equal(fs.existsSync(owned), false); assert.equal(fs.existsSync(other), false);
  for (const file of [active, foreign, unknown]) assert.ok(fs.existsSync(file));
  const entry = f.read(second).entries.find(e => e.path === owned);
  assert.equal(entry.owner, 'R-1'); assert.equal(entry.matchedBy, 'run marker'); assert.equal(entry.disposition, 'removed');
  assert.ok(entry.size > 3); assert.match(f.read(second).entries.find(e => e.path === foreign).reason, /another project/);
});

test('longest topic removes owned scratch and keeps the prefix sibling and an undelimited prefix', t => {
  const f = setup(t), own = f.directory('topic-review'), named = f.directory('topic-review-r1');
  const sibling = f.directory('topic-ds3-review'), prefix = f.directory('topical-review'), round = f.directory('topic-review-r2');
  const sweep = f.prepare(); sweep.execute();
  for (const file of [own, named, round]) assert.equal(fs.existsSync(file), false);
  for (const file of [sibling, prefix]) assert.ok(fs.existsSync(file));
  assert.equal(f.read(sweep).entries.find(e => e.path === own).size, 3);
  assert.equal(f.read(sweep).entries.find(e => e.path === round).matchedBy, 'longest topic');
  assert.equal(f.read(sweep).kept_summary.by_reason['longer lane topic owns scratch'], 1);
  assert.deepEqual(f.read(sweep).kept_summary.sample_paths, [sibling]);
  assert.equal(f.read(sweep).entries.some(e => e.path === prefix), false);
});

test('the measured gap name uses longest-topic fallback when its run token is not in the closing lane', t => {
  const f = setup(t), own = f.directory('eng1685-pair-review-r2493');
  const sweep = f.prepare({ topic: 'eng1685-pair', topics: ['eng1685-pair', 'eng1685-pair-ds3'] });
  sweep.execute();
  assert.equal(fs.existsSync(own), false);
  const entry = f.read(sweep).entries.find(e => e.path === own);
  assert.equal(entry.owner, 'eng1685-pair'); assert.equal(entry.matchedBy, 'longest topic');
  assert.equal(entry.disposition, 'removed');
});

test('unmarked same-topic scratch uses the documented project-ambiguous fallback; a foreign marker keeps it', t => {
  const f = setup(t), otherCommon = path.join(f.scratch, 'other-project/.git');
  fs.mkdirSync(otherCommon, { recursive: true });
  // Both scratch creators use topic. Only the marker can distinguish projects.
  const unmarked = f.directory('topic-other-review'), marked = f.directory('topic-marked-review', { topic: 'topic', common: otherCommon });
  const sweep = f.prepare();
  assert.match(f.read(sweep).entries.find(e => e.path === unmarked).reason, /not project-bound; same-topic scratch from another project may match/);
  sweep.execute();
  assert.equal(fs.existsSync(unmarked), false); assert.ok(fs.existsSync(marked));
  assert.match(f.read(sweep).entries.find(e => e.path === unmarked).reason, /removed.*not project-bound/);
  assert.match(f.read(sweep).entries.find(e => e.path === marked).reason, /another project/);
});

for (const late of [false, true]) test(`an open file ${late ? 'appearing after planning' : 'at planning'} keeps its scratch`, t => {
  const f = setup(t), owned = f.directory('topic-review'); let observations = 0;
  const sweep = f.prepare({ readOpenFiles: () => ++observations === 1 && late ? [] : [{ pid: 99, path: path.join(owned, 'payload') }] });
  sweep.execute(); assert.ok(fs.existsSync(owned));
  if (late) assert.match(f.read(sweep).entries[0].reason, /open process handles/);
  else assert.equal(f.read(sweep).kept_summary.by_reason['directory has open process handles'], 1);
});

for (const late of [false, true]) test(`HOLD ${late ? 'appearing after planning' : 'at planning'} keeps everything`, t => {
  const f = setup(t), own = f.directory('topic-review'); let held = !late;
  const sweep = f.prepare({ hold: () => held ? 'HOLD' : null }); held = true;
  sweep.execute(); assert.ok(fs.existsSync(own)); assert.match(f.read(sweep).entries[0].reason, /HOLD/);
});

test('an unmerged lane keeps scratch with the real archive tag', t => {
  const f = setup(t, { merged: false }), own = f.directory('topic-review');
  const command = sweepCommands(f).command;
  const proof = f.retirement({ scratchRoots: [f.root], command }).removeLane({ lane: f.lane, branch: 'lane/topic', gitOnly: true });
  assert.equal(fs.existsSync(f.lane), false); assert.ok(fs.existsSync(own));
  assert.equal(f.git(['rev-parse', `refs/tags/${proof.archiveTag}`]), f.head);
  assert.equal(JSON.parse(fs.readFileSync(proof.scratchManifest)).kept_summary.by_reason['unmerged lane keeps scratch with its archive tag'], 1);
});

for (const kind of ['declared', 'sibling', 'none', 'opt-out']) test(`manifest location follows the ${kind} archive declaration`, t => {
  const f = setup(t); f.directory('topic-review');
  const sibling = path.join(f.scratch, 'archive');
  if (kind !== 'none') fs.mkdirSync(sibling);
  const archive = kind === 'declared' ? path.join(f.scratch, 'durable') : sibling;
  if (kind === 'declared' || kind === 'opt-out') fs.writeFileSync(path.join(f.repo, '.lane.json'),
    JSON.stringify({ archive: { dirs: kind === 'opt-out' ? [] : ['../durable'] } }));
  const sweep = f.prepare();
  assert.ok(sweep.manifest.startsWith(kind === 'none' || kind === 'opt-out' ? path.dirname(f.evidence.directory) : archive));
  assert.ok(fs.existsSync(sweep.manifest)); sweep.execute();
  assert.equal(f.read(sweep).phase, 'complete');
  if (kind === 'none' || kind === 'opt-out') assert.ok(f.warnings.some(warning => /No archive declared/.test(warning)));
});

for (const destination of ['next external', 'Git fallback', 'first external', 'ignored canonical'])
  test(`a guarded close keeps canonical Git clean with the ${destination} archive destination`, t => {
    const f = setup(t), external = path.join(f.scratch, '.org/evidence');
    const tracked = path.join(f.repo, 'docs/reports');
    fs.mkdirSync(tracked, { recursive: true }); fs.writeFileSync(path.join(tracked, 'keep.md'), 'tracked report');
    const dirs = destination === 'next external' ? ['docs/reports', '../.org/evidence'] :
      destination === 'first external' ? ['../.org/evidence', 'docs/reports'] :
      destination === 'ignored canonical' ? ['ignored-archive'] : ['docs/reports'];
    fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ archive: { dirs } }));
    if (destination === 'ignored canonical') fs.writeFileSync(path.join(f.repo, '.gitignore'), '/ignored-archive/\n');
    // Reproduce Brain's local stopgap. Ignoring just lane-sweeps/ must not
    // make docs/reports itself an eligible archive directory.
    fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n/docs/reports/lane-sweeps/\n');
    f.git(['add', '.']); f.git(['commit', '-qm', 'archive declaration']);
    assert.equal(f.git(['status', '--porcelain']), '');
    const own = f.directory('topic-review');
    const proof = f.retirement({ scratchRoots: [f.root], command: sweepCommands(f).command })
      .removeLane({ lane: f.lane, branch: 'lane/topic', gitOnly: true });
    const expected = destination === 'Git fallback' ? path.join(f.common, 'lane-archive/topic') :
      destination === 'ignored canonical' ? path.join(f.repo, 'ignored-archive/lane-sweeps') : path.join(external, 'lane-sweeps');
    assert.ok(proof.scratchManifest.startsWith(expected + path.sep), proof.scratchManifest);
    assert.equal(JSON.parse(fs.readFileSync(proof.scratchManifest)).phase, 'complete');
    assert.equal(fs.existsSync(f.lane), false); assert.equal(fs.existsSync(own), false);
    assert.equal(fs.existsSync(path.join(tracked, 'lane-sweeps')), false);
    assert.equal(f.git(['status', '--porcelain']), '', 'guarded close never dirties the canonical checkout');
  });

test('an archive inside another registered worktree is skipped even when reached through a symlink', t => {
  const f = setup(t), other = path.join(f.scratch, 'other-lane'), link = path.join(f.scratch, 'archive-link');
  f.git(['worktree', 'add', '-b', 'lane/other', other]);
  fs.symlinkSync(other, link);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ archive: { dirs: [link, '../durable'] } }));
  const sweep = f.prepare(); sweep.execute();
  assert.equal(path.dirname(sweep.manifest), path.join(f.scratch, 'durable/lane-sweeps'));
  assert.equal(f.git(['status', '--porcelain'], other), '');
  assert.equal(fs.existsSync(path.join(other, 'lane-sweeps')), false);
});

test('an external archive with lane-sweeps redirected into a tracked checkout uses the Git fallback', t => {
  const f = setup(t), archive = path.join(f.scratch, 'durable'); fs.mkdirSync(archive);
  fs.symlinkSync(f.repo, path.join(archive, 'lane-sweeps'));
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ archive: { dirs: ['../durable'] } }));
  const sweep = f.prepare(); sweep.execute();
  assert.ok(sweep.manifest.startsWith(path.join(f.common, 'lane-archive/topic') + path.sep));
  assert.deepEqual(fs.readdirSync(f.repo).filter(name => name.endsWith('.json')), ['.lane.json']);
});

test('an ignored archive inside the closing lane still falls back and keeps scratch', t => {
  const f = setup(t), own = f.directory('topic-review');
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n/ignored-archive/\n');
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ archive: { dirs: [path.join(f.lane, 'ignored-archive')] } }));
  const sweep = f.prepare(); sweep.execute();
  assert.ok(sweep.manifest.startsWith(path.join(f.common, 'lane-archive/topic') + path.sep));
  assert.ok(fs.existsSync(own)); assert.equal(fs.existsSync(path.join(f.lane, 'ignored-archive')), false);
  assert.match(f.read(sweep).warnings.join('\n'), /archive is inside closing lane/);
});

for (const failed of ['worktree', 'check-ignore']) test(`an unavailable archive ${failed} observation keeps scratch in the fallback`, t => {
  const f = setup(t), own = f.directory('topic-review');
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ archive: { dirs: ['docs/reports', '../durable'] } }));
  const command = sweepCommands(f).command;
  const sweep = f.prepare({ command: (exe, args, options) => args.includes(failed)
    ? { status: 128, stderr: 'injected Git observation failure', stdout: '' } : command(exe, args, options) });
  sweep.execute(); assert.ok(fs.existsSync(own));
  assert.ok(sweep.manifest.startsWith(path.join(f.common, 'lane-archive/topic') + path.sep));
  assert.match(f.read(sweep).warnings.join('\n'), /archive .* unavailable/);
});

test('a guarded close over 3000 ordinary kept entries stays below 64 KiB with exact counts and full failure details', t => {
  const f = setup(t), siblings = new Set();
  f.git(['branch', 'lane/topic-ds3']);
  for (let i = 0; i < 3000; i++) siblings.add(f.directory(`topic-ds3-review-${i}`));
  const removed = f.directory('topic-review'), invalid = f.directory('topic-invalid'),
    foreign = f.directory('topic-foreign', { run: 'R-1', common: f.scratch }), live = f.directory('topic-live');
  fs.writeFileSync(path.join(invalid, SCRATCH_OWNER_FILE), '{'); fs.writeFileSync(path.join(live, '.local-live'), '');
  const proof = f.retirement({ scratchRoots: [f.root], command: sweepCommands(f).command })
    .removeLane({ lane: f.lane, branch: 'lane/topic', gitOnly: true });
  const manifest = JSON.parse(fs.readFileSync(proof.scratchManifest));
  assert.ok(fs.statSync(proof.scratchManifest).size < 64 * 1024);
  assert.equal(manifest.schema, 'lane-scratch-sweep/v1'); assert.equal(manifest.phase, 'complete');
  assert.deepEqual(manifest.counts, { total: 3004, kept: 3003, removed: 1 });
  assert.equal(manifest.kept_summary.count, 3000);
  assert.deepEqual(manifest.kept_summary.by_reason, { 'longer lane topic owns scratch': 3000 });
  const sample = manifest.kept_summary.sample_paths;
  assert.equal(sample.length, 16); assert.ok(sample.every(file => siblings.has(file)));
  assert.ok(Buffer.byteLength(sample.map(file => JSON.stringify(file)).join('')) <= 4096);
  assert.deepEqual(new Set(manifest.entries.map(entry => entry.path)), new Set([removed, invalid, foreign, live]));
  for (const [file, reason] of [[invalid, /ownership observation failed/], [foreign, /another project/], [live, /protected live scratch/]]) {
    const entry = manifest.entries.find(entry => entry.path === file);
    assert.equal(entry.disposition, 'kept'); assert.match(entry.reason, reason);
    for (const field of ['owner', 'matchedBy', 'size']) assert.ok(Object.hasOwn(entry, field));
    assert.ok(fs.existsSync(file));
  }
  const entry = manifest.entries.find(entry => entry.path === removed);
  assert.equal(entry.disposition, 'removed'); assert.equal(entry.size, 3); assert.equal(fs.existsSync(removed), false);
  assert.ok([...siblings].every(file => fs.existsSync(file)));
});

for (const failure of ['inventory', 'marker', 'archive', 'changed', 'new-topic', 'record']) test(`${failure} observation failure keeps scratch`, t => {
  const f = setup(t), own = f.directory('topic-review', failure === 'marker' ? { run: 'R-1' } : undefined);
  if (failure === 'marker') fs.writeFileSync(path.join(own, SCRATCH_OWNER_FILE), '{');
  if (failure === 'archive') fs.writeFileSync(path.join(f.repo, '.lane.json'), '{');
  const sweep = f.prepare({
    ...(failure === 'inventory' ? { readOpenFiles: () => { throw Error('unreadable process inventory'); } } : {}),
    ...(failure === 'record' ? { readOwnership: () => { throw Error('record unavailable'); } } : {}),
    ...(failure === 'new-topic' ? { readOwnership: () => ({ runs: f.runs, topics: ['topic', 'topic-review'] }) } : {}),
  });
  if (failure === 'changed') fs.appendFileSync(path.join(own, 'payload'), 'changed');
  sweep.execute(); assert.ok(fs.existsSync(own));
  assert.equal(f.read(sweep).entries.find(e => e.path === own).disposition, 'kept');
});

test('external report evidence warns without refusing lane removal and keeps the cited payload', t => {
  const f = setup(t), own = f.directory('topic-review');
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ archive: { dirs: ['../durable'] } }));
  f.runs[0].report.artifacts = [path.join(own, 'payload'), path.join(f.lane, 'seed'), path.join(f.scratch, 'durable/result')];
  const sweep = f.prepare(); sweep.execute();
  assert.ok(fs.existsSync(own)); assert.equal(f.warnings.filter(w => /cites evidence outside/.test(w)).length, 1);
  assert.equal(f.read(sweep).kept_summary.by_reason['scratch contains report evidence outside the archive'], 1);
});

test('an archive write failure falls back to lane evidence and keeps scratch', t => {
  const f = setup(t), own = f.directory('topic-review'), archive = path.join(f.scratch, 'durable');
  fs.mkdirSync(archive); fs.writeFileSync(path.join(archive, 'lane-sweeps'), 'occupied');
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ archive: { dirs: ['../durable'] } }));
  const sweep = f.prepare(); sweep.execute();
  assert.ok(sweep.manifest.startsWith(path.dirname(f.evidence.directory))); assert.ok(fs.existsSync(own));
  assert.ok(f.read(sweep).warnings.some(warning => warning.includes('Declared archive manifest unavailable')));
});

test('symlinks are not followed and protected live scratch is kept', t => {
  const f = setup(t), target = path.join(f.scratch, 'target'); fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'unique'), 'keep');
  fs.symlinkSync(target, path.join(f.root, 'topic-link'));
  const live = f.directory('topic-live'); fs.writeFileSync(path.join(live, '.local-live'), '');
  const own = f.directory('topic-review'); fs.symlinkSync(target, path.join(own, 'link'));
  const sweep = f.prepare(); sweep.execute();
  assert.equal(fs.readFileSync(path.join(target, 'unique'), 'utf8'), 'keep'); assert.ok(fs.existsSync(live));
  assert.ok(fs.lstatSync(path.join(f.root, 'topic-link')).isSymbolicLink()); assert.equal(fs.existsSync(own), false);
});

for (const change of ['HOLD', 'marker', 'contents']) test(`a final ${change} change after the persisted removal intent keeps scratch`, t => {
  const f = setup(t), own = f.directory('topic-review', { run: 'R-1' }); let calls = 0, held = false;
  const sweep = f.prepare({ guard: () => {
    if (++calls !== 3) return;
    if (change === 'HOLD') held = true;
    if (change === 'marker') fs.writeFileSync(path.join(own, SCRATCH_OWNER_FILE), '{}');
    if (change === 'contents') fs.appendFileSync(path.join(own, 'payload'), 'new');
  }, hold: () => held ? 'HOLD' : null });
  sweep.execute(); assert.ok(fs.existsSync(own)); assert.equal(f.read(sweep).entries[0].disposition, 'kept');
});

test('guarded removal writes its manifest before Git removes the lane and warns on stderr', t => {
  const f = setup(t), own = f.directory('topic-review', { run: 'R-1' });
  fs.mkdirSync(path.join(f.scratch, 'archive'));
  const events = fs.readFileSync(f.eventFile, 'utf8').trim().split('\n').map(JSON.parse);
  events.find(e => e.type === 'report.ingested').report.artifacts = [path.join(f.scratch, 'outside-evidence')];
  fs.writeFileSync(f.eventFile, events.map(event => JSON.stringify(event) + '\n').join(''));
  const stderr = [];
  t.mock.method(process.stderr, 'write', message => { stderr.push(String(message)); return true; });
  const command = sweepCommands(f).command; let manifest;
  const retirement = f.retirement({ scratchRoots: [f.root], command: (exe, args, options) => {
    if (exe === '/usr/sbin/lsof' && args.includes('-Fpfn0')) return { status: 0, stderr: '', stdout: `p${process.pid}\0fcwd\0n${f.repo}\0\n` };
    if (exe === 'git' && args[2] === 'worktree' && args[3] === 'remove') {
      assert.ok(fs.existsSync(manifest)); assert.ok(fs.existsSync(own));
      assert.equal(JSON.parse(fs.readFileSync(manifest)).phase, 'planned');
    }
    return command(exe, args, options);
  }, log: row => { if (row.action === 'scratch-manifest') manifest = row.manifest; } });
  const proof = retirement.removeLane({ lane: f.lane, branch: 'lane/topic', gitOnly: true });
  assert.equal(fs.existsSync(f.lane), false); assert.equal(fs.existsSync(own), false);
  assert.equal(proof.scratchManifest, manifest); assert.ok(manifest.startsWith(path.join(f.scratch, 'archive')));
  assert.equal(JSON.parse(fs.readFileSync(manifest)).entries[0].disposition, 'removed');
  assert.ok(stderr.some(message => message.includes('cites evidence outside the archive and lane')));
  assert.ok(JSON.parse(fs.readFileSync(manifest)).warnings.some(message => message.includes('outside-evidence')));
});

for (const archive of [true, false]) for (const refusal of ['HOLD', 'deadline'])
  test(`post-prepare ${refusal} retries bound ${archive ? 'archive' : 'fallback'} manifests after discarding duplicate evidence`, t => {
    const f = setup(t), own = f.directory('topic-review');
    if (archive) fs.mkdirSync(path.join(f.scratch, 'archive'));
    let now = Date.now(); const start = now, deadline = start + 120000;
    t.mock.method(Date, 'now', () => now);
    const manifests = [], proofs = [], retained = [];
    const retirement = f.retirement({ scratchRoots: [f.root], command: sweepCommands(f).command, deadline, log: row => {
      if (row.action === 'lane-preflight') proofs.push(row.evidence);
      if (row.action === 'scratch-attempt-discarded' && row.retained) retained.push(row.manifest);
      if (row.action !== 'scratch-manifest') return;
      manifests.push(row.manifest);
      assert.equal(JSON.parse(fs.readFileSync(row.manifest)).phase, 'planned');
      if (refusal === 'HOLD') hold(f);
      else now = deadline;
    } });
    for (let attempt = 0; attempt < 3; attempt++) {
      now = start;
      fs.rmSync(path.join(f.repo, '.lane/supervisor/HOLD-WORKER-TAB-CLOSE'), { force: true });
      assert.throws(() => retirement.removeLane({ lane: f.lane, branch: 'lane/topic', gitOnly: true }),
        refusal === 'HOLD' ? /retirement held/ : { code: 'RETIREMENT_DEADLINE' });
      assert.ok(fs.existsSync(f.lane)); assert.ok(fs.existsSync(own));
      assert.equal(f.git(['rev-parse', 'refs/heads/lane/topic']), f.head);
      const directory = path.dirname(manifests.at(-1));
      const remaining = fs.readdirSync(directory).filter(name => name.endsWith('.json'));
      assert.equal(remaining.length, archive ? 1 : 0, 'refused retries do not accumulate orphan manifests');
      for (const name of remaining) assert.equal(JSON.parse(fs.readFileSync(path.join(directory, name))).phase, 'not-executed');
    }
    assert.equal(manifests.length, 3); assert.equal(new Set(manifests).size, 3);
    for (const manifest of manifests) assert.equal(fs.existsSync(manifest), false);
    assert.equal(new Set(retained).size, archive ? 1 : 0);
    for (const manifest of new Set(retained)) {
      const data = JSON.parse(fs.readFileSync(manifest));
      assert.equal(data.phase, 'not-executed'); assert.ok(data.completed_at);
      assert.match(data.reason, refusal === 'HOLD' ? /retirement held/ : /deadline/i);
      const entry = data.entries.find(e => e.path === own);
      assert.equal(entry.disposition, 'kept'); assert.match(entry.reason, /lane removal not completed/);
      assert.doesNotMatch(entry.reason, /awaiting final/);
    }
    assert.equal(proofs.length, 3);
    for (const proof of proofs) assert.equal(fs.existsSync(proof.directory), false, 'duplicate evidence is still discarded');
    assert.equal(f.herdrCalls().some(args => args[0] === 'workspace' && args[1] === 'close'), false);
  });

for (const integrated of [true, false]) test(`branch deletion failure recovers through the same sweep for an ${integrated ? 'integrated' : 'unmerged'} lane`, t => {
  const f = setup(t, { merged: integrated }), own = f.directory('topic-review', { run: 'R-1' });
  const logs = [], command = sweepCommands(f).command; let refuse = true;
  const retirement = f.retirement({ scratchRoots: [f.root], command: (exe, args, options) => {
    if (exe === 'git' && args[2] === 'branch' && args[3] === '-D' && refuse) {
      refuse = false;
      return { status: 1, stdout: '', stderr: 'injected branch deletion refusal' };
    }
    return command(exe, args, options);
  }, log: row => logs.push(row) });
  assert.throws(() => retirement.removeLane({ lane: f.lane, branch: 'lane/topic', gitOnly: true }), /branch deletion refusal/);
  const { action, ...proof } = logs.find(row => row.action === 'lane-preflight');
  assert.equal(fs.existsSync(f.lane), false); assert.ok(fs.existsSync(own));
  assert.equal(f.git(['rev-parse', 'refs/heads/lane/topic']), f.head);
  assert.equal(JSON.parse(fs.readFileSync(proof.scratchManifest)).phase, 'not-executed');
  assert.ok(fs.existsSync(proof.evidence.directory), 'partial removal retains its recovery evidence');
  const resumed = retirement.resumeLaneRemoval(proof);
  assert.equal(f.git(['branch', '--list', 'lane/topic']), ''); assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).workspaces, []);
  assert.equal(fs.existsSync(own), !integrated);
  assert.notEqual(resumed.scratchManifest, proof.scratchManifest);
  const manifest = JSON.parse(fs.readFileSync(resumed.scratchManifest));
  assert.equal(manifest.phase, 'complete');
  assert.deepEqual(manifest.recovery, { manifest: proof.scratchManifest, evidence: proof.evidence });
  if (integrated) {
    const entry = manifest.entries.find(entry => entry.path === own);
    assert.equal(entry.disposition, 'removed'); assert.match(entry.reason, /owned scratch removed/);
  } else {
    assert.equal(manifest.kept_summary.by_reason['unmerged lane keeps scratch with its archive tag'], 1);
    assert.deepEqual(manifest.kept_summary.sample_paths, [own]);
  }
  const preparation = logs.findIndex(row => row.action === 'scratch-manifest' && row.manifest === resumed.scratchManifest);
  const removal = logs.findIndex(row => row.action === 'lane-removed' && row.reconciled);
  assert.ok(preparation < removal, 'recovery writes its manifest before removal completes');
  assert.equal(logs[removal].scratchManifest, resumed.scratchManifest);
});

for (const [failAt, phase] of [[1, 'intent'], [2, 'outcome'], [3, 'completion']])
  test(`a manifest made unwritable at ${phase} warns and logs while workspace closure still completes`, t => {
    const f = setup(t), own = f.directory('topic-review', { run: 'R-1' });
    fs.mkdirSync(path.join(f.scratch, 'archive'));
    const stderr = [], logs = []; let manifest, writes = 0;
    t.mock.method(process.stderr, 'write', message => { stderr.push(String(message)); return true; });
    const open = fs.openSync;
    t.mock.method(fs, 'openSync', (file, flags, ...rest) => {
      if (manifest && typeof file === 'string' && file.startsWith(manifest + '.') && flags === 'wx' && ++writes >= failAt)
        throw Object.assign(Error('injected archive write failure'), { code: 'EACCES' });
      return open(file, flags, ...rest);
    });
    const retirement = f.retirement({ scratchRoots: [f.root], command: sweepCommands(f).command, log: row => {
      logs.push(row); if (row.action === 'scratch-manifest') manifest = row.manifest;
    } });
    const proof = retirement.removeLane({ lane: f.lane, branch: 'lane/topic', gitOnly: true });
    assert.equal(fs.existsSync(f.lane), false); assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
    assert.deepEqual(proof.pending, []); assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).workspaces, []);
    assert.ok(f.herdrCalls().some(args => args[0] === 'workspace' && args[1] === 'close'));
    assert.equal(fs.existsSync(own), failAt === 1, 'unlink requires a durably written intent');
    assert.ok(stderr.some(message => /Sweep manifest.*update failed.*injected archive write failure/.test(message)));
    const errors = logs.filter(row => row.action === 'scratch-manifest-error');
    assert.ok(errors.length); assert.ok(errors.every(row => row.why === 'injected archive write failure'));
    assert.deepEqual(errors.at(-1).removed, failAt === 1 ? [] : [own], 'the log retains actual removal evidence');
    assert.deepEqual(fs.readdirSync(path.dirname(manifest)), [path.basename(manifest)], 'failed writes leave no temporary manifests');
  });

test('the guarded closer honors the real HOLD file before sweeping', t => {
  const f = setup(t), own = f.directory('topic-review'); hold(f);
  assert.throws(() => f.retirement({ scratchRoots: [f.root] }).removeLane({ lane: f.lane, branch: 'lane/topic' }), /retirement held/);
  assert.ok(fs.existsSync(own)); assert.ok(fs.existsSync(f.lane));
});

test('open file inventory includes ordinary descriptors and refuses incomplete observations', t => {
  const f = setup(t), own = f.directory('topic-review');
  const stdout = `p${process.pid}\0fcwd\0n${f.repo}\0\np99\0f7\0n${own}/payload\0\nf8\0nPIPE\0\nf9\0n${own}/unlinked\0\n`;
  const refs = readProcessFileReferences({ platform: 'darwin', command: () => ({ status: 0, stderr: '', stdout }) });
  assert.ok(refs.some(ref => ref.pid === 99 && ref.path === `${own}/payload`));
  assert.ok(refs.some(ref => ref.pid === 99 && ref.path === `${own}/unlinked`), 'unlinked open paths still protect their directory');
  for (const output of [stdout.replace(`fcwd\0n${f.repo}\0`, ''), stdout.slice(0, -1), 'p99\0n/bad\0\n'])
    assert.throws(() => readProcessFileReferences({ platform: 'darwin', command: () => ({ status: 0, stderr: '', stdout: output }) }));
  assert.throws(() => readProcessFileReferences({ platform: 'darwin', command: () => ({ status: 1, stderr: 'denied' }) }), /unavailable/);
});

test('directory entries bound the root scan while arbitrary-name ownership markers remain discoverable', t => {
  const f = setup(t), owned = f.directory('arbitrary', { run: 'R-1' });
  const foreign = Array.from({ length: 16 }, (_, i) => f.directory(`foreign-${i}`));
  const file = path.join(f.root, 'topic-file'), link = path.join(f.root, 'topic-link');
  fs.writeFileSync(file, 'keep'); fs.symlinkSync(owned, link);
  const alias = path.join(f.scratch, 'root-alias'); fs.symlinkSync(f.root, alias);
  const readdir = fs.readdirSync, lstat = fs.lstatSync, scanned = [], markerReads = [], topLevelStats = [];
  t.mock.method(fs, 'readdirSync', (directory, options) => {
    if (directory === f.root) { scanned.push(directory); assert.deepEqual(options, { withFileTypes: true }); }
    return readdir(directory, options);
  });
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (path.basename(file) === SCRATCH_OWNER_FILE) markerReads.push(path.dirname(file));
    if (path.dirname(file) === f.root) topLevelStats.push(file);
    return lstat(file, ...args);
  });
  const sweep = f.prepare({ roots: [f.root, alias] });
  assert.deepEqual(scanned, [f.root], 'root aliases are scanned once');
  assert.deepEqual(new Set(markerReads), new Set([owned, ...foreign]), 'every directory is checked for a marker');
  assert.deepEqual(topLevelStats, [owned], 'only owned scratch is statted for its content proof');
  sweep.execute();
  assert.equal(fs.existsSync(owned), false); assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
  assert.ok(fs.lstatSync(link).isSymbolicLink()); assert.ok(foreign.every(directory => fs.existsSync(directory)));
});

for (const stage of ['planning', 'execution']) test(`a directory replaced by a symlink at ${stage} is kept`, t => {
  const f = setup(t), owned = f.directory('arbitrary', { run: 'R-1' }), target = path.join(f.scratch, 'target');
  const replace = () => { fs.renameSync(owned, target); fs.symlinkSync(target, owned); };
  if (stage === 'planning') {
    const readdir = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (directory, options) => {
      const children = readdir(directory, options);
      if (directory === f.root) replace();
      return children;
    });
  }
  const sweep = f.prepare();
  if (stage === 'execution') replace();
  sweep.execute();
  assert.ok(fs.lstatSync(owned).isSymbolicLink()); assert.equal(fs.readFileSync(path.join(target, 'payload'), 'utf8'), 'abc');
  assert.match(f.read(sweep).entries[0].reason, /scratch root is not a directory/);
});

test('planning inventories only final candidates and execution rechecks each candidate separately', t => {
  const f = setup(t), owned = f.directory('topic-review'), marked = f.directory('arbitrary', { run: 'R-1' });
  f.directory('topic-ds3-review'); f.directory('topic-foreign', { common: f.scratch, topic: 'topic' });
  const cited = f.directory('topic-evidence'), live = f.directory('topic-live');
  f.runs[0].report.artifacts = [path.join(cited, 'payload')]; fs.writeFileSync(path.join(live, '.local-live'), '');
  const calls = [];
  const sweep = f.prepare({ readOpenFiles: directories => { calls.push(directories); return []; } });
  assert.equal(calls.length, 1); assert.deepEqual(new Set(calls[0]), new Set([owned, marked]));
  sweep.execute();
  assert.deepEqual(calls.slice(1), [[marked], [owned]], 'each final check gets only its own tree');
  assert.equal(fs.existsSync(owned), false); assert.equal(fs.existsSync(marked), false);
  assert.ok(fs.existsSync(cited)); assert.ok(fs.existsSync(live));
});

test('the default scratch inventory requires one full numeric observation at planning and removal', t => {
  const f = setup(t), owned = f.directory('topic-review'), native = sweepCommands(f);
  f.directory('unrelated');
  const sweep = f.prepare({ readOpenFiles: undefined, command: native.command }); sweep.execute();
  const calls = native.calls.filter(call => call.exe === '/usr/sbin/lsof');
  assert.equal(calls.length, process.platform === 'darwin' ? 2 : 0);
  for (const call of calls)
    assert.deepEqual(call.args, ['-n', '-P', '-a', '-u', String(process.getuid()), '-Fpfn0']);
});

test('complete macOS inventory returns candidate paths including unlinked files with a caller cwd anchor', t => {
  const f = setup(t), owned = f.directory('arbitrary', { run: 'R-1' }), second = f.directory('topic-review');
  const stdout = `p${process.pid}\0fcwd\0n${f.repo}\0\np99\0f7\0n${owned}/nested/payload\0\nf8\0n${owned}/unlinked\0\n` +
    `f9\0nPIPE\0\nf10\0n/elsewhere\0\nf11\0n(revoked)\0\nf12\0n${owned}-sibling/payload\0\n` +
    `f13\0n${owned}/vnode: filename\0\nf14\0n${owned}/no more information\0\n`;
  const calls = [], env = { TEST: 'complete' };
  const command = (exe, args, options) => {
    calls.push({ exe, args, options });
    return { status: 0, stderr: '', stdout };
  };
  const refs = readProcessFileReferences({ platform: 'darwin', env, directories: [owned, second, owned], command });
  assert.equal(calls.length, 1, 'no redundant selected query or per-candidate native command');
  assert.deepEqual(calls[0].args, ['-n', '-P', '-a', '-u', String(process.getuid()), '-Fpfn0']);
  for (const call of calls) {
    assert.equal(call.exe, '/usr/sbin/lsof'); assert.equal(call.options.env, env);
    assert.ok(call.options.timeout >= 10000);
  }
  assert.ok(refs.some(ref => ref.path === `${owned}/nested/payload`));
  assert.ok(refs.some(ref => ref.path === `${owned}/unlinked`));
  assert.ok(refs.some(ref => ref.path === `${owned}/vnode: filename`), 'absolute paths are not native error names');
  assert.ok(refs.some(ref => ref.path === `${owned}/no more information`));
  assert.ok(refs.every(ref => ref.path.startsWith(owned + path.sep)), 'unrelated paths and prefix siblings are not returned');
  assert.deepEqual(readProcessFileReferences({ platform: 'darwin', directories: [], command }), []);
  assert.equal(calls.length, 1, 'no candidate means no process inventory');
  for (const directories of [null, 'relative', ['relative'], [owned + '\0']])
    assert.throws(() => readProcessFileReferences({ platform: 'darwin', directories, command }), /invalid/);
});

for (const stage of ['planning', 'execution'])
  for (const failure of ['cwd', 'descriptor', 'fileport', 'mapping', 'thread', 'vnode-denied', 'vnode-error', 'vnode-fileport',
    'timeout', 'signal', 'stderr', 'exit', 'anchor', 'truncated'])
    test(`an unfiltered macOS ${failure} failure hidden by selection keeps scratch at ${stage}`, t => {
      const f = setup(t), owned = f.directory('arbitrary', { run: 'R-1' });
      const anchor = `p${process.pid}\0fcwd\0n${f.repo}\0\n`, calls = [];
      let observations = 0;
      const command = (exe, args) => {
        assert.equal(exe, '/usr/sbin/lsof'); calls.push(args);
        // Native path/link-count selection discards the unreadable process:
        // only the valid caller remains, with empty stderr and status 1.
        // The amended observer avoids that query and always reads full output.
        if (args.includes('+D') || args.includes('+L1') || args.includes('-d'))
          return { status: 1, stderr: '', stdout: anchor };
        assert.deepEqual(args, ['-n', '-P', '-a', '-u', String(process.getuid()), '-Fpfn0']);
        const result = { status: 0, stderr: '', stdout: anchor };
        if (++observations === 1 && stage === 'execution') return result;
        if (failure === 'cwd') result.stdout += 'p99\0fcwd\0ncwd|rtd info error: Permission denied\0\n';
        if (failure === 'descriptor') result.stdout += 'p99\0ferr\0nFD info error: Permission denied\0\n';
        if (failure === 'fileport') result.stdout += 'p99\0ferr\0nFILEPORT info error: Permission denied\0\n';
        if (failure === 'mapping') result.stdout += 'p99\0ftxt\0nregion info error: Permission denied\0\n';
        if (failure === 'thread') result.stdout += 'p99\0ftwd\0nthread info error: Permission denied\0\n';
        if (failure === 'vnode-denied') result.stdout += 'p99\0f7\0nno more information\0\n';
        if (failure === 'vnode-error') result.stdout += 'p99\0f7\0nvnode: Input/output error\0\n';
        if (failure === 'vnode-fileport') result.stdout += 'p99\0f8\0nvnode: Permission denied\0\n';
        if (failure === 'timeout') { result.status = null; result.error = Object.assign(Error('timed out'), { code: 'ETIMEDOUT' }); }
        if (failure === 'signal') result.signal = 'SIGKILL';
        if (failure === 'stderr') result.stderr = 'partial observation';
        if (failure === 'exit') result.status = 1;
        if (failure === 'anchor') result.stdout = 'p99\0fcwd\0n/elsewhere\0\n';
        if (failure === 'truncated') result.stdout = anchor.slice(0, -2);
        return result;
      };
      const sweep = f.prepare({ readOpenFiles: directories => readProcessFileReferences({ platform: 'darwin', directories, command }) });
      sweep.execute();
      assert.equal(observations, stage === 'planning' ? 1 : 2, 'every planning/final check needs its own completeness observation');
      assert.equal(calls.length, observations, 'selected output never substitutes for the full observation');
      assert.ok(calls.every(args => !args.includes('+D')));
      assert.ok(fs.existsSync(owned)); assert.equal(fs.readFileSync(path.join(owned, 'payload'), 'utf8'), 'abc');
      assert.match(f.read(sweep).entries[0].reason, /(?:observation failed|scratch kept)/);
    });

test('a candidate handle omitted by native path selection still keeps scratch through the full observation', t => {
  const f = setup(t), owned = f.directory('topic-review'), calls = [];
  const sweep = f.prepare({ readOpenFiles: directories => readProcessFileReferences({ platform: 'darwin', directories,
    command: (exe, args) => {
      calls.push(args);
      const anchor = `p${process.pid}\0fcwd\0n${f.repo}\0\n`;
      return args.includes('+D') ? { status: 1, stderr: '', stdout: anchor }
        : { status: 0, stderr: '', stdout: anchor + `p99\0f7\0n${owned}/payload\0\n` };
    } }) });
  sweep.execute(); assert.equal(calls.length, 1); assert.ok(fs.existsSync(owned));
  assert.deepEqual(calls[0], ['-n', '-P', '-a', '-u', String(process.getuid()), '-Fpfn0']);
  assert.equal(f.read(sweep).kept_summary.by_reason['directory has open process handles'], 1);
});

test('symlink inodes retain the full numeric macOS inventory, including directly opened links', t => {
  const f = setup(t), owned = f.directory('topic-review'), nested = path.join(owned, 'nested');
  fs.mkdirSync(nested); const link = path.join(nested, 'link'); fs.symlinkSync(path.join(owned, 'payload'), link);
  const calls = [];
  const sweep = f.prepare({ readOpenFiles: directories => readProcessFileReferences({ platform: 'darwin', directories,
    command: (exe, args) => { calls.push(args); return { status: 0, stderr: '',
      stdout: `p${process.pid}\0fcwd\0n${f.repo}\0\np99\0f7\0n${link}\0\n` }; } }) });
  sweep.execute(); assert.ok(fs.existsSync(owned)); assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.deepEqual(calls, [['-n', '-P', '-a', '-u', String(process.getuid()), '-Fpfn0']]);
  assert.equal(f.read(sweep).kept_summary.by_reason['directory has open process handles'], 1);
  assert.throws(() => readProcessFileReferences({ platform: 'darwin', directories: [owned],
    command: () => ({ status: 1, stderr: '', stdout: `p${process.pid}\0fcwd\0n${f.repo}\0\n` }) }), /unavailable/);
});

for (const failure of ['timeout', 'signal', 'stderr', 'exit', 'anchor', 'truncated', 'identity', 'dangling-fd', 'dangling-process', 'unknown-field', 'error-fd', 'cwd-path'])
  test(`complete macOS ${failure} observation keeps scratch`, t => {
    const f = setup(t), owned = f.directory('topic-review');
    const stdout = `p${process.pid}\0fcwd\0n${f.repo}\0\n`;
    const result = { status: 0, stderr: '', stdout };
    if (failure === 'timeout') result.error = Object.assign(Error('timed out'), { code: 'ETIMEDOUT' });
    if (failure === 'signal') result.signal = 'SIGKILL';
    if (failure === 'stderr') result.stderr = 'partial observation';
    if (failure === 'exit') result.status = 1;
    if (failure === 'anchor') result.stdout = 'p99\0f7\0n/elsewhere\0\n';
    if (failure === 'truncated') result.stdout = stdout.slice(0, -2);
    if (failure === 'identity') result.stdout += 'p99\0n/elsewhere\0\n';
    if (failure === 'dangling-fd') result.stdout += 'p99\0f7\0\n';
    if (failure === 'dangling-process') result.stdout += 'p99\0\n';
    if (failure === 'unknown-field') result.stdout += 'incomplete\0\n';
    if (failure === 'error-fd') result.stdout += 'p99\0ferr\0n/private/unavailable\0\n';
    if (failure === 'cwd-path') result.stdout += 'p99\0fcwd\0n(unavailable)\0\n';
    const sweep = f.prepare({ readOpenFiles: directories => readProcessFileReferences({ platform: 'darwin', directories, command: () => result }) });
    sweep.execute(); assert.ok(fs.existsSync(owned)); assert.match(f.read(sweep).entries[0].reason, /observation failed/);
  });

test('a timed-out full final inventory keeps scratch after a successful planning observation', t => {
  const f = setup(t), owned = f.directory('topic-review'); let calls = 0, observations = 0;
  const sweep = f.prepare({ readOpenFiles: directories => readProcessFileReferences({ platform: 'darwin', directories,
    command: (exe, args) => {
      calls++;
      assert.deepEqual(args, ['-n', '-P', '-a', '-u', String(process.getuid()), '-Fpfn0']);
      return ++observations === 1 ? { status: 0, stderr: '', stdout: `p${process.pid}\0fcwd\0n${f.repo}\0\n` }
        : { status: null, error: Error('timed out') };
    } }) });
  sweep.execute(); assert.equal(calls, 2); assert.equal(observations, 2); assert.ok(fs.existsSync(owned));
  assert.match(f.read(sweep).entries[0].reason, /scratch kept: open file source unavailable.*timed out/);
});

test('the shared archive helper honors layer-relative paths and whole-value overrides', t => {
  const f = setup(t), file = path.join(f.scratch, 'selected.json');
  fs.writeFileSync(file, JSON.stringify({ archive: { dirs: ['saved'] } }));
  const result = discoverArchive({ cwd: f.repo, project: { canonical: f.repo }, env: { ...f.env, LANE_CONFIG: file } });
  assert.deepEqual(result.dirs, [path.join(f.scratch, 'saved')]);
});
