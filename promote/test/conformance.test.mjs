import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { fixture, cli } from './helpers/conformance.mjs';

for (const operation of ['check', 'promote']) test(`caller identity source failure remains an exit-75 refusal in direct ${operation}`, t => {
  const f = fixture(t), wt = f.lane('topic');
  const preload = path.join(f.root, 'transient.mjs'), denied = path.join(f.root, 'denied');
  fs.writeFileSync(preload, `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const execute=cp.spawnSync,read=fs.readFileSync;let failed=false;
const deny=()=>{if(failed||!new Error().stack.includes('runTestSlotSync'))return false;failed=true;fs.writeFileSync(${JSON.stringify(denied)},'one transient source failure');return true;};
cp.spawnSync=(file,...args)=>String(file).includes('process-source-')&&deny()?{error:Object.assign(Error('transient source failure'),{code:'ENOENT'})}:execute(file,...args);
fs.readFileSync=(file,...args)=>String(file).startsWith('/proc/')&&deny()?(()=>{throw Object.assign(Error('transient source failure'),{code:'EACCES'});})():read(file,...args);syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS += ` --import=${preload}`;
  const r = operation === 'check' ? f.exec(['check', '--tier', 'promotion'], wt) : f.exec(['promote', 'topic']);
  assert.ok(fs.existsSync(denied), 'only the caller identity lookup is denied');
  assert.equal(r.status, 75, r.stderr);
  assert.match(r.stderr, /TEST_SLOT_HOLDER_UNKNOWN:.*cannot establish caller process source identity/);
  assert.equal(fs.existsSync(f.counts), false, 'no gate command executes');
  assert.equal(f.git(['rev-parse', 'main']), f.base);
  assert.equal(fs.existsSync(path.join(wt, '.lane/gate.json')), false);
  const receipts = fs.readdirSync(path.join(f.identity, 'lane-validation')).filter(name => name.endsWith('.json'));
  assert.deepEqual(receipts, [], 'source refusal supplies no reusable evidence');
});

for (const mode of ['uncommitted repair', 'committed gate change']) test(`train refuses ${mode} and leaves main at the validated input base`, t => {
  const f = fixture(t); f.lane('topic'); const b = f.batch(['topic']);
  f.body(`fs.writeFileSync('work','validated repair');${mode.startsWith('committed') ? "require('child_process').execFileSync('git',['add','.']);require('child_process').execFileSync('git',['commit','-qm','post-gate']);" : ''}console.log('green after repair');`);
  b.run(); assert.equal(f.git(['rev-parse', 'main']), f.base);
  assert.equal(b.read().results.topic.outcome, 'refused');
  assert.equal(fs.readFileSync(path.join(f.repo, 'work'), 'utf8'), 'base');
});

test('repeated red gates retain distinct immutable logs and hashes for the same committed tree', t => {
  const f = fixture(t); f.lane('topic');
  f.body(`const n=fs.readFileSync(${JSON.stringify(f.counts)},'utf8').trim().split('\\n').length;console.log('execution '+n);process.exit(1);`);
  const first = f.batch(['topic']); first.run(); const a = first.read().attempts[0].gate;
  const original = fs.readFileSync(a.log, 'utf8');
  const second = f.batch(['topic']); second.run(); const b = second.read().attempts[0].gate;
  assert.notEqual(a.log, b.log); assert.equal(fs.readFileSync(a.log, 'utf8'), original);
  assert.match(original, /execution 1/); assert.match(fs.readFileSync(b.log, 'utf8'), /execution 2/);
  for (const g of [a, b]) assert.equal(createHash('sha256').update(JSON.stringify(fs.readFileSync(g.log, 'utf8'))).digest('hex'), g.log_hash);
});

test('a completed gate refused at integration counts once; failed preparation counts no gate', t => {
  const f = fixture(t); f.lane('topic'); const b = f.batch(['topic']);
  f.body(`fs.writeFileSync(${JSON.stringify(path.join(f.repo, 'operator-edit'))},'keep');console.log('green');`);
  b.run(); assert.equal(f.git(['rev-parse', 'main']), f.base);
  assert.equal(f.metrics().summary.gates_executed, 1);
  fs.unlinkSync(path.join(f.repo, 'operator-edit'));
  fs.writeFileSync(f.config, JSON.stringify({ prepare: [{ run: `${process.execPath} -e 'process.exit(8)'` }] }));
  const failed = f.batch(['topic']); failed.run();
  assert.equal(failed.read().attempts[0].gate, undefined); assert.equal(f.metrics().summary.gates_executed, 1);
});

test('resuming a prepared attempt retains both executed gates in receipts and metrics', t => {
  const f = fixture(t); f.lane('topic'); const b = f.batch(['topic']);
  f.body("console.log('red first');process.exit(1);"); b.run();
  const plan = b.read(), first = plan.attempts[0].gate;
  // Restore the durable prepared checkpoint; the real second gate still executes.
  plan.attempts[0].phase = 'prepared'; plan.groups = [['topic']]; plan.results = {};
  f.git(['worktree', 'add', '-b', plan.attempts[0].branch, plan.attempts[0].scratch, plan.attempts[0].tip]);
  fs.writeFileSync(b.file, JSON.stringify(plan));
  f.body("console.log('green second');"); b.run();
  assert.equal(b.read().attempts[0].gate_history.length, 1);
  assert.deepEqual(b.read().attempts[0].gate_history[0], first);
  const m = f.metrics(); assert.equal(m.summary.gates_executed, 2); assert.equal(m.summary.red, 1); assert.equal(m.summary.green, 1);
  assert.equal(m.summary.first_pass.rate, 0); assert.equal(m.warnings.length, 0);
});

test('executed gates that dirty the worktree still retain real exit, log and timing evidence', t => {
  const f = fixture(t); f.lane('topic'); const b = f.batch(['topic']);
  f.body("fs.writeFileSync('work','uncommitted');console.log('executed dirty');"); b.run();
  const gate = b.read().attempts[0].gate.execution;
  assert.equal(gate.exit_code, 0); assert.match(fs.readFileSync(gate.log, 'utf8'), /executed dirty/);
  assert.equal(f.metrics().summary.gates_executed, 1); assert.equal(f.git(['rev-parse', 'main']), f.base);
});

test('interrupted execution time is included separately from completed gate time', t => {
  const f = fixture(t); f.lane('topic'); const b = f.batch(['topic']);
  f.body("setTimeout(()=>process.kill(process.pid,'SIGTERM'),100);"); b.run();
  const m = f.metrics(); assert.equal(m.summary.gates_executed, 1); assert.equal(m.summary.interrupted, 1);
  assert.equal(m.summary.executed_gate_time_s.samples, 1); assert.ok(m.summary.executed_gate_time_s.total > 0);
});

for (const mode of ['dirty', 'committed']) test(`post-gate ${mode} scratch drift cannot reach main`, t => {
  const f = fixture(t); f.lane('topic'); const b = f.batch(['topic']);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
  const proxy = path.join(f.root, 'git.cjs'), marker = path.join(f.root, 'drift');
  fs.writeFileSync(proxy, `const fs=require('fs'),cp=require('child_process'),path=require('path'),a=process.argv.slice(2),p=JSON.parse(fs.readFileSync(${JSON.stringify(b.file)})),s=p.attempts?.at(-1);
if(s?.phase==='validated'&&a[1]===s.scratch&&a[2]==='status'&&!fs.existsSync(${JSON.stringify(marker)})){
 fs.writeFileSync(${JSON.stringify(marker)},'changed after gate');fs.writeFileSync(path.join(s.scratch,'work'),'post-gate drift');
 ${mode === 'committed' ? `cp.execFileSync(${JSON.stringify(realGit)},['-C',s.scratch,'add','.']);cp.execFileSync(${JSON.stringify(realGit)},['-C',s.scratch,'commit','-qm','post-gate drift']);` : ''}
}
const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??1);`);
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\nrequire(${JSON.stringify(proxy)});`, { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const r = b.run(); assert.notEqual(r.status, 0); assert.ok(fs.existsSync(marker));
  assert.equal(f.git(['rev-parse', 'main']), f.base); assert.equal(b.read().attempts[0].gate.exit_code, 0);
});

test('concurrent same-tree red checks retain distinct complete logs', async t => {
  const f = fixture(t), one = f.lane('first'), two = f.lane('second');
  f.git(['reset', '--hard', 'lane/first'], two);
  f.body("console.log('complete '+process.cwd());process.exit(1);");
  const { spawnChild, waitForExit } = await import('../../test/helpers/child.mjs');
  const children = [one, two].map(cwd => spawnChild(t, process.execPath, [cli, 'check', '--tier', 'fast', '--cmd', `${process.execPath} ${f.checker}`], { cwd, env: f.env }));
  const results = await Promise.all(children.map(waitForExit));
  for (const [i, result] of results.entries()) {
    // The cache-key lock can refuse one concurrent caller. Retry only that
    // refusal after both callers finish; two real red executions are required.
    const r = /locked/.test(result.stderr)
      ? f.exec(['check', '--tier', 'fast', '--cmd', `${process.execPath} ${f.checker}`], [one, two][i]) : result;
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /GATE .* exit=1/, r.stderr);
  }
  const gates = [one, two].map(cwd => JSON.parse(fs.readFileSync(path.join(cwd, '.lane/gate.json'))));
  assert.equal(gates[0].key, gates[1].key, 'both executions share the collision-prone cache key');
  assert.notEqual(gates[0].log, gates[1].log);
  for (const [i, gate] of gates.entries()) {
    const output = fs.readFileSync(gate.log, 'utf8');
    assert.ok(output.includes(`complete ${[one, two][i]}\n`));
    assert.equal(createHash('sha256').update(JSON.stringify(output)).digest('hex'), gate.log_hash);
  }
});
