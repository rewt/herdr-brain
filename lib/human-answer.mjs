// Verify an existing human answer transaction without importing native sessions.
import fs from 'node:fs';
import { loadEvents } from './store.mjs';
import { fold } from './state.mjs';
import { parseUniqueJson } from '../sessions/json.mjs';
import { digest } from './digest.mjs';

export function humanAnswerEvidence({ record: org, ref, field, validateScope }) {
  const record = fs.realpathSync(org), loaded = loadEvents(record);
  if (loaded.tornTail) throw Error('operator decision record has an incomplete tail');
  const index = loaded.events.findIndex(e => e.seq === ref.seq && e.id === ref.id);
  const [event, update, close] = loaded.events.slice(index, index + 3);
  // record answer emits these three adjacent events in one transaction. Auto
  // answers use the same note kind, but answered_by=auto; named agents are not
  // the operator, and an unattributed default-human writer is not evidence.
  const human = e => e?.id === ref.id && e.by === 'human' && !e.unattributed && e.at === event?.at;
  const before = fold(loaded.events.slice(0, index)).items.get(ref.id);
  const current = fold(loaded.events).items.get(ref.id);
  if (index < 0 || !human(event) || event.type !== 'note.added' || event.decision !== true || event.kind !== 'answer' ||
      !human(update) || update.seq !== event.seq + 1 || update.type !== 'item.updated' ||
      update.fields?.meta?.answer !== 'yes' || update.fields.meta.answered_by !== 'human' ||
      !human(close) || close.seq !== event.seq + 2 || close.type !== 'item.closed' || close.as !== 'done' ||
      before?.role !== 'human' || current?.role !== 'human' || current.closed?.seq !== close.seq ||
      current.meta.answer !== 'yes' || current.meta.answered_by !== 'human')
    throw Error('operator decision requires an attributed human record answer yes transaction on a human question');
  // Scope must precede the answer and remain unchanged afterward.
  const raw = before.meta[field];
  if (typeof raw !== 'string' || current.meta[field] !== raw)
    throw Error(`operator decision requires unchanged ${field} scope recorded before the answer`);
  const scope = parseUniqueJson(raw);
  validateScope(scope);
  return { record, id: ref.id, seq: ref.seq, sha256: digest({ event, update, close, scope }) };
}
