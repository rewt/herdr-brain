// Pin-bound green admission. All candidate bytes come from Git objects; none
// are imported or executed. This is eligibility, never validation selection.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir } from '../lib/store.mjs';
import { executionClosure, staticImportClosure } from './green-reach.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const contractFile = 'supervisor/green-contracts.json';
const contractBytes = fs.readFileSync(new URL('./green-contracts.json', import.meta.url), 'utf8');
export const GREEN_CONTRACTS = JSON.parse(contractBytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const commit = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value ?? '');
const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'ORG_DIR')), ORG_DIR: '', GIT_OPTIONAL_LOCKS: '0' });
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

function runningAuthority() {
  const source = fs.realpathSync(root); let bytes = 0;
  return staticImportClosure({ read(file) {
    if (!safePath(file)) throw Error('unsafe authority source path');
    const target = path.join(source, file), stat = fs.lstatSync(target);
    if (!stat.isFile() || fs.realpathSync(target) !== target || stat.size > 2 * 1024 * 1024) throw Error('non-regular or oversized authority input');
    const data = fs.readFileSync(target); bytes += data.length;
    if (bytes > 32 * 1024 * 1024) throw Error('authority source exceeds byte limit');
    return text(data);
  } }, GREEN_CONTRACTS.authorityEntries);
}

function gitAt(workspace) {
  return (args, raw = false) => {
    const r = spawnSync('git', ['--no-optional-locks', '-C', workspace, ...args], { env: env(), encoding: null, timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw Error(r.stderr?.toString('utf8').trim() || r.error?.message || 'Git unavailable');
    return raw ? r.stdout : utf8(r.stdout);
  };
}
function readTree(git, ref) {
  const entries = git(['ls-tree', '-r', '-z', ref]).split('\0');
  if (entries.pop() !== '') throw Error('truncated Git tree');
  const files = new Map(), cache = new Map(); let total = 0;
  for (const entry of entries) {
    const m = /^(\d{6}) (blob|commit) ([a-f0-9]+)\t(.+)$/.exec(entry);
    if (!m || !safePath(m[4])) throw Error('unsupported Git tree entry');
    files.set(m[4], { mode: m[1], oid: m[3] });
  }
  if (files.size > 10000) throw Error('Git tree exceeds 10000 files');
  return { files, read(file) {
    if (!cache.has(file)) {
      const entry = files.get(file);
      if (!entry || !['100644', '100755'].includes(entry.mode)) throw Error(`non-regular input: ${file}`);
      const bytes = git(['cat-file', 'blob', entry.oid], true); total += bytes.length;
      if (bytes.length > 2 * 1024 * 1024 || total > 32 * 1024 * 1024) throw Error('source inventory exceeds byte limit');
      cache.set(file, text(bytes));
    }
    return cache.get(file);
  } };
}
function declaredPair(pair) {
  if (!pair || typeof pair !== 'object' || Array.isArray(pair) || Object.keys(pair).length !== 3 ||
      !['repo', 'identity', 'org'].every(k => typeof pair[k] === 'string' && path.isAbsolute(pair[k]) && fs.realpathSync(pair[k]) === pair[k])) identityError('declarations require canonical repo, identity and org paths');
  const project = gitProject(pair.repo, { env: env(), timeoutMs: 10000 });
  if (project.canonical !== pair.repo || project.checkout !== pair.repo || project.identity !== pair.identity) identityError('declared canonical Git identity changed');
  const discovered = findOrgDir({ cwd: pair.repo, env: env() });
  if (!discovered || fs.realpathSync(discovered) !== pair.org) identityError('declared record differs from discovered project record');
  return pair;
}

// sourceRoot is constructor injection for private fixture repositories. The
// live autopilot uses the singleton below, never a configurable source root.
export function createGreenCohort(sourceRoot = root) {
  function identity({ repo, org, identity: expected, bindings }) {
    try {
      if (!bindings || Object.keys(bindings).length !== 2 || !bindings.brain || !bindings.lab) identityError('declare brain and lab project/record pairs');
      const brain = declaredPair(bindings.brain), lab = declaredPair(bindings.lab);
      if (brain.identity === lab.identity || brain.org === lab.org) identityError('Brain and lab must have independent identities and records');
      const source = gitProject(sourceRoot, { env: env(), timeoutMs: 10000 });
      if (source.identity !== brain.identity || source.canonical !== brain.repo) identityError('Brain declaration differs from this source checkout');
      const project = gitProject(repo, { env: env(), timeoutMs: 10000 });
      const kind = ['brain', 'lab'].find(k => bindings[k].identity === project.identity);
      if (!kind || project.checkout !== project.canonical || project.canonical !== bindings[kind].repo || repo !== project.canonical || org !== bindings[kind].org ||
          (expected !== undefined && expected !== project.identity)) identityError('admission is outside the declared canonical project and record');
      return { kind, ...bindings[kind] };
    } catch (error) {
      if (error.message.startsWith('GREEN_IDENTITY_MISMATCH:')) throw error;
      identityError(error.message);
    }
  }
  function scope(options) {
    const { repo, org, workspace, base, head, review, report, run, reportRoot, item } = options;
    try {
      const binding = identity(options), git = gitAt(workspace);
      const candidate = gitProject(workspace, { env: env(), timeoutMs: 10000 });
      const record = findOrgDir({ cwd: workspace, env: env() });
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
      // Refuse authority edits before interpreting any candidate declaration.
      // Derive from trusted running modules on each admission so newly imported
      // authority helpers cannot escape a hand-maintained path list or cache.
      const authority = runningAuthority(), authorityPaths = new Set(authority.paths);
      for (const change of changes) {
        if (authorityPaths.has(change.file) || matches(change.file, GREEN_CONTRACTS.exclusions[0].paths)) return refusal('GREEN_SELF_AUTHORITY', `eligibility/evidence authority: ${change.file}`);
        if (![change.before, change.after].every(m => ['000000', '100644', '100755'].includes(m)) ||
            (change.before !== '000000' && change.after !== '000000' && change.before !== change.after) ||
            (change.after === '100755' && change.before !== '100755')) return refusal('GREEN_NATIVE_ISOLATION', `file type or executable mode: ${change.file}`);
      }
      if (authority.unknown.length) return refusal('GREEN_SELF_AUTHORITY', 'running authority import closure is incomplete', { authority });
      const before = readTree(git, base), after = readTree(git, head);
      if (binding.kind === 'brain') for (const tree of [before, after]) {
        if (tree.read(contractFile) !== contractBytes) return refusal('GREEN_SELF_AUTHORITY', 'inventory/contract declaration differs from the running checker');
      }
      const entries = GREEN_CONTRACTS.entries.filter(e => e.project === binding.kind).map(e => e.path);
      const oldReach = executionClosure(before, entries), newReach = executionClosure(after, entries);
      const consumed = new Set([...oldReach.paths, ...newReach.paths]);
      const evidence = { base: oldReach, candidate: newReach };
      for (const { file } of changes) if (consumed.has(file)) return refusal('GREEN_BCH_CONSUMED', `cross-project execution input: ${file}`, { reach: evidence });
      for (const { file } of changes) for (const rule of GREEN_CONTRACTS.exclusions.slice(1)) if (matches(file, rule.paths)) return refusal(rule.code, `declared contract: ${file}`);
      if (oldReach.unknown.length || newReach.unknown.length) return refusal('GREEN_REACH_UNKNOWN', 'unresolved cross-project execution edge', { reach: evidence });
      let lifecycle = false, evidenceOnly = true; const paths = [];
      for (const change of changes) {
        const { file } = change; paths.push(file);
        if (review && file.startsWith('docs/reviews/') && file === path.relative(workspace, review.path).split(path.sep).join('/') && change.status === 'A' && hash(after.read(file)) === review.sha256) continue;
        if (file.startsWith('docs/evidence/')) {
          if (!GREEN_CONTRACTS.evidenceExtensions.includes(path.posix.extname(file)) || [change.before, change.after].includes('100755')) return refusal('GREEN_BINARY_EVIDENCE', `non-text evidence type or executable evidence: ${file}`);
          try { for (const tree of [before, after]) if (tree.files.has(file)) tree.read(file); }
          catch { return refusal('GREEN_BINARY_EVIDENCE', `binary evidence: ${file}`); }
          continue;
        }
        evidenceOnly = false;
        if ((file === 'README.md' || /^docs\/(?!reviews\/).*\.md$/.test(file)) && change.after !== '100755') continue;
        if (!matches(file, GREEN_CONTRACTS.code) || !/\.(?:mjs|js)$/.test(file)) return refusal('GREEN_REACH_UNKNOWN', `unmapped code, launcher or configuration: ${file}`);
        // Reach of changed code is also inspected. New hidden loads cannot be
        // declared green merely because the old cross-project graph misses it.
        for (const tree of [before, after]) if (tree.files.has(file)) {
          const reach = executionClosure(tree, [file]);
          if (reach.unknown.length) return refusal('GREEN_REACH_UNKNOWN', `unresolved affected execution path: ${file}`, { reach });
        }
        lifecycle ||= matches(file, GREEN_CONTRACTS.lifecycle);
      }
      let controls;
      if (lifecycle) {
        try { controls = lifecycleEvidence({ report, run, reportRoot, binding, base, head, review, workspace, git, after }); }
        catch (error) { return refusal('GREEN_LIFECYCLE_EVIDENCE', error.message); }
      }
      return { eligible: true, cohort: 'green-pass', area: evidenceOnly ? 'evidence-only' : lifecycle ? 'green-lifecycle' : 'green', base, head, paths, repo, binding, reach: evidence,
        ...(controls ? { lifecycle: controls } : {}) };
    } catch (error) {
      const named = /^(GREEN_[A-Z_]+):\s*/.exec(error.message);
      return refusal(named?.[1] ?? 'GREEN_REACH_UNKNOWN', named ? error.message.slice(named[0].length) : error.message);
    }
  }
  return { identity, scope };
}

export const LIFECYCLE_CASES = {
  identity: ['foreign-project-kept', 'record-mismatch-kept'],
  hold: ['hold-at-mutation-kept'],
  live_reference: ['live-reference-kept'],
  recoverability: ['dirty-or-unknown-kept', 'unmerged-work-archived'],
};
function lifecycleEvidence({ report, run, reportRoot, binding, base, head, review, workspace, git, after }) {
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
