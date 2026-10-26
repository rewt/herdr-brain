import fs from 'node:fs';
import path from 'node:path';
import { quote } from '../lib/shell.mjs';
import { coldStart, renderColdStart } from './context.mjs';

export function supervisorPolicy(context, root) {
  const command = `${quote(process.execPath)} ${quote(path.join(root, 'supervisor/supervisor.mjs'))}`;
  const protocol = fs.readFileSync(path.join(root, 'supervisor/PROTOCOL.md'), 'utf8');
  return `${protocol}\nSupervisor command: ${command}\nOrdinary self-landing and report/review/promotion follow-up belong to the recorded worker. Consume its verification receipt once; reserve supervisor mutations for actual exceptions/recovery. Retain bootstrap watchers and forward ordinary follow-up to their recorded owner without duplicate intake/review.
Use --repo ${quote(context.canonical)} --org ${quote(context.org)} on supervisor commands; mutations also require --role supervisor and the canonical checkout. Workers never borrow this role.
Foreground session refresh: ${command} entry --repo ${quote(context.canonical)} --org ${quote(context.org)} --role supervisor.\nCold start (no model, no pane mutations):\n${renderColdStart(coldStart({ cwd: context.canonical, org: context.org }))}`;
}
