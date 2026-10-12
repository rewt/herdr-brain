// Read-only history from earlier release cycles.
import { parseArgs } from 'node:util';
import { UserError } from './store.mjs';
import { sanitizeTerminal } from './sanitize.mjs';

export function candidateRows(state, identity) {
  return [...state.candidates.values()].filter(c => !identity || c.identity === identity).map(c => {
    const q = state.items.get(c.question);
    const answer = q?.closed?.as === 'done' && q.meta.answered_by === 'human' ? q.meta.answer : null;
    const status = !c.started ? 'pending-gate' : !c.gate ? 'inspect-interrupted' : c.gate.result !== 'passed' ? 'gate-failed'
      : answer === 'yes' ? 'approved' : answer === 'no' ? 'declined' : 'awaiting-operator';
    return { ...c, status, decision: answer, answered_by: q?.meta.answered_by ?? null };
  });
}

export function renderCandidates(rows) {
  return sanitizeTerminal(rows.length ? rows.map(c => `${c.id} ${c.tag} · ${c.commit.slice(0, 12)} · gate ${c.gate?.result ?? (c.started ? 'started; inspect' : 'pending')} · ${c.status}${c.question ? ` · ${c.question}` : ''}\n  snapshot ${c.snapshot}${c.gate?.log ? `\n  evidence ${c.gate.log}` : ''}${c.ship ? `\n  operator ship argv ${JSON.stringify(c.ship)}` : '\n  operator chooses how to ship or activate'}`).join('\n') + '\n' : 'No release candidates recorded.\n');
}

export function releasesCommand(argv, { openOrg, out }) {
  const { values: opt, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    json: { type: 'boolean' }, identity: { type: 'string' },
  } });
  if (positionals.length) throw new UserError('usage: record releases [--json] [--identity DIR]');
  const rows = candidateRows(openOrg().state, opt.identity);
  out(opt.json ? JSON.stringify({ candidates: rows }) + '\n' : renderCandidates(rows));
}
