import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { releaseProject } from '../lib/releases.mjs';
import { policyLocation, contentDigest } from '../lib/config-home.mjs';
import { readPolicySnapshot, parsePolicyBytes } from '../lib/config-policy.mjs';
import { durableWrite } from '../lib/durable-json.mjs';

export function freezeReleaseValidation(cwd, tag, destination, env = process.env) {
  const project = releaseProject(cwd), selected = policyLocation(project.canonical, 'validation', env);
  let declaration = {}, source = `tag:${tag}:.lane.validation.json`, bytes = '';
  if (selected.home) {
    const snapshot = readPolicySnapshot(selected.file, 'validation', { cwd, env });
    declaration = snapshot.config; bytes = snapshot.bytes; source = selected.file;
  } else {
    const git = (args, encoding = 'utf8') => execFileSync('git', ['-C', project.canonical, ...args], { encoding, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const ref = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]).trim();
    const entry = git(['ls-tree', ref, '--', '.lane.validation.json']).trim();
    if (entry) {
      if (!/^100(?:644|755) blob /u.test(entry)) throw Error('tagged validation declaration must be a regular file');
      bytes = git(['show', `${ref}:.lane.validation.json`], 'buffer');
      declaration = parsePolicyBytes(bytes, 'validation', source);
    }
  }
  const frozen = { schema: 'release-validation-admission/v1', common: project.identity, source, sha256: contentDigest(bytes), declaration };
  durableWrite(destination, frozen);
  return frozen;
}
