// Historical fixture bytes only. Product code has no shadow/turn-hook writer.
import fs from 'node:fs';
import path from 'node:path';
import { JournalScope } from '../../messages/journal.mjs';
import { canonical, digest } from '../../messages/schema.mjs';
import { classify } from '../../messages/classify.mjs';

export class HistoricalShadow extends JournalScope {
  entries = [];
  async append(event) {
    await this.prepareDirectory();
    const prior = this.entries.find(e => e.eventId === event.eventId ||
      canonical(e.producer) === canonical(event.producer));
    const disposition = !prior ? 'accepted' : prior.payload.summary === event.payload.summary ? 'duplicate' : 'conflict';
    const entry = { ...event, stream: `${this.identity}/${digest(this.commonDir)}`,
      cursor: { epoch: 'shadow-1', sequence: this.entries.length + 1 }, receivedAt: '2026-10-15T18:00:00Z',
      shadow: { ...classify(event), disposition, ...(prior ? { originalEventId: prior.eventId } : {}) } };
    this.entries.push(entry);
    fs.appendFileSync(path.join(this.directory, 'shadow.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
    if (disposition === 'conflict') throw Error('conflicting historical fixture');
    return entry;
  }
}

export async function historicalHookClaim(receiver, eventId, session) {
  return receiver.transaction((state, append) => {
    const entry = state.entries.find(e => e.event.eventId === eventId);
    append({ type: 'receipt', acceptance: entry.acceptance, receipt: {
      state: 'delivered', eventId, recipient: entry.recipient, acceptance: entry.acceptance,
      transport: 'hook-pull/v1', consumer: session.consumer, session: 'historical-native', hook: 'Stop',
      reason: 'historical fixture: processing unknown',
    } });
  });
}
