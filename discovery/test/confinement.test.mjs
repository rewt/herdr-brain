import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createEntry, command, quote } from '../runtime.mjs';
import { initOrg } from '../../lib/store.mjs';
import { sandboxCommand } from '../confinement.mjs';

const product = new URL('../../', import.meta.url).pathname;
const binary = process.env.MONITOR_TEST_SANDBOX;
test('shared-state sandbox paths must come from the parent as absolute exclusions', () => {
  for (const sharedPaths of [undefined, [], ['relative'], ['/tmp/invalid\0']]) {
    assert.throws(() => sandboxCommand('codex', '/tmp/project', { sharedPaths }), /absolute shared-state paths/u);
  }
});

for (const linked of [false, true]) test(`native main-mode workers and validation deny record and coordination writes (${linked ? 'linked record and event log' : 'default record'})`, {
  skip: !binary && 'set MONITOR_TEST_SANDBOX to run this offline native filesystem regression', timeout: 60000,
}, (t) => {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-confinement-test-'));
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
  const probe = path.join(repo, 'probe.cjs'), observations = path.join(scratch, 'observations');
  fs.mkdirSync(observations);
  const client = path.join(product, 'discovery/client.mjs');
  // This is executed inside the actual native kernel sandbox, with no inference.
  fs.writeFileSync(probe, `const fs=require('fs'),path=require('path'),assert=require('assert'),{spawnSync}=require('child_process');
const phase=process.argv[2],denied=[];
const targets=['.org/events.jsonl','.lane/discovery/routing.json','.lane/discovery/entries/injected.json'];
if(${linked})targets.push('state/events.jsonl',${JSON.stringify(path.join(scratch, 'shared-record/events.jsonl'))});
for(const file of targets){assert.throws(()=>fs.writeFileSync(file,'unauthorized'),e=>['EPERM','EACCES'].includes(e.code),file);denied.push(file);}
assert.throws(()=>fs.renameSync('.lane/discovery','.lane/moved-discovery'),e=>['EPERM','EACCES'].includes(e.code));
if(${linked})assert.throws(()=>fs.unlinkSync('.org'),e=>['EPERM','EACCES'].includes(e.code));
const ordinary='ordinary-'+phase+'.txt';fs.writeFileSync(ordinary,'ordinary work');fs.unlinkSync(ordinary);
if(phase==='prepare'||phase==='validate'){
  fs.writeFileSync(path.join(process.env.TMPDIR,'result-'+phase+'.json'),JSON.stringify(denied));
}else{
  const result=spawnSync(process.execPath,[${JSON.stringify(client)},'start','Bounded '+phase+' task'],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const context=JSON.parse(result.stdout);assert.ok(context.run);
  fs.writeFileSync(${JSON.stringify(observations)}+'/'+phase+'.json',JSON.stringify({denied,run:context.run,args:JSON.parse(process.env.PROBE_NATIVE_ARGS)}));
}
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
  for (const phase of ['prepare', 'validate']) assert.ok(JSON.parse(fs.readFileSync(path.join(repo, '.lane/validation-tmp', `result-${phase}.json`))).length >= 3);
  entry.close();

  // An installed transport forwards sandbox calls to the real CLI, while its
  // model-free native session runs only the denial probe and bounded client.
  const transport = path.join(scratch, 'native'), bin = path.join(scratch, 'bin');
  fs.writeFileSync(transport, `#!${process.execPath}
const {spawnSync}=require('child_process'),args=process.argv.slice(2);
const sandbox=args[0]==='sandbox',kind=args.includes('--append-system-prompt')?'claude':'codex';
const result=spawnSync(sandbox?${JSON.stringify(binary)}:process.execPath,sandbox?args:[${JSON.stringify(probe)},kind],{stdio:'inherit',env:{...process.env,PROBE_NATIVE_ARGS:JSON.stringify(args)}});
process.exit(result.status??1);
`, { mode: 0o755 });
  command(process.execPath, [path.join(product, 'discovery/install.mjs'), '--bin', bin, '--codex', transport, '--claude', transport], repo);
  // Put requests beneath the protected coordination tree to also exercise the
  // one session-specific writable exception, without exposing other receipts.
  const nativeEnv = { CODEX_HOME: nativeHome, MONITOR_RUNTIME_DIR: path.join(repo, '.lane/discovery/requests'),
    MONITOR_ENTRY_BYPASS: '', MONITOR_REQUEST_DIR: '', ORG_DIR: '', HERDR_INTEGRATION_ID: '', HERDR_PANE_ID: '' };
  for (const kind of ['codex', 'claude']) {
    command(path.join(bin, `monitor-${kind}`), ['--', '--model', 'literal-model', 'Fixture task'], repo, nativeEnv);
    const got = JSON.parse(fs.readFileSync(path.join(observations, `${kind}.json`)));
    assert.ok(got.denied.length >= 3); assert.match(got.run, /^R-\d+$/u);
    assert.equal(got.args[got.args.indexOf('--model') + 1], 'literal-model');
    assert.deepEqual(fs.readFileSync(routingFile), routingBefore);
  }
  assert.equal(command('git', ['status', '--porcelain'], repo), '');
});
