// The recommendation pass: one ephemeral, headless session reads what a worker
// left behind and turns it into something the operator can answer in one key.
//
// It has no tools and no pane. It costs one small call: the captured tail plus
// these instructions, nothing else.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const INSTRUCTIONS = `You are reading the final screen of an autonomous coding session that has just
stopped. Turn it into something its operator can act on in one keypress.

First decide which of these it is:

- "decision" — the WORK needs a judgement only the operator can make. A real
  choice about the project, with consequences either way.
- "obstacle" — something mechanical is in the way: a first-run dialog, a
  permission prompt, a trust question, a tool that needs an answer. The
  operator does not need to think about it; they need it gone. A dialog is
  almost always an obstacle, NOT a decision, even when it is phrased as a
  question.
- "report" — it finished and needs nothing.

If there is UNSENT text in the prompt box, the operator has already answered
something and it never got delivered. Say that plainly: the item is their
stranded reply, and the obstacle is only what is holding it.

Reply with ONE fenced json block and nothing else:

\`\`\`json
{
  "kind": "decision",
  "what_happened": "2-3 plain sentences. What the session actually did and where things stand. No jargon, no item codes, no praise.",
  "needs_you": true,
  "question": "The one plain line the operator must answer. For an obstacle, phrase it as clearing the way, not as the dialog's own wording. Null for a report.",
  "options": [
    { "key": "1", "label": "short label", "causes": "one sentence saying what happens if this is chosen" }
  ],
  "recommend": "1",
  "why": "one sentence for the recommendation",
  "next_step": "For a report, the single next action someone should take. Otherwise null."
}
\`\`\`

Rules:
- For an obstacle, the options ARE that dialog's own choices, verbatim, and the
  recommendation is whichever one dismisses it with the least commitment.
- Never invent options. Two or more, or none.
- Plain language. The operator does not want identifiers.`;

function accountEnv(cwd) {
  // Today's lesson: a session started without CLAUDE_CONFIG_DIR runs on a
  // different, unconfigured account and stalls on first-run dialogs.
  const env = { ...process.env };
  try {
    const clean = { ...process.env };
    delete clean.AI_PERSONA;
    delete clean.CLAUDE_CONFIG_DIR;
    const out = execFileSync('/Users/rewt/bin/ai', ['env'], { cwd, env: clean, encoding: 'utf8', timeout: 15000 });
    for (const line of out.split('\n')) {
      const m = /^(AI_PERSONA|CLAUDE_CONFIG_DIR|GH_CONFIG_DIR|CODEX_HOME)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2];
    }
  } catch { /* fall back to this process's account */ }
  return env;
}

export async function digest(entry, { model = 'claude-fable-5-1', timeout = 180000 } = {}) {
  const body = [
    `Session: ${entry.title || entry.session}`,
    `It stopped in state: ${entry.state}`,
    entry.where ? `Working directory: ${entry.where}` : null,
    entry.unsent ? `\nThere is UNSENT text sitting in its prompt box:\n${entry.unsent}` : null,
    '\n--- its final screen ---',
    entry.screen ?? entry.said ?? '(nothing captured)',
    '--- end ---',
    '',
    INSTRUCTIONS,
  ].filter(Boolean).join('\n');

  const cwd = entry.where && entry.where.startsWith('/') ? entry.where : process.cwd();
  const { stdout } = await run('claude', ['-p', body, '--model', model], {
    cwd,
    env: accountEnv(cwd),
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return parse(stdout);
}

export function parse(stdout) {
  const fenced = /```json\s*([\s\S]*?)```/.exec(stdout) ?? /```\s*([\s\S]*?)```/.exec(stdout);
  const text = fenced ? fenced[1] : stdout;
  try {
    const d = JSON.parse(text.trim());
    return {
      kind: ['decision','obstacle','report'].includes(d.kind) ? d.kind : null,
      what_happened: d.what_happened ?? null,
      needs_you: Boolean(d.needs_you),
      question: d.question ?? null,
      options: Array.isArray(d.options) ? d.options.slice(0, 9) : [],
      recommend: d.recommend ?? null,
      why: d.why ?? null,
      next_step: d.next_step ?? null,
    };
  } catch {
    // An unparseable answer is still worth showing; it is not worth retrying.
    return { kind: null, what_happened: stdout.trim().slice(0, 1200), needs_you: false, question: null, options: [], recommend: null, why: null, next_step: null, malformed: true };
  }
}
