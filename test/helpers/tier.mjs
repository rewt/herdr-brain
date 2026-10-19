import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../../lib/cli-help.mjs';
import { main as suite } from './suite.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fast = ['test/main-module.test.mjs', 'test/report.test.mjs', 'test/discernment.test.mjs', 'test/sanitization.test.mjs', 'test/processes.test.mjs', 'test/tier-plan.test.mjs', 'lanes/test/routes.test.mjs'];
// Whole-file promotion coverage stays explicit; future files default to release.
// Mixed files also supply selected fast cases through the promotion scripts.
const promotion = [
  'acceptance/test/cases.test.mjs',
  'acceptance/test/deadlines.test.mjs',
  'acceptance/test/environment.test.mjs',
  'acceptance/test/focus-classification.test.mjs',
  'acceptance/test/load.test.mjs',
  'acceptance/test/probe.test.mjs',
  'acceptance/test/results.test.mjs',
  'acceptance/test/signal.test.mjs',
  'acceptance/test/snapshot.test.mjs',
  'dispatch/test/timing.test.mjs',
  'dispatch/test/retired-flags.test.mjs',
  'dispatch/test/session-cap.test.mjs',
  'lanes/test/herdr-client.test.mjs',
  'lanes/test/no-focus.test.mjs',
  'lanes/test/routes.test.mjs',
  'lanes/test/validation.test.mjs',
  'promote/test/promote.test.mjs',
  'promote/test/train.test.mjs',
  'promote/test/workflow-train.test.mjs',
  'test/bch-cloak-contract.test.mjs',
  'test/contracts-conformance.test.mjs',
  'supervisor/test/request.test.mjs',
  'settle/test/rebase-paths.test.mjs',
  'settle/test/rebase-review.test.mjs',
  'settle/test/rebase-safety.test.mjs',
  'settle/test/rebase.test.mjs',
  'settle/test/record-recovery.test.mjs',
  'settle/test/record-safety.test.mjs',
  'settle/test/review-scope.test.mjs',
  'settle/test/train.test.mjs',
  'supervisor/test/autopilot.test.mjs',
  'supervisor/test/green-pass.test.mjs',
  'supervisor/test/green-manifest.test.mjs',
  'supervisor/test/chats.test.mjs',
  'supervisor/test/reconcile.test.mjs',
  'test/activation-seam.test.mjs',
  'test/approvals.test.mjs',
  'test/discernment.test.mjs',
  'test/file-wait.test.mjs',
  'test/flow.test.mjs',
  'test/git-seed.test.mjs',
  'test/inbox.test.mjs',
  'test/lane-removal-protection.test.mjs',
  'test/lessons.test.mjs',
  'test/main-module.test.mjs',
  'test/memory.test.mjs',
  'test/name-alias.test.mjs',
  'test/no-setuid-processes.test.mjs',
  'test/offline-herdr.test.mjs',
  'test/one-watcher.test.mjs',
  'test/processes.test.mjs',
  'test/report.test.mjs',
  'test/record-guard.test.mjs',
  'test/retire-status.test.mjs',
  'test/retire-archive.test.mjs',
  'test/retire-removal-deadlines.test.mjs',
  'test/review-children.test.mjs',
  'test/sanitization.test.mjs',
  'test/session-release.test.mjs',
  'test/setup.test.mjs',
  'test/setup-apply.test.mjs',
  'test/suite.test.mjs',
  'test/tidy-tabs.test.mjs',
  'test/tier-plan.test.mjs',
  'test/today.test.mjs',
  'watch/test/lock.test.mjs'
];
const directories = {
  core: ['test', 'brain/test', 'watch/test', 'dispatch/test', 'housekeeping/test', 'discovery/test', 'promote/test', 'verify/test'],
  cycle: ['settle/test', 'supervisor/test'],
  lanes: ['lanes/test'], acceptance: ['acceptance/test'],
};
// A module folder may be gone from the tree being planned (removed in the candidate while the
// planner runs from the base commit), so a missing folder contributes no tests.
function testFiles(directory, dir) {
  const absolute = path.join(directory, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute).filter(file => file.endsWith('.test.mjs')).sort().map(file => `${dir}/${file}`);
}
export function tierFiles(tier, directory = root) {
  if (tier === 'fast') return [...fast];
  if (tier === 'promotion') return [...promotion];
  if (tier === 'release') return Object.values(directories).flat().flatMap(dir => testFiles(directory, dir))
    .filter(file => !promotion.includes(file));
  if (!directories[tier]) throw Error(`unknown test tier: ${tier}`);
  return directories[tier].flatMap(dir => testFiles(directory, dir))
    .filter(file => promotion.includes(file));
}
if (isMain(import.meta.url)) {
  const [tier, ...options] = process.argv.slice(2);
  if (options.some(option => !option.startsWith('--'))) throw Error('expected runner options after tier');
  process.chdir(root);
  suite([...options, ...tierFiles(tier)]);
}
