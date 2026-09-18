// What sessions left behind, from the brain queue, shaped like the questions
// the board already knows how to draw.
//
// The queue is the record of a session stopping: what it said, the dialog it
// is stuck at, and any reply the operator typed that never got sent. None of
// it comes from org, so it reaches the board as its own rows and nothing in
// the org path changes.
//
// Acting on a row goes through the brain CLI too (brainArgs), so the queue
// records what was done and the row leaves the list on the next read.
import { execFile } from 'node:child_process';
import path from 'node:path';
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

const RANK = { stranded: 0, decision: 1, obstacle: 2, finished: 3, report: 3 };

// What each category means, in the words the row shows.
export const CATEGORY_WORDS = {
  stranded: 'your reply never sent',
  decision: 'needs your decision',
  obstacle: 'stuck at a prompt',
  finished: 'finished',
  report: 'finished',
};

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

// The choices a row offers and how a choice is delivered. A session stuck at a
// dialog is answered by pressing the dialog's own key; a session that finished
// and asked something in prose is answered by sending the chosen words.
export function choicesOf(entry) {
  const d = entry.digest ?? {};
  const dialog = entry.state === 'blocked' ? entry.dialog?.options ?? [] : [];
  if (dialog.length) {
    const causes = new Map((d.options ?? []).map((o) => [String(o.key), o.causes]));
    return {
      via: 'key',
      options: dialog.map((o) => ({ key: String(o.key), label: o.label, causes: causes.get(String(o.key)) ?? '' })),
      recommend: d.recommend != null && dialog.some((o) => String(o.key) === String(d.recommend)) ? String(d.recommend) : null,
    };
  }
  const options = (d.options ?? []).filter((o) => o?.key != null && o.label).map((o) => ({ key: String(o.key), label: o.label, causes: o.causes ?? '' }));
  return {
    via: 'send',
    options,
    recommend: d.recommend != null && options.some((o) => o.key === String(d.recommend)) ? String(d.recommend) : null,
  };
}

// The shape `questionRow` consumes: id, title, category, recommend, created, memo.
export function asQuestions(rows) {
  return rows
    .map((r) => {
      const d = r.digest;
      const choices = choicesOf(r);
      const recommended = choices.options.find((o) => o.key === choices.recommend);
      return {
        id: r.id,
        title: titleFor(r, d),
        category: categoryOf(r),
        recommend: recommended ? `${recommended.key} · ${recommended.label}` : d?.recommend ?? null,
        created: { at: r.at, by: r.session },
        memo: null,
        blocks: [],
        status: r.state === 'blocked' ? 'blocked' : 'ready',
        later: r.status === 'later',
        options: choices.options,
        via: choices.via,
        recommendKey: choices.recommend,
        item: d?.item ?? null,
        gist: d?.gist ?? null,
        explain: d?.explain ?? d?.what_happened ?? null,
        why: d?.why ?? null,
        // Carried through for the detail view and the verbs.
        brain: r,
      };
    })
    .sort((a, b) => (RANK[a.category] ?? 8) - (RANK[b.category] ?? 8) || (a.created.at < b.created.at ? 1 : -1));
}

// The brain CLI arguments for a verb on a result. `id` is the queue id, which
// is unique; handles and session names are for typing at a shell.
//   pick   { key } of an option: pressed in a dialog, or its label sent as a reply
//   send   { text }: a reply in the operator's words, or Claude's draft accepted
//   later, drop
export function brainArgs(verb, row, { key, text } = {}) {
  const id = row.data?.id ?? row.question;
  switch (verb) {
    case 'pick': {
      const option = row.options?.find((o) => o.key === String(key));
      if (!option) return null;
      return row.via === 'key' ? ['key', id, option.key] : ['send', id, option.label];
    }
    case 'send':
      return text?.trim() ? ['send', id, text.trim()] : null;
    case 'later':
      return ['later', id];
    case 'drop':
      // A finished report is read, not refused; anything else will not come back.
      return ['finished', 'report'].includes(row.category) ? ['dismiss', id] : ['never', id];
    default:
      return null;
  }
}

export async function brainAct(bin, args, { timeout = 45000 } = {}) {
  if (!bin) return { ok: false, error: 'no brain_bin configured' };
  try {
    const { stdout } = await run(process.execPath, [bin, ...args], { timeout, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    const text = `${err.stderr ?? ''}`.trim() || `${err.stdout ?? ''}`.trim() || err.message;
    return { ok: false, blocked: /stuck at a dialog|agent_blocked/.test(text), error: text.split('\n')[0] };
  }
}

// ---- sending a question off to be worked out ------------------------------

// The brief for a session that studies a question nobody has worked out yet.
// It comes back with choices; it does not decide. When it stops, the brain
// watcher captures what it wrote and it returns to Waiting on you, where one
// key answers it and the answer goes back to that same session.
export function workUpBrief(row) {
  const q = row.data ?? {};
  const lines = [
    'The operator wants this question worked out so they can decide it:',
    '',
    `  ${q.title ?? row.headline}`,
  ];
  const known = [
    q.why && `Why it was asked: ${q.why}`,
    q.blocks?.length && `It holds up: ${q.blocks.map((b) => b.title ?? b.id).join('; ')}.`,
    q.memo && `There is a memo about it: ${q.memo}`,
    q.on_yes && `What was written about a yes: ${q.on_yes}`,
    q.on_no && `What was written about a no: ${q.on_no}`,
  ].filter(Boolean);
  if (known.length) lines.push('', ...known);
  lines.push(
    '',
    'Read what you need in this repository and the files above. Then reply with:',
    '- the real choices, two to four, each a complete answer to the whole question;',
    '- for each, one plain sentence on what happens if it is chosen;',
    '- which one you recommend, and why, in a sentence.',
    'If it is really several questions, say so and list them separately.',
    '',
    'Do not decide it. Do not start the work it holds up, and change nothing that cannot be undone.',
    'Write in plain words, without item codes. Stop when you have written the choices: the operator answers here, in this session.',
  );
  return lines.join('\n');
}

export function workUpArgs(row, project, now = new Date()) {
  const q = row.data ?? {};
  const hhmm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const slug = String(q.title ?? row.headline ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 22).replace(/-+$/, '');
  const name = `ask-${slug || 'question'}-${hhmm}`;
  const short = String(q.title ?? row.headline ?? 'a question').split(/\s+/).slice(0, 4).join(' ');
  const dirs = [...new Set([project.org && path.dirname(project.org), q.memo && path.dirname(q.memo)].filter(Boolean))];
  return {
    name,
    args: ['start', '--json', '--cwd', project.cwd, '--name', name, '--label', `work out: ${short}`,
      ...dirs.flatMap((d) => ['--add-dir', d]), '--', workUpBrief(row)],
  };
}

export async function startWorkUp(bin, project, row, { timeout = 240000 } = {}) {
  if (!project?.cwd) return { ok: false, error: `the project ${project?.name ?? ''} has no checkout (cwd) to start a session in` };
  const { name, args } = workUpArgs(row, project);
  const r = await brainAct(bin, args, { timeout });
  if (!r.ok) {
    try {
      return { ok: false, error: JSON.parse(r.error).error };
    } catch {
      return { ok: false, error: r.error };
    }
  }
  return { ok: true, name };
}

// ---- an org question in plain words ---------------------------------------

// One reading per question, cached by brain against the item's content, so it
// is paid again only when the question changes.
export async function explainQuestion(bin, orgDir, id, { orgBin, timeout = 240000 } = {}) {
  const args = ['explain', '--json', '--org', orgDir, ...(orgBin ? ['--org-bin', orgBin] : []), id];
  const r = await brainAct(bin, args, { timeout });
  let body = null;
  try { body = JSON.parse(r.ok ? r.output : r.error); } catch { body = null; }
  if (!r.ok || !body || body.error) return { ok: false, error: body?.error ?? r.error };
  return { ok: true, ...body };
}
