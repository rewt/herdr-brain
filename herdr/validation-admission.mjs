import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { releaseProject } from '../lib/releases.mjs';
import { policyLocation, contentDigest } from '../lib/config-home.mjs';
import { readPolicySnapshot, parsePolicyBytes } from '../lib/config-policy.mjs';
import { durableWrite } from '../lib/durable-json.mjs';
import { findOrgDir } from '../lib/store.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = file => {
  if (!path.isAbsolute(file) || !fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw Error('coverage evidence must be a plain absolute file');
  return fs.readFileSync(file);
};

// This is the inventory of the existing full command, not an additional gate.
// Custom release commands retain one whole-command obligation.
export async function releaseCoverageFiles(root, command) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const legacyRelease = command === 'npm run test:release' &&
    pkg.scripts?.['test:release'] === 'node test-slot/test-slot.mjs run test:release -- npm run test:release:steps';
  const fullPassRelease = command === 'npm run test:slot && node test/helpers/full-pass.mjs' &&
    pkg.scripts?.['test:slot'] === 'node --test test-slot/test/*.test.mjs' &&
    fs.existsSync(path.join(root, 'test/helpers/full-pass.mjs'));
  if (legacyRelease || fullPassRelease) {
    const { tierFiles } = await import(pathToFileURL(path.join(root, 'test/helpers/tier.mjs')).href);
    return [...fs.readdirSync(path.join(root, 'test-slot/test')).filter(file => file.endsWith('.test.mjs')).map(file => `test-slot/test/${file}`),
      ...['core', 'cycle', 'lanes', 'acceptance', 'release'].flatMap(tier => tierFiles(tier, root))].sort();
  }
  return [`command:${command}`];
}

// A continuation is explicitly a supervisor reconciliation of retained native
// receipts. It is never an exit-0 receipt for an unexecuted whole command.
// The record note binds the exact reconciliation, including semantic case and
// dependency decisions that a filename/hash comparison cannot establish.
export async function verifyReleaseCoverage(file, { identity, frozen, canonical, env = process.env }) {
  const bytes = plain(file), coverage = JSON.parse(bytes), sha256 = digest(bytes);
  const command = frozen.declaration.release ?? 'npm run test:release';
  if (coverage.schema !== 'release-full-coverage/v1' || coverage.commit !== identity.commit || coverage.tree !== identity.tree ||
      coverage.common !== frozen.common || coverage.command !== command || coverage.admissionSha256 !== frozen.sha256 ||
      coverage.complete !== true || !Array.isArray(coverage.unresolved) || coverage.unresolved.length) throw Error('release coverage binding is incomplete or mismatched');
  const runtime = { executable: process.execPath, version: process.version, sha256: digest(fs.readFileSync(process.execPath)), platform: process.platform, arch: process.arch };
  if (JSON.stringify(coverage.runtime) !== JSON.stringify(runtime)) throw Error('release coverage runtime changed');
  const required = await releaseCoverageFiles(identity.root, command);
  if (!Array.isArray(coverage.files) || new Set(coverage.files.map(row => row.file)).size !== coverage.files.length ||
      JSON.stringify(coverage.files.map(row => row.file).sort()) !== JSON.stringify(required)) throw Error('release coverage does not cover the full inventory');
  if (!Array.isArray(coverage.evidence) || !coverage.evidence.length) throw Error('release coverage has no native evidence');
  const evidence = new Map();
  for (const row of coverage.evidence) {
    if (!row.id || evidence.has(row.id) || digest(plain(row.file)) !== row.sha256) throw Error('release coverage evidence changed or duplicated');
    if (!Array.isArray(row.executedFiles) || !row.executedFiles.length || new Set(row.executedFiles).size !== row.executedFiles.length) throw Error('release coverage needs the actual executed file scope');
    const receipt = JSON.parse(plain(row.file));
    if (!Number.isInteger(receipt.exit_code) || receipt.attempts !== 1 || receipt.signal || receipt.gate_timeout ||
        !receipt.started_at || !receipt.finished_at) throw Error('release coverage execution is unfinished, repeated or timed out');
    const captured = JSON.parse(plain(row.identityFile));
    if (digest(plain(row.identityFile)) !== row.identitySha256 || !captured.identity?.commit ||
        row.source !== captured.identity.commit) throw Error('release coverage source identity changed');
    const source = captured.identity;
    if (receipt.resource?.profile?.binding?.target_identity && receipt.resource.profile.binding.target_identity !== source.tree) throw Error('release coverage receipt/source mismatch');
    const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', canonical, ...args], {
      encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' } }).trim();
    if (git(['rev-parse', `${source.commit}^{tree}`]) !== source.tree ||
        git(['merge-base', source.commit, identity.commit]) !== source.commit) throw Error('release coverage source is not an ancestor of the candidate');
    const changed = git(['diff', '--name-only', source.commit, identity.commit]).split('\n').filter(Boolean).sort();
    if (JSON.stringify(changed) !== JSON.stringify(row.changedFiles)) throw Error('release coverage source reconciliation is stale');
    // No automatic validity from a matching filename or opaque environment hash.
    for (const key of ['source', 'runner', 'environment', 'dependencies', 'cleanup']) {
      if (typeof row.reconciliation?.[key] !== 'string' || row.reconciliation[key].trim().length < 20) throw Error(`release coverage needs explicit ${key} reconciliation`);
    }
    evidence.set(row.id, { ...row, receipt });
  }
  for (const row of coverage.files) {
    if (!Array.isArray(row.receipts) || !row.receipts.length || row.receipts.some(id => !evidence.has(id)) ||
        typeof row.scope !== 'string' || row.scope.trim().length < 20) throw Error('release coverage has an unproved file or case scope');
    // A later suite may fail after an earlier audited suite finished green.
    // Use the paired native suite observations, never a test filename alone.
    const passed = (id, file) => {
      const result = evidence.get(id)?.receipt;
      if (!result || !evidence.get(id).executedFiles.includes(file)) return false;
      if (result.exit_code === 0) return true;
      return (result.timings ?? []).some(start => start.event === 'start' && start.depth === 0 &&
        ((start.kind === 'suite' && start.files?.includes(file)) || (start.kind === 'file' && start.name === file)) &&
        result.timings.some(end => end.id === start.id && end.kind === start.kind && end.event === 'finish' && end.exit_code === 0));
    };
    const red = row.receipts.filter(id => !passed(id, row.file));
    if (red.length && (!Array.isArray(row.corrections) || red.some(id => !row.corrections.some(fix => fix.original === id &&
        evidence.has(fix.passed) && passed(fix.passed, fix.file ?? row.file) && typeof fix.scope === 'string' && fix.scope.trim().length >= 20)))) {
      throw Error('release coverage retains a known-red component without a passing specific correction');
    }
  }
  // The note is durable evidence of the supervisor's disposition, not a native
  // identity/permission substitute. The native release entry retains those guards.
  const org = findOrgDir({ cwd: canonical, env: { ...env, ORG_DIR: undefined } });
  const note = org && fs.readFileSync(path.join(org, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).find(row => row.seq === coverage.attestationSeq);
  if (note?.type !== 'note.added' || note.decision !== true || note.text !== `Release full coverage reconciled: ${coverage.attestationDigest}`) throw Error('release coverage has no exact recorded disposition');
  const attested = { ...coverage }; delete attested.attestationSeq; delete attested.attestationDigest;
  if (coverage.attestationDigest !== digest(JSON.stringify(attested))) throw Error('release coverage disposition does not bind this certificate');
  return { kind: 'supervisor-reconciled-full-coverage', sha256, inputBase64: bytes.toString('base64'), certificate: coverage };
}

export function freezeReleaseValidation(cwd, tag, destination, env = process.env, { commit, mode = 'stable' } = {}) {
  if (!['stable', 'routine'].includes(mode)) throw Error('invalid release mode');
  const project = releaseProject(cwd), selected = policyLocation(project.canonical, 'validation', env);
  const git = (args, encoding = 'utf8') => execFileSync('git', ['-C', project.canonical, ...args], { encoding,
    env: Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_'))), stdio: ['ignore', 'pipe', 'pipe'] });
  const ref = commit ?? git(['rev-parse', '--verify', selected.home ? 'HEAD^{commit}' : `refs/tags/${tag}^{commit}`]).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref) || git(['cat-file', '-t', ref]).trim() !== 'commit') throw Error('invalid captured release commit');
  let declaration = {}, source = `tag:${tag}:.lane.validation.json`, bytes = '';
  if (selected.home) {
    const snapshot = readPolicySnapshot(selected.file, 'validation', { cwd, env });
    declaration = snapshot.config; bytes = snapshot.bytes; source = selected.file;
  } else {
    const entry = git(['ls-tree', ref, '--', '.lane.validation.json']).trim();
    if (entry) {
      if (!/^100(?:644|755) blob /u.test(entry)) throw Error('tagged validation declaration must be a regular file');
      bytes = git(['show', `${ref}:.lane.validation.json`], 'buffer');
      declaration = parsePolicyBytes(bytes, 'validation', source);
    }
  }
  const frozen = { schema: 'release-validation-admission/v1', common: project.identity, canonical: project.canonical, source, sha256: contentDigest(bytes), declaration,
    consumerOfferRequired: true, payloadCommit: ref, inputBase64: Buffer.from(bytes).toString('base64'), ...(mode === 'routine' ? { releaseMode: mode } : {}) };
  durableWrite(destination, frozen);
  return frozen;
}
