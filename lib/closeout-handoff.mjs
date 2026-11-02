import { OPERATOR_LANDING_WAIVER } from './validation-declaration.mjs';
// Explicit post-return completion tail. Record writers never call this module.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gitProject } from './project.mjs';
import { loadEvents, transact } from './store.mjs';
import { fold } from './state.mjs';
import { digest } from './completion.mjs';
import { readPlainFile, plainDirectory } from './files.mjs';
import { closeoutRecordMatches, closeoutPolicy, closeoutDirectory, queueTransaction, publishCloseoutEvents,
  readCloseoutEntries, closeoutBindingMatches, claimRetirementOwner, assertQueueOwnership, kickCloseout, sameFileIdentity, sameBranchLog, closeoutEvaluation, pruneCompletedCloseout, recordedCloseoutHandoff } from './closeout.mjs';
import { readLiveReferences } from './retire-runtime.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// Resolve the existing prefix even after a worktree has disappeared. This uses
// the same physical namespace for proofs and lane roots, including macOS's
// /tmp and /var aliases; readPlainFile still refuses agent-created redirects.
function physicalPath(file) {
  let prefix = path.resolve(file);
  const missing = [];
  for (;;) {
    try { return path.join(fs.realpathSync(prefix), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(prefix) === prefix) throw error;
      missing.unshift(path.basename(prefix)); prefix = path.dirname(prefix);
    }
  }
}
// Completion proof must survive every linked-worktree removal, including a
// different queued lane. Never publish authority backed by disposable bytes.
function assertCompletionLocations(project, source, files) {
  const lanes = new Set((source.closeout_targets ?? []).map(t => t.cwd));
  const canonical = physicalPath(project.canonical);
  for (const row of git(project.canonical, ['worktree', 'list', '--porcelain', '-z']).split('\0')) {
    const cwd = row.startsWith('worktree ') ? row.slice(9) : undefined;
    if (cwd && physicalPath(cwd) !== canonical) lanes.add(cwd);
  }
  const physicalLanes = [...lanes].map(physicalPath);
  for (const file of files) {
    const absolute = physicalPath(file);
    if (physicalLanes.some(lane => absolute === lane || absolute.startsWith(lane + path.sep)))
      throw Error('completion proof is inside a closing worktree; retain the original receipt and gate evidence outside linked worktrees before handoff; keep');
  }
}
// Atomic replacement with file and directory durability, also used by migration.
export function durableCloseoutFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.new-${randomUUID()}`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, Buffer.isBuffer(value) ? value : JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

function completionProof(project, org, receipt, events) {
  const bytes = readPlainFile(receipt, null), payload = JSON.parse(bytes);
  const source = events.find(e => e.type === 'promotion.reconciled' && e.identity === project.identity &&
    e.batch === payload.batch && e.fingerprint === digest(payload));
  if (payload.version !== 1 || payload.org !== org || payload.identity !== project.identity || !source ||
      (payload.gate?.exit_code !== 0 && !(payload.gate?.exit_code === null && payload.gate?.operator_waiver === OPERATOR_LANDING_WAIVER && payload.gate?.executed === false)) || source.base !== payload.base || source.tip !== payload.tip || digest(source.gate) !== digest(payload.gate) || digest(source.heads) !== digest(payload.items.map(({ item, run, head }) => ({ item, run, head }))))
    throw Error('completion tail lacks the exact successful reconciliation receipt; keep');
  if (sha(readPlainFile(payload.gate.log, null)) !== payload.gate.sha256) throw Error('completion gate evidence changed; keep');
  git(project.canonical, ['merge-base', '--is-ancestor', payload.tip, 'HEAD']);
  return { source, receipt: { file: receipt, sha256: sha(bytes), fingerprint: digest(payload) } };
}

export function verifyCloseoutHandoff(entry, events = loadEvents(entry.org).events) {
  if (entry.source.type !== 'promotion.reconciled') return;
  const e = events.find(e => e.seq === entry.handoff?.seq && e.type === 'closeout.handoff');
  if (!e || e.identity !== entry.common || e.org !== entry.org || e.project !== entry.project ||
      e.source.seq !== entry.source.seq || e.source.type !== entry.source.type || !e.keys.includes(entry.key) || e.digest !== entry.handoff.digest)
    throw Error('awaiting exact completion handoff; keep');
  const checkpoint = JSON.parse(readPlainFile(e.checkpoint));
  const source = events.find(s => s.seq === entry.source.seq && s.type === entry.source.type);
  if (digest(checkpoint) !== e.digest || checkpoint.schema !== 'closeout-completion/v1' || checkpoint.identity !== entry.common ||
      checkpoint.project !== entry.project || checkpoint.org !== entry.org || !checkpoint.keys.includes(entry.key) ||
      checkpoint.source.seq !== source?.seq || checkpoint.source.type !== source.type || checkpoint.source.fingerprint !== source.fingerprint ||
      checkpoint.source.digest !== digest(source) || sha(readPlainFile(checkpoint.receipt.file, null)) !== checkpoint.receipt.sha256 ||
      checkpoint.receipt.fingerprint !== source.fingerprint) throw Error('completion handoff evidence changed; keep');
  assertCompletionLocations({ identity: entry.common, canonical: entry.project }, source,
    [e.checkpoint, checkpoint.receipt.file, source.gate.log]);
  if (events.some(s => s.seq > entry.source.seq && s.type === 'item.reopened' && s.id === entry.item))
    throw Error('completion target reopened; original handoff supplies no fresh cleanup authority');
  return checkpoint;
}

// A native bookkeeping recovery can be covered by a separate manual completion.
// Resolve only that manual caller's already committed post-return tail. The
// source alone cannot supply completion authority, and this read never creates
// a new handoff or binds a replacement lane. The caller separately verifies the
// original native receipt's exact whole-batch recovery coverage.
export function completedCloseoutKeys({ cwd, org, expected, env = process.env } = {}) {
  const project = gitProject(cwd);
  if (!expected || expected.common !== project.identity || expected.project !== project.canonical ||
      fs.realpathSync(expected.org) !== fs.realpathSync(org) || !closeoutRecordMatches(project, org, env) ||
      !closeoutPolicy(project.canonical, 'promotion.reconciled', { requireServiceSource: false })) throw Error('completion outbox record/project binding changed; keep');
  org = fs.realpathSync(org);
  const loaded = loadEvents(org);
  if (loaded.tornTail) throw Error('incomplete completion handoff record');
  const source = loaded.events.find(e => e.seq === expected.source?.seq && e.type === 'promotion.reconciled' &&
    e.type === expected.source.type && e.identity === project.identity && e.fingerprint === expected.source.fingerprint);
  if (!source) throw Error('recovered completion source binding changed; keep');
  const targets = (source.closeout_targets ?? []).filter(t => t.common === project.identity && t.project === project.canonical && t.org === org &&
    t.item === expected.item && t.run === expected.run && t.branch === `lane/${expected.topic}` && t.head === expected.tip);
  if (targets.length !== 1) throw Error('recovered completion lacks one exact original target binding; keep');
  const target = targets[0];
  const entry = { ...target, source: expected.source };
  const outcome = loaded.events.findLast(e => e.type === 'closeout.evaluated' && e.identity === project.identity && e.key === target.key &&
    e.run === target.run && e.item === target.item && e.source?.seq === source.seq && e.source.type === source.type);
  const handoff = recordedCloseoutHandoff(entry, loaded.events, outcome?.completed ? outcome : undefined);
  if (!handoff) throw Error('awaiting exact completion handoff from the manual caller; keep');
  const checkpoint = verifyCloseoutHandoff({ ...target, source: expected.source,
    handoff: { seq: handoff.seq, digest: handoff.digest } }, loaded.events);
  const proof = completionProof(project, org, checkpoint.receipt.file, loaded.events);
  if (digest(proof.source) !== digest(source) || digest(proof.receipt) !== digest(checkpoint.receipt))
    throw Error('recovered completion receipt/source binding changed; keep');
  const state = fold(loaded.events), item = state.items.get(target.item), run = state.runs.get(target.run);
  if (!item?.closed || item.closed.as !== 'done' || item.runs.at(-1) !== target.run || !run?.report || run.abandoned)
    throw Error('completion target reopened or run changed; no new cleanup authority');
  return [target.key];
}

// Call only after finish/complete-batch has returned successfully, outside its
// locks. A recovered caller uses the same retained receipt and checkpoint.
export function handoffCloseout({ cwd, org, receipt, keys, expected, env = process.env, start = false } = {}) {
  const project = gitProject(cwd);
  if (!closeoutRecordMatches(project, org, env) || !closeoutPolicy(project.canonical, 'promotion.reconciled', { requireServiceSource: false })) return [];
  org = fs.realpathSync(org); receipt = path.resolve(receipt);
  const loaded = loadEvents(org);
  if (loaded.tornTail) throw Error('incomplete completion handoff record');
  const proof = completionProof(project, org, receipt, loaded.events), source = proof.source;
  assertCompletionLocations(project, source, [receipt, source.gate.log]);
  if (expected && (expected.common !== project.identity || expected.project !== project.canonical || fs.realpathSync(expected.org) !== org ||
      expected.source?.seq !== source.seq || expected.source?.fingerprint !== source.fingerprint || expected.receipt_sha256 !== proof.receipt.sha256))
    throw Error('completion outbox binding differs from the exact receipt/source; keep');
  const targets = (source.closeout_targets ?? []).filter(t => (!keys || keys.includes(t.key)) &&
    (!expected || (t.run === expected.run && t.branch === `lane/${expected.topic}` && t.head === expected.tip)));
  if (!targets.length) return [];
  const prior = loaded.events.find(e => e.type === 'closeout.handoff' && e.identity === project.identity && e.source.seq === source.seq &&
    targets.every(t => e.keys.includes(t.key)));
  const state = fold(loaded.events), refs = readLiveReferences({ common: project.identity, org, env });
  if (refs.errors.length) throw Error(refs.errors.join('; '));
  for (const t of targets) {
    const item = state.items.get(t.item), run = state.runs.get(t.run);
    if (!prior && (!item?.closed || item.closed.as !== 'done' || item.runs.at(-1) !== t.run || !run?.report || run.abandoned ||
        loaded.events.some(e => e.seq > source.seq && e.type === 'item.reopened' && e.id === t.item)))
      throw Error('completion target reopened or run changed; no new cleanup authority');
    if (refs.references.some(r => r.run === t.run || r.item === t.item || r.lane === t.branch.slice(5) ||
        r.cwd === t.cwd || r.cwd?.startsWith(t.cwd + path.sep))) throw Error('completion tail still has live integration/reconciliation/callback references; keep');
  }
  const checkpoint = path.join(closeoutDirectory(project.identity), 'completions',
    `${source.seq}-${proof.receipt.sha256}-${digest(targets.map(t => t.key).sort()).slice(0, 16)}.json`);
  assertCompletionLocations(project, source, [checkpoint]);
  plainDirectory(path.dirname(checkpoint));
  const tail = { schema: 'closeout-completion/v1', identity: project.identity, project: project.canonical, org,
    source: { seq: source.seq, type: source.type, fingerprint: source.fingerprint, digest: digest(source), batch: source.batch },
    receipt: proof.receipt, keys: targets.map(t => t.key).sort() };
  if (fs.existsSync(checkpoint) && digest(JSON.parse(readPlainFile(checkpoint))) !== digest(tail))
    throw Error('completion tail checkpoint differs; retain original evidence');
  if (!fs.existsSync(checkpoint)) durableCloseoutFile(checkpoint, tail);
  queueTransaction(project.identity, () => {
    const committed = transact(org, events => {
      const current = events.find(e => e.seq === source.seq);
      if (digest(current) !== digest(source)) throw Error('completion source changed before handoff');
      const same = events.find(e => e.type === 'closeout.handoff' && e.identity === project.identity && e.digest === digest(tail));
      return { add: same ? [] : [{ type: 'closeout.handoff', identity: project.identity, project: project.canonical, org,
        source: { seq: source.seq, type: source.type }, checkpoint, digest: digest(tail), keys: tail.keys }] };
    }, { actor: 'completion tail' });
    const e = committed.added[0] ?? loadEvents(org).events.find(e => e.type === 'closeout.handoff' && e.digest === digest(tail));
    for (const entry of readCloseoutEntries(project.identity).filter(e => tail.keys.includes(e.key))) {
      if (entry.schema !== 'closeout-entry/v2') continue; // Explicit migration owns v1.
      if (!closeoutBindingMatches(entry, source, loadEvents(org).events)) throw Error('handoff target differs from original binding');
      durableCloseoutFile(path.join(closeoutDirectory(project.identity), 'entries', `${entry.key}.json`), { ...entry, handoff: { seq: e.seq, digest: e.digest } });
    }
  });
  publishCloseoutEvents({ cwd, org, added: [source], env, start: false });
  if (start) kickCloseout(project, org, { env });
  return tail.keys;
}

// Named exact-key conversion only. A crash after the journal append resumes the
// same bytes; no topic lookup can bind a replacement worktree.
export function migrateCloseout({ cwd, org, key, receipt, env = process.env } = {}) {
  const project = gitProject(cwd);
  if (!closeoutRecordMatches(project, org, env) || !closeoutPolicy(project.canonical, undefined, { requireServiceSource: false })) return [];
  const release = claimRetirementOwner(project.identity);
  try {
    assertQueueOwnership(project, org);
    const entry = readCloseoutEntries(project.identity).find(e => e.key === key);
    if (!entry || entry.org !== fs.realpathSync(org) || entry.project !== project.canonical) throw Error('migration needs one original pending v1 key');
    const loaded = loadEvents(org), source = loaded.events.find(e => e.seq === entry.source.seq && e.type === entry.source.type);
    if (loaded.tornTail || !closeoutBindingMatches(entry, source, loaded.events)) throw Error('migration source binding is unproven; keep');
    if (closeoutEvaluation(entry, loaded.events)?.completed) {
      queueTransaction(project.identity, () => pruneCompletedCloseout(project.identity, org, [entry], loadEvents(org).events));
      return [];
    }
    if (entry.schema === 'closeout-entry/v2' && entry.migration) return [key]; // Resume the same completed conversion, never rebind it.
    if (entry.schema !== 'closeout-entry/v1') throw Error('migration needs one original pending v1 key');
    if (!sameBranchLog(entry.branchLog) ||
        !git(project.canonical, ['worktree', 'list', '--porcelain']).split('\n\n').some(row => row.split('\n').includes(`worktree ${entry.cwd}`) && row.split('\n').includes(`branch refs/heads/${entry.branch}`)))
      throw Error('migration branch generation or registration changed; keep');
    if (!sameFileIdentity(entry.cwd, entry.worktreeIdentity) || !sameFileIdentity(entry.gitDirectory, entry.gitIdentity) ||
        git(entry.cwd, ['rev-parse', 'HEAD']) !== entry.head || git(entry.cwd, ['symbolic-ref', '--short', 'HEAD']) !== entry.branch ||
        git(entry.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== project.identity ||
        git(entry.cwd, ['rev-parse', '--absolute-git-dir']) !== entry.gitDirectory || git(entry.cwd, ['status', '--porcelain']))
      throw Error('migration current target identity changed; keep');
    if (entry.source.type === 'promotion.reconciled') {
      if (!receipt) throw Error('v1 landing migration requires the original completion receipt');
      handoffCloseout({ cwd, org, receipt, keys: [key], env });
    }
    queueTransaction(project.identity, () => {
      const file = path.join(closeoutDirectory(project.identity), 'entries', `${key}.json`), bytes = readPlainFile(file, null);
      if (digest(JSON.parse(bytes)) !== digest(entry)) throw Error('migration envelope changed; keep both evidence and target');
      const backup = path.join(closeoutDirectory(project.identity), 'migrations', `${key}.v1.json`);
      if (fs.existsSync(backup) && sha(readPlainFile(backup, null)) !== sha(bytes)) throw Error('migration evidence conflict; keep');
      if (!fs.existsSync(backup)) durableCloseoutFile(backup, bytes);
      const oldDigest = sha(readPlainFile(backup, null));
      const r = transact(org, events => {
        const prior = events.find(e => e.type === 'closeout.migrated' && e.keys?.includes(key));
        if (prior && prior.digest !== oldDigest) throw Error('migration journal conflict; keep');
        return { add: prior ? [] : [{ type: 'closeout.migrated', identity: project.identity, keys: [key], source: entry.source, backup, digest: oldDigest }], result: prior };
      }, { actor: 'named closeout migration' });
      const migration = r.added[0] ?? r.result;
      const handoff = recordedCloseoutHandoff({ ...entry, handoff: undefined }, loadEvents(org).events);
      durableCloseoutFile(file, { ...entry, schema: 'closeout-entry/v2', migration: { seq: migration.seq, digest: oldDigest },
        ...(handoff ? { handoff: { seq: handoff.seq, digest: handoff.digest } } : {}) });
    });
    return [key];
  } finally { release(); }
}
