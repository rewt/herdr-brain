import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setupOrg, BIN } from './helpers.mjs';
import { fixtureFleet } from './helpers/offline-herdr.mjs';
import { transact } from '../lib/store.mjs';
import { measureLifecycle } from '../measurement/lifecycle.mjs';
import { queueFor, enqueue } from '../promote/promote.mjs';

function fixture(t) {
  const f = setupOrg();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  fixtureFleet(t, f.root);
  assert.equal(spawnSync('git', ['init', f.root], { encoding: 'utf8' }).status, 0);
  const project = fs.realpathSync(path.join(f.root, '.git'));
  transact(f.dir, () => ({ add: [
    {type: 'item.added', id: 'ENG-1', title: 'Fixture'},
    {type: 'run.started', id: 'R-1', item: 'ENG-1', meta: {dispatch_project: project}},
    {type: 'run.started', id: 'R-2', item: 'ENG-1', meta: {dispatch_project: '/other/.git'}},
    {type: 'run.started', id: 'R-3', item: 'ENG-1'}
  ] }), {at: new Date('2026-09-15T08:00:00Z'), actor: 'fixture'});
  const argv = ['nudge', '--id', 'test:one', '--run', 'R-1', '--project', project, '--actor', 'helper',
    '--occurred-at', '2026-09-15T08:30:00Z', '--stage', 'report', '--action', 'Prompted worker to finish report',
    '--reason', 'Report stalled', '--evidence', 'fixture:prompt'];
  const env = {ORG_ACTOR: 'nudge-owner'};
  return {...f, project, argv, env};
}

test('nudge refuses wrong scope and malformed input, then recovers with one attributed append and stable retry', t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.dir, 'events.jsonl'));
  for (const [key, value] of [['--run', 'R-2'], ['--run', 'R-3'], ['--run', 'R-99'],
    ['--project', f.root], ['--occurred-at', '2026-09-15'], ['--occurred-at', '2026-09-15T07:00:00Z'],
    ['--occurred-at', '2026-09-16T08:00:00Z'], ['--reason', '  '], ['--actor', ' '], ['--id', 'bad id']]) {
    const args = [...f.argv]; args[args.indexOf(key) + 1] = value;
    assert.equal(f.org(args, {env: f.env}).code, 1);
    assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.jsonl')), before);
  }
  assert.deepEqual(f.json(f.argv, {env: f.env}), {recorded: true, reused: false});
  const event = f.events().at(-1), bytes = fs.readFileSync(path.join(f.dir, 'events.jsonl'));
  assert.equal(event.type, 'lifecycle.manual-nudge');
  assert.equal(event.by, 'nudge-owner'); assert.equal(event.actor, 'helper');
  assert.equal(event.item, 'ENG-1'); assert.equal(event.project, f.project);
  assert.equal(event.occurred_at, '2026-09-15T08:30:00.000Z');
  assert.deepEqual(bytes.subarray(0, before.length), before);
  assert.equal(f.json(f.argv, {env: f.env, now: '2026-09-15T10:00:00Z'}).reused, true);
  const changed = [...f.argv]; changed[changed.indexOf('--reason') + 1] = 'Different intervention';
  assert.match(f.fail(changed, {env: f.env}), /different content/);
  changed[changed.indexOf('--reason') + 1] = 'Report stalled';
  changed[changed.indexOf('--actor') + 1] = 'other-helper';
  assert.match(f.fail(changed, {env: f.env}), /different content/);
  assert.equal(f.json(f.argv, {env: {ORG_ACTOR: 'other-recorder'}}).event.by, 'nudge-owner');
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.jsonl')), bytes);
  const measured = measureLifecycle({events: f.events(), project: f.project,
    from: '2026-09-15T08:00:00Z', cutoff: '2026-09-15T10:00:00Z'});
  assert.equal(measured.hand_nudges.recorded, 1); assert.equal(measured.hand_nudges.total, null);
  assert.equal(measured.hand_nudges.journal[0].evidence, 'fixture:prompt');
});

test('concurrent stable-ID retries append exactly once', async t => {
  const f = fixture(t);
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...f.argv], {cwd: f.root,
      env: {...process.env, ...f.env, ORG_DIR: f.dir, ORG_NOW: '2026-09-15T09:00:00Z'}, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', error = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => error += chunk);
    child.on('error', reject); child.on('close', code => resolve({code, output, error}));
  });
  const results = await Promise.all([run(), run()]);
  for (const result of results) assert.equal(result.code, 0, result.error);
  assert.equal(results.filter(r => JSON.parse(r.output).recorded).length, 1);
  assert.equal(f.events().filter(e => e.type === 'lifecycle.manual-nudge').length, 1);
});

test('nudge rejects a foreign record even when it contains a matching run project label', t => {
  const f = fixture(t), other = setupOrg();
  t.after(() => fs.rmSync(other.root, {recursive: true, force: true}));
  transact(other.dir, () => ({add: [{type: 'run.started', id: 'R-1', item: 'ENG-1', meta: {dispatch_project: f.project}}]}),
    {at: new Date('2026-09-15T08:00:00Z'), actor: 'fixture'});
  const result = f.org(f.argv, {env: {...f.env, ORG_DIR: other.dir}});
  assert.equal(result.code, 1); assert.match(result.err, /record does not belong/);
  assert.equal(other.events().some(e => e.type === 'lifecycle.manual-nudge'), false);
});

for (const child of [false, true]) test(`nudge defers while ${child ? 'the parent' : 'its item'} has an open promotion, then recovers with the original occurrence time`, t => {
  const f = fixture(t);
  const git = args => {
    const result = spawnSync('git', ['-C', f.root, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['-c', 'user.name=Nudge', '-c', 'user.email=nudge@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture']);
  const head = git(['rev-parse', 'HEAD']), argv = [...f.argv];
  if (child) {
    transact(f.dir, () => ({add: [
      {type: 'item.added', id: 'ENG-4', parent: 'ENG-1', title: 'Child'},
      {type: 'run.started', id: 'R-4', item: 'ENG-4', meta: {dispatch_project: f.project}}
    ]}), {at: new Date('2026-09-15T08:00:00Z'), actor: 'fixture'});
    argv[argv.indexOf('--run') + 1] = 'R-4';
  }
  const queue = queueFor(f.root);
  enqueue(queue, ['nudge-fixture'], {org: f.dir, run: 'R-1', expectedHead: head});
  const before = fs.readFileSync(path.join(f.dir, 'events.jsonl')), throughSeq = f.events().at(-1).seq;
  const env = {...f.env, ORG_GUARD_OVERRIDE: ''};
  const refused = () => {
    const queueBefore = fs.readFileSync(queue.file);
    const result = f.org(argv, {env});
    assert.equal(result.code, 3, result.err);
    assert.match(result.err, /promotion write guard REFUSED/);
    assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.jsonl')), before, 'refusal appends nothing');
    assert.deepEqual(fs.readFileSync(queue.file), queueBefore, 'journaling does not change the promotion');
  };
  refused();
  queue.transaction(data => {
    data.results.push({...data.pending.shift(), outcome: 'promoted', tip: head, reconciliation: {state: 'pending'}});
  });
  refused(); // Green/landed but unreconciled still defers the journal.
  queue.transaction(data => { data.results[0].reconciliation.state = 'complete'; });
  assert.deepEqual(f.json(argv, {env, now: '2026-09-15T10:00:00Z'}), {recorded: true, reused: false});
  const event = f.events().at(-1), after = fs.readFileSync(path.join(f.dir, 'events.jsonl'));
  assert.equal(event.nudge_id, 'test:one');
  assert.equal(event.item, child ? 'ENG-4' : 'ENG-1');
  assert.equal(event.actor, 'helper'); assert.equal(event.by, 'nudge-owner');
  assert.equal(event.occurred_at, '2026-09-15T08:30:00.000Z');
  assert.equal(event.at, '2026-09-15T10:00:00.000Z');
  assert.deepEqual(after.subarray(0, before.length), before);
  assert.equal(f.json(argv, {env, now: '2026-09-15T10:15:00Z'}).reused, true);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'events.jsonl')), after);
  const measure = options => measureLifecycle({events: f.events(), project: f.project,
    from: '2026-09-15T08:00:00Z', cutoff: '2026-09-15T10:00:00Z', ...options});
  assert.equal(measure({cutoff: '2026-09-15T09:00:00Z'}).hand_nudges.recorded, 0, 'not recorded by the earlier cutoff');
  assert.equal(measure({throughSeq}).hand_nudges.recorded, 0, 'not recorded by the earlier fence');
  assert.equal(measure().hand_nudges.recorded, 1);
  assert.equal(measure().hand_nudges.total, null);
  assert.equal(measure().hand_nudges.journal[0].occurred_at, event.occurred_at);
});
