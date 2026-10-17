// The pilot's deliberately closed Brain scope map. Unknown paths use the
// ordinary route. This is eligibility, never validation selection or reuse.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const protectedPath = file => /^(?:contrib|supervisor|settle|promote|lanes|acceptance|sessions|discovery|dispatch|watch|housekeeping|test-slot|herdr|bin|\.codex|\.claude)(?:\/|$)/.test(file) ||
  /^(?:AGENTS\.md|CLAUDE\.md|package(?:-lock)?\.json|\.nvmrc|\.[^/]+)$/.test(file) ||
  /(?:^|\/)(?:\.codex|\.claude|permissions?[^/]*|sessions?[^/]*|retire[^/]*|validation[^/]*|receipts?[^/]*|vectors?|trust[-_]pins?|AGENTS\.md|CLAUDE\.md|PROTOCOL\.md|SECURITY\.md|REVIEW_TEMPLATE\.md|DECISION-ROUTING\.md)(?:\/|$)/i.test(file) ||
  /^lib\/(?:store|state|report|cli-help|sessions?[^/]*|retire[^/]*|completion|discernment|processes|routes|launch[^/]*|pty[^/]*|pane-run)\.mjs$/.test(file);
const areaOf = file => {
  if (/^(brain|board|logs)\//.test(file)) return file.split('/')[0];
  if (/^lib\/(pane-run-output|render|report-feed)\.mjs$/.test(file)) return file.slice(4, -4);
  if (/^test\/board[^/]*\.test\.mjs$/.test(file)) return 'board';
  if (/^test\/logs[^/]*\.test\.mjs$/.test(file)) return 'logs';
  const test = /^test\/(pane-run-output|render|report-feed)\.test\.mjs$/.exec(file);
  if (test) return test[1];
  if (file === 'README.md' || /^docs\/(?!reviews\/)[\w/-]+\.md$/.test(file)) return 'documentation';
  return null;
};
export function cleanPassScope({ repo, workspace, base, head, review }) {
  const git = args => {
    const r = spawnSync('git', ['-C', workspace, ...args], { encoding: null, maxBuffer: 32 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw Error(r.stderr?.toString('utf8').trim() || r.error?.message || 'Git scope unavailable');
    const text = r.stdout.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(r.stdout)) throw Error('non-UTF-8 scope evidence');
    return text;
  };
  const refuse = (code, reason) => ({ eligible: false, code, reason });
  try {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base ?? '') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head ?? '') || git(['rev-parse', 'HEAD']).trim() !== head) return refuse('AUTOPILOT_SCOPE_UNKNOWN', 'candidate head or base is missing or changed');
    if (git(['status', '--porcelain=v1', '--untracked-files=all']).trim()) return refuse('AUTOPILOT_SCOPE_UNKNOWN', 'candidate worktree is dirty');
    // No rename detection: every rename is a deletion plus an addition, so
    // both names remain visible, including a protected source renamed away.
    const raw = git(['diff', '--raw', '--no-abbrev', '--no-renames', '-z', base, head, '--']);
    const tokens = raw.split('\0'); if (tokens.pop() !== '') throw Error('truncated diff');
    if (!tokens.length || tokens.length % 2) return refuse('AUTOPILOT_SCOPE_UNKNOWN', 'empty or incomplete complete diff');
    const paths = [], areas = new Set();
    for (let i = 0; i < tokens.length; i += 2) {
      const header = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([AMDT])$/.exec(tokens[i]), file = tokens[i + 1];
      if (!header || !file || file.includes('\\') || path.posix.isAbsolute(file) || file.split('/').some(p => !p || p === '.' || p === '..') || /[\x00-\x1f\x7f]/.test(file)) throw Error('unknown diff entry');
      if ([header[1], header[2]].some(mode => !['000000', '100644', '100755'].includes(mode))) return refuse('AUTOPILOT_SCOPE_UNKNOWN', `non-regular file: ${file}`);
      paths.push(file);
      if (header[2] === '100755' && header[1] !== '100755') return refuse('AUTOPILOT_SCOPE_EXCLUDED', `new executable permission: ${file}`);
      if (header[1] !== '000000' && header[2] !== '000000' && header[1] !== header[2]) return refuse('AUTOPILOT_SCOPE_EXCLUDED', `changed file permission: ${file}`);
      if (protectedPath(file)) return refuse('AUTOPILOT_SCOPE_EXCLUDED', `protected scope: ${file}`);
      // Settle's exact generated review document is still in the full diff.
      // Verify its bytes; this exemption never changes receipt tree identity.
      if (review && file.startsWith('docs/reviews/') && file === path.relative(workspace, review.path).split(path.sep).join('/') && header[3] === 'A' &&
          createHash('sha256').update(git(['show', `${head}:${file}`])).digest('hex') === review.sha256) continue;
      const area = areaOf(file);
      if (!area) return refuse('AUTOPILOT_SCOPE_UNKNOWN', `unmapped scope: ${file}`);
      areas.add(area);
    }
    if (areas.size !== 1) return refuse('AUTOPILOT_SCOPE_EXCLUDED', 'pilot requires one mapped area');
    return { eligible: true, area: [...areas][0], base, head, paths, repo };
  } catch (error) { return refuse('AUTOPILOT_SCOPE_UNKNOWN', error.message.trim()); }
}
