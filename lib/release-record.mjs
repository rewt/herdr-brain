// Record facts only. Commands, projects and gates are opaque data to the core.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { UserError } from './store.mjs';
import { nextItemId } from './state.mjs';
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

const command = (value, nullable = false) => (nullable && value === null) ||
  (Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string' && !v.includes('\0')) && value[0].trim());
const hash = value => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value ?? '');
const identical = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function releaseRecordCommand(argv, { openOrg, mutate, out }) {
  const { values: opt, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    json: { type: 'boolean' }, identity: { type: 'string' }, file: { type: 'string' },
  } });
  const [action = 'list', id] = positionals;
  const ctx = openOrg();
  if (action === 'list') {
    if (positionals.length > 1 || opt.file) throw new UserError('usage: record releases [--json] [--identity DIR]');
    const rows = candidateRows(ctx.state, opt.identity);
    out(opt.json ? JSON.stringify({ candidates: rows }) + '\n' : renderCandidates(rows)); return;
  }
  if (!['cut', 'start', 'result'].includes(action) || positionals.length > 2) throw new UserError('usage: record release cut --file JSON | start RC-n | result RC-n --file JSON');
  const payload = opt.file ? JSON.parse(fs.readFileSync(path.resolve(opt.file), 'utf8')) : null;
  const { result } = mutate(ctx, s => {
    if (action === 'cut') {
      const c = payload;
      if (id || !c || !path.isAbsolute(c.identity ?? '') || !path.isAbsolute(c.snapshot ?? '') ||
          typeof c.tag !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(c.tag) || c.tag.includes('..') || c.tag.endsWith('.') ||
          typeof c.base !== 'string' || !c.base.trim() || !hash(c.commit) || !hash(c.tree) ||
          !command(c.gate_command) || !command(c.prepare, true) || !command(c.ship, true) ||
          !(c.previous === null || hash(c.previous)) || !(c.parent === null || typeof c.parent === 'string') ||
          Object.keys(c).some(k => !['identity', 'tag', 'base', 'commit', 'tree', 'snapshot', 'previous', 'commits', 'gate_command', 'prepare', 'ship', 'parent'].includes(k)) ||
          !Array.isArray(c.commits) || !c.commits.every(hash)) throw new UserError('invalid release candidate receipt');
      if (c.parent && !s.items.has(c.parent)) throw new UserError(`unknown item ${c.parent}`);
      const existing = [...s.candidates.values()].find(r => r.identity === c.identity && (r.commit === c.commit || r.tag === c.tag));
      if (existing) {
        const saved = Object.fromEntries(Object.keys(c).map(k => [k, existing[k]]));
        if (!identical(saved, c)) throw new UserError('candidate tag or commit already recorded with different evidence');
        return { add: [], result: existing };
      }
      const number = Math.max(0, ...[...s.candidates.keys()].map(k => Number(k.slice(3)))) + 1;
      const candidate = { ...c, id: `RC-${number}` };
      return { add: [{ type: 'release.cut', ...candidate }], result: candidate };
    }
    const c = s.candidates.get(id);
    if (!c) throw new UserError(`unknown release candidate ${id}`);
    if (action === 'start') {
      if (opt.file) throw new UserError('start takes no receipt file');
      return c.started ? { add: [], result: { started: false, candidate: c } }
        : { add: [{ type: 'release.gate.started', id }], result: { started: true, candidate: c } };
    }
    if (!c.started) throw new UserError('gate result requires a recorded start');
    const g = payload;
    if (!g || !['passed', 'failed', 'interrupted'].includes(g.result) || !['prepare', 'gate', 'snapshot'].includes(g.stage) ||
        !path.isAbsolute(g.log ?? '') || !(g.exit_code === null || Number.isInteger(g.exit_code)) ||
        typeof g.detail !== 'string' || !command(g.command, true) ||
        (g.result === 'passed' && (g.exit_code !== 0 || g.stage !== 'gate'))) throw new UserError('invalid release gate receipt');
    if (!identical(g.command, g.stage === 'gate' ? c.gate_command : g.stage === 'prepare' ? c.prepare : null)) throw new UserError('result command differs from the declared candidate command');
    if (c.gate) {
      const saved = Object.fromEntries(Object.keys(g).map(k => [k, c.gate[k]]));
      if (!identical(saved, g)) throw new UserError('a different result is already recorded for this candidate');
      return { add: [], result: c };
    }
    const events = [];
    let question = null;
    if (g.result === 'passed') {
      question = nextItemId(s, { kind: 'work', role: 'human' });
      const title = `Ship or activate release candidate ${c.tag}?`;
      const why = `The declared release gate passed for ${c.commit}. Evidence: ${g.log}. ${c.ship ? `Operator ship argv: ${JSON.stringify(c.ship)}.` : 'Choose the project ship or activation step.'} Activation and distribution remain the operator\'s decision.`;
      // This operator-reserved question deliberately bypasses auto-category routing.
      events.push({ type: 'item.added', id: question, kind: 'work', role: 'human', title, parent: c.parent ?? null,
        meta: { category: 'publish', recommend: 'yes', operator_reserved: true, release: c.id,
          on_yes: 'Operator may execute the declared ship step; activation remains operator controlled.',
          on_no: 'Keep the candidate and evidence; do not ship or activate it.' } },
      { type: 'note.added', id: question, text: why, decision: false, kind: 'why' });
    }
    events.push({ type: 'release.gate.finished', id, gate: g, question });
    return { add: events, result: { ...c, gate: g, question } };
  });
  out(JSON.stringify(result) + '\n');
}
