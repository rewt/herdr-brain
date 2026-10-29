// A foreground command plus an optional terminal view. Display state never
// supplies validation evidence, execution authority or a readiness gate.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/cli-help.mjs';
import { processStartRecord, processState } from '../test-slot/lock-support.mjs';

const script = fileURLToPath(import.meta.url), execute = promisify(execFile);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
};
const git = (repo, ...args) => execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
}).trim();
async function herdr(args) {
  if (process.env.HERDR_ENV !== '1') throw Error('the progress view requires a Herdr-managed caller');
  const { stdout } = await execute(process.env.HERDR_BIN_PATH || 'herdr', args, { timeout: 5000, maxBuffer: 1024 * 1024 });
  // These native input/title commands acknowledge success with exit 0 and no
  // body on some Herdr versions. Never replay their already-completed effect.
  if (!stdout.trim() && ['pane run', 'tab rename'].includes(args.slice(0, 2).join(' '))) return {};
  const reply = JSON.parse(stdout);
  if (reply.error || !reply.result) throw Error(`Herdr refused ${args.slice(0, 2).join(' ')}: ${stdout.trim()}`);
  return reply.result;
}

export async function openView({ repo, directory, label }) {
  // Labels and inherited workspace IDs are not repository authority. Only the
  // live canonical workspace with matching real Git identity is eligible.
  const common = fs.realpathSync(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const canonical = fs.realpathSync(path.dirname(common));
  if (git(canonical, 'rev-parse', '--show-toplevel') !== canonical) throw Error('canonical checkout unavailable');
  const { workspaces } = await herdr(['workspace', 'list']);
  const parent = workspaces?.find(w => w.worktree?.repo_key === common && w.worktree.repo_root === canonical &&
    w.worktree.checkout_path === canonical && w.worktree.is_linked_worktree === false);
  if (!parent) throw Error('open the canonical project workspace to see progress');
  const created = await herdr(['tab', 'create', '--workspace', parent.workspace_id, '--cwd', canonical,
    '--label', `${label} · running`, '--no-focus']);
  const tab = created.tab?.tab_id, pane = created.root_pane?.pane_id;
  if (!tab || !pane || created.tab.workspace_id !== parent.workspace_id ||
      created.root_pane.workspace_id !== parent.workspace_id || created.root_pane.tab_id !== tab)
    throw Error('progress tab creation returned inconsistent ownership');
  // Only the new native creation reply authorizes input. Never reuse a tab,
  // focus the operator, start an agent, retry a refusal or close anything.
  save(path.join(directory, 'view.json'), { state: 'created', workspace: parent.workspace_id, tab, pane });
  await herdr(['pane', 'run', pane, [process.execPath, script, 'view', directory, label, tab].map(quote).join(' ')]);
  save(path.join(directory, 'view.json'), { state: 'attached', workspace: parent.workspace_id, tab, pane });
  return { workspace: parent.workspace_id, tab, pane };
}

export async function runVisible({ repo, label, command }) {
  if (!command?.length) throw Error('supply a command after --');
  let directory, fd;
  try {
    const common = fs.realpathSync(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    const root = path.join(common, 'visible-runs');
    fs.mkdirSync(root, { recursive: true });
    directory = fs.mkdtempSync(path.join(root, 'run-'));
    fs.chmodSync(directory, 0o700);
    fd = fs.openSync(path.join(directory, 'output.log'), 'wx', 0o600);
    console.error(`Progress view: ${directory}`);
  } catch (error) {
    console.error(`Progress view unavailable: ${error.message}`);
    if (fd !== undefined) fs.closeSync(fd);
    fd = undefined;
  }
  // Execution starts before any Herdr round trip. Keep the caller's cwd,
  // command, environment, stdin, runner limits and existing gate receipts.
  const child = spawn(command[0], command.slice(1), { detached: true,
    stdio: fd === undefined ? 'inherit' : ['inherit', 'pipe', 'pipe'] });
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  if (fd !== undefined) for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    input.on('data', bytes => {
      try { fs.writeSync(fd, bytes); } catch (error) { console.error(`Progress log unavailable: ${error.message}`); }
    });
    input.pipe(output, { end: false });
  }
  const started = new Date().toISOString();
  let ownerKnown = false;
  if (fd !== undefined) try {
    save(path.join(directory, 'owner.json'), { pid: process.pid, ...processStartRecord(process.pid) });
    ownerKnown = true;
  } catch (error) { console.error(`Progress owner unavailable: ${error.message}`); }
  const viewing = ownerKnown && process.env.HERDR_ENV === '1'
    ? openView({ repo, directory, label }).catch(error => {
      console.error(`Progress view unavailable (command continues): ${error.message}`);
      try { save(path.join(directory, 'view-error.json'), { error: error.message }); } catch {}
    }) : Promise.resolve();
  let launchError;
  child.once('error', error => { launchError = error.message; console.error(error.message); });
  const result = await new Promise(resolve => child.once('close', (exit_code, signal) => resolve({ exit_code, signal })));
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  if (fd !== undefined) {
    fs.closeSync(fd);
    try { save(path.join(directory, 'result.json'), { schema: 'herdr-visible-run/v1', command, cwd: process.cwd(),
      started, finished: new Date().toISOString(), ...result, ...(launchError ? { error: launchError } : {}) }); }
    catch (error) { console.error(`Progress result unavailable: ${error.message}`); }
  }
  // Display errors never alter the command's result or trigger another attempt.
  await viewing;
  return { ...result, directory, code: result.exit_code ?? (result.signal ? 128 + os.constants.signals[result.signal] : 1) };
}

export async function view(directory, label, tab) {
  console.log(`${label}\nFollowing command output; closing this view does not stop the command.\n`);
  let offset = 0;
  const owner = json(path.join(directory, 'owner.json'));
  async function drain() {
    const fd = fs.openSync(path.join(directory, 'output.log'), 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      for (let count; (count = fs.readSync(fd, buffer, 0, buffer.length, offset)) > 0;) {
        offset += count;
        if (!process.stdout.write(buffer.subarray(0, count))) await new Promise(resolve => process.stdout.once('drain', resolve));
      }
    } finally { fs.closeSync(fd); }
  }
  for (;;) {
    await drain();
    let result;
    try { result = json(path.join(directory, 'result.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let state;
    if (result) state = result.signal ? `interrupted (${result.signal})` : result.exit_code === 0 ? 'passed' : `failed (${result.exit_code ?? 'launch'})`;
    else if (processState(owner.pid, owner.start, owner.birth).state !== 'live') state = 'result unknown';
    if (state) {
      await drain(); // the final result is published only after output closes
      console.log(`\n${label}: ${state}\nLog: ${path.join(directory, 'output.log')}\nThis display is not a validation receipt.`);
      try { await herdr(['tab', 'rename', tab, `${label} · ${state}`]); }
      catch (error) { console.error(`Progress title unchanged: ${error.message}`); }
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

if (isMain(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  try {
    if (mode === 'view' && args.length === 3) await view(...args);
    else if (mode === 'run') {
      const separator = args.indexOf('--'), options = args.slice(0, separator);
      if (separator < 0 || options.length !== 4 || options[0] !== '--repo' || options[2] !== '--label')
        throw Error('usage: visible-run.mjs run --repo PATH --label TEXT -- COMMAND [ARGS...]');
      process.exitCode = (await runVisible({ repo: options[1], label: options[3], command: args.slice(separator + 1) })).code;
    } else throw Error('usage: visible-run.mjs run --repo PATH --label TEXT -- COMMAND [ARGS...]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
