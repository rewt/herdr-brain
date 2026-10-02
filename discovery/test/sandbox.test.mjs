import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createEntry, command } from '../runtime.mjs';
import { spawnSync } from 'node:child_process';
const binary = process.env.MONITOR_TEST_SANDBOX;
test('real native sandbox validates both lanes and promotion; outside writes and Git metadata stay denied', { skip: !binary && 'set MONITOR_TEST_SANDBOX to a native Codex executable for this offline sandbox check' }, (t) => {
  const scratch = fs.mkdtempSync('/private/tmp/monitor-sandbox-test-');
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const repo = path.join(scratch, 'project'); fs.mkdirSync(repo);
  command('git', ['init', '-q', '-b', 'main'], repo);
  command('git', ['config', 'user.name', 'Test'], repo); command('git', ['config', 'user.email', 'test@example.invalid'], repo);
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, 'test/green.test.mjs'), "import test from 'node:test'; test('green',()=>{});\n");
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
  command('git', ['add', '.'], repo); command('git', ['commit', '-qm', 'Seed'], repo);
  const options = { cwd: repo, sandboxBinary: binary, runtimeDir: path.join(scratch, 'runtime'), worktreeRoot: path.join(scratch, 'lanes') };
  const a = createEntry(options), b = createEntry(options); t.after(a.close); t.after(b.close);
  for (const [entry, name] of [[a, 'a'], [b, 'b']]) {
    const task = entry.dispatch({ op: 'start', text: `Task ${name}` });
    fs.writeFileSync(path.join(task.workspace, `${name}.txt`), name);
    fs.mkdirSync(path.dirname(task.report), { recursive: true });
    fs.writeFileSync(task.report, `---\nrun: ${task.run}\noutcome: done\nsummary: Added ${name}\nheadline: Added ${name}\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
    entry.dispatch({ op: 'commit', text: `Add ${name}` });
    assert.throws(() => entry.dispatch({ op: 'finish' }), /successful promotion/u);
    assert.match(entry.dispatch({ op: 'check' }), /GATE .* exit=0/u);
    assert.match(entry.dispatch({ op: 'promote' }), /fast-forward/u);
    entry.dispatch({ op: 'finish' });
  }
  assert.equal(command('git', ['status', '--porcelain'], repo), '');
  assert.equal(command('git', ['rev-list', '--merges', 'main'], repo), '');
  const c = createEntry(options), d = createEntry(options); t.after(c.close); t.after(d.close);
  for (const [entry, value] of [[c, 'left'], [d, 'right']]) {
    const task = entry.dispatch({ op: 'start', text: `Conflict ${value}` });
    fs.writeFileSync(path.join(task.workspace, 'shared.txt'), `${value}\n`);
    fs.mkdirSync(path.dirname(task.report), { recursive: true });
    fs.writeFileSync(task.report, `---\nrun: ${task.run}\noutcome: done\nsummary: Conflict ${value}\nheadline: Conflict ${value}\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
    entry.dispatch({ op: 'commit', text: `Conflict ${value}` });
  }
  c.dispatch({ op: 'promote' });
  assert.throws(() => d.dispatch({ op: 'promote' }), /does not rebase cleanly/u);
  const paused = d.dispatch({ op: 'rebase' });
  assert.equal(paused.paused, true); assert.match(paused.next, /adapter stages/u);
  assert.equal(d.dispatch({ op: 'context' }).branch, d.context().branch, 'verified rebase receipt permits detached recovery');
  fs.writeFileSync(path.join(d.context().workspace, 'shared.txt'), 'left\nright\n');
  d.dispatch({ op: 'continue' });
  d.dispatch({ op: 'check' }); d.dispatch({ op: 'promote' }); d.dispatch({ op: 'finish' });
  assert.equal(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8'), 'left\nright\n');
  const e = createEntry(options); t.after(e.close);
  const task = e.dispatch({ op: 'resume', text: d.context().item });
  const record = new URL('../../bin/org.mjs', import.meta.url).pathname;
  command(process.execPath, [record, 'answer', e.context().routing.question, 'yes'], repo, { ORG_DIR: e.context().org, ORG_ACTOR: 'human' });
  e.dispatch({ op: 'apply-routes' });
  fs.mkdirSync(path.dirname(task.report), { recursive: true });
  fs.writeFileSync(task.report, `---\nrun: ${task.run}\noutcome: done\nsummary: Apply approved routes\nheadline: Routes applied\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
  e.dispatch({ op: 'commit', text: 'Apply approved routes' }); e.dispatch({ op: 'check' });
  e.dispatch({ op: 'promote' }); e.dispatch({ op: 'finish' });
  const exactReport = fs.readFileSync(task.report, 'utf8');
  fs.writeFileSync(task.report, exactReport.replace('Apply approved routes', 'A second different report'));
  assert.throws(() => e.dispatch({ op: 'finish' }), /already has a report/u);
  fs.writeFileSync(task.report, exactReport);
  const parent = JSON.parse(command(process.execPath, [record, 'show', e.context().routing.parent, '--json'], repo, { ORG_DIR: e.context().org }));
  assert.equal(parent.closed.as, 'done');
  const cwd = a.context().workspace;
  const gitPointer = fs.readFileSync(path.join(cwd, '.git'), 'utf8');
  const probe = spawnSync(binary, ['sandbox', '--permission-profile', 'monitor-denial', '--include-managed-config', '-C', cwd,
    '-c', 'permissions.monitor-denial.filesystem={ ":root"="read", ":workspace_roots"={ "."="write", ".git"="read" } }',
    '-c', 'permissions.monitor-denial.network.enabled=false', '--', process.execPath, '-e',
    `const fs=require('fs');for(const file of [${JSON.stringify(path.join(repo, '.git/escape'))},${JSON.stringify(path.join(scratch, 'outside'))},${JSON.stringify(path.join(cwd, '.git'))}]){try{fs.writeFileSync(file,'bad');process.exit(3)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}}`], { cwd, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.ok(!fs.existsSync(path.join(repo, '.git/escape'))); assert.ok(!fs.existsSync(path.join(scratch, 'outside')));
  assert.equal(fs.readFileSync(path.join(cwd, '.git'), 'utf8'), gitPointer);
});
