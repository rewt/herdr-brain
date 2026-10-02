// Entry creation receipts and foreground recovery. Display-only lane session
// metadata is never consulted; removal requires fresh Git and record facts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gitProject } from '../lib/project.mjs';
import { withLock, loadEvents } from '../lib/store.mjs';
import { plainDirectory, readPlainFile, removePlainDirectory, writeFileAtomic } from '../lib/files.mjs';

export function worktreeDirectory(selected, identity) {
  let prefix = path.resolve(selected ?? path.join(fs.realpathSync(os.homedir()), '.herdr/worktrees',
    createHash('sha256').update(identity).digest('hex').slice(0, 16)));
  const missing = [];
  for (;;) {
    try { fs.lstatSync(prefix); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(prefix);
      if (parent === prefix) throw error;
      missing.unshift(path.basename(prefix)); prefix = parent;
    }
  }
  // This is an operator-selected root. Resolve its existing prefix once;
  // subsequent creation and agent-writable descendants keep no-follow checks.
  return plainDirectory(path.join(fs.realpathSync(prefix), ...missing));
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export function entryLifecycle({ project, coordination, git, externalGit }) {
  const directory = plainDirectory(path.join(coordination, 'entries'));
  const file = (receipt) => path.join(directory, `${receipt.topic}.json`);
  const save = (receipt) => writeFileAtomic(file(receipt), JSON.stringify(receipt) + '\n', 0o600);
  const keep = (receipt, reason) => {
    console.error(`monitor entry: keeping ${receipt.branch} at ${receipt.workspace}: ${reason}`);
    return false;
  };
  const live = (receipt) => receipt.owners.some(alive);
  const valid = (receipt, name) => receipt?.version === 1 && /^entry-[0-9a-f]{12}$/u.test(receipt.topic)
    && name === `${receipt.topic}.json` && receipt.branch === `lane/${receipt.topic}`
    && /^[0-9a-f]{32}$/u.test(receipt.id) && receipt.topic === `entry-${receipt.id.slice(0, 12)}`
    && receipt.identity === project.identity && receipt.canonical === project.canonical
    && typeof receipt.workspace === 'string' && path.isAbsolute(receipt.workspace)
    && /^[0-9a-f]{40,64}$/u.test(receipt.base) && typeof receipt.main === 'string'
    && typeof receipt.org === 'string' && path.isAbsolute(receipt.org)
    && typeof receipt.log === 'string' && path.isAbsolute(receipt.log)
    && Array.isArray(receipt.owners) && receipt.owners.every((pid) => Number.isSafeInteger(pid) && pid > 0)
    && ['requests', 'metadata'].every((key) => receipt[key] === undefined
      || (typeof receipt[key] === 'string' && path.isAbsolute(receipt[key]) && path.basename(receipt[key]) === receipt.id));
  const removeRuntime = (receipt) => {
    if (receipt.metadata) {
      const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir'], receipt.workspace);
      if (receipt.metadata !== path.join(gitDir, 'monitor-entry', receipt.id)) throw new Error('entry metadata path changed');
    }
    for (const name of ['requests', 'metadata']) if (receipt[name]) removePlainDirectory(receipt[name]);
  };
  // Called only under the coordination lock. A receipt identifies a candidate;
  // it cannot authorize deletion without the current Git identity, original
  // base, complete record history, dead owners and cleanliness including ignores.
  const cleanup = (receipt) => {
    if (live(receipt)) return false;
    const now = gitProject(receipt.workspace);
    if (now.identity !== project.identity || now.canonical !== project.canonical || now.checkout !== receipt.workspace)
      return keep(receipt, 'Git identity changed');
    if (git(['branch', '--show-current'], receipt.workspace) !== receipt.branch
      || git(['branch', '--show-current']) !== receipt.main) return keep(receipt, 'assigned or integration branch changed');
    externalGit(receipt.workspace); externalGit(project.canonical);
    return withLock(receipt.org, () => {
      if (fs.realpathSync(path.join(receipt.org, 'events.jsonl')) !== receipt.log) return keep(receipt, 'record path changed');
      const { events, tornTail } = loadEvents(receipt.org);
      if (tornTail) return keep(receipt, 'record history has an incomplete tail');
      if (live(receipt)) return false;
      removeRuntime(receipt);
      if (events.some((event) => {
        if (event.type !== 'run.started' || !event.workspace) return false;
        if (path.resolve(event.workspace) === receipt.workspace) return true;
        try { return fs.realpathSync(event.workspace) === receipt.workspace; } catch { return false; }
      })) {
        keep(receipt, 'a run was started in this lane');
        // A recorded lane is permanently outside untouched-lane recovery.
        fs.unlinkSync(file(receipt)); return false;
      }
      if (git(['rev-list', `${receipt.base}..${receipt.branch}`])) return keep(receipt, 'commits beyond its creation base');
      if (git(['status', '--porcelain', '--untracked-files=all', '--ignored'], receipt.workspace))
        return keep(receipt, 'modified, untracked or ignored files');
      if (live(receipt)) return false;
      // No force. Ignore files count as work even though Git itself would allow
      // their removal. Preserve the branch if Git refuses either operation.
      git(['worktree', 'remove', receipt.workspace]);
      git(['branch', '-d', receipt.branch]);
      fs.unlinkSync(file(receipt));
      return true;
    });
  };
  const sweepLocked = () => {
    for (const name of fs.readdirSync(directory).filter((name) => /^entry-[0-9a-f]{12}\.json$/u.test(name))) {
      try {
        const receipt = JSON.parse(readPlainFile(path.join(directory, name)));
        if (!valid(receipt, name)) { console.error(`monitor entry: keeping ${name}: invalid creation receipt`); continue; }
        cleanup(receipt);
      } catch (error) { console.error(`monitor entry: keeping ${name}: ${error.message}`); }
    }
  };
  let own;
  return {
    sweep: () => withLock(coordination, sweepLocked),
    allocate({ id, topic, workspace, main, org }) {
      withLock(coordination, () => {
        sweepLocked();
        const base = git(['rev-parse', '--verify', `${main}^{commit}`]);
        git(['worktree', 'add', '-b', `lane/${topic}`, workspace, base]);
        own = { version: 1, id, topic, workspace, base, main, org, log: fs.realpathSync(path.join(org, 'events.jsonl')),
          identity: project.identity, canonical: project.canonical, branch: `lane/${topic}`, owners: [process.pid] };
        save(own);
      });
    },
    attachChild(pid) {
      if (!own || !pid) return;
      own.owners.push(pid);
      withLock(coordination, () => save(own));
    },
    runtime({ requests, metadata }) {
      if (!own) return;
      Object.assign(own, { requests, metadata });
      withLock(coordination, () => save(own));
    },
    close() {
      if (!own) return;
      withLock(coordination, () => {
        own.owners = own.owners.filter((pid) => pid !== process.pid && alive(pid));
        save(own);
        if (live(own)) return;
        removeRuntime(own);
        try { cleanup(own); } catch (error) { keep(own, error.message); }
      });
    },
  };
}
