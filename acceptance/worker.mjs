// A script in a real PTY. Explicit lifecycle reports test the coordination
// contract, not Codex/Claude screen detection. No harness executable is started.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
const [root, role, name] = process.argv.slice(2);
const pane = process.env.HERDR_PANE_ID;
const env = { ...process.env, ACCEPTANCE_ROOT: root };
const call = (...args) => execFileSync(process.execPath, [path.join(root, 'herdr.mjs'), ...args], { env, stdio: 'pipe' });
let seq = 0;
const state = (value) => call('pane', 'report-agent', pane, '--source', 'acceptance-script', '--agent', 'codex', '--state', value, '--seq', String(++seq));
state('idle');
fs.mkdirSync(path.join(root, 'script-panes'), { recursive: true });
fs.writeFileSync(path.join(root, 'script-panes', pane), role);
console.log(`Scripted ${role} ready (${name})`);
// These are trusted scratch tasks, never model-written instructions or code.
function defaultCycle() {
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'default-supervisor-task.json')));
  const scoped = { ...env, HOME: spec.home, PATH: `${path.join(root, 'bin')}:${env.PATH}`, ORG_ACTOR: name,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(scoped)) if (/^(ORG_|LANE_|MONITOR_|HERDR_)/.test(key)) delete scoped[key];
  scoped.ORG_ACTOR = name;
  const node = (file, args, extra = {}) => execFileSync(process.execPath, [path.join(root, 'candidate', file), ...args], {
    cwd: spec.repo, env: { ...scoped, ...extra }, encoding: 'utf8', timeout: 90_000,
  });
  const record = (args) => node('bin/org.mjs', args, { ORG_DIR: path.join(spec.repo, '.org') });
  return { spec, node, record };
}
function dispatchDefault() {
  const file = path.join(root, 'default-supervisor-job.json');
  try {
    const { spec, node, record } = defaultCycle();
    const policy = node('discovery/adapters/codex.mjs', ['--repo', spec.repo, '--binary', spec.binary, '--role', 'supervisor', '--policy-only']);
    fs.writeFileSync(path.join(root, 'default-supervisor-policy.txt'), policy);
    const item = record(['add', 'Default cycle canary', '--role', 'engineer']).match(/^(\S+)/)[1];
    const job = JSON.parse(node('dispatch/dispatch.mjs', [item, '--lane', 'default-cycle', '--route', 'engineer', '--brief', spec.ask, '--to', name]));
    const info = JSON.parse(record(['show', job.run, '--json']));
    fs.writeFileSync(file, JSON.stringify({ job, info }));
  } catch (error) { fs.writeFileSync(file, JSON.stringify({ error: error.message })); }
}
function ingestDefault(line) {
  const file = path.join(root, 'default-supervisor-job.json');
  if (!fs.existsSync(file)) return;
  const saved = JSON.parse(fs.readFileSync(file));
  if (!saved.job || !line.startsWith(`[org-report] run=${saved.job.run} `) || !line.includes(`report=${saved.info.report_path}`)) return;
  const receipt = path.join(root, 'default-supervisor-ingest.json');
  try {
    const { record } = defaultCycle();
    record(['check', saved.info.report_path]); record(['ingest', saved.info.report_path, '--run', saved.job.run]);
    fs.writeFileSync(receipt, record(['show', saved.job.run, '--json']));
  } catch (error) { fs.writeFileSync(receipt, JSON.stringify({ error: error.message })); }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const input = readline.createInterface({ input: process.stdin });
for await (const raw of input) {
  const line = raw.replace(/\x1b\[200~|\x1b\[201~/g, '').trim();
  if (!line) continue;
  const requested = line.match(/^acceptance-state (working|idle)$/)?.[1];
  const match = line.match(/You are run (R-\d+).*Write the report to ([^;]+);/);
  // Legacy briefs contain many lines. Only the task line changes a worker's
  // lifecycle; acknowledgements still cover the complete PTY transport.
  if (role !== 'supervisor' && !requested && !match && !line.startsWith('You are a fresh, short-lived orchestrator')) {
    fs.appendFileSync(path.join(root, `${role}-input.jsonl`), JSON.stringify({ pane, name, line }) + '\n');
    continue;
  }
  state('working');
  fs.appendFileSync(path.join(root, `${role}-input.jsonl`), JSON.stringify({ pane, name, line }) + '\n');
  if (requested) { state(requested); continue; }
  if (role === 'supervisor') {
    console.log(line);
    if (line === 'acceptance-default-cycle') dispatchDefault();
    else ingestDefault(line);
    await delay(1000); state('idle'); continue;
  }
  if (!match) { await delay(4000); state('idle'); continue; }
  const [, run, report] = match;
  const mode = fs.readFileSync(path.join(root, 'mode'), 'utf8').trim();
  fs.writeFileSync(path.join(root, 'worker-started'), run);
  // Let the watcher observe working before a deliberately incomplete stop.
  await delay(1500);
  if (mode === 'blocked') { state('blocked'); continue; }
  if (mode === 'missing') { state('idle'); continue; }
  fs.mkdirSync(path.dirname(report), { recursive: true });
  if (mode === 'invalid') { fs.writeFileSync(report, `---\nrun: ${run}\noutcome: banana\n---\n`); state('idle'); continue; }
  const outcome = mode === 'needs-human' ? 'needs_human' : mode === 'blocked-report' ? 'blocked' : 'done';
  fs.writeFileSync(path.join(process.cwd(), `work-${run}.txt`), `${mode}\n`);
  execFileSync('git', ['add', `work-${run}.txt`], { stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', `Scripted acceptance ${mode} ${run}`], { stdio: 'pipe' });
  fs.writeFileSync(report, `---\nrun: ${run}\noutcome: ${outcome}\nsummary: Scripted worker completed its acceptance round.\nheadline: The scripted round completed\nblockers: ${outcome === 'done' ? '[]' : '["Acceptance stand-in needs a decision"]'}\nproposals: []\nlearnings: []\nartifacts: []\n---\n\nScripted evidence, no model.\n`);
  console.log(`Report ${report}`); if (mode !== 'held') state('idle');
}
