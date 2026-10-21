// Config reads may append audit events. No native/controller effect is allowed.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadEvents, transact, initOrg, writer } from './store.mjs';
import { readPlainFile, writeFileAtomic } from './files.mjs';
import { parseUniqueJson } from '../sessions/json.mjs';
import { configHome, contentDigest, projectIdentity, assertConfigWriter, present, configGitEnv } from './config-home.mjs';
import { gitProject } from './project.mjs';
import { durableWrite } from './durable-json.mjs';

export const absentValue = Object.freeze({ unavailable: 'absent' });
export function assertNoSecrets(value, key = 'root') {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(entry) && /(?:token|secret|password|api_key|private_key|credential)/iu.test(entry.split('=')[0])) throw Error(`${key}: secret environment values must stay in native stores`);
      assertNoSecrets(entry, key);
    }
  } else if (value && typeof value === 'object') for (const [name, child] of Object.entries(value)) {
    if (/(?:token|secret|password|api_key|private_key|credential)/iu.test(name) && !/(?:_ref|_reference|profileRef)$/u.test(name)) throw Error(`${key}.${name}: secrets must stay in native stores`);
    assertNoSecrets(child, `${key}.${name}`);
  }
}
function auditTarget(file, { cwd = process.cwd(), env = process.env } = {}) {
  const relative = path.relative(configHome(env), file).split(path.sep);
  if (relative[0] === '..' || path.isAbsolute(relative[0])) return null;
  const identity = relative[0];
  if (relative.length === 2 && relative[1] === 'identity.json') {
    let git, detected;
    try { git = gitProject(cwd, { env: configGitEnv(env) }); detected = projectIdentity(git, env); } catch { return null; }
    let boundRoot;
    try { boundRoot = parseUniqueJson(readPlainFile(file)).identity_root; }
    catch {
      try { boundRoot = auditEvents(path.join(path.dirname(file), '.org')).findLast(e => e.type === 'config.changed' && e.file === file && typeof e.new_value?.identity_root === 'string')?.new_value.identity_root; } catch { /* Unavailable history cannot establish authority. */ }
    }
    if (detected.name !== identity || detected.root !== boundRoot) return { record: path.join(path.dirname(file), '.org'), scope: 'identity', identity, unauthorized: true };
    return { record: path.join(path.dirname(file), '.org'), scope: 'identity', identity, caller: git.identity };
  }
  if (relative.length !== 3 || !['lane.json', 'lane.validation.json', 'routing.json', 'promote.json', 'housekeeping.json', 'pin'].includes(relative[2])) return null;
  const p = parseUniqueJson(readPlainFile(path.join(path.dirname(file), 'project.json')));
  const defaults = parseUniqueJson(readPlainFile(path.join(path.dirname(path.dirname(file)), 'identity.json')));
  const target = { ...p, defaults };
  try { assertConfigWriter(target, { cwd, env }); }
  catch { return { record: p.record, scope: 'project', identity, unauthorized: true }; }
  return { record: p.record, scope: 'project', identity, caller: gitProject(cwd, { env: configGitEnv(env) }).identity };
}
export function auditEvents(record) {
  const { events, tornTail } = loadEvents(record);
  if (tornTail) throw Error(`${record}: incomplete config audit record; effects held`);
  return events;
}
export function recordConfigBaseline({ file, value, bytes, record, scope, operation, cwd, env = process.env, who }) {
  assertNoSecrets(value);
  const digest = contentDigest(bytes);
  auditEvents(record);
  return transact(record, events => {
    const prior = latest(events, file);
    if (prior) {
      if (prior.new_digest === digest && (prior.operation === operation || scope === 'identity')) return { add: [] };
      throw Error(`${file}: existing audit baseline differs from frozen adoption`);
    }
    return { add: [eventFor({ file, scope, operation, origin: 'adopt', who, caller: gitProject(cwd, { env: configGitEnv(env) }).identity,
      old: value, next: value, oldDigest: digest, newDigest: digest })] };
  }, { actor: writer(env).actor });
}
export function publishConfigBaseline({ file, value, bytes, record, scope, operation, cwd, env = process.env, who }) {
  assertNoSecrets(value); auditEvents(record);
  const hash = contentDigest(bytes), actor = writer(env).actor;
  const { result: intent } = transact(record, events => {
    const prior = latest(events, file);
    if (prior && prior.new_digest === hash && (prior.operation === operation || scope === 'identity')) return { add: [], result: null };
    if (prior) throw Error(`${file}: adoption conflicts with an audited revision`);
    const pending = unresolved(events, file);
    if (pending.length && (pending.length !== 1 || pending[0].operation !== operation || pending[0].new_digest !== hash)) throw Error(`${file}: conflicting config intent; effects held`);
    const entry = pending[0] ?? { type: 'config.change-intent', operation, file, scope, origin: 'adopt', old_value: value, new_value: value,
      old_digest: hash, new_digest: hash, caller: gitProject(cwd, { env: configGitEnv(env) }).identity, who_asked: who };
    return { add: pending.length ? [] : [entry], result: { ...entry, by: pending[0]?.by ?? actor } };
  }, { actor });
  if (present(file)) { if (contentDigest(readPlainFile(file, null)) !== hash) throw Error(`${file}: published adoption bytes differ`); }
  else {
    writeFileAtomic(file, bytes, 0o600);
    for (const target of [file, path.dirname(file)]) { const fd = fs.openSync(target, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  }
  if (intent) transact(record, events => ({ add: events.some(e => e.type === 'config.changed' && e.operation === operation) ? [] : [eventFor({ file, scope, operation,
    origin: 'adopt', who: intent.who_asked, caller: intent.caller, old: value, next: value, oldDigest: hash, newDigest: hash })] }), { actor: intent.by });
}
function latest(events, file) { return events.findLast(e => e.type === 'config.changed' && e.file === file); }
function unresolved(events, file) {
  return events.filter(e => e.type === 'config.change-intent' && e.file === file && !events.some(c => c.type === 'config.changed' && c.operation === e.operation));
}
export function pendingConfigWrite(record, file) { return unresolved(auditEvents(record), file); }
function changes(old, next, prefix = '') {
  const obj = v => v && typeof v === 'object' && !Array.isArray(v) && !v.unavailable;
  if (obj(old) && obj(next)) return [...new Set([...Object.keys(old), ...Object.keys(next)])].flatMap(k => changes(Object.hasOwn(old, k) ? old[k] : absentValue, Object.hasOwn(next, k) ? next[k] : absentValue, prefix ? `${prefix}.${k}` : k));
  return JSON.stringify(old) === JSON.stringify(next) ? [] : [{ key: prefix || '$', old_value: old === undefined ? absentValue : old, new_value: next === undefined ? absentValue : next }];
}
function eventFor({ file, scope, operation, origin, who, caller, old, next, oldDigest, newDigest, error }) {
  return { type: 'config.changed', file, scope, key: '$', operation, origin, who_asked: who, caller,
    old_value: old, new_value: next, changes: changes(old, next), old_digest: oldDigest, new_digest: newDigest,
    ...(error ? { validation_error: error } : {}) };
}
export function auditPolicyRead(file, value, bytes, error, options = {}) {
  const target = auditTarget(file, options);
  if (!target) return { audited: false };
  const digest = bytes === undefined ? null : contentDigest(bytes);
  const events = auditEvents(target.record), prior = latest(events, file), pending = unresolved(events, file);
  if (pending.length > 1) throw Error(`${file}: multiple unresolved config writes; effects held`);
  if (pending.length) {
    const intent = pending[0];
    if (target.unauthorized || digest !== intent.new_digest || error) throw Error(`${file}: config write ${intent.operation} is unresolved; retry the original command; effects held`);
    const result = transact(target.record, current => ({ add: unresolved(current, file).some(e => e.operation === intent.operation) ? [eventFor({ file, scope: target.scope,
      operation: intent.operation, origin: intent.origin ?? 'command', who: intent.who_asked, caller: intent.caller,
      old: intent.old_value, next: intent.new_value, oldDigest: intent.old_digest, newDigest: digest })] : [] }), { actor: intent.by });
    return { audited: true, recovered: result.added.length > 0 };
  }
  if (prior && prior.new_digest === digest && Boolean(prior.validation_error) === Boolean(error)) return { audited: true };
  if (target.unauthorized) throw Error(`${file}: unaudited revision; owning record authority required before effects`);
  // Never put malformed bytes or secret-bearing parsed data in history.
  let next = error ? { unavailable: bytes === undefined ? 'unavailable' : 'invalid' } : value;
  try { if (!error) assertNoSecrets(next); } catch (e) { error = e.message; next = { unavailable: 'invalid' }; }
  const env = options.env ?? process.env, actor = writer(env).actor;
  transact(target.record, current => {
    const previous = latest(current, file);
    if (previous?.new_digest === digest && Boolean(previous.validation_error) === Boolean(error)) return { add: [] };
    return { add: [eventFor({ file, scope: target.scope, operation: randomUUID(), origin: 'hand-edit', who: 'unknown (hand edit)', caller: target.caller,
      old: previous?.new_value ?? absentValue, next, oldDigest: previous?.new_digest ?? null, newDigest: digest, error })] };
  }, { actor });
  if (error && !options.invalid) throw Error(`${file}: ${error}; effects held`);
  return { audited: true };
}
export function writeAuditedConfig({ file, value, kind, binding, cwd = process.cwd(), env = process.env, scope = 'project', who, origin = 'command', validate, expectDigest, afterReplace, afterIntent }) {
  assertConfigWriter(binding, { cwd, env, scope });
  assertNoSecrets(value); validate(value);
  const record = scope === 'identity' ? path.join(path.dirname(binding.identityFile), '.org') : binding.record;
  if (scope === 'identity' && !present(path.join(record, 'events.jsonl'))) initOrg(record);
  const beforeBytes = present(file) ? readPlainFile(file) : null, oldDigest = beforeBytes === null ? null : contentDigest(beforeBytes);
  if (expectDigest !== undefined && expectDigest !== oldDigest) throw Error('config changed since inspection; refresh and review again');
  const content = JSON.stringify(value, null, 2) + '\n', newDigest = contentDigest(content);
  const events = auditEvents(record), pending = unresolved(events, file);
  if (pending.length > 1) throw Error('multiple unresolved config writes; effects held');
  let intent = pending[0];
  if (intent && (intent.new_digest !== newDigest || ![intent.old_digest, intent.new_digest].includes(oldDigest))) throw Error('unresolved config write has different bytes; retry its original command');
  let previousValue;
  try { previousValue = beforeBytes === null ? absentValue : parseUniqueJson(beforeBytes); assertNoSecrets(previousValue); }
  catch { previousValue = { unavailable: 'invalid' }; }
  if (!intent && JSON.stringify(previousValue) === JSON.stringify(value)) return { changed: false, file };
  const actor = writer(env).actor;
  if (!intent) {
    const old = previousValue;
    const result = transact(record, current => {
      if (unresolved(current, file).length) throw Error('config write in progress; effects held');
      return { add: [{ type: 'config.change-intent', operation: randomUUID(), file, scope, kind, origin, old_value: old, new_value: value,
        old_digest: oldDigest, new_digest: newDigest, caller: gitProject(cwd, { env: binding.adoption ? configGitEnv(env) : env }).identity,
        who_asked: who ?? { actor, run: env.ORG_RUN ?? null, item: env.ORG_ITEM ?? null } }] };
    }, { actor });
    intent = result.added[0];
    afterIntent?.();
  }
  if (oldDigest !== intent.new_digest) {
    // durableWrite preserves the same JSON bytes used to freeze the intent.
    durableWrite(file, value);
    afterReplace?.();
  }
  transact(record, current => ({ add: current.some(e => e.type === 'config.changed' && e.operation === intent.operation) ? [] :
    [eventFor({ file, scope, operation: intent.operation, origin: intent.origin, who: intent.who_asked, caller: intent.caller,
      old: intent.old_value, next: intent.new_value, oldDigest: intent.old_digest, newDigest: intent.new_digest })] }), { actor: intent.by });
  return { changed: true, file, operation: intent.operation };
}
