// Delegated decisions: the operator approves, an agent decides. A decider is a
// Claude session started with `brain start` in the project's checkout. It reads
// the report and the code, then writes its answer to a decision file. The pane
// forwards a decision to the supervisor as the operator's delegated answer;
// anything the decider escalates comes back to the operator with its
// recommendation. Deciders never change code, write to the org or message
// other sessions; the supervisor records answers as it always has.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_RUNNING = 2;

export const decisionPath = (dir, key) => path.join(dir, 'decisions', `${String(key).replace(/[^\w.-]/g, '_')}.json`);

// The brief: what to decide, where the evidence is, the rules, and the exact
// form of the answer. Everything a decider needs is in it.
export function delegateBrief({ project, entry, item, file, orgBin, reportPath = null, blocks = [] }) {
  const qs = entry.decisions.map(d => `${d.n}. ${d.question}${d.recommend ? `\n   The author recommends: ${d.recommend}.` : ''}${d.detail ? `\n   ${d.detail}` : ''}`).join('\n');
  return [
    `The operator of ${project.name} has delegated a decision to you. Decide on their behalf, as they would with full knowledge of this codebase.`,
    '',
    `Decision: ${entry.id}${entry.run ? ` (from run ${entry.run})` : ''}: ${item?.title ?? entry.title}`,
    item?.created?.why ? `Why it exists: ${item.created.why}` : null,
    blocks.length ? `Waiting on it: ${blocks.join(', ')}.` : null,
    reportPath ? `The report this comes from: ${reportPath}. Read it first.` : null,
    `The org record (read only): ORG_DIR=${project.org} node ${orgBin} show ${entry.id}`,
    '',
    'Questions:',
    qs,
    '',
    'How to decide:',
    '- Read the report and the code it concerns in this repository. Check the facts your answer rests on.',
    '- Take the author\'s recommendation unless you find a concrete reason not to, and name that reason.',
    '- Do not change any file except the decision file below, run long jobs, start or message other sessions, or write to the org.',
    '- Escalate instead of answering when the decision spends or moves money or funds anything, is legal or regulatory, publishes outside the project, cannot be undone, or rests on a fact you could not verify.',
    '',
    `When you have decided, write exactly one JSON object to ${file} and then stop:`,
    `{"item": "${entry.id}", "escalate": false, "escalate_reason": null, "answers": {${entry.decisions.map(d => `"${d.n}": "<your answer>"`).join(', ')}}, "confidence": "high|medium|low", "why": "<at most 8 lines, citing files and lines>"}`,
  ].filter(x => x !== null).join('\n');
}

// A decision file, checked: it must answer the item it was asked about, and
// every question, unless it escalates.
export function parseDecision(text, entry) {
  let d; try { d = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return { ok: false, error: 'the decision file is not JSON' }; }
  if (d?.item !== entry.id) return { ok: false, error: `the decision is for ${d?.item ?? 'nothing'}, not ${entry.id}` };
  const answers = d.answers ?? {};
  if (!d.escalate && entry.decisions.some(q => !String(answers[q.n] ?? '').trim())) return { ok: false, error: 'the decision leaves a question unanswered' };
  return { ok: true, escalate: Boolean(d.escalate), reason: d.escalate_reason ?? null, answers, confidence: d.confidence ?? null, why: d.why ?? '' };
}

// What the supervisor receives: the decision as the operator's delegated answer.
export function forwardMessage(entry, decision, agent, file) {
  const whose = entry.source === 'report' ? `${entry.run} (${entry.id})` : entry.id;
  const answers = entry.decisions.map(q => entry.decisions.length === 1 ? decision.answers[q.n] : `${q.n} ${decision.answers[q.n]}`).join('; ');
  return `Delegated decision for ${whose}, decided on the operator's authority by ${agent}${decision.confidence ? ` (confidence ${decision.confidence})` : ''}: ${answers}. Reasoning: ${file}. Record it as the operator's answer and proceed.`;
}

// The queue, kept in the pane's state directory so it survives a restart.
export function createDelegations({ dir, fsApi = fs }) {
  const file = path.join(dir, 'delegations.json');
  let list = [];
  try { list = JSON.parse(fsApi.readFileSync(file, 'utf8')); } catch {}
  const save = () => { fsApi.mkdirSync(dir, { recursive: true }); fsApi.writeFileSync(`${file}.tmp`, JSON.stringify(list, null, 1)); fsApi.renameSync(`${file}.tmp`, file); };
  return {
    get list() { return list; },
    find: key => list.find(x => x.key === key),
    add(entry) { if (list.some(x => x.key === entry.key && !['failed', 'escalated'].includes(x.status))) return false; list = list.filter(x => x.key !== entry.key); list.push(entry); save(); return true; },
    update(key, fields) { const x = list.find(y => y.key === key); if (x) { Object.assign(x, fields); save(); } return x; },
  };
}
