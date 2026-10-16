// Fixture-only rehearsal of the supervisor inbox's single-owner handoff.
import fs from 'node:fs';
import path from 'node:path';
import { Receiver, addressKey, drained, syncDirectory, writeProjection, transportStatus } from './receiver.mjs';
import { canonical, digest } from './schema.mjs';
import { fixtureRoot, fixtureInboxEnrolled } from './fixture.mjs';
import { readInbox } from '../supervisor/prompt-supervisor.mjs';
import { noticeLock } from '../supervisor/notice-lock.mjs';

function readLegacyInbox(file) {
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error('legacy inbox must be a private regular fixture file');
  }
  return readInbox(file);
}

export class SupervisorTransfer {
  constructor({ root }) { this.root = root; this.receiver = new Receiver({ root }); }
  async enroll() {
    fixtureRoot(this.root);
    const config = this.receiver.state().config;
    if (config?.legacy?.inbox !== path.join(this.root, 'inbox.log') || !config.legacy.target ||
        !config.senders.some(s => s.receipt === config.legacy.sender)) throw Error('explicit fixture supervisor inbox enrollment required');
    const file = config.legacy.inbox;
    // Lock ordering is always legacy owner, drain, journal, then receiver writer.
    // A live or unidentified compatibility worker holds bootstrap; do not kill it.
    const releases = [];
    try {
      for (const suffix of ['.owner.lock', '.drain.lock', '.lock']) releases.push(noticeLock(file + suffix));
      // Policy runs outside these locks, then appends its result under .lock.
      // Do not import mutable delivery text while that result can still arrive.
      for (const notice of readLegacyInbox(file)) {
        if (notice.autopilot_owner === undefined) continue;
        const pid = notice.autopilot_owner;
        if (!Number.isInteger(pid) || pid < 1) throw Error('autopilot owner is unidentified; enrollment held');
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === 'ESRCH') continue; throw Error('autopilot owner is unidentified; enrollment held'); }
        throw Error('autopilot owner is live; enrollment held until its result is recorded');
      }
      // Enqueue fsyncs append bytes. Persist an empty old inbox's directory
      // entry here too, before acknowledging any post-enrollment spool write.
      if (!fs.existsSync(file)) writeProjection(file, '');
      writeProjection(`${file}.transport-fixture`, 'brain.transport-fixture/v1\n');
      await this.importLocked(config);
    } finally { for (const release of releases.reverse()) release(); }
  }
  async importLocked(config) {
    const source = config.legacy.inbox, receiver = this.receiver;
    const scope = config.senders.find(s => s.receipt === config.legacy.sender);
    const entries = readLegacyInbox(source);
    const history = fs.existsSync(source) ? fs.readFileSync(source, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
    for (const [index, notice] of entries.entries()) {
      if (notice.to !== config.legacy.target) throw Error('legacy target needs explicit re-resolution; cannot redirect notice');
      const eventId = `legacy:${digest(source)}:${notice.id}`;
      const prior = receiver.state().entries.find(e => e.event.eventId === eventId);
      if (prior) {
        if (prior.legacy?.id !== notice.id || prior.legacy.message !== notice.message || prior.legacy.deliveryMessage !== (notice.delivery_message ?? notice.message) || prior.legacy.to !== notice.to) throw Error('legacy notice changed after import');
        continue;
      }
      // Retain exact legacy bytes within the fixture's authorized body root.
      const body = Buffer.from(notice.message), bodyPath = path.join(this.root, `legacy-body-${digest(body)}`);
      writeProjection(bodyPath, body);
      const event = { schema: 'brain.log/v1', eventId, producer: { id: scope.producer, epoch: scope.epoch, sequence: index + 1 },
        occurredAt: notice.at, type: 'session.message.v1', level: 'info', identity: scope.address.identity,
        project: { commonDir: scope.address.projectRef }, source: { kind: 'supervisor-inbox-import', ref: source },
        payload: { from: scope.address, to: [config.supervisor], kind: 'notice', refs: [], reply_to: null, priority: 'normal', reply_by: null,
          summary: [...notice.message.replace(/[\s\p{Cc}]+/gu, ' ').trim()].slice(0, 240).join('') || 'Supervisor notice',
          body_ref: { path: bodyPath, sha256: digest(body), bytes: body.length, mediaType: 'text/plain' }, decision_ref: null } };
      // Import ambiguity in the SAME durable acceptance as the envelope.
      const attempts = history.filter(e => e.id === notice.id && ['sending', 'retry', 'sent', 'autopilot'].includes(e.type));
      const last = attempts.at(-1);
      const disposition = ['sent', 'handled'].includes(notice.state) ? (notice.state === 'sent' ? 'delivered' : 'consumed') :
        notice.state === 'uncertain' || notice.autopilot_owner || last?.may_have_delivered ? 'uncertain' : null;
      await receiver.accept(event, { sender: scope.receipt, recipient: addressKey(config.supervisor),
        legacy: { id: notice.id, message: notice.message, deliveryMessage: notice.delivery_message ?? notice.message, to: notice.to, disposition } });
    }
  }
  async syncIntake() {
    fixtureRoot(this.root);
    const config = this.receiver.state().config, file = config?.legacy?.inbox;
    if (!file || !fixtureInboxEnrolled(file)) throw Error('enroll fixture inbox before transfer');
    const release = noticeLock(`${file}.lock`);
    try { await this.importLocked(config); } finally { release(); }
  }
  async fence(direction) {
    if (!['switch', 'reverse'].includes(direction)) throw Error('expected switch or reverse');
    fixtureRoot(this.root);
    const config = this.receiver.state().config, file = config?.legacy?.inbox;
    if (!file || !fixtureInboxEnrolled(file)) throw Error('enroll fixture inbox before transfer');
    const release = noticeLock(`${file}.lock`);
    try {
      await this.importLocked(config);
      return await this.receiver.transaction((state, append) => {
        const from = direction === 'switch' ? 'legacy' : 'envelope';
        if (state.fence) {
          if (state.fence.direction !== direction) throw Error('another transfer is fenced');
          return state.fence;
        }
        if (state.owner !== from) throw Error(`transfer requires ${from} owner`);
        const watermark = state.entries.length;
        return append({ type: 'fence', direction, owner: from, watermark,
          legacyWatermark: state.entries.filter(e => e.legacy).length });
      });
    } finally { release(); }
  }

  async finish(direction) {
    await this.syncIntake();
    fixtureRoot(this.root);
    const file = path.join(this.root, 'delivery.lock'), lock = fs.openSync(file, 'wx', 0o600);
    try {
      return await this.receiver.transaction((state, append) => {
        if (!state.fence || state.fence.direction !== direction) throw Error('matching durable fence required');
        const key = addressKey(state.config.supervisor);
        const held = state.entries.filter(e => e.recipient === key && e.acceptance <= state.fence.watermark && !drained(e));
        if (held.length) return { switched: false, owner: state.owner, held: held.map(e => ({ eventId: e.event.eventId, state: e.state })) };
        const owner = direction === 'switch' ? 'envelope' : 'legacy';
        append({ type: 'owner', owner, direction, watermark: state.fence.watermark });
        return { switched: true, owner };
      });
    } finally { fs.closeSync(lock); fs.unlinkSync(file); }
  }
  async switch(direction = 'switch') {
    fixtureRoot(this.root);
    if (!['switch', 'reverse'].includes(direction)) throw Error('expected switch or reverse');
    const state = this.receiver.state();
    const target = direction === 'switch' ? 'envelope' : 'legacy';
    if (!state.fence && state.owner === target) return { switched: false, owner: target, already: true };
    await this.fence(direction);
    return this.finish(direction);
  }
  async drain(adapter, resolveBinding) {
    await this.syncIntake();
    const receipt = await this.receiver.deliverNext(adapter, resolveBinding);
    // Compatibility projection is repaired from authoritative receiver receipts.
    // It is never used to reset a new receiver disposition or mint another ID.
    const config = this.receiver.state().config, file = config.legacy.inbox;
    const release = noticeLock(`${file}.lock`);
    try {
      for (const entry of this.receiver.state().entries.filter(e => e.legacy && ['delivered', 'consumed', 'uncertain', 'refused'].includes(e.state))) {
        const old = readInbox(file).find(e => e.id === entry.legacy.id);
        const type = ['delivered', 'consumed'].includes(entry.state) ? 'sent' : 'sending';
        if (old?.state === (type === 'sent' ? 'sent' : 'uncertain')) continue;
        const fd = fs.openSync(file, 'a', 0o600);
        try { fs.writeFileSync(fd, canonical({ type, id: entry.legacy.id, at: new Date().toISOString(), transport: entry.state }) + '\n'); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
      }
      syncDirectory(this.root);
    } finally { release(); }
    return receipt;
  }
  status() { return transportStatus(this.root); }
}
