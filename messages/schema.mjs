// Structural validation only. Addresses and decision references confer no authority.
import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';

export const SCHEMA = 'brain.log/v1';
export const KINDS = ['request', 'reply', 'decision', 'fyi', 'hold', 'release', 'notice', 'question', 'ack'];
export const MAX_EVENT_BYTES = 16 * 1024;
export const MAX_BODY_BYTES = 64 * 1024;
export const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Error(`message schema: ${message}`); };
function string(value, name, max = 1024) {
  if (typeof value !== 'string' || !value || value.length > max || /[\p{Cc}\u2028\u2029]/u.test(value)) fail(name);
}
function absolute(value, name) {
  string(value, name, 4096);
  if (!path.isAbsolute(value) || path.normalize(value) !== value) fail(`${name} must be canonical and absolute`);
}
function time(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail(name);
  const normalized = new Date(value).toISOString();
  if (normalized.slice(0, 19) !== value.slice(0, 19)) fail(name);
}
function sequence(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail(name);
}
function body(ref) {
  if (!object(ref)) fail('body_ref');
  absolute(ref.path, 'body_ref.path');
  if (!/^[a-f0-9]{64}$/.test(ref.sha256)) fail('body_ref.sha256');
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > MAX_BODY_BYTES) fail('body_ref.bytes');
  string(ref.mediaType, 'body_ref.mediaType', 128);
  if (!/^[\w.+-]+\/[\w.+-]+(?:;[^\r\n]*)?$/.test(ref.mediaType)) fail('body_ref.mediaType');
}
function address(value) {
  if (!object(value)) fail('address');
  string(value.identity, 'address.identity', 128);
  absolute(value.projectRef, 'address.projectRef');
  if (Boolean(value.role) === Boolean(value.session)) fail('address requires exactly one role or session');
  if (value.role) {
    string(value.role.name, 'role.name', 128);
    string(value.role.bindingRef, 'role.bindingRef');
  } else {
    string(value.session.uid, 'session.uid');
    string(value.session.incarnation, 'session.incarnation');
  }
}

// Sorted JSON is also the content comparison used after rebuilding the journal.
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  fail('non-JSON value');
}

// JSON.parse alone discards duplicate keys, including escaped spellings. Scan
// object keys first, then let JSON.parse enforce the rest of JSON's grammar.
export function parseJSON(text, maxBytes = MAX_EVENT_BYTES) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) fail('JSON byte bound');
  let i = 0;
  const space = () => { while (/[\t\r\n ]/.test(text[i] ?? '') && i < text.length) i++; };
  const quoted = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    fail('unterminated JSON string');
  };
  function scan(depth = 0) {
    if (depth > 32) fail('JSON depth bound');
    space();
    if (text[i] === '{') {
      i++; space(); const keys = new Set();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        space(); if (text[i] !== '"') fail('JSON object key');
        const key = quoted();
        if (keys.has(key)) fail(`duplicate JSON key ${key}`);
        keys.add(key); space(); if (text[i++] !== ':') fail('JSON colon');
        scan(depth + 1); space();
        if (text[i] === '}') { i++; return; }
        if (text[i++] !== ',') fail('JSON object separator');
      }
    }
    if (text[i] === '[') {
      i++; space(); if (text[i] === ']') { i++; return; }
      for (;;) {
        scan(depth + 1); space();
        if (text[i] === ']') { i++; return; }
        if (text[i++] !== ',') fail('JSON array separator');
      }
    }
    if (text[i] === '"') { quoted(); return; }
    const start = i;
    while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
    if (start === i) fail('JSON value');
  }
  scan(); space(); if (i !== text.length) fail('JSON trailing content');
  return JSON.parse(text);
}

export function validateEvent(event) {
  // This also rejects undefined, nonfinite numbers and non-JSON extras.
  const encoded = canonical(event);
  parseJSON(encoded);
  if (!object(event) || event.schema !== SCHEMA) fail('schema must be brain.log/v1');
  string(event.eventId, 'eventId');
  if (!object(event.producer)) fail('producer');
  string(event.producer.id, 'producer.id'); string(event.producer.epoch, 'producer.epoch');
  sequence(event.producer.sequence, 'producer.sequence');
  time(event.occurredAt, 'occurredAt');
  if (event.receivedAt !== undefined) time(event.receivedAt, 'receivedAt');
  if (event.cursor !== undefined) { string(event.cursor.epoch, 'cursor.epoch'); sequence(event.cursor.sequence, 'cursor.sequence'); }
  if (event.stream !== undefined) string(event.stream, 'stream');
  string(event.type, 'type', 128);
  if (!['debug', 'info', 'warn', 'error'].includes(event.level)) fail('level');
  string(event.identity, 'identity', 128); absolute(event.project?.commonDir, 'project.commonDir');
  if (!object(event.payload)) fail('payload');
  for (const key of ['workspaceUid', 'sessionUid', 'incarnation', 'run', 'item', 'correlationId', 'causationId'])
    if (event[key] !== undefined) string(event[key], key);
  if (Boolean(event.sessionUid) !== Boolean(event.incarnation)) fail('sessionUid/incarnation pair');
  if (/^(run\.|review\.)/.test(event.type) && (!event.run || !event.item)) fail('run-specific event refs');
  if (event.orgRef !== undefined) absolute(event.orgRef, 'orgRef');
  if (event.source !== undefined) { string(event.source.kind, 'source.kind'); string(event.source.ref, 'source.ref', 4096); }
  if (event.type !== 'session.message.v1') return event; // Unknown types stay inert.
  const p = event.payload;
  address(p.from);
  if (p.from.identity !== event.identity || p.from.projectRef !== event.project.commonDir) fail('outer origin and from disagree');
  if (event.sessionUid && (p.from.session?.uid !== event.sessionUid || p.from.session?.incarnation !== event.incarnation)) fail('outer session and from disagree');
  if (!Array.isArray(p.to) || !p.to.length || p.to.length > 32) fail('to must contain 1..32 addresses');
  p.to.forEach(address);
  const recipientKey = value => canonical([value.identity, value.projectRef,
    value.role ? ['role', value.role.bindingRef] : ['session', value.session.uid, value.session.incarnation]]);
  if (new Set(p.to.map(recipientKey)).size !== p.to.length) fail('duplicate recipient');
  if (!KINDS.includes(p.kind)) fail('kind');
  if (!Array.isArray(p.refs) || p.refs.length > 64) fail('refs');
  for (const ref of p.refs) {
    absolute(ref.orgRef, 'refs.orgRef');
    if (!ref.item && !ref.run) fail('ref needs item or run');
    if (ref.item !== undefined) string(ref.item, 'refs.item');
    if (ref.run !== undefined) string(ref.run, 'refs.run');
  }
  if (event.item || event.run) {
    const origin = p.refs.filter(ref => (!event.item || ref.item === event.item) && (!event.run || ref.run === event.run));
    if (!origin.length || new Set(origin.map(ref => ref.orgRef)).size !== 1 || (event.orgRef && origin[0].orgRef !== event.orgRef)) fail('outer refs and org-qualified refs disagree');
  }
  if (p.reply_to !== null) string(p.reply_to, 'reply_to');
  if (p.kind === 'reply' && (!p.reply_to || !event.correlationId)) fail('reply requires reply_to and correlationId');
  if (!['normal', 'urgent'].includes(p.priority)) fail('priority');
  if (p.reply_by !== null) time(p.reply_by, 'reply_by');
  if (typeof p.summary !== 'string' || !p.summary.trim() || [...p.summary].length > 240 || /[\p{Cc}\u2028\u2029]/u.test(p.summary)) fail('summary must be one line, at most 240 characters');
  if (p.body_ref !== null) body(p.body_ref);
  if (p.decision_ref !== null) {
    const d = p.decision_ref;
    absolute(d.orgRef, 'decision_ref.orgRef'); sequence(d.sequence, 'decision_ref.sequence');
    string(d.author, 'decision_ref.author'); string(d.delegationRef, 'decision_ref.delegationRef');
    if (d.memo !== undefined) body(d.memo);
  }
  return event;
}
export const parseEvent = text => validateEvent(parseJSON(text));

// Explicit consumption helper; validation/journaling NEVER follows a body path.
export async function verifyBody(ref, { roots }) {
  body(ref);
  const permitted = await Promise.all(roots.map(root => fs.realpath(root)));
  const resolved = await fs.realpath(ref.path);
  if (resolved !== ref.path || !permitted.some(root => resolved.startsWith(root + path.sep))) fail('body outside canonical permitted roots');
  const handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== ref.bytes || stat.size > MAX_BODY_BYTES) fail('body size changed');
    const bytes = await handle.readFile();
    if (bytes.length !== ref.bytes || digest(bytes) !== ref.sha256) fail('body digest changed');
    return bytes;
  } finally { await handle.close(); }
}
