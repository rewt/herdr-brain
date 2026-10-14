import { parseArgs } from 'node:util';
import { findOrgDir, transact, UserError, writer } from './store.mjs';
import { fold } from './state.mjs';
import { requestRetirement } from './retire-trigger.mjs';

// Explicit operator/supervisor confirmation recorded by the record CLI. This
// leaves both reports immutable and does not put eligibility in the fold.
export function handoffCommand(argv) {
  const { values: opt, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    to: { type: 'string' }, confirm: { type: 'boolean' }, why: { type: 'string' },
  } });
  const [from] = positionals;
  if (positionals.length !== 1 || !/^R-\d+$/.test(from ?? '') || !/^R-\d+$/.test(opt.to ?? '') || !opt.confirm || !opt.why?.trim())
    throw new UserError('usage: record handoff R-old --to R-new --confirm --why TEXT');
  const org = findOrgDir();
  if (!org) throw new UserError('no record found');
  const who = writer();
  const result = transact(org, events => {
    const state = fold(events), a = state.runs.get(from), b = state.runs.get(opt.to);
    const identity = r => r?.workspace && r.meta?.pane && r.meta?.worker_workspace && (r.meta?.terminal_id || r.meta?.agent_session_id);
    if (!identity(a) || !identity(b) || a.item !== b.item || b.started.seq <= a.started.seq || b.abandoned ||
        state.items.get(b.item)?.runs.at(-1) !== b.id || a.meta.pane === b.meta.pane ||
        (a.meta.agent_session_id && a.meta.agent_session_id === b.meta.agent_session_id)) throw new UserError('handoff requires a newer retained successor with a different recorded launch identity on the same item');
    const prior = events.filter(e => e.type === 'retirement.handoff' && e.from === from).at(-1);
    if (prior && prior.to !== b.id) throw new UserError('handoff already names a different successor');
    return { add: prior ? [] : [{ type: 'retirement.handoff', from, to: b.id, item: a.item, confirmed: true, why: opt.why }] };
  }, { actor: who.actor, unattributed: who.unattributed });
  if (result.added.length) try { requestRetirement({ org, eventSeq: result.added.at(-1).seq, source: 'record handoff' }); }
  catch (e) { process.stderr.write(`record: retirement request deferred: ${e.message}\n`); }
  process.stdout.write(JSON.stringify({ from, to: opt.to, recorded: result.added.length > 0 }) + '\n');
  return 0;
}
