#!/usr/bin/env node
// The adoption guide's repeatable scratch exercise. No inference or live Herdr.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'native-codex': { type: 'string' }, 'npm-cache': { type: 'string' } } });
if (!values['native-codex'] || !path.isAbsolute(values['native-codex'])) throw new Error('supply --native-codex ABSOLUTE_NATIVE_EXECUTABLE');
const native = fs.realpathSync(values['native-codex']);
fs.accessSync(native, fs.constants.X_OK);
const source = path.resolve(import.meta.dirname, '../..');
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-adoption-'));
const home = path.join(root, 'home'), product = path.join(root, 'product');
// The unrelated project has its own parent: it cannot inherit product config.
const projects = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'adopter-projects-'));
const project = path.join(projects, 'hello'), evidence = path.join(root, 'evidence');
for (const dir of [home, product, project, evidence]) fs.mkdirSync(dir, { recursive: true });
const calls = [];
// A child-only home and clean environment; never overwrite the operator's HOME.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(ORG_|LANE_|MONITOR_|HERDR_|RELEASE_|GIT_|CODEX_|CLAUDE_|OPENAI_|ANTHROPIC_|XDG_|npm_config_)/u.test(name)));
Object.assign(env, {
  HOME: home, ZDOTDIR: home, CODEX_HOME: path.join(home, '.codex'),
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local/state'),
  XDG_DATA_HOME: path.join(home, '.local/share'),
  ORG_ACTOR: `adoption-rehearsal-${process.pid}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  HERDR_MONITOR_HOME: path.join(home, '.local/share/herdr-monitor'),
  HERDR_MONITOR_BIN: path.join(home, '.local/bin'), HERDR_MONITOR_CLAUDE: '-',
  HERDR_MONITOR_REPO: product, RELEASE_NO_LAUNCHD: '1',
  MONITOR_RUNTIME_DIR: path.join(home, 'entry-queue'), MONITOR_WORKTREE_ROOT: path.join(projects, 'lanes'),
  npm_config_cache: path.join(home, '.npm'),
});
fs.mkdirSync(env.CODEX_HOME);
const write = (file, content, mode) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, mode ? { mode } : undefined); };
function run(file, args, cwd = project, extra = {}, timeout = 180_000) {
  const result = spawnSync(file, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
  calls.push({ file, args, cwd, status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr });
  write(path.join(evidence, 'commands.json'), JSON.stringify(calls, null, 2) + '\n');
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `${file}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const git = (cwd, ...args) => run('git', ['-C', cwd, ...args], cwd);
const release = (...args) => run('bash', [path.join(product, 'herdr/release.sh'), ...args], product);
let outcome = 'failed', failure, head, context, sourceCommit;
try {
  console.log(`Evidence: ${evidence}`);
  // Normal product prerequisites, inherited from the host toolchain. The real
  // worker check below must also compile/link the product's lifetime owner.
  write(path.join(evidence, 'prerequisites.txt'),
    run('/usr/bin/cc', ['--version']) + '\n' + run('python3', ['--version']) + '\n');
  // Exercise release.sh's actual Python JSON parsing without touching a live
  // Herdr server or machine registry. Linking over an existing entry is refused,
  // so a missing Python discovery result cannot silently pass an upgrade.
  const pluginState = path.join(home, 'scratch-plugin-root');
  const scratchHerdr = path.join(root, 'herdr.cjs');
  write(scratchHerdr, `#!${process.execPath}
const fs = require('fs'), assert = require('assert/strict');
const args = process.argv.slice(2), state = ${JSON.stringify(pluginState)};
fs.appendFileSync(${JSON.stringify(path.join(evidence, 'herdr-commands.jsonl'))}, JSON.stringify(args)+'\\n');
if (args[0] !== 'plugin') { console.log(JSON.stringify({result:[]})); process.exit(0); }
if (args[1] === 'list') console.log(JSON.stringify({result:{plugins:fs.existsSync(state) ? [{plugin_root:fs.readFileSync(state,'utf8')}] : []}}));
else if (args[1] === 'link') { assert.ok(!fs.existsSync(state), 'unlink existing registration before linking'); fs.writeFileSync(state,fs.realpathSync(args[2])); }
else if (args[1] === 'unlink') { assert.ok(fs.existsSync(state)); fs.unlinkSync(state); }
else throw new Error('unsupported scratch plugin command');
`, 0o755);
  env.HERDR_BIN_PATH = scratchHerdr;
  const registered = () => fs.readFileSync(pluginState, 'utf8');
  // Optional cached tarballs are copied by integrity from pinned lockfiles only.
  // This reads no account/configuration files and never writes the input cache.
  if (values['npm-cache']) {
    const cache = path.resolve(values['npm-cache']);
    for (const module of ['console', 'mcp']) {
      const lock = JSON.parse(fs.readFileSync(path.join(source, module, 'package-lock.json')));
      for (const entry of Object.values(lock.packages)) {
        if (!entry.integrity?.startsWith('sha512-')) continue;
        const hash = Buffer.from(entry.integrity.slice(7), 'base64').toString('hex');
        const rel = path.join('_cacache/content-v2/sha512', hash.slice(0, 2), hash.slice(2, 4), hash.slice(4));
        const from = path.join(cache, rel), to = path.join(env.npm_config_cache, rel);
        if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
      }
    }
    env.npm_config_offline = 'true';
  }
  const archive = path.join(root, 'source.tar');
  sourceCommit = git(source, 'rev-parse', 'HEAD');
  git(source, 'archive', 'HEAD', '-o', archive);
  run('tar', ['-xf', archive, '-C', product], root);
  for (const repo of [product, project]) {
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Adoption rehearsal');
    git(repo, 'config', 'user.email', 'adoption@example.invalid');
  }
  git(product, 'add', '.'); git(product, 'commit', '-qm', 'Inspected scratch candidate');
  git(product, 'tag', 'adoption-a');
  write(path.join(product, 'scratch-version'), 'second scratch candidate\n');
  git(product, 'add', '.'); git(product, 'commit', '-qm', 'Second scratch candidate'); git(product, 'tag', 'adoption-b');
  write(path.join(project, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}\n');
  write(path.join(project, 'hello.mjs'), "export const greeting = 'Hello';\n");
  write(path.join(project, 'test/hello.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {greeting} from '../hello.mjs'; test('greeting', () => assert.equal(greeting, 'Hello'));\n");
  git(project, 'add', '.'); git(project, 'commit', '-qm', 'Initial unrelated project');
  const original = Buffer.from('# Existing scratch shell bytes\n');
  write(path.join(home, '.zshrc'), original, 0o600);
  // A scripted worker at the native boundary. Sandbox requests go to actual
  // native Codex. The worker uses only the policy's supplied command prefix.
  const scripted = path.join(root, 'native-codex.cjs');
  write(scripted, `#!${process.execPath}
const fs = require('fs'), path = require('path'), cp = require('child_process'), assert = require('assert/strict');
const args = process.argv.slice(2);
if (args[0] === 'sandbox' || args.includes('--version')) {
  // The product's native validation owner sends its readiness receipt on fd 3.
  const stdio = args[0] === 'sandbox' && process.platform === 'darwin' ? ['inherit','inherit','inherit',3] : 'inherit';
  const result = cp.spawnSync(${JSON.stringify(native)}, args, {stdio, timeout:150000});
  process.exit(result.status ?? 1);
}
const policyArg = args.find(a => a.startsWith('developer_instructions='));
assert.ok(policyArg, 'installed entry must supply policy');
const policy = JSON.parse(policyArg.slice('developer_instructions='.length));
fs.writeFileSync(${JSON.stringify(path.join(evidence, 'worker-policy.txt'))}, policy);
assert.ok(policy.includes('You are a worker'));
assert.ok(policy.includes('Never start project housekeeping'));
const client = policy.match(/'([^'\\n]+\\/discovery\\/client\\.mjs)'/)[1];
function monitor(op, text) {
  const r = cp.spawnSync(process.execPath, [client, op, ...(text ? [text] : [])], {encoding:'utf8',timeout:175000,maxBuffer:8*1024*1024});
  fs.appendFileSync(${JSON.stringify(path.join(evidence, 'worker-commands.txt'))}, op+'\\n'+r.stdout+r.stderr);
  assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout;
}
const c = JSON.parse(monitor('start', 'Change the greeting to Bonjour and validate it'));
fs.writeFileSync(${JSON.stringify(path.join(evidence, 'worker-context.json'))}, JSON.stringify(c,null,2));
assert.notEqual(c.workspace, c.canonical);
assert.ok(fs.readFileSync(c.brief, 'utf8').includes(c.run));
fs.writeFileSync('hello.mjs', "export const greeting = 'Bonjour';\\n");
fs.writeFileSync('test/hello.test.mjs', "import test from 'node:test'; import assert from 'node:assert/strict'; import {greeting} from '../hello.mjs'; test('greeting', () => assert.equal(greeting, 'Bonjour'));\\n");
fs.mkdirSync(path.dirname(c.report), {recursive:true});
fs.writeFileSync(c.report, '---\\nrun: '+c.run+'\\noutcome: done\\nsummary: Changed and tested the greeting.\\nheadline: The greeting is ready\\nblockers: []\\nproposals: []\\nlearnings: []\\nartifacts: []\\ndecisions: []\\nquestions: []\\nchallenges: []\\n---\\n');
const record = path.join(path.dirname(path.dirname(client)), 'bin/org.mjs');
const checked = cp.spawnSync(process.execPath, [record,'check',c.report], {encoding:'utf8',timeout:10000});
assert.equal(checked.status,0,checked.stderr);
monitor('commit','Change the greeting to Bonjour'); monitor('check'); monitor('promote'); monitor('finish');
`, 0o755);
  env.HERDR_MONITOR_CODEX = scripted;
  release('build', 'adoption-a');
  assert.equal(fs.existsSync(path.join(home, '.zshenv')), false, 'build must not install entry');
  release('activate', 'adoption-a'); release('status');
  assert.equal(registered(), path.join(env.HERDR_MONITOR_HOME, 'releases/adoption-a'));
  const entryBin = path.join(env.HERDR_MONITOR_HOME, 'entry/bin');
  const discovered = run('zsh', ['-ic', 'command -v codex; command -v monitor-codex']);
  assert.equal(discovered, `${entryBin}/codex\n${entryBin}/monitor-codex`);
  for (const file of ['AGENTS.md', 'CLAUDE.md', '.lane.json', '.org']) assert.equal(fs.existsSync(path.join(project, file)), false, `pristine ${file}`);
  // Automatic entry requires a terminal; an interactive shell with piped stdio
  // is deliberately a passthrough. BSD/util-linux script supplies the real PTY.
  const shell = ['zsh', '-ic', 'codex'];
  const pty = process.platform === 'darwin' ? ['-q', '/dev/null', ...shell]
    : ['-q', '-e', '-c', "zsh -ic 'codex'", '/dev/null'];
  run('script', pty, project, {}, 240_000);
  context = JSON.parse(fs.readFileSync(path.join(evidence, 'worker-context.json')));
  assert.match(fs.readFileSync(path.join(project, 'hello.mjs'), 'utf8'), /Bonjour/);
  head = git(project, 'rev-parse', 'HEAD');
  assert.equal(git(project, 'status', '--porcelain'), '');
  assert.equal(git(context.workspace, 'rev-parse', 'HEAD'), head, 'actual fast-forward');
  const active = path.join(env.HERDR_MONITOR_HOME, 'releases/adoption-a');
  const record = (...args) => run(process.execPath, [path.join(active, 'bin/org.mjs'), ...args]);
  const item = JSON.parse(record('show', context.item, '--json'));
  assert.equal(item.status, 'done');
  assert.ok(fs.existsSync(path.join(project, '.org/reports', `${context.run}.md`)));
  const routing = JSON.parse(record('show', context.routing.question, '--json'));
  assert.ok(!routing.closed && !routing.meta?.answer, 'routing preference must remain unanswered');
  write(path.join(evidence, 'record.json'), record('status', '--json'));
  // No server belongs to this mechanical exercise. Supply an empty read-only
  // topology instead of reading or starting the operator's default server.
  const emptyHerdr = path.join(root, 'empty-herdr.cjs');
  write(emptyHerdr, `#!${process.execPath}\nconst args=process.argv.slice(2); if(args[1]!=='list'){console.error('scratch Herdr permits list only');process.exit(1);} console.log(JSON.stringify({result:{workspaces:[],tabs:[],panes:[],agents:[]}}));\n`, 0o755);
  write(path.join(evidence, 'console.txt'), run(process.execPath, [path.join(active, 'console/app.mjs'), '--modern', '--folder', project, '--print', '100x34'], project, { HERDR_BIN_PATH: emptyHerdr }));
  write(path.join(evidence, 'supervisor.txt'), run(process.execPath, [path.join(active, 'supervisor/supervisor.mjs'), 'brief']));
  run(process.execPath, [path.join(active, 'housekeeping/housekeeping.mjs'), '--once', '--dry-run', '--herdr', emptyHerdr, '--state-dir', path.join(project, '.lane/housekeeping-preview')]);
  // Separate bounded mechanical exercise for the reviewed supervisor cycle.
  // It scripts only Herdr/model transport; Git, record, review, watch and queue
  // code are actual product commands. Its output states that limitation.
  write(path.join(evidence, 'reviewed-cycle.txt'), run(process.execPath, [path.join(active, 'acceptance/supervisor.mjs'), active], project, {}, 240_000));
  release('build', 'adoption-b'); release('activate', 'adoption-b');
  assert.equal(fs.realpathSync(path.join(env.HERDR_MONITOR_HOME, 'current')), path.join(env.HERDR_MONITOR_HOME, 'releases/adoption-b'));
  assert.equal(registered(), path.join(env.HERDR_MONITOR_HOME, 'releases/adoption-b'));
  release('rollback');
  assert.equal(fs.realpathSync(path.join(env.HERDR_MONITOR_HOME, 'current')), active);
  assert.equal(registered(), active);
  release('restore');
  assert.equal(fs.existsSync(pluginState), false, 'restore must discover and unlink the release plugin');
  assert.deepEqual(fs.readFileSync(path.join(home, '.zshrc')), original);
  assert.equal(fs.statSync(path.join(home, '.zshrc')).mode & 0o777, 0o600);
  for (const file of ['.zshenv', '.bashrc', '.bash_profile']) assert.equal(fs.existsSync(path.join(home, file)), false);
  for (const file of ['codex', 'monitor-codex']) assert.equal(fs.existsSync(path.join(entryBin, file)), false);
  for (const file of ['record', 'org', 'lane']) assert.equal(fs.existsSync(path.join(env.HERDR_MONITOR_BIN, file)), false);
  assert.equal(git(project, 'rev-parse', 'HEAD'), head);
  assert.ok(fs.existsSync(path.join(project, '.org/events.jsonl')));
  outcome = 'passed';
} catch (error) { failure = error.stack; }
write(path.join(evidence, 'summary.json'), JSON.stringify({ outcome, failure, root, project, head, run: context?.run,
  source_commit: sourceCommit,
  coverage: 'host compiler/Python prerequisite checks, scratch install and pinned dependencies, activation, Python-backed plugin discovery/relink/unlink against a local fixture, fresh shell auto-entry, scripted task, actual native sandbox check and local promotion, record ingestion, console, supervisor cold start, dry-run housekeeping, scripted reviewed cycle, upgrade, rollback, shell restoration',
  excluded: ['model judgment', 'live Herdr transport', 'GitHub distribution', 'launchd', 'Linux and desktop/remote transport'],
}, null, 2) + '\n');
console.log(`${outcome.toUpperCase()}: ${path.join(evidence, 'summary.json')}`);
if (failure) { console.error(failure); process.exitCode = 1; }
