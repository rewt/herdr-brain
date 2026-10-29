// Shared identity discovery for foreground readers; no projection or writes.
import path from 'node:path';
import { homeProject, projectIdentity } from '../lib/config-home.mjs';
import { gitProject } from '../lib/project.mjs';
import { identityRootAt } from './journal.mjs';

export async function identityAt(commonDir, env = process.env) {
  const checkout = path.dirname(commonDir);
  let project;
  try { project = gitProject(checkout, { env }); } catch { /* Legacy explicit shadow partitions need no live checkout. */ }
  if (project) {
    const home = homeProject(project.canonical, env);
    if (home) return home.identity;
  }
  if (env.BRAIN_IDENTITY) return env.BRAIN_IDENTITY;
  const root = identityRootAt(commonDir);
  if (root) return path.basename(root);
  if (project) return projectIdentity(project, env).name;
  throw Error('shadow identity is unenrolled; set BRAIN_IDENTITY or use an identity-root checkout');
}
