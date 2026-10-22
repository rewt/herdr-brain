// Routing checks, not native execution provenance. The operator's sandbox is
// the hard boundary, including on hosts where every identity shares a UID.
import fs from 'node:fs';
import { gitProject } from '../lib/project.mjs';
import { identityRootAt } from '../messages/journal.mjs';

export const identityRefusal = (code, reason) => Object.assign(Error(`${code}: ${reason}`), { code });
export function executionIdentity(project, { cwd = process.cwd(), bound } = {}) {
  let callerRoot, projectRoot;
  try {
    callerRoot = identityRootAt(fs.realpathSync(cwd));
    projectRoot = identityRootAt(fs.realpathSync(project.identity));
  } catch (error) { throw identityRefusal('PROMOTION_IDENTITY_AMBIGUOUS', error.message); }
  if (callerRoot !== projectRoot) throw identityRefusal('PROMOTION_IDENTITY_MISMATCH', 'caller and project identity roots differ');
  let caller;
  try { caller = gitProject(cwd, { env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))) }); }
  catch { throw identityRefusal('PROMOTION_PROJECT_MISMATCH', 'caller must be in the project checkout or one of its linked worktrees'); }
  if (caller.identity !== project.identity || caller.canonical !== project.canonical)
    throw identityRefusal('PROMOTION_PROJECT_MISMATCH', 'caller Git common directory differs from the project');
  const binding = { caller_root: callerRoot, project_root: projectRoot, common: project.identity };
  if (bound !== undefined && (!bound || Object.keys(binding).some(key => bound[key] !== binding[key])))
    throw identityRefusal('PROMOTION_IDENTITY_BINDING_CHANGED', 'job or attempt identity root changed; explicit owner disposition required');
  return binding;
}
