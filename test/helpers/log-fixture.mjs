import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LogJournal } from '../../logs/journal.mjs';

export const AT = '2026-10-16T12:00:00.000Z';
export function logFixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'logs-fixture-'))), commonDir = path.join(root, 'project/.git');
  fs.mkdirSync(commonDir, { recursive: true });
  const scope = { identity: 'fixture', commonDir, root: path.join(root, 'output'), clock: () => AT, ...options };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const event = (sequence = 1, type = 'herdr.observation', payload = {}, extra = {}) => ({ schema: 'brain.log/v1',
    eventId: `fixture:${sequence}`, producer: { id: 'fixture', epoch: 'one', sequence }, occurredAt: AT,
    type, level: 'info', identity: 'fixture', project: { commonDir },
    ...(/^(run\.|review\.)/.test(type) ? { run: 'R-1', item: 'ENG-1' } : {}),
    source: { kind: 'fixture', ref: `fixture#${sequence}` }, payload, ...extra });
  const message = (sequence, evidence, extra = {}) => event(sequence, 'session.message.v1', {
    from: { identity: 'fixture', projectRef: commonDir, session: { uid: 'worker', incarnation: 'one' } },
    to: [{ identity: 'fixture', projectRef: commonDir, role: { name: 'supervisor', bindingRef: 'fixture' } }],
    kind: 'notice', refs: [], reply_to: null, priority: 'normal', reply_by: null, summary: 'Synthetic observation', body_ref: null, decision_ref: null,
    evidence: { validated: true, ...evidence } }, { sessionUid: 'worker', incarnation: 'one', ...extra });
  return { root, scope, commonDir, event, message, journal: new LogJournal(scope) };
}
export function at(minutes) { return new Date(Date.parse(AT) + minutes * 60000).toISOString(); }
