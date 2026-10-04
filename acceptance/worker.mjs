// A script in a real PTY. Explicit lifecycle reports test the coordination
// contract, not Codex/Claude screen detection. No harness executable is started.
import { loadTimeout } from './deadline.mjs';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { registerProducer, assertProducing, producersStopping } from './producers.mjs';
import { scratchProductHomes, assertScratchHomes } from './environment.mjs';
const [root, role, name] = process.argv.slice(2);
const producer = registerProducer(root, `script-${role}`);
let activeChild, workerStopping = false;
// Keep the worker alive to finish its journal after an active command returns.
// No subsequent command may start after stop, including on a direct PTY signal.
const stopTimer = setInterval(() => {
  if ((workerStopping || producersStopping(root)) && !activeChild) process.exit(0);
}, 25);
process.once('exit', () => clearInterval(stopTimer));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { workerStopping = true; });
const pane = process.env.HERDR_PANE_ID;
// A PTY inherits the server environment, not the runner's TMPDIR. Keep child
// dispatch environment files inside the same scratch capability boundary.
const slotFile = path.join(root, 'test-slot-env.json');
const slotEnv = fs.existsSync(slotFile) ? JSON.parse(fs.readFileSync(slotFile)) : {};
const homesFile = path.join(root, 'product-home-env.json');
const homes = fs.existsSync(homesFile) ? JSON.parse(fs.readFileSync(homesFile)) : { realHome: process.env.HOME, homes: scratchProductHomes(root) };
const env = { ...process.env, ...slotEnv, ...homes.homes, ACCEPTANCE_ROOT: root, TMPDIR: root, TMP: root, TEMP: root };
const checkHomes = selected => assertScratchHomes(selected, homes.roots ?? [root], { realHome: homes.realHome });
checkHomes(env);
async function command(binary, args, options = {}, timeout = 90_000) {
  if (workerStopping) throw new Error('scripted worker stopped; no further commands allowed');
  assertProducing(root);
  return await new Promise((resolve, reject) => {
    const child = activeChild = spawn(binary, args, { ...options, env: checkHomes(options.env ?? env), stdio: ['ignore', 'pipe', 'pipe'] });
    producer.child(child.pid);
    let stdout = '', stderr = '', killTimer, spawnError;
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), loadTimeout(1000));
    }, loadTimeout(timeout));
    child.on('error', error => { spawnError = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      producer.child(child.pid, false); activeChild = undefined;
      if (spawnError || code !== 0) reject(spawnError ?? new Error(`${binary}: ${signal ?? code}: ${stderr}`));
      else resolve(stdout);
    });
  });
}
const call = (...args) => command(process.execPath, [path.join(root, 'herdr.mjs'), ...args], { env: { ...env, ACCEPTANCE_CALLER: 'harness' } });
let seq = 0;
let composerMode = 'shaded', composerText = '';
function emptyComposer() {
  // Actual PTY chrome, not an adapter read override: production's screen gate
  // sees the same padded shaded Codex box as it does in a native session.
  const shade = '\x1b[48;2;72;76;92m', reset = '\x1b[0m';
  const width = Math.max(12, Math.min(process.stdout.columns ?? 60, 80) - 1);
  const top = Math.max(1, (process.stdout.rows ?? 24) - 4);
  if (composerMode === 'legacy') {
    // The restored snapshot consumer reads between the last two footer rules.
    // Render these in the actual supervisor PTY only for the rollback canary.
    process.stdout.write(`\x1b[2J\x1b[${top};1H` +
      `${'─'.repeat(width)}\n❯ ${composerText}\n${'─'.repeat(width)}\n` +
      `scripted · ${root} · ${role}\n`);
    return;
  }
  // The production notice gate reads the last fourteen rendered rows.
  process.stdout.write(`\x1b[2J\x1b[${top};1H` +
    `${shade}${' '.repeat(width)}${reset}\n` +
    `\x1b[1m${shade}›${reset}${shade}${' '.repeat(width - 1)}${reset}\n` +
    `${shade}${' '.repeat(width)}${reset}\n` +
    `scripted · ${root} · ${role}\n`);
}
const state = (value) => {
  if (value === 'idle') emptyComposer();
  return call('pane', 'report-agent', pane, '--source', 'acceptance-script', '--agent', 'codex', '--state', value, '--seq', String(++seq));
};
await state('idle');
fs.mkdirSync(path.join(root, 'script-panes'), { recursive: true });
fs.writeFileSync(path.join(root, 'script-panes', pane), role);
// Readiness is published after the empty composer and idle receipt.
// These are trusted scratch tasks, never model-written instructions or code.
function defaultCycle() {
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'default-supervisor-task.json')));
  const scoped = { ...env, HOME: spec.home, PATH: `${path.join(root, 'bin')}:${env.PATH}`, ORG_ACTOR: name,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(scoped)) if (/^(ORG_|LANE_|MONITOR_|HERDR_)/.test(key)) delete scoped[key];
  Object.assign(scoped, slotEnv);
  Object.assign(scoped, scratchProductHomes(root, spec.home));
  scoped.HERDR_MONITOR_FLEET = env.HERDR_MONITOR_FLEET;
  scoped.ORG_ACTOR = name;
  const node = (file, args, extra = {}) => command(process.execPath, [path.join(root, 'candidate', file), ...args], {
    cwd: spec.repo, env: { ...scoped, ...extra },
  });
  const record = (args) => node('bin/org.mjs', args, { ORG_DIR: path.join(spec.repo, '.org') });
  return { spec, node, record };
}
async function dispatchDefault() {
  const file = path.join(root, 'default-supervisor-job.json');
  try {
    const { spec, node, record } = defaultCycle();
    const policy = await node('discovery/adapters/codex.mjs', ['--repo', spec.repo, '--binary', spec.binary, '--role', 'supervisor', '--policy-only']);
    fs.writeFileSync(path.join(root, 'default-supervisor-policy.txt'), policy);
    const item = (await record(['add', 'Default cycle canary', '--role', 'engineer'])).match(/^(\S+)/)[1];
    const job = JSON.parse(await node('dispatch/dispatch.mjs', [item, '--lane', 'default-cycle', '--route', 'engineer', '--brief', spec.ask, '--to', name]));
    const info = JSON.parse(await record(['show', job.run, '--json']));
    fs.writeFileSync(file, JSON.stringify({ job, info }));
  } catch (error) { fs.writeFileSync(file, JSON.stringify({ error: error.message })); }
}
async function ingestDefault(line) {
  const file = path.join(root, 'default-supervisor-job.json');
  if (!fs.existsSync(file)) return;
  const saved = JSON.parse(fs.readFileSync(file));
  if (!saved.job || !line.startsWith(`[org-report] run=${saved.job.run} `) || !line.includes(`report=${saved.info.report_path}`)) return;
  const receipt = path.join(root, 'default-supervisor-ingest.json');
  try {
    const { record } = defaultCycle();
    await record(['check', saved.info.report_path]); await record(['ingest', saved.info.report_path, '--run', saved.job.run]);
    fs.writeFileSync(receipt, await record(['show', saved.job.run, '--json']));
  } catch (error) { fs.writeFileSync(receipt, JSON.stringify({ error: error.message })); }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const input = readline.createInterface({ input: process.stdin });
for await (const raw of input) {
  assertProducing(root);
  const line = raw.replace(/\x1b\[200~|\x1b\[201~/g, '').trim();
  if (!line) continue;
  const requested = line.match(/^acceptance-state (working|idle)$/)?.[1];
  const composer = role === 'supervisor' && line.match(/^acceptance-composer (legacy|shaded)(?: (.*))?$/);
  const match = line.match(/You are run (R-\d+).*Write the report to ([^;]+);/);
  // Legacy briefs contain many lines. Only the task line changes a worker's
  // lifecycle; acknowledgements still cover the complete PTY transport.
  if (role !== 'supervisor' && !requested && !match && !line.startsWith('You are a fresh, short-lived orchestrator')) {
    fs.appendFileSync(path.join(root, `${role}-input.jsonl`), JSON.stringify({ pane, name, line }) + '\n');
    continue;
  }
  await state('working');
  fs.appendFileSync(path.join(root, `${role}-input.jsonl`), JSON.stringify({ pane, name, line }) + '\n');
  if (composer) {
    [, composerMode, composerText = ''] = composer;
    await state('idle');
    const directory = path.join(root, 'script-composers');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, pane);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ mode: composerMode, text: composerText }));
    fs.renameSync(`${file}.tmp`, file);
    continue;
  }
  if (requested) { await state(requested); continue; }
  if (role === 'supervisor') {
    console.log(line);
    if (line === 'acceptance-default-cycle') await dispatchDefault();
    else await ingestDefault(line);
    await delay(1000); await state('idle'); continue;
  }
  if (!match) { await delay(4000); await state('idle'); continue; }
  const [, run, report] = match;
  const mode = fs.readFileSync(path.join(root, 'mode'), 'utf8').trim();
  fs.writeFileSync(path.join(root, 'worker-started'), run);
  // Let the watcher observe working before a deliberately incomplete stop.
  await delay(1500);
  assertProducing(root);
  if (mode === 'blocked') { await state('blocked'); continue; }
  if (mode === 'missing') { await state('idle'); continue; }
  fs.mkdirSync(path.dirname(report), { recursive: true });
  if (mode === 'invalid') { fs.writeFileSync(report, `---\nrun: ${run}\noutcome: banana\n---\n`); await state('idle'); continue; }
  const outcome = mode === 'needs-human' ? 'needs_human' : mode === 'blocked-report' ? 'blocked' : 'done';
  fs.writeFileSync(path.join(process.cwd(), `work-${run}.txt`), `${mode}\n`);
  await command('git', ['add', `work-${run}.txt`], { env }, 15_000);
  await command('git', ['commit', '-qm', `Scripted acceptance ${mode} ${run}`], { env }, 15_000);
  assertProducing(root);
  fs.writeFileSync(report, `---\nrun: ${run}\noutcome: ${outcome}\nsummary: Scripted worker completed its acceptance round.\nheadline: The scripted round completed\nblockers: ${outcome === 'done' ? '[]' : '["Acceptance stand-in needs a decision"]'}\nproposals: []\nlearnings: []\nartifacts: []\n---\n\nScripted evidence, no model.\n`);
  console.log(`Report ${report}`); if (mode !== 'held') await state('idle');
}
clearInterval(stopTimer); producer.release();
