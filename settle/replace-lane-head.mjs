// Reserve the named ref before touching files; HEAD/index locks exclude ordinary
// checkout and commit operations in this worktree throughout the replacement.
import { loadTimeout } from '../lib/deadline.mjs';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const plan = JSON.parse(process.argv[2]);
const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
function git(args, cwd = plan.workspace, extraEnv = {}) {
  const r = spawnSync('git', args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(r.stderr || r.error?.message || `Git exit ${r.status}`);
  return r.stdout.trim();
}
function verify() {
  for (const cwd of [plan.workspace, plan.repo]) {
    if (fs.realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)) !== plan.common) throw new Error('Git common-directory identity changed');
    if (git(['status', '--porcelain=v1', '--untracked-files=all'], cwd)) throw new Error('worktree changed before lane-head replacement');
  }
  if (git(['symbolic-ref', 'HEAD']) !== plan.branch || git(['rev-parse', 'HEAD']) !== plan.from) throw new Error('lane HEAD or branch moved; lane-head replacement refused');
  if (git(['rev-parse', plan.main], plan.repo) !== plan.mainHead) throw new Error('base branch moved; lane-head replacement refused');
}

const locks = [];
let child, completed, uncertain = false;
try {
  const index = git(['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const headLock = `${git(['rev-parse', '--path-format=absolute', '--git-path', 'HEAD'])}.lock`;
  const indexLock = `${index}.lock`;
  for (const file of [headLock, indexLock]) {
    const fd = fs.openSync(file, 'wx', 0o600); locks.push(file); fs.closeSync(fd);
  }
  verify();
  child = spawn('git', ['update-ref', '--no-deref', '-m', 'settle: apply proved mechanical rebase', '--stdin'], {
    // Run from the canonical checkout so update-ref does not try to lock the
    // lane's HEAD again for its automatic HEAD reflog entry. We own that lock.
    cwd: plan.repo, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  completed = once(child, 'close');
  completed.catch(() => {});
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  async function command(text, response) {
    child.stdin.write(`${text}\n`);
    let timer;
    try {
      const line = await Promise.race([lines.next(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Git ref transaction timed out')), loadTimeout(15_000));
      })]);
      if (line.done || line.value !== `${response}: ok`) throw new Error(stderr || `Git ref transaction refused ${response}`);
    } finally { clearTimeout(timer); }
  }
  await command('start', 'start');
  child.stdin.write(`update ${plan.branch} ${plan.to} ${plan.from}\n`);
  await command('prepare', 'prepare'); // CAS verifies and locks this exact branch.
  verify(); // HEAD cannot switch and the reserved branch cannot advance.
  fs.copyFileSync(index, indexLock);
  // An alternate index lets Git perform its two-tree, edit-preserving checkout
  // while we retain the real index.lock for the entire ref transaction.
  uncertain = true;
  git(['read-tree', '-m', '-u', plan.from, plan.to], plan.workspace, { GIT_INDEX_FILE: indexLock });
  await command('commit', 'commit');
  fs.renameSync(indexLock, index);
  locks.splice(locks.indexOf(indexLock), 1);
  uncertain = false;
  child.stdin.end();
  const [code] = await completed;
  if (code !== 0) throw new Error(stderr || `Git ref transaction exit ${code}`);
} catch (error) {
  process.stderr.write(`${error.message.trim()}${uncertain ? '; checkout outcome uncertain: retained HEAD/index locks require inspection' : ''}\n`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) { child.stdin.destroy(); child.kill(); await completed.catch(() => {}); }
  // Never erase pre-existing locks. An uncertain partial checkout keeps ours.
  if (!uncertain) for (const file of locks.reverse()) fs.unlinkSync(file);
}
