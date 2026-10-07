// Explicit supervisor launch receipts, independent of native chat/session ids.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gitProject } from '../lib/project.mjs';

const bindingFile = (project, pane) => path.join(project.canonical, '.lane/supervisor/panes',
  `${createHash('sha256').update(pane).digest('hex')}.json`);

export function supervisorBinding(project, pane) {
  if (!pane || project.checkout !== project.canonical) return null;
  let saved;
  try { saved = JSON.parse(fs.readFileSync(bindingFile(project, pane), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (saved.role !== 'supervisor' || saved.pane !== pane || saved.canonical !== project.canonical ||
      saved.identity !== project.identity || !path.isAbsolute(saved.org ?? '')) return null;
  if (fs.realpathSync(saved.org) !== saved.org) throw new Error('supervisor record binding changed');
  return saved;
}

export function rememberSupervisor(context, env) {
  const pane = env.HERDR_PANE_ID;
  if (!pane) return;
  const project = gitProject(context.canonical);
  if (project.identity !== context.identity || project.canonical !== context.canonical) throw new Error('supervisor launch identity changed');
  const file = bindingFile(project, pane);
  // Explicitly repurposing the pane as a worker revokes its old supervisor role.
  if (context.role !== 'supervisor') { fs.rmSync(file, { force: true }); return; }
  const saved = { role: 'supervisor', pane, canonical: project.canonical, identity: project.identity,
    org: fs.realpathSync(context.org), to: env.MONITOR_SUPERVISOR_AGENT || null,
    session_kind: ['chat', 'combined'].includes(env.MONITOR_SESSION_KIND) ? env.MONITOR_SESSION_KIND : 'ops' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(saved) + '\n', { mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
