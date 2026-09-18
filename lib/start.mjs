// Starting a session: the one thing the operator asks for that opens a new
// terminal. A new Herdr tab in the checkout's workspace, Claude on the account
// that folder belongs to, then the brief as its first prompt.
//
// Same chain as the settle watcher's openSession, without org or a ledger:
//   ~/bin/ai env           which Claude account the folder uses (refuses to guess)
//   cmem-domain            the memory settings `ai claude` would add
//   herdr tab create       the tab, with that account in its environment
//   herdr agent start      Claude in it, named, so the queue can find it later
//   herdr agent prompt     the brief
//
// The session is then an ordinary Herdr agent: when it stops, `brain watch`
// captures what it said and it lands in the queue like any other result.
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BIN = process.env.HERDR_BIN ?? 'herdr';
const LAUNCHER = process.env.BRAIN_LAUNCHER ?? path.join(os.homedir(), 'bin', 'ai');
const CMEM = process.env.BRAIN_CMEM ?? path.join(os.homedir(), 'development', 'claude-mem', 'bin', 'cmem-domain');
const PERSONA = ['AI_PERSONA', 'CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR', 'CODEX_HOME'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function herdr(args, { env } = {}) {
  try {
    const { stdout } = await run(BIN, args, { env: env ? { ...process.env, ...env } : process.env, timeout: 150000, maxBuffer: 32 * 1024 * 1024 });
    try { return { ok: true, body: JSON.parse(stdout) }; } catch { return { ok: true, body: stdout }; }
  } catch (err) {
    return { ok: false, error: `${err.stderr ?? ''}${err.stdout ?? ''}`.trim().split('\n')[0] || err.message };
  }
}

// A Herdr agent name: starts with a letter, lowercase letters, digits, - and _, at most 32.
export function agentName(prefix, words, now = new Date()) {
  const hhmm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const slug = String(words ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const room = 32 - prefix.length - hhmm.length - 2;
  const cut = slug.slice(0, room).replace(/-+$/, '');
  return `${prefix}${cut ? `-${cut}` : ''}-${hhmm}`;
}

// The account and memory settings `ai claude` would use in `cwd`.
export async function launchSettings(cwd) {
  const clean = { ...process.env };
  for (const v of PERSONA) delete clean[v];
  let out = '';
  try {
    ({ stdout: out } = await run(LAUNCHER, ['env'], { cwd, env: clean, timeout: 15000 }));
  } catch (err) {
    throw new Error(`${LAUNCHER} env failed in ${cwd}: ${(err.stderr ?? err.message).toString().trim().split('\n')[0]}`);
  }
  const env = {};
  for (const line of out.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && PERSONA.includes(m[1])) env[m[1]] = m[2];
  }
  if (!env.CLAUDE_CONFIG_DIR) throw new Error(`${LAUNCHER} env gave no CLAUDE_CONFIG_DIR for ${cwd}; not starting a session on an unknown account`);
  const args = [];
  try {
    const { stdout } = await run(CMEM, ['launch-args', 'claude', cwd], { timeout: 15000 });
    for (const line of stdout.split('\n')) {
      if (line.startsWith('env ')) {
        const kv = line.slice(4);
        const i = kv.indexOf('=');
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      } else if (line.startsWith('arg ')) {
        args.push(line.slice(4));
      }
    }
  } catch {
    // Memory is optional; the account is not.
  }
  return { env, args };
}

// The Herdr workspace whose own checkout is `cwd`.
async function workspaceFor(cwd) {
  const r = await herdr(['workspace', 'list']);
  if (!r.ok) throw new Error(`herdr workspace list failed: ${r.error}`);
  const want = path.resolve(cwd);
  const list = r.body?.result?.workspaces ?? [];
  const ws = list.find((w) => w.worktree && !w.worktree.is_linked_worktree && path.resolve(w.worktree.checkout_path) === want)
    ?? list.find((w) => w.worktree && path.resolve(w.worktree.checkout_path) === want);
  if (!ws) throw new Error(`no Herdr workspace has ${want} as its checkout`);
  return ws.workspace_id;
}

// Returns { name, tab, pane }; throws with a plain reason, naming how far it got.
export async function startSession({ cwd, name, label, prompt, model = 'opus', effort = 'high', permissionMode = 'auto', addDirs = [] }) {
  if (!cwd || !name || !prompt) throw new Error('start needs --cwd, --name and a prompt');
  const workspace = await workspaceFor(cwd);
  const { env, args } = await launchSettings(cwd);

  const tabArgs = ['tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', label ?? name, '--no-focus'];
  for (const [k, v] of Object.entries(env)) tabArgs.push('--env', `${k}=${v}`);
  const tab = await herdr(tabArgs);
  const pane = tab.body?.result?.root_pane?.pane_id;
  if (!tab.ok || !pane) throw new Error(`could not open a tab: ${tab.error ?? 'Herdr returned no pane'}`);
  const tabId = tab.body?.result?.tab?.tab_id ?? tab.body?.result?.tab_id ?? null;

  const startArgs = ['agent', 'start', name, '--kind', 'claude', '--pane', pane, '--timeout', '120000', '--',
    ...args, ...addDirs.flatMap((d) => ['--add-dir', d]),
    '--model', model, '--effort', effort, '--permission-mode', permissionMode, '--name', name];
  let started = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await sleep(3000); // a new tab's shell needs a moment to reach its prompt
    // Herdr takes the agent's account from the caller of `agent start`, not the tab.
    started = await herdr(startArgs, { env });
    if (started.ok) break;
  }
  if (!started?.ok) throw new Error(`a tab opened (${label ?? name}) but Claude did not start in it: ${started?.error}`);

  const prompted = await herdr(['agent', 'prompt', name, prompt]);
  if (!prompted.ok) throw new Error(`${name} started but did not take the brief: ${prompted.error}`);
  return { name, tab: tabId, pane, account: env.CLAUDE_CONFIG_DIR };
}
