// Pin-bound green admission. All candidate bytes come from Git objects; none
// are imported or executed. This is eligibility, never validation selection.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir } from '../lib/store.mjs';
import { manifestScope, checkActivation, checkDeployment, recordedActivation, childEnvironment } from './green-manifest.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const contractFile = 'supervisor/green-contracts.json';
const contractBytes = fs.readFileSync(new URL('./green-contracts.json', import.meta.url), 'utf8');
export const GREEN_CONTRACTS = JSON.parse(contractBytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const commit = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value ?? '');
const env = (manifest = GREEN_CONTRACTS) => childEnvironment(manifest);
const utf8 = bytes => {
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded).equals(bytes)) throw Error('non-UTF-8 input');
  return decoded;
};
const text = bytes => {
  const decoded = utf8(bytes);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(decoded)) throw Error('binary input');
  return decoded;
};
const safePath = file => typeof file === 'string' && file && !file.includes('\\') && !path.posix.isAbsolute(file) &&
  !/[\x00-\x1f\x7f]/.test(file) && file.split('/').every(p => p && p !== '.' && p !== '..');
export const contractMatch = (file, pattern) => new RegExp('^' + pattern.split(/(\*\*\/|\*\*|\*)/).map(p =>
  p === '**/' ? '(?:.*/)?' : p === '**' ? '.*' : p === '*' ? '[^/]*' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$').test(file);
const matches = (file, patterns) => patterns.some(p => contractMatch(file, p));
const refusal = (code, reason, extra = {}) => ({ eligible: false, code, reason, ...extra });
const identityError = reason => { throw Error(`GREEN_IDENTITY_MISMATCH: ${reason}`); };

// Shared by the pre-declaration authority check and the remaining path checks.
// Policy identity is its code; JSON array order carries no authority meaning.
export function greenContractRefusal(file, { contracts = GREEN_CONTRACTS, authority = false } = {}) {
  const rules = contracts.exclusions.filter(rule => (rule.code === 'GREEN_SELF_AUTHORITY') === authority);
  const rule = rules.find(rule => matches(file, rule.paths));
  return rule && refusal(rule.code, `${authority ? 'eligibility/evidence authority' : 'declared contract'}: ${file}`);
}

function gitAt(workspace, manifest) {
  return (args, raw = false) => {
    const r = spawnSync(manifest.git.path, ['--no-optional-locks', '-C', workspace, ...args], { env: env(manifest), encoding: null, timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw Error(r.stderr?.toString('utf8').trim() || r.error?.message || 'Git unavailable');
    return raw ? r.stdout : utf8(r.stdout);
  };
}
function readTree(git, ref, root) {
  const entries = git(['ls-tree', '-r', '-z', ref]).split('\0');
  if (entries.pop() !== '') throw Error('truncated Git tree');
  const files = new Map(), cache = new Map(); let total = 0;
  for (const entry of entries) {
    const m = /^(\d{6}) (blob|commit) ([a-f0-9]+)\t(.+)$/.exec(entry);
    if (!m || !safePath(m[4])) throw Error('unsupported Git tree entry');
    files.set(m[4], { mode: m[1], oid: m[3] });
  }
  if (files.size > 10000) throw Error('Git tree exceeds 10000 files');
  const bytes = file => {
    if (!cache.has(file)) {
      const entry = files.get(file);
      if (!entry || !['100644', '100755'].includes(entry.mode)) throw Error(`non-regular input: ${file}`);
      const value = git(['cat-file', 'blob', entry.oid], true); total += value.length;
      if (value.length > 2 * 1024 * 1024 || total > 32 * 1024 * 1024) throw Error('source inventory exceeds byte limit');
      cache.set(file, value);
    }
    return cache.get(file);
  };
  return { files, root, bytes, read: file => text(bytes(file)) };
}

function declaredPair(pair, manifest) {
  if (!pair || typeof pair !== 'object' || Array.isArray(pair) || Object.keys(pair).length !== 3 ||
      !['repo', 'identity', 'org'].every(k => typeof pair[k] === 'string' && path.isAbsolute(pair[k]) && fs.realpathSync(pair[k]) === pair[k])) identityError('declarations require canonical repo, identity and org paths');
  const project = gitProject(pair.repo, { env: env(manifest), timeoutMs: 10000 });
  if (project.canonical !== pair.repo || project.checkout !== pair.repo || project.identity !== pair.identity) identityError('declared canonical Git identity changed');
  const discovered = findOrgDir({ cwd: pair.repo, env: env(manifest) });
  if (!discovered || fs.realpathSync(discovered) !== pair.org) identityError('declared record differs from discovered project record');
  return pair;
}

export function greenManifestIdentity({ repo, org, identity: expected, bindings }, { manifest, sourceRoot, manifestDigest = hash(JSON.stringify(manifest)) }) {
    try {
      checkActivation(bindings, Date.now(), recordedActivation(manifest.bindings.brain.org, manifestDigest, manifest.activation));
      if (!bindings || Object.keys(bindings).some(k => !['brain', 'lab', 'activatedAt', 'activationId'].includes(k)) || !bindings.brain) identityError('declare the manifest Brain binding');
      if (!['brain', 'lab'].every(kind => ['repo', 'identity', 'org'].every(key => (bindings[kind]?.[key] ?? null) === (manifest.bindings[kind]?.[key] ?? null)))) identityError('configuration differs from reviewed manifest identities');
      const brain = declaredPair(bindings.brain, manifest), lab = bindings.lab && declaredPair(bindings.lab, manifest);
      if (lab && (brain.identity === lab.identity || brain.org === lab.org)) identityError('Brain and lab must have independent identities and records');
      const source = gitProject(sourceRoot, { env: env(manifest), timeoutMs: 10000 });
      if (source.identity !== brain.identity || source.canonical !== brain.repo) identityError('Brain declaration differs from this source checkout');
      const project = gitProject(repo, { env: env(manifest), timeoutMs: 10000 });
      const kind = ['brain', 'lab'].find(k => bindings[k]?.identity === project.identity);
      if (!kind || project.checkout !== project.canonical || project.canonical !== bindings[kind].repo || repo !== project.canonical || org !== bindings[kind].org ||
          (expected !== undefined && expected !== project.identity)) identityError('admission is outside the declared canonical project and record');
      return { kind, ...bindings[kind] };
    } catch (error) {
      if (error.message.startsWith('GREEN_')) throw error;
      identityError(error.message);
    }
  }

// Private fixtures may inject a trusted checkout. The live singleton always
// loads the reviewed manifest from its own source, never from the candidate.
export function createGreenCohort(sourceRoot = root) {
  // Read only the trusted running checkout. Candidate policy is never loaded.
  const policyBytes = sourceRoot === root ? contractBytes : fs.readFileSync(path.join(sourceRoot, contractFile), 'utf8');
  const manifest = JSON.parse(policyBytes);
  const snapshots = new Map();
  const trusted = (file, expectedMode, raw = false) => {
    const target = path.join(fs.realpathSync(sourceRoot), file);
    const stat = fs.lstatSync(target);
    if (!safePath(file) || fs.realpathSync(target) !== target || !stat.isFile() || stat.size > 2 * 1024 * 1024 ||
        (expectedMode && ((stat.mode & 0o111) ? '100755' : '100644') !== expectedMode)) throw Error('non-regular, oversized or changed-mode trusted input');
    const value = fs.readFileSync(target);
    if (raw) return value;
    const bytes = text(value);
    if (snapshots.has(file) && snapshots.get(file) !== bytes) throw Error(`trusted source drift: ${file}`);
    return bytes;
  };
  let sourceError;
  try { for (const file of manifest.bootstrapFiles ?? []) snapshots.set(file, trusted(file, '100644')); }
  catch (error) { sourceError = error.message; }
  function deployment() {
    if (sourceError) throw Error(`GREEN_REACH_UNKNOWN: ${sourceError}`);
    checkDeployment(manifest, trusted);
  }
  function identity(options) {
    deployment();
    return greenManifestIdentity(options, { manifest, sourceRoot, manifestDigest: hash(policyBytes) });
  }
  function scope(options) {
    const { repo, org, workspace, base, head, review, report, run, reportRoot, item } = options;
    try {
      const binding = identity(options), git = gitAt(workspace, manifest);
      const candidate = gitProject(workspace, { env: env(manifest), timeoutMs: 10000 });
      const record = findOrgDir({ cwd: workspace, env: env(manifest) });
      if (candidate.identity !== binding.identity || !record || fs.realpathSync(record) !== org) return refusal('GREEN_IDENTITY_MISMATCH', 'candidate workspace or record differs from admission', {
        expected: { identity: binding.identity, org }, observed: { identity: candidate.identity, org: record && fs.realpathSync(record) } });
      if (!commit(base) || !commit(head) || git(['rev-parse', 'HEAD']).trim() !== head || git(['status', '--porcelain=v1', '--untracked-files=all']).trim()) return refusal('GREEN_REACH_UNKNOWN', 'candidate head/base missing, changed or dirty');
      git(['merge-base', '--is-ancestor', base, head]);
      const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
      if (/^blue(?:\/|$)/.test(branch) || item?.meta?.release_channel === 'blue' || item?.meta?.blue_hotfix === true) return refusal('GREEN_BLUE_HOTFIX', 'blue operations use the ordinary route');
      const raw = git(['diff', '--raw', '--no-abbrev', '--no-renames', '-z', base, head, '--']).split('\0');
      if (raw.pop() !== '' || !raw.length || raw.length % 2) throw Error('empty or incomplete diff');
      const changes = [];
      for (let i = 0; i < raw.length; i += 2) {
        const m = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([AMDT])$/.exec(raw[i]), file = raw[i + 1];
        if (!m || !safePath(file)) throw Error('unknown diff entry');
        changes.push({ file, before: m[1], after: m[2], status: m[3] });
      }
      // Refuse policy edits before interpreting any candidate declaration.
      // The reviewed manifest supplies the remaining frozen boundary inputs.
      for (const change of changes) {
        const denied = greenContractRefusal(change.file, { authority: true });
        if (denied) return denied;
      }
      for (const change of changes) {
        const denied = greenContractRefusal(change.file);
        if (denied) return denied;
        if (![change.before, change.after].every(mode => ['000000', '100644', '100755'].includes(mode)) ||
            (change.before !== '000000' && change.after !== '000000' && change.before !== change.after) || change.after === '100755')
          return refusal('GREEN_NATIVE_ISOLATION', `file type or executable mode: ${change.file}`);
      }
      const before = readTree(git, base, binding.repo), after = readTree(git, head, binding.repo);
      if (binding.kind === 'brain') for (const tree of [before, after]) {
        if (tree.read(contractFile) !== policyBytes) return refusal('GREEN_SELF_AUTHORITY', 'inventory/contract declaration differs from the running checker');
      }
      const execution = manifestScope(before, after, { manifest, trusted, project: binding.kind, changes, review,
        reviewFile: review && path.relative(workspace, review.path).split(path.sep).join('/') });
      if (!execution.eligible) return execution;
      const { reach: evidence, authority } = execution;
      const lifecycle = execution.lifecycle;
      const paths = changes.map(change => change.file);
      let controls;
      if (lifecycle) {
        try { controls = lifecycleEvidence({ report, run, reportRoot, binding, base, head, review, workspace, git, after }); }
        catch (error) { return refusal('GREEN_LIFECYCLE_EVIDENCE', error.message); }
      }
      return { eligible: true, cohort: 'green-pass', area: lifecycle ? 'green-lifecycle' : 'green', base, head, paths, repo, binding, requiredTests: execution.requiredTests, reach: evidence, authority, manifest: { sha256: hash(policyBytes), components: execution.components },
        ...(controls ? { lifecycle: controls } : {}) };
    } catch (error) {
      const named = /^(GREEN_[A-Z_]+):\s*/.exec(error.message);
      return refusal(named?.[1] ?? 'GREEN_REACH_UNKNOWN', named ? error.message.slice(named[0].length) : error.message);
    }
  }
  return { identity, scope, deployment, environment: () => childEnvironment(manifest) };
}

export const LIFECYCLE_CASES = {
  identity: ['foreign-project-kept', 'record-mismatch-kept'],
  hold: ['hold-at-mutation-kept'],
  live_reference: ['live-reference-kept'],
  recoverability: ['dirty-or-unknown-kept', 'unmerged-work-archived'],
};
export function lifecycleEvidence({ report, run, reportRoot, binding, base, head, review, workspace, git, after }) {
  const e = report?.extra?.green_lifecycle ?? report?.green_lifecycle;
  if (!e || e.version !== 1 || e.run !== run || e.base !== base || !commit(e.head) || e.identity !== binding.identity || e.org !== binding.org) throw Error('missing or stale lifecycle report binding');
  if (e.head !== head) {
    // Settle can add exactly its independently hashed review document after
    // engineer evidence was captured. No source/evidence delta is exempted.
    git(['merge-base', '--is-ancestor', e.head, head]);
    const changed = git(['diff', '--name-status', '--no-renames', e.head, head, '--']).trim();
    const reviewPath = review && path.relative(workspace, review.path).split(path.sep).join('/');
    if (!reviewPath?.startsWith('docs/reviews/') || changed !== `A\t${reviewPath}` || hash(after.read(reviewPath)) !== review.sha256) throw Error('lifecycle candidate changed after evidence');
  }
  if (!reportRoot || fs.realpathSync(reportRoot) !== reportRoot) throw Error('missing canonical run evidence directory');
  const readArtifact = descriptor => {
    if (!safePath(descriptor?.file) || !/^[a-f0-9]{64}$/.test(descriptor?.sha256 ?? '')) throw Error('invalid lifecycle artifact descriptor');
    const file = path.join(reportRoot, descriptor.file);
    let current = reportRoot;
    for (const part of descriptor.file.split('/')) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw Error('symlinked lifecycle evidence');
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw Error('non-regular or oversized lifecycle evidence');
    const bytes = fs.readFileSync(file);
    if (hash(bytes) !== descriptor.sha256) throw Error('lifecycle evidence digest changed');
    return text(bytes);
  };
  const controls = {};
  for (const [control, cases] of Object.entries(LIFECYCLE_CASES)) {
    const descriptor = e.controls?.[control], result = JSON.parse(readArtifact(descriptor));
    if (result.schema !== 'green-control/v1' || result.control !== control || result.run !== run || result.base !== base || result.head !== e.head ||
        result.identity !== binding.identity || result.org !== binding.org || result.exit_code !== 0 ||
        !Array.isArray(result.command) || !result.command.length || result.command.some(v => typeof v !== 'string' || !v.trim())) throw Error(`invalid ${control} check binding or result`);
    const log = readArtifact(result.log);
    if (/^\s*not ok\b/m.test(log) || !/^# fail 0\s*$/m.test(log) || cases.some(name => !new RegExp(`^\\s*ok \\d+ - ${name}\\s*$`, 'm').test(log))) throw Error(`missing passing ${control} control cases`);
    controls[control] = { ...descriptor, log: result.log, command: result.command };
  }
  return { run, base, head: e.head, controls };
}

const live = createGreenCohort();
export const greenIdentity = live.identity;
export const greenPassScope = live.scope;

export const greenEnvironment = live.environment;
