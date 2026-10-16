// Foreground, offline receiver. The journal is authoritative; files are projections.
import fs from 'node:fs';
import path from 'node:path';
import { constants } from 'node:fs';
import { canonical, digest, parseJSON, validateEvent, verifyBody } from './schema.mjs';
import { fixtureRoot } from './fixture.mjs';

export const addressKey = a => canonical([a.identity, a.projectRef, a.role ? ['role', a.role.bindingRef] : ['session', a.session.uid, a.session.incarnation]]);
const tuple = e => canonical([e.producer.id, e.producer.epoch, e.producer.sequence]);
const clone = x => JSON.parse(canonical(x));
const controls = new Set(['fyi', 'ack', 'hold', 'release']);
export function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function privateFile(file, flags) {
  const fd = fs.openSync(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || (stat.mode & 0o077)) { fs.closeSync(fd); throw Error('transport needs private regular files'); }
  return fd;
}
export function writeProjection(file, bytes) {
  try {
    const fd = privateFile(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(path.dirname(file));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const fd = privateFile(file, constants.O_RDONLY);
    try { if (!fs.readFileSync(fd).equals(Buffer.from(bytes))) throw Error('transport projection changed'); }
    finally { fs.closeSync(fd); }
  }
}
function privateDirectory(directory) {
  fs.mkdirSync(directory, { mode: 0o700 });
  syncDirectory(path.dirname(directory));
}
function checkDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || fs.realpathSync(directory) !== directory)
    throw Error('transport needs canonical private directories');
}
export function readTransport(root) {
  if (!root || !path.isAbsolute(root)) throw Error('transport requires an explicit absolute --root');
  if (fs.realpathSync(root) !== root) throw Error('transport root must be canonical');
  checkDirectory(root);
  const file = path.join(root, 'transport.jsonl');
  let bytes;
  try { const fd = privateFile(file, constants.O_RDONLY); try { bytes = fs.readFileSync(fd); } finally { fs.closeSync(fd); } }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (bytes.length && bytes.at(-1) !== 10) throw Error('torn transport tail preserved; inspect before recovery');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').filter(Boolean).map((line, i) => {
    const entry = parseJSON(line, 512 * 1024);
    if (entry.schema !== 'brain.transport/v1' || entry.sequence !== i + 1 || typeof entry.type !== 'string') throw Error(`corrupt transport journal line ${i + 1}`);
    return entry;
  });
}
export function foldTransport(records) {
  const state = { config: null, owner: 'legacy', fence: null, watermark: 0, entries: [], receipts: [] };
  for (const record of records) {
    if (record.type === 'init') { if (state.config) throw Error('duplicate receiver configuration'); state.config = record.config; }
    if (record.type === 'accepted') {
      validateEvent(record.event);
      state.entries.push({ ...record, state: record.initialReceipt?.state ?? 'accepted', receipts: [record.receipt, ...(record.initialReceipt ? [record.initialReceipt] : [])] });
      state.receipts.push(record.receipt, ...(record.initialReceipt ? [record.initialReceipt] : []));
    }
    if (record.type === 'receipt') {
      const entry = state.entries.find(e => e.acceptance === record.acceptance);
      if (!entry) throw Error('receipt for unknown acceptance');
      // Intent without a result after a crash remains uncertain.
      entry.state = record.receipt.state === 'wake-attempt' ? 'uncertain' : record.receipt.state;
      entry.receipts.push(record.receipt); state.receipts.push(record.receipt);
    }
    if (record.type === 'rejected') state.receipts.push(record.receipt);
    if (record.type === 'fence') { state.fence = record; state.watermark = record.watermark; }
    if (record.type === 'owner') { state.owner = record.owner; state.fence = null; }
    // Unknown future events are inert.
  }
  return state;
}
export const pending = e => ['accepted', 'pending'].includes(e.state);
export const drained = e => ['delivered', 'consumed', 'retained-refused'].includes(e.state);

export function transportStatus(root) {
  const state = foldTransport(readTransport(root));
  const openThreads = state.entries.filter(e => ['question', 'request'].includes(e.event.payload.kind) &&
    !state.entries.some(r => r.event.payload.kind === 'reply' && r.event.payload.reply_to === e.event.eventId &&
      r.event.correlationId === e.event.correlationId && r.event.payload.to.some(a => addressKey(a) === addressKey(e.event.payload.from))));
  return { schema: 'brain.transport-status/v1', owner: state.owner, watermark: state.watermark,
    fence: state.fence ? { direction: state.fence.direction, watermark: state.fence.watermark } : null,
    pending: state.entries.filter(pending).map(e => ({ eventId: e.event.eventId, recipient: e.recipient, acceptance: e.acceptance,
      spooled: Boolean(state.fence && e.acceptance > state.fence.watermark) })),
    uncertain: state.entries.filter(e => e.state === 'uncertain').map(e => e.event.eventId),
    refused: state.entries.filter(e => e.state === 'refused').map(e => e.event.eventId),
    retainedRefused: state.entries.filter(e => e.state === 'retained-refused').map(e => e.event.eventId),
    openThreads: openThreads.map(e => e.event.eventId), receipts: state.receipts };
}

export class Receiver {
  constructor({ root }) { this.root = root; }
  records() { return readTransport(this.root); }
  state() { return foldTransport(this.records()); }
  async transaction(fn) {
    fixtureRoot(this.root); checkDirectory(this.root);
    const lockFile = path.join(this.root, 'writer.lock');
    const fd = fs.openSync(lockFile, 'wx', 0o600); // Never steal crash evidence.
    try {
      const records = this.records();
      const append = data => {
        const record = { schema: 'brain.transport/v1', sequence: records.length + 1, at: new Date().toISOString(), ...data };
        const bytes = canonical(record) + '\n';
        parseJSON(bytes, 512 * 1024);
        const log = privateFile(path.join(this.root, 'transport.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
        try { fs.writeFileSync(log, bytes); fs.fsyncSync(log); } finally { fs.closeSync(log); }
        syncDirectory(this.root); records.push(record);
        return record;
      };
      return await fn(foldTransport(records), append);
    } finally { fs.closeSync(fd); fs.unlinkSync(lockFile); }
  }
  async initialize(config) {
    const input = clone(config);
    if (!Array.isArray(input.recipients) || !input.recipients.length || !Array.isArray(input.senders) || !input.senders.length ||
        !input.recipients.some(r => canonical(r.address) === canonical(input.supervisor))) throw Error('explicit local enrollments and supervisor required');
    const keys = input.recipients.map(r => addressKey(r.address));
    if (new Set(keys).size !== keys.length || new Set(input.senders.map(s => s.receipt)).size !== input.senders.length) throw Error('duplicate enrollment');
    for (const r of input.recipients) {
      if (r.address.identity !== input.supervisor.identity || r.address.projectRef !== input.supervisor.projectRef || !r.consumer)
        throw Error('only own project recipients are supported');
    }
    for (const s of input.senders) {
      if (!s.receipt || !s.producer || !s.epoch || !s.address || !Array.isArray(s.recipients) || !Array.isArray(s.bodyRoots) ||
          s.address.identity !== input.supervisor.identity || s.address.projectRef !== input.supervisor.projectRef ||
          s.address.role?.bindingRef?.startsWith('legacy-shadow:')) throw Error('sender requires an explicit local launch receipt');
      for (const root of s.bodyRoots) if (fs.realpathSync(root) !== root || !(root.startsWith(this.root + path.sep) || root === this.root)) throw Error('fixture body roots must be canonical and local');
    }
    return this.transaction((state, append) => {
      if (state.config) {
        if (canonical(state.config) !== canonical(input)) throw Error('receiver enrollment differs');
        return;
      }
      append({ type: 'init', config: input });
    });
  }
  async accept(input, { sender, recipient, legacy = null } = {}) {
    // Snapshot before awaiting anything; origin fields are never rewritten.
    const event = clone(validateEvent(input));
    return this.transaction(async (state, append) => {
      let target;
      const refuse = reason => {
        const receipt = { state: 'refused', eventId: event.eventId, recipient: recipient ?? null, reason };
        append({ type: 'rejected', receipt });
        throw Error(`message refused: ${reason}`);
      };
      if (!state.config) return refuse('receiver is unenrolled');
      if (event.type !== 'session.message.v1' || event.cursor || event.receivedAt || event.stream || event.shadow) return refuse('receiver accepts only origin message envelopes');
      const scope = state.config.senders.find(s => s.receipt === sender);
      if (!scope || scope.producer !== event.producer.id || scope.epoch !== event.producer.epoch || canonical(scope.address) !== canonical(event.payload.from)) return refuse('unknown or out-of-scope sender');
      const p = event.payload;
      if (legacy && (scope.receipt !== state.config.legacy?.sender || typeof legacy.id !== 'string' || typeof legacy.message !== 'string' || typeof legacy.to !== 'string' || ![null, 'delivered', 'consumed', 'refused', 'uncertain'].includes(legacy.disposition))) return refuse('legacy rendering requires the enrolled inbox importer');
      if (event.identity === 'operator' || ['operator', 'human'].includes(p.from.role?.name) || p.origin || p.provenance || ['operator', 'human'].includes(p.evidence?.origin)) return refuse('human origin is unverified; actual relayer is required');
      if (!p.to.every(a => scope.recipients.includes(addressKey(a)) && state.config.recipients.some(r => canonical(r.address) === canonical(a)))) return refuse('recipient outside sender scope');
      target = p.to.find(a => addressKey(a) === recipient);
      if (!target) return refuse('explicit addressed recipient required');
      const prior = state.entries.find(e => e.recipient === recipient && (e.event.eventId === event.eventId || tuple(e.event) === tuple(event)));
      if (prior) {
        if (canonical(prior.event) !== canonical(event) || canonical(prior.legacy) !== canonical(legacy)) return refuse('conflicting eventId or producer sequence');
        // A previous caller may have lost an fsync error after writing a full
        // line. Re-establish durability before returning its acceptance again.
        const fd = privateFile(path.join(this.root, 'transport.jsonl'), constants.O_WRONLY);
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        syncDirectory(this.root);
        return { ...prior.receipt, duplicate: true };
      }
      if (p.kind === 'reply') {
        const question = state.entries.find(e => e.event.eventId === p.reply_to && ['question', 'request'].includes(e.event.payload.kind) &&
          e.event.correlationId === event.correlationId && addressKey(e.event.payload.from) === recipient &&
          e.event.payload.to.some(a => canonical(a) === canonical(p.from)) && canonical(e.event.payload.refs) === canonical(p.refs));
        if (!question) return refuse('reply does not match a pending thread, expected sender and exact recipient');
        if (state.entries.some(e => e.event.payload.kind === 'reply' && e.event.payload.reply_to === p.reply_to &&
            e.event.correlationId === event.correlationId && e.recipient === recipient && canonical(e.event.payload.from) === canonical(p.from))) return refuse('conflicting reply to answered thread');
      } else if (p.reply_to !== null) return refuse('only a correlated reply can answer a pending thread');
      const bodies = [];
      try {
        for (const [field, ref] of [['body_ref', p.body_ref], ['decision_memo', p.decision_ref?.memo]]) {
          if (ref) bodies.push({ field, ref, base64: (await verifyBody(ref, { roots: scope.bodyRoots })).toString('base64') });
        }
      } catch (error) { return refuse(error.message); }
      const acceptance = state.entries.length + 1;
      const receipt = { state: 'accepted', eventId: event.eventId, recipient, acceptance, sha256: digest(canonical(event)) };
      const initialReceipt = legacy?.disposition ? { ...receipt, state: legacy.disposition, reason: 'imported compatibility inbox disposition' } : null;
      append({ type: 'accepted', acceptance, event, recipient, bodies, legacy, receipt, initialReceipt });
      return receipt;
    });
  }
  async #receipt(acceptance, state, extra = {}) {
    return this.transaction((view, append) => {
      const entry = view.entries.find(e => e.acceptance === acceptance);
      if (!entry) throw Error('unknown acceptance');
      const receipt = { ...extra, state, eventId: entry.event.eventId, recipient: entry.recipient, acceptance };
      append({ type: 'receipt', acceptance, receipt }); return receipt;
    });
  }
  project(entry) {
    fixtureRoot(this.root); checkDirectory(this.root);
    for (const name of ['bodies', 'envelopes']) {
      const dir = path.join(this.root, name);
      if (!fs.existsSync(dir)) privateDirectory(dir);
      checkDirectory(dir);
    }
    const retained = entry.bodies.map(b => {
      const bytes = Buffer.from(b.base64, 'base64');
      if (bytes.length !== b.ref.bytes || digest(bytes) !== b.ref.sha256) throw Error('corrupt retained body');
      const file = path.join(this.root, 'bodies', `${b.ref.sha256}.body`);
      writeProjection(file, bytes);
      return { field: b.field, ...b.ref, path: file };
    });
    const content = canonical({ schema: 'brain.message-pointer/v1', event: entry.event, retained });
    const file = path.join(this.root, 'envelopes', `${entry.acceptance}.json`);
    writeProjection(file, content);
    return { eventId: entry.event.eventId, kind: entry.event.payload.kind, summary: entry.event.payload.summary,
      path: file, sha256: digest(content), ...(entry.legacy ? { legacyText: `${entry.legacy.deliveryMessage} notice-id=${entry.legacy.id}` } : {}) };
  }
  async consume(eventId, recipient, { consumer } = {}) {
    fixtureRoot(this.root);
    const delivery = path.join(this.root, 'delivery.lock'), lock = fs.openSync(delivery, 'wx', 0o600);
    try {
      const state = this.state();
      const enrollment = state.config?.recipients.find(r => addressKey(r.address) === recipient && r.consumer === consumer);
      const entry = state.entries.find(e => e.event.eventId === eventId && e.recipient === recipient);
      if (!enrollment || !entry) throw Error('unknown consumer or addressed event');
      if (['refused', 'retained-refused', 'uncertain'].includes(entry.state)) throw Error('delivery hold requires explicit inspection before consumption');
      const pointer = this.project(entry), stored = parseJSON(fs.readFileSync(pointer.path, 'utf8'), 32 * 1024);
      if (digest(fs.readFileSync(pointer.path)) !== pointer.sha256) throw Error('envelope projection changed');
      const bodies = [];
      for (const ref of stored.retained) bodies.push({ field: ref.field, bytes: await verifyBody(ref, { roots: [path.join(this.root, 'bodies')] }) });
      if (entry.state !== 'consumed') await this.#receipt(entry.acceptance, 'consumed', { consumer, reason: 'verified and exposed to recipient; no claim of understanding' });
      return { event: stored.event, bodies };
    } finally { fs.closeSync(lock); fs.unlinkSync(delivery); }
  }
  // Pull at a harness turn boundary. Prepare/verify every output byte before
  // committing the single handoff receipt. Shares the push/transfer exclusion.
  async claimNext({ recipient, consumer, session, hook, render }) {
    fixtureRoot(this.root);
    const file = path.join(this.root, 'delivery.lock'), lock = fs.openSync(file, 'wx', 0o600);
    try { return await this.transaction((state, append) => {
      if (typeof session !== 'string' || !session || !['Stop', 'UserPromptSubmit'].includes(hook) ||
          !state.config?.recipients.some(r => addressKey(r.address) === recipient && r.consumer === consumer))
        throw Error('unknown hook session or consumer');
      const entry = state.entries.find(e => e.recipient === recipient && !drained(e) && (!state.fence || e.acceptance <= state.fence.watermark));
      if (!entry) return null;
      if (!pending(entry)) throw Error('delivery hold requires inspection');
      const retry = entry.receipts.findLast(r => r.retryTransport !== undefined);
      if (retry && retry.retryTransport !== 'hook-pull/v1') throw Error('retry belongs to another transport');
      const bodies = entry.bodies.map(b => {
        const bytes = Buffer.from(b.base64, 'base64');
        if (bytes.length !== b.ref.bytes || digest(bytes) !== b.ref.sha256) throw Error('corrupt retained body');
        return { field: b.field, bytes };
      });
      const control = controls.has(entry.event.payload.kind);
      const output = control ? null : render({ event: clone(entry.event), bodies });
      if (!control && (typeof output !== 'string' || !output)) throw Error('empty hook rendering');
      const receipt = { state: control ? 'consumed' : 'delivered', eventId: entry.event.eventId, recipient, acceptance: entry.acceptance,
        transport: 'hook-pull/v1', consumer, session, hook,
        reason: control ? 'rule-consumed: control retained without model wake or control effect' : 'hook handoff committed; processing unknown' };
      append({ type: 'receipt', acceptance: entry.acceptance, receipt });
      return output;
    }); } finally { fs.closeSync(lock); fs.unlinkSync(file); }
  }
  async deliverNext(adapter, resolveBinding, { recipient = addressKey(this.state().config.supervisor) } = {}) {
    fixtureRoot(this.root);
    const delivery = path.join(this.root, 'delivery.lock');
    const lock = fs.openSync(delivery, 'wx', 0o600);
    try {
      const state = this.state();
      const entry = state.entries.find(e => e.recipient === recipient && !drained(e) && (!state.fence || e.acceptance <= state.fence.watermark));
      if (!entry) return null;
      if (!pending(entry)) return entry.receipts.at(-1); // Refused/uncertain: never another adapter attempt.
      const transport = typeof adapter.id === 'string' && adapter.id ? adapter.id : null;
      const retry = entry.receipts.findLast(receipt => receipt.retryTransport !== undefined);
      if (retry && retry.retryTransport !== transport)
        return this.#receipt(entry.acceptance, 'pending', { reason: 'inspected refusal retry requires the original transport', retryTransport: retry.retryTransport });
      if (controls.has(entry.event.payload.kind)) return this.#receipt(entry.acceptance, 'consumed', { reason: 'rule-consumed: control retained without model wake or control effect' });
      let binding;
      try { binding = clone((await resolveBinding(entry.recipient)) ?? null); }
      catch (error) { return await this.#receipt(entry.acceptance, 'pending', { reason: `binding resolution held: ${error.message}` }); }
      const pointer = this.project(entry);
      let attempted = false;
      // offerQuiet's callback is synchronous so no write occurs after its final
      // pane read. Commit intent synchronously while holding the writer lock.
      const intent = () => {
        if (attempted) throw Error('adapter attempted input twice');
        this.#receiptSync(entry.acceptance, 'wake-attempt', { owner: state.owner, binding, pointer, transport });
        attempted = true;
      };
      let result;
      try { result = await adapter.deliver(pointer, binding, { beforePrompt: intent }); }
      catch (error) { result = { state: attempted ? 'uncertain' : 'pending', reason: error.message }; }
      if (!['delivered', 'pending', 'refused', 'uncertain'].includes(result?.state) || (!attempted && result.state !== 'pending'))
        result = { state: attempted ? 'uncertain' : 'pending', reason: 'invalid adapter receipt; inspect before retry' };
      return await this.#receipt(entry.acceptance, result.state, { reason: result.reason ?? '', owner: state.owner, binding, pointer, transport });
    } finally { fs.closeSync(lock); fs.unlinkSync(delivery); }
  }
  #receiptSync(acceptance, state, extra) {
    fixtureRoot(this.root); checkDirectory(this.root);
    const lockFile = path.join(this.root, 'writer.lock'), lock = fs.openSync(lockFile, 'wx', 0o600);
    try {
      const records = this.records(), entry = foldTransport(records).entries.find(e => e.acceptance === acceptance);
      if (!entry) throw Error('unknown acceptance');
      const receipt = { ...extra, state, acceptance, eventId: entry.event.eventId, recipient: entry.recipient };
      const bytes = canonical({ schema: 'brain.transport/v1', type: 'receipt', sequence: records.length + 1, at: new Date().toISOString(), acceptance, receipt }) + '\n';
      const fd = privateFile(path.join(this.root, 'transport.jsonl'), constants.O_WRONLY | constants.O_APPEND);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      syncDirectory(this.root);
    } finally { fs.closeSync(lock); fs.unlinkSync(lockFile); }
  }
  async resolveUncertain(eventId, recipient, { delivered, evidence } = {}) {
    if (typeof delivered !== 'boolean' || typeof evidence !== 'string' || !evidence.trim()) throw Error('inspection evidence and explicit delivery disposition required');
    return this.#resolveHold(eventId, recipient, 'uncertain', delivered ? 'delivered' : 'pending', evidence);
  }
  async resolveRefused(eventId, recipient, { disposition, evidence } = {}) {
    if (!['pending', 'retained-refused'].includes(disposition) || typeof evidence !== 'string' || !evidence.trim())
      throw Error('inspection evidence and explicit refused disposition required');
    return this.#resolveHold(eventId, recipient, 'refused', disposition, evidence);
  }
  async #resolveHold(eventId, recipient, hold, disposition, evidence) {
    fixtureRoot(this.root);
    const file = path.join(this.root, 'delivery.lock'), lock = fs.openSync(file, 'wx', 0o600);
    try {
      const entry = this.state().entries.find(e => e.event.eventId === eventId && e.recipient === recipient);
      if (entry?.state !== hold) throw Error(`event is not ${hold}`);
      const retryTransport = hold === 'refused' && disposition === 'pending' ? entry.receipts.at(-1).transport : undefined;
      if (hold === 'refused' && disposition === 'pending' && !retryTransport) throw Error('original transport is unknown; retain the refusal instead');
      return await this.#receipt(entry.acceptance, disposition, { inspection: evidence, ...(retryTransport ? { retryTransport } : {}) });
    } finally { fs.closeSync(lock); fs.unlinkSync(file); }
  }
}
