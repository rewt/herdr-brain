// Ownership for transport-only fixtures whose record CLI is deliberately fake.
import fs from 'node:fs';
import path from 'node:path';
import { brainOwner, admittedRelease } from '../../lib/run-owner.mjs';
import { gitProject } from '../../lib/project.mjs';
export function seedOwnedRun(org, run, { workspace = null, release, controller = 'brain' } = {}) {
  fs.mkdirSync(org, { recursive: true });
  org = fs.realpathSync(org);
  let project = null;
  if (workspace) project = gitProject(workspace).identity;
  const owner = release ? { controller, legacy: false, release: admittedRelease(release.root) } : brainOwner(controller);
  const stamp = { at: new Date().toISOString(), by: 'ownership-fixture' };
  fs.writeFileSync(path.join(org, 'events.jsonl'), [
    { ...stamp, seq: 1, type: 'run.started', id: run, item: 'ENG-9', workspace, meta: {} },
    { ...stamp, seq: 2, type: 'run.claimed', run, record: org, project, owner },
  ].map(e => JSON.stringify(e) + '\n').join(''));
  return owner;
}
