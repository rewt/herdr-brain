// Foreground, identity-owned journal. The segments are the only commit/dedup log.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ShadowJournal } from '../messages/journal.mjs';
import { canonical, digest, parseJSON, validateEvent } from '../messages/schema.mjs';
import { detect, observation } from './rules.mjs';

export const LIMITS = Object.freeze({ version: 'log-storage/v1', segmentBytes: 1024 * 1024,
  retentionBytes: 256 * 1024 * 1024, retentionMs: 7 * 86400000, batchEvents: 100, batchBytes: 64 * 1024, progressMs: 5000 });
const segmentName = sequence => `segment-${String(sequence).padStart(16, '0')}.jsonl`;
const key = event => canonical([event.producer.id, event.producer.epoch, event.producer.sequence]);
const producer = event => canonical([event.producer.id, event.producer.epoch]);
export function inputOf(event) { const { stream, cursor, receivedAt, ...input } = event; return input; }
const privateFile = stat => { if (!stat.isFile() || stat.mode & 0o077) throw Error('log file must be a private regular file'); };

export class LogJournal {
  constructor(options) {
    // Reuse both the resolver and its repeated private-path checks, without
    // changing shadow.jsonl or the stage 7 format.
    this.scope = new ShadowJournal(options);
    const env = options.env ?? process.env;
    this.locationOptions = { identity: options.identity, commonDir: options.commonDir, root: options.root,
      env: { HOME: env.HOME, BRAIN_SHADOW_ROOT: env.BRAIN_SHADOW_ROOT } };
    this.directory = this.scope.directory;
    this.identity = options.identity; this.commonDir = options.commonDir;
    this.io = options.io ?? fs;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.limits = { ...LIMITS, ...options.limits };
    for (const name of ['segmentBytes', 'retentionBytes', 'retentionMs', 'batchEvents', 'batchBytes', 'progressMs'])
      if (!Number.isSafeInteger(this.limits[name]) || this.limits[name] < 1) throw Error(`invalid log limit: ${name}`);
  }
  async syncDirectory() {
    const handle = await this.io.open(this.directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async readFile(file) {
    const handle = await this.io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { privateFile(await handle.stat()); return await handle.readFile(); } finally { await handle.close(); }
  }
  async syncHead(state) {
    const latest = state.segments.at(-1);
    if (!latest) return;
    const handle = await this.io.open(path.join(this.directory, latest.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { privateFile(await handle.stat()); await handle.sync(); } finally { await handle.close(); }
    await this.syncDirectory();
  }
  async read() {
    // Resolution is read-only, and also refuses replaced storage components.
    const check = new ShadowJournal(this.locationOptions);
    if (check.directory !== this.directory) throw Error('log partition changed');
    let names;
    try { names = (await this.io.readdir(this.directory)).filter(n => /^segment-\d{16}\.jsonl$/.test(n)).sort(); }
    catch (error) { if (error.code === 'ENOENT') return { entries: [], segments: [], tornTail: null, floor: null, watermarks: {} }; throw error; }
    const entries = [], segments = []; let tornTail = null;
    for (const [index, name] of names.entries()) {
      const bytes = await this.readFile(path.join(this.directory, name));
      const end = bytes.lastIndexOf(10) + 1, tail = bytes.subarray(end), rows = [];
      if (tail.length) {
        tornTail = { segment: name, offset: end, bytes: tail.length, sha256: digest(tail) };
        if (index !== names.length - 1) throw Error(`corrupt middle segment ${name}: incomplete tail preserved`);
      }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
        for (const line of text.split('\n').slice(0, -1)) {
          const event = validateEvent(parseJSON(line));
          if (!event.cursor || !event.receivedAt || event.identity !== this.identity || event.project.commonDir !== this.commonDir || event.stream !== `${this.identity}/${digest(this.commonDir)}`) throw Error('invalid stored scope/cursor');
          rows.push(event); entries.push(event);
        }
        if (rows.length && name !== segmentName(rows[0].cursor.sequence)) throw Error('segment sequence name mismatch');
        if (!rows.length && index !== names.length - 1) throw Error('empty middle segment');
        if (!rows.length && bytes.length === 0) tornTail = { segment: name, offset: 0, bytes: 0, sha256: digest(bytes) };
      } catch (error) { throw Error(`corrupt log segment ${name}: ${error.message}`); }
      segments.push({ name, bytes: bytes.length, entries: rows });
    }
    const epoch = entries[0]?.cursor.epoch;
    let floorSequence = 1, watermarks = {};
    for (const event of entries) if (event.type === 'service.retention' && event.producer.id === 'logs-control') {
      const p = event.payload;
      if (!Number.isSafeInteger(p.floor) || p.floor < floorSequence || p.floor > event.cursor.sequence || !p.watermarks || typeof p.watermarks !== 'object' || Array.isArray(p.watermarks)) throw Error('corrupt retention control');
      for (const [id, seq] of Object.entries(p.watermarks)) {
        if (!Number.isSafeInteger(seq) || seq < 1) throw Error('corrupt retention watermark');
        watermarks[id] = Math.max(watermarks[id] ?? 0, seq);
      }
      floorSequence = p.floor;
    }
    let previous = 0; const ids = new Set(), keys = new Set();
    for (const event of entries) {
      const seq = event.cursor.sequence;
      if (event.cursor.epoch !== epoch || seq <= previous || (seq !== previous + 1 && seq > floorSequence)) throw Error('corrupt log sequence gap or epoch');
      if (ids.has(event.eventId) || keys.has(key(event))) throw Error('corrupt duplicate log key');
      ids.add(event.eventId); keys.add(key(event)); previous = seq;
    }
    return { entries, segments, tornTail, floor: epoch ? { epoch, sequence: floorSequence } : null, watermarks };
  }
  async locked(fn) {
    await this.scope.prepareDirectory();
    if (await this.io.realpath(this.commonDir) !== this.commonDir) throw Error('noncanonical project commonDir');
    let lock;
    const file = path.join(this.directory, 'log-writer.lock');
    try { lock = await this.io.open(file, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw Error('log writer locked; inspect ownership before explicit removal'); throw error; }
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, at: this.clock() }) + '\n'); return await fn(); }
    finally { await lock.close(); await this.io.unlink(file); }
  }
  control(type, payload, id = randomUUID()) {
    return { schema: 'brain.log/v1', eventId: `logs:${type}:${id}`, producer: { id: 'logs-control', epoch: id, sequence: 1 },
      occurredAt: this.clock(), level: 'info', identity: this.identity, project: { commonDir: this.commonDir }, type, payload };
  }
  async write(input, state, { rotate = false } = {}) {
    const last = state.entries.at(-1), sequence = (last?.cursor.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw Error('log sequence exhausted');
    const entry = { ...input, stream: `${this.identity}/${digest(this.commonDir)}`,
      cursor: { epoch: last?.cursor.epoch ?? randomUUID(), sequence }, receivedAt: this.clock() };
    validateEvent(entry); // Including writer fields within the shared 16 KiB cap.
    const bytes = Buffer.from(JSON.stringify(entry) + '\n'), previous = state.segments.at(-1);
    const name = !rotate && previous && previous.bytes + bytes.length <= this.limits.segmentBytes ? previous.name : segmentName(sequence);
    const handle = await this.io.open(path.join(this.directory, name), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try { privateFile(await handle.stat()); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await this.syncDirectory(); // Segment creation is durable before acceptance too.
    return entry;
  }
  async appendRaw(input, internal = false) {
    validateEvent(input);
    const event = JSON.parse(canonical(input));
    if (event.cursor || event.receivedAt || event.stream || event.shadow) throw Error('log writer owns cursor, receivedAt and stream');
    if (event.identity !== this.identity || event.project.commonDir !== this.commonDir) throw Error('log partition scope mismatch');
    if (!internal && (event.producer.id.startsWith('logs-') || ['service.retention', 'service.events.coalesced', 'service.journal.repaired', 'detector.hit'].includes(event.type))) throw Error('reserved log observation');
    return this.locked(async () => {
      const state = await this.read();
      if (state.tornTail) throw Error('torn log tail preserved; explicit repair required');
      // Recover complete-but-unacknowledged bytes before a later segment or
      // cursor can become durable ahead of them.
      await this.syncHead(state);
      const prior = state.entries.find(e => e.eventId === event.eventId || key(e) === key(event));
      if (prior) {
        if (canonical(inputOf(prior)) !== canonical(event)) throw Error('conflicting log event id or producer key');
        // A previous fsync failure may have left a complete line. Sync again
        // before acknowledging an identical retry after restart.
        const segment = state.segments.find(s => s.entries.includes(prior));
        const handle = await this.io.open(path.join(this.directory, segment.name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await handle.sync(); } finally { await handle.close(); }
        await this.syncDirectory();
        return { disposition: 'duplicate', cursor: prior.cursor, entry: prior };
      }
      if ((state.watermarks[producer(event)] ?? 0) >= event.producer.sequence) throw Error('producer outside retained replay horizon; reconciliation required');
      const entry = await this.write(event, state);
      return { disposition: 'accepted', cursor: entry.cursor, entry };
    });
  }
  async reconcileDetectors() {
    const state = await this.read();
    if (state.tornTail) throw Error('torn log tail preserved; explicit repair required');
    const observations = detect(state.entries);
    for (const hit of observations) {
      const event = observation(hit, { identity: this.identity, commonDir: this.commonDir });
      if (!state.entries.some(e => e.eventId === event.eventId)) await this.appendRaw(event, true);
    }
    return observations;
  }
  async append(input) {
    const result = await this.appendRaw(input);
    // No detector evaluation, model or consumer holds the writer critical section.
    await this.reconcileDetectors();
    await this.retain();
    return result;
  }
  async retain() {
    return this.locked(async () => {
      const state = await this.read();
      if (state.tornTail) throw Error('torn log tail preserved; explicit repair required');
      if (!state.entries.length) return null;
      // Complete lines left by a failed fsync are recoverable, but must be
      // synced before applying a previously written deletion intent.
      await this.syncHead(state);
      // A committed control is a deletion intent. Complete it after a crash
      // before computing a new floor; never infer a gap from missing files.
      for (const s of state.segments) if (s.entries.length && s.entries.at(-1).cursor.sequence < state.floor.sequence) await this.io.unlink(path.join(this.directory, s.name));
      const segments = state.segments.filter(s => s.entries.at(-1)?.cursor.sequence >= state.floor.sequence);
      let bytes = segments.reduce((n, s) => n + s.bytes, 0), remove = [];
      const cutoff = Date.parse(this.clock()) - this.limits.retentionMs;
      for (const s of segments.slice(0, -1)) {
        if (bytes <= this.limits.retentionBytes && s.entries.some(e => Date.parse(e.receivedAt) >= cutoff)) break;
        remove.push(s); bytes -= s.bytes;
      }
      // Rotate a single over-age/over-size segment too; keep the new control.
      const last = segments.at(-1);
      if (last && remove.length === segments.length - 1 && (bytes > this.limits.retentionBytes || last.entries.every(e => Date.parse(e.receivedAt) < cutoff))) remove.push(last);
      if (!remove.length) { await this.syncDirectory(); return null; }
      let control;
      for (;;) {
        const removed = remove.flatMap(s => s.entries), watermarks = { ...state.watermarks };
        for (const event of removed) if (!event.producer.id.startsWith('logs-')) watermarks[producer(event)] = Math.max(watermarks[producer(event)] ?? 0, event.producer.sequence);
        const floor = removed.at(-1).cursor.sequence + 1, removedBytes = remove.reduce((n, s) => n + s.bytes, 0);
        control = this.control('service.retention', { floor, watermarks,
          sequenceRanges: [[removed[0].cursor.sequence, floor - 1]], count: removed.length, bytes: removedBytes });
        const stored = { ...control, stream: `${this.identity}/${digest(this.commonDir)}`, receivedAt: this.clock(),
          cursor: { epoch: state.floor.epoch, sequence: state.entries.at(-1).cursor.sequence + 1 } };
        validateEvent(stored);
        const controlBytes = Buffer.byteLength(JSON.stringify(stored) + '\n');
        if (segments.reduce((n, s) => n + s.bytes, 0) - removedBytes + controlBytes <= this.limits.retentionBytes) break;
        if (remove.length === segments.length) throw Error('retention control exceeds byte ceiling; evidence preserved for explicit reconciliation');
        remove.push(segments[remove.length]);
      }
      const entry = await this.write(control, state, { rotate: true });
      // Oversized control/watermark sets fail visibly before deleting evidence.
      for (const s of remove) await this.io.unlink(path.join(this.directory, s.name));
      await this.syncDirectory();
      return entry;
    });
  }
  async repair() {
    return this.locked(async () => {
      const state = await this.read(), tail = state.tornTail;
      if (!tail) return null;
      const file = path.join(this.directory, tail.segment), bytes = await this.readFile(file);
      const evidence = `${tail.segment}.${digest(bytes)}.evidence`;
      let archive;
      try { archive = await this.io.open(path.join(this.directory, evidence), 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!(await this.readFile(path.join(this.directory, evidence))).equals(bytes)) throw Error('repair evidence changed');
        const saved = await this.io.open(path.join(this.directory, evidence), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await saved.sync(); } finally { await saved.close(); }
      }
      if (archive) try { await archive.writeFile(bytes); await archive.sync(); } finally { await archive.close(); }
      await this.syncDirectory();
      const handle = await this.io.open(file, constants.O_WRONLY | constants.O_NOFOLLOW);
      try { await handle.truncate(tail.offset); await handle.sync(); } finally { await handle.close(); }
      if (tail.offset === 0) { await this.io.unlink(file); await this.syncDirectory(); }
      const repaired = await this.read();
      return this.write(this.control('service.journal.repaired', { ...tail, evidence }), repaired);
    });
  }
  async subscribe(id, { cursor, acknowledge = false, limit = this.limits.batchEvents } = {}) {
    if (!/^[a-zA-Z0-9][\w-]{0,127}$/.test(id)) throw Error('invalid subscriber id');
    if (!Number.isInteger(limit) || limit < 1 || limit > this.limits.batchEvents) throw Error('invalid batch limit');
    // Cursor transactions share the partition lock, never a long-held consumer lock.
    return this.locked(async () => {
      const state = await this.read();
      if (state.tornTail) throw Error('torn log tail preserved; explicit repair required');
      const file = path.join(this.directory, `subscriber-${id}.json`);
      let previous = null;
      try { previous = parseJSON((await this.readFile(file)).toString()); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const valid = c => c && typeof c.epoch === 'string' && Number.isSafeInteger(c.sequence) && c.sequence >= 0;
      if (previous && !valid(previous)) throw Error('corrupt subscriber cursor');
      cursor ??= previous;
      if (cursor && !valid(cursor)) throw Error('invalid subscriber cursor');
      const floor = state.floor, last = state.entries.at(-1)?.cursor;
      if (cursor && floor && cursor.epoch === floor.epoch && cursor.sequence > last.sequence) throw Error('cursor ahead of journal');
      const gap = cursor && floor && (cursor.epoch !== floor.epoch || cursor.sequence < floor.sequence - 1)
        ? { requested: cursor, floor, reason: 'history unavailable; rebuild from authoritative sources' } : null;
      const start = gap || !cursor ? (floor?.sequence ?? 1) - 1 : cursor.sequence;
      const entries = []; let bytes = 0;
      for (const e of state.entries) if (e.cursor.sequence > start) {
        const size = Buffer.byteLength(JSON.stringify(e) + '\n');
        if (entries.length >= limit || bytes + size > this.limits.batchBytes) {
          if (!entries.length) throw Error('event exceeds subscriber byte ceiling');
          break;
        }
        entries.push(e); bytes += size;
      }
      const next = entries.at(-1)?.cursor ?? (floor ? { epoch: floor.epoch, sequence: start } : null);
      if (acknowledge && next) {
        if (previous && previous.epoch === next.epoch && previous.sequence > next.sequence) throw Error('subscriber cursor cannot move backward');
        await this.syncHead(state);
        const temporary = `${file}.${randomUUID()}.tmp`, handle = await this.io.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(canonical(next) + '\n'); await handle.sync(); } finally { await handle.close(); }
        await this.io.rename(temporary, file); await this.syncDirectory();
      }
      return { entries, next, floor, gap };
    });
  }
}
