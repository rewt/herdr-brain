import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as suite } from './suite.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fast = ['test/report.test.mjs', 'test/discernment.test.mjs', 'test/sanitization.test.mjs', 'test/processes.test.mjs', 'test/tier-plan.test.mjs', 'brain/test/capture.test.mjs', 'console/test/model.test.mjs', 'console/test/modern.test.mjs', 'console/test/frame.test.mjs', 'console/test/paint.test.mjs', 'console/test/names.test.mjs', 'console/test/waiting.test.mjs', 'console/test/terminal.test.mjs', 'console/proto/prototype.test.mjs', 'lanes/test/routes.test.mjs'];
const release = ['discovery/test/acceptance.test.mjs', 'test/deadline-boundaries.test.mjs', 'settle/test/ref-wallclock.test.mjs'];
const directories = {
  core: ['test', 'brain/test', 'console/test', 'console/proto', 'watch/test', 'dispatch/test', 'housekeeping/test', 'discovery/test', 'promote/test'],
  cycle: ['settle/test', 'supervisor/test', 'release/test'],
  lanes: ['lanes/test'], acceptance: ['acceptance/test'],
};
export function tierFiles(tier, directory = root) {
  if (tier === 'fast') return [...fast];
  if (tier === 'release') return [...release];
  if (!directories[tier]) throw Error(`unknown test tier: ${tier}`);
  return directories[tier].flatMap(dir => fs.readdirSync(path.join(directory, dir))
    .filter(file => file.endsWith('.test.mjs')).sort().map(file => `${dir}/${file}`)).filter(file => !release.includes(file));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tier, ...options] = process.argv.slice(2);
  if (options.some(option => !option.startsWith('--'))) throw Error('expected runner options after tier');
  process.chdir(root);
  suite([...options, ...tierFiles(tier)]);
}
