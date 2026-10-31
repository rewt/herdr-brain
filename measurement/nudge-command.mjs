import fs from '../lib/record-observation.mjs';
import { parseArgs } from 'node:util';
import { UserError, findOrgDir } from '../lib/store.mjs';
import { gitProject } from '../lib/project.mjs';
import { checkFleetRecord } from '../lib/fleet.mjs';
import { timestamp } from './lifecycle.mjs';

export const NUDGE_TYPE = 'lifecycle.manual-nudge';

// An explicit journal only. Recording does not execute or authorize the action.
export function nudgeCommand(argv, { openOrg, mutate, out }) {
  const keys = ['id', 'run', 'project', 'actor', 'occurred-at', 'stage', 'action', 'reason', 'evidence'];
  const { values: opt, positionals } = parseArgs({ args: argv, allowPositionals: true,
    options: Object.fromEntries(keys.map(key => [key, { type: 'string' }])) });
  if (positionals.length || keys.some(key => !opt[key]?.trim()))
    throw new UserError('usage: record nudge --id ID --run R-n --project COMMON_DIR --actor NAME --occurred-at ISO_TIME --stage STAGE --action TEXT --reason TEXT --evidence REF');
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(opt.id)) throw new UserError('nudge id must be a stable identifier (at most 200 characters)');
  if (timestamp(opt['occurred-at']) === null) throw new UserError('occurred-at must be a timestamp with timezone');
  const ctx = openOrg();
  const { result } = mutate(ctx, (state, events) => {
    // Keep project/config observations in the transaction's existing source
    // seal, alongside the fresh run scope and stable-ID check.
    const project = gitProject();
    let identity;
    try { identity = fs.realpathSync(opt.project); } catch { throw new UserError('project must be an existing Git common directory'); }
    if (identity !== project.identity) throw new UserError('project does not match the current Git common directory');
    const bound = checkFleetRecord(ctx.dir);
    const discovered = bound?.record ?? findOrgDir({ cwd: project.canonical, env: { ...process.env, ORG_DIR: '' } });
    if ((bound && (bound.identity !== project.identity || bound.checkout !== project.canonical)) ||
        !discovered || fs.realpathSync(discovered) !== fs.realpathSync(ctx.dir))
      throw new UserError('record does not belong to the current project');
    const run = state.runs.get(opt.run);
    if (!run || run.meta?.dispatch_project !== identity) throw new UserError('run is missing or belongs to a different/unscoped project');
    const occurred = timestamp(opt['occurred-at']);
    if (timestamp(run.started.at) === null || occurred < timestamp(run.started.at) || occurred > ctx.now.getTime())
      throw new UserError('occurred-at must be between run start and recording time');
    const event = { type: NUDGE_TYPE, nudge_id: opt.id, run: run.id, item: run.item, project: identity,
      actor: opt.actor.trim(), occurred_at: new Date(occurred).toISOString(), stage: opt.stage.trim(), action: opt.action.trim(),
      reason: opt.reason.trim(), evidence: opt.evidence.trim() };
    const existing = events.find(e => e.type === NUDGE_TYPE && e.nudge_id === opt.id);
    if (existing) {
      if (Object.keys(event).some(key => existing[key] !== event[key])) throw new UserError('nudge id already exists with different content; retain the original event');
      return { add: [], result: { recorded: false, reused: true, event: existing } };
    }
    return { add: [event], result: { recorded: true, reused: false } };
  });
  out(JSON.stringify(result) + '\n');
  return 0;
}
