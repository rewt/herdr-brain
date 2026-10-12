#!/usr/bin/env node
// Native Herdr entry canary. No inference, prompts, live install or launchd:
// the actual Codex UI runs under a scratch-only write / no-network boundary.
import { loadTimeout } from './deadline.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from '../lib/cli-help.mjs';
import { quote } from '../lib/shell.mjs';
import { copyProduct } from '../lib/product-files.mjs';
import { scratchProductHomes, assertScratchHomes } from './environment.mjs';
import { fleetPath } from '../lib/fleet.mjs';

const { values } = parseArgs({ options: { candidate: { type: 'string' }, 'native-codex': { type: 'string' } } });
if (!values.candidate || !values['native-codex']) throw new Error('usage: node acceptance/plugin-entry.mjs --candidate FINAL_PRODUCT_DIRECTORY --native-codex ABSOLUTE_NATIVE_CODEX');
if (process.env.HERDR_ENV !== '1') throw new Error('run from an authorized Herdr pane');
if (process.platform !== 'darwin') throw new Error('native UI canary currently requires macOS sandbox-exec');
const candidate = fs.realpathSync(values.candidate), binary = fs.realpathSync(values['native-codex']);
const herdrBinary = fs.realpathSync(spawnSync('which', ['herdr'], { encoding: 'utf8' }).stdout.trim());
const gitBinary = fs.realpathSync(spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim());
const session = `eng80-entry-${process.pid}`;
// Keep the named server's Unix socket beneath macOS's short sun_path limit.
const root = fs.mkdtempSync('/private/tmp/e80-native-');
const evidence = path.join(root, 'evidence'); fs.mkdirSync(evidence);
const home = path.join(root, 'home'), source = path.join(root, 'source'), project = path.join(root, 'project'), nativeBin = path.join(root, 'native-bin');
for (const dir of [home, source, project, nativeBin]) fs.mkdirSync(dir);
const env = { ...process.env, ...scratchProductHomes(root, home), HOME: home, ZDOTDIR: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), TMPDIR: path.join(root, 'tmp'),
  ORG_ACTOR: `eng80-native-${process.pid}`, ORG_DIR: '', OPENAI_API_KEY: 'scratch-ui-no-network',
  PATH: `${nativeBin}:${process.env.PATH}`, HERDR_MONITOR_HOME: path.join(home, 'monitor'), HERDR_MONITOR_BIN: path.join(home, 'bin'),
  HERDR_MONITOR_CODEX: path.join(nativeBin, 'codex'), HERDR_MONITOR_CLAUDE: '-', HERDR_MONITOR_ENTRY_BIN: path.join(home, 'monitor/entry/bin'),
  HERDR_MONITOR_REPO: source, HERDR_MONITOR_PLIST: path.join(home, 'absent.plist'), RELEASE_NO_HERDR: '1', RELEASE_NO_LAUNCHD: '1', RELEASE_NO_NPM: '1',
  MONITOR_ENTRY_BYPASS: '', MONITOR_REQUEST_DIR: '', HERDR_INTEGRATION_ID: '', MONITOR_RUNTIME_DIR: path.join(home, 'entry-runtime'), MONITOR_WORKTREE_ROOT: path.join(root, 'lanes'),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SHELL: '/bin/zsh',
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local/state'), XDG_DATA_HOME: path.join(home, '.local/share'),
  HERDR_CONFIG_PATH: path.join(home, '.config/herdr/config.toml') };
assertScratchHomes(env, [root], { realHome: process.env.HOME, fleetFile: fleetPath(env) });
for (const key of ['HERDR_SOCKET_PATH', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID', 'HERDR_PLUGIN_ROOT', 'HERDR_PLUGIN_CONTEXT_JSON', 'HERDR_SESSION_NAME', 'HERDR_BIN_PATH']) delete env[key];
fs.mkdirSync(env.TMPDIR); fs.mkdirSync(env.CODEX_HOME);
fs.mkdirSync(path.dirname(env.HERDR_CONFIG_PATH), { recursive: true }); fs.writeFileSync(env.HERDR_CONFIG_PATH, '');
const calls = [];
function run(file, args, cwd = root, timeout = 20000) {
  const r = spawnSync(file, args, { cwd, env, encoding: 'utf8', timeout: loadTimeout(timeout), maxBuffer: 4 * 1024 * 1024 });
  calls.push({ file, args, status: r.status, error: r.error?.message, stdout: r.stdout, stderr: r.stderr });
  fs.writeFileSync(path.join(evidence, 'commands.json'), JSON.stringify(calls, null, 2));
  return r;
}
function ok(file, args, cwd, timeout) {
  const r = run(file, args, cwd, timeout);
  assert.equal(r.status, 0, r.error?.message ?? r.stdout + r.stderr);
  return r.stdout;
}
const herdr = (...args) => { const output = ok(herdrBinary, ['--session', session, ...args]); return output.trim() ? JSON.parse(output).result : {}; };
const herdrRun = (...args) => run(herdrBinary, ['--session', session, ...args], root, 25000);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(check, label) {
  const deadline = Date.now() + loadTimeout(10000);
  while (Date.now() < deadline) { if (check()) return; await delay(100); }
  throw new Error(`timeout waiting for ${label}`);
}
const owned = [], readinessSnippets = [];
let installed = false, pluginInstalled = false, server, serverLog, runtime, pluginRoot, outcome = 'failed', failure;
try {
  // Snapshot only the distribution used by entry, not local runtime state or
  // project instructions. Candidate build/activation remains real product code.
  copyProduct(candidate, source, { includeApps: true });
  function init(repo) {
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Entry Canary'], ['config', 'user.email', 'canary@example.invalid']]) ok('git', args, repo);
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'Pristine project\n');
    ok('git', ['add', '.'], repo); ok('git', ['commit', '-qm', 'Scratch seed'], repo);
  }
  init(source); ok('git', ['tag', 'candidate'], source); init(project);
  const before = Buffer.concat([Buffer.from('# Original scratch shell setup\n# '), Buffer.from([255, 192, 128]), Buffer.from('\n')]);
  fs.writeFileSync(path.join(home, '.zshrc'), before);
  // Transparent native transport captures the product-authored policy at the
  // real executable boundary. No replacement policy or model response exists.
  const transport = path.join(root, 'transport.mjs');
  const profile = `(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(root)}) (subpath "/dev"))`;
  fs.writeFileSync(transport, `import fs from 'node:fs';import {spawn} from 'node:child_process';
const args=process.argv.slice(2),home=${JSON.stringify(env.CODEX_HOME)},file=process.env.ENTRY_CANARY_RECEIPT;
const policyArg=args.find(a=>a.startsWith('developer_instructions='));
fs.writeFileSync(file,JSON.stringify({args,cwd:process.cwd(),policy:policyArg?JSON.parse(policyArg.slice('developer_instructions='.length)):null},null,2));
fs.writeFileSync(home+'/config.toml','[projects.'+JSON.stringify(process.cwd())+']\\ntrust_level="trusted"\\n');
const child=spawn('/usr/bin/sandbox-exec',['-p',${JSON.stringify(profile)},${JSON.stringify(binary)},...args],{stdio:'inherit',env:process.env});
for(const s of ['SIGINT','SIGTERM','SIGHUP'])process.on(s,()=>child.kill(s));child.on('error',e=>{console.error(e.message);process.exitCode=1});child.on('close',c=>process.exitCode=c??1);
`);
  fs.writeFileSync(path.join(nativeBin, 'codex'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(transport)} "$@"\n`, { mode: 0o755 });
  // Only clone transport is local. Herdr itself performs its real temporary
  // checkout, manifest build, managed move, registry and pane lifecycle.
  fs.writeFileSync(path.join(nativeBin, 'git'), `#!${process.execPath}
const fs=require('fs'),cp=require('child_process'),args=process.argv.slice(2),original=[...args];
const index=args.findIndex(a=>/^https:\\/\\/github.com\\/eng80-r89\\/plugin-entry(?:\\.git)?$/u.test(a));
fs.appendFileSync(${JSON.stringify(path.join(evidence, 'git-transport.jsonl'))},JSON.stringify({args:original,cwd:process.cwd(),local:index>=0})+'\\n');
if(index>=0)args[index]=${JSON.stringify(source)};
if(args.includes('fetch')){
  const at=args.indexOf('-C'),prefix=at>=0?['-C',args[at+1]]:[];
  const remote=cp.spawnSync(${JSON.stringify(gitBinary)},[...prefix,'remote','get-url','origin'],{encoding:'utf8'});
  if(remote.status!==0||remote.stdout.trim()!==${JSON.stringify(source)})throw new Error('network fetch forbidden in canary');
}
const r=cp.spawnSync(${JSON.stringify(gitBinary)},args,{stdio:'inherit',env:process.env});process.exit(r.status??1);
`, { mode: 0o755 });
  serverLog = fs.openSync(path.join(evidence, 'server.log'), 'a');
  server = spawn(herdrBinary, ['--session', session, 'server'], { env, cwd: root, stdio: ['ignore', serverLog, serverLog] });
  await poll(() => herdrRun('workspace', 'list').status === 0, 'isolated Herdr server');
  installed = true;
  ok(herdrBinary, ['--session', session, 'plugin', 'install', 'eng80-r89/plugin-entry', '--yes']); pluginInstalled = true;
  pluginRoot = herdr('plugin', 'list', '--plugin', 'rewt.herdr-monitor', '--json').plugins[0].plugin_root;
  const entry = JSON.parse(fs.readFileSync(path.join(env.HERDR_MONITOR_ENTRY_BIN, '.monitor-entry.json'))); runtime = entry.product;
  assert.notEqual(runtime, pluginRoot);
  const checkout = fs.readFileSync(path.join(evidence, 'git-transport.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((call) => call.local);
  const at = checkout.args.indexOf('-C');
  const buildCheckout = path.resolve(checkout.cwd, at >= 0 ? checkout.args[at + 1] : checkout.args.includes('clone') ? checkout.args.at(-1) : '.');
  assert.equal(fs.existsSync(buildCheckout), false, 'Herdr must have moved its temporary checkout');
  assert.ok(fs.existsSync(path.join(pluginRoot, 'herdr/supervisor.sh')));
  const bin = env.HERDR_MONITOR_ENTRY_BIN;
  assert.equal(ok('zsh', ['-ic', 'command -v codex']).trim(), path.join(bin, 'codex'));
  for (const name of ['.org', '.lane.json', 'AGENTS.md', 'CLAUDE.md', '.housekeeping.json']) assert.equal(fs.existsSync(path.join(project, name)), false);
  for (const role of ['worker', 'supervisor']) {
    const receipt = path.join(evidence, `${role}.json`), ready = path.join(root, `${role}-shell-ready`);
    env.ENTRY_CANARY_RECEIPT = receipt;
    // A normal scratch user shell sources the installer-created startup files.
    // This readiness marker supplies no policy and does not prepend entry PATH.
    const readinessSnippet = Buffer.from(`\n: > ${quote(ready)}\n`);
    readinessSnippets.push(readinessSnippet); fs.appendFileSync(path.join(home, '.zshrc'), readinessSnippet);
    const args = ['workspace', 'create', '--cwd', project, '--label', `entry-canary-${role}-${process.pid}`, '--no-focus'];
    for (const [key, value] of Object.entries(env)) {
      if (['HOME', 'ZDOTDIR', 'CODEX_HOME', 'TMPDIR', 'PATH', 'ORG_ACTOR', 'ORG_DIR', 'OPENAI_API_KEY', 'ENTRY_CANARY_RECEIPT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key) || /^(HERDR_MONITOR|MONITOR_)/.test(key)) args.push('--env', `${key}=${value}`);
    }
    const created = herdr(...args); owned.push(created.workspace.workspace_id);
    fs.writeFileSync(path.join(evidence, 'ownership.json'), JSON.stringify(owned));
    let pane = created.root_pane.pane_id;
    await poll(() => fs.existsSync(ready), 'fresh scratch shell');
    if (role === 'worker') {
      const started = herdrRun('agent', 'start', `entry-canary-${process.pid}`, '--kind', 'codex', '--pane', pane, '--timeout', String(loadTimeout(15000)), '--', '--no-alt-screen');
      await poll(() => fs.existsSync(receipt), 'native Codex entry receipt');
      assert.equal(started.status, 0, started.stdout + started.stderr);
    } else {
      // Deliberately omit --cwd: this is the manifest boundary that starts in
      // pluginRoot, while the selected workspace belongs to another project.
      fs.writeFileSync(path.join(evidence, 'selected-workspace.json'), JSON.stringify(herdr('workspace', 'get', created.workspace.workspace_id), null, 2));
      const probe = path.join(root, 'context-probe.cjs');
      fs.writeFileSync(probe, `require('fs').appendFileSync(${JSON.stringify(path.join(evidence, 'invocation-context.jsonl'))},JSON.stringify({cwd:process.cwd(),context:process.env.HERDR_PLUGIN_CONTEXT_JSON,workspace:process.env.HERDR_WORKSPACE_ID,pane:process.env.HERDR_PANE_ID})+'\\n');\n`);
      const opened = herdr('plugin', 'pane', 'open', '--plugin', 'rewt.herdr-monitor', '--entrypoint', 'supervisor', '--workspace', created.workspace.workspace_id, '--no-focus', '--env', `ENTRY_CANARY_RECEIPT=${receipt}`, '--env', `NODE_OPTIONS=--require=${probe}`);
      fs.writeFileSync(path.join(evidence, 'manifest-pane.json'), JSON.stringify(opened, null, 2));
      pane = opened.plugin_pane?.pane?.pane_id;
      assert.ok(pane, 'manifest pane response must expose its pane id');
      assert.equal(opened.plugin_pane.pane.cwd, pluginRoot, 'the manifest must exercise Herdr default plugin cwd');
      await poll(() => fs.existsSync(receipt), 'supervisor entry receipt');
      await poll(() => {
        const r = herdrRun('agent', 'get', pane);
        const agent = r.status === 0 ? JSON.parse(r.stdout).result.agent : null;
        return agent?.agent === 'codex' && ['idle', 'done'].includes(agent.agent_status) && agent.foreground_cwd === project;
      }, 'native supervisor UI');
    }
    const delivered = JSON.parse(fs.readFileSync(receipt));
    assert.ok(delivered.policy?.includes('Herdr Monitor installed project-entry policy'));
    assert.ok(delivered.policy.includes(path.join(runtime, 'discovery/policy.mjs')));
    assert.match(delivered.policy, role === 'worker' ? /Never start project housekeeping/u : /At session entry, start the default project schedule/u);
    assert.equal(delivered.cwd === project, role === 'supervisor');
    fs.writeFileSync(path.join(evidence, `${role}-screen.txt`), ok(herdrBinary, ['--session', session, 'pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', '80']));
    herdr('workspace', 'close', owned.at(-1)); owned.pop();
  }
  assert.ok(fs.existsSync(path.join(project, '.org/events.jsonl')));
  assert.equal(fs.existsSync(path.join(pluginRoot, '.org')), false, 'plugin checkout must never become the selected project');
  assert.equal(fs.existsSync(path.join(project, '.org/housekeeping')), false, 'policy delivery never starts a loop in this canary');
  ok(process.execPath, [path.join(pluginRoot, 'herdr/entry-install.mjs'), '--remove']); installed = false;
  assert.equal(fs.existsSync(path.join(bin, 'codex')), false); assert.equal(fs.existsSync(path.join(bin, 'monitor-codex')), false);
  assert.equal(fs.existsSync(path.join(home, '.zshenv')), false);
  assert.equal(ok('zsh', ['-ic', 'command -v codex']).trim(), path.join(nativeBin, 'codex'));
  let remaining = fs.readFileSync(path.join(home, '.zshrc'));
  for (const snippet of readinessSnippets) {
    const index = remaining.indexOf(snippet); assert.ok(index >= 0);
    remaining = Buffer.concat([remaining.subarray(0, index), remaining.subarray(index + snippet.length)]);
  }
  fs.writeFileSync(path.join(home, '.zshrc'), remaining);
  assert.deepEqual(remaining, before);
  fs.writeFileSync(path.join(evidence, 'shell-restore.json'), JSON.stringify({ before: before.toString('base64'), restored: remaining.toString('base64'), byteIdentical: remaining.equals(before) }, null, 2));
  for (const name of ['.bashrc', '.bash_profile']) assert.equal(fs.existsSync(path.join(home, name)), false);
  ok(herdrBinary, ['--session', session, 'plugin', 'uninstall', 'rewt.herdr-monitor']); pluginInstalled = false;
  outcome = 'passed';
} catch (error) {
  failure = error.stack;
  for (const workspace of owned) {
    const listed = herdrRun('pane', 'list', '--workspace', workspace);
    fs.writeFileSync(path.join(evidence, `failure-${workspace}-panes.json`), listed.stdout || listed.stderr);
    if (listed.status === 0) {
      for (const pane of JSON.parse(listed.stdout).result.panes) {
        const read = herdrRun('pane', 'read', pane.pane_id, '--source', 'recent-unwrapped', '--lines', '100');
        fs.writeFileSync(path.join(evidence, `failure-${pane.pane_id.replace(':', '-')}.txt`), read.stdout || read.stderr);
      }
    }
  }
}
finally {
  const cleanup = [];
  for (const workspace of owned.reverse()) { const r = herdrRun('workspace', 'close', workspace); if (r.status !== 0) cleanup.push(r.stderr || r.stdout); }
  if (installed) { const r = run(process.execPath, [path.join(pluginRoot ?? source, 'herdr/entry-install.mjs'), '--remove']); if (r.status !== 0) cleanup.push(r.stderr || r.stdout); }
  if (pluginInstalled) { const r = herdrRun('plugin', 'uninstall', 'rewt.herdr-monitor'); if (r.status !== 0) cleanup.push(r.stderr || r.stdout); }
  if (server) {
    // This named server and its scratch home were created by this test alone.
    const r = herdrRun('server', 'stop'); if (r.status !== 0) cleanup.push(r.stderr || r.stdout);
    await poll(() => server.exitCode !== null || server.signalCode !== null, 'owned test server shutdown').catch((error) => { server.kill('SIGTERM'); cleanup.push(error.message); });
  }
  if (serverLog !== undefined) fs.closeSync(serverLog);
  if (cleanup.length) { outcome = 'failed'; failure = [failure, ...cleanup].filter(Boolean).join('\n'); }
  fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify({ outcome, failure, root, candidate, binary, runtime, pluginRoot, session, cleanup,
    coverage: 'real Herdr temporary plugin install/build/move, native worker start, manifest supervisor pane from unrelated project, restore and uninstall; no inference or housekeeping loop',
    excluded: ['GitHub network clone (local transport)', 'absolute native binary paths', 'desktop/remote entry', 'npm dependency downloads', 'launchd'] }, null, 2));
  console.log(`${outcome.toUpperCase()}: ${path.join(evidence, 'summary.json')}`);
  if (failure) console.error(failure);
  process.exitCode = outcome === 'passed' ? 0 : 1;
}
