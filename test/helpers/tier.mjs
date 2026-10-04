import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as suite } from './suite.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fast = ['test/report.test.mjs', 'test/discernment.test.mjs', 'test/sanitization.test.mjs', 'test/processes.test.mjs', 'test/tier-plan.test.mjs', 'brain/test/capture.test.mjs', 'console/test/model.test.mjs', 'console/test/modern.test.mjs', 'console/test/frame.test.mjs', 'console/test/paint.test.mjs', 'console/test/names.test.mjs', 'console/test/waiting.test.mjs', 'console/test/terminal.test.mjs', 'console/proto/prototype.test.mjs', 'lanes/test/routes.test.mjs'];
// Whole-file promotion coverage stays explicit; future files default to release.
// Mixed files also supply selected fast cases through the promotion scripts.
const promotion = [
  'acceptance/test/cases.test.mjs',
  'acceptance/test/deadlines.test.mjs',
  'acceptance/test/environment.test.mjs',
  'acceptance/test/launch.test.mjs',
  'acceptance/test/load.test.mjs',
  'acceptance/test/probe.test.mjs',
  'acceptance/test/results.test.mjs',
  'acceptance/test/security.test.mjs',
  'acceptance/test/signal.test.mjs',
  'acceptance/test/snapshot.test.mjs',
  'brain/test/capture.test.mjs',
  'brain/test/projects.test.mjs',
  'console/proto/autonomy.test.mjs',
  'console/proto/prototype.test.mjs',
  'console/proto/workflows.test.mjs',
  'console/test/board.test.mjs',
  'console/test/brain.test.mjs',
  'console/test/control-plane.test.mjs',
  'console/test/control.test.mjs',
  'console/test/controller.test.mjs',
  'console/test/desks.test.mjs',
  'console/test/frame.test.mjs',
  'console/test/housekeeping.test.mjs',
  'console/test/model.test.mjs',
  'console/test/modern.test.mjs',
  'console/test/names.test.mjs',
  'console/test/paint.test.mjs',
  'console/test/sources.test.mjs',
  'console/test/terminal.test.mjs',
  'console/test/waiting.test.mjs',
  'discovery/test/confinement.test.mjs',
  'discovery/test/entry.test.mjs',
  'discovery/test/review-r4.test.mjs',
  'lanes/test/herdr-client.test.mjs',
  'lanes/test/no-focus.test.mjs',
  'lanes/test/routes.test.mjs',
  'lanes/test/validation.test.mjs',
  'promote/test/promote.test.mjs',
  'promote/test/train.test.mjs',
  'release/test/candidate.test.mjs',
  'settle/test/rebase-paths.test.mjs',
  'settle/test/rebase-review.test.mjs',
  'settle/test/rebase-safety.test.mjs',
  'settle/test/rebase.test.mjs',
  'settle/test/record-recovery.test.mjs',
  'settle/test/record-safety.test.mjs',
  'settle/test/train.test.mjs',
  'supervisor/test/autopilot.test.mjs',
  'test/approvals.test.mjs',
  'test/discernment.test.mjs',
  'test/file-wait.test.mjs',
  'test/flow.test.mjs',
  'test/focus.test.mjs',
  'test/git-seed.test.mjs',
  'test/inbox.test.mjs',
  'test/lessons.test.mjs',
  'test/memory.test.mjs',
  'test/name-alias.test.mjs',
  'test/no-setuid-processes.test.mjs',
  'test/offline-herdr.test.mjs',
  'test/one-watcher.test.mjs',
  'test/priorities.test.mjs',
  'test/processes.test.mjs',
  'test/recap.test.mjs',
  'test/report.test.mjs',
  'test/sanitization.test.mjs',
  'test/suite.test.mjs',
  'test/tidy-tabs.test.mjs',
  'test/tier-plan.test.mjs',
  'test/today.test.mjs',
  'test/workspace.test.mjs',
  'watch/test/lock.test.mjs'
];
const directories = {
  core: ['test', 'brain/test', 'console/test', 'console/proto', 'watch/test', 'dispatch/test', 'housekeeping/test', 'discovery/test', 'promote/test'],
  cycle: ['settle/test', 'supervisor/test', 'release/test'],
  lanes: ['lanes/test'], acceptance: ['acceptance/test'],
};
export function tierFiles(tier, directory = root) {
  if (tier === 'fast') return [...fast];
  if (tier === 'promotion') return [...promotion];
  if (tier === 'release') return Object.values(directories).flat().flatMap(dir => fs.readdirSync(path.join(directory, dir))
    .filter(file => file.endsWith('.test.mjs')).sort().map(file => `${dir}/${file}`)).filter(file => !promotion.includes(file));
  if (!directories[tier]) throw Error(`unknown test tier: ${tier}`);
  return directories[tier].flatMap(dir => fs.readdirSync(path.join(directory, dir))
    .filter(file => file.endsWith('.test.mjs')).sort().map(file => `${dir}/${file}`)).filter(file => promotion.includes(file));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tier, ...options] = process.argv.slice(2);
  if (options.some(option => !option.startsWith('--'))) throw Error('expected runner options after tier');
  process.chdir(root);
  suite([...options, ...tierFiles(tier)]);
}
