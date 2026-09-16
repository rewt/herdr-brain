// Reading what the console shows besides org: the session ledger, Claude transcripts
// and Herdr's agent list. Parsers are pure; file access goes through `fsApi` so tests
// can use fixtures. Nothing here writes.
import nodeFs from 'node:fs';
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

// The text of the last assistant message: its text blocks joined, tool calls ignored.
export function lastAssistantText(jsonlText) {
  const lines = String(jsonlText).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"assistant"')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== 'assistant' || e.isSidechain) continue;
    const content = e.message?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n') : '';
    if (text.trim()) return { text: text.trim(), at: e.timestamp ?? null };
  }
  return null;
}

// Finds and reads session transcripts, caching per file by modification time.
export function createSessionReader({ fsApi = nodeFs } = {}) {
  const files = new Map(); // file → { mtimeMs, size, names, note }
  const located = new Map(); // `${dirs}|${name}` → file

  function stat(file) {
    try {
      const st = fsApi.statSync(file);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  }

  function load(file) {
    const st = stat(file);
    if (!st) return null;
    const cached = files.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
    let text;
    try {
      text = fsApi.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    const entry = { ...st, names: agentNames(text), note: lastAssistantText(text) };
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
          if (st && st.mtimeMs >= sinceMs) out.push({ file, mtimeMs: st.mtimeMs });
        }
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs).map((c) => c.file);
  }

  // Only transcripts touched since `sinceMs` are read: a session in today's ledger wrote today.
  function find({ configDirs, cwd, name, sinceMs = 0 }) {
    const key = `${configDirs.join(':')}|${cwd}|${name}`;
    const known = located.get(key);
    if (known && load(known)?.names.has(name)) return known;
    for (const file of candidates(configDirs, cwd, sinceMs)) {
      if (load(file)?.names.has(name)) {
        located.set(key, file);
        return file;
      }
    }
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
    const sessions = entries.map((entry) => {
      const file = find({ configDirs, cwd, name: entry.name, sinceMs });
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

// The first absolute markdown path in a note's text.
export function firstMarkdownPath(text) {
  const m = /(?:^|[\s(`'"])((?:\/|~\/)[^\s`'"()<>]+\.md)\b/.exec(String(text ?? ''));
  return m ? m[1] : null;
}
