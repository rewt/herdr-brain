import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { releaseProject } from '../lib/releases.mjs';
import { policyLocation, contentDigest } from '../lib/config-home.mjs';
import { readPolicyFile } from '../lib/config-policy.mjs';
import { parseUniqueJson } from '../sessions/json.mjs';
import { validateValidation } from '../lanes/validation.mjs';
import { durableWrite } from '../sessions/runtime.mjs';

export function freezeReleaseValidation(cwd, tag, destination, env = process.env) {
  const project = releaseProject(cwd), selected = policyLocation(project.canonical, 'validation', env);
  let declaration = {}, source = `tag:${tag}:.lane.validation.json`, bytes = '';
  if (selected.home) {
    declaration = readPolicyFile(selected.file, 'validation', { cwd, env });
    bytes = fs.readFileSync(selected.file); source = selected.file;
  } else {
    const git = args => execFileSync('git', ['-C', project.canonical, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    const ref = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]).trim();
    const entry = git(['ls-tree', ref, '--', '.lane.validation.json']).trim();
    if (entry) {
      if (!/^100(?:644|755) blob /u.test(entry)) throw Error('tagged validation declaration must be a regular file');
      bytes = git(['show', `${ref}:.lane.validation.json`]);
      declaration = validateValidation(parseUniqueJson(bytes));
    }
  }
  const frozen = { schema: 'release-validation-admission/v1', common: project.identity, source, sha256: contentDigest(bytes), declaration };
  durableWrite(destination, frozen);
  return frozen;
}
