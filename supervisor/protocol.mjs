import fs from 'node:fs';
import path from 'node:path';
import { quote } from '../lib/shell.mjs';
import { coldStart, renderColdStart } from './context.mjs';

export function supervisorPolicy(context, root) {
  const command = `${quote(process.execPath)} ${quote(path.join(root, 'supervisor/supervisor.mjs'))}`;
  const protocol = fs.readFileSync(path.join(root, 'supervisor/PROTOCOL.md'), 'utf8');
  return `${protocol}\nSupervisor command: ${command}\nUse --repo ${quote(context.canonical)} --org ${quote(context.org)} on each command below; mutations also require --role supervisor.
Manual recovery when native hooks are unavailable or untrusted: ${command} entry --repo ${quote(context.canonical)} --org ${quote(context.org)} --role supervisor.\nCold start (no model, no pane mutations):\n${renderColdStart(coldStart({ cwd: context.canonical, org: context.org }))}`;
}
