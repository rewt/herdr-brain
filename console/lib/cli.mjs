// The console's only ways to touch the world: the org CLI (child process, argument
// arrays), Herdr's agent and tab lists and focus, and an external viewer. It never
// appends to events.jsonl and never starts, stops or messages agents.
import { execFile, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentList, parseTabList } from './sources.mjs';

export const ORG_BIN = process.env.HERDR_ORG_BIN || fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));

function run(cmd, args, { env, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout, stderr, error });
    });
  });
}

function orgEnv(project) {
  const env = { ...process.env, ORG_DIR: project.org };
  // Answers from the console are the operator's.
  delete env.ORG_ACTOR;
  return env;
}

function firstLine(text) {
  return String(text ?? '').trim().split('\n')[0].replace(/^org:\s*/, '');
}

export async function orgToday(project) {
  const r = await run(process.execPath, [ORG_BIN, 'today', '--json'], { env: orgEnv(project) });
  if (!r.ok) throw new Error(firstLine(r.stderr) || r.error?.message || 'org today failed');
  return JSON.parse(r.stdout);
}

export function answerArgs({ question, answer, note, overrule }) {
  // --note=… keeps a reason that starts with a dash from reading as an option.
  return ['answer', question, answer, ...(note ? [`--note=${note}`] : []), ...(overrule ? ['--overrule'] : [])];
}

export async function orgAnswer(project, request) {
  const r = await run(process.execPath, [ORG_BIN, ...answerArgs(request)], { env: orgEnv(project) });
  return r.ok ? { ok: true, output: r.stdout.trim() } : { ok: false, error: firstLine(r.stderr) || r.error?.message || 'org answer failed' };
}

export async function herdrAgents() {
  const r = await run('herdr', ['agent', 'list'], { timeout: 4000 });
  if (!r.ok) return { ok: false, agents: [], error: firstLine(r.stderr) || r.error?.code || 'herdr agent list failed' };
  try {
    return { ok: true, agents: parseAgentList(r.stdout) };
  } catch (error) {
    return { ok: false, agents: [], error: error.message };
  }
}

export async function herdrTabs() {
  const r = await run('herdr', ['tab', 'list'], { timeout: 4000 });
  if (!r.ok) return [];
  try {
    return parseTabList(r.stdout);
  } catch {
    return [];
  }
}

// Going to a session: its agent by name, or its tab when Herdr gives the agent no name.
export function goArgs({ agent, tab }) {
  if (agent) return ['agent', 'focus', agent];
  if (tab) return ['tab', 'focus', tab];
  return null;
}

export async function herdrGo(target) {
  const args = goArgs(target);
  if (!args) return { ok: false, error: 'no Herdr agent or tab to go to' };
  const r = await run('herdr', args, { timeout: 4000 });
  return r.ok ? { ok: true } : { ok: false, error: firstLine(r.stderr) || firstLine(r.stdout) || `herdr ${args.slice(0, 2).join(' ')} failed` };
}

// $VISUAL or $EDITOR run in this terminal (the caller suspends the UI first);
// otherwise macOS `open -t` hands the file to the default text editor and returns at
// once. Never plain `open`: a memo is agent-supplied, and Launch Services would run a
// .command script or launch an app bundle.
export function viewerFor(env = process.env) {
  const editor = (env.VISUAL || env.EDITOR || '').trim();
  if (editor) {
    const [cmd, ...args] = editor.split(/\s+/);
    return { cmd, args, blocking: true, label: path.basename(cmd) };
  }
  return { cmd: 'open', args: ['-t'], blocking: false, label: 'the default text editor' };
}

export function openBlocking(viewer, file) {
  const r = spawnSync(viewer.cmd, [...viewer.args, file], { stdio: 'inherit' });
  return r.error ? { ok: false, error: r.error.message } : { ok: r.status === 0, error: r.status ? `${viewer.label} exited ${r.status}` : null };
}

export function openDetached(viewer, file) {
  return new Promise((resolve) => {
    const child = spawn(viewer.cmd, [...viewer.args, file], { stdio: 'ignore', detached: true });
    child.on('error', (error) => resolve({ ok: false, error: error.message }));
    child.on('exit', (code) => resolve({ ok: code === 0, error: code ? `${viewer.label} exited ${code}` : null }));
    child.unref();
  });
}
