import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { recordDispatchCompletion } from '../completion.mjs';
import { configFixture } from '../../test/helpers/config-home-fixture.mjs';
import { gitProject } from '../../lib/project.mjs';
import { transact, loadEvents } from '../../lib/store.mjs';

// Waiting for a record writer is not owner recovery: a lock whose recorded
// owner is dead stays exactly as found and publication refuses at the bound.
test('completion publication waits for a record writer but never removes a dead-owner record lock', t => {
  const f = configFixture(t, { custom: true }), org = f.env.ORG_DIR, repo = f.cwd, dir = path.join(org, 'dispatch');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'original.json'), job = { token: 'original', repo, org, common: gitProject(repo).identity, item: 'ENG-1', stage: 'open', completion_protocol: 1 };
  fs.writeFileSync(file, JSON.stringify(job)); fs.writeFileSync(file + '.lock', String(process.pid));
  transact(org, () => ({ add: [{ type: 'item.added', id: 'ENG-1', role: 'engineer', title: 'Original dispatch' }] }));
  const lock = path.join(org, 'lock'), dead = String(spawnSync(process.execPath, ['-e', '']).pid);
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), dead);
  const started = performance.now();
  assert.throws(() => recordDispatchCompletion({ job, journal: file, exitCode: 1 }), /the record is locked .*explicit control will not probe or recover its owner/);
  assert.ok(performance.now() - started >= 10000, 'a held lock is waited on before refusal');
  assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), dead);
  fs.rmSync(lock, { recursive: true });
  assert.equal(loadEvents(org).events.filter(e => e.type === 'dispatch.completed').length, 0);
});
