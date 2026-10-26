// Review work uses ordinary record items and normal dispatch, never a second queue.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir } from '../lib/store.mjs';
import { nextItemId } from '../lib/state.mjs';
import { roleIs } from '../lib/roles.mjs';
import { readOwnedRun, requireController, assertOwner } from '../lib/run-owner.mjs';
import { effectiveWorkerIdentity } from '../lib/worker-identity.mjs';
import { nativeSender } from '../messages/operator-inbox.mjs';
import { selectRoute } from '../lanes/routes.mjs';
import { bindReviewTarget, reviewAttempt } from './review.mjs';

const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const files = ['line-service/review-queue.mjs', 'line-service/review.mjs', 'bin/org.mjs', 'dispatch/dispatch.mjs', 'dispatch/unlanded-cap.mjs'];
const hashes = files.map(file => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const git = (repo, args) => execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const journalFor = (org, identity) => path.join(org, 'line-service', createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 20), 'effects.json');

export const isQueueReview = item => roleIs(item, 'REV') && Boolean(item.meta.review_source_item);
export const reviewQueueRoute = config => config.routes?.reviewer ? 'reviewer' : selectRoute(config, 'review');
function openBoundary(org, repo, identity) {
  for (const file of [journalFor(org, identity).replace(/effects\.json$/, 'STOP'), path.join(repo, '.lane/supervisor/STOP'), path.join(repo, '.lane/supervisor/HOLD')])
    if (fs.existsSync(file)) throw Error('STOP/HOLD prevents review queue effect');
}
export function queueConsumer({ run, env = process.env }) {
  // Both NEW entry points explicitly support this matching development selector.
  // No installed/pinned/saved owner is substituted or rewritten.
  if (env.HERDR_BRAIN_ROOT && fs.realpathSync(env.HERDR_BRAIN_ROOT) !== root) throw Error('queue source selector differs from actual implementation');
  if (run.owner?.legacy || run.owner?.release?.id !== 'source' || fs.realpathSync(run.owner?.release?.root ?? '.') !== root ||
      run.owner.release.identity !== gitProject(root).identity) throw Error('saved/legacy queue consumer is UNKNOWN; retain owner and existing attempt');
  for (let i = 0; i < files.length; i++) if (createHash('sha256').update(fs.readFileSync(path.join(root, files[i]))).digest('hex') !== hashes[i]) throw Error('loaded queue/dispatch implementation changed; wait for next real pass');
  return root;
}
function source({ state, events, org, repo, identity, runId }) {
  const run = state.runs.get(runId), item = run && state.items.get(run.item);
  if (!run || !item || !roleIs(item, 'ENG') || run.abandoned || item.runs.at(-1) !== run.id || !run.report) throw Error('review queue needs the current reported build run');
  if (roleIs(state.items.get(item.parent), 'REV')) throw Error('linked formal correction retains its original review; no automatic re-review chain');
  if (item.closed?.as === 'dropped' || item.meta.hold || item.meta.held || item.meta.operator_reserved || item.meta.reserved ||
      ['security', 'funds-and-chain', 'publish', 'delete-data', 'licensing', 'priorities'].includes(item.meta.category)) throw Error('held/reserved/dropped source is not review-queue authority');
  const current = readOwnedRun(org, run.id);
  requireController(current, 'brain'); assertOwner(current, { owner: run.owner, generation: run.owner_generation });
  queueConsumer({ run });
  const target = bindReviewTarget({ item, run, events, org, repo, identity });
  try { git(repo, ['merge-base', '--is-ancestor', target.head, 'HEAD']); }
  catch { throw Error('review source is not actually landed in the canonical project'); }
  return { run, item, target };
}
function ignoreIntent(org, identity, item, target) {
  return { file: journalFor(org, identity), key: `review:${item.id}`, target, operation: 'record-queue' };
}

// Called inside the existing record transaction and promotion write guard.
export function queueReviewMutation({ state, events, org, repo, runId, head, base, env = process.env }) {
  const project = gitProject(repo), identity = project.identity;
  if (project.checkout !== project.canonical) throw Error('queue-review uses the canonical project checkout');
  const record = findOrgDir({ cwd: repo, env: { ...env, ORG_DIR: '' } });
  if (!record || fs.realpathSync(record) !== fs.realpathSync(org)) throw Error('queue-review record differs from the actual project');
  openBoundary(org, repo, identity);
  const bound = source({ state, events, org, repo, identity, runId }), { item, run, target } = bound;
  if (head && head !== target.head || base && base !== target.base) throw Error('queue request differs from immutable landed tuple/evidence');
  if (env.ORG_ACTOR === 'line-service') {
    if (gitProject(process.cwd()).checkout !== repo || env.HERDR_ENV === '1' || env.HERDR_PANE_ID) throw Error('line-service queue producer requires its genuine canonical non-session context');
  } else {
    const binding = nativeSender(org, { cwd: process.cwd(), env }), worker = effectiveWorkerIdentity(run, state), native = binding.native;
    if (worker.agent !== native.name || worker.terminal_id !== native.terminal_id || worker.agent_session_id !== native.agent_session.value) throw Error('queue producer differs from actual source worker');
  }
  const key = `${item.id}:${target.head}`, existing = [...state.items.values()].filter(q => q.meta.review_key === key);
  if (existing.length) {
    if (existing.length !== 1 || !isQueueReview(existing[0]) || existing[0].meta.review_source_run !== run.id || !same(existing[0].meta.review_target, target)) throw Error('review queue key has ambiguous/different evidence; retain it');
    return { add: [], result: { result: 'review_queued', review_item: existing[0].id, source_item: item.id, head: target.head, existing: true } };
  }
  const prior = reviewAttempt(item, { state, events, org, repo, identity, ignoreService: ignoreIntent(org, identity, item, target) });
  if (prior) throw Error(`item review already retained: ${prior}`);
  const id = nextItemId(state, { kind: 'work', role: 'reviewer' });
  // The source reference is metadata, not a blocking review-child edge: source
  // completion/build admission must not wait for this post-code review.
  return { add: [{ type: 'item.added', id, kind: 'work', role: 'reviewer', capability: 'review', parent: item.parent, priority: item.priority,
    title: `Review ${item.title}`, budget: {}, accept: ['Independent immutable diff/evidence review; zero suites and no edits. Record PASS or FAIL verdict. Major findings become linked engineer follow-up proposals, never an automatic second review.'],
    meta: { review_key: key, review_source_item: item.id, review_source_run: run.id, review_target: target, review_round_cap: 1 } }],
    result: { result: 'review_queued', review_item: id, source_item: item.id, head: target.head, existing: false } };
}

export function validateQueuedReview({ item, state, events, org, repo, allowRun, allowJournal, journals }) {
  if (!isQueueReview(item) || item.meta.review_round_cap !== 1) throw Error('not a supported single-review queue item');
  const project = gitProject(repo), bound = source({ state, events, org, repo: project.canonical, identity: project.identity, runId: item.meta.review_source_run });
  openBoundary(org, project.canonical, project.identity);
  if (bound.item.id !== item.meta.review_source_item || item.meta.review_key !== `${bound.item.id}:${bound.target.head}` || !same(item.meta.review_target, bound.target)) throw Error('queued review immutable target/evidence changed');
  if (item.runs.some(id => id !== allowRun)) throw Error('queued review already has a run; no replacement/re-review');
  journals ??= fs.readdirSync(path.join(org, 'dispatch')).filter(file => file.endsWith('.json') && !file.endsWith('.routes.json')).map(file => ({
    ...JSON.parse(fs.readFileSync(path.join(org, 'dispatch', file), 'utf8')), journal: path.join(org, 'dispatch', file),
  }));
  if (journals.some(j => j.item === item.id && j.journal !== allowJournal && (!allowRun || j.run !== allowRun))) throw Error('queued review has existing/ambiguous saved dispatch; retain it');
  const prior = reviewAttempt(bound.item, { state, events, org, repo: project.canonical, identity: project.identity, ignoreQueue: item.id, capturedRun: bound.run.id,
    ignoreService: ignoreIntent(org, project.identity, bound.item, bound.target) });
  if (prior) throw Error(`queued review launch held by existing item attempt: ${prior}`);
  return bound.target;
}

export function reviewQueueBrief(item) {
  const t = item.meta.review_target;
  return `# Independent review of ${item.meta.review_source_item}\n\nCaptured immutable HEAD ${t.head}, base ${t.base}. Evidence ${t.evidence}; report SHA256 ${t.reportHash}; diff SHA256 ${t.diff_sha256}. Read the original ask and complete bound producer evidence. Inspect this exact committed diff, independently of later source/cleanup. No build, test, check, prepare, install, model/API or source mutation commands; zero reviewer suites. Do not start another review or invoke settle/lane review. Write the normal record report with outcome done and verdict PASS or FAIL. Unsupported claims and Major findings must be explicit. Propose any formal correction as a linked engineer follow-up under this review, preserving the original source item and final-release Major obligations; cap1, no re-review chain. Existing held/native attempts remain immutable.\n`;
}
