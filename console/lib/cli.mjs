// The console's only ways to touch the world: the org CLI (child process, argument
// arrays), Herdr's agent and tab lists, focus, screen reads and prompts, a new chat
// tab the operator started, Herdr's
// right-click routing for the console's own pane, and an external viewer. It never
// appends to events.jsonl and never stops or closes agents. The only message it
// sends into a session is one the operator typed or confirmed (herdrPrompt).
//
// Right clicks: Herdr keeps them for its pane menu unless the pane asks. While the
// console runs, app.mjs calls `herdr pane input --right-click pane $HERDR_PANE_ID`
// (herdrRightClick) so right clicks reach the console, and gives them back with
// `--right-click herdr` on quit, suspend and crash. Herdr's own pane menu is not
// available in that pane meanwhile. Without HERDR_PANE_ID nothing is routed.
import { execFile, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentList, parseTabList } from './sources.mjs';

export const ORG_BIN = process.env.HERDR_ORG_BIN || fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
export const herdrBinary = () => process.env.HERDR_BIN_PATH || 'herdr';

function run(cmd, args, { env, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout, stderr, error });
    });
  });
}

function orgEnv(project) {
  // Writes from the console are the operator's own, and say so: an inherited
  // session name must not be used, and without a terminal an unnamed write
  // would be flagged unattributed.
  return { ...process.env, ORG_DIR: project.org, ORG_ACTOR: 'human' };
}

function firstLine(text) {
  return String(text ?? '').trim().split('\n')[0].replace(/^org:\s*/, '');
}

export async function orgToday(project) {
  const r = await run(process.execPath, [ORG_BIN, 'today', '--json'], { env: orgEnv(project) });
  if (!r.ok) throw new Error(firstLine(r.stderr) || r.error?.message || 'org today failed');
  return JSON.parse(r.stdout);
}

// Recent events, one JSON object per line, for the items pane.
export async function orgLog(project, since = '36h') {
  const r = await run(process.execPath, [ORG_BIN, 'log', '--since', since, '--json'], { env: orgEnv(project) });
  if (!r.ok) throw new Error(firstLine(r.stderr) || r.error?.message || 'org log failed');
  return r.stdout.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

export async function orgStatus(project) {
  const r = await run(process.execPath, [ORG_BIN, 'status', '--json'], { env: orgEnv(project) });
  if (!r.ok) throw new Error(firstLine(r.stderr) || r.error?.message || 'org status failed');
  const doc = JSON.parse(r.stdout);
  if (!Array.isArray(doc.items) || !Array.isArray(doc.runs)) throw new Error('unexpected org status output');
  return doc;
}

// One work block, top down (org recap --json). back=0 is the latest block.
export async function orgRecap(project, back = 0) {
  const r = await run(process.execPath, [ORG_BIN, 'recap', '--json', ...(back ? ['--back', String(back)] : [])], { env: orgEnv(project) });
  if (!r.ok) throw new Error(firstLine(r.stderr) || r.error?.message || 'org recap failed');
  const doc = JSON.parse(r.stdout);
  if (!Array.isArray(doc.threads) || !Array.isArray(doc.waiting)) throw new Error('unexpected org recap output');
  return doc;
}

// The live trial reads topology separately so an unavailable source never looks
// like an empty project. Keep opaque IDs and Git identity supplied by Herdr.
export async function herdrList(resource) {
  if (!['workspace', 'tab', 'pane'].includes(resource)) throw new Error('unknown Herdr resource');
  const r = await run(herdrBinary(), [resource, 'list'], { timeout: 4000 });
  if (!r.ok) throw new Error(firstLine(r.stderr) || r.error?.message || `Herdr ${resource} list failed`);
  const rows = JSON.parse(r.stdout)?.result?.[`${resource}s`];
  if (!Array.isArray(rows)) throw new Error(`unexpected Herdr ${resource} list output`);
  return rows;
}

export function answerArgs({ question, answer, note, overrule }) {
  // --note=… keeps a reason that starts with a dash from reading as an option.
  return ['answer', question, answer, ...(note ? [`--note=${note}`] : []), ...(overrule ? ['--overrule'] : [])];
}

export async function orgAnswer(project, request) {
  const r = await run(process.execPath, [ORG_BIN, ...answerArgs(request)], { env: orgEnv(project) });
  return r.ok ? { ok: true, output: r.stdout.trim() } : { ok: false, error: firstLine(r.stderr) || r.error?.message || 'org answer failed' };
}

// A plain note on an item, as the operator. Best effort: a failure is reported, never fatal.
export async function orgNote(project, id, text, { decision = false } = {}) {
  const r = await run(process.execPath, [ORG_BIN, 'note', id, text, ...(decision ? ['--decision'] : [])], { env: orgEnv(project) });
  return r.ok ? { ok: true } : { ok: false, error: firstLine(r.stderr) || 'org note failed' };
}

// A task the operator typed, under the work block when there is one.
export function addArgs({ title, parent }) {
  // `--` keeps a title that starts with a dash from reading as an option.
  return ['add', ...(parent ? [`--parent=${parent}`] : []), '--', title];
}

export async function orgAdd(project, request) {
  const r = await run(process.execPath, [ORG_BIN, ...addArgs(request)], { env: orgEnv(project) });
  return r.ok ? { ok: true, id: firstLine(r.stdout) } : { ok: false, error: firstLine(r.stderr) || r.error?.message || 'org add failed' };
}

// A new chat the operator asked for: a tab in the chosen checkout, a supported
// agent started at its shell prompt, then the operator's first words, if any.
export async function herdrStartChat({ workspace, cwd, kind, name, prompt }) {
  const herdr = herdrBinary();
  // The chat's org writes carry its Herdr agent name, so the record and the
  // live session join exactly (ORG_ACTOR is identity, never authority).
  const tab = await run(herdr, ['tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', 'chat', '--env', `ORG_ACTOR=${name}`, '--no-focus'], { timeout: 5000 });
  if (!tab.ok) return { ok: false, error: firstLine(tab.stderr) || 'herdr tab create failed' };
  let pane = null;
  try { pane = JSON.parse(tab.stdout)?.result?.root_pane?.pane_id ?? null; } catch { /* reported below */ }
  if (!pane) return { ok: false, error: 'Herdr created a tab but reported no pane' };
  const start = await run(herdr, ['agent', 'start', name, '--kind', kind, '--pane', pane], { timeout: 35000 });
  if (!start.ok) return { ok: false, pane, error: firstLine(start.stderr) || firstLine(start.stdout) || `herdr could not start ${kind}` };
  if (prompt) {
    const sent = await herdrPrompt(name, prompt);
    if (!sent.ok) return { ...sent, pane, error: `Started, but the first message was not sent: ${sent.error}` };
  }
  return { ok: true, pane, name };
}

// The operator's own name for a session: a display-only pane label. Agent
// names are left alone, since org runs are linked to them.
export async function herdrRename(pane, label) {
  // Herdr keeps a `--` as part of the label, so a leading dash is dropped instead.
  const text = String(label ?? '').trim().replace(/^-+\s*/, '');
  const args = text ? ['pane', 'rename', pane, text] : ['pane', 'rename', pane, '--clear'];
  const r = await run(herdrBinary(), args, { timeout: 4000 });
  return r.ok ? { ok: true } : { ok: false, error: firstLine(r.stderr) || firstLine(r.stdout) || 'herdr pane rename failed' };
}

export async function herdrAgents() {
  const r = await run(herdrBinary(), ['agent', 'list'], { timeout: 4000 });
  if (!r.ok) return { ok: false, agents: [], error: firstLine(r.stderr) || r.error?.code || 'herdr agent list failed' };
  try {
    return { ok: true, agents: parseAgentList(r.stdout) };
  } catch (error) {
    return { ok: false, agents: [], error: error.message };
  }
}

export async function herdrTabs() {
  const r = await run(herdrBinary(), ['tab', 'list'], { timeout: 4000 });
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
  const r = await run(herdrBinary(), args, { timeout: 4000 });
  return r.ok ? { ok: true } : { ok: false, error: firstLine(r.stderr) || firstLine(r.stdout) || `herdr ${args.slice(0, 2).join(' ')} failed` };
}

// A session's screen as plain text, for the peek. `recent-unwrapped` because the
// session's pane is a different width than the peek, and a pre-wrapped screen
// would arrive broken at the wrong width. An unnamed agent is read by its pane.
export function readArgs({ agent, pane }, lines = 400) {
  const tail = ['--source', 'recent-unwrapped', '--lines', String(lines), '--format', 'text'];
  if (agent) return ['agent', 'read', agent, ...tail];
  if (pane) return ['pane', 'read', pane, ...tail];
  return null;
}

// What a pane shows right now, and nothing more. The `recent` sources make Herdr
// scroll a full-screen app such as Claude Code to collect its history, which the
// operator sees as the session scrolling up by itself; `visible` touches nothing.
export async function herdrVisible(pane) {
  const r = await run(herdrBinary(), ['pane', 'read', pane, '--source', 'visible', '--format', 'text'], { timeout: 4000 });
  return r.ok ? { ok: true, text: r.stdout } : { ok: false, error: firstLine(r.stderr) || 'herdr pane read failed' };
}

export async function herdrRead(target, lines = 400) {
  const args = readArgs(target, lines);
  if (!args) return { ok: false, error: 'no Herdr agent or pane to read' };
  const r = await run(herdrBinary(), args, { timeout: 5000 });
  if (!r.ok) return { ok: false, error: firstLine(r.stderr) || firstLine(r.stdout) || 'herdr read failed' };
  // `agent read` answers in JSON on some versions and plain text on others.
  try {
    const body = JSON.parse(r.stdout);
    const text = body?.result?.text ?? body?.result?.output ?? body?.result?.content;
    if (typeof text === 'string') return { ok: true, text };
  } catch {
    // plain text
  }
  return { ok: true, text: r.stdout };
}

// Sends the operator's words to a session. Herdr refuses a session stuck at a
// prompt before sending anything (agent_blocked), so this cannot jam one.
export async function herdrPrompt(agent, text) {
  if (!agent) return { ok: false, error: 'that session has no name Herdr can address' };
  const r = await run(herdrBinary(), ['agent', 'prompt', agent, text], { timeout: 30000 });
  if (r.ok) return { ok: true };
  const msg = `${r.stderr ?? ''}${r.stdout ?? ''}`;
  return { ok: false, blocked: /agent_blocked/.test(msg), error: firstLine(r.stderr) || firstLine(r.stdout) || 'herdr agent prompt failed' };
}

// Herdr opens its own pane menu on a right click unless the pane asks for right clicks.
// The console asks for its own pane (target "pane") while it runs and gives them back
// ("herdr") when it stops. Synchronous, so it also works while the process exits.
export function herdrRightClick(pane, target) {
  if (!pane) return false;
  const r = spawnSync(herdrBinary(), ['pane', 'input', '--right-click', target, pane], { stdio: 'ignore', timeout: 3000 });
  return !r.error && r.status === 0;
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
