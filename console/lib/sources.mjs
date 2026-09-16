// Reading what the console shows besides org: the session ledger, Claude transcripts
// and Herdr's agent list. Parsers are pure; file access goes through `fsApi` so tests
// can use fixtures. Nothing here writes.
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// "HH:MM:SS name mode subject" per line (contrib/settle-watch.mjs writes it).
export function parseLedger(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(\d{2}:\d{2}(?::\d{2})?)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line.trim());
    if (m) out.push({ time: m[1], name: m[2], mode: m[3], subject: m[4]?.trim() || null });
  }
  return out;
}

export function ledgerFile(dir, date) {
  return path.join(dir, `sessions-${date}.log`);
}

// Claude names a project directory after its cwd. The spec's rule replaces "/";
// Claude also replaces other punctuation (".worktrees" becomes "-worktrees"), so both are tried.
export function projectSlugs(cwd) {
  const abs = path.resolve(cwd);
  return [...new Set([abs.replace(/\//g, '-'), abs.replace(/[^A-Za-z0-9-]/g, '-')])];
}

export function agentNames(jsonlText) {
  const names = new Set();
  for (const line of String(jsonlText).split('\n')) {
    if (!line.includes('agent-name')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'agent-name' && typeof e.agentName === 'string') names.add(e.agentName);
    } catch {
      // A partly written last line is normal while the session runs.
    }
  }
  return names;
}

// One transcript line as an assistant note ({ text, at }), or null: text blocks
// joined, tool calls ignored.
function assistantNote(line) {
  if (!line.includes('"assistant"')) return null;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  if (e.type !== 'assistant' || e.isSidechain) return null;
  const content = e.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n') : '';
  return text.trim() ? { text: text.trim(), at: e.timestamp ?? null } : null;
}

// The text of the last assistant message.
export function lastAssistantText(jsonlText) {
  const lines = String(jsonlText).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const note = assistantNote(lines[i]);
    if (note) return note;
  }
  return null;
}

const CHUNK = 1 << 20;

// Finds and reads session transcripts. Each file is read once, then only the bytes
// appended since: agent names and the last assistant note are kept per file, so a
// refresh costs a stat and the new lines. A name not found stays unsearched until a
// transcript in the folders grows or appears.
export function createSessionReader({ fsApi = nodeFs } = {}) {
  const files = new Map(); // file → { mtimeMs, size, offset, names, note }
  const located = new Map(); // `${dirs}|${cwd}|${name}` → file
  const missing = new Map(); // same key → candidate signature when last searched

  function stat(file) {
    try {
      const st = fsApi.statSync(file);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  }

  function readLines(file, entry, size) {
    let fd;
    try {
      fd = fsApi.openSync(file, 'r');
    } catch {
      return false;
    }
    try {
      const buf = Buffer.alloc(CHUNK);
      let carry = Buffer.alloc(0);
      let pos = entry.offset;
      while (pos < size) {
        const n = fsApi.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
        if (n <= 0) break;
        pos += n;
        const data = Buffer.concat([carry, buf.subarray(0, n)]);
        const end = data.lastIndexOf(10);
        // A partly written last line is normal while the session runs: it is read next time.
        carry = end < 0 ? data : data.subarray(end + 1);
        if (end < 0) continue;
        for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
          if (line.includes('agent-name')) agentNames(line).forEach((name) => entry.names.add(name));
          entry.note = assistantNote(line) ?? entry.note;
        }
      }
      entry.offset = pos - carry.length;
      return true;
    } finally {
      fsApi.closeSync(fd);
    }
  }

  function load(file, st = stat(file)) {
    if (!st) return null;
    let entry = files.get(file);
    if (entry && entry.mtimeMs === st.mtimeMs && entry.size === st.size) return entry;
    // A file that shrank was rewritten: start over.
    if (!entry || st.size < entry.offset) entry = { offset: 0, names: new Set(), note: null };
    if (!readLines(file, entry, st.size)) return null;
    Object.assign(entry, st);
    files.set(file, entry);
    return entry;
  }

  function candidates(dirs, cwd, sinceMs) {
    const out = [];
    for (const dir of dirs) {
      for (const slug of projectSlugs(cwd)) {
        const folder = path.join(dir, 'projects', slug);
        let names;
        try {
          names = fsApi.readdirSync(folder);
        } catch {
          continue;
        }
        for (const n of names) {
          if (!n.endsWith('.jsonl')) continue;
          const file = path.join(folder, n);
          const st = stat(file);
          if (st && st.mtimeMs >= sinceMs) out.push({ file, ...st });
        }
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  // Only transcripts touched since `sinceMs` are read: a session in today's ledger wrote today.
  function find({ configDirs, cwd, name, sinceMs = 0 }, list = null) {
    const key = `${configDirs.join(':')}|${cwd}|${name}`;
    const known = located.get(key);
    if (known && load(known)?.names.has(name)) return known;
    located.delete(key);
    const found = list ?? candidates(configDirs, cwd, sinceMs);
    const signature = found.map((c) => `${c.file}:${c.size}`).join('|');
    if (missing.get(key) === signature) return null;
    for (const c of found) {
      if (load(c.file, c)?.names.has(name)) {
        located.set(key, c.file);
        missing.delete(key);
        return c.file;
      }
    }
    missing.set(key, signature);
    return null;
  }

  function notes({ ledgerDir, date, configDirs, cwd, sinceMs = 0 }) {
    let text;
    try {
      text = fsApi.readFileSync(ledgerFile(ledgerDir, date), 'utf8');
    } catch (error) {
      return { sessions: [], count: 0, error: error.code === 'ENOENT' ? null : `ledger unreadable: ${error.code ?? error.message}` };
    }
    const entries = parseLedger(text);
    let list = null;
    const sessions = entries.map((entry) => {
      const args = { configDirs, cwd, name: entry.name, sinceMs };
      // The folders are listed once per call, and only if some name is not located yet.
      const known = located.get(`${configDirs.join(':')}|${cwd}|${entry.name}`);
      if (!known) list ??= candidates(configDirs, cwd, sinceMs);
      const file = find(args, known ? null : list);
      const note = file ? files.get(file)?.note ?? null : null;
      return { ...entry, transcript: file, note: note?.text ?? null, note_at: note?.at ?? null };
    });
    return { sessions, count: entries.length, error: null };
  }

  return { find, notes, load };
}

export function stopFileExists(ledgerDir, fsApi = nodeFs) {
  return Boolean(ledgerDir) && fsApi.existsSync(path.join(ledgerDir, 'STOP'));
}

// herdr agent list → [{ name, status, tab, pane, cwd, workspace }]
export function parseAgentList(stdout) {
  const body = JSON.parse(stdout);
  const agents = body?.result?.agents;
  if (!Array.isArray(agents)) throw new Error('unexpected herdr agent list output');
  return agents.map((a) => ({
    name: a.name ?? null,
    status: a.agent_status ?? 'unknown',
    tab: a.tab_id ?? null,
    pane: a.pane_id ?? null,
    cwd: a.cwd ?? null,
    workspace: a.workspace_id ?? null,
  }));
}

export const EXECUTIVE_RE = /^(settle|exec|plan|audit)-/;

// The first absolute markdown path in a note's text; a leading ~/ means the home folder.
export function firstMarkdownPath(text, home = os.homedir()) {
  const m = /(?:^|[\s(`'"])((?:\/|~\/)[^\s`'"()<>]+\.md)\b/.exec(String(text ?? ''));
  if (!m) return null;
  return m[1].startsWith('~/') ? path.join(home, m[1].slice(2)) : m[1];
}
