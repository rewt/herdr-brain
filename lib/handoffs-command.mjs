import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { UserError, writer } from './store.mjs';
import { handoffKey, handoffScope, prepareHandoff, readHandoff, missingHandoffSections, recordedHandoffs } from './handoffs.mjs';
import { renderHandoff, renderHandoffTemplate, renderHandoffCheck } from './render.mjs';

export function handoffsCommand(argv, { openOrg, mutate, out }) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    workspace: { type: 'string' }, slot: { type: 'string' }, file: { type: 'string' }, json: { type: 'boolean' },
  } });
  const [action] = positionals;
  if (positionals.length !== 1 || !['write', 'latest', 'template', 'check'].includes(action))
    throw new UserError('usage: record handoffs write|latest --workspace W --slot S [--file PATH] [--json] | template | check --file PATH');
  if (action === 'template') { out(renderHandoffTemplate()); return 0; }
  if (['write', 'check'].includes(action) && !values.file) throw new UserError('--file is required');
  if (action === 'check') {
    const doc = { missing_sections: missingHandoffSections(fs.readFileSync(values.file, 'utf8')) };
    out(values.json ? JSON.stringify(doc) + '\n' : renderHandoffCheck(doc)); return 0;
  }
  handoffScope(values.workspace, values.slot);
  const ctx = openOrg({ readOnly: action === 'latest' });
  let entry;
  if (action === 'write') {
    const bytes = fs.readFileSync(values.file);
    const { added } = mutate(ctx, (_state, events) => ({ add: [prepareHandoff(ctx.dir, events, {
      workspace: values.workspace, slot: values.slot, bytes, author: writer().actor, at: ctx.now,
    })] }));
    entry = added[0];
  } else entry = recordedHandoffs(ctx.events).get(handoffKey(values.workspace, values.slot));
  if (!entry) throw new UserError(`no recorded handoff for ${values.workspace}/${values.slot}`);
  const doc = readHandoff(ctx.dir, entry);
  out(values.json ? JSON.stringify(doc) + '\n' : renderHandoff(doc) + '\n' + renderHandoffCheck(doc));
  return 0;
}
