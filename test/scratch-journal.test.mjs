import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { recoverScratch } from './helpers/scratch.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-journal-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, journal: path.join(root, 'owned.jsonl') };
}

test('malformed scratch journal retains all roots and emits diagnostics without changing evidence', t => {
  const { root, journal } = fixture(t), scratch = path.join(root, 'scratch');
  fs.mkdirSync(scratch); fs.writeFileSync(path.join(scratch, 'evidence'), 'keep');
  const stat = fs.lstatSync(scratch, { bigint: true }), owner = { pid: 400, pgid: 400, identity: 'birth' };
  const row = { schema: 'test-scratch/v1', root: scratch, owner,
    dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) };
  const bytes = JSON.stringify(row) + '\n{broken\n';
  fs.writeFileSync(journal, bytes);
  const result = recoverScratch(journal, { joined: true, suite: owner,
    lookup: () => assert.fail('malformed journal cannot authorize owner lookup'),
    groupProbe: () => assert.fail('malformed journal cannot authorize group lookup') });
  assert.equal(result.created, 2); assert.equal(result.removed, 0);
  assert.equal(result.retained_unknown, 2); assert.equal(result.journal_errors[0].line, 2);
  assert.equal(fs.readFileSync(journal, 'utf8'), bytes);
  assert.equal(fs.readFileSync(path.join(scratch, 'evidence'), 'utf8'), 'keep');
  // After an explicit repair of this fixture's journal, the normal native
  // absence/overlap/preservation checks still allow its valid root to recover.
  fs.writeFileSync(journal, JSON.stringify(row) + '\n');
  assert.equal(recoverScratch(journal, { joined: true, suite: owner,
    lookup: () => ({ ok: true, value: null }), groupProbe: () => ({ ok: true, absent: true }) }).removed, 1);
});

for (const denied of [false, true]) test(`scratch registration survives injected product writes (source denied=${denied})`, t => {
  const { root, journal } = fixture(t);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { installScratchTracking } from ${JSON.stringify(new URL('./helpers/scratch.mjs', import.meta.url).href)};
    installScratchTracking();
    fs.writeFileSync = () => { throw Error('injected product write failure'); };
    if (${denied}) cp.spawnSync = () => { throw Error('injected process denial'); };
    syncBuiltinESMExports();
    console.log(fs.mkdtempSync(${JSON.stringify(path.join(root, 'registered-'))}));
  `], { env: { ...process.env, HERDR_TEST_SCRATCH_JOURNAL: journal }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const rows = fs.readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse);
  const row = rows.find(row => row.root === child.stdout.trim());
  assert.ok(row, 'registration survives a replaced fs.writeFileSync');
  if (denied) assert.equal(row.owner, null);
  else assert.equal(row.owner.pid, child.pid);
  const result = recoverScratch(journal, { joined: false });
  assert.ok(result.results.every(row => row.status === 'retained'));
  assert.ok(fs.existsSync(row.root));
});
