// Local receipts only. The denied session records the operator question via CLI.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { noticeLock } from '../../supervisor/notice-lock.mjs';
import { writeFileAtomic } from '../../lib/files.mjs';
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function persist(file, data) {
  writeFileAtomic(file, JSON.stringify(data) + '\n', 0o600);
  const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
export function auditPermission(home, binding, event, decision, now = Date.now(), config = {}, { deadline, deferApproval = false, onDurable } = {}) {
  const file = path.join(home, 'steward/permissions.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = noticeLock(`${file}.lock`, { waitMs: 2000, deadline });
  try {
    let data = { version: 1, sessions: {}, events: [] };
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 4 * 1024 * 1024) throw Error('permission audit exceeds bound');
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.version !== 1 || !data.sessions || typeof data.sessions !== 'object' || Array.isArray(data.sessions) || !Array.isArray(data.events) || data.events.length > 512 || Object.keys(data.sessions).length > 128) throw Error('invalid permission audit');
    }
    const key = fingerprint([binding.project, binding.workspace, binding.runTemp, binding.session]);
    const request = fingerprint([event.session_id, event.tool_name, event.tool_input]);
    const state = data.sessions[key] ?? { approvals: 0, requests: {}, alerts: {}, at: now, lastAlert: 0 };
    state.reservations ??= 0;
    if (!Number.isInteger(state.approvals) || state.approvals < 0 || !Number.isInteger(state.reservations) || state.reservations < 0 || state.approvals + state.reservations > 32 || !state.requests || Array.isArray(state.requests) || Object.values(state.requests).some(v => !Number.isSafeInteger(v) || v < 0) || !Number.isFinite(state.at) || !Number.isFinite(state.lastAlert)) throw Error('invalid permission circuit receipt');
    const repeated = state.requests[request] ?? 0;
    if (decision.behavior === 'allow' && (state.approvals + state.reservations >= 32 || repeated >= 3)) decision = { behavior: 'deny', category: 'security', alert: true, reason: 'Permission circuit breaker', message: 'Permission circuit breaker. Do not work around the denial. Record the question with record ask --category security --recommend no, then continue with other work.' };
    if (decision.behavior === 'allow') {
      if (deferApproval) state.reservations++;
      else state.approvals++;
    }
    state.requests[request] = repeated + 1;
    state.requests = Object.fromEntries(Object.entries(state.requests).slice(-64));
    state.at = now;
    state.alerts ??= {};
    const alerts = state.alerts[request] ?? 0;
    const notify = decision.alert && alerts < (config.alert_cap ?? 3) && (!state.lastAlert || now - state.lastAlert >= (config.debounce_seconds ?? 300) * 1000);
    if (notify) { state.lastAlert = now; state.alerts[request] = alerts + 1; }
    state.alerts = Object.fromEntries(Object.entries(state.alerts).slice(-64));
    data.sessions[key] = state;
    data.sessions = Object.fromEntries(Object.entries(data.sessions).sort((a, b) => a[1].at - b[1].at).slice(-128));
    // Reserve circuit capacity before responding, but only call it an approval
    // after the watchdog acknowledges that it emitted the native allow output.
    const receipt = deferApproval && decision.behavior === 'allow' ? { file, id: randomUUID() } : null;
    data.events.push({ at: now, key, request, project: binding.project, session: binding.session, behavior: receipt ? 'pending' : decision.behavior, reason: decision.reason, category: decision.category, alert_intent: Boolean(notify), ...(receipt ? { id: receipt.id } : {}) });
    data.events = data.events.slice(-512);
    persist(file, data);
    const result = { decision, notify, file, receipt };
    // A denial's alert must start here, before release or later work can exceed
    // the deadline after consuming its durable cap/debounce receipt.
    onDurable?.(result);
    return result;
  } finally { release(); }
}

export function confirmPermissionApproval(receipt, { deadline } = {}) {
  const release = noticeLock(`${receipt.file}.lock`, { waitMs: 500, deadline });
  try {
    const data = JSON.parse(fs.readFileSync(receipt.file, 'utf8'));
    const event = data.events.find(event => event.id === receipt.id);
    if (event?.behavior !== 'pending') return;
    const state = data.sessions[event.key];
    if (state) { state.reservations--; state.approvals++; }
    event.behavior = 'allow';
    persist(receipt.file, data);
  } finally { release(); }
}
