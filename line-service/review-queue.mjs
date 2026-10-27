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
import { selectRoute,resolveLaunchRoute } from '../lanes/routes.mjs';
import { reviewAttempt } from './review.mjs';
import { discoverChanges,capturedProducerTarget } from './phase1.mjs';
import {producerGroupKey,queueProducerGroup,sameProducerQueue,sameCapturedTarget,capturedReviewCommits} from './review-group.mjs';
import {originalPrestartProof,reviewPlain,reviewDigest} from './review-resolutions.mjs';

const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const files = ['line-service/review-queue.mjs', 'line-service/review.mjs','line-service/review-group.mjs','line-service/review-recovery.mjs','line-service/review-resolutions.mjs', 'line-service/phase1.mjs', 'line-service/cutoff.mjs','settle/review-range.mjs', 'bin/org.mjs', 'dispatch/dispatch.mjs','dispatch/preflight.mjs','dispatch/foreground-command.mjs','dispatch/outcome.mjs','dispatch/not-started.mjs','dispatch/request-lock.mjs', 'dispatch/session-cap.mjs', 'dispatch/unlanded-cap.mjs','lanes/lane.mjs'];
const hashes = files.map(file => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'));
const immutableCode=fs.existsSync(path.join(root,'.release-manifest.json'))||fs.existsSync(path.join(root,'.release-commit'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const git = (repo, args) => execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const journalFor = (org, identity) => path.join(org, 'line-service', createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 20), 'effects.json');

export const isQueueReview = item => roleIs(item, 'REV') && Boolean(item.meta.review_source_item);
export function reviewQueueRoute(config) {
  if(config.routes?.reviewer)return'reviewer';
  if(config.selection_policy?.by_task_class?.review!==undefined)return selectRoute(config,'review');
  if(config.routes?.review){resolveLaunchRoute(config,{route:'review'});return'review';}
  return selectRoute(config,'review');
}
function openBoundary(org, repo, identity) {
  for (const file of [journalFor(org, identity).replace(/effects\.json$/, 'STOP'), path.join(repo, '.lane/supervisor/STOP'), path.join(repo, '.lane/supervisor/HOLD')])
    if (fs.existsSync(file)) throw Error('STOP/HOLD prevents review queue effect');
}
export function queueConsumer({ run, env = process.env }) {
  // Both NEW entry points explicitly support this matching development selector.
  // No installed/pinned/saved owner is substituted or rewritten.
  if (env.HERDR_BRAIN_ROOT && fs.realpathSync(env.HERDR_BRAIN_ROOT) !== root) throw Error('queue source selector differs from actual implementation');
  if (!run.owner || run.owner.legacy || run.owner.controller!=='brain') throw Error('source ownership is UNKNOWN; retain owner and existing attempt');
  // This actual loaded module implements immutable target/group/dedup checks.
  // Development main may advance while a request runs: that does not change
  // its captured tuple or loaded capability. Immutable saved bundles retain
  // their byte fence; neither selection nor native/source ownership is replaced.
  if(immutableCode)for (let i = 0; i < files.length; i++) if (createHash('sha256').update(fs.readFileSync(path.join(root, files[i]))).digest('hex') !== hashes[i]) throw Error('immutable saved queue/dispatch implementation changed; retain its owner');
  return root;
}
function source({ state, events, org, repo, identity, runId, head, base,env=process.env,originalCapture }) {
  const run = state.runs.get(runId), item = run && state.items.get(run.item);
  if (!run || !item || !roleIs(item, 'ENG') || !run.report) throw Error('review queue needs an immutable reported build run');
  if (roleIs(state.items.get(item.parent), 'REV')) throw Error('linked formal correction retains its original review; no automatic re-review chain');
  const current = readOwnedRun(org, run.id);
  requireController(current, 'brain'); assertOwner(current, { owner: run.owner, generation: run.owner_generation });
  queueConsumer({ run,env });
  const discovered=discoverChanges({state,events,org,repo,identity});
  const whole=discovered.changes.filter(c=>c.run.id===runId);let choices=whole.filter(c=>!head||c.target.head===head),capturedOriginal=false;
  if(originalCapture&&whole.length===1&&!sameCapturedTarget(originalCapture,whole[0].target)){
    capturedProducerTarget({repo,target:originalCapture,whole:whole[0]});choices=[{...whole[0],target:originalCapture}];capturedOriginal=true;
  }
  if(choices.length!==1)throw Error(`landed change target missing/ambiguous: ${discovered.holds.filter(h=>!h.run||h.run===runId).map(h=>h.reason).join('; ')||'source is not actually landed after the recorded boundary; historical, unlanded or absent source is not a new target'}`);
  const {target,cutoff,authorization}=choices[0];
  if(base&&base!==target.base)throw Error('review base differs from captured landed change');
  try { git(repo, ['merge-base', '--is-ancestor', target.head, 'HEAD']); }
  catch { throw Error('review source is not actually landed in the canonical project'); }
  return { run, item, target, cutoff,authorization,capturedOriginal,whole:whole[0] };
}
function ignoreIntent(org, identity, item, target) {
  return { file: journalFor(org, identity), key: `review:${item.id}:${target.head}`, target, operation: 'record-queue' };
}

// Called inside the existing record transaction and promotion write guard.
export function queueReviewMutation({ state, events, org, repo, runId, head, base, env = process.env,recoveryBinding }) {
  const project = gitProject(repo), identity = project.identity;
  if (project.checkout !== project.canonical) throw Error('queue-review uses the canonical project checkout');
  const record = findOrgDir({ cwd: repo, env: { ...env, ORG_DIR: '' } });
  if (!record || fs.realpathSync(record) !== fs.realpathSync(org)) throw Error('queue-review record differs from the actual project');
  openBoundary(org, repo, identity);
  const bound = source({ state, events, org, repo, identity, runId,head,base,env }), { item, run, target } = bound;
  if (head && head !== target.head || base && base !== target.base) throw Error('queue request differs from immutable landed tuple/evidence');
  if (env.ORG_ACTOR === 'line-service') {
    if (gitProject(process.cwd()).checkout !== repo || env.HERDR_ENV === '1' || env.HERDR_PANE_ID) throw Error('line-service queue producer requires its genuine canonical non-session context');
  } else {
    const binding = recoveryBinding??nativeSender(org, { cwd: process.cwd(), env }), worker = effectiveWorkerIdentity(run, state), native = binding.native;
    const recovery=bound.authorization;
    const supervisorRecovery=recovery&&recovery.native_caller?.name===native.name&&recovery.native_caller?.agent_session?.value===native.agent_session.value&&binding.project.checkout===repo;
    if (!supervisorRecovery&&(worker.agent !== native.name || worker.terminal_id !== native.terminal_id || worker.agent_session_id !== native.agent_session.value)) throw Error('queue producer differs from actual source worker');
  }
  const archived=new Set(bound.authorization?.archived_review_items??[]),key = `${item.id}:${target.head}`,group=producerGroupKey(item.id,run.id,target.reportHash),existing = [...state.items.values()].filter(q => !archived.has(q.id)&&(sameProducerQueue(q,item.id,run.id)||q.meta.review_key===key));
  if (existing.length) {
    if (existing.length !== 1 || !isQueueReview(existing[0]) || queueProducerGroup(existing[0])!==group || !sameCapturedTarget(existing[0].meta.review_target,target)) throw Error('whole producer review already retained with different/partial/UNKNOWN capture; preserve attempts, verdicts and cap1');
    return { add: [], result: { result: 'review_queued', review_item: existing[0].id, source_item: item.id, head: target.head, existing: true } };
  }
  const prior = reviewAttempt(item, { state, events, org, repo, identity, target,capturedRun:run.id, ignoreService: ignoreIntent(org, identity, item, target) });
  if (prior) throw Error(`item review already retained: ${prior}`);
  const id = nextItemId(state, { kind: 'work', role: 'reviewer' });
  // The source reference is metadata, not a blocking review-child edge: source
  // completion/build admission must not wait for this post-code review.
  const landing=events.some(e=>e.type==='change.landed'&&e.item===item.id&&e.head===target.head)?[]:[{
    type:'change.landed',item:item.id,run:run.id,head:target.head,base:target.base,project:identity,landed_at:null,observed_at:new Date().toISOString(),evidence:target.evidence,time_qualification:'Canonical containment observed; exact historical landing time UNKNOWN.'
  }];
  return { add: [...landing,{ type: 'item.added', id, kind: 'work', role: 'reviewer', capability: 'review', parent: item.parent, priority: item.priority,
    title: `Review ${item.title}`, budget: {}, accept: ['Independent immutable diff/evidence review; zero suites and no edits. Record PASS or FAIL verdict. Major findings become linked engineer follow-up proposals, never an automatic second review.'],
    meta: { review_key: key,review_group_key:group, review_source_item: item.id, review_source_run: run.id, review_target: target, review_round_cap: 1, review_cutover:bound.cutoff,...(bound.authorization?{review_recovery_id:bound.authorization.id}:{}) } }],
    result: { result: 'review_queued', review_item: id, source_item: item.id, head: target.head, existing: false } };
}

export function validateQueuedReview({ item, state, events, org, repo, allowRun, allowJournal, journals }) {
  if (!isQueueReview(item) || item.meta.review_round_cap !== 1) throw Error('not a supported single-review queue item');
  const project = gitProject(repo);let originalCapture;
  if(allowJournal&&path.dirname(path.resolve(allowJournal))===path.join(org,'dispatch')){
    const bytes=reviewPlain(allowJournal),job=JSON.parse(bytes),proof=originalPrestartProof({events,org,common:project.identity,journal:allowJournal,job,requestHash:reviewDigest(bytes)});
    if(proof&&proof.review_item===item.id&&same(item.meta.review_target,job.reviewQueue))originalCapture=item.meta.review_target;
  }
  const bound = source({ state, events, org, repo: project.canonical, identity: project.identity, runId: item.meta.review_source_run,head:item.meta.review_target?.head,base:item.meta.review_target?.base,originalCapture });
  openBoundary(org, project.canonical, project.identity);
  if(!same(item.meta.review_cutover,bound.cutoff))throw Error('review queue boundary differs from its actual landed target; retain exact evidence');
  if(bound.authorization&&item.meta.review_recovery_id!==bound.authorization.id)throw Error('archived review item cannot consume the one replacement');
  const archived=new Set(bound.authorization?.archived_review_items??[]),peers=[...state.items.values()].filter(q=>q.id!==item.id&&!archived.has(q.id)&&sameProducerQueue(q,bound.item.id,bound.run.id));
  if(peers.length){
    if(!bound.capturedOriginal)throw Error('another record entry retains this whole producer review; no duplicate native launch, cancellation or retarget');
    const captured=new Set(capturedReviewCommits(bound.target));for(const peer of peers){capturedProducerTarget({repo:project.canonical,target:peer.meta.review_target,whole:bound.whole});if(capturedReviewCommits(peer.meta.review_target).some(h=>captured.has(h)))throw Error('overlapping/UNKNOWN original review scope retained; no duplicate launch');}
  }
  if (bound.item.id !== item.meta.review_source_item || item.meta.review_key !== `${bound.item.id}:${bound.target.head}` || !sameCapturedTarget(item.meta.review_target,bound.target)) throw Error('queued review immutable whole producer target/evidence changed');
  if (item.runs.some(id => id !== allowRun)) throw Error('queued review already has a run; no replacement/re-review');
  journals ??= fs.readdirSync(path.join(org, 'dispatch')).filter(file => file.endsWith('.json') && !file.endsWith('.routes.json')).map(file => ({
    ...JSON.parse(fs.readFileSync(path.join(org, 'dispatch', file), 'utf8')), journal: path.join(org, 'dispatch', file),
  }));
  if (journals.some(j => j.item === item.id && j.journal !== allowJournal && (!allowRun || j.run !== allowRun))) throw Error('queued review has existing/ambiguous saved dispatch; retain it');
  const prior = reviewAttempt(bound.item, { state, events, org, repo: project.canonical, identity: project.identity, ignoreQueue: item.id, capturedRun: bound.run.id,
    target:bound.target,capturedOriginal:bound.capturedOriginal,ignoreQueues:bound.capturedOriginal?peers.map(q=>q.id):[],
    ignoreService: ignoreIntent(org, project.identity, bound.item, bound.target) });
  if (prior) throw Error(`queued review launch held by existing item attempt: ${prior}`);
  return bound.target;
}

export function reviewQueueBrief(item) {
  const t = item.meta.review_target;
  return `# Independent review of ${item.meta.review_source_item}\n\nCaptured immutable HEAD ${t.head}, base ${t.base}. Evidence ${t.evidence}; report SHA256 ${t.reportHash}; diff SHA256 ${t.diff_sha256}. This is ONE whole producer report/source group, including its intermediate and final delivered commits: ${(t.source_group?.owned_commits??t.scope?.commits??[t.head]).join(', ')}. Other attributed commits in the immutable range are context and retain their independent reviews. Read the original ask and complete bound producer evidence. Inspect this exact committed diff, independently of later source/cleanup. No build, test, check, prepare, install, model/API or source mutation commands; zero reviewer suites. Do not start another review or invoke settle/lane review. Write the normal record report with outcome done and verdict PASS or FAIL. Use one markdown bullet per finding: - [Major] path:line - explanation or - [Minor] path:line - explanation. With no findings say so. Unsupported claims and Major findings must be explicit. Propose any formal correction as a linked engineer follow-up under this review, preserving the original source item and final-release Major obligations; cap1, no re-review chain. Existing held/native attempts remain immutable.\n`;
}
