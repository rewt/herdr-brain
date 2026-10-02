#!/usr/bin/env node
// Explicit real-session smoke test, outside npm test. Product and unrelated
// projects have separate scratch roots; no checkout or AGENTS.md is nearby.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../', import.meta.url));
const { values: opt } = parseArgs({ options: { binary: { type: 'string' }, model: { type: 'string', default: 'gpt-5.6-luna' },
  effort: { type: 'string', default: 'low' }, 'skip-live': { type: 'boolean' }, keep: { type: 'boolean' } } });
const binary = opt.binary ?? spawnSync('which', ['codex'], { encoding: 'utf8' }).stdout.trim();
const install = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-installed-'));
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-projects-'));
const evidence = path.join(scratch, 'evidence'); fs.mkdirSync(evidence);
const results = [], usage = [];
const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (/^(ORG_|LANE_|MONITOR_|GIT_|HERDR_)/u.test(key)) delete cleanEnv[key];
Object.assign(cleanEnv, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  MONITOR_WORKTREE_ROOT: path.join(scratch, 'lanes'), MONITOR_RUNTIME_DIR: path.join(scratch, 'runtime') });
function run(exe, args, cwd, extra = {}) {
  const r = spawnSync(exe, args, { cwd, env: { ...cleanEnv, ...extra }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status) throw new Error(r.error?.message ?? (r.stderr || r.stdout).trim());
  return r.stdout.trim();
}
const git = (repo, args) => run('git', ['-C', repo, ...args], repo);
function repo(name) {
  const p = path.join(scratch, name); fs.mkdirSync(p);
  git(p, ['init', '-q', '-b', 'main']); git(p, ['config', 'user.name', 'Discovery acceptance']);
  git(p, ['config', 'user.email', 'acceptance@example.invalid']);
  fs.writeFileSync(path.join(p, 'README.md'), 'An unrelated greetings project.\n');
  fs.writeFileSync(path.join(p, 'greetings.mjs'), "export const greetings = {\n  en: 'Hello',\n};\n");
  fs.mkdirSync(path.join(p, 'test'));
  fs.writeFileSync(path.join(p, 'test/greetings.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {greetings} from '../greetings.mjs'; test('English stays',()=>assert.equal(greetings.en,'Hello'));\n");
  git(p, ['add', '.']); git(p, ['commit', '-qm', 'Seed unrelated project']);
  return p;
}
async function check(name, fn) {
  try { await fn(); results.push({ name, status: 'PASS' }); }
  catch (e) { results.push({ name, status: 'FAIL', error: e.message }); }
  console.log(`${results.at(-1).status.padEnd(7)} ${name}${results.at(-1).error ? `: ${results.at(-1).error}` : ''}`);
}
const product = path.join(install, 'product'); fs.mkdirSync(product);
for (const directory of ['bin', 'lib', 'lanes', 'dispatch', 'watch', 'housekeeping', 'supervisor', 'discovery']) {
  fs.cpSync(path.join(source, directory), path.join(product, directory), { recursive: true, filter: (p) => !['test', 'node_modules'].includes(path.basename(p)) });
}
fs.copyFileSync(path.join(source, 'package.json'), path.join(product, 'package.json'));
const bin = path.join(install, 'bin');
run(process.execPath, [path.join(product, 'discovery/install.mjs'), '--bin', bin, '--codex', binary], scratch);
const record = (p, args, actor = 'acceptance-agent') => run(process.execPath, [path.join(product, 'bin/org.mjs'), ...args], p, { ORG_DIR: '', ORG_ACTOR: actor });
async function live(p, name, task) {
  const home = path.join(scratch, 'auth', name); fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const auth = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'auth.json');
  fs.copyFileSync(auth, path.join(home, 'auth.json')); fs.chmodSync(path.join(home, 'auth.json'), 0o600);
  const prompt = `Do the following bounded task as an entering coding agent in this unrelated project. Changes only in this scratch project and your assigned scratch checkout. Never push or operate Herdr. Do not read other project repositories or records; do not scan parent directories for instructions. Read policy delivered by the installed product and files in your own checkout. Do not invent or answer operator preferences. In the final response identify your actual policy source, lane branch, record IDs and validation/promotion evidence.\n\nTask: ${task}`;
  fs.writeFileSync(path.join(evidence, `${name}.prompt.txt`), prompt);
  const output = fs.openSync(path.join(evidence, `${name}.jsonl`), 'w');
  const errors = fs.openSync(path.join(evidence, `${name}.stderr`), 'w');
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(bin, 'monitor-codex'), ['--', 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--sandbox', 'workspace-write', '--json', '--model', opt.model, '-c', `model_reasoning_effort=${opt.effort}`,
      '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      '-c', 'features.shell_snapshot=false', '-c', 'web_search="disabled"', '-c', 'allow_login_shell=false',
      '-c', 'shell_environment_policy.inherit="all"', '-c', `log_dir=${JSON.stringify(path.join(scratch, 'logs'))}`,
      '-c', `sqlite_home=${JSON.stringify(path.join(scratch, 'state'))}`, '-o', path.join(evidence, `${name}.txt`), prompt], {
      cwd: p, env: { ...cleanEnv, CODEX_HOME: home, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (v) => fs.writeSync(output, v)); child.stderr.on('data', (v) => fs.writeSync(errors, v));
    const timer = setTimeout(() => child.kill('SIGTERM'), 240_000);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer); fs.closeSync(output); fs.closeSync(errors); fs.rmSync(home, { recursive: true, force: true });
      const events = fs.readFileSync(path.join(evidence, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      const turns = events.filter((e) => e.type === 'turn.completed').map((e) => e.usage);
      const totals = turns.reduce((a, u) => { for (const [key, value] of Object.entries(u)) a[key] = (a[key] ?? 0) + value; return a; }, {});
      usage.push({ name, model: opt.model, effort: opt.effort, code, signal, turns: turns.length, ...totals });
      fs.writeFileSync(path.join(evidence, 'usage.json'), JSON.stringify(usage, null, 2) + '\n');
      if (code !== 0 || !turns.length) reject(new Error(`session ${name} exited ${code}/${signal}: ${fs.readFileSync(path.join(evidence, `${name}.stderr`), 'utf8').slice(-2000)}`));
      else resolve({ events, answer: fs.readFileSync(path.join(evidence, `${name}.txt`), 'utf8') });
    });
  });
}
try {
  await check('02 Record bootstrap and canonical discovery', () => {
    const p = repo('cli-project'); record(p, ['status', '--json']); record(p, ['add', 'Actual CLI task']);
    assert.ok(fs.existsSync(path.join(p, '.org/events.jsonl')));
    assert.equal(JSON.parse(record(p, ['status', '--json'])).items.length, 1);
    assert.equal(git(p, ['status', '--porcelain']), '');
  });
  await check('03 Suggested routes without project configuration', () => {
    const p = repo('routes-project');
    const probe = path.join(install, 'routes-probe.mjs');
    fs.writeFileSync(probe, `import {loadDiscoveredRoutes,resolveLaunchRoute} from ${JSON.stringify(path.join(product, 'lanes/routes.mjs'))};console.log(JSON.stringify(resolveLaunchRoute(loadDiscoveredRoutes().config)));`);
    assert.equal(JSON.parse(run(process.execPath, [probe], p)).model, 'gpt-6.1-sol');
  });
  await check('04 Installed entry teaches dispatch, watch, worker and supervisor defaults', () => {
    const p = repo('entry-project');
    const policy = run(process.execPath, [path.join(product, 'discovery/adapters/codex.mjs'), '--repo', p, '--binary', binary, '--role', 'supervisor', '--policy-only'], p);
    assert.match(policy, /dispatch.*ITEM/u); assert.match(policy, /watch\/watch.mjs/u); assert.match(policy, /Only a supervisor/u);
    const help = run(process.execPath, [path.join(product, 'dispatch/dispatch.mjs')], p); assert.match(help, /watch/u);
  });
  if (opt['skip-live']) results.push({ name: '20/21 Real isolated discovery', status: 'PENDING' });
  else {
    await check('20 Real concurrent own-lane work and sandboxed fast-forward promotion', async () => {
      const p = repo('concurrent-project'), before = git(p, ['rev-parse', 'main']);
      const workers = await Promise.all([live(p, 'french', 'Add French Bonjour to greetings.mjs, test it, and finish the change for integration.'),
        live(p, 'german', 'Add German Hallo to greetings.mjs, test it, and finish the change for integration.')]);
      assert.ok(workers.every((w) => /lane\//u.test(w.answer)));
      assert.notEqual(git(p, ['rev-parse', 'main']), before);
      const greetings = fs.readFileSync(path.join(p, 'greetings.mjs'), 'utf8'); assert.match(greetings, /Bonjour/u); assert.match(greetings, /Hallo/u);
      assert.equal(git(p, ['status', '--porcelain']), ''); assert.equal(git(p, ['rev-list', '--merges', 'main']), '');
      const state = JSON.parse(record(p, ['status', '--json'])); assert.equal(state.runs.length, 2); assert.ok(state.runs.every((r) => r.report?.outcome === 'done'));
      run(process.execPath, ['--test'], p);
    });
    await check('21 Real routing question waits and actual operator answer applies', async () => {
      const p = repo('routing-project');
      await live(p, 'routing', 'Prepare model and effort routing for future engineering and independent review. If operator preferences are required, leave a durable question with a concrete recommendation and stop.');
      const state = JSON.parse(record(p, ['status', '--json']));
      const questions = state.items.filter((i) => i.role === 'human' && !i.closed); assert.equal(questions.length, 1);
      assert.equal(questions[0].meta.category, 'other'); assert.ok(!fs.existsSync(path.join(p, '.lane.json')));
      record(p, ['answer', questions[0].id, 'yes', '--note', 'Scripted acceptance operator approves the suggested preset'], 'human');
      await live(p, 'routing-apply', `The operator answered yes to ${questions[0].id}. Apply the approved model routes and validate and integrate the configuration.`);
      const routes = JSON.parse(fs.readFileSync(path.join(p, '.lane.json'), 'utf8')).routes;
      assert.equal(routes.engineer.model, 'gpt-6.1-sol'); assert.equal(routes.engineer.effort, 'high'); assert.equal(routes.review.model, 'opus');
      assert.equal(git(p, ['status', '--porcelain']), '');
      const finished = JSON.parse(record(p, ['status', '--json']));
      assert.equal(finished.runs.at(-1).report?.outcome, 'done', 'route application must finish durably as well as writing configuration');
      assert.equal(finished.items.find((i) => i.id === questions[0].parent).closed?.as, 'done');
    });
  }
} finally {
  fs.rmSync(path.join(scratch, 'auth'), { recursive: true, force: true });
  fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify({ results, usage, install, scratch }, null, 2) + '\n');
  console.log(`Evidence: ${evidence}`);
  console.log(`Installed snapshot: ${install}`);
  if (!opt.keep) fs.rmSync(install, { recursive: true, force: true });
}
process.exitCode = results.some((r) => r.status !== 'PASS') ? 1 : 0;
