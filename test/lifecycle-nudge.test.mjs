import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setupOrg, BIN } from './helpers.mjs';
import { fixtureFleet } from './helpers/offline-herdr.mjs';
import { transact } from '../lib/store.mjs';
import { measureLifecycle } from '../measurement/lifecycle.mjs';

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
