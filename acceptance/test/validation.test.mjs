import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createEntry, command } from '../../discovery/runtime.mjs';
import { sandboxCommand } from '../../discovery/confinement.mjs';
import { lifetimeScope, closeScope } from '../../discovery/lifetime.mjs';
import { validationTransport } from '../validation.mjs';
import { copyNativeTransport } from '../transport.mjs';
import { createLiveSessionTemp } from '../temp.mjs';
import { sessionEnv } from '../security.mjs';

const source = path.resolve(import.meta.dirname, '../..');
const discovered = spawnSync('which', ['codex'], { encoding: 'utf8' }).stdout?.trim();
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'av-')));
  const entries = [], scratchRoots = [];
  const temp = createLiveSessionTemp(scratchRoots);
  t.after(() => {
    try { for (const entry of entries) entry.close(); }
    finally { for (const directory of [...scratchRoots, root]) fs.rmSync(directory, { recursive: true, force: true }); }
  });
  const repo = path.join(root, 'project');
  fs.mkdirSync(repo);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid']]) command('git', args, repo);
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, 'test/green.test.mjs'), "import test from 'node:test';test('green',()=>{});\n");
  command('git', ['add', '.'], repo); command('git', ['commit', '-qm', 'Seed'], repo);
  const spec = { name: 'offline', repo, temp, runtimeHome: path.join(root, 'runtime-home'), path: process.env.PATH, installation: source, toolRoots: [],
    entryBinary: '/installed/monitor-codex', gitCommon: path.join(repo, '.git'), worktreeRoot: path.join(temp, 'lanes') };
  fs.mkdirSync(spec.runtimeHome);
  return { root, repo, temp, spec, entries };
}

test('validation composition keeps product denials and refuses foreign writes and unsupported profiles', (t) => {
  const { repo, temp, spec } = fixture(t);
  const shared = path.join(repo, '.org'); fs.mkdirSync(shared);
  const coordination = path.join(repo, '.lane'), temporary = path.join(coordination, 'validation-tmp');
  fs.mkdirSync(temporary, { recursive: true });
  const sandbox = sandboxCommand('/native/codex', repo, { sharedPaths: [shared, coordination], writablePaths: [temporary] });
  const args = ['sandbox', ...sandbox.args.slice(1), process.execPath, '-e', ''];
  // sandbox.args already starts with "sandbox" and ends at the separator.
  const composed = validationTransport(spec, args, repo).args.join(' ');
  assert.ok(composed.includes(`${JSON.stringify(shared)}="read"`));
  assert.ok(composed.includes(`${JSON.stringify(coordination)}="read"`));
  assert.ok(composed.includes(`${JSON.stringify(temporary)}="write"`));
  assert.ok(composed.includes('":tmpdir"="read"'));
  assert.ok(composed.includes(`${JSON.stringify(spec.worktreeRoot)}="read"`));
  assert.ok(composed.includes(`${JSON.stringify(spec.gitCommon)}="read"`));
  assert.ok(composed.includes('network.enabled=false'));
  const option = args.findIndex((arg) => arg.startsWith('permissions.monitor-validation.filesystem='));
  const changed = [...args]; changed[option] = changed[option].replace('":root"="read"', `":root"="read",${JSON.stringify(temp)}="write"`);
  assert.throws(() => validationTransport(spec, changed, repo), /external writes/);
  changed[option] = args[option] + 'garbage';
  assert.throws(() => validationTransport(spec, changed, repo), /trailing validation profile/);
});

test('validation write exceptions reject redirected directories and protected Git or shared-state targets', (t) => {
  const { repo, spec } = fixture(t);
  const temporary = path.join(repo, '.lane/validation-tmp'); fs.mkdirSync(temporary, { recursive: true });
  const shared = path.join(temporary, 'selected-record'); fs.mkdirSync(shared);
  const sandbox = sandboxCommand('/native/codex', repo, { sharedPaths: [shared] });
  const args = [...sandbox.args, '/bin/true'];
  const option = args.findIndex((arg) => arg.startsWith('permissions.monitor-validation.filesystem='));
  const grant = (file) => args.map((arg, i) => i === option
    ? arg.replace('":root"="read"', `":root"="read",${JSON.stringify(file)}="write"`) : arg);
  for (const file of [temporary, path.join(repo, '.git/objects')])
    assert.throws(() => validationTransport(spec, grant(file), repo), /overlaps protected state/);
  const alias = path.join(repo, 'redirected-temp'); fs.symlinkSync(temporary, alias);
  assert.throws(() => validationTransport(spec, grant(alias), repo), /writable path redirected/);
});

test('only immutable lifetime probes get a narrow read grant; aliases and missing denials refuse', { skip: process.platform !== 'darwin' }, (t) => {
  const { repo, spec } = fixture(t), scope = lifetimeScope(); t.after(() => closeScope(scope));
  const ownerDir = fs.mkdtempSync('/private/tmp/monitor-owner-test-'); fs.chmodSync(ownerDir, 0o700);
  t.after(() => fs.rmSync(ownerDir, { recursive: true, force: true }));
  const owner = path.join(ownerDir, 'owner'); fs.writeFileSync(owner, 'offline stand-in', { mode: 0o755 });
  const sandbox = sandboxCommand('/native/codex', repo, { sharedPaths: [path.join(repo, '.org')], lifetime: scope });
  const args = [...sandbox.args, owner, '--enter', scope.allowed, scope.denied, '/bin/true'];
  const composed = validationTransport(spec, args, repo);
  assert.equal(composed.lifetime, true);
  const text = composed.args.join(' ');
  assert.ok(text.includes(`${JSON.stringify(scope.allowed)}="read"`));
  assert.ok(text.includes(`${JSON.stringify(scope.denied)}="none"`));
  assert.ok(!text.includes(`${JSON.stringify(path.dirname(scope.allowed))}="read"`));
  const changed = args.map((arg) => arg.startsWith('permissions.monitor-validation.filesystem=') ? arg.replace(`${JSON.stringify(scope.denied)}="none"`, `${JSON.stringify(scope.denied)}="read"`) : arg);
  assert.throws(() => validationTransport(spec, changed, repo), /invalid validation lifetime protocol/);
  fs.unlinkSync(scope.allowed); fs.symlinkSync(scope.denied, scope.allowed);
  assert.throws(() => validationTransport(spec, args, repo), /redirected validation lifetime resource/);
});

test('actual native transport validates and promotes work and approved routes offline, preserving owner fd and confinement',
  { skip: process.platform !== 'darwin' || !discovered, timeout: 60000 }, (t) => {
    const { root, repo, temp, spec, entries } = fixture(t);
    spec.binary = fs.realpathSync(discovered);
    spec.toolRoots = [fs.realpathSync(path.resolve(path.dirname(process.execPath), '..')), path.resolve(path.dirname(spec.binary), '..'), '/opt/homebrew'];
    fs.mkdirSync(path.join(root, 'live-jobs')); fs.mkdirSync(path.join(root, 'evidence'));
    fs.writeFileSync(path.join(root, 'live-jobs/offline.json'), JSON.stringify(spec));
    const native = path.join(root, 'native');
    const nativeTransport = copyNativeTransport(root);
    fs.writeFileSync(native, `#!/bin/sh\nexec '${process.execPath}' '${nativeTransport}' '${root}' offline "$@"\n`, { mode: 0o755 });
    // This uses the trusted parent directly, the actual gate transport and native
    // Codex sandbox, with no authentication, model or Herdr calls.
    const previous = { ...process.env };
    for (const key of Object.keys(process.env)) if (/^(ORG_|LANE_|MONITOR_|GIT_|HERDR_|ACCEPTANCE_)/u.test(key)) delete process.env[key];
    delete process.env.NODE_TEST_CONTEXT;
    // Use exactly the live session's short home/fleet and scrubbed environment.
    Object.assign(process.env, sessionEnv(previous, spec));
    t.after(() => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, previous); });
    const outside = path.join(root, 'private-canary'); fs.writeFileSync(outside, 'private');
    const options = { cwd: repo, sandboxBinary: native, runtimeDir: path.join(temp, 'runtime'), worktreeRoot: spec.worktreeRoot };
    for (const taskName of ['work', 'routes']) {
      const entry = createEntry(options); entries.push(entry);
      const fleet = JSON.parse(fs.readFileSync(path.join(temp, 'f/fleet.json'), 'utf8'));
      assert.deepEqual(Object.keys(fleet.projects), ['project']);
      assert.equal(fleet.projects.project.checkout, repo);
      assert.equal(fleet.projects.project.record, path.join(repo, '.org'));
      const task = entry.dispatch({ op: 'start', text: `Offline ${taskName}` });
      if (taskName === 'routes') {
        command(process.execPath, [path.join(source, 'bin/org.mjs'), 'answer', entry.context().routing.question, 'yes'], repo,
          { ORG_DIR: entry.context().org, ORG_ACTOR: 'human' });
        entry.dispatch({ op: 'apply-routes' });
      }
      fs.writeFileSync(path.join(task.workspace, 'test/confinement.test.mjs'), `import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import net from 'node:net';import path from 'node:path';
        test('gate and product boundaries',async()=>{
          const runtimeTemp=fs.realpathSync(process.env.TMPDIR);
          assert.equal(path.dirname(runtimeTemp),${JSON.stringify(fleet.projects.project.temp)});
          assert.ok(Buffer.byteLength(runtimeTemp)<=60);
          assert.match(path.basename(runtimeTemp),/^r-[A-Za-z0-9]{6}$/);
          assert.equal(process.env.TMP,runtimeTemp);assert.equal(process.env.TEMP,runtimeTemp);
          const temporary=fs.mkdtempSync(path.join(process.env.TMPDIR,'gate-proof-'));
          try {
            const file=path.join(temporary,'probe');fs.writeFileSync(file,'temporary data',{flag:'wx'});
            assert.equal(fs.readFileSync(file,'utf8'),'temporary data');fs.unlinkSync(file);assert.ok(!fs.existsSync(file));
          } finally {fs.rmSync(temporary,{recursive:true,force:true});}
          assert.throws(()=>fs.readFileSync(${JSON.stringify(outside)}),e=>['EPERM','EACCES'].includes(e.code));
          for(const file of ${JSON.stringify([path.join(repo, '.org/events.jsonl'), path.join(repo, '.lane/escape'), path.join(repo, '.git/config'), path.join(task.workspace, '.git'), path.join(temp, 'escape')])})
            assert.throws(()=>fs.writeFileSync(file,'escape'),e=>['EPERM','EACCES'].includes(e.code),file);
          await new Promise((resolve,reject)=>{const socket=net.createConnection({host:'127.0.0.1',port:9});socket.once('connect',()=>{socket.destroy();reject(Error('network allowed'))});socket.once('error',e=>['EPERM','EACCES'].includes(e.code)?resolve():reject(e));});
        });\n`);
      fs.mkdirSync(path.dirname(task.report), { recursive: true });
      fs.writeFileSync(task.report, `---\nrun: ${task.run}\noutcome: done\nsummary: Offline ${taskName}\nheadline: Offline validation passed\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
      entry.dispatch({ op: 'commit', text: `Offline ${taskName}` });
      assert.match(entry.dispatch({ op: 'check' }), /GATE .* exit=0/u);
      assert.match(entry.dispatch({ op: 'promote' }), /fast-forward/u);
      entry.dispatch({ op: 'finish' });
      assert.equal(command('git', ['status', '--porcelain'], repo), '');
      assert.equal(command('git', ['rev-parse', 'main'], repo), command('git', ['rev-parse', 'HEAD'], task.workspace));
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.lane.json'))).routes.engineer.model, 'gpt-6.1-sol');
    assert.equal(command('git', ['rev-list', '--merges', 'main'], repo), '');
  });

test('native per-run validation temp is admitted only by its private identity and exact environment handoff', t => {
  const { repo, temp, spec } = fixture(t);
  const temporary = fs.mkdtempSync(path.join(temp, 'r-')); fs.chmodSync(temporary, 0o700);
  const sandbox = sandboxCommand('/native/codex', repo, { sharedPaths: [path.join(repo, '.org')], temporaryPaths: [temporary] });
  const args = [...sandbox.args, '/bin/true'];
  const env = { TMPDIR: temporary, TMP: temporary, TEMP: temporary };
  const composed = validationTransport(spec, args, repo, { env }).args.join(' ');
  assert.ok(composed.includes(`${JSON.stringify(temporary)}="write"`));
  for (const wrong of [{}, { ...env, TMP: repo }, { ...env, TMPDIR: path.dirname(temporary) }])
    assert.throws(() => validationTransport(spec, args, repo, { env: wrong }), /external writes/);
  fs.chmodSync(temporary, 0o755);
  assert.throws(() => validationTransport(spec, args, repo, { env }), /private validation temp/);
  fs.chmodSync(temporary, 0o700);
  fs.renameSync(temporary, `${temporary}-moved`); fs.symlinkSync(`${temporary}-moved`, temporary);
  assert.throws(() => validationTransport(spec, args, repo, { env }), /writable path redirected/);
});
