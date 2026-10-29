// Stopped runtime handoffs share the line pass's positive-ESRCH recovery.
// Control and promotion owners have no automatic recovery authority here.
import path from 'node:path';
import { noticeLock } from '../supervisor/notice-lock.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { transact } from '../lib/store.mjs';

export function withRuntimeLocks(c, { id, operation, dryRun, owner, validate }, action) {
  const onRecovery = recovery => {
    const prior = recovery.owner;
    // Legacy pass owners record at/argv rather than a kernel birth. A present
    // PID always refuses, even if its recorded identity appears different.
    if (!(typeof prior.identity === 'string' && prior.identity.trim()) &&
        !(typeof prior.at === 'string' && Number.isFinite(Date.parse(prior.at)) &&
          Array.isArray(prior.argv) && prior.argv.length && prior.argv.every(a => typeof a === 'string')))
      throw Error(`locked: ${recovery.directory}; recorded owner identity is missing`);
    transact(c.org, () => {
      validate();
      return { add: [{ type: 'line-service.lock-recovery', schema: 'line-lock-recovery/v1',
        id, operation, dry_run: dryRun, project: c.identity, repo: c.repo, org: c.org,
        native_caller: owner.native, ...recovery }] };
    }, { actor: owner.native.name, strictTail: true, lockOptions: { recover: false } });
  };
  const releaseControl = noticeLock(path.join(c.directory, 'control.lock'), { recover: false });
  try {
    const releasePass = noticeLock(path.join(c.directory, 'pass.lock'), { onRecovery });
    try {
      const releasePromotion = acquireLock(path.join(c.identity, 'lane-promote.lock'));
      try { return action(); } finally { releasePromotion(); }
    } finally { releasePass(); }
  } finally { releaseControl(); }
}
