// Read-only Git evidence. Only delivered-change artifacts make range claims;
// report prose and informational artifact references never do.
import { spawnSync } from 'node:child_process';

const TOKEN = /(?<![A-Za-z0-9/._~-])[a-f0-9]{7,64}(?![A-Za-z0-9/._~-])/gi;
const CLAIM_LABEL = /^(?:commit|head|branch\s+head|source)\s*(?:[:=]\s*|\s+)[`"']?$/i;
const BARE = /^[`"']?[a-f0-9]{7,64}[`"']?(?:\s+on\s+lane\/[a-z0-9][a-z0-9-]*)?$/i;
export function declaredSourceRanges(artifacts=[]){
  return artifacts.flatMap(value=>{const m=/^source\s*[:=]\s*[`"']?([a-f0-9]{7,64})[`"']?\s*;\s*base\s*[:=]\s*[`"']?([a-f0-9]{7,64})[`"']?(?:\s*;|\s*$)/i.exec(String(value).trim());const repository=/(?:^|;)\s*repository\s*[:=]\s*(.+?)\s*$/i.exec(String(value));return m?[{head:m[1].toLowerCase(),base:m[2].toLowerCase(),...(repository?{repository:repository[1]}:{})}]:[];});
}

export function claimedCommitTokens(artifacts=[]) {
  return [...new Set(artifacts.flatMap(artifact=>{
    const entry=String(artifact).trim();
    return [...entry.matchAll(TOKEN)].filter(match=>CLAIM_LABEL.test(entry.slice(0,match.index))||BARE.test(entry)).map(match=>match[0].toLowerCase());
  }))];
}

export function reviewScope({ workspace, base, head, artifacts = [] }) {
  const git = (args, optional = false) => {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,timeout:10000 });
    if (result.error || (result.status !== 0 && !(optional && result.status === 1))) {
      throw new Error(`review scope ${args[0]}: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
    }
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const resolve = (token, type) => git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${token}^{${type}}`], true);
  const main = resolve(base, 'commit'), tip = resolve(head, 'commit');
  if (!main || !tip) throw new Error('review scope requires a commit base and head');
  const scope = {
    schema: 'brain.review-scope/v1', base: git(['merge-base', main, tip]), head: tip,
    commits: git(['rev-list', `${main}..${tip}`]).split('\n').filter(Boolean),
    claims: [], context: [], outside: [], unresolved: [], deferred: null,
  };
  const range = new Set(scope.commits);
  const add = (field, value) => { if (!scope[field].includes(value)) scope[field].push(value); };
  for (const artifact of artifacts) {
    const entry = String(artifact).trim();
    for (const match of entry.matchAll(TOKEN)) {
      const token = match[0].toLowerCase();
      const labelled = CLAIM_LABEL.test(entry.slice(0, match.index));
      // Dates and other numeric identifiers are not commit references by default.
      if (/^\d+$/.test(token) && !labelled) continue;
      const claim = labelled || BARE.test(entry);
      const commit = resolve(token, 'commit');
      if (!claim) { add('context', token); continue; }
      if (!commit) {
        // Trees, blobs and tags to non-commits are evidence, even under a HEAD
        // label. Only a missing/ambiguous delivered commit defers review.
        if (resolve(token, 'object')) add('context', token);
        else add('unresolved', token);
      } else {
        add('claims', commit);
        if (!range.has(commit)) add('outside', commit);
      }
    }
  }
  scope.deferred = scope.outside.length ? 'named-commit-outside-range'
    : scope.unresolved.length ? 'named-commit-unresolved' : null;
  return scope;
}
