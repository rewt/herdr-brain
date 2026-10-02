#!/usr/bin/env node
// Native Herdr entry canary. No inference, prompts, live install or launchd:
// the actual Codex UI runs under a scratch-only write / no-network boundary.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { quote } from '../discovery/runtime.mjs';

const { values } = parseArgs({ options: { candidate: { type: 'string' }, 'native-codex': { type: 'string' } } });
if (!values.candidate || !values['native-codex']) throw new Error('usage: node acceptance/plugin-entry.mjs --candidate FINAL_PRODUCT_DIRECTORY --native-codex ABSOLUTE_NATIVE_CODEX');
if (process.env.HERDR_ENV !== '1') throw new Error('run from an authorized Herdr pane');
if (process.platform !== 'darwin') throw new Error('native UI canary currently requires macOS sandbox-exec');
const candidate = fs.realpathSync(values.candidate), binary = fs.realpathSync(values['native-codex']);
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-plugin-entry-'));
const evidence = path.join(root, 'evidence'); fs.mkdirSync(evidence);
const home = path.join(root, 'home'), source = path.join(root, 'source'), project = path.join(root, 'project'), nativeBin = path.join(root, 'native-bin');
for (const dir of [home, source, project, nativeBin]) fs.mkdirSync(dir);
const env = { ...process.env, HOME: home, ZDOTDIR: home, CODEX_HOME: path.join(home, '.codex'), TMPDIR: path.join(root, 'tmp'),
  ORG_ACTOR: 'eng80-native-herdr-canary', ORG_DIR: '', OPENAI_API_KEY: 'scratch-ui-no-network',
  PATH: `${nativeBin}:${process.env.PATH}`, HERDR_MONITOR_HOME: path.join(home, 'monitor'), HERDR_MONITOR_BIN: path.join(home, 'bin'),
  HERDR_MONITOR_CODEX: path.join(nativeBin, 'codex'), HERDR_MONITOR_CLAUDE: '-', HERDR_MONITOR_ENTRY_BIN: path.join(home, 'monitor/entry/bin'),
  HERDR_MONITOR_REPO: source, HERDR_MONITOR_PLIST: path.join(home, 'absent.plist'), RELEASE_NO_HERDR: '1', RELEASE_NO_LAUNCHD: '1', RELEASE_NO_NPM: '1',
  MONITOR_ENTRY_BYPASS: '', MONITOR_REQUEST_DIR: '', HERDR_INTEGRATION_ID: '', MONITOR_RUNTIME_DIR: path.join(home, 'entry-runtime'), MONITOR_WORKTREE_ROOT: path.join(root, 'lanes'),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
fs.mkdirSync(env.TMPDIR); fs.mkdirSync(env.CODEX_HOME);
const calls = [];
function run(file, args, cwd = root, timeout = 20000) {
  const r = spawnSync(file, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  calls.push({ file, args, status: r.status, error: r.error?.message, stdout: r.stdout, stderr: r.stderr });
  fs.writeFileSync(path.join(evidence, 'commands.json'), JSON.stringify(calls, null, 2));
  return r;
}
function ok(file, args, cwd, timeout) {
  const r = run(file, args, cwd, timeout);
  assert.equal(r.status, 0, r.error?.message ?? r.stdout + r.stderr);
  return r.stdout;
}
const herdr = (...args) => { const output = ok('herdr', args); return output.trim() ? JSON.parse(output).result : {}; };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (check()) return; await delay(100); }
  throw new Error(`timeout waiting for ${label}`);
}
const owned = [], readinessSnippets = [];
let installed = false, outcome = 'failed', failure;
try {
  // Snapshot only the distribution used by entry, not local runtime state or
  // project instructions. Candidate build/activation remains real product code.
  for (const name of ['bin', 'lib', 'lanes', 'discovery', 'herdr', 'housekeeping', 'dispatch', 'watch', 'promote', 'supervisor', 'herdr-plugin.toml']) {
    fs.cpSync(path.join(candidate, name), path.join(source, name), { recursive: true,
      filter: (file) => !file.split(path.sep).includes('node_modules') });
  }
  function init(repo) {
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Entry Canary'], ['config', 'user.email', 'canary@example.invalid']]) ok('git', args, repo);
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'Pristine project\n');
    ok('git', ['add', '.'], repo); ok('git', ['commit', '-qm', 'Scratch seed'], repo);
  }
  init(source); ok('git', ['tag', 'candidate'], source); init(project);
  const before = '# Original scratch shell setup\n';
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
  const release = (...args) => ok('bash', [path.join(source, 'herdr/release.sh'), ...args]);
  release('build', 'candidate');
  assert.equal(fs.existsSync(path.join(home, '.zshenv')), false);
  release('activate', 'candidate'); installed = true;
  const bin = env.HERDR_MONITOR_ENTRY_BIN;
  assert.equal(ok('zsh', ['-ic', 'command -v codex']).trim(), path.join(bin, 'codex'));
  for (const name of ['.org', '.lane.json', 'AGENTS.md', 'CLAUDE.md', '.housekeeping.json']) assert.equal(fs.existsSync(path.join(project, name)), false);
  for (const role of ['worker', 'supervisor']) {
    const receipt = path.join(evidence, `${role}.json`), ready = path.join(root, `${role}-shell-ready`);
    env.ENTRY_CANARY_RECEIPT = receipt;
    // A normal scratch user shell sources the installer-created startup files.
    // This readiness marker supplies no policy and does not prepend entry PATH.
    const readinessSnippet = `\n: > ${quote(ready)}\n`;
    readinessSnippets.push(readinessSnippet); fs.appendFileSync(path.join(home, '.zshrc'), readinessSnippet);
    const args = ['workspace', 'create', '--cwd', project, '--label', `entry-canary-${role}-${process.pid}`, '--no-focus'];
    for (const [key, value] of Object.entries(env)) {
      if (['HOME', 'ZDOTDIR', 'CODEX_HOME', 'TMPDIR', 'PATH', 'ORG_ACTOR', 'ORG_DIR', 'OPENAI_API_KEY', 'ENTRY_CANARY_RECEIPT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key) || /^(HERDR_MONITOR|MONITOR_)/.test(key)) args.push('--env', `${key}=${value}`);
    }
    const created = herdr(...args); owned.push(created.workspace.workspace_id);
    fs.writeFileSync(path.join(evidence, 'ownership.json'), JSON.stringify(owned));
    const pane = created.root_pane.pane_id;
    await poll(() => fs.existsSync(ready), 'fresh scratch shell');
    if (role === 'worker') {
      const started = run('herdr', ['agent', 'start', `entry-canary-${process.pid}`, '--kind', 'codex', '--pane', pane, '--timeout', '15000', '--', '--no-alt-screen'], root, 20000);
      await poll(() => fs.existsSync(receipt), 'native Codex entry receipt');
      assert.equal(started.status, 0, started.stdout + started.stderr);
    } else {
      // Supervisor role is chosen explicitly; raw native starts stay workers.
      herdr('pane', 'run', pane, `bash ${quote(path.join(env.HERDR_MONITOR_HOME, 'releases/candidate/herdr/supervisor.sh'))} --no-alt-screen`);
      await poll(() => fs.existsSync(receipt), 'supervisor entry receipt');
      await poll(() => {
        const r = run('herdr', ['agent', 'get', pane]);
        const agent = r.status === 0 ? JSON.parse(r.stdout).result.agent : null;
        return agent?.agent === 'codex' && ['idle', 'done'].includes(agent.agent_status) && agent.foreground_cwd === project;
      }, 'native supervisor UI');
    }
    const delivered = JSON.parse(fs.readFileSync(receipt));
    assert.ok(delivered.policy?.includes('Herdr Monitor installed project-entry policy'));
    assert.ok(delivered.policy.includes(path.join(env.HERDR_MONITOR_HOME, 'releases/candidate/discovery/policy.mjs')));
    assert.match(delivered.policy, role === 'worker' ? /Never start project housekeeping/u : /At session entry, start the default project schedule/u);
    assert.equal(delivered.cwd === project, role === 'supervisor');
    fs.writeFileSync(path.join(evidence, `${role}-screen.txt`), ok('herdr', ['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', '80']));
    herdr('workspace', 'close', owned.at(-1)); owned.pop();
  }
  assert.ok(fs.existsSync(path.join(project, '.org/events.jsonl')));
  assert.equal(fs.existsSync(path.join(project, '.org/housekeeping')), false, 'policy delivery never starts a loop in this canary');
  release('restore'); installed = false;
  assert.equal(fs.existsSync(path.join(bin, 'codex')), false); assert.equal(fs.existsSync(path.join(bin, 'monitor-codex')), false);
  assert.equal(fs.existsSync(path.join(home, '.zshenv')), false);
  assert.equal(ok('zsh', ['-ic', 'command -v codex']).trim(), path.join(nativeBin, 'codex'));
  let remaining = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
  for (const snippet of readinessSnippets) remaining = remaining.replace(snippet, '');
  fs.writeFileSync(path.join(home, '.zshrc'), remaining);
  assert.equal(remaining, before);
  for (const name of ['.bashrc', '.bash_profile']) assert.equal(fs.existsSync(path.join(home, name)), false);
  outcome = 'passed';
} catch (error) { failure = error.stack; }
finally {
  const cleanup = [];
  for (const workspace of owned.reverse()) { const r = run('herdr', ['workspace', 'close', workspace]); if (r.status !== 0) cleanup.push(r.stderr || r.stdout); }
  if (installed) { const r = run('bash', [path.join(source, 'herdr/release.sh'), 'restore']); if (r.status !== 0) cleanup.push(r.stderr || r.stdout); }
  if (cleanup.length) { outcome = 'failed'; failure = [failure, ...cleanup].filter(Boolean).join('\n'); }
  fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify({ outcome, failure, root, candidate, binary, cleanup,
    coverage: 'real native Herdr worker start and native supervisor UI; installed policy receipt; no inference or housekeeping loop',
    excluded: ['absolute native binary paths', 'desktop/remote entry', 'plugin linking', 'npm dependency build', 'launchd'] }, null, 2));
  console.log(`${outcome.toUpperCase()}: ${path.join(evidence, 'summary.json')}`);
  if (failure) console.error(failure);
  process.exitCode = outcome === 'passed' ? 0 : 1;
}
