// Retained live observations are evidence, never an unexecuted whole-run PASS.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readPlainFile } from './files.mjs';
import { findOrgDir } from './store.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const liveKeys = ['candidate-snapshot', 'new-project-record', 'new-project-routes', 'supervisor-policy',
  'herdr-fixture', 'configured-cycle', 'promotion-queue', 'missing-worker', 'invalid-worker', 'blocked-worker',
  'fix-round', 'watch-grace', 'housekeeping', 'scratch-release', 'default-cycle', 'settle-cycle',
  'supervisor-cycle', 'scope-cleanup', 'operator-focus'];
// A new scratch scope and distribution entry always need their own witnesses.
export const freshLiveKeys = ['candidate-snapshot', 'herdr-fixture', 'scratch-release', 'scope-cleanup', 'operator-focus'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const retainedLiveEvidence = (prior, result) => path.isAbsolute(result.evidence)
  ? result.evidence : path.join(prior.evidence, result.evidence);
const runtime = () => ({ executable: process.execPath, version: process.version,
  sha256: sha(fs.readFileSync(process.execPath)), platform: process.platform, arch: process.arch });

export function liveContinuation(bytes, { commit, tree } = {}) {
  const certificate = JSON.parse(bytes), priorBytes = Buffer.from(certificate.prior?.inputBase64 ?? '', 'base64');
  if (certificate.schema !== 'release-live-coverage/v1' || certificate.commit !== commit ||
      (tree && certificate.tree !== tree) || !same(certificate.keys, liveKeys) ||
      certificate.complete !== true || !Array.isArray(certificate.unresolved) || certificate.unresolved.length ||
      sha(priorBytes) !== certificate.prior?.sha256) throw Error('live continuation binding incomplete or mismatched');
  const prior = JSON.parse(priorBytes);
  if (prior.liveCoverage) validateLiveSummary(prior);
  if (prior.candidateCommit !== certificate.sourceCommit || !Array.isArray(prior.results) ||
      !same(prior.results.map(r => r.key), liveKeys)) throw Error('live continuation original cases/source changed');
  const rerun = new Set(certificate.rerun);
  if (!Array.isArray(certificate.rerun) || rerun.size !== certificate.rerun.length ||
      [...rerun].some(key => !liveKeys.includes(key)) || freshLiveKeys.some(key => !rerun.has(key)))
    throw Error('live continuation omits fresh scope/distribution checks');
  const retained = prior.results.filter(r => !rerun.has(r.key));
  if (retained.some(r => r.status !== 'PASS')) throw Error('live continuation cannot retain a red, pending or skipped case');
  for (const key of ['source', 'runner', 'environment', 'dependencies', 'cleanup']) {
    if (typeof certificate.reconciliation?.[key] !== 'string' || certificate.reconciliation[key].trim().length < 20)
      throw Error(`live continuation needs explicit ${key} disposition`);
  }
  const attested = { ...certificate }; delete attested.attestationSeq; delete attested.attestationDigest;
  if (sha(JSON.stringify(attested)) !== certificate.attestationDigest) throw Error('live continuation disposition digest changed');
  return { certificate, prior, rerun, retained, sha256: sha(bytes), inputBase64: Buffer.from(bytes).toString('base64') };
}

export function verifyLiveContinuation(file, { commit, tree, canonical }) {
  const bytes = readPlainFile(file), plan = liveContinuation(bytes, { commit, tree }), c = plan.certificate;
  if (fs.realpathSync(c.canonical) !== fs.realpathSync(canonical) || !same(c.runtime, runtime()))
    throw Error('live continuation canonical/runtime changed');
  const identityBytes = readPlainFile(c.identityFile), identity = JSON.parse(identityBytes).identity;
  if (sha(identityBytes) !== c.identitySha256 || identity?.commit !== c.sourceCommit)
    throw Error('live continuation original source identity changed');
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', canonical, ...args], {
    encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' } }).trim();
  if (git(['rev-parse', 'HEAD']) !== commit || git(['rev-parse', `${commit}^{tree}`]) !== tree ||
      git(['merge-base', c.sourceCommit, commit]) !== c.sourceCommit || git(['rev-parse', `${c.sourceCommit}^{tree}`]) !== identity.tree ||
      !same(git(['diff', '--name-only', c.sourceCommit, commit]).split('\n').filter(Boolean).sort(), c.changedFiles))
    throw Error('live continuation source/diff changed');
  const org = findOrgDir({ cwd: canonical, env: { ...process.env, ORG_DIR: undefined } });
  const note = org && fs.readFileSync(path.join(org, 'events.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x))
    .find(e => e.seq === c.attestationSeq);
  if (note?.type !== 'note.added' || !note.decision || note.text !== `Release live coverage reconciled: ${c.attestationDigest}`)
    throw Error('live continuation has no exact owning-record disposition');
  return plan;
}

// A sealed summary embeds the retained immutable bytes and exact disposition.
// Readback needs no mutable external record or obsolete scratch roots.
export function validateLiveSummary(summary) {
  if (!summary.liveCoverage) return;
  const proof = summary.liveCoverage, bytes = Buffer.from(proof.inputBase64 ?? '', 'base64');
  if (proof.kind !== 'supervisor-reconciled-live-coverage' || sha(bytes) !== proof.sha256)
    throw Error('live continuation embedded evidence changed');
  const plan = liveContinuation(bytes, { commit: summary.candidateCommit });
  if (!same(summary.results?.map(r => r.key), liveKeys)) throw Error('live continuation result inventory changed');
  for (const result of summary.results) {
    const prior = plan.retained.find(r => r.key === result.key);
    if (prior) {
      const expected = { ...prior, evidence: retainedLiveEvidence(plan.prior, prior),
        retained: { sha256: plan.certificate.prior.sha256, commit: plan.certificate.sourceCommit, key: prior.key } };
      if (!same(result, expected)) throw Error('live continuation retained result changed');
    } else if (result.retained) throw Error('live continuation labels a fresh required case retained');
  }
}
