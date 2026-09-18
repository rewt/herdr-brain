// What sessions left behind, from the brain queue, shaped like the questions
// the board already knows how to draw.
//
// The queue is the record of a session stopping: what it said, the dialog it
// is stuck at, and any reply the operator typed that never got sent. None of
// it comes from org, so it reaches the board as its own rows and nothing in
// the org path changes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Newest first; the board sorts by its own rules after this.
export async function readQueue(bin, { timeout = 8000 } = {}) {
  if (!bin) return { rows: [], off: true };
  try {
    const { stdout } = await run(process.execPath, [bin, 'queue', '--json'], { timeout, maxBuffer: 32 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    return { rows: Array.isArray(parsed) ? parsed : [], off: false };
  } catch (err) {
    return { rows: [], off: false, error: err.stderr?.toString().trim() || err.message };
  }
}

// `stranded` is its own category because it is the most urgent thing on the
// machine: the operator answered and the answer never left the prompt box.
export function categoryOf(entry) {
  if (entry.unsent) return 'stranded';
  return entry.digest?.kind ?? (entry.state === 'blocked' ? 'obstacle' : 'finished');
}

const RANK = { stranded: 0, decision: 1, obstacle: 2, finished: 3 };

// The shape `questionRow` consumes: id, title, category, recommend, created, memo.
export function asQuestions(rows) {
  return rows
    .map((r) => {
      const d = r.digest;
      const recommended = d?.options?.find((o) => o.key === d.recommend);
      return {
        id: r.id,
        title: d?.question ?? r.headline ?? r.title ?? 'a session stopped',
        category: categoryOf(r),
        recommend: recommended ? `${recommended.key} · ${recommended.label}` : d?.recommend ?? null,
        created: { at: r.at, by: r.session },
        memo: null,
        blocks: [],
        status: r.state === 'blocked' ? 'blocked' : 'ready',
        // Carried through for the detail view and the verbs.
        brain: r,
      };
    })
    .sort((a, b) => (RANK[a.category] ?? 8) - (RANK[b.category] ?? 8) || (a.created.at < b.created.at ? 1 : -1));
}
