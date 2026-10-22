// One record transaction admits a claim or reserves a durable effect intent.
// Lock order: operation/lane lock -> record lock -> queue lock. Transfer only
// takes the record lock and reads atomic receipts; it never takes consumer locks.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fold } from './state.mjs';
import { findOrgDir, loadEvents, transact, withLock, writer, UserError } from './store.mjs';
import { gitProject } from './project.mjs';
import { bundleRelease, continueRelease, operationFile, projectEnvironment } from './releases.mjs';
import { readInbox } from '../supervisor/prompt-supervisor.mjs';
import { promotionCloseoutOutcome } from './closeout-results.mjs';
import { BRAIN_CONTROLLER, equalRelease, sameOwner, ownerBinding, ownerNamespace as namespace, validateOwner, readOwnedRun, assertOwner } from './run-owner-guard.mjs';
export { BRAIN_CONTROLLER, sameOwner, ownerBinding, readOwnedRun, assertOwner, requireController, adoptedPromotionBinding, guardPromotionJob } from './run-owner-guard.mjs';

const fail = (code, message) => { throw Object.assign(new UserError(`${code}: ${message}`), { code }); };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const optional = file => { try { return json(file); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; } };
const files = dir => { try { return fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => path.join(dir, n)); } catch (e) { if (e.code !== 'ENOENT') throw e; return []; } };
export function admittedRelease(root = bundleRelease().root) {
  const bundle = bundleRelease(root);
  if (bundle.commit) return { root: bundle.root, id: bundle.id, commit: bundle.commit };
  return { root: bundle.root, id: 'source', commit: null,
    identity: gitProject(bundle.root, { env: projectEnvironment() }).identity };
}
export function brainOwner(controller = BRAIN_CONTROLLER) {
  return { controller, release: admittedRelease(), legacy: false };
}
export function continueOwnerRelease(relative, binding) {
  const release = binding.owner.release;
  try {
    const actual = admittedRelease(release.root);
    if (!equalRelease(actual, release) || !fs.statSync(path.join(release.root, relative)).isFile()) throw Error('bound release identity changed');
    // Source roots retain their canonical common-directory identity as HEAD
    // advances; installed bundles retain their exact immutable commit binding.
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
          j.reconciliation?.state === 'pending' ||
          (j.cleanup?.state === 'pending' && !promotionCloseoutOutcome(j, project)?.complete) ||
          j.queued === true || j.delivered === false)) effects.push('promotion:unreconciled/pending-callback');
    }
  }
  return effects;
}
// Explicit upgrade admission, never inferred from a report or a legacy run.
// Only known Brain operation receipts can prove the old runtime binding.
function operationReceipts(org, run, project) {
  const paths = [path.join(org, 'watch', `${run.id}.json`), path.join(org, 'settle', `${run.id}.json`)];
  if (project) paths.push(path.join(org, 'supervisor', createHash('sha256').update(project).digest('hex').slice(0, 20), `${run.id}.json`));
  return [...paths.filter(file => fs.existsSync(file)), ...files(path.join(org, 'dispatch')).filter(file => {
    if (file.endsWith('.routes.json')) return false;
    const saved = json(file); return saved.run === run.id || saved.fromRun === run.id;
  })];
}
const queueMembers = q => [...(q.pending ?? []), ...(q.current?.jobs ?? (q.current ? [q.current] : [])),
  ...(q.interrupted ?? []).flatMap(b => b.jobs ?? [b]), ...(q.results ?? [])];
function brainReceipt(org, run, project, file) {
  const canonical = fs.realpathSync(file), saved = json(canonical);
  const settle = path.join(org, 'settle', `${run.id}.json`);
  const promotion = project && path.join(org, 'supervisor', createHash('sha256').update(project).digest('hex').slice(0, 20), `${run.id}.json`);
  const dispatch = path.dirname(canonical) === path.join(org, 'dispatch') && !canonical.endsWith('.routes.json');
  if (saved.run !== run.id || saved.org !== org || saved.ownership ||
      !(canonical === settle && saved.common === project || canonical === promotion && saved.identity === project || dispatch && saved.repo && gitProject(saved.repo, { env: projectEnvironment() }).identity === project))
    fail('RUN_CLAIM_INVALID', 'adoption requires this run\'s unclaimed Brain settle, dispatch or supervisor receipt');
  if (!saved.release) fail('RUN_CLAIM_INVALID', 'Brain receipt must name its saved release');
  operationFile(canonical === settle ? 'settle/settle.mjs' : canonical === promotion ? 'supervisor/supervisor.mjs' : 'dispatch/dispatch.mjs', saved.release);
  // Adoption cannot mix runtimes or overwrite an earlier claim's receipts.
  for (const other of operationReceipts(org, run, project)) {
    const receipt = json(other);
    if (receipt.ownership || !equalRelease(receipt.release, saved.release) || receipt.release?.protocol !== saved.release.protocol)
      fail('RUN_CLAIM_TRANSFER_REFUSED', `conflicting or unbound operation receipt: ${other}`);
  }
  const queue = project && optional(path.join(project, 'promote/queue.json'));
  if (queue) {
    if (queue.identity !== project || !Array.isArray(queue.pending) || !Array.isArray(queue.results)) fail('RUN_CLAIM_INVALID', 'invalid promotion queue');
    for (const job of queueMembers(queue).filter(j => j.run === run.id && j.org && fs.realpathSync(j.org) === org)) {
      if (job.ownership || !equalRelease(job.release, saved.release) || job.release?.protocol !== saved.release.protocol)
        fail('RUN_CLAIM_TRANSFER_REFUSED', 'queued job does not match the unclaimed Brain receipt release');
    }
  }
  return { receipt: canonical, release: saved.release };
}
export function claimRun({ org, run: id, owner, expected, from, why, predecessor, admission = false, admitWorker = false, adoptReceipt }) {
  owner = validateOwner(owner);
  if ((admitWorker || adoptReceipt) && (owner.legacy || owner.controller !== BRAIN_CONTROLLER || from !== undefined || admission || predecessor) || admitWorker && adoptReceipt)
    fail('RUN_CLAIM_INVALID', 'upgrade admission is only an explicit initial Brain claim');
  const who = writer();
  return transact(org, events => {
    const run = readOwnedRun(org, id, events), ns = claimedNamespace(org, run, events);
    let adoption;
    if (adoptReceipt && !run.owner) {
      adoption = brainReceipt(ns.record, run, ns.project, adoptReceipt);
      if (owner.legacy || owner.controller !== BRAIN_CONTROLLER || !equalRelease(owner.release, admittedRelease(adoption.release.root)))
        fail('RUN_CLAIM_INVALID', 'adoption must claim Brain at the receipt\'s saved release');
    }
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
    } else if (!owner.legacy && !admission && !adoption) {
      const effects = outstandingEffects(org, run, ns.project);
      if (admitWorker) {
        const queue = ns.project && optional(path.join(ns.project, 'promote/queue.json'));
        const hasReceipt = operationReceipts(org, run, ns.project).length || queue && queueMembers(queue).some(j => j.run === id && j.org && fs.realpathSync(j.org) === ns.record);
        if (hasReceipt || effects.some(e => e !== 'worker:pending-callback')) fail('RUN_CLAIM_TRANSFER_REFUSED', '--admit-worker requires only this run\'s own worker and no operation receipts or callbacks');
      } else if (effects.length) fail('RUN_CLAIM_TRANSFER_REFUSED', 'unclaimed work has outstanding legacy effects; inventory with --legacy and drain first');
    }
    const event = { type: 'run.claimed', run: id, ...ns, owner,
      ...(adoption ? { adoption } : {}),
      ...(from !== undefined ? { previous: ownerBinding(run), why: why.trim() } : {}) };
    return { add: [event], result: { already: false, owner, generation: (events.at(-1)?.seq ?? 0) + 1 } };
  }, who).result;
}
export function claimCommand(argv) {
  const { values: opt, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    controller: { type: 'string' }, legacy: { type: 'boolean' }, 'release-root': { type: 'string' },
    'transfer-from': { type: 'string' }, why: { type: 'string' }, 'expected-owner': { type: 'string' }, 'expected-generation': { type: 'string' },
    'admit-worker': { type: 'boolean' }, 'adopt-brain-receipt': { type: 'string' },
  } });
  if (positionals.length !== 1 || !/^R-\d+$/.test(positionals[0]) || !opt.controller ||
      (opt['transfer-from'] === undefined && [opt.why, opt['expected-owner'], opt['expected-generation']].some(v => v !== undefined)))
    throw new UserError('usage: record claim R-n --controller NAME [--legacy] [--release-root DIR] [--admit-worker | --adopt-brain-receipt FILE] [--transfer-from NAME --expected-owner JSON --expected-generation N --why TEXT]');
  const org = findOrgDir();
  if (!org) throw new UserError('no record found');
  if ((opt['admit-worker'] || opt['adopt-brain-receipt']) && (opt.legacy || opt['transfer-from'] || opt.controller !== BRAIN_CONTROLLER) || opt['admit-worker'] && opt['adopt-brain-receipt'])
    throw new UserError('upgrade admission requires --controller brain, no transfer, and one admission option');
  let expectedOwner;
  if (opt['transfer-from'] !== undefined && opt['expected-owner'] === undefined) throw new UserError('--expected-owner requires a JSON object');
  if (opt['expected-owner'] !== undefined) {
    try { expectedOwner = JSON.parse(opt['expected-owner']); } catch { throw new UserError('--expected-owner requires a JSON object'); }
    if (!expectedOwner || typeof expectedOwner !== 'object' || Array.isArray(expectedOwner)) throw new UserError('--expected-owner requires a JSON object');
  }
  const generation = opt['expected-generation'];
  if ((generation !== undefined || opt['transfer-from'] !== undefined) && (!/^[1-9]\d*$/.test(generation ?? '') || !Number.isSafeInteger(Number(generation)))) throw new UserError('--expected-generation requires a positive integer');
  let releaseRoot = opt['release-root'];
  if (opt['adopt-brain-receipt']) {
    const saved = json(opt['adopt-brain-receipt']);
    if (releaseRoot && releaseRoot !== saved.release?.root) throw new UserError('--release-root differs from the saved Brain receipt');
    releaseRoot = saved.release?.root;
  }
  const result = claimRun({ org, run: positionals[0], owner: { controller: opt.controller, legacy: !!opt.legacy,
    release: releaseRoot || !opt.legacy ? admittedRelease(releaseRoot) : null }, from: opt['transfer-from'], why: opt.why,
    admitWorker: opt['admit-worker'], adoptReceipt: opt['adopt-brain-receipt'],
    expected: expectedOwner ? { owner: expectedOwner, generation: Number(generation) } : undefined });
  process.stdout.write(JSON.stringify({ run: positionals[0], ...result }) + '\n');
  return 0;
}
