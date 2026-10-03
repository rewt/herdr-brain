// Persist kernel birth identities beside PIDs; an unreadable source is unknown.
import { lookupProcess } from './processes.mjs';

export const readOwnerProcess = pid => lookupProcess(pid, { identityOnly: true });

export function ownerProcess(pid, read = readOwnerProcess) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error('owner PID is missing or invalid; inspect');
  const result = read(pid);
  if (!result?.ok) throw Error(`owner identity unavailable: ${result?.error ?? 'unreadable process source'}; inspect`);
  if (result.value === null) return null;
  const row = result.value;
  if (row?.pid !== pid || typeof row.identity !== 'string' || !row.identity.trim() || typeof row.state !== 'string' || !row.state)
    throw Error('owner identity is incomplete; inspect');
  return /^[ZX]/.test(row.state) ? null : row;
}

export function ownerAlive(owner, read = readOwnerProcess) {
  const current = ownerProcess(owner?.pid, read);
  if (!current) return false;
  // Legacy owners can be recovered only when the PID is absent. A present PID
  // without a recorded birth cannot prove either continued ownership or reuse.
  if (typeof owner.identity !== 'string' || !owner.identity.trim()) throw Error('owner start-time identity is missing; inspect');
  // A pre-upgrade Linux tick has no boot proof. Do not replace a present owner
  // just because the new source includes evidence that its receipt omitted.
  if (/^[0-9a-f-]{36}:\d+$/i.test(current.identity) && /^\d+$/.test(owner.identity)) throw Error('owner boot identity is missing; inspect');
  return current.identity === owner.identity;
}

export function ownerIdentity(pid, read = readOwnerProcess) {
  const current = ownerProcess(pid, read);
  if (!current) throw Error('owner died before its identity could be recorded; inspect');
  return current.identity;
}
