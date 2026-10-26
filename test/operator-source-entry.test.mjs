import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { transact } from '../lib/store.mjs';
import { gitProject } from '../lib/project.mjs';

const source = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const entry = path.join(source, 'bin/org.mjs');
const sourceCommon = gitProject(source).identity;

async function adopted(t, { saved = false } = {}) {
  const f = configFixture(t, { custom: true });
  // Model an older adopted entry without changing any real installed bundle.
  const pinnedEntry = path.join(f.bundle, 'bin/org.mjs');
  fs.writeFileSync(pinnedEntry, `if (['messages','status'].includes(process.argv[2])) { console.log(JSON.stringify({pinned:true,command:process.argv[2]})); process.exit(0); }\n` + fs.readFileSync(pinnedEntry, 'utf8').replace(/^#![^\n]*\n/, ''));
  const manifest = spawnSync(process.execPath, [path.join(source, 'herdr/releases.mjs'), 'manifest', f.bundle,
    path.join(f.bundle, '.release-acceptance.json')], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
  assert.equal(manifest.status, 0, manifest.stderr);
  const savedRoot = saved ? f.release('saved-continuation') : null;
  await f.adopt();
  // Keep even default release forwarding inside this fixture's account.
  const account = path.join(f.scratch, 'account.mjs');
  fs.writeFileSync(account, `import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';const original=os.userInfo;os.userInfo=(...args)=>({...original(...args),homedir:${JSON.stringify(f.home)}});syncBuiltinESMExports();`);
  const bin = path.join(f.scratch, 'bin'); fs.mkdirSync(bin);
  const agent = structuredClone(f.observation.agents[0]), calls = path.join(f.scratch, 'native-calls');
  fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}
import fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');
if(a[0]==='agent'&&a[1]==='get'&&a[2]===${JSON.stringify(agent.pane_id)})console.log(JSON.stringify({result:{agent:${JSON.stringify(agent)}}}));else process.exit(1);
`, { mode: 0o755 });
  const env = { ...f.env, HERDR_ENV: '1', HERDR_PANE_ID: agent.pane_id, HERDR_WORKSPACE_ID: agent.workspace_id,
    CODEX_THREAD_ID: agent.agent_session.value, HERDR_BRAIN_ROOT: undefined, PATH: `${bin}:${f.env.PATH}`,
    NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(pathToFileURL(account).href)}` };
  transact(f.env.ORG_DIR, () => ({ add: [
    { type: 'item.added', id: 'ENG-1', title: 'Fixture work', role: 'engineer' },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: f.cwd, meta: { agent: agent.name,
      pane: agent.pane_id, worker_workspace: agent.workspace_id, terminal_id: agent.terminal_id,
      agent_session_id: agent.agent_session.value } },
    { type: 'run.claimed', run: 'R-1', record: f.env.ORG_DIR, project: path.join(f.cwd, '.git'),
      owner: { controller: 'brain', legacy: false, release: { root: source, id: 'source', commit: null, identity: sourceCommon } } },
  ] }));
  const run = (args, extra = {}, file = entry) => {
    const result = spawnSync(process.execPath, [file, ...args], { cwd: f.cwd, env: { ...env, ...extra }, encoding: 'utf8' });
    assert.deepEqual(protectedFiles.map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null), before, 'entry selection never edits a pin, adopted binding or installed payload');
    return result;
  };
  const send = ['messages', 'send', '--id', 'fixture:entry:1', '--kind', 'notice', '--run', 'R-1', '--item', 'ENG-1', '--summary', 'Actual guarded source entry'];
  const rows = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const protectedFiles = [f.binding().file, path.join(f.cwd, '.herdr-release.json'), path.join(f.bundle, '.release-manifest.json')];
  const before = protectedFiles.map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  return { ...f, run, send, rows, savedRoot };
}

test('operator messages source entry reaches an adopted record with matching selector and actual native/run guards', async t => {
  const f = await adopted(t), result = f.run(f.send, { HERDR_BRAIN_ROOT: source });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).push.state, 'record-only');
  const messages = f.events().filter(e => e.type === 'session.message.v1');
  assert.equal(messages.length, 1); assert.equal(messages[0].envelope.sessionUid, 'native-session');
  assert.equal(messages[0].envelope.orgRef, f.env.ORG_DIR);
  assert.equal(messages[0].envelope.project.commonDir, path.join(f.cwd, '.git'));
  const digest = f.run(['messages', 'digest', '--json'], { HERDR_BRAIN_ROOT: source });
  assert.equal(digest.status, 0, digest.stderr); assert.equal(JSON.parse(digest.stdout).messages[0].id, 'fixture:entry:1');
  assert.ok(f.rows().length); assert.ok(f.rows().every(a => a[0] === 'agent' && a[1] === 'get'), 'no pane input or operator push');
});

test('operator messages source entry preserves default adopted pin forwarding and other record commands', async t => {
  const f = await adopted(t), before = f.events().length;
  for (const [args, env] of [[['messages', 'digest', '--json'], {}], [['status', '--json'], { HERDR_BRAIN_ROOT: source }]]) {
    const result = f.run(args, env);
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).pinned, true);
  }
  assert.equal(f.events().length, before); assert.deepEqual(f.rows(), []);
});

test('operator messages source entry refuses mismatched selection before record or native effects', async t => {
  const f = await adopted(t), before = f.events().length;
  const result = f.run(f.send, { HERDR_BRAIN_ROOT: f.cwd });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /HERDR_BRAIN_ROOT must match the invoked development source root/);
  assert.equal(f.events().length, before); assert.deepEqual(f.rows(), []);
});

test('operator messages source entry grants no missing native or foreign run binding authority', async t => {
  const f = await adopted(t), before = f.events().length;
  const missing = f.run(f.send, { HERDR_BRAIN_ROOT: source, HERDR_ENV: '0' });
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /native caller binding is missing/);
  assert.equal(f.events().length, before); assert.deepEqual(f.rows(), []);
  transact(f.env.ORG_DIR, () => ({ add: [{ type: 'run.updated', id: 'R-1', meta: { agent_session_id: 'foreign-session' } }] }));
  const changed = f.events().length, foreign = f.run(f.send, { HERDR_BRAIN_ROOT: source });
  assert.notEqual(foreign.status, 0); assert.match(foreign.stderr, /run claim or native worker binding differs/);
  assert.equal(f.events().length, changed); assert.ok(f.rows().every(a => a[1] === 'get'));
});

test('operator messages source entry preserves an immutable saved release despite a different selector or adopted pin', async t => {
  const f = await adopted(t, { saved: true }), before = f.events().length;
  const result = f.run(['messages', 'digest', '--json'], { HERDR_BRAIN_ROOT: f.cwd }, path.join(f.savedRoot, 'bin/org.mjs'));
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).total, 0);
  assert.equal(JSON.parse(result.stdout).pinned, undefined, 'the saved release did not forward into the adopted pin');
  assert.equal(f.events().length, before); assert.deepEqual(f.rows(), []);
});
