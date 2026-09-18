// Explaining an org item the way the operator reads work: a handle, a quoted
// gist of what is at stake, plain sentences on why it matters, and the actions
// the record already supports.
//
// One small headless call per item (`claude -p`, no tools), cached by the
// item's content: it is paid again only when the item changes. The console
// asks for the questions on its screen, so parked ones cost nothing until
// they are opened.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { HOME } from './queue.mjs';
import { accountEnvFor, parse } from './digest.mjs';

const run = promisify(execFile);
const CACHE = path.join(HOME, 'explain');

const INSTRUCTIONS = `You are explaining one item from a project's work record to its operator, who
decides what happens next. They read items like this, and want this voice
exactly: the item id, a short quoted gist of what is at stake, then plain
sentences on what the thing is, what goes wrong without it, and what each
consequence costs, concretely. An example of the voice:

  ENG-85 — "don't let the switch silently rewrite the past."
  Every test that replays the real Chipnet transactions from last week asks for
  "the profile" and "the verification key" by name, not by version number.
  Throw the switch and all those names start pointing at the new protocol,
  while the recorded data is still from the old one. Best case everything fails
  loudly. Worst case something passes for the wrong reason and you'd never
  learn that your existing live evidence stopped meaning what it says.

Then say what the operator can do about it, as actions.

Reply with ONE fenced json block and nothing else:

\`\`\`json
{
  "gist": "a short quoted-style phrase, at most 12 words, saying what is at stake",
  "explain": "3-5 plain sentences in the voice above",
  "options": [
    { "key": "1", "label": "a short action the operator can take", "causes": "one sentence: what happens next if they choose it" }
  ],
  "recommend": "1",
  "why": "one sentence for the recommendation"
}
\`\`\`

Rules:
- Only use what the record says. Never invent facts, numbers or options.
- Options: when the record carries a recommendation, the first option is to
  adopt it as written; add the alternatives the record itself names. Two to
  four options, or none if the record gives nothing to choose between. Never
  add an option to "look into it later" or "ask someone".
- Plain words. Use item ids only as handles; explain what each one is instead
  of pointing at it. Other codes, hashes and file paths only when the operator
  needs them to act.`;

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

async function org(bin, orgDir, args) {
  const { stdout } = await run(bin, args, { env: { ...process.env, ORG_DIR: orgDir }, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

// The record the model reads: the item, its notes (newest last, bounded), what
// it blocks and is blocked by, and the start of its memo.
async function record(orgBin, orgDir, id) {
  const item = JSON.parse(await org(orgBin, orgDir, ['show', id, '--json']));
  const related = [];
  for (const other of [...(item.blocks ?? []), ...(item.blocked_by ?? [])].slice(0, 8)) {
    try {
      const o = JSON.parse(await org(orgBin, orgDir, ['show', other, '--json']));
      related.push(`${o.id} (${o.status}): ${o.title}${(item.blocks ?? []).includes(other) ? ' — waits on this item' : ' — this item waits on it'}`);
    } catch { /* a missing neighbour is not worth failing over */ }
  }
  let memo = null;
  if (item.meta?.memo) {
    const file = path.isAbsolute(item.meta.memo) ? item.meta.memo : path.join(path.dirname(orgDir), item.meta.memo);
    try { memo = fs.readFileSync(file, 'utf8').slice(0, 6000); } catch { memo = null; }
  }
  const notes = (item.notes ?? []).slice(-12).map((n) => `- ${n.at?.slice(0, 16) ?? ''} ${n.decision ? '[decision] ' : ''}${n.text}`);
  let text = [
    `Item ${item.id}: ${item.title}`,
    `Status: ${item.status}${item.meta?.stage != null ? ` · stage ${item.meta.stage}` : ''}${item.role ? ` · role ${item.role}` : ''}`,
    item.created?.why ? `Why it was created: ${item.created.why}` : null,
    item.meta && Object.keys(item.meta).length ? `Fields: ${JSON.stringify(item.meta)}` : null,
    related.length ? `Related:\n${related.join('\n')}` : null,
    notes.length ? `Notes:\n${notes.join('\n')}` : null,
    memo ? `Memo (${item.meta.memo}), start:\n${memo}` : null,
  ].filter(Boolean).join('\n\n');
  if (text.length > 24000) text = `${text.slice(0, 24000)}\n[cut]`;
  return { item, text, key: hash({ title: item.title, meta: item.meta, notes: item.notes, status: item.status, blocks: item.blocks, blocked_by: item.blocked_by }) };
}

function cacheFile(orgDir, id) {
  return path.join(CACHE, hash(path.resolve(orgDir)), `${id}.json`);
}

export function cached(orgDir, id) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(orgDir, id), 'utf8'));
  } catch {
    return null;
  }
}

// { id, key, at, gist, explain, options, recommend, why, cached }
export async function explainItem({ orgDir, id, orgBin = 'org', model = 'claude-sonnet-5', refresh = false, cachedOnly = false }) {
  const old = cached(orgDir, id);
  if (cachedOnly) return old ? { ...old, cached: true } : null;
  const { text, key } = await record(orgBin, orgDir, id);
  if (!refresh && old?.key === key) return { ...old, cached: true };
  const cwd = path.dirname(path.resolve(orgDir));
  const { stdout } = await run('claude', ['-p', `${text}\n\n${INSTRUCTIONS}`, '--model', model], {
    cwd, env: accountEnvFor(cwd), timeout: 180000, maxBuffer: 16 * 1024 * 1024,
  });
  const d = parse(stdout);
  const out = {
    id, key, at: new Date().toISOString(),
    gist: d.gist, explain: d.explain, options: d.options, recommend: d.recommend, why: d.why, malformed: d.malformed ?? false,
  };
  const file = cacheFile(orgDir, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(out, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return { ...out, cached: false };
}
