// Physical Herdr command invocation. No logical authority or delivery policy here.
import { spawnSync } from 'node:child_process';
import { loadTimeout } from './deadline.mjs';
import { literalLaunch } from './owner-launch.mjs';

export function invokeHerdr(herdr, args, { env = process.env, timeout = loadTimeout(10000), launch, cwd } = {}) {
  if (launch && !(args[0] === 'agent' && args[1] === 'start')) throw Error('identity launch prefix is restricted to the owner launch seam');
  const input = literalLaunch(herdr, args, launch);
  const result = spawnSync(input.command, input.args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const error = new Error((result.stderr || result.stdout || result.error?.message || `Herdr exited ${result.status}`).trim());
    try { error.code = JSON.parse(result.stderr || result.stdout).error?.code; } catch {}
    throw error;
  }
  return result.stdout;
}
