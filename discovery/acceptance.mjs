#!/usr/bin/env node
// Explicit real-session smoke test, outside npm test. Product and unrelated
// projects have separate scratch roots; no checkout or AGENTS.md is nearby.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from '../lib/cli-help.mjs';
import { fileURLToPath } from 'node:url';
import { assertSupervisorEntry } from '../acceptance/entry.mjs';
import { copyProduct } from '../lib/product-files.mjs';
const source = fileURLToPath(new URL('../', import.meta.url));
const { values: opt } = parseArgs({ options: { binary: { type: 'string' }, harness: { type: 'string', default: 'codex' },
  validator: { type: 'string' }, 'claude-auth': { type: 'string' }, model: { type: 'string' },
  effort: { type: 'string', default: 'low' }, 'skip-live': { type: 'boolean' }, keep: { type: 'boolean' } } });
if (!['codex', 'claude'].includes(opt.harness)) throw new Error('--harness must be codex or claude');
opt.model ??= opt.harness === 'claude' ? 'haiku' : 'gpt-5.6-luna';
const binary = opt.binary ?? spawnSync('which', [opt.harness], { encoding: 'utf8' }).stdout.trim();
let install, scratch, evidence, setupComplete = false;
const results = [], usage = [], active = new Set();
let interrupted = false;
try {
  install = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-installed-'));
  scratch = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'mp-'));
  evidence = path.join(scratch, 'evidence'); fs.mkdirSync(evidence);

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
  interrupted = true;
  for (const child of active) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  if (scratch) fs.rmSync(path.join(scratch, 'auth'), { recursive: true, force: true });
});
const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (/^(ORG_|LANE_|MONITOR_|GIT_|HERDR_)/u.test(key)) delete cleanEnv[key];
for (const key of ['MONITOR_TEST_SLOT_PATH', 'MONITOR_TEST_SLOT_COMPAT_PATH', 'MONITOR_TEST_SLOT_WAIT_SECONDS', 'MONITOR_TEST_SLOT_TOKEN']) if (process.env[key] !== undefined) cleanEnv[key] = process.env[key];
Object.assign(cleanEnv, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  HERDR_MONITOR_FLEET: path.join(scratch, 'fleet'), HERDR_ORG_CONSOLE_CONFIG: path.join(scratch, 'console.json'),
  MONITOR_WORKTREE_ROOT: path.join(scratch, 'lanes'), MONITOR_RUNTIME_DIR: path.join(scratch, 'runtime'), ORG_ACTOR: `eng81-${opt.harness}-acceptance` });
function run(exe, args, cwd, extra = {}) {
  const r = spawnSync(exe, args, { cwd, env: { ...cleanEnv, ...extra }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000, killSignal: 'SIGKILL' });
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
copyProduct(source, product);
const bin = path.join(install, 'bin');
// Installed adapters generate the harness's native settings for these projects.
const liveRequired = !opt['skip-live'] && !(opt.harness === 'claude' && !opt['claude-auth']);
run(process.execPath, [path.join(product, 'discovery/install.mjs'), '--bin', bin, `--${opt.harness}`, binary,
  ...(opt.validator ? ['--validator', opt.validator] : [])], scratch);
const record = (p, args, actor = 'acceptance-agent') => run(process.execPath, [path.join(product, 'bin/org.mjs'), ...args], p, { ORG_DIR: '', ORG_ACTOR: actor });
async function live(p, name, task) {
  if (interrupted) throw new Error('discovery probe interrupted');
  const home = path.join(scratch, 'auth', name); fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (opt.harness === 'codex') {
    const auth = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'auth.json');
    fs.copyFileSync(auth, path.join(home, 'auth.json')); fs.chmodSync(path.join(home, 'auth.json'), 0o600);
  } else {
    // An explicit credential file is operator-authorized. No user settings,
    // hooks, plugins, MCP configuration or project instructions are copied.
    if (opt['claude-auth']) {
      fs.copyFileSync(opt['claude-auth'], path.join(home, '.credentials.json'));
      fs.chmodSync(path.join(home, '.credentials.json'), 0o600);
    }
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({hasCompletedOnboarding:true}), {mode:0o600});
  }
  const prompt = `Do the following bounded task as an entering coding agent in this unrelated project. Changes only in this scratch project and your assigned scratch checkout. Never push or operate Herdr. Do not read other project repositories or records; do not scan parent directories for instructions. Read policy delivered by the installed product and files in your own checkout. Do not invent or answer operator preferences. In the final response identify your actual policy source, lane branch, record IDs and validation/promotion evidence.\n\nTask: ${task}`;
  fs.writeFileSync(path.join(evidence, `${name}.prompt.txt`), prompt);
  const output = fs.openSync(path.join(evidence, `${name}.jsonl`), 'w');
  const errors = fs.openSync(path.join(evidence, `${name}.stderr`), 'w');
  return new Promise((resolve, reject) => {
    const nativeArgs = opt.harness === 'claude' ? [prompt, '--print', '--model', opt.model, '--effort', opt.effort,
      '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--safe-mode',
      '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--permission-mode', 'dontAsk', '--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep'] : ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--sandbox', 'workspace-write', '--json', '--model', opt.model, '-c', `model_reasoning_effort=${opt.effort}`,
      '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      '-c', 'features.shell_snapshot=false', '-c', 'web_search="disabled"', '-c', 'allow_login_shell=false',
      '-c', 'shell_environment_policy.inherit="all"', '-c', `log_dir=${JSON.stringify(path.join(scratch, 'logs'))}`,
      '-c', `sqlite_home=${JSON.stringify(path.join(scratch, 'state'))}`, '-o', path.join(evidence, `${name}.txt`), prompt];
    const child = spawn(path.join(bin, `monitor-${opt.harness}`), ['--', ...nativeArgs], {
      cwd: p, env: { ...cleanEnv, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, PATH: `${bin}:${process.env.PATH}` },
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    active.add(child);
    child.stdout.on('data', (v) => fs.writeSync(output, v)); child.stderr.on('data', (v) => fs.writeSync(errors, v));
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(stop, 240_000);
    let launchError;
    child.on('error', (error) => { launchError = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer); stop(); active.delete(child); fs.closeSync(output); fs.closeSync(errors); fs.rmSync(home, { recursive: true, force: true });
      const events = fs.readFileSync(path.join(evidence, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      const result = events.findLast((e) => e.type === 'result');
      const turns = opt.harness === 'claude' ? (result?.usage ? [result.usage] : [])
        : events.filter((e) => e.type === 'turn.completed').map((e) => e.usage);
      if (opt.harness === 'claude') fs.writeFileSync(path.join(evidence, `${name}.txt`), result?.result ?? '');
      const totals = turns.reduce((a, u) => { for (const [key, value] of Object.entries(u)) if (typeof value === 'number') a[key] = (a[key] ?? 0) + value; return a; }, {});
      usage.push({ name, harness: opt.harness, cost_usd: result?.total_cost_usd, modelUsage: result?.modelUsage, model: opt.model, effort: opt.effort, code, signal, turns: turns.length, ...totals });
      fs.writeFileSync(path.join(evidence, 'usage.json'), JSON.stringify(usage, null, 2) + '\n');
      if (launchError || code !== 0 || !turns.length || result?.is_error) reject(new Error(`session ${name} exited ${code}/${signal}: ${result?.result ?? result?.errors?.join('; ') ?? ''} ${fs.readFileSync(path.join(evidence, `${name}.stderr`), 'utf8').slice(-2000)}`));
      else resolve({ events, answer: fs.readFileSync(path.join(evidence, `${name}.txt`), 'utf8') });
    });
  });
}
setupComplete = true;
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
    const policy = run(process.execPath, [path.join(product, `discovery/adapters/${opt.harness}.mjs`), '--repo', p, '--binary', binary, '--role', 'supervisor', '--policy-only'], p);
    assertSupervisorEntry(policy);
    const help = run(process.execPath, [path.join(product, 'dispatch/dispatch.mjs')], p); assert.match(help, /watch/u);
  });
  if (opt['skip-live'] || (opt.harness === 'claude' && !opt['claude-auth'])) {
    const reason = opt['skip-live'] ? 'Live cases omitted by --skip-live.'
      : 'Operator-authorized scratch authentication is absent; ENG-81 live proof awaits HUM-19.';
    for (const name of ['20 Real concurrent own-lane work and sandboxed fast-forward promotion',
      '21 Real routing question waits and actual operator answer applies']) {
      results.push({ name, status: 'PENDING', reason }); console.log(`PENDING ${name}: ${reason}`);
    }
  }
  else {
    await check('20 Real concurrent own-lane work and sandboxed fast-forward promotion', async () => {
      const p = repo('concurrent-project'), before = git(p, ['rev-parse', 'main']);
      const completed = await Promise.allSettled([live(p, 'french', 'Add French Bonjour to greetings.mjs, test it, and finish the change for integration.'),
        live(p, 'german', 'Add German Hallo to greetings.mjs, test it, and finish the change for integration.')]);
      const failures = completed.filter((r) => r.status === 'rejected');
      if (failures.length) throw new Error(failures.map((r) => r.reason.message).join('\n'));
      const workers = completed.map((r) => r.value);
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
} catch (error) {
  results.push({ name: 'Setup', status: 'FAIL', error: error.message });
  console.error(`FAIL Setup: ${error.message}`);
} finally {
  try {
    if (scratch) fs.rmSync(path.join(scratch, 'auth'), { recursive: true, force: true });
    if (evidence) {
      fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify({ harness: opt.harness, results, usage, install, scratch, interrupted, setupComplete }, null, 2) + '\n');
      console.log(`Evidence: ${evidence}`);
    }
  } catch (error) {
    results.push({ name: 'Evidence', status: 'FAIL', error: error.message });
    console.error(`FAIL Evidence: ${error.message}`);
  } finally {
    console.log(`Installed snapshot: ${install}`);
    if (install && (!opt.keep || !setupComplete)) fs.rmSync(install, { recursive: true, force: true });
    if (scratch && !setupComplete) for (const name of fs.readdirSync(scratch)) {
      if (name !== 'evidence') fs.rmSync(path.join(scratch, name), { recursive: true, force: true });
    }
  }
}
process.exitCode = results.some((r) => r.status !== 'PASS') ? 1 : 0;
