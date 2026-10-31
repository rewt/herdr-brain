// Foreground Brain owner adapter. Linked foreign facts are evidence, never
// authority. No delivery, scheduler, process signal, prover or foreign IO.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { nativeSender } from '../messages/operator-inbox.mjs';
import { canonical } from '../messages/schema.mjs';
import { readInbox } from './prompt-supervisor.mjs';
import { readProjectPolicy } from '../lib/config-policy.mjs';
import { gitProject } from '../lib/project.mjs';
import { lineContext } from '../line-service/cutoff.mjs';
import { noticeLock } from './notice-lock.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { loadEvents, transact } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { closeoutDirectory, retirementOwnerLock } from '../lib/closeout.mjs';
import { plainDirectory, readPlainFile } from '../lib/files.mjs';
import { TEST_SLOT_PATH, PATH_ENV, COMPAT_PATH_ENV } from '../test-slot/paths.mjs';
import { readTestSlotOccupancy } from '../test-slot/occupancy.mjs';
import { safePoint } from './safe-point.mjs';
import { invokeHerdr } from '../lib/herdr-command.mjs';
import { parseArgs, isMain } from '../lib/cli-help.mjs';

export const provingScope = ['admissions', 'landings', 'closeout', 'proving'];
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => canonical(a) === canonical(b);
const nonempty = x => typeof x === 'string' && x.length > 0 && x.length <= 2048 && !/[\0\r\n]/.test(x);
const absolute = x => nonempty(x) && path.isAbsolute(x) && path.normalize(x) === x;
const fail = text => { throw Error(`PROVING_HOLD: ${text}`); };
export const packetDigest = packet => hash(canonical(packet));
export const requestKey = packet => hash(canonical([packet.source_project, packet.issuer, packet.request_id]));
const eventId = (packet, action) => `proving:${requestKey(packet)}:${action}`;

export function validatePacket(packet, consumer) {
  if (!packet || Buffer.byteLength(canonical(packet)) > 16384 || packet.schema !== 'brain.proving-hold/v1' ||
      !['request', 'release'].includes(packet.kind) || !absolute(packet.source_project) || packet.source_project === consumer ||
      !nonempty(packet.issuer) || !nonempty(packet.request_id) || packet.consumer !== consumer ||
      !nonempty(packet.authority_ref) || !same(packet.scope, provingScope) || !nonempty(packet.notice_id) ||
      !['linked-record', 'native-inbox'].includes(packet.delivery)) fail('invalid/foreign packet or unsupported scope');
  if (packet.kind === 'release' && (!nonempty(packet.reply_to) || !['completed', 'authorized-cancellation'].includes(packet.result) ||
      !nonempty(packet.completion_ref))) fail('release needs positive completion or explicitly authorized cancellation');
  return packet;
}

// A local owner must have verified the original issuer and standing authority
// through its existing relationship. A digest, label or claimed sender cannot
// do that. This exact decision note records the owner's endorsement, not a new
// trust configuration, permission, or cross-project executor.
function endorsement(events, packet, owner, sequence) {
  const event = events.find(e => e.seq === sequence);
  const text = `PROVING HOLD ${packet.kind} ${packetDigest(packet)}`;
  if (event?.type !== 'note.added' || event.decision !== true || event.by !== owner.name || event.text !== text)
    fail('missing exact local owner endorsement of authenticated issuer and existing authority');
  return event;
}

function exclusive(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function optional(file) {
  try { return readPlainFile(file); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; }
}
const ownerBytes = c => canonical({ schema: 'brain.proving-hold-directory/v1', project: c.identity, org: c.org }) + '\n';
function marker(c, packet, create = false) {
  const directory = path.join(c.repo, '.lane/supervisor/HOLD');
  if (create) {
    plainDirectory(path.dirname(directory));
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      exclusive(path.join(directory, '.proving-owner.json'), ownerBytes(c));
      syncDirectory(path.dirname(directory));
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  // A pre-existing plain/operator HOLD, unknown directory, or redirection stays
  // untouched. It cannot be converted, adopted or cleared by this adapter.
  plainDirectory(directory, { create: false });
  if (readPlainFile(path.join(directory, '.proving-owner.json')) !== ownerBytes(c)) fail('foreign/operator HOLD remains owned elsewhere');
  const file = path.join(directory, `proving-${requestKey(packet)}.json`);
  return { directory, file };
}
function ensureMarker(c, packet, decision) {
  const m = marker(c, packet, true), bytes = canonical({ packet, endorsement_seq: decision.seq }) + '\n';
  const prior = optional(m.file);
  if (prior !== null && prior !== bytes) fail('request ID already has different retained content');
  if (prior === null) exclusive(m.file, bytes);
  return { ...m, bytes };
}
function checkMarker(c, packet, decision) {
  const m = marker(c, packet), bytes = canonical({ packet, endorsement_seq: decision.seq }) + '\n';
  if (readPlainFile(m.file) !== bytes) fail('original HOLD marker changed or missing');
  return { ...m, bytes };
}
function delivered(c, packet) {
  if (packet.delivery === 'linked-record') return; // Exact owner endorsement is required separately.
  const original = readInbox(path.join(c.org, 'supervisor/inbox.log')).find(e => e.id === packet.notice_id);
  if (!original || !['sent', 'handled'].includes(original.state)) fail(`original native notice ${packet.notice_id} remains missing/pending/refused/uncertain; no replay`);
}

// Snapshot existing resource observations without removing a stale lock or
// pruning occupancy. Even a dead retained lock needs its original owner.
export function resourceConflicts(env = process.env) {
  const paths = [...new Set([env[PATH_ENV] ?? TEST_SLOT_PATH, env[COMPAT_PATH_ENV] ?? TEST_SLOT_PATH])];
  const conflicts = [];
  for (const file of paths) {
    if (fs.lstatSync(file, { throwIfNoEntry: false })) conflicts.push({ path: file, reason: 'resource lock remains; original owner must settle it' });
    const directory = `${file}.occupancy`;
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })) continue;
    plainDirectory(directory, { create: false });
    const rows = readTestSlotOccupancy(file);
    for (const name of fs.readdirSync(directory).filter(n => !n.startsWith('.'))) {
      const row = rows.find(r => r.path === path.join(directory, name));
      if (!row || row.state !== 'gone') conflicts.push({ path: path.join(directory, name), reason: row?.state ?? 'unknown resource owner' });
    }
  }
  return conflicts;
}

function drainConflicts(c) {
  return [path.join(closeoutDirectory(c.identity), 'consumer.lock'), retirementOwnerLock(c.identity)]
    .filter(file => fs.lstatSync(file, { throwIfNoEntry: false }))
    .map(file => ({ path: file, reason: 'original closeout/drain owner is still live or unknown' }));
}

const nativeTuple = a => ({ name: a.name, pane: a.pane_id, workspace: a.workspace_id, terminal: a.terminal_id,
  session: a.agent_session?.value, cwd: a.cwd, status: a.agent_status });
function ownAgents(c, agents) {
  if (!Array.isArray(agents)) fail('native resource owners unknown');
  return agents.filter(agent => {
    if (!absolute(agent.cwd)) fail('native resource owner checkout unknown');
    try { return gitProject(agent.cwd).identity === c.identity; }
    catch { fail('native resource owner project unknown'); }
  });
}
function containment(c, events, env, call, owner, readProcess) {
  const state = fold(events), conflicts = [...resourceConflicts(env), ...drainConflicts(c)];
  // Existing workers may finish compute and submit a report; HOLD prevents
  // further launches, FF and closeout. Completion is not a kill/drain receipt.
  for (const run of state.runs.values()) if (run.workspace) {
    // This owning record can contain several projects: only its real linked
    // workspaces belong in this adapter's observation.
    let owned = events.some(e => e.type === 'run.claimed' && e.run === run.id && e.project === c.identity);
    try { owned ||= gitProject(run.workspace).identity === c.identity; }
    catch { if (!run.report && !run.abandoned) conflicts.push({ run: run.id, reason: 'active workspace ownership unknown' }); }
    if (!owned) continue;
    if (!run.report && !run.abandoned) conflicts.push({ run: run.id, reason: 'existing worker has not reported; may finish before acknowledgement' });
  }
  const agents = ownAgents(c, JSON.parse(call('herdr', ['agent', 'list'])).result?.agents);
  for (const agent of agents) {
    if (agent.name !== owner.name && !['idle', 'done'].includes(agent.agent_status)) { conflicts.push({ agent: agent.name, reason: 'native resource owner live/unknown' }); continue; }
    const observation = safePoint({ cwd: c.repo, org: c.org, pane: agent.pane_id,
      call: args => JSON.parse(call('herdr', args)).result, ...(readProcess ? { readProcess } : {}) });
    if (!observation.safe) conflicts.push({ agent: agent.name, reason: 'native children/deliveries unknown or still live', observation });
  }
  if (conflicts.length) fail(`containment pending: ${canonical(conflicts)}`);
  return { observed_at: new Date().toISOString(), native_agents: agents.map(nativeTuple), resource_paths: [...new Set([env[PATH_ENV] ?? TEST_SLOT_PATH, env[COMPAT_PATH_ENV] ?? TEST_SLOT_PATH])],
    control_pass_promotion_locked: true, existing_work: 'compute/report may finish; no worker or drain killed',
    proving_owner_obligation: 'separately observe fresh memory and acquire/verify the real prover lock before proving' };
}

// Consumer-side contract validation only: no probing/acquiring a BCH lock.
// The proving owner supplies its own actual, fresh readback after Brain ACK.
export function validateProvingReadback(ack, readback, now = Date.now()) {
  const memory = readback?.memory, lock = readback?.lock;
  const fresh = at => Number.isFinite(Date.parse(at)) && now - Date.parse(at) >= 0 && now - Date.parse(at) <= 30000 &&
    Date.parse(at) >= Date.parse(ack?.containment?.observed_at);
  if (ack?.type !== 'proving-hold.acknowledged' || !fresh(memory?.observed_at) || !fresh(lock?.observed_at) ||
      !Number.isSafeInteger(memory.free_bytes) || !Number.isSafeInteger(memory.required_bytes) || memory.required_bytes < 0 ||
      memory.free_bytes < memory.required_bytes || lock.state !== 'held' || lock.issuer !== ack.packet.issuer ||
      lock.request_id !== ack.packet.request_id || !nonempty(lock.evidence_ref)) fail('proving owner needs fresh memory and its real matching prover-lock readback');
  return true;
}

export function provingHold({ repo, org, action, packet, decisionSeq, cwd = process.cwd(), env = process.env,
  call = invokeHerdr, readProcess, fault = () => {} } = {}) {
  const c = lineContext(repo, org);
  validatePacket(packet, c.identity);
  if (!['request', 'ack', 'release'].includes(action) || packet.kind !== (action === 'release' ? 'release' : 'request')) fail('action/packet mismatch');
  const bind = () => {
    const b = nativeSender(c.org, { cwd, env, call });
    const name = readProjectPolicy(c.repo, 'promote', env).config.to;
    if (!name || b.native.name !== name || b.project.identity !== c.identity || b.project.checkout !== c.repo)
      fail('requires the actual configured canonical project owner; workers/foreign senders have no executor');
    return { name, pane: b.native.pane_id, terminal: b.native.terminal_id, session: b.native.agent_session.value };
  };
  const owner = bind();
  // Reuse the existing serialization surfaces, no new queue or recovery lock.
  plainDirectory(c.directory);
  const releaseControl = noticeLock(path.join(c.directory, 'control.lock'), { recover: false });
  let releasePass, releasePromotion;
  try {
    let acknowledgement;
    if (action === 'ack') {
      releasePass = noticeLock(path.join(c.directory, 'pass.lock'), { recover: false });
      releasePromotion = acquireLock(path.join(c.identity, 'lane-promote.lock'));
      const loaded = loadEvents(c.org);
      if (loaded.tornTail) fail('incomplete record retains HOLD');
      endorsement(loaded.events, packet, owner, decisionSeq);
      if (!loaded.events.some(e => e.project === c.identity && e.org === c.org && e.key === requestKey(packet) && e.type === 'proving-hold.acknowledged')) {
        delivered(c, packet);
        acknowledgement = { events: canonical(loaded.events), observation: containment(c, loaded.events, env, call, owner, readProcess) };
      }
    }
    return transact(c.org, events => {
      if (!same(bind(), owner)) fail('native owner changed');
      const decision = endorsement(events, packet, owner, decisionSeq);
      const history = events.filter(e => e.project === c.identity && e.org === c.org && e.key === requestKey(packet) && e.type.startsWith('proving-hold.'));
      const request = history.find(e => e.type === 'proving-hold.requested');
      const ack = history.find(e => e.type === 'proving-hold.acknowledged');
      const released = history.find(e => e.type === 'proving-hold.released');
      const event = (type, values = {}) => ({ type: `proving-hold.${type}`, id: eventId(packet, type), key: requestKey(packet), project: c.identity, org: c.org,
        packet, subject: decision.id, endorsement_seq: decision.seq, native_owner: owner, ...values });
      if (action === 'request') {
        if (request && (!same(request.packet, packet) || request.endorsement_seq !== decision.seq)) fail('same request ID has different content/endorsement');
        if (released) return { add: [], result: { state: 'released', request, ack, released } };
        ensureMarker(c, packet, decision); fault('hold-written');
        return { add: request ? [] : [event('requested', { reply_to: packet.notice_id })], result: { state: 'held', request_id: packet.request_id } };
      }
      if (!request) fail('out-of-order action; original request missing');
      if (action === 'ack') {
        if (!same(request.packet, packet) || request.endorsement_seq !== decision.seq || released) fail('request changed/already released');
        checkMarker(c, packet, decision);
        if (ack) return { add: [], result: { state: 'acknowledged', ack } };
        delivered(c, packet);
        if (!acknowledgement || canonical(events) !== acknowledgement.events || resourceConflicts(env).length || drainConflicts(c).length ||
            !same(ownAgents(c, JSON.parse(call('herdr', ['agent', 'list'])).result?.agents).map(nativeTuple), acknowledgement.observation.native_agents))
          fail('containment observation changed before acknowledgement; retain original request');
        checkMarker(c, packet, decision);
        if (!same(bind(), owner)) fail('native owner changed before acknowledgement');
        fault('before-ack');
        return { add: [event('acknowledged', { reply_to: request.id, request_seq: request.seq, containment: acknowledgement.observation })], result: { state: 'acknowledged' } };
      }
      if (!ack || packet.reply_to !== ack.id || !same(packet.scope, request.packet.scope) || packet.authority_ref !== request.packet.authority_ref)
        fail('release does not match the same issuer/request/authority and exact acknowledgement');
      delivered(c, packet);
      if (released && (!same(released.packet, packet) || released.endorsement_seq !== decision.seq)) fail('release ID already has different completion');
      // Commit release permission before filesystem cleanup. Restart uses this
      // same completion and request; it never replays a native delivery.
      return { add: released ? [] : [event('released', { reply_to: ack.id, request_seq: request.seq })], result: { state: 'release-recorded', request, released: released ?? packet } };
    }, { actor: owner.name, strictTail: true, lockOptions: { recover: false } });
  } finally {
    releasePromotion?.(); releasePass?.(); releaseControl();
  }
}

// Release cleanup is a separate idempotent local effect, guarded by the durable
// completion. It cannot clear another issuer's entry or a plain/operator HOLD.
export function clearProvingHold(options) {
  const result = provingHold({ ...options, action: 'release' });
  const c = lineContext(options.repo, options.org);
  const release = noticeLock(path.join(c.directory, 'control.lock'), { recover: false });
  try {
    // Repeat native/record endorsement at this mutation boundary, preserving
    // original release rather than substituting a new request or owner.
    provingHoldReleaseGuard(options);
    const events = loadEvents(c.org).events;
    const request = events.find(e => e.type === 'proving-hold.requested' && e.key === requestKey(options.packet) && e.project === c.identity && e.org === c.org);
    const directory = path.join(c.repo, '.lane/supervisor/HOLD');
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })) return { ...result, cleared: true };
    const m = marker(c, request.packet);
    if (optional(m.file) !== null) {
      checkMarker(c, request.packet, { seq: request.endorsement_seq });
      options.fault?.('before-clear'); fs.unlinkSync(m.file); syncDirectory(m.directory);
    }
    if (fs.readdirSync(directory).length === 1) {
      fs.unlinkSync(path.join(directory, '.proving-owner.json'));
      try { fs.rmdirSync(directory); } catch (e) { if (e.code !== 'ENOTEMPTY') throw e; }
      syncDirectory(path.dirname(directory));
    }
    return { ...result, cleared: true, other_hold_remains: fs.existsSync(directory) };
  } finally { release(); }
}
function provingHoldReleaseGuard(options) {
  const c = lineContext(options.repo, options.org), b = nativeSender(c.org, { cwd: options.cwd, env: options.env, call: options.call });
  if (b.project.checkout !== c.repo || b.native.name !== readProjectPolicy(c.repo, 'promote', options.env).config.to) fail('release native owner changed');
  const loaded = loadEvents(c.org);
  if (loaded.tornTail) fail('incomplete record retains HOLD');
  endorsement(loaded.events, options.packet, { name: b.native.name }, options.decisionSeq);
  if (!loaded.events.some(e => e.type === 'proving-hold.released' && e.project === c.identity && e.org === c.org && same(e.packet, options.packet))) fail('original positive release missing');
}

export function provingHoldStatus({ repo, org, packet }) {
  const c = lineContext(repo, org); validatePacket(packet, c.identity);
  const loaded = loadEvents(c.org);
  if (loaded.tornTail) fail('incomplete record; original request remains unknown');
  const history = loaded.events.filter(e => e.project === c.identity && e.org === c.org && e.key === requestKey(packet) && e.type.startsWith('proving-hold.'));
  return { history, hold_present: fs.existsSync(path.join(c.repo, '.lane/supervisor/HOLD')),
    meaning: 'record evidence only; use current owner guards and fresh resource/prover observations before effects' };
}

if (isMain(import.meta.url)) {
  try {
    const { values: v, positionals: [action] } = parseArgs({ options: { repo: { type: 'string' }, org: { type: 'string' }, packet: { type: 'string' }, 'decision-seq': { type: 'string' } }, allowPositionals: true });
    const options = { repo: v.repo, org: v.org, action, packet: JSON.parse(readPlainFile(v.packet)), decisionSeq: Number(v['decision-seq']) };
    console.log(JSON.stringify(action === 'status' ? provingHoldStatus(options) : action === 'release' ? clearProvingHold(options) : provingHold(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
