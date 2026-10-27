// A completion owner joins a finite, freshly resolved closer outside its locks.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitProject } from './project.mjs';
import { loadEvents } from './store.mjs';
import { loadedCloseoutCode, resolveFreshCloseoutCode } from './closeout-code.mjs';
import {closeoutEvaluations} from './closeout.mjs';

export function joinedCloseoutAttempt({ cwd, org, keys, env = process.env, deadline = Date.now() + 180000 } = {}) {
  if (!keys.length) return { complete: true, outcomes: [] };
  const project = gitProject(cwd), root = resolveFreshCloseoutCode(project);
  const childEnv = { ...env };
  for (const key of ['HERDR_TAB_ID', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'LANE_CONFIG', 'LANE_VALIDATE']) delete childEnv[key];
  const child = spawnSync(process.execPath, [path.join(root, 'supervisor/closeout.mjs'), 'drain', '--repo', project.canonical,
    '--org', org, '--keys', JSON.stringify(keys), '--deadline', String(deadline)],
  { cwd: project.canonical, env: childEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (child.error || child.status !== 0) return { complete: false, reason: child.stderr || child.error?.message || 'closer startup/attempt failed; explicit drain required' };
  // A pre-existing owner may have accepted the handoff. Observe its durable
  // outcome and claim release; never mistake a detached launch for completion.
  const lock = path.join(project.identity, 'closeout/consumer.lock');
  while (fs.existsSync(lock) && Date.now() < deadline)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(25, deadline - Date.now()));
  if (fs.existsSync(lock)) return { complete: false, reason: 'closer deadline; surviving owner retains claim and needs inspection' };
  const { events, tornTail } = loadEvents(org);
  if (tornTail) return { complete: false, reason: 'incomplete closeout outcome record; cleanup pending' };
  const observed=new Map(closeoutEvaluations(project.identity,fs.realpathSync(org),events).map(e=>[e.key,e]));
  const outcomes = keys.map(key => observed.get(key));
  return { complete: outcomes.every(e => e?.completed), outcomes,
    ...(outcomes.every(e => e?.completed) ? {} : { reason: outcomes.filter(e => !e?.completed).map(e => e?.reason ?? 'completion handoff remains pending; explicit drain required').join('; ') }) };
}

// The stale owner has already released both claims before calling this. One
// successor only; a second epoch change leaves the exact keys for explicit drain.
export function restartCloseout({ cwd, org, restart, env = process.env, deadline, noRestart = false }) {
  if (noRestart || !restart.keys.length) return { pending: true, reason: 'fresh drain required', keys: restart.keys };
  const project = gitProject(cwd), root = resolveFreshCloseoutCode(project, restart.old?.code ?? loadedCloseoutCode.identity);
  const child = spawnSync(process.execPath, [path.join(root, 'supervisor/closeout.mjs'), 'drain', '--repo', project.canonical,
    '--org', org, '--keys', JSON.stringify(restart.keys), '--no-restart', ...(deadline ? ['--deadline', String(deadline)] : [])],
  { cwd: project.canonical, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { root, exit: child.status, pending: Boolean(child.error || child.status !== 0),
    ...(child.error || child.status !== 0 ? { reason: child.stderr || child.error?.message || 'fresh restart failed; explicit drain required' } : {}) };
}
