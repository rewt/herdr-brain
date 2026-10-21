// Observations only. Eligibility and lifecycle authority stay in retire.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { readProjectPolicy } from './config-policy.mjs';

export function readArchivalRetirementPolicy(canonicalRoot) {
  try {
    const config = readProjectPolicy(canonicalRoot, 'lane', process.env, { canonical: canonicalRoot }).config;
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    if (!object(config) || (config.retirement !== undefined && !object(config.retirement))) throw Error('invalid retirement configuration');
    const enabled = config.retirement?.archival_retirement;
    if (enabled !== undefined && typeof enabled !== 'boolean') throw Error('retirement.archival_retirement must be boolean');
    return { archivalRetirementPolicy: enabled === true };
  } catch (error) {
    return { archivalRetirementPolicy: false, archivalRetirementPolicyError: error.message };
  }
}

// git cherry describes historical patches, never ancestry or current behavior.
// Bind both refs around the full observation; unique merges are unaccounted
// even when every non-merge patch has a match. Incomplete history cannot qualify.
export function observeArchivalHistory({ branch, tip, main, mainTip, git }) {
  const result = { tip, mainTip, complete: false, stable: true };
  const stable = () => git(['rev-parse', '--verify', `refs/heads/${branch}`]) === tip &&
    git(['rev-parse', '--verify', `refs/heads/${main}`]) === mainTip;
  try {
    if (!stable()) { result.stable = false; return result; }
    if (git(['rev-parse', '--is-shallow-repository']) !== 'false' ||
        git(['for-each-ref', '--format=%(refname)', 'refs/replace']) ||
        fs.existsSync(git(['rev-parse', '--path-format=absolute', '--git-path', 'info/grafts']))) throw Error('shallow or rewritten Git history');
    const merges = git(['rev-list', '--min-parents=2', `${mainTip}..${tip}`]);
    const patches = git(['cherry', mainTip, tip]);
    result.uniqueMerges = merges ? merges.split('\n') : [];
    result.patches = patches ? patches.split('\n').map(line => {
      const match = /^([+-]) ([a-f0-9]{40,64})$/.exec(line);
      if (!match) throw Error('incomplete git cherry output');
      return { sign: match[1], commit: match[2] };
    }) : [];
    if (result.uniqueMerges.some(commit => !/^[a-f0-9]{40,64}$/.test(commit))) throw Error('incomplete merge inventory');
    result.stable = stable();
    result.complete = true;
  } catch (error) {
    if (error.code === 'RETIREMENT_DEADLINE') throw error;
    result.error = error.message;
  }
  return result;
}
