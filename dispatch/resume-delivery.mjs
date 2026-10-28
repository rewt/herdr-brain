// Resume delivery is append-only transcript evidence, separate from native
// process identity. Read only the requested conversation in the launch home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const digest = text => createHash('sha256').update(text).digest('hex');
const maxTail = 8 * 1024 * 1024;
export const resumePrompt = (delivery, name) => delivery.template.replaceAll(delivery.marker, name);

function plain(file) {
  if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw Error('resume transcript is redirected or not a regular file');
  return fs.statSync(file);
}
function transcript(route, session, workspace, env) {
  const effective = { ...env, ...Object.fromEntries((route.env ?? []).map(pair => {
    const at = pair.indexOf('='); return [pair.slice(0, at), pair.slice(at + 1)];
  })) };
  const home = effective.HOME || os.homedir();
  if (route.kind === 'claude') return path.join(path.resolve(workspace, effective.CLAUDE_CONFIG_DIR || path.join(home, '.claude')),
    'projects', workspace.replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`);
  const root = path.join(path.resolve(workspace, effective.CODEX_HOME || path.join(home, '.codex')), 'sessions');
  const matches = [];
  // Codex's year/month/day layout. Do not follow symlinks or search other homes.
  function visit(dir, depth) {
    if (fs.realpathSync(dir) !== dir) throw Error('resume transcript directory is redirected');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3 && /^\d+$/.test(entry.name)) visit(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(`-${session}.jsonl`)) matches.push(file);
    }
  }
  visit(root, 0);
  if (matches.length !== 1) throw Error('resume transcript is missing or ambiguous in the configured launch home');
  return matches[0];
}
function readRange(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(length), count = fs.readSync(fd, bytes, 0, length, start);
    if (count !== length) throw Error('resume transcript changed while reading');
    return bytes.toString('utf8');
  } finally { fs.closeSync(fd); }
}
export function prepareResumeDelivery({ route, session, workspace, template, marker, env = process.env, now = Date.now }) {
  const file = transcript(route, session, workspace, env), stat = plain(file);
  if (stat.size && readRange(file, stat.size - 1, 1) !== '\n') throw Error('resume transcript has an incomplete tail before launch');
  // Read the native ID from persisted metadata, never use the requested UUID as
  // the observed identity. Fresh prompt/cwd evidence below is still mandatory.
  const header = readRange(file, 0, Math.min(stat.size, 1024 * 1024)).split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  });
  const sessionId = route.kind === 'codex' ? header.find(e => e?.type === 'session_meta')?.payload?.id
    : header.find(e => typeof e?.sessionId === 'string')?.sessionId;
  if (sessionId !== session) throw Error('resume transcript identity differs from the saved conversation');
  return { harness: route.kind, file, device: stat.dev, inode: stat.ino, offset: stat.size,
    session: sessionId, cwd: workspace, template, marker, started_at: new Date(now()).toISOString() };
}
export function observeResumeDelivery(delivery, workerName, now = Date.now) {
  const stat = plain(delivery.file), length = stat.size - delivery.offset;
  if (stat.dev !== delivery.device || stat.ino !== delivery.inode || length < 0) throw Error('resume transcript replaced or truncated');
  if (length > maxTail) throw Error('resume transcript delivery tail exceeds the bounded read');
  const tail = readRange(delivery.file, delivery.offset, length), end = tail.lastIndexOf('\n');
  if (end < 0) return null;
  const rows = tail.slice(0, end).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const prompt = resumePrompt(delivery, workerName);
  let task = false, folder = false, turn;
  for (const row of rows) {
    if (delivery.harness === 'codex') {
      if (row.type === 'session_meta' && row.payload?.id !== delivery.session) throw Error('resume transcript session changed');
      if (row.type === 'event_msg' && row.payload?.type === 'task_started') {
        task = folder = false;
        turn = row.payload.turn_id;
      }
      if (row.type === 'turn_context') {
        if (turn && row.payload?.turn_id && turn !== row.payload.turn_id) task = false;
        turn = row.payload?.turn_id ?? turn;
        if (row.payload?.cwd !== delivery.cwd) throw Error('resume task ran in a different folder');
        folder = true;
      }
      const p = row.payload;
      const text = row.type === 'event_msg' && p?.type === 'user_message' ? p.message
        : row.type === 'response_item' && p?.type === 'message' && p.role === 'user'
          ? p.content?.filter(c => c.type === 'input_text').map(c => c.text).join('\n') : null;
      if (text === prompt) task = true;
    } else if (row.type === 'user' && !row.isMeta) {
      const content = row.message?.content;
      const text = typeof content === 'string' ? content : content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (text === prompt) {
        if (row.sessionId !== delivery.session || row.cwd !== delivery.cwd) throw Error('resume task session or folder differs');
        task = folder = true;
      }
    }
    // Never pair one turn's task with a later turn's folder context.
    if (task && folder) break;
  }
  if (!task || !folder) return null;
  return { session: delivery.session, cwd: delivery.cwd, file: delivery.file, device: delivery.device, inode: delivery.inode,
    offset: delivery.offset, end: delivery.offset + end + 1, prompt_sha256: digest(prompt), observed_at: new Date(now()).toISOString() };
}
export function validResumeDelivery(job, proposed) {
  if (!job.resumeDeliveryProtocol) return true;
  const d = job.resumeDelivery, r = d?.receipt;
  return Boolean(r && job.resumeSession === r.session && proposed.session === r.session && r.cwd === job.workspace &&
    r.file === d.file && r.device === d.device && r.inode === d.inode && r.offset === d.offset && r.end > r.offset &&
    r.prompt_sha256 === digest(resumePrompt(d, job.worker.agentName)) &&
    proposed.prompted_at === d.started_at && Date.parse(r.observed_at) >= Date.parse(d.started_at) &&
    Date.parse(r.observed_at) <= Date.parse(proposed.observed_at));
}
