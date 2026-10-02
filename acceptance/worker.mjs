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
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const input = readline.createInterface({ input: process.stdin });
for await (const raw of input) {
  const line = raw.replace(/\x1b\[200~|\x1b\[201~/g, '').trim();
  if (!line) continue;
  state('working');
  fs.appendFileSync(path.join(root, `${role}-input.jsonl`), JSON.stringify({ pane, name, line }) + '\n');
  if (role === 'supervisor') {
    console.log(line); await delay(1000); state('idle'); continue;
  }
  const match = line.match(/You are run (R-\d+).*Write the report to ([^;]+);/);
  if (!match) { await delay(1000); state('idle'); continue; }
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
  console.log(`Report ${report}`); state('idle');
}
