// One record transaction admits a claim or reserves a durable effect intent.
// Lock order: operation/lane lock -> record lock -> queue lock. Transfer only
// takes the record lock and reads atomic receipts; it never takes consumer locks.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fold } from './state.mjs';
import { findOrgDir, loadEvents, transact, withLock, writer, UserError } from './store.mjs';
import { gitProject } from './project.mjs';
import { checkFleetRecord } from './fleet.mjs';
import { bundleRelease, continueRelease, projectEnvironment } from './releases.mjs';
import { readInbox } from '../supervisor/prompt-supervisor.mjs';

export const BRAIN_CONTROLLER = 'brain';
const fail = (code, message) => { throw Object.assign(new UserError(`${code}: ${message}`), { code }); };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const optional = file => { try { return json(file); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; } };
const files = dir => { try { return fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => path.join(dir, n)); } catch (e) { if (e.code !== 'ENOENT') throw e; return []; } };
const equalRelease = (a, b) => a === b || (!!a && !!b && ['id', 'commit', 'root'].every(k => a[k] === b[k]));
export const sameOwner = (a, b) => !!a && !!b && a.controller === b.controller && a.legacy === b.legacy && equalRelease(a.release, b.release);
export const ownerBinding = run => ({ owner: run.owner, generation: run.owner_generation });

function namespace(org, cwd = path.dirname(org)) {
  const fleet = checkFleetRecord(org);
  if (fleet) return { record: fs.realpathSync(org), project: fs.realpathSync(fleet.identity) };
  let project = null;
  for (const candidate of [path.dirname(org), cwd]) {
    try { project = gitProject(candidate, { env: projectEnvironment() }).identity; break; } catch { /* A standalone record has no project. */ }
  }
  return { record: fs.realpathSync(org), project };
}
export function admittedRelease(root = bundleRelease().root) {
  const bundle = bundleRelease(root);
  const commit = bundle.commit ?? execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: projectEnvironment() }).trim();
  return { root: bundle.root, id: bundle.id ?? 'source', commit };
}
export function brainOwner(controller = BRAIN_CONTROLLER) {
  return { controller, release: admittedRelease(), legacy: false };
}
function validateOwner(owner) {
  if (!owner || typeof owner.controller !== 'string' || !/^[\w][\w.:-]*$/.test(owner.controller) || typeof owner.legacy !== 'boolean' ||
      (!owner.release && !owner.legacy) || (owner.release && (!path.isAbsolute(owner.release.root ?? '') ||
        typeof owner.release.id !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(owner.release.commit ?? ''))))
    fail('RUN_CLAIM_INVALID', 'expected controller, legacy and exact release root/id/commit (or null for legacy)');
  return { controller: owner.controller, release: owner.release ? Object.fromEntries(['id', 'commit', 'root'].map(k => [k, owner.release[k]])) : null, legacy: owner.legacy };
}
export function readOwnedRun(org, id, events) {
  const loaded = events ? { events } : loadEvents(org);
  if (loaded.tornTail) fail('RUN_CLAIM_INVALID', 'incomplete record event');
  const run = fold(loaded.events).runs.get(id);
  if (!run) fail('RUN_CLAIM_INVALID', `unknown run ${id}`);
  if (run.owner) {
    const event = loaded.events.find(e => e.seq === run.owner_generation);
    if (event.record !== fs.realpathSync(org)) fail('RUN_CLAIM_INVALID', 'claim record identity changed');
    if (event.project) {
      // A completed promotion may already have removed its lane checkout.
      // The canonical common-directory binding survives that removal.
      const fleet = checkFleetRecord(org);
      if (fleet && fs.realpathSync(fleet.identity) !== event.project) fail('RUN_CLAIM_INVALID', 'claim fleet project identity changed');
      const candidates = [fleet?.checkout, path.dirname(org), run.workspace, path.dirname(event.project)].filter(Boolean);
      let matched = false;
      for (const cwd of candidates) {
        try { if (gitProject(cwd, { env: projectEnvironment() }).identity === event.project) { matched = true; break; } }
        catch { /* A removed lane or separate metadata directory is not a checkout. */ }
      }
      if (!matched) fail('RUN_CLAIM_INVALID', 'claim canonical project identity changed or is unavailable');
    } else if (namespace(org, run.workspace ?? path.dirname(org)).project !== null) {
      fail('RUN_CLAIM_INVALID', 'standalone claim acquired a different project identity');
    }
    validateOwner(run.owner);
  }
  return run;
}
export function assertOwner(run, expected) {
  if (!run.owner) fail('RUN_OWNER_UNCLAIMED', `${run.id} has no exclusive owner; inventory legacy work and use record claim explicitly`);
  if (!sameOwner(run.owner, expected?.owner) || run.owner_generation !== expected?.generation)
    fail('RUN_OWNED_ELSEWHERE', `${run.id} owner=${JSON.stringify(run.owner)} generation=${run.owner_generation}`);
  return run;
}
export function requireController(run, controller = BRAIN_CONTROLLER) {
  if (!run.owner) return assertOwner(run);
  if (run.owner.controller !== controller || run.owner.legacy)
    fail('RUN_OWNED_ELSEWHERE', `${run.id} owner=${JSON.stringify(run.owner)} generation=${run.owner_generation}`);
  return ownerBinding(run);
}
export function continueOwnerRelease(relative, binding) {
  const release = binding.owner.release;
  try {
    const actual = admittedRelease(release.root);
    if (!equalRelease(actual, release) || !fs.statSync(path.join(release.root, relative)).isFile()) throw Error('bound release identity changed');
    // Source checkouts have a Git commit binding; deployed bundles have the
    // existing immutable operation protocol. Both are verified before entry.
    return continueRelease(relative, bundleRelease(release.root));
  } catch (e) { fail('RUN_OWNER_RELEASE_UNAVAILABLE', `${JSON.stringify(release)}: ${e.message}`); }
}
export function fenceOwner(org, id, expected, reserve) {
  return withLock(org, () => reserve(assertOwner(readOwnedRun(org, id), expected)));
}

// Any uncertainty remains a hold. No age or dead PID turns an intent into a
// completed effect. Existing recovery paths finish their original binding.
function claimedNamespace(org, run, events = loadEvents(org).events) {
  return run.owner ? { record: fs.realpathSync(org), project: events.find(e => e.seq === run.owner_generation).project }
    : namespace(org, run.workspace ?? path.dirname(org));
}
export function outstandingEffects(org, run, project = claimedNamespace(org, run).project) {
  const effects = [];
  if (!run.report && !run.abandoned && (run.meta?.terminal_id || run.meta?.agent_session_id)) effects.push('worker:pending-callback');
  const settle = optional(path.join(org, 'settle', `${run.id}.json`));
  if (settle && (settle.ownerActive || settle.stage !== 'complete')) effects.push(`settle:${settle.stage}`);
  for (const file of files(path.join(org, 'dispatch'))) {
    if (file.endsWith('.routes.json')) continue;
    const d = json(file);
    if (d.run !== run.id && d.fromRun !== run.id) continue;
    const child = d.run ? readOwnedRun(org, d.run) : null;
    if (d.stage !== 'complete' || (child && !child.report && !child.abandoned)) effects.push(`dispatch:${d.stage}/pending-callback`);
  }
  const watch = optional(path.join(org, 'watch', `${run.id}.json`));
  if (watch?.intent && (watch.intent !== 'delivery' || !watch.deliveries?.length ||
      watch.deliveries.some(id => !['sent', 'handled'].includes(readInbox(watch.inbox).find(e => e.id === id)?.state)))) effects.push(`watch:${watch.intent}`);
  if (watch?.inbox) {
    for (const entry of readInbox(watch.inbox)) if (watch.deliveries?.includes(entry.id) && !['sent', 'handled'].includes(entry.state)) effects.push(`delivery:${entry.state}`);
  }
  // Also inspect the canonical inbox for legacy callbacks without a watch receipt.
  const inbox = path.join(org, 'supervisor/inbox.log');
  if (fs.existsSync(inbox)) for (const entry of readInbox(inbox)) {
    if (new RegExp(`(?:^|[ =])${run.id}(?:[ \\n]|$)`).test(entry.message ?? '') && !['sent', 'handled'].includes(entry.state)) effects.push(`callback:${entry.state}`);
  }
  if (project) {
    const dir = path.join(org, 'supervisor', createHash('sha256').update(project).digest('hex').slice(0, 20));
    const promotion = optional(path.join(dir, `${run.id}.json`));
    if (promotion?.ownerActive || promotion?.phase === 'enqueuing') effects.push('promotion:enqueuing');
    const queue = optional(path.join(project, 'promote/queue.json'));
    if (queue) {
      if (queue.identity !== project || !Array.isArray(queue.pending) || !Array.isArray(queue.results)) throw Error('invalid promotion queue');
      const bound = j => j?.run === run.id && typeof j.org === 'string' && fs.realpathSync(j.org) === fs.realpathSync(org);
      const members = b => b?.jobs ?? (b ? [b] : []);
      for (const j of [...queue.pending, ...members(queue.current), ...(queue.interrupted ?? []).flatMap(members)]) if (bound(j)) effects.push('promotion:queued/current/interrupted');
      for (const j of queue.results) if (bound(j) && (!['refused', 'timeout', 'promoted'].includes(j.outcome) ||
          (j.outcome === 'promoted' && j.reconciliation?.state !== 'complete' && !fold(loadEvents(org).events).items.get(run.item)?.closed) ||
          j.reconciliation?.state === 'pending' || j.cleanup?.state === 'pending' || j.queued === true || j.delivered === false)) effects.push('promotion:unreconciled/pending-callback');
    }
  }
  return effects;
}
export function claimRun({ org, run: id, owner, expected, from, why, predecessor, admission = false }) {
  owner = validateOwner(owner);
  const who = writer();
  return transact(org, events => {
    const run = readOwnedRun(org, id, events), ns = claimedNamespace(org, run, events);
    if (predecessor) {
      const previous = readOwnedRun(org, predecessor.run, events);
      assertOwner(previous, predecessor.binding);
      if (!sameOwner(owner, previous.owner) || previous.item !== run.item) fail('RUN_CLAIM_INVALID', 'continuation must inherit its predecessor owner');
    }
    if (from !== undefined) {
      if (!run.owner || from !== run.owner.controller || !expected || !sameOwner(expected.owner, run.owner) || expected.generation !== run.owner_generation || !why?.trim())
        fail('RUN_CLAIM_TRANSFER_REFUSED', `${id} requires the complete current owner and generation; owner=${JSON.stringify(run.owner)} generation=${run.owner_generation}`);
      if (sameOwner(run.owner, owner)) return { add: [], result: { already: true, ...ownerBinding(run) } };
      let effects;
      try { effects = outstandingEffects(org, run, ns.project); }
      catch (e) { fail('RUN_CLAIM_TRANSFER_REFUSED', `cannot prove effects drained: ${e.message}`); }
      if (effects.length) fail('RUN_CLAIM_TRANSFER_REFUSED', `outstanding ${effects.join(', ')}`);
    } else if (run.owner) {
      if (!sameOwner(run.owner, owner)) fail('RUN_OWNED_ELSEWHERE', `${id} owner=${JSON.stringify(run.owner)} generation=${run.owner_generation}`);
      return { add: [], result: { already: true, ...ownerBinding(run) } };
    } else if (!owner.legacy && !admission && outstandingEffects(org, run, ns.project).length) {
      fail('RUN_CLAIM_TRANSFER_REFUSED', 'unclaimed work has outstanding legacy effects; inventory with --legacy and drain first');
    }
    const event = { type: 'run.claimed', run: id, ...ns, owner,
      ...(from !== undefined ? { previous: ownerBinding(run), why: why.trim() } : {}) };
    return { add: [event], result: { already: false, owner, generation: (events.at(-1)?.seq ?? 0) + 1 } };
  }, who).result;
}
export function claimCommand(argv) {
  const { values: opt, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    controller: { type: 'string' }, legacy: { type: 'boolean' }, 'release-root': { type: 'string' },
    'transfer-from': { type: 'string' }, why: { type: 'string' }, 'expected-owner': { type: 'string' }, 'expected-generation': { type: 'string' },
  } });
  if (positionals.length !== 1 || !/^R-\d+$/.test(positionals[0]) || !opt.controller ||
      (opt['transfer-from'] === undefined && [opt.why, opt['expected-owner'], opt['expected-generation']].some(v => v !== undefined)))
    throw new UserError('usage: record claim R-n --controller NAME [--legacy] [--release-root DIR] [--transfer-from NAME --expected-owner JSON --expected-generation N --why TEXT]');
  const org = findOrgDir();
  if (!org) throw new UserError('no record found');
  const result = claimRun({ org, run: positionals[0], owner: { controller: opt.controller, legacy: !!opt.legacy,
    release: opt['release-root'] || !opt.legacy ? admittedRelease(opt['release-root']) : null }, from: opt['transfer-from'], why: opt.why,
    expected: opt['expected-owner'] ? { owner: JSON.parse(opt['expected-owner']), generation: Number(opt['expected-generation']) } : undefined });
  process.stdout.write(JSON.stringify({ run: positionals[0], ...result }) + '\n');
  return 0;
}
