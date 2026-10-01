// The chat index: every code a supervisor chat has mentioned, kept in a state
// file the items pane reads. The source is the chat's own Claude transcript,
// read incrementally from where the index stopped, so nothing depends on where
// the screen is scrolled and nothing touches the chat's pane. A new transcript
// after a context clear or handoff is added beside the old ones. The index is
// observation only: it is never written to the org, and deleting it loses
// nothing that the transcripts do not still hold.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CODE = /(?<![\w.-])([A-Z][A-Z0-9]{0,5}-\d{1,5}|\d{1,2}[A-Z](?:-[A-Z]{1,4}\d*)?|\d{1,2}-[A-Z]{1,4}\d*)(?![\w-])/g;
const MAX_MESSAGES = 12;

export function indexFile(project, env = process.env) {
  const base = env.HERDR_BRAIN_STATE ?? path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'herdr-brain');
  return path.join(base, String(project ?? 'default').replace(/[^\w.-]/g, '_'), 'chat-index.json');
}

// Where Claude Code keeps a session's transcript: <config>/projects/<slug>/<id>.jsonl.
export function transcriptPath(sessionId, cwd, { home = os.homedir(), env = process.env, fsApi = fs } = {}) {
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) return null;
  const slugs = [...new Set([cwd.replace(/[/.]/g, '-'), cwd.replace(/[^A-Za-z0-9]/g, '-')])];
  let dirs = [];
  try { dirs = fsApi.readdirSync(home).filter(d => /^\.claude/.test(d)).map(d => path.join(home, d)); } catch {}
  if (env.CLAUDE_CONFIG_DIR) dirs.unshift(env.CLAUDE_CONFIG_DIR);
  for (const dir of dirs) for (const slug of slugs) {
    const file = path.join(dir, 'projects', slug, `${sessionId}.jsonl`);
    try { if (fsApi.statSync(file).isFile()) return file; } catch {}
  }
  return null;
}

const textOf = e => {
  const c = e?.message?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x?.type === 'text').map(x => x.text).join('\n') : '';
};
// Who said it: the supervisor, the operator, or a watcher's delivered notice.
export const roleOf = (e, text) => e.type === 'assistant' ? 'supervisor' : /^\s*\[(org-report|watch|notify)\]/.test(text) ? 'notice' : 'operator';

// The sentence around a mention, enough to see what was said about it.
export function snippet(text, at, width = 160) {
  const flat = text.replace(/\s+/g, ' ');
  const i = flat.indexOf(at);
  if (i < 0) return flat.slice(0, width);
  const start = Math.max(0, flat.lastIndexOf('. ', i) + 1, i - width / 2), end = Math.min(flat.length, start + width);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

// Adds one transcript line's mentions to the index. Pure, for tests.
export function addLine(index, line, session) {
  let e; try { e = JSON.parse(line); } catch { return false; }
  if (e?.type !== 'assistant' && e?.type !== 'user') return false;
  const text = textOf(e); if (!text.trim()) return false;
  const role = roleOf(e, text), at = e.timestamp ?? null;
  const codes = [...new Set([...text.matchAll(CODE)].map(m => m[1]))];
  for (const code of codes) {
    const m = (index.mentions[code] ??= { first: at, last: at, count: 0, messages: [] });
    m.last = at; m.count++;
    if (role !== 'notice' || !m.messages.length) m.messages.push({ at, role, session, text: snippet(text, code) });
    if (m.messages.length > MAX_MESSAGES) m.messages.splice(0, m.messages.length - MAX_MESSAGES);
  }
  if (role === 'supervisor') index.lastTurn = { at, session, codes };
  else if (role === 'operator') index.lastOperatorAt = at;
  return codes.length > 0;
}

export function createChatIndex({ file, fsApi = fs }) {
  let index = { version: 1, sessions: {}, mentions: {}, lastTurn: null, lastOperatorAt: null };
  try { const saved = JSON.parse(fsApi.readFileSync(file, 'utf8')); if (saved?.version === 1) index = saved; } catch {}
  return {
    get data() { return index; },
    // Reads what a transcript gained since last time; a partial last line waits.
    update(sessionId, transcript) {
      if (!transcript) return false;
      const s = (index.sessions[sessionId] ??= { file: transcript, offset: 0, seen: new Date().toISOString() });
      let size; try { size = fsApi.statSync(transcript).size; } catch { return false; }
      if (size < s.offset) s.offset = 0;
      if (size === s.offset) return false;
      const fd = fsApi.openSync(transcript, 'r');
      try {
        const buf = Buffer.alloc(size - s.offset); fsApi.readSync(fd, buf, 0, buf.length, s.offset);
        const text = buf.toString('utf8'), end = text.lastIndexOf('\n');
        if (end < 0) return false;
        let changed = false;
        for (const line of text.slice(0, end).split('\n')) if (line.trim() && addLine(index, line, sessionId)) changed = true;
        s.offset += Buffer.byteLength(text.slice(0, end + 1));
        fsApi.mkdirSync(path.dirname(file), { recursive: true });
        fsApi.writeFileSync(`${file}.tmp`, JSON.stringify(index)); fsApi.renameSync(`${file}.tmp`, file);
        return changed;
      } finally { fsApi.closeSync(fd); }
    },
  };
}
