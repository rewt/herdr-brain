import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';
const healthy = { available: 8 * 1024 ** 3, swap_used: 0 };
const pressure = { available: 128 * 1024 ** 2, swap_used: 0 };
const journal = (f, run) => JSON.parse(fs.readFileSync(path.join(f.org, 'settle', `${run}.json`)));

// Inject pressure (and optionally STOP) only after the parent has waited and
// saved its launch stage. All lane operations still use the real product CLI.
function boundaryAdapter(f, command, stopped) {
  const memory = path.join(f.root, 'memory.json'), inject = path.join(f.root, 'inject');
  const observed = path.join(f.root, 'boundary.json'), stop = path.join(f.repo, '.lane/supervisor/STOP');
  fs.writeFileSync(memory, JSON.stringify(healthy)); fs.writeFileSync(inject, 'inject once');
  f.env.TEST_MEMORY_FILE = memory;
  const adapter = path.join(f.root, 'lane-boundary.mjs');
  fs.writeFileSync(adapter, `#!/usr/bin/env node
import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === ${JSON.stringify(command)} && fs.existsSync(${JSON.stringify(inject)})) {
  fs.unlinkSync(${JSON.stringify(inject)});
  fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify(args));
  fs.writeFileSync(${JSON.stringify(memory)}, ${JSON.stringify(JSON.stringify(pressure))});
  ${stopped ? `fs.mkdirSync(${JSON.stringify(path.dirname(stop))}, {recursive:true}); fs.writeFileSync(${JSON.stringify(stop)}, 'Boundary stop');` : ''}
}
const r = spawnSync(process.execPath, [${JSON.stringify(path.join(f.source, 'lanes/lane.mjs'))}, ...args], {stdio:'inherit'});
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  return { adapter, memory, stop, observed };
}

for (const stopped of [true, false]) {
  test(`dispatch child boundary ${stopped ? 'STOP restores worker stage for ordinary retry' : 'pressure does not create a second hidden wait'}`, t => {
    const f = fixture(t), original = f.start(), b = boundaryAdapter(f, 'dispatch', stopped);
    fs.appendFileSync(path.join(f.repo, '.git/info/exclude'), '\n.lane/\n');
    const args = [path.join(f.source, 'dispatch/dispatch.mjs'), f.show(original).item,
      '--repo', f.repo, '--org', f.org, '--lane', 'topic', '--route', 'engineer',
      '--brief', path.join(f.root, 'ask with spaces.md'), '--lane-cli', b.adapter];
    const r = f.exec(process.execPath, args);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(fs.readFileSync(b.observed)).includes('--memory-checked'));
    let receipt = JSON.parse(r.stdout);
    if (stopped) {
      assert.equal(receipt.result, 'stopped'); assert.equal(receipt.stage, 'worker');
      assert.equal(JSON.parse(fs.readFileSync(receipt.journal)).stage, 'worker');
      assert.equal(f.calls().filter(a => a[0] === 'agent' && a[1] === 'start').length, 0);
      assert.equal(fs.existsSync(`${receipt.journal}.lock`), false);
      fs.unlinkSync(b.stop); fs.writeFileSync(b.memory, JSON.stringify(healthy));
      const resumed = f.exec(process.execPath, [path.join(f.source, 'dispatch/dispatch.mjs'), '--retry', receipt.journal, '--org', f.org, '--repo', f.repo]);
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(JSON.parse(resumed.stdout).run, receipt.run);
      receipt = JSON.parse(resumed.stdout);
    }
    assert.ok(receipt.agent);
    assert.equal(f.calls().filter(a => a[0] === 'agent' && a[1] === 'start').length, 1);
  });

  test(`settle review child boundary ${stopped ? 'STOP restores review stage for ordinary retry' : 'pressure does not create a second hidden wait'}`, t => {
    const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
    const b = boundaryAdapter(f, 'review', stopped);
    const r = f.settle(run, ['--lane-cli', b.adapter]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(fs.readFileSync(b.observed)).includes('--memory-checked'));
    if (stopped) {
      assert.equal(JSON.parse(r.stdout).result, 'stopped'); assert.equal(journal(f, run).stage, 'review');
      assert.equal(journal(f, run).round, 1);
      assert.equal(f.calls().filter(a => a[0] === 'agent' && a[1] === 'start').length, 0);
      fs.unlinkSync(b.stop); fs.writeFileSync(b.memory, JSON.stringify(healthy));
      const resumed = f.retry(run);
      assert.equal(resumed.status, 0, resumed.stderr); assert.equal(JSON.parse(resumed.stdout).result, 'promotable');
      assert.equal(journal(f, run).round, 1);
    } else assert.equal(JSON.parse(r.stdout).result, 'promotable');
    assert.equal(f.calls().filter(a => a[0] === 'agent' && a[1] === 'start').length, 1);
  });
}

for (const command of ['dispatch', 'review']) {
  test(`direct lane ${command} waits visibly and honors canonical STOP from a linked worktree`, async t => {
    const f = fixture(t), memory = path.join(f.root, 'memory.json');
    fs.writeFileSync(memory, JSON.stringify(pressure)); f.env.TEST_MEMORY_FILE = memory;
    // The coordinator's cwd is canonical; --repo is not a lane option. A small
    // entry adapter changes cwd to the linked checkout before the real CLI.
    const adapter = path.join(f.root, 'linked-lane.mjs');
    fs.writeFileSync(adapter, `process.chdir(${JSON.stringify(f.workspace)}); await import(${JSON.stringify(path.join(f.source, 'lanes/lane.mjs'))});`);
    const pending = f.concurrent(command, adapter, ['topic', ...(command === 'dispatch' ? ['--json'] : [])]);
    let stderr = '', stdout = '';
    pending.child.stderr.on('data', data => { stderr += data; });
    pending.child.stdout.on('data', data => { stdout += data; });
    const stop = path.join(f.repo, '.lane/supervisor/STOP');
    try {
      const end = Date.now() + 10000;
      while (!stderr.includes(`lane ${command}: waiting`) && Date.now() < end) await new Promise(r => setTimeout(r, 20));
      assert.match(stderr, /waiting; memory pressure/);
      fs.mkdirSync(path.dirname(stop), { recursive: true }); fs.writeFileSync(stop, 'Stop while waiting');
      await pending.done;
    } finally { fs.writeFileSync(memory, JSON.stringify(healthy)); }
    assert.equal(pending.child.exitCode, 0, stderr);
    assert.equal(JSON.parse(stdout).result, 'stopped');
    assert.equal(f.calls().filter(a => a[0] === 'agent' && a[1] === 'start').length, 0);
  });
}
