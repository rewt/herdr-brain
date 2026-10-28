import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { completedSession } from '../lib/completion-session.mjs';
import { gitProject } from '../lib/project.mjs';
import { loadDiscoveredRoutes } from '../lanes/routes.mjs';

export function resumeSource({ events, session, item, lane, harness, repo }) {
  const saved = completedSession(events, session);
  if (!saved) throw Error('resume requires a completion record carrying the saved session identity');
  if (saved.harness !== harness) throw Error('resume harness differs from the completion record');
  if (![item.id, item.meta?.review_source_item].includes(saved.item)) throw Error('saved session belongs to another item');
  const { workspace, branch, lane: topic } = saved.resume ?? {};
  if (!workspace || !path.isAbsolute(workspace) || topic !== lane || branch !== `lane/${lane}`)
    throw Error('resume requires the original recorded lane and worktree path');
  const project = gitProject(repo);
  const git = args => execFileSync('git', ['-C', project.canonical, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const trees = git(['worktree', 'list', '--porcelain']).split('\n\n');
  const tree = trees.find(row => row.split('\n').includes(`branch refs/heads/${branch}`));
  const registered = tree?.split('\n').find(line => line.startsWith('worktree '))?.slice(9);
  if (registered && registered !== workspace) throw Error('saved resume branch is allocated at a different path');
  if (fs.existsSync(workspace)) {
    if (!registered || fs.realpathSync(workspace) !== workspace) throw Error('saved resume path has another allocation');
    if (execFileSync('git', ['-C', workspace, 'status', '--porcelain=v1'], { encoding: 'utf8' }).trim())
      throw Error(`unsaved author work kept at ${workspace}; preserve or commit it before resume`);
  } else if (registered) throw Error('saved resume worktree registration remains without its folder');
  const { layers } = loadDiscoveredRoutes({ cwd: project.canonical, canonical: project.canonical });
  const main = Object.assign({}, ...layers.map(layer => layer.config)).main ?? 'main';
  const integration = git(['rev-parse', '--verify', `refs/heads/${main}^{commit}`]);
  const kept = git(['for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`]);
  let unlanded = Boolean(kept);
  if (kept) {
    try { git(['merge-base', '--is-ancestor', kept, integration]); unlanded = false; }
    catch (error) { if (error.status !== 1) throw error; }
  }
  return { run: saved.run, workspace, branch, base: unlanded ? kept : integration };
}
