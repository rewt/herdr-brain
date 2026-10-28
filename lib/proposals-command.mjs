import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { proposalIntakeEvents, proposalDisposition, proposalToken, proposalMetrics } from './proposal-intake.mjs';
import { reviewResultEvents } from '../line-service/phase1.mjs';
import { nativeSender } from '../messages/operator-inbox.mjs';
import { readProjectPolicy } from './config-policy.mjs';
import { lineDirectory } from '../line-service/cutoff.mjs';
import { readReport } from './report.mjs';
import { UserError } from './store.mjs';

// Existing saved/UNKNOWN dispatches are protection, never replacement authority.
function attemptedItems(org, identity) {
  const items = new Set(), directory = path.join(org, 'dispatch');
  if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory).filter(n => n.endsWith('.json') && !n.endsWith('.routes.json'))) {
    const saved = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    if (saved.item ?? saved.job?.item) items.add(saved.item ?? saved.job.item);
  }
  const file = path.join(lineDirectory(org, identity), 'effects.json');
  if (fs.existsSync(file)) {
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!journal || !journal.actions || typeof journal.actions !== 'object' || Array.isArray(journal.actions))
      throw new UserError('saved dispatch effects are UNKNOWN; retain proposal');
    for (const key of Object.keys(journal.actions)) if (key.startsWith('dispatch:')) items.add(key.split(':')[1]);
  }
  return [...items];
}

export async function proposalsCommand(argv, { openOrg, mutate, out }) {
  const [action, ...rest] = argv;
  const { values:v, positionals } = parseArgs({ args:rest, allowPositionals:true, options:Object.fromEntries(
    ['index', 'cut', 'expect', 'into', 'key', 'successor-expect', 'why'].map(k => [k, { type:'string' }])) });
  const ctx = openOrg(), id = positionals[0];
  if (action === 'metrics' && !positionals.length) { out(JSON.stringify(proposalMetrics(ctx.events), null, 2) + '\n'); return 0; }
  if (!id || positionals.length !== 1) throw new UserError('usage: record proposals file|token|lapse|duplicate ID [options] | metrics');
  if (action === 'token') { if (!ctx.state.items.has(id)) throw new UserError('unknown proposal'); out(proposalToken(ctx.state, id) + '\n'); return 0; }
  if (action === 'file') {
    const index = Number(v.index);
    if (v.index === undefined || !Number.isSafeInteger(index) || index < 0) throw new UserError('file requires a nonnegative --index');
    const { result } = mutate(ctx, (state, events) => {
      const run = state.runs.get(id);
      if (!run?.report) throw new UserError('file requires the original ingested report');
      const file = path.resolve(ctx.dir, run.report.file), bytes = fs.readFileSync(file, 'utf8');
      if (!file.startsWith(ctx.dir + path.sep) || fs.realpathSync(file) !== file ||
          createHash('sha256').update(bytes).digest('hex') !== run.report.sha256) throw new UserError('immutable source report changed');
      const parsed = readReport(bytes);
      if (parsed.errors.length || !parsed.report.proposals[index]) throw new UserError('proposal index is missing from the immutable report');
      const add = proposalIntakeEvents({ state, events, run, report:parsed.report, sha256:run.report.sha256, indices:[index] });
      // Formal engineer re-filing stays entirely in ENG673's shared helper.
      const review = reviewResultEvents({ state, events, run, report:parsed.report, sha256:run.report.sha256, body:parsed.body,
        usedIds:add.filter(e => e.type === 'item.added').map(e => e.id) });
      return { add:[...add, ...review], result:{ run:id, index, reused:!add.some(e => e.type === 'item.added') && !review.some(e => e.type === 'item.added') } };
    });
    out(JSON.stringify(result) + '\n'); return 0;
  }
  if (!['lapse', 'duplicate'].includes(action) || !v.expect || !v.why ||
      action === 'duplicate' && (!v.into || !v.key || !v['successor-expect'])) throw new UserError('explicit disposition needs current tokens, reason and cut or typed successor');
  const { result } = mutate(ctx, (state, events) => {
    // Actual native owner and canonical policy, never an actor/display name or
    // caller-supplied supervisor override. No new service or standing authority.
    const binding = nativeSender(ctx.dir), repo = binding.project.canonical;
    const policyEnv = { ...process.env };
    for (const key of ['LANE_CONFIG', 'PROMOTE_CONFIG', 'MONITOR_SUPERVISOR_AGENT']) delete policyEnv[key];
    const supervisor = readProjectPolicy(repo, 'promote', policyEnv, { canonical:repo }).config.to;
    if (!supervisor || binding.native.name !== supervisor) throw new UserError('proposal dispositions require the actual owning PROJECT SUPERVISOR');
    for (const file of [path.join(lineDirectory(ctx.dir, binding.project.identity), 'STOP'), path.join(repo, '.lane/supervisor/STOP'), path.join(repo, '.lane/supervisor/HOLD')])
      if (fs.existsSync(file)) throw new UserError('STOP/HOLD prevents proposal disposition');
    return proposalDisposition({ state, events, id, expect:v.expect, cut:v.cut,
      successor:action === 'duplicate' ? v.into : undefined, successorExpect:v['successor-expect'], key:v.key, why:v.why,
      authority:{ native_caller:binding.native, project:binding.project.identity, org:binding.org },
      attempted:attemptedItems(ctx.dir, binding.project.identity) });
  });
  out(JSON.stringify(result) + '\n'); return 0;
}
