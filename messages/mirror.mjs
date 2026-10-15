// Stage 7 observers. No Herdr calls, record writes or delivery receipts.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest, MAX_BODY_BYTES } from './schema.mjs';
import { noticeEvidence } from './classify.mjs';
import { ShadowJournal, privateDirectory } from './journal.mjs';

const execute = promisify(execFile);
const pending = new Set(), partitions = new Map();
const warned = new Set();
export function bestEffort(task, { onError = error => {
  // Local diagnostic only; never another notice, prompt or model wake.
  if (!warned.has(error.message)) { warned.add(error.message); console.error(`message shadow: ${error.message}`); }
} } = {}) {
  const promise = Promise.resolve().then(task).catch(error => { try { onError(error); } catch {} });
  pending.add(promise);
  void promise.finally(() => pending.delete(promise));
}
// Offline tests and explicit foreground callers only; delivery NEVER awaits it.
export async function flushShadow() { while (pending.size) await Promise.all([...pending]); }

async function commonDirectory(cwd) {
  const { stdout } = await execute('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 1000, maxBuffer: 8192 });
  return fs.realpath(stdout.trim());
}
export async function identityAt(commonDir, env = process.env) {
  if (env.BRAIN_IDENTITY) return env.BRAIN_IDENTITY;
  for (let directory = commonDir; ; directory = path.dirname(directory)) {
    try { if ((await fs.stat(path.join(directory, '.identity-root'))).isFile()) return path.basename(directory); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    if (directory === path.dirname(directory)) throw Error('shadow identity is unenrolled; set BRAIN_IDENTITY or use an identity-root checkout');
  }
}
const role = (identity, projectRef, name, key) => ({ identity, projectRef, role: { name, bindingRef: `legacy-shadow:${digest(key)}` } });

async function mirror({ id, at, sequence, message, to, source, cwd, project, evidence, kind = 'notice', target }, { env = process.env, root, identity, commonDir } = {}) {
  commonDir ??= project?.identity ?? await commonDirectory(cwd ?? process.cwd());
  commonDir = await fs.realpath(commonDir);
  identity ??= await identityAt(commonDir, env);
  root ??= env.BRAIN_SHADOW_ROOT || path.join(env.HOME || os.homedir(), '.local/state/herdr-brain/logs');
  const journal = new ShadowJournal({ identity, commonDir, root });
  // Serialize only shadow work in this process. Cross-process contention fails
  // immediately; the original transport neither waits nor retries for a mirror.
  const previous = partitions.get(journal.directory) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    const directory = await privateDirectory(journal.directory);
    const bytes = Buffer.from(message);
    if (bytes.length > MAX_BODY_BYTES) throw Error('shadow body exceeds 64 KiB; original delivery retained');
    const sha256 = digest(bytes), bodyDir = await privateDirectory(path.join(directory, 'bodies'));
    const bodyPath = path.join(bodyDir, `${sha256}.txt`);
    try {
      const file = await fs.open(bodyPath, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      const parent = await fs.open(bodyDir, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(bodyPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || digest(await fs.readFile(bodyPath)) !== sha256) throw Error('shadow body changed');
    const channel = evidence?.channel ?? noticeEvidence(message).channel;
    let recipient = role(identity, commonDir, 'project-supervisor', `${source}:${to}`), unresolved;
    if (target) {
      try { recipient = role(target.identity, await commonDirectory(target.cwd), 'identity-desk', `${target.identity}:${to}`); }
      catch { unresolved = 'recipient canonical project unavailable; legacy target preserved without guessing'; }
    }
    const refs = [];
    const run = /(?:^| )run=(R-\d+)(?: |$)/.exec(message)?.[1];
    const item = /(?:^| )item=([A-Z]+-\d+)(?: |$)/.exec(message)?.[1];
    if (project?.org && (run || item)) refs.push({ orgRef: project.org, ...(run ? { run } : {}), ...(item ? { item } : {}) });
    const event = { schema: 'brain.log/v1', eventId: `legacy:${digest(source)}:${id}`,
      producer: { id: channel, epoch: `legacy-${digest(source)}`, sequence }, occurredAt: at,
      type: unresolved ? 'legacy.message.unresolved' : 'session.message.v1', level: 'info', identity, project: { commonDir },
      ...(refs.length ? { orgRef: project.org, ...(run ? { run } : {}), ...(item ? { item } : {}) } : {}),
      source: { kind: 'legacy-shadow', ref: source },
      payload: { from: role(identity, commonDir, channel, source), ...(unresolved ? {} : { to: [recipient] }), kind, refs,
        reply_to: null, priority: 'normal', reply_by: null,
        summary: [...message.replace(/[\s\p{Cc}]+/gu, ' ').trim()].slice(0, 240).join(''),
        body_ref: { path: bodyPath, sha256, bytes: bytes.length, mediaType: 'text/plain' }, decision_ref: null,
        evidence: evidence ?? noticeEvidence(message),
        legacy: { id, to, channel, provenance: 'unverified-legacy-binding', ...(unresolved ? { unresolved } : {}) } } };
    return journal.append(event);
  });
  partitions.set(journal.directory, work);
  try { return await work; } finally { if (partitions.get(journal.directory) === work) partitions.delete(journal.directory); }
}

export async function mirrorNotice(entry, options = {}) {
  return mirror({ ...entry, source: await fs.realpath(entry.inbox), cwd: entry.cwd }, options);
}
export function mirrorDesk(entry, options = {}) {
  return mirror({ ...entry, sequence: 1, source: `identity-request:${entry.id}`, kind: 'request',
    evidence: { channel: 'identity-desk', validated: true } }, options);
}
