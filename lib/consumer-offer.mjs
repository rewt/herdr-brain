// A coordinator reconciliation of retained evidence, never a suite or activation.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readPlainFile } from './files.mjs';
import { findOrgDir, loadRecord } from './store.mjs';
import { readProjectPolicy } from './config-policy.mjs';
import { gitProject } from './project.mjs';
import { itemConditions, retainedCorrectionResolution } from './state.mjs';
import { canonical as canonicalJSON } from '../messages/schema.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const unrunSuite = { status: 'UNRUN', details: 'No full-suite run supplied; background information only.' };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commitHash = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const sourceGit = canonical => args => execFileSync('git', ['-C', canonical, ...args], { encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))) });
function references(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.some(row => !path.isAbsolute(row.file ?? '') || !hash(row.sha256)))
    throw Error('consumer offer needs retained evidence references');
}
// Shared by read-only packet preparation and the guarded publication path.
export function validateConsumerCanaryEvidence(rows, { commit, manifestSha256 }) {
  references(rows);
  for (const name of ['installed', 'probation', 'soak']) if (!rows.some(row => row.stage === name))
    throw Error(`consumer offer requires ${name} canary evidence`);
  const tuple = new Map();
  for (const row of rows) {
    if (fs.realpathSync(row.file) !== row.file) throw Error('consumer offer evidence changed or redirected');
    const bytes = readPlainFile(row.file);
    if (digest(bytes) !== row.sha256) throw Error('consumer offer evidence changed or redirected');
    const stage = JSON.parse(bytes), candidate = stage.candidate;
    const bindings = [stage.candidateCommit, candidate?.commit].filter(value => value !== undefined);
    if (stage.status !== 'PASS' || !bindings.length || bindings.some(value => value !== commit))
      throw Error('consumer offer canary evidence must pass for the exact candidate');
    if (manifestSha256 && candidate?.manifestSha256 !== undefined && candidate.manifestSha256 !== manifestSha256)
      throw Error('consumer offer canary candidate tuple mismatch');
    for (const key of ['root', 'commit', 'tree', 'manifestSha256', 'inventorySha256', 'node', 'protocol', 'configHome']) {
      if (candidate?.[key] === undefined) continue;
      const value = canonicalJSON(candidate[key]);
      if (tuple.has(key) && tuple.get(key) !== value) throw Error('consumer offer canary candidate tuple mismatch');
      tuple.set(key, value);
    }
    if (stage.schema === 'brain.probation-stage/v1') {
      const ref = stage.archive;
      references([ref]);
      if (row.stage !== 'probation' || fs.realpathSync(ref.file) !== ref.file)
        throw Error('consumer offer probation archive changed or redirected');
      const original = readPlainFile(ref.file);
      if (digest(original) !== ref.sha256) throw Error('consumer offer probation archive changed or redirected');
      const archive = JSON.parse(original), c = archive.scope?.candidate;
      if (archive.schema !== 'brain-probation/v1' || archive.id !== stage.trial || archive.authority !== stage.authority ||
          archive.project !== stage.project || archive.scope?.brain_common !== stage.project ||
          !candidate || c?.release?.commit !== commit || c.release.root !== candidate.root || c.tree !== candidate.tree ||
          c.manifest_sha256 !== candidate.manifestSha256 || canonicalJSON(c.node) !== canonicalJSON(candidate.node) ||
          !rows.some(r => r.stage === 'soak' && r.sha256 === stage.assessmentSha256))
        throw Error('consumer offer probation provenance or candidate tuple mismatch');
    }
  }
}
export function validateConsumerOffer(packet, release, manifestSha256) {
  if (packet.schema !== 'consumer-release-offer/v1' || packet.commit !== release.commit || packet.manifestSha256 !== manifestSha256)
    throw Error('consumer offer candidate binding mismatch');
  if (!nonempty(packet.coordinatorItem)) throw Error('consumer offer needs its coordinator item');
  if (packet.canary?.status !== 'PASS' || !nonempty(packet.canary.scope)) throw Error('consumer offer requires a canary PASS');
  references(packet.canary.evidence);
  for (const stage of ['installed', 'probation', 'soak']) if (!packet.canary.evidence.some(row => row.stage === stage))
    throw Error(`consumer offer requires ${stage} canary evidence`);
  if (packet.landing?.status !== 'PASS' || !nonempty(packet.landing.scope)) throw Error('consumer offer requires landing-test PASS evidence');
  references(packet.landing.evidence);
  if (!Array.isArray(packet.majors?.unresolved) || packet.majors.unresolved.length || !Array.isArray(packet.majors.corrections) || !nonempty(packet.majors.scope))
    throw Error('consumer offer has unresolved or unaccounted Majors');
  for (const fix of packet.majors.corrections) {
    if (!nonempty(fix.item) || !nonempty(fix.scope)) throw Error('consumer offer Major correction needs its item and scope');
    references(fix.evidence);
  }
  // Optional broad-suite observations never establish or veto qualification.
  if (packet.fullSuite !== undefined && (!['UNRUN', 'PASS', 'FAIL', 'UNKNOWN'].includes(packet.fullSuite.status) || !nonempty(packet.fullSuite.details)))
    throw Error('consumer offer full-suite information must state its actual status');
  const unsigned = { ...packet }; delete unsigned.attestationSeq; delete unsigned.attestationDigest;
  if (!Number.isSafeInteger(packet.attestationSeq) || packet.attestationDigest !== digest(JSON.stringify(unsigned)))
    throw Error('consumer offer disposition does not bind this packet');
  return packet;
}
function passingLanding(row, packet, canonical) {
  const receipt = JSON.parse(readPlainFile(row.file));
  if (receipt.schema !== 'lane-validation/v1' || receipt.executed !== true || receipt.exit_code !== 0 || receipt.signal || receipt.gate_timeout ||
      receipt.node_version !== 'v20.19.4' || !receipt.command || !receipt.started_at || !receipt.finished_at || !receipt.head)
    throw Error('consumer offer landing evidence is not a completed passing pinned-runtime check');
  // Rebased producer heads need not be ancestors. Compare the retained checked
  // tree directly with the candidate; the coordinator reconciles that exact delta.
  const git = sourceGit(canonical);
  for (const head of [receipt.head, packet.commit]) {
    if (!commitHash(head) || git(['cat-file', '-t', head]).trim() !== 'commit')
      throw Error('consumer offer landing source must be a canonical commit object');
  }
  const changed = git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', receipt.head, packet.commit, '--'])
    .split('\0').filter(Boolean).sort();
  if (JSON.stringify(changed) !== JSON.stringify(row.changedFiles) || !nonempty(row.reconciliation))
    throw Error('consumer offer landing scope reconciliation is stale or missing');
  return receipt;
}
export function requireCorrectedMajors(state, packet, canonical) {
  const git = sourceGit(canonical), identity = gitProject(canonical).identity;
  const contained = head => {
    if (!commitHash(head)) return false;
    try { return git(['merge-base', head, packet.commit]).trim() === head; }
    catch (error) { if (error.status === 1) return false; throw error; }
  };
  for (const item of state.items.values()) for (const binding of item.finding_bindings ?? []) {
    if (binding.finding?.severity !== 'major') continue;
    const source = state.runs.get(item.meta.review_source_run);
    const project = source?.meta.dispatch_project ?? source?.landings?.at(-1)?.project;
    if (project && project !== identity || !contained(binding.head)) continue;
    const run = state.runs.get(item.runs.at(-1));
    const unresolved = () => Error(`consumer offer has unresolved or unaccounted recorded Major: ${item.id} ${binding.finding_key}`);
    // An immutable blocked report never gains a same-run landing. Only the fold's
    // verified receipt stands in for it, and this commit must hold its source and proof.
    const retained = retainedCorrectionResolution(state, item, run);
    if (retained) {
      const proofs = retained.findings.filter(f => f.key === binding.finding_key && f.finding_seq === binding.seq);
      if (!proofs.length || run.abandoned || run.owner_generation == null || retained.retained_landing.project !== identity ||
          itemConditions(state, item.id).Accepted.status !== 'True' || !contained(retained.retained_landing.head) ||
          proofs.some(f => !contained(f.head)) || !packet.majors.corrections.some(fix => fix.item === item.id))
        throw unresolved();
      continue;
    }
    const discharge = run?.discharges?.findLast(d => !d.resolution_kind && d.report_sha256 === run.report?.sha256 &&
      d.claim_generation === run.owner_generation && d.review_key === `${binding.source_item}:${binding.head}`);
    const proof = discharge?.findings.find(f => f.key === binding.finding_key && f.finding_seq === binding.seq);
    const landing = run?.landings?.at(-1);
    if (!proof || run.report?.outcome !== 'done' || run.abandoned || run.owner_generation == null ||
        landing?.head !== proof.head || landing.project !== identity || landing.producer?.ownership_generation !== run.owner_generation ||
        !contained(proof.head) || !packet.majors.corrections.some(fix => fix.item === item.id))
      throw unresolved();
  }
}
export function publishConsumerOffer({ release, home, canonical, file, env = process.env }) {
  const bytes = readPlainFile(file), packet = JSON.parse(bytes);
  const manifestSha256 = digest(readPlainFile(path.join(release.root, '.release-manifest.json')));
  validateConsumerOffer(packet, release, manifestSha256);
  for (const row of [...packet.landing.evidence, ...packet.majors.corrections.flatMap(fix => fix.evidence)]) {
    if (fs.realpathSync(row.file) !== row.file || digest(readPlainFile(row.file)) !== row.sha256) throw Error('consumer offer evidence changed or redirected');
  }
  validateConsumerCanaryEvidence(packet.canary.evidence, packet);
  for (const row of [...packet.landing.evidence, ...packet.majors.corrections.flatMap(fix => fix.evidence)]) passingLanding(row, packet, canonical);
  const org = findOrgDir({ cwd: canonical, env: { ...env, ORG_DIR: undefined } });
  if (!org) throw Error('consumer offer needs its owning record');
  const { events, state, tornTail } = loadRecord(org);
  if (tornTail) throw Error('consumer offer record has an incomplete event');
  const note = events.find(row => row.seq === packet.attestationSeq);
  const coordinator = readProjectPolicy(canonical, 'promote', env).config.to ?? 'supervisor-herdr';
  if (note?.type !== 'note.added' || note.decision !== true || note.by !== coordinator ||
      note.id !== packet.coordinatorItem || !state.items.has(packet.coordinatorItem) ||
      note.text !== `Consumer release offer reconciled: ${packet.attestationDigest}`)
    throw Error('consumer offer has no exact recorded coordinator disposition');
  requireCorrectedMajors(state, packet, canonical);
  const directory = path.resolve(home, 'offers'); fs.mkdirSync(directory, { recursive: true });
  if (fs.realpathSync(directory) !== directory) throw Error('consumer offer directory is redirected');
  const destination = path.join(directory, `${release.id}.json`), temporary = `${destination}.${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ schema: 'consumer-release-offer-record/v1', release: release.id, commit: release.commit,
      manifestSha256, packet, packetBase64: Buffer.from(bytes).toString('base64'), packetSha256: digest(bytes),
      fullSuite: packet.fullSuite ?? unrunSuite,
      coordinator, disposition: note }, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
    try { fs.linkSync(temporary, destination); }
    catch (error) { if (error.code === 'EEXIST') throw Error('consumer offer already exists; inspect the original offer, never replace it'); throw error; }
  } finally { fs.rmSync(temporary, { force: true }); }
  return destination;
}
export function consumerOfferAcceptance(release, home) {
  const file = path.join(home, 'offers', `${release.id}.json`);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return null;
  try {
    if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw Error('redirected offer');
    const record = JSON.parse(readPlainFile(file));
    const manifestSha256 = digest(readPlainFile(path.join(release.root, '.release-manifest.json')));
    const bytes = Buffer.from(record.packetBase64 ?? '', 'base64');
    if (record.schema !== 'consumer-release-offer-record/v1' || record.release !== release.id || record.commit !== release.commit ||
        record.manifestSha256 !== manifestSha256 || digest(bytes) !== record.packetSha256 ||
        JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(record.packet)) throw Error('offer record mismatch');
    validateConsumerOffer(record.packet, release, manifestSha256);
    if (JSON.stringify(record.fullSuite) !== JSON.stringify(record.packet.fullSuite ?? unrunSuite)) throw Error('offer information mismatch');
    if (record.disposition?.seq !== record.packet.attestationSeq || record.disposition.type !== 'note.added' || record.disposition.decision !== true ||
        !nonempty(record.coordinator) || record.disposition.by !== record.coordinator || record.disposition.id !== record.packet.coordinatorItem ||
        record.disposition.text !== `Consumer release offer reconciled: ${record.packet.attestationDigest}`) throw Error('offer disposition mismatch');
    return { ready: true, source: 'consumer-offer', candidateCommit: release.commit, summarySha256: record.packetSha256,
      fullSuite: record.fullSuite };
  } catch (error) { return { ready: false, source: 'consumer-offer', reason: `consumer-offer-invalid: ${error.message}` }; }
}
