import fs from 'node:fs';
import path from 'node:path';
import { permissionArgs, sessionEnv, copiedSandbox } from './security.mjs';
import { createOwnedTempRoot } from './temp.mjs';

export const safeGitArgs = (repo, args) => ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'commit.gpgsign=false', '-C', repo, ...args];

// Model-written files, Git filters and project configuration never execute on
// the host. Verification has a fresh temp and host-owned CLI home, read-only
// project/Git metadata, stripped environment and no network. Even Git reads
// can invoke configured helpers, so every post-entry Git call goes here.
export function createVerification(spec, { root, scratchRoots, discoveryRoots, run }) {
  const temp = createOwnedTempRoot('/private/tmp/herdr-verification-', scratchRoots, discoveryRoots);
  const verified = { ...spec, temp, runtimeHome: path.join(root, `verification-runtime-${spec.name}`),
    entryBinary: undefined, worktreeRoot: undefined, probeGit: undefined };
  fs.mkdirSync(verified.runtimeHome, { recursive: true, mode: 0o700 });
  const execute = (command, args, options = {}) => run(spec.binary,
    ['sandbox', '-C', spec.repo, '-P', 'acceptance', ...permissionArgs(verified, { gitWrites: false, projectWrites: false }), '--', command, ...args],
    { ...options, cwd: spec.repo, isolatedEnv: sessionEnv({}, verified) });
  // The trusted record CLI's safe reader opens ancestor directory FDs. A
  // kernel profile permits those literal directory reads, while constraining
  // record writes even if a model replaces .org with a symlink during a call.
  const org = path.join(spec.repo, '.org'), policy = path.join(root, `verification-record-${spec.name}.sb`);
  fs.writeFileSync(policy, copiedSandbox(temp, [spec.repo, spec.installation, ...spec.toolRoots])
    + `(deny network*)\n(allow file-write* (subpath ${JSON.stringify(org)}))\n`);
  const record = (args, extra = {}) => run('/usr/bin/sandbox-exec', ['-f', policy, process.execPath, path.join(spec.installation, 'bin/org.mjs'), ...args],
    { cwd: spec.repo, isolatedEnv: { ...sessionEnv({}, verified), ...extra, ORG_DIR: org } }).stdout;
  return { execute, record, git: (args) => execute(spec.gitBinary, safeGitArgs(spec.repo, args)).stdout.trim(), temp };
}
