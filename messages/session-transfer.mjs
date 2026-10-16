// Retain a logical role inbox across a controller incarnation. No delivery or
// address rewriting: exact-session replies never become role messages. The
// receiver retains its existing fixture-only mutation boundary.
import { Receiver, addressKey, pending } from './receiver.mjs';
import { canonical } from './schema.mjs';
import { validBinding, equalBinding, strings, text } from '../sessions/lifecycle-evidence.mjs';

export async function transferSessionInbox({ root, recipient, common, uid, role, operationId, previous, next, messageIds, cursor }) {
  if (!text(uid) || !['chat', 'supervisor'].includes(role) || !text(operationId) || !validBinding(previous) || !validBinding(next) || equalBinding(previous, next) ||
      !strings(messageIds) || !/^transport:[0-9]+$/u.test(cursor ?? '')) throw Error('invalid session inbox transfer');
  const receiver = new Receiver({ root });
  return receiver.transaction((state, append) => {
    const enrollment = state.config?.recipients.find(r => addressKey(r.address) === recipient);
    if (!enrollment?.address.role || enrollment.address.projectRef !== common ||
        enrollment.address.role.bindingRef !== uid || enrollment.address.role.name !== `project-${role}`) throw Error('transfer requires the enrolled logical role in this project');
    const prior = receiver.records().filter(r => r.type === 'session-role-transfer' && r.operationId === operationId);
    const transfer = { operationId, recipient, uid, role, previous, next, messageIds, cursor };
    if (prior.length) {
      const { schema, sequence, at, type, ...saved } = prior[0];
      if (prior.length !== 1 || canonical(saved) !== canonical(transfer)) throw Error('conflicting inbox transfer');
      return saved;
    }
    const watermark = Number(cursor.slice('transport:'.length));
    if (!Number.isSafeInteger(watermark) || watermark > receiver.records().length) throw Error('inbox cursor is not committed');
    const entries = state.entries.filter(e => e.recipient === recipient && e.acceptance <= watermark);
    if (entries.some(e => ['uncertain', 'refused'].includes(e.state))) throw Error('uncertain or refused role delivery holds transfer');
    const ids = entries.filter(pending).map(e => e.event.eventId);
    if (ids.length !== messageIds.length || ids.some(id => !messageIds.includes(id))) throw Error('pending inbox coverage changed');
    append({ type: 'session-role-transfer', ...transfer });
    return transfer;
  });
}
