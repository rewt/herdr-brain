// Keep the bounded runner's containment installed in every descendant while
// presenting the production-required absent loader environment to green checks.
import '../../../test/helpers/fixture-policy.mjs';
import { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const spawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (options) {
  const index = options.envPairs.findIndex(pair => pair.startsWith('NODE_OPTIONS='));
  const current = index < 0 ? '' : options.envPairs[index].slice('NODE_OPTIONS='.length);
  const value = `NODE_OPTIONS=${current} --import=${JSON.stringify(self)}`;
  if (index < 0) options.envPairs.push(value); else options.envPairs[index] = value;
  return spawn.call(this, options);
};
delete process.env.NODE_OPTIONS;
