// Native resource inputs for the offline world. Never run a host-wide lsof or
// process inventory; kernel birth lookups for the scenario's owned PIDs stay real.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fs.realpathSync(process.env.INSTALLED_CYCLE_ROOT);
// sandbox-exec drops the host preload. Propagate this local native fixture
// explicitly to every installed product child after the boundary is entered.
const preload = `--import=${fileURLToPath(import.meta.url)}`;
if (!process.env.NODE_OPTIONS?.includes(preload)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${preload}`.trim();
// os.userInfo is a native account lookup and ignores HOME. Match the scratch
// account in every process so default installed entries use the fixture home.
const account = os.userInfo();
os.userInfo = options => ({ ...account, homedir: options?.encoding === 'buffer' ? Buffer.from(process.env.HOME) : process.env.HOME });
const original = childProcess.spawnSync;
childProcess.spawnSync = function (file, args = [], options = {}) {
  if (file === '/usr/sbin/lsof') {
    if (!args.includes('-Fpn0') && !args.includes('-Fpfn0')) throw Error('unexpected installed-fixture resource inventory');
    const cwd = process.cwd();
    if (!cwd.startsWith(root + path.sep)) throw Error('resource observer left scratch');
    fs.appendFileSync(path.join(root, 'evidence/native-observations.jsonl'), JSON.stringify({
      scripted: true, file, args, pid: process.pid, cwd }) + '\n');
    // Complete caller anchor in both native formats. Scripted workers have no
    // host process or open descriptors; real harness children run in the repo.
    return { status: 0, signal: null, stdout: `p${process.pid}\0\nfcwd\0n${cwd}\0\n`, stderr: '' };
  }
  if (String(file).includes('/lib/native/process-source-')) {
    if (!args.some(a => /^[1-9]\d*$/.test(a))) throw Error('unscoped host process inventory forbidden in installed fixture');
    fs.appendFileSync(path.join(root, 'evidence/native-observations.jsonl'), JSON.stringify({ file, args, caller: process.pid }) + '\n');
  }
  return original.call(this, file, args, options);
};
syncBuiltinESMExports();
