// Settle and the train execute trusted base code while inspecting the candidate tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { promotionTestPlan } from '../promote/test-plan.mjs';

const MAX_BYTES = 64 * 1024 * 1024;
function git(repo, args, input) {
  const r = spawnSync('git', ['-C', repo, ...args], { input, maxBuffer: MAX_BYTES, timeout: 20000 });
  if (r.error || r.status !== 0) throw Error(r.stderr?.toString().trim() || r.error?.message || 'cannot materialize canonical test planner');
  return r.stdout;
}
export function canonicalTestPlan({ repo, base, ...options }) {
  if (!options.planner) return null;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) throw Error('test planner requires a captured canonical base commit');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'settle-test-plan-'));
  try {
    const entries = git(repo, ['ls-tree', '-rz', base]).toString('utf8').split('\0').filter(Boolean);
    if (entries.length > 10000) throw Error('canonical test planner snapshot exceeds 10000 paths');
    // Copy regular blobs only. Symlinks/submodules cannot import code outside
    // this private snapshot; all relative imports come from the same commit.
    const files = entries.flatMap(entry => {
      const match = /^(100644|100755) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
      if (!match) return [];
      const [, mode, oid, name] = match;
      if (path.isAbsolute(name) || name.split('/').includes('..')) throw Error('invalid canonical planner snapshot path');
      return [{ mode, oid, name }];
    });
    const blobs = git(repo, ['cat-file', '--batch'], files.map(file => file.oid + '\n').join(''));
    let offset = 0;
    for (const file of files) {
      const end = blobs.indexOf(10, offset);
      const header = blobs.subarray(offset, end).toString('ascii').split(' ');
      const size = Number(header[2]);
      offset = end + 1;
      if (end < 0 || header[0] !== file.oid || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0 || offset + size >= blobs.length || blobs[offset + size] !== 10) throw Error('invalid canonical planner blob');
      const target = path.join(root, file.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, blobs.subarray(offset, offset + size), { flag: 'wx', mode: file.mode === '100755' ? 0o700 : 0o600 });
      offset += size + 1;
    }
    return promotionTestPlan({ ...options, plannerRoot: root });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
