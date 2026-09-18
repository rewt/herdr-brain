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

// A row that says "send your stranded reply" without saying which reply is
// useless, so the operator's own words go in the title when nothing else
// already carries them.
export function titleFor(entry, digest) {
  const asked = digest?.question ?? entry.headline ?? entry.title ?? 'a session stopped';
  const reply = entry.unsent?.split('\n')[0]?.trim();
  if (!reply) return asked;
  const head = reply.slice(0, 16).toLowerCase();
  if (asked.toLowerCase().includes(head)) return asked;
  const short = reply.length > 44 ? `${reply.slice(0, 43)}…` : reply;
  // A generic prompt is replaced; a real question keeps its words and is tagged.
  return /stranded|your (typed )?reply|send (it|your)/i.test(asked)
    ? `Send your reply: "${short}"`
    : `${asked} — you said "${short}"`;
}

// The shape `questionRow` consumes: id, title, category, recommend, created, memo.
export function asQuestions(rows) {
  return rows
    .map((r) => {
      const d = r.digest;
      const recommended = d?.options?.find((o) => o.key === d.recommend);
      return {
        id: r.id,
        title: titleFor(r, d),
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
