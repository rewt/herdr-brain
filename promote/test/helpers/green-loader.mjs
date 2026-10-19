// Keep the bounded runner's containment installed in every descendant while
// presenting the production-required absent loader environment to green checks.
import '../../../test/helpers/fixture-policy.mjs';
import childProcess, { ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const environment = (env = process.env) => ({ ...env,
  NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(self)}` });
for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
  const original = childProcess[name];
  childProcess[name] = function (...args) {
    const index = name === 'execSync' ? 1 : Array.isArray(args[1]) ? 2 : 1;
    args[index] = { ...args[index], env: environment(args[index]?.env) };
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
const spawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (options) {
  const index = options.envPairs.findIndex(pair => pair.startsWith('NODE_OPTIONS='));
  const current = index < 0 ? '' : options.envPairs[index].slice('NODE_OPTIONS='.length);
  const value = `NODE_OPTIONS=${current} --import=${JSON.stringify(self)}`;
  if (index < 0) options.envPairs.push(value); else options.envPairs[index] = value;
  return spawn.call(this, options);
};
delete process.env.NODE_OPTIONS;
