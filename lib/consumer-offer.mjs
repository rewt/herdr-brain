// A coordinator reconciliation of retained evidence, never a suite or activation.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readPlainFile } from './files.mjs';
import { findOrgDir } from './store.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const unrunSuite = { status: 'UNRUN', details: 'No full-suite run supplied; background information only.' };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function references(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.some(row => !path.isAbsolute(row.file ?? '') || !hash(row.sha256)))
    throw Error('consumer offer needs retained evidence references');
}
export function validateConsumerOffer(packet, release, manifestSha256) {
  if (packet.schema !== 'consumer-release-offer/v1' || packet.commit !== release.commit || packet.manifestSha256 !== manifestSha256)
    throw Error('consumer offer candidate binding mismatch');
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
  // Reuse affected producer checks from ancestors only with explicit coordinator
  // scope reconciliation, bound by the exact recorded disposition below.
  const git = args => execFileSync('git', ['-C', canonical, ...args], { encoding: 'utf8',
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))) }).trim();
  if (git(['merge-base', receipt.head, packet.commit]) !== receipt.head) throw Error('consumer offer landing source is not an ancestor of the candidate');
  const changed = git(['diff', '--name-only', receipt.head, packet.commit]).split('\n').filter(Boolean).sort();
  if (JSON.stringify(changed) !== JSON.stringify(row.changedFiles) || !nonempty(row.reconciliation))
    throw Error('consumer offer landing scope reconciliation is stale or missing');
  return receipt;
}
export function publishConsumerOffer({ release, home, canonical, file, env = process.env }) {
  const bytes = readPlainFile(file), packet = JSON.parse(bytes);
  const manifestSha256 = digest(readPlainFile(path.join(release.root, '.release-manifest.json')));
  validateConsumerOffer(packet, release, manifestSha256);
  for (const row of [...packet.canary.evidence, ...packet.landing.evidence, ...packet.majors.corrections.flatMap(fix => fix.evidence)]) {
    if (fs.realpathSync(row.file) !== row.file || digest(readPlainFile(row.file)) !== row.sha256) throw Error('consumer offer evidence changed or redirected');
  }
  for (const row of [...packet.landing.evidence, ...packet.majors.corrections.flatMap(fix => fix.evidence)]) passingLanding(row, packet, canonical);
  const org = findOrgDir({ cwd: canonical, env: { ...env, ORG_DIR: undefined } });
  const note = org && readPlainFile(path.join(org, 'events.jsonl')).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).find(row => row.seq === packet.attestationSeq);
  if (note?.type !== 'note.added' || note.decision !== true || note.text !== `Consumer release offer reconciled: ${packet.attestationDigest}`)
    throw Error('consumer offer has no exact recorded coordinator disposition');
  const directory = path.resolve(home, 'offers'); fs.mkdirSync(directory, { recursive: true });
  if (fs.realpathSync(directory) !== directory) throw Error('consumer offer directory is redirected');
  const destination = path.join(directory, `${release.id}.json`), temporary = `${destination}.${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ schema: 'consumer-release-offer-record/v1', release: release.id, commit: release.commit,
      manifestSha256, packet, packetBase64: Buffer.from(bytes).toString('base64'), packetSha256: digest(bytes),
      fullSuite: packet.fullSuite ?? unrunSuite,
      disposition: note }, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
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
        record.disposition.text !== `Consumer release offer reconciled: ${record.packet.attestationDigest}`) throw Error('offer disposition mismatch');
    return { ready: true, source: 'consumer-offer', candidateCommit: release.commit, summarySha256: record.packetSha256,
      fullSuite: record.fullSuite };
  } catch (error) { return { ready: false, source: 'consumer-offer', reason: `consumer-offer-invalid: ${error.message}` }; }
}
