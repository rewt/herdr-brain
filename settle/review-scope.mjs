// Optional review is project authority, read only from committed canonical HEAD.
// Routes, environment overrides, worker config and session metadata cannot grant it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const schema = 'settle-review-scope/v1';
const protectedNames = new Set(['agents.md', 'claude.md', '.lane.json', '.lane.validation.json', '.promote.json', '.supervisor.json', '.housekeeping.json', '.gitattributes']);
const protectedDirectories = new Set(['.agents', '.codex', '.claude']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 32 * 1024 * 1024 });
const ref = (repo, name) => git(repo, ['rev-parse', '--verify', name]).toString('utf8').trim();

export function validateReviewScope(value = { mode: 'required' }) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['mode', 'paths'].includes(key)) || !['required', 'scoped'].includes(value.mode))
    throw Error('settle.review must contain mode required|scoped and optional paths');
  const paths = value.paths ?? [];
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !p ||
      /[\x00-\x1f\x7f\\*?\[\]]/.test(p) || p.startsWith('/') ||
      p.replace(/\/$/, '').split('/').some(part => !part || part === '.' || part === '..')))
    throw Error('settle.review.paths must be relative literal files or directory prefixes ending in /');
  if (value.mode === 'scoped' && paths.length === 0) throw Error('scoped review requires at least one path');
  if (value.mode === 'required' && paths.length) throw Error('required review cannot declare unreviewed paths');
  return { mode: value.mode, paths: [...new Set(paths)].sort() };
}

export function inspectReviewScope(repo, head) {
  const base = ref(repo, 'HEAD'), source = ref(repo, `${head}^{commit}`);
  const entry = git(repo, ['ls-tree', '-z', base, '--', '.lane.json']).toString('utf8');
  let policy = validateReviewScope(), blob = null;
  if (entry) {
    const match = /^100(?:644|755) blob ([0-9a-f]+)\t\.lane\.json\0$/.exec(entry);
    if (!match) throw Error('committed .lane.json must be a regular file');
    blob = match[1];
    const config = JSON.parse(git(repo, ['cat-file', 'blob', blob]).toString('utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('committed .lane.json must be an object');
    policy = validateReviewScope(config.settle?.review);
  }
  const ancestor = git(repo, ['merge-base', base, source]).toString('utf8').trim();
  const bytes = git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', ancestor, source]);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || (bytes.length && bytes.at(-1) !== 0)) throw Error('review scope paths cannot be decoded losslessly');
  const paths = text.split('\0').filter(Boolean).sort();
  const covered = p => {
    const parts = p.toLowerCase().split('/'), name = parts.at(-1);
    return !protectedNames.has(name) && !/^(agents|claude)(\.[^/]+)?\.md$/.test(name) &&
      !parts.some(part => protectedDirectories.has(part)) &&
      policy.paths.some(allowed => allowed.endsWith('/') ? p.startsWith(allowed) : p === allowed);
  };
  const required = policy.mode !== 'scoped' || !paths.length || paths.some(p => !covered(p));
  return { schema, required, mode: policy.mode, policy_hash: digest(policy), policy_commit: base,
    policy_blob: blob, source_head: source, paths,
    reason: required ? 'Independent review required by committed project policy' : 'All changed paths are covered by committed scoped-review policy' };
}

// Recheck the current canonical policy and actual diff, including after a rebase.
// A policy edit never silently changes an in-flight candidate's authorization.
export function assertScopedReview(repo, head, decision) {
  if (decision?.schema !== schema || decision.required !== false || decision.mode !== 'scoped') throw Error('missing scoped-review authority');
  const current = inspectReviewScope(repo, head);
  if (current.required || current.policy_hash !== decision.policy_hash) throw Error('committed review policy or change scope changed; independent review required');
  return current;
}

export function assertScopedSettlement({ repo, identity, org, run, settled, result }) {
  if (settled?.stage !== 'complete' || settled.common !== identity || settled.org !== org || settled.run !== run ||
      settled.review || result?.review || result?.reviewed_commit !== null || result?.result !== 'promotable' ||
      result.run !== run || result.item !== settled.item || result.head !== (settled.finalHead ?? settled.head) ||
      settled.result?.result !== 'promotable' || settled.result?.head !== result.head || settled.reportIngest?.sha256 !== settled.reportHash ||
      JSON.stringify(result.independent_review) !== JSON.stringify(settled.independentReview))
    throw Error('scoped promotion lacks bound settlement evidence');
  return assertScopedReview(repo, result.head, settled.independentReview);
}
