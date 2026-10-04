import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createEntry, command, quote } from '../runtime.mjs';
import { initOrg } from '../../lib/store.mjs';
import { sandboxCommand } from '../confinement.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';

const binary = process.env.MONITOR_TEST_SANDBOX;
test('shared-state sandbox paths must come from the parent as absolute exclusions', () => {
  for (const sharedPaths of [undefined, [], ['relative'], ['/tmp/invalid\0']]) {
    assert.throws(() => sandboxCommand('codex', '/tmp/project', { sharedPaths }), /absolute shared-state paths/u);
  }
});

for (const linked of [false, true]) test(`native validation denies record and coordination writes (${linked ? 'linked record and event log' : 'default record'})`, {
  skip: !binary && 'set MONITOR_TEST_SANDBOX to run this offline native filesystem regression', timeout: 60000,
}, (t) => {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'mc-'));
  fixtureFleet(t, scratch);
  const entries = [];
  t.after(() => { for (const entry of entries) entry.close(); fs.rmSync(scratch, { recursive: true, force: true }); });
  const repo = path.join(scratch, 'project'), nativeHome = path.join(scratch, 'native-home');
  fs.mkdirSync(repo); fs.mkdirSync(nativeHome);
  command('git', ['init', '-q', '-b', 'main'], repo);
  command('git', ['config', 'user.name', 'Confinement test'], repo);
  command('git', ['config', 'user.email', 'test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'state/\n.org\n');
  if (linked) {
    const storage = path.join(scratch, 'shared-record'); initOrg(storage);
    fs.mkdirSync(path.join(repo, 'state'));
    const log = path.join(repo, 'state/events.jsonl');
    fs.renameSync(path.join(storage, 'events.jsonl'), log);
    fs.symlinkSync(log, path.join(storage, 'events.jsonl'));
    fs.symlinkSync(storage, path.join(repo, '.org'));
  }
  const probe = path.join(repo, 'probe.cjs');
  // This is executed inside the actual native kernel sandbox, with no inference.
  fs.writeFileSync(probe, `const fs=require('fs'),path=require('path'),assert=require('assert');
const phase=process.argv[2],denied=[];
const targets=['.org/events.jsonl','.lane/discovery/routing.json','.lane/discovery/entries/injected.json'];
if(${linked})targets.push('state/events.jsonl',${JSON.stringify(path.join(scratch, 'shared-record/events.jsonl'))});
for(const file of targets){assert.throws(()=>fs.writeFileSync(file,'unauthorized'),e=>['EPERM','EACCES'].includes(e.code),file);denied.push(file);}
assert.throws(()=>fs.renameSync('.lane/discovery','.lane/moved-discovery'),e=>['EPERM','EACCES'].includes(e.code));
const ordinary='ordinary-'+phase+'.txt';fs.writeFileSync(ordinary,'ordinary work');fs.unlinkSync(ordinary);
assert.equal(process.env.TMPDIR,process.env.TMP);assert.equal(process.env.TMP,process.env.TEMP);
fs.writeFileSync(path.join(process.env.TMPDIR,'result-'+phase+'.json'),JSON.stringify(denied));
`);
  const runProbe = (phase) => [process.execPath, probe, phase].map(quote).join(' ');
  fs.writeFileSync(path.join(repo, '.lane.json'), JSON.stringify({ main: 'main', entry: { mode: 'main' },
    prepare: [{ run: runProbe('prepare') }], validate: runProbe('validate') }));
  command('git', ['add', '.gitignore', '.lane.json', 'probe.cjs'], repo);
  command('git', ['commit', '-qm', 'Seed native confinement fixture'], repo);
  const options = { cwd: repo, sandboxBinary: binary, runtimeDir: path.join(scratch, 'runtime'), worktreeRoot: path.join(scratch, 'lanes') };
  const entry = createEntry(options); entries.push(entry);
  entry.dispatch({ op: 'start', text: 'Exercise main-mode preparation and validation' });
  const context = entry.context(), recordBefore = fs.readFileSync(path.join(context.org, 'events.jsonl'));
  const routingFile = path.join(repo, '.lane/discovery/routing.json'), routingBefore = fs.readFileSync(routingFile);
  const previousHome = process.env.CODEX_HOME;
  try {
    // This variable retains its native meaning: an isolated CLI runtime home.
    process.env.CODEX_HOME = nativeHome;
    assert.match(entry.dispatch({ op: 'check' }), /GATE .* exit=0/u);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  }
  assert.deepEqual(fs.readFileSync(path.join(context.org, 'events.jsonl')), recordBefore);
  assert.deepEqual(fs.readFileSync(routingFile), routingBefore);
  assert.deepEqual(fs.readdirSync(context.tempRoot).filter(name => name.startsWith('r-')), [], 'validation removes each run temp');
  entry.close();
  assert.equal(command('git', ['status', '--porcelain'], repo), '');
});
