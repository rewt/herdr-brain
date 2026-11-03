// Derive both endpoints from original finite-turn fences, never supplied labels.
import {timestamp} from './lifecycle.mjs';
import {createHash} from 'node:crypto';
const hash = b => createHash('sha256').update(b).digest('hex');
export function diagnoseTurns({trial, events, verified, row}) {
  const run = row.run, b = row.lifecycle, close = b?.item_closed, results = [];
  for (const packet of trial.turnWitnesses ?? []) {
    const id = packet.evidence?.[0];
    if (!verified.has(id) || typeof packet.bytes !== 'string' || hash(packet.bytes) !== trial.evidence?.[id]?.sha256) continue;
    let w; try { w = JSON.parse(packet.bytes); } catch { continue; }
    const lo = w.before?.record?.seq, hi = w.after?.record?.seq;
    if (w.schema !== 'brain.hold-closeout/v1' || w.project !== trial.project || !w.id || !Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) ||
        lo >= hi || hi > trial.window.through_seq || timestamp(w.before?.at) === null || timestamp(w.after?.at) === null ||
        timestamp(w.before.at) > timestamp(w.after.at) || timestamp(w.after.at) > timestamp(trial.window.cutoff)) continue;
    for (const subject of w.subjects ?? []) {
      if (subject.run !== run) continue;
      const source = events.find(e => e.type === 'report.ingested' && e.run === run && e.seq === subject.source?.seq && subject.source.type === e.type);
      const owns = e => e?.identity === trial.project && e.run === run && e.key === subject.key &&
        e.source?.seq === source?.seq && e.source?.type === source?.type;
      if (!source || !subject.key) continue;
      for (const evaluation of events.filter(e => e.type === 'closeout.evaluated' && owns(e) && e.seq > lo && e.seq <= hi)) {
        const effects = k => {
          const r = evaluation.resources?.[k], refs = [...(r?.receipts ?? []), ...(r?.receipt ? [r.receipt] : [])];
          return refs.flatMap(ref => {
            const e = events.find(e => e.type === 'closeout.effect' && owns(e) && e.seq === ref.seq && e.effect === ref.effect && e.seq > lo && e.seq < evaluation.seq);
            return e ? [e.seq] : [];
          });
        };
        const session = effects('session'), folder = effects('folder');
        if (session.includes(b?.resources.session.receipt?.seq) && folder.includes(b?.resources.folder.receipt?.seq))
          results.push({id: w.id, evaluation_seq: evaluation.seq, session_effects: session, folder_effects: folder,
            item_close_in_turn: Boolean(close && close.seq > lo && close.seq <= hi)});
      }
    }
  }
  const verdict = events.find(e => e.type === 'report.ingested' && e.run === row.observation?.review?.run);
  return {run, item_closed: close ?? null, resource_evaluated: events.filter(e => e.type === 'closeout.evaluated' && e.run === run),
    witnesses: results, claimed_turns_match: results.some(w => w.id === row.observation?.turns?.close && w.id === row.observation?.turns?.session && w.id === row.observation?.turns?.folder), same_resource_turn: results.length > 0, same_offer_turn: results.some(w => w.item_close_in_turn),
    source_close_before_original_verdict: close && verdict ? close.seq < verdict.seq && timestamp(close.at) <= timestamp(verdict.at) : null};
}
