#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from '../lib/record-observation.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gitProject, ignoreRuntime } from '../lib/project.mjs';
import { discoverArchive } from '../lib/archive.mjs';
import { checkFleetRecord, FleetError } from '../lib/fleet.mjs';
import { forwardRelease, bundleRelease, projectEnvironment } from '../lib/releases.mjs';
import {
  UserError, findOrgDir, initOrg, isOrgDir, loadEvents, loadRecord, loadRecordReader, now as clock, readConfig, transact, planTransaction, writeFileAtomic, writer,
} from '../lib/store.mjs';
import {
  BUDGET_KEYS, attention, blockedBy, blockersOf, fold, isResolved, itemStatus, laterRuns, nextItemId, nextRunId, openRuns,
  wouldCycleBlock, wouldCycleParent, releases, dependencyReleases, nextLessonId, lessonState, wouldCycleLesson,
} from '../lib/state.mjs';
import { roleIs } from '../lib/roles.mjs';
import { requestRetirement } from '../lib/retire-trigger.mjs';
import { bindCloseoutSources, publishCloseoutEvents } from '../lib/closeout.mjs';
import { lessonProposal, lessonsJson } from '../lib/lessons.mjs';
import { readReport } from '../lib/report.mjs';
import { selfClosedDecision } from '../lib/self-closed-decision.mjs';
import { trialsAffectedByClose } from '../lib/trial-close-warning.mjs';
import { isReservedItem, proposalIntakeEvents, proposalSelection } from '../lib/proposal-intake.mjs';
import { completionSession } from '../lib/completion-session.mjs';
import { approvalPolicy, CATEGORY_CHECKLIST, categoryFlag, categoryFlagText, reportCategoryFlags } from '../lib/discernment.mjs';
import { sanitizeTerminal } from '../lib/sanitize.mjs';
import { DISPATCH_TEMPLATE, intentFirstCreation } from '../lib/dispatch-template.mjs';
import { renderToday, todayJson } from '../lib/today.mjs';
import { loadDiscoveredRoutes, readRoutesSnapshot, resolveRoute } from '../lanes/routes.mjs';
import { completeBatchCommand } from '../lib/completion.mjs';
import { releasesCommand } from '../lib/release-record.mjs';
import { handoffsCommand } from '../lib/handoffs-command.mjs';
import { protectRecordMutation } from '../lib/record-guard.mjs';
import { operatorAnswerRelay } from '../lib/operator-answer-relay.mjs';
import {
  approxTokens, describeEvent, itemJson, renderBrief, renderLog, renderShowItem, renderShowRun,
  renderSnapshot, renderStatus, statusJson, truncate, renderLessons,
} from '../lib/render.mjs';

const BIN = fileURLToPath(import.meta.url);

const USAGE = `record: durable organizational state for agent R&D (no daemon, no inference)

Setup
  record init [dir]                       create a record (default ./.org)
  record config [--json]                  effective policy, provenance and repo-copy drift
  record config set KEY VALUE [--scope identity] [--who-asked REF]
  record config history [--scope identity] owning record's configuration history
  record adopt PROJECT --inspect --expires DATE
  record adopt PROJECT --scope FILE --decision ID:SEQ

Work
  record obligations [--json] [--project COMMON_DIR]  exact pending facts and consumer outcomes (read-only)
  record nudge --id ID --run R-n --project COMMON_DIR --actor NAME --occurred-at ISO_TIME
          --stage STAGE --action TEXT --reason TEXT --evidence REF
                                          journal one manual lifecycle intervention (idempotent)
  record witness evaluate [--item ID ...] [--dry-run]  evaluate recorded live witness specs; result notes only
  record messages send --id ID --summary TEXT [--kind KIND --run R-n --item ID --question HUM-n]
  record messages send --file ENVELOPE    store an existing session.message.v1 envelope
  record messages digest [--limit 5 --after SEQ --json]  pull a short operator digest
  record messages push --id ID            resume an existing reserved ask through Brain Chat
  record add <title> [--goal] [--role R] [--capability C] [--parent ID]
          [--blocked-by ID]... [--accept TEXT]... | [--file PROMPT] [--why TEXT]
          [--priority N] [--budget key=N]...
  record template                       editable intent-first dispatch prompt
  record queue-review R-n|canonical:SHA [--head SHA --base SHA]  idempotent landed-source review item
  record proposals file R-n --index N     reuse an immutable report proposal
  record proposals metrics               daily filing and ever-run cohorts (UTC)
  record proposals token ID               current proposal/dependency version
  record proposals lapse ID --cut selection|release --expect TOKEN --why TEXT
  record proposals duplicate ID --into ID --key KEY --expect TOKEN --successor-expect TOKEN --why TEXT
  record block <ID> --by <ID> [--requires completed|accepted]
                                          default completion; acceptance is opt-in
  record unblock <ID> --by <ID>           remove that blocking link
  record note <ID> <text> [--decision [--summary TEXT]]
                                          attach a note or decision (summary: one plain sentence)
  record amend-accept <ID> --accept TEXT... --why TEXT
          | <ID> --file PATH --why TEXT   replace acceptance; retain every revision in show

Questions for the operator
  record ask "<yes/no question>" --parent ID --category C --recommend ANSWER --why TEXT
          [--on-yes T] [--on-no T] [--memo PATH] [--blocks ID]... [--priority N] [--wait]
                                          a role=human item; --wait always requires an operator answer
  record answer <ID> yes|no|"<text>" [--note WHY] [--overrule]
          [--relay-operator --source WHERE --said-at ISO_TIME]  bound chat, priorities only
                                          a "no" keeps the work it blocks blocked
  record set <ID> key=value...            edit an item (title role capability priority parent
                                          budget.<key> meta.<key>) or add run metadata; start
                                          facts are fixed (e.g. record set R-3 tokens_in=48210)
  record close <ID> [--dropped] [--note T] [--if-current-run R-n]
  record complete-batch --file JSON       supervisor-attested batch reconciliation (all members)
    [--accept-delta SHA256 --why TEXT]    accept inspected plain notes without completing
  record reopen <ID> [--note T] [--if-current-run R-n]

Lessons (durable knowledge, separate from work items)
  record lesson add TEXT --evidence ID|event:N... [--scope project|fleet|framework]
          [--path PATH]... [--module NAME]...   propose a short claim (at most 400 code points)
  record lesson activate L-n [--supersedes L-n]... [--reason TEXT]
                                          activate and atomically supersede older lessons
  record lesson retire L-n --reason TEXT  retain the lesson and why it stopped helping
  record lessons [--path PATH] [--module NAME] [--scope S] [--state S] [--json]
                                          active by default; text shows five, JSON all matches
                                          states: proposed, active, retired, superseded, all

Runs and reports
  record handoffs write --workspace W --slot S --file PATH [--json]
                                          save immutable handoff bytes and one sha256 event
  record handoffs latest --workspace W --slot S [--json]
                                          verify and name the latest recorded handoff
  record handoffs template | check --file PATH [--json]
                                          standard headings; missing sections are advisory
  record start <ID> [--route R [--route-config FILE] | --harness H --model M --effort E] [--workspace DIR]
          [--report PATH] [--escalation] [--meta key=value]... [--if-current-run R-n] [--defer-preparation]
  record brief R-n [--prepare-start]      materialize deferred start work without starting again
  record claim R-n --controller NAME [--legacy] [--release-root DIR]
    [--transfer-from NAME --expected-owner JSON --expected-generation N --why TEXT]
    [--admit-worker | --adopt-brain-receipt FILE]
  record worker <R-n> --agent NAME --pane ID --worker-workspace ID --cwd DIR
          [--terminal-id ID] [--agent-session-id ID]
                                          launcher receipt; use dispatch/record-worker.mjs at launch
  record session-bind --journal FILE      dispatch's one-time late native session fact
  record check <report.md>                validate a report without recording anything
  record ingest <report.md> [--run R-n] [--if-current-run R-n] [--if-self-closed SEQ]
                                          record a report; optional guard checked under the log lock
  record sync                             record every report waiting at an open run's report path
  record handoff R-old --to R-new --confirm --why TEXT
                                          confirm a retained successor; reports stay immutable
  record pane-release R-n [--reviewer] --session S --terminal T --pane P --head SHA --authority TEXT --next TEXT --unresolved TEXT --evidence PATH... --confirm --why TEXT
  record abandon <R-n> [--note T]         give up on a run (a later report is still accepted)
  record brief <R-n>                      print the brief a run was given

Views (zero inference)
  record lookup TEXT [--kind decision|mistake|challenge|lesson|learning|note] [--item ID]
          [--at SEQ] [--limit 10] [--all-states] [--json]  rebuild per-record source lookup
  record status [--json]                  one-screen overview
  record snapshot                         markdown state for a fresh session of any harness
  record show <ID> [--json] [--compact]   an item or run with its reports and history
  record log [--since 2h|09:00|DATE] [--limit N] [--json]
  record today [--json] [--parked]        what waits on the operator; --parked lists questions older than 7 days
  record summary [--json]                published summary freshness and age
  record summary publish [--json]        publish status/today/releases from the canonical checkout
  record housekeeping [--json]            schedule status, last scan and recent activity
  record releases [--json] [--identity DIR] candidates, gate evidence and operator decisions
  record housekeeping pause [--expect REV] save enabled=false for the next tick
  record housekeeping set --resume false [--unset KEY] [--expect REV]
                                          validate project .housekeeping.json overrides
  record desks [--json]                   settle/review project settings
  record desks set [--review-route R] [--fix-route R] [--review-round-cap N] [--timeout S]
                   [--reuse true|false] [--to AGENT] [--unset FIELD] [--expect REV]
  record routes add|policy|defaults|arguments --value JSON [--expect REV]
  record routes [--json]                  project routes and their configuration sources
  record routes set NAME --kind K --model M --effort E [--expect REV]
                                          validate and save an override in the project's .lane.json

The record is found from $ORG_DIR, the canonical Git project's .org/, or a legacy ancestor .org/.
In a Git project with no record, record commands initialize the canonical .org/ automatically.
The org command is a permanent alias; .org/, ORG_DIR and ORG_ACTOR remain supported.

${CATEGORY_CHECKLIST}
`;

const out = (text) => process.stdout.write(text);
const err = (text) => process.stderr.write(text);
const safeOut = (text) => out(sanitizeTerminal(text));

function args(argv, options, { min = 0, max = Infinity, usage }) {
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  if (positionals.length < min || positionals.length > max) throw new UserError(`usage: ${usage}`);
  return { values, positionals };
}

function shq(text) {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

function cliString(dir) {
  return `ORG_DIR=${shq(dir)} node ${shq(BIN)}`;
}

function openOrg({ readOnly = false, compact = false } = {}) {
  let dir = findOrgDir();
  if (!dir && !process.env.ORG_DIR && !readOnly) {
    try { const project = gitProject(); ignoreRuntime(project); dir = path.join(project.canonical, '.org'); }
    catch { /* Outside Git, explicit init remains necessary. */ }
    if (dir) initOrg(dir);
  }
  if (!isOrgDir(dir)) {
    throw new UserError(dir
      ? `${dir} is not an initialized record (run: record init ${dir})`
      : 'no record found: run record init, or set ORG_DIR');
  }
  if (compact) {
    const reader = loadRecordReader(dir);
    // The show renderer requests only matching history. Do not materialize the
    // archive to provide its existing filter contract.
    const events = { filter(predicate) { const selected = []; for (const event of reader.events()) if (predicate(event)) selected.push(event); return selected; } };
    try { return { dir, events, state: reader.state, tornTail: reader.tornTail, config: readConfig(dir), now: clock(), close: () => reader.close() }; }
    catch (error) { reader.close(); throw error; }
  }
  const { events, tornTail, state } = loadRecord(dir);
  return { dir, events, tornTail, state, config: readConfig(dir), now: clock() };
}

function view(ctx) {
  return { orgDir: ctx.dir, events: ctx.events, tornTail: ctx.tornTail, config: ctx.config, now: ctx.now, cli: cliString(ctx.dir) };
}

function briefArchive(workspace) {
  try { return { archive: workspace ? discoverArchive({ cwd: workspace }).dirs : [] }; }
  catch (error) { return { archive: [], archiveError: error?.message || String(error) }; }
}

let warnedUnattributed = false;
function mutate(ctx, fn, authority, { deferCloseout = false } = {}) {
  const who = writer();
  if (who.unattributed && !warnedUnattributed) {
    warnedUnattributed = true;
    err('record: recorded as human but unattributed (no ORG_ACTOR, no terminal). An agent session sets ORG_ACTOR=<its session name>.\n');
  }
  // Event derivation and read-only guards precede the append lock. Intake and
  // queue-review defer their immutable/native effects to the final commit hook.
  const planned = new Set(['add', 'block', 'unblock', 'note', 'amend-accept', 'ask', 'answer', 'set', 'close', 'reopen', 'start', 'worker', 'abandon', 'lesson', 'ingest', 'sync', 'queue-review', 'messages', 'nudge', 'witness']);
  // Only event derivation may refresh on a race. Commit hooks never replay;
  // the store permits one refresh after a committed, idempotent config audit.
  // Message preparation includes its fresh native sender observation. It may
  // precede acquisition, but a record/file race must never replay that lookup.
  const replaySafe = process.argv[2] !== 'messages' &&
    !(process.argv[2] === 'answer' && process.argv.includes('--relay-operator')) && !process.env.ORG_GUARD_OVERRIDE;
  const transaction = planned.has(process.argv[2]) ? planTransaction : transact;
  const res = transaction(ctx.dir, (events, state) => {
    return bindCloseoutSources({ org: ctx.dir, events, mutation: protectRecordMutation({ org: ctx.dir, events, state, mutation: fn(state, events), command: process.argv[2], ...authority }) });
  }, {
    at: ctx.now,
    actor: who.actor,
    unattributed: who.unattributed,
    replaySafe,
  });
  if (res.repaired) err('record: repaired an incomplete last event left by an interrupted write\n');
  try { if (!deferCloseout) publishCloseoutEvents({ org: ctx.dir, added: res.added }); }
  catch (e) { err(`record: closeout deferred: ${e.message}; source retained; recover with supervisor/closeout.mjs event --seq N\n`); }
  if (!deferCloseout && res.added.some(e => ['report.ingested', 'item.closed', 'item.reopened', 'question.answered', 'link.removed', 'run.abandoned', 'promotion.reconciled'].includes(e.type) || (e.type === 'note.added' && e.decision))) {
    try { requestRetirement({ org: ctx.dir, eventSeq: res.added.at(-1).seq, source: `record ${process.argv[2]}` }); }
    catch (e) { err(`record: retirement request deferred: ${e.message}\n`); }
  }
  return res;
}

function requireItem(s, id) {
  const item = s.items.get(id);
  if (!item) throw new UserError(`unknown item ${id}`);
  return item;
}

function requireLesson(s, id) {
  const lesson = s.lessons.get(id);
  if (!lesson) throw new UserError(`unknown lesson ${id}`);
  return lesson;
}

function lesson(argv) {
  const [action, ...rest] = argv;
  if (action === 'add') {
    const { values, positionals } = args(rest, {
      scope: { type: 'string' }, path: { type: 'string', multiple: true }, module: { type: 'string', multiple: true },
      evidence: { type: 'string', multiple: true },
    }, { min: 1, usage: 'record lesson add TEXT --evidence ID|event:N [--scope S] [--path PATH] [--module NAME]' });
    const { result } = mutate(openOrg(), (s, events) => {
      const fields = lessonProposal(s, events, { text: positionals.join(' '), scope: values.scope,
        paths: values.path, modules: values.module, evidence: values.evidence });
      const id = nextLessonId(s);
      return { add: [{ type: 'lesson.proposed', id, ...fields }], result: id };
    });
    out(result + '\n');
    return 0;
  }
  if (action === 'activate' || action === 'retire') {
    const { values, positionals } = args(rest, {
      reason: { type: 'string' }, ...(action === 'activate' ? { supersedes: { type: 'string', multiple: true } } : {}),
    }, { min: 1, max: 1, usage: `record lesson ${action} L-n ${action === 'retire' ? '--reason TEXT' : '[--supersedes L-n] [--reason TEXT]'}` });
    const id = positionals[0], reason = values.reason?.trim();
    if (action === 'retire' && !reason) throw new UserError('retiring a lesson requires --reason TEXT');
    const { added } = mutate(openOrg(), s => {
      const target = requireLesson(s, id);
      if (action === 'retire') {
        if (target.supersession) throw new UserError(`${id} is superseded by ${target.supersession.by_lesson}; propose a new lesson instead`);
        return { add: target.retirement?.reason === reason ? [] : [{ type: 'lesson.retired', id, reason }] };
      }
      const predecessors = [...new Set(values.supersedes ?? [])];
      for (const oldId of predecessors) {
        const old = requireLesson(s, oldId);
        if (wouldCycleLesson(s, oldId, id)) throw new UserError(`superseding ${oldId} by ${id} would create a lesson cycle`);
        if (old.supersession && old.supersession.by_lesson !== id)
          throw new UserError(`${oldId} is already superseded by ${old.supersession.by_lesson}`);
      }
      if (target.supersession) throw new UserError(`${id} is superseded by ${target.supersession.by_lesson}; propose a new lesson instead`);
      return { add: [
        ...(lessonState(target) === 'active' ? [] : [{ type: 'lesson.activated', id }]),
        ...predecessors.filter(oldId => !s.lessons.get(oldId).supersession).map(oldId => ({
          type: 'lesson.superseded', id: oldId, by_lesson: id, reason: reason || `Replaced by ${id}`,
        })),
      ] };
    });
    safeOut(added.length ? added.map(describeEvent).join('\n') + '\n' : 'nothing to change\n');
    return 0;
  }
  throw new UserError('usage: record lesson add|activate|retire (see: record help)');
}

function lessons(argv) {
  const { values } = args(argv, {
    path: { type: 'string' }, module: { type: 'string' }, scope: { type: 'string' }, state: { type: 'string' }, json: { type: 'boolean' },
  }, { max: 0, usage: 'record lessons [--path PATH] [--module NAME] [--scope S] [--state S] [--json]' });
  const doc = lessonsJson(openOrg().state, values);
  out(values.json ? JSON.stringify(doc, null, 2) + '\n' : renderLessons(doc));
  return 0;
}

function requireCurrentRun(s, itemId, runId) {
  const run = s.runs.get(runId);
  if (!run) throw new UserError(`unknown run ${runId}`);
  if (run.item !== itemId) throw new UserError(`${runId} does not belong to ${itemId}`);
  const later = laterRuns(s, runId);
  if (later.length) throw new UserError(`${runId} is superseded by ${later.map((r) => r.id).join(', ')}`);
}

function coerce(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parsePairs(list, what) {
  const pairs = {};
  for (const pair of list ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new UserError(`${what} expects key=value (got "${pair}")`);
    pairs[pair.slice(0, eq).trim()] = coerce(pair.slice(eq + 1).trim());
  }
  return pairs;
}

function checkBudget(key, value) {
  if (!BUDGET_KEYS.includes(key)) throw new UserError(`unknown budget key "${key}" (known: ${BUDGET_KEYS.join(', ')})`);
  if (value !== null && typeof value !== 'number') throw new UserError(`budget ${key} must be a number`);
}

function init(argv) {
  const { positionals } = args(argv, {}, { max: 1, usage: 'record init [dir]' });
  const dir = path.resolve(positionals[0] ?? process.env.ORG_DIR ?? '.org');
  checkFleetRecord(dir);
  if (isOrgDir(dir)) {
    out(`${dir} is already a record\n`);
    return 0;
  }
  initOrg(dir);
  out(`initialized ${dir}\n`);
  out(path.basename(dir) === '.org'
    ? `record finds it from anywhere under ${path.dirname(dir)}; elsewhere set ORG_DIR=${dir}\n`
    : `set ORG_DIR=${dir} to use it\n`);
  return 0;
}

function add(argv) {
  const { values, positionals } = args(argv, {
    goal: { type: 'boolean' },
    role: { type: 'string' },
    capability: { type: 'string' },
    parent: { type: 'string' },
    'blocked-by': { type: 'string', multiple: true },
    accept: { type: 'string', multiple: true },
    file: { type: 'string' },
    why: { type: 'string' },
    priority: { type: 'string' },
    budget: { type: 'string', multiple: true },
    meta: { type: 'string', multiple: true },
  }, { min: 1, usage: 'record add <title> [options]' });
  const title = positionals.join(' ').trim();
  if (!title) throw new UserError('a title is required');
  if (values.file && values.accept) throw new UserError('choose --file or --accept, not both');
  let accept = values.accept ?? [];
  if (values.file) {
    try {
      if (!fs.statSync(values.file).isFile()) throw Error('not a regular file');
      const body = fs.readFileSync(values.file, 'utf8');
      if (!body.trim()) throw Error('empty prompt');
      accept = [body];
    } catch (error) { throw new UserError(`cannot read prompt ${values.file}: ${error.message}`); }
  }
  const budget = parsePairs(values.budget, '--budget');
  for (const [key, value] of Object.entries(budget)) checkBudget(key, value);
  const priority = values.priority == null ? null : Number(values.priority);
  if (values.priority != null && !Number.isFinite(priority)) throw new UserError('--priority must be a number');
  const kind = values.goal ? 'goal' : 'work';
  const { result } = mutate(openOrg(), (s) => {
    if (values.parent) requireItem(s, values.parent);
    const blockers = [...new Set(values['blocked-by'] ?? [])];
    blockers.forEach((b) => requireItem(s, b));
    const id = nextItemId(s, { kind, role: values.role });
    const events = [intentFirstCreation({
      type: 'item.added', id, kind, title,
      role: values.role?.toLowerCase() ?? null,
      capability: values.capability ?? null,
      parent: values.parent ?? null,
      priority,
      accept, why: values.why ?? null,
      budget,
      meta: parsePairs(values.meta, '--meta'),
    })];
    for (const blocker of blockers) events.push({ type: 'link.added', blocker, blocked: id });
    return { add: events, result: id };
  });
  out(`${result}\n`);
  return 0;
}

async function queueReview(argv) {
  const { values, positionals } = args(argv, { head: { type: 'string' }, base: { type: 'string' },'recover-inactive':{type:'boolean'},'recover-unstarted':{type:'boolean'},role:{type:'string'},resolution:{type:'string'},'decision-seq':{type:'string'},id:{type:'string'},'predecessor-preparation':{type:'string'} }, { min: 1, max: 1, usage: 'record queue-review R-n|canonical:SHA [--head SHA --base SHA] | REV-n --recover-unstarted --role supervisor --resolution OWN.json --decision-seq N --id STABLE | R-n --recover-inactive --role supervisor --resolution OWN.json --decision-seq N --id STABLE [--predecessor-preparation UNUSED_ID]' });
  const { queueReviewMutation } = await import('../line-service/review-queue.mjs');
  const ctx = openOrg(), repo = gitProject(process.cwd()).canonical;
  if(values['recover-unstarted']){
    if(values['recover-inactive']||values['predecessor-preparation']||values.head||values.base)throw new UserError('never-started recovery retains the exact original target; no other recovery or retarget flags');
    const {recoverUnstartedReview}=await import('../line-service/review-unstarted.mjs');
    const result=recoverUnstartedReview({repo,org:ctx.dir,reviewId:positionals[0],resolution:values.resolution,decisionSeq:Number(values['decision-seq']),id:values.id,role:values.role});out(JSON.stringify(result)+'\n');return 0;
  }
  if(values['recover-inactive']){
    const {recoverInactiveReview}=await import('../line-service/review-recovery.mjs');
    const result=recoverInactiveReview({repo,org:ctx.dir,runId:positionals[0],head:values.head,base:values.base,resolution:values.resolution,decisionSeq:Number(values['decision-seq']),id:values.id,role:values.role,predecessorPreparation:values['predecessor-preparation']});out(JSON.stringify(result)+'\n');return 0;
  }
  if(values['predecessor-preparation'])throw new UserError('--predecessor-preparation requires the existing scoped supervisor recovery');
  if (loadEvents(ctx.dir).tornTail) throw new UserError('incomplete record tail prevents review queue creation');
  const { result } = mutate(ctx, (state, events) => queueReviewMutation({ state, events, org: ctx.dir, repo, runId: positionals[0], head: values.head, base: values.base, deferCommit: true }));
  out(JSON.stringify(result) + '\n');
  return 0;
}

function block(argv, remove = false) {
  const usage = `record ${remove ? 'unblock' : 'block'} <ID> --by <ID>`;
  const { values, positionals } = args(argv, { by: { type: 'string', multiple: true }, requires: { type: 'string' } }, { min: 1, max: 1, usage });
  if (!values.by?.length) throw new UserError(`usage: ${usage}`);
  if (values.requires && (remove || !['completed', 'accepted'].includes(values.requires))) throw new UserError('--requires must be completed or accepted on block');
  const target = positionals[0];
  const { added } = mutate(openOrg(), (s) => {
    requireItem(s, target);
    const events = [];
    for (const by of new Set(values.by)) {
      requireItem(s, by);
      const exists = s.links.find((l) => l.blocker === by && l.blocked === target);
      if (!remove && exists && values.requires && (exists.requires ?? 'completed') !== values.requires)
        throw new UserError('existing link requirement differs; explicitly unblock before replacing it');
      if (remove) {
        if (exists) events.push({ type: 'link.removed', blocker: by, blocked: target });
      } else if (!exists) {
        if (wouldCycleBlock(s, by, target)) throw new UserError(`${by} cannot block ${target}: that would create a blocking cycle`);
        events.push({ type: 'link.added', blocker: by, blocked: target, ...(values.requires === 'accepted' ? {
          requires: 'accepted', consumer: target, wake: ['report.ingested', 'change.reviewed', 'correction.discharged'], stuck_owner: target,
        } : {}) });
      }
    }
    return { add: events };
  });
  out(added.length ? added.map(describeEvent).join('\n') + '\n' : 'nothing to change\n');
  return 0;
}

function note(argv) {
  const { values, positionals } = args(argv, { decision: { type: 'boolean' }, summary: { type: 'string' } },
    { min: 2, usage: 'record note <ID> <text> [--decision [--summary TEXT]]' });
  const [id, ...words] = positionals;
  const summary = values.summary?.replace(/\s+/g, ' ').trim();
  if (values.summary != null && !values.decision) throw new UserError('--summary needs --decision (it is the plain sentence the operator reads)');
  if (values.summary != null && !summary) throw new UserError('--summary cannot be empty');
  mutate(openOrg(), (s) => {
    if (!s.items.has(id) && !s.runs.has(id)) throw new UserError(`unknown item or run ${id}`);
    return { add: [{ type: 'note.added', id, text: words.join(' ').trim(), decision: Boolean(values.decision), ...(summary ? { summary } : {}) }] };
  });
  out(`${values.decision ? 'decision' : 'note'} recorded on ${id}\n`);
  return 0;
}

function amendAccept(argv) {
  const { values, positionals } = args(argv, {
    accept: { type: 'string', multiple: true }, file: { type: 'string' }, why: { type: 'string' },
  }, { min: 1, max: 1, usage: 'record amend-accept <ID> (--accept TEXT... | --file PATH) --why TEXT' });
  if (Boolean(values.accept) === (values.file !== undefined))
    throw new UserError('supply either repeated --accept TEXT or --file PATH');
  if (!values.why?.trim()) throw new UserError('--why is required: explain the acceptance replacement');
  let accept = values.accept;
  if (values.file !== undefined) {
    const file = path.resolve(values.file);
    try {
      if (!fs.statSync(file).isFile()) throw new UserError(`acceptance file ${file} is not a regular file`);
      accept = [fs.readFileSync(file, 'utf8')];
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw new UserError(`cannot read acceptance file ${file}: ${error.message}`);
    }
  }
  if (accept.some(text => !text.trim())) throw new UserError('acceptance text cannot be empty');
  const id = positionals[0];
  const { added } = mutate(openOrg(), s => {
    const item = requireItem(s, id);
    if (isReservedItem(item)) throw new UserError('operator-reserved acceptance cannot be amended');
    return { add: [{ type: 'item.acceptance-amended', id, accept, why: values.why }] };
  });
  safeOut(describeEvent(added[0]) + '\n');
  return 0;
}

function categoryPolicy(config, category) {
  const { categories } = config.approvals;
  if (!Object.hasOwn(categories, category)) {
    throw new UserError(`unknown category "${category}" (known: ${Object.keys(categories).join(', ')})`);
  }
  return approvalPolicy(config, category);
}

// A reply that starts with the word yes or no is that answer ("No." and "no, not yet"
// decline); whatever follows the word is returned as `rest`. Anything else is a text answer.
function parseReply(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(yes|no)(?![\p{L}\p{N}_])[\s\p{P}]*(.*)$/iu.exec(t);
  return m ? { answer: m[1].toLowerCase(), rest: m[2].trim() || null } : { answer: t, rest: null };
}

function ask(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    out(`record ask "<question>" --parent ID --category C --recommend ANSWER --why TEXT [--wait]\n\n${CATEGORY_CHECKLIST}\n`);
    return 0;
  }
  const { values, positionals } = args(argv, {
    wait: { type: 'boolean' },
    parent: { type: 'string' },
    category: { type: 'string' },
    recommend: { type: 'string' },
    why: { type: 'string' },
    'on-yes': { type: 'string' },
    'on-no': { type: 'string' },
    memo: { type: 'string' },
    blocks: { type: 'string', multiple: true },
    priority: { type: 'string' },
  }, { min: 1, usage: 'record ask "<yes/no question>" --parent ID --category C --recommend ANSWER --why TEXT [options]' });
  const title = positionals.join(' ').replace(/\s+/g, ' ').trim();
  if (!title) throw new UserError('a question is required');
  const text = (value) => value?.replace(/\s+/g, ' ').trim() || null;
  const { answer: recommend, rest: recommendRest } = parseReply(values.recommend);
  if (!recommend) throw new UserError('--recommend is required: never hand the operator an open question');
  if (recommendRest) throw new UserError(`--recommend should be just ${recommend}; put "${recommendRest}" in --why`);
  if (!values.category) throw new UserError('--category is required');
  if (!values.parent) throw new UserError('--parent is required: say which work the question belongs to');
  const why = text(values.why);
  if (!why) throw new UserError('--why is required: two plain sentences the operator reads first');
  const priority = values.priority == null ? null : Number(values.priority);
  if (values.priority != null && !Number.isFinite(priority)) throw new UserError('--priority must be a number');
  let memo = null;
  if (values.memo) {
    memo = path.resolve(values.memo);
    if (!fs.existsSync(memo)) throw new UserError(`memo ${memo} does not exist`);
    // A memo is a document to open; a directory, app bundle or device is not.
    if (!fs.statSync(memo).isFile()) throw new UserError(`memo ${memo} is not a regular file`);
  }
  const ctx = openOrg();
  const configuredPolicy = categoryPolicy(ctx.config, values.category);
  const policy = values.wait || values.category === 'priorities' ? 'ask' : configuredPolicy;
  const flag = categoryFlag(ctx.config, { category: values.category, wait: values.wait, title, why,
    recommend, on_yes: values['on-yes'], on_no: values['on-no'], memo_text: memo ? fs.readFileSync(memo, 'utf8') : null }, 'question', { wait: values.wait });
  const { actor } = writer();
  const { result } = mutate(ctx, (s) => {
    requireItem(s, values.parent);
    const blocks = [...new Set(values.blocks ?? [])];
    blocks.forEach((b) => requireItem(s, b));
    const id = nextItemId(s, { kind: 'work', role: 'human' });
    const meta = { category: values.category, recommend, memo, on_yes: text(values['on-yes']), on_no: text(values['on-no']) };
    const events = [
      intentFirstCreation({ type: 'item.added', id, kind: 'work', title, why, role: 'human', capability: null, parent: values.parent, priority, accept: [], budget: {},
        meta: Object.fromEntries(Object.entries(meta).filter(([, v]) => v != null)) }),
      { type: 'note.added', id, text: why, decision: false, kind: 'why' },
    ];
    for (const blocked of blocks) {
      if (s.links.some((l) => l.blocker === id && l.blocked === blocked)) continue;
      events.push({ type: 'link.added', blocker: id, blocked });
    }
    if (flag) events.push({ type: 'category.flagged', id, ...flag });
    if (policy === 'auto') {
      events.push(
        { type: 'note.added', id, text: `Answered ${recommend} automatically (${values.category} is auto)`, decision: true, kind: 'answer' },
        { type: 'item.updated', id, fields: { meta: { answer: recommend, answered_by: 'auto' } } },
        { type: 'item.closed', id, as: 'done', note: 'answered automatically' },
      );
    }
    return { add: events, result: id };
  });
  out(`${result}\n`);
  if (flag) err(sanitizeTerminal(`warning: ${result} ${categoryFlagText(flag)}\n`));
  if (policy === 'auto') err(`${result} answered ${recommend} automatically (${values.category} is auto); overrule with: record answer ${result} <answer> --overrule\n`);
  else if (actor !== 'human') err(`${result} is waiting for the operator\n`);
  return 0;
}

function answer(argv) {
  const { values, positionals } = args(argv, { note: { type: 'string' }, overrule: { type: 'boolean' },
    'relay-operator': { type: 'boolean' }, source: { type: 'string' }, 'said-at': { type: 'string' } },
    { min: 2, usage: 'record answer <ID> yes|no|"<text>" [--note WHY] [--overrule]' });
  const [id, ...words] = positionals;
  const verbatim = words.join(' ');
  const { answer: reply, rest } = parseReply(verbatim);
  if (!reply) throw new UserError('an answer is required: yes, no or a short text');
  if (!values['relay-operator'] && (values.source !== undefined || values['said-at'] !== undefined))
    throw new UserError('--source and --said-at require --relay-operator');
  const { actor } = writer();
  const note = [rest, values.note?.replace(/\s+/g, ' ').trim()].filter(Boolean).join('; ') || null;
  const ctx = openOrg();
  const { result } = mutate(ctx, (s) => {
    const item = requireItem(s, id);
    if (item.role !== 'human') throw new UserError(`${id} is not a question (only role=human items are answered)`);
    if (values['relay-operator'] && (item.meta.category !== 'priorities' || item.meta.operator_reserved || item.meta.reserved))
      throw new UserError('operator answer relay is limited to non-reserved priority questions');
    if (item.meta.category === 'priorities' && actor !== 'human' && !values['relay-operator']) throw new UserError('priority questions wait for the operator');
    if (item.meta.operator_reserved && actor !== 'human') throw new UserError('release questions are reserved for the operator');
    if (item.meta.operator_reserved && !['yes', 'no'].includes(reply)) throw new UserError('release questions require a yes or no answer; start the reply with yes or no and put any explanation after it or in --note');
    const answered = item.closed && item.meta.answer != null;
    if (values.overrule && !answered) throw new UserError(`${id} has not been answered; nothing to overrule (drop --overrule)`);
    if (!values.overrule && answered) {
      throw new UserError(`${id} was already answered ${item.meta.answer} by ${item.meta.answered_by ?? 'unknown'}; to change it: record answer ${id} <answer> --overrule`);
    }
    if (values.overrule && String(item.meta.answer).trim().toLowerCase() === reply.toLowerCase()) {
      throw new UserError(`${id} is already answered ${item.meta.answer}; an overrule must change the answer`);
    }
    if (!values.overrule && item.closed) throw new UserError(`${id} is closed (${item.closed.as}); reopen it first`);
    const relay = values['relay-operator'] ? operatorAnswerRelay({ org: ctx.dir, actor, verbatim,
      source: values.source, saidAt: values['said-at'], now: ctx.now }) : null;
    const attribution = relay ? `Operator reply relayed by ${actor}, said at ${relay.said_at}, source ${relay.source}: ${JSON.stringify(verbatim)}` : null;
    const events = [];
    if (item.closed) events.push({ type: 'item.reopened', id, note: 'reopened to overrule its answer' });
    events.push(
      { type: 'note.added', id, text: [`Answered ${reply}${values.overrule ? ` (overruling ${item.meta.answer})` : ''}`, note, attribution].filter(Boolean).join(': '), decision: true, kind: 'answer' },
      { type: 'item.updated', id, fields: { meta: { answer: reply, answered_by: relay ? 'human' : actor,
        ...(relay || item.meta.answer_relay ? { answer_relay: relay } : {}), ...(values.overrule ? { overruled: true } : {}) } } },
      { type: 'item.closed', id, as: 'done', note },
    );
    return { add: events, result: { dependents: blockedBy(s, id) } };
  });
  out(`${id} answered ${reply}${values.overrule ? ' (overruled)' : ''}\n`);
  const after = openOrg();
  for (const blocked of result.dependents) {
    const now = itemStatus(after.state, blocked);
    const running = openRuns(after.state, blocked);
    const closed = after.state.items.get(blocked)?.closed;
    if (reply === 'no' && closed) {
      // A closed item stays closed whatever its blockers say.
      out(`${blocked} is already closed (${closed.as}); the decline does not reopen it\n`);
    } else if (reply === 'no' && running.length) {
      // An open run counts before blockers in itemStatus, so the item is active, not blocked.
      out(`${blocked} is already running (${running.map((r) => r.id).join(', ')}); the decline does not stop it\n`);
    } else if (reply === 'no') {
      out(`${blocked} stays blocked: declined (re-plan it, then: record unblock ${blocked} --by ${id})\n`);
    } else if (now !== 'blocked') {
      out(`${blocked} is no longer blocked by ${id} (now ${now})\n`);
    } else {
      out(`${blocked} is still blocked by other work\n`);
    }
  }
  return 0;
}

const ITEM_FIELDS = ['title', 'role', 'capability', 'priority', 'parent'];

function set(argv) {
  const { positionals } = args(argv, {}, { min: 2, usage: 'record set <ID> key=value...' });
  const [id, ...pairs] = positionals;
  const { added } = mutate(openOrg(), (s, events) => {
    const parsed = parsePairs(pairs, 'record set');
    if (s.runs.has(id)) {
      const meta = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k.replace(/^meta\./, ''), v]));
      // Start facts never change: a different value would make the record inconsistent.
      const started = events.find((e) => e.type === 'run.started' && e.id === id)?.meta ?? {};
      // --harness/--model/--effort and routes store raw strings; set values are coerced.
      const same = (k) => [started[k], typeof started[k] === 'string' ? coerce(started[k]) : started[k]].some((v) => JSON.stringify(v) === JSON.stringify(meta[k]));
      const changed = Object.keys(meta).filter((k) => Object.hasOwn(started, k) && !same(k));
      if (changed.length) throw new UserError(`${id} was started with ${changed.join(', ')}; start facts cannot change`);
      const added = Object.fromEntries(Object.entries(meta).filter(([k]) => !Object.hasOwn(started, k)));
      return { add: Object.keys(added).length ? [{ type: 'run.updated', id, meta: added }] : [] };
    }
    const target = requireItem(s, id);
    if (target.meta.operator_reserved && Object.keys(parsed).some(key => ['role', 'meta.operator_reserved', 'meta.category', 'meta.release', 'meta.answer', 'meta.answered_by'].includes(key))) throw new UserError('release decision fields are immutable; use record answer as the operator');
    const fields = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith('budget.')) {
        checkBudget(key.slice(7), value);
        fields.budget = { ...fields.budget, [key.slice(7)]: value };
      } else if (key.startsWith('meta.')) {
        fields.meta = { ...fields.meta, [key.slice(5)]: value };
      } else if (key === 'parent') {
        if (value !== null) {
          requireItem(s, String(value));
          if (wouldCycleParent(s, id, String(value))) throw new UserError(`${value} cannot be the parent of ${id}: that would create a cycle`);
        }
        fields.parent = value === null ? null : String(value);
      } else if (key === 'priority') {
        if (value !== null && typeof value !== 'number') throw new UserError('priority must be a number');
        fields.priority = value;
      } else if (key === 'title') {
        if (value === null) throw new UserError('title cannot be empty');
        fields.title = String(value);
      } else if (ITEM_FIELDS.includes(key)) {
        fields[key] = value === null ? null : String(value).toLowerCase();
      } else {
        throw new UserError(`unknown field "${key}" (items: ${ITEM_FIELDS.join(', ')}, budget.<key>, meta.<key>)`);
      }
    }
    return { add: [{ type: 'item.updated', id, fields }] };
  });
  out(added.length ? describeEvent(added[0]) + '\n' : `${id} unchanged\n`);
  return 0;
}

function close(argv) {
  const { values, positionals } = args(argv, { dropped: { type: 'boolean' }, note: { type: 'string' }, 'if-current-run': { type: 'string' } },
    { min: 1, max: 1, usage: 'record close <ID> [--dropped] [--note TEXT] [--if-current-run R-n]' });
  const id = positionals[0];
  const as = values.dropped ? 'dropped' : 'done';
  const { added, result } = mutate(openOrg(), (s, events) => {
    const item = requireItem(s, id);
    if (item.meta.operator_reserved && writer().actor !== 'human') throw new UserError('release questions are reserved for the operator');
    if (proposalSelection(item) && proposalSelection(item) !== 'selected') throw new UserError('unselected proposal records require explicit selection or an owning proposal disposition');
    if (values['if-current-run'] !== undefined) {
      const runId = values['if-current-run'];
      requireCurrentRun(s, id, runId);
      const run = s.runs.get(runId);
      if (run.abandoned || run.report?.outcome !== 'done') throw new UserError('conditional close requires a recorded done report');
      if (item.outcome && item.outcome.run !== runId) throw new UserError(`${id} outcome does not belong to ${runId}`);
      const blocked = blockersOf(s, id).some((b) => !dependencyReleases(s, b, id, itemStatus(s, b, new Set(), id)));
      if (openRuns(s, id).length || blocked || ['blocked', 'needs_human', 'dropped'].includes(itemStatus(s, id))) throw new UserError('conditional close needs supervisor judgment: work, blockers or outcome changed');
      // A done report may survive explicit reopening. Its ingestion revision
      // binds completion to the first subsequent closure, even for old receipts.
      // Read that history inside this transaction, alongside the current-run guard.
      if (!item.closed && events.some((e) => e.type === 'item.closed' && e.id === id && e.seq > run.report.seq)) {
        throw new UserError(`${id} was reopened after completion of ${runId}; conditional close needs supervisor judgment`);
      }
    }
    if (item.closed?.as === as) return { add: [], result: [] };
    return { add: [{ type: 'item.closed', id, as, note: values.note ?? null,...(values['if-current-run']?{completed_run:values['if-current-run']}:{}) }],
      result: { open: openRuns(s, id).map((r) => r.id), trials: trialsAffectedByClose(s, events, id) } };
  }, { closeRun: values['if-current-run'] });
  if (!added.length) {
    out(`${id} is already ${as}\n`);
    return 0;
  }
  out(`${id} closed as ${as}\n`);
  if (result.open.length) out(`note: ${result.open.join(', ')} still open; a report from it will still be recorded\n`);
  for (const trial of result.trials) out(`warning: active trial ${trial.id} is owned by ${trial.owner}; closing ${id} does not complete or withdraw it. Trial-owner admission must be installed to ignore ordinary closure; explicit holds and reservations still refuse admission.\n`);
  return 0;
}

function reopen(argv) {
  const { values, positionals } = args(argv, { note: { type: 'string' }, 'if-current-run': { type: 'string' } }, { min: 1, max: 1, usage: 'record reopen <ID> [--note TEXT] [--if-current-run R-n]' });
  const id = positionals[0];
  const { added } = mutate(openOrg(), (s) => {
    const item = requireItem(s, id);
    if (item.meta.operator_reserved && writer().actor !== 'human') throw new UserError('release questions are reserved for the operator');
    if (values['if-current-run'] !== undefined) {
      requireCurrentRun(s, id, values['if-current-run']);
      if (item.closed) throw new UserError(`${id} is closed; conditional reopen needs supervisor judgment`);
      if (item.outcome && item.outcome.run !== values['if-current-run']) throw new UserError(`${id} outcome does not belong to ${values['if-current-run']}`);
    }
    if (!item.closed && !item.outcome) return { add: [] };
    return { add: [{ type: 'item.reopened', id, note: values.note ?? null }] };
  });
  out(added.length ? `${id} reopened\n` : `${id} is already open\n`);
  return 0;
}

function start(argv) {
  const { values, positionals } = args(argv, {
    route: { type: 'string' },
    'route-config': { type: 'string' },
    harness: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    workspace: { type: 'string' },
    report: { type: 'string' },
    escalation: { type: 'boolean' },
    'if-current-run': { type: 'string' },
    'defer-preparation': { type: 'boolean' },
    meta: { type: 'string', multiple: true },
  }, { min: 1, max: 1, usage: 'record start <ID> [--route R [--route-config FILE] | --harness H --model M --effort E] [options]' });
  const id = positionals[0];
  const meta = parsePairs(values.meta, '--meta');
  if (values['route-config'] !== undefined && values.route === undefined) {
    throw new UserError('--route-config requires --route');
  }
  if (values.route !== undefined) {
    const copied = ['harness', 'model', 'effort'].filter((key) => values[key] !== undefined);
    if (copied.length > 0) throw new UserError(`--route cannot be combined with ${copied.map((key) => `--${key}`).join(', ')}`);
    let resolved;
    try {
      const config = values['route-config'] === undefined ? loadDiscoveredRoutes({ cwd: process.cwd() }).config : readRoutesSnapshot(values['route-config']);
      resolved = resolveRoute(config, { route: values.route });
    } catch (error) {
      throw new UserError(error.message);
    }
    meta.route = values.route;
    meta.harness = resolved.kind;
    if (resolved.model !== undefined) meta.model = resolved.model;
    if (resolved.effort !== undefined) meta.effort = resolved.effort;
  }
  for (const key of ['harness', 'model', 'effort']) if (values[key]) meta[key] = values[key];
  if (values.escalation) meta.escalation = true;
  const workspace = path.resolve(values.workspace ?? process.cwd());
  const deferred = values['defer-preparation'] === true;
  const archive = deferred ? null : briefArchive(workspace);
  const ctx = openOrg();
  const { result, added } = mutate(ctx, (s) => {
    const item = requireItem(s, id);
    if (item.meta.operator_reserved && writer().actor !== 'human') throw new UserError('release questions are reserved for the operator');
    if (proposalSelection(item) && proposalSelection(item) !== 'selected') throw new UserError('select the proposal separately with meta.queue_selected=true before starting work');
    if (values['if-current-run'] !== undefined) {
      requireCurrentRun(s, id, values['if-current-run']);
      if (item.closed) throw new UserError(`${id} is closed; conditional start needs supervisor judgment`);
      if (item.outcome && item.outcome.run !== values['if-current-run']) throw new UserError(`${id} outcome does not belong to ${values['if-current-run']}`);
    }
    const runId = nextRunId(s);
    const runDir = path.join(ctx.dir, 'runs', runId);
    const events = [];
    if (item.closed) events.push({ type: 'item.reopened', id, note: `reopened by starting ${runId}` });
    events.push({
      type: 'run.started',
      id: runId,
      item: id,
      meta,
      workspace,
      report_path: path.resolve(values.report ?? path.join(runDir, 'report.md')),
      brief_path: path.join(runDir, 'brief.md'),
      ...(deferred ? { preparation_deferred: true } : {}),
    });
    return { add: events, result: { runId, reopened: Boolean(item.closed), parallel: openRuns(s, id).map((r) => r.id) } };
  }, undefined, { deferCloseout: deferred });

  // The committed source is the recovery anchor. No publication, record reload,
  // archive discovery or filesystem preparation belongs to this start reply.
  if (deferred) {
    const run = added.find(e => e.type === 'run.started');
    safeOut(`${run.id} started on ${id}\n  preparation deferred; run record brief ${run.id} --prepare-start\n`);
    return 0;
  }

  const after = openOrg();
  const run = after.state.runs.get(result.runId);
  const brief = renderBrief(after.state, run.id, { ...view(after), ...archive });
  writeFileAtomic(run.brief_path, brief);
  fs.mkdirSync(path.dirname(run.report_path), { recursive: true });

  const label = [meta.harness, meta.model, meta.effort].filter(Boolean).join(' · ');
  safeOut(`${run.id} started on ${id} "${truncate(after.state.items.get(id).title, 60)}"${label ? ` [${label}]` : ''}\n`);
  if (result.reopened) safeOut(`  (${id} was closed; reopened)\n`);
  safeOut(`  brief   ${run.brief_path}  (${brief.length} chars ≈ ${approxTokens(brief)} tokens)\n`);
  safeOut(`  report  ${run.report_path}\n`);
  safeOut(`  prompt  Read ${run.brief_path} and follow it.\n`);
  if (result.parallel.length) safeOut(`note: ${id} already has open runs: ${result.parallel.join(', ')}\n`);
  for (const a of attention(after.state, after.config, after.now).filter((a) => a.id === id && a.kind === 'budget')) {
    safeOut(`note: ${id} ${a.text}\n`);
  }
  return 0;
}

function worker(argv) {
  const { values: v, positionals: [id] } = args(argv, Object.fromEntries(
    ['agent', 'pane', 'worker-workspace', 'cwd', 'terminal-id', 'agent-session-id'].map(k => [k, { type: 'string' }])),
  { min: 1, max: 1, usage: 'record worker R-n --agent NAME --pane ID --worker-workspace ID --cwd DIR [--terminal-id ID] [--agent-session-id ID]' });
  for (const key of ['agent', 'pane', 'worker-workspace', 'cwd']) {
    if (!v[key]?.trim()) throw new UserError(`--${key} is required`);
  }
  if (!v['terminal-id']?.trim() && !v['agent-session-id']?.trim()) throw new UserError('worker needs at least one occupant identity');
  const meta = { agent: v.agent, pane: v.pane, worker_workspace: v['worker-workspace'],
    ...(v['terminal-id'] ? { terminal_id: v['terminal-id'] } : {}),
    ...(v['agent-session-id'] ? { agent_session_id: v['agent-session-id'] } : {}) };
  mutate(openOrg(), s => {
    const run = s.runs.get(id);
    if (!run) throw new UserError(`unknown run ${id}`);
    if (!run.workspace || fs.realpathSync(run.workspace) !== fs.realpathSync(v.cwd)) throw new UserError('worker cwd does not match run workspace');
    const keys = ['agent', 'pane', 'worker_workspace', 'terminal_id', 'agent_session_id'];
    for (const key of keys) {
      if (run.meta[key] != null && run.meta[key] !== meta[key]) throw new UserError(`worker launch ${key} mismatch`);
    }
    const complete = run.meta.agent && run.meta.pane && run.meta.worker_workspace && (run.meta.terminal_id || run.meta.agent_session_id);
    if (complete) {
      if (keys.some(key => (run.meta[key] ?? null) !== (meta[key] ?? null))) throw new UserError('worker launch identity differs from recorded receipt');
      return { add: [] };
    } // Lost reply: exact identity only, never enrich a receipt later.
    if (keys.some(key => run.meta[key] != null)) throw new UserError('cannot backfill a partial worker launch receipt');
    if (run.report || run.abandoned) throw new UserError('cannot backfill a settled worker launch');
    if ([...s.runs.values()].some(other => other.started.seq > run.started.seq && other.meta.agent === meta.agent)) throw new UserError('worker name belongs to a newer run');
    return { add: [{ type: 'run.updated', id, meta }] };
  });
  safeOut(`${id} worker launch recorded\n`);
  return 0;
}

async function ingestFile(ctx, file, runHint, currentRun, selfClosedSeq) {
  const abs = path.resolve(file);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    throw new UserError(`cannot read ${abs}: ${error.code ?? error.message}`);
  }
  const parsed = readReport(text);
  const fail = (errors) => ({ ok: false, file: abs, errors, warnings: parsed.warnings });
  if (parsed.errors.length) return fail(parsed.errors);
  const runId = runHint ?? parsed.report.run;
  if (!runId) return fail(['the report does not say which run it belongs to: add "run: R-<n>" or pass --run']);
  if (runHint && parsed.report.run && parsed.report.run !== runHint) {
    return fail([`the report says run ${parsed.report.run} but --run is ${runHint}`]);
  }
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');
  // Load review services before the synchronous record transaction, only for intake.
  const { reviewResultEvents } = await import('../line-service/phase1.mjs');
  const { correctionDischargeEvents } = await import('../lib/correction-discharge.mjs');
  const { result } = mutate(ctx, (s, committedEvents) => {
    const run = s.runs.get(runId);
    if (!run) throw new UserError(`unknown run ${runId}`);
    if (currentRun !== undefined) {
      if (currentRun !== runId) throw new UserError(`conditional ingest names ${currentRun}, but the report belongs to ${runId}`);
      requireCurrentRun(s, run.item, currentRun);
    }
    if (run.report) {
      if (run.report.sha256 === sha256) {
        const add = reviewResultEvents({ state:s, events:committedEvents, run, report:parsed.report, sha256, body:parsed.body, minorBackfillOnly:true });
        const discharges = correctionDischargeEvents({ state:s, run, report:parsed.report, sha256, org:ctx.dir });
        add.push(...discharges);
        return { add, result: { already: true, runId, correctionDischarged: discharges.length > 0,
          minorBatches: add.filter(e=>e.type==='item.added').map(e=>e.id) } };
      }
      throw new UserError(`${runId} already has a report (recorded ${run.report.at}); start a new run to report again`);
    }
    if (run.abandoned) {
      return { add: [], result: { skipped: true, runId, item: run.item } };
    }
    const already_closed_by_run=selfClosedDecision(run,s,committedEvents);
    if(selfClosedSeq!==undefined&&(!already_closed_by_run||String(already_closed_by_run.seq)!==selfClosedSeq))
      throw new UserError('original self-closed decision changed before report intake');
    const stored = path.join('reports', `${runId}.md`);
    const report = { ...parsed.report, run: runId };
    const late = laterRuns(s, runId).some((r) => r.report);
    let brief_sha256;
    try{if(run.brief_path&&fs.lstatSync(run.brief_path).isFile())brief_sha256=crypto.createHash('sha256').update(fs.readFileSync(run.brief_path)).digest('hex');}catch{/* Unknown brief does not fabricate a revision. */}
    const events = [{ type: 'report.ingested', run: runId, item: run.item, file: stored, source: abs, sha256, late, report,
      ...completionSession(run, s), ...(brief_sha256?{brief_sha256}:{}),
      ...(already_closed_by_run?{already_closed_by_run}:{}) }];
    const categoryFlags = reportCategoryFlags(ctx.config, report);
    for (const flag of categoryFlags) events.push({ type: 'category.flagged', id: run.item, run: runId, ...flag });
    const taken = new Set();
    const created = [];
    const proposals = proposalIntakeEvents({ state:s, events:committedEvents, run, report, sha256 });
    for (const e of proposals) if (e.type === 'item.added') {
      taken.add(e.id);
      created.push({ id:e.id, title:e.title, role:e.role,
        blocking:proposals.some(l=>l.type==='link.added'&&l.blocker===e.id&&l.blocked===run.item),
        reviewHold:false });
    }
    events.push(...proposals);
    const reviewFacts=reviewResultEvents({state:s,events:committedEvents,run,report,sha256,body:parsed.body,usedIds:taken});
    for(const e of reviewFacts)if(e.type==='item.added')created.push({id:e.id,title:e.title,role:e.role,
      blocking:reviewFacts.some(link=>link.type==='link.added'&&link.blocker===e.id&&link.blocked===run.item),reviewHold:false});
    const reviewed=reviewFacts.find(e=>e.type==='change.reviewed');
    // Normalize the explicit judgment for existing folded-report consumers.
    // The immutable stored bytes/hash retain its original body/frontmatter.
    if(reviewed)report.extra={...report.extra,verdict:reviewed.verdict};
    events.push(...reviewFacts);
    events.push(...correctionDischargeEvents({ state: s, run, report, sha256, org: ctx.dir }));
    return {
      add: events,
      commit: () => writeFileAtomic(path.join(ctx.dir, stored), text, 0o444),
      actor: `run:${runId}`,
      result: { runId, item: run.item, created, categoryFlags, late, outcome: report.outcome, summary: report.summary },
    };
  });
  return { ok: true, file: abs, warnings: parsed.warnings, ...result };
}

function printSkippedReport(runId) {
  safeOut(`${runId}: report skipped because the run was abandoned; it will not be ingested\n`);
}

function printIngest(res) {
  if (!res.ok) {
    err(`${res.file}: not recorded\n`);
    for (const e of res.errors) err(`  error: ${e}\n`);
    for (const w of res.warnings) err(`  warning: ${w}\n`);
    return false;
  }
  if (res.skipped) {
    printSkippedReport(res.runId);
    return true;
  }
  if (res.already) {
    safeOut(`${res.runId}: report already recorded\n`);
    if (res.correctionDischarged) safeOut('  + correction discharged from the unchanged report and original proof\n');
    for (const id of res.minorBatches ?? []) safeOut(`  + ${id} unselected Minor batch from the immutable report\n`);
    return true;
  }
  safeOut(`${res.runId} → ${res.outcome} on ${res.item}${res.late ? ' (late: a newer run already has a report)' : ''}: ${truncate(res.summary, 100)}\n`);
  for (const c of res.created) {
    safeOut(`  + ${c.id} "${truncate(c.title, 60)}"${c.role ? ` (${c.role})` : ''}${c.blocking || c.reviewHold ? ` blocks ${res.item}` : ''}\n`);
  }
  for (const w of res.warnings) safeOut(`  warning: ${w}\n`);
  for (const flag of res.categoryFlags ?? []) safeOut(`  warning: ${categoryFlagText({ ...flag, run: res.runId })}\n`);
  const after = openOrg();
  const status = itemStatus(after.state, res.item);
  safeOut(`${res.item} is now ${status}\n`);
  if (isResolved(status)) {
    for (const blocked of blockedBy(after.state, res.item)) {
      const now = itemStatus(after.state, blocked);
      if (now !== 'blocked') safeOut(`${blocked} is no longer blocked by ${res.item} (now ${now})\n`);
    }
  }
  const touched = new Set([res.item, ...res.created.map((c) => c.id)]);
  for (const a of attention(after.state, after.config, after.now).filter((a) => touched.has(a.id) && a.kind === 'budget')) {
    safeOut(`note: ${a.id} ${a.text}; recorded, not refused\n`);
  }
  return true;
}

async function ingest(argv) {
  const { values, positionals } = args(argv, { run: { type: 'string' }, 'if-current-run': { type: 'string' }, 'if-self-closed': { type: 'string' } }, { min: 1, max: 1, usage: 'record ingest <report.md> [--run R-n] [--if-current-run R-n] [--if-self-closed SEQ]' });
  return printIngest(await ingestFile(openOrg(), positionals[0], values.run, values['if-current-run'], values['if-self-closed'])) ? 0 : 1;
}

async function sync(argv) {
  args(argv, {}, { max: 0, usage: 'record sync' });
  const ctx = openOrg();
  const runs = [...ctx.state.runs.values()];
  const waiting = runs.filter((r) => !r.report && fs.existsSync(r.report_path));
  if (!waiting.length) {
    const open = runs.filter((r) => !r.report && !r.abandoned).length;
    out(`nothing to record (${open} open run${open === 1 ? '' : 's'} without a report)\n`);
    return 0;
  }
  let failed = 0;
  for (const run of waiting) {
    if (run.abandoned) {
      printSkippedReport(run.id);
      continue;
    }
    if (!printIngest(await ingestFile(openOrg(), run.report_path, run.id))) failed++;
  }
  return failed ? 1 : 0;
}

function check(argv) {
  const { positionals } = args(argv, {}, { min: 1, max: 1, usage: 'record check <report.md>' });
  const abs = path.resolve(positionals[0]);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    throw new UserError(`cannot read ${abs}: ${error.code ?? error.message}`);
  }
  const parsed = readReport(text);
  for (const e of parsed.errors) err(`error: ${e}\n`);
  for (const w of parsed.warnings) err(`warning: ${w}\n`);
  if (parsed.errors.length) return 1;
  const r = parsed.report;
  const dir = findOrgDir();
  if (isOrgDir(dir)) for (const flag of reportCategoryFlags(readConfig(dir), r)) {
    err(sanitizeTerminal(`warning: ${categoryFlagText(flag)}\n`));
  }
  if (!r.run) {
    err('warning: no "run:" field; recording it will need --run\n');
  } else if (isOrgDir(dir)) {
    const run = fold(loadEvents(dir).events).runs.get(r.run);
    if (!run) err(`warning: run ${r.run} is not in the record at ${dir}\n`);
    else if (run.report) err(`warning: ${r.run} already has a recorded report\n`);
  }
  const count = (list, word) => `${list.length} ${word}${list.length === 1 ? '' : 's'}`;
  out(`ok: ${r.outcome} · ${count(r.blockers, 'blocker')} · ${count(r.proposals, 'proposal')} · ${count(r.learnings, 'learning')} · ${count(r.artifacts, 'artifact')}\n`);
  return 0;
}

function abandon(argv) {
  const { values, positionals } = args(argv, { note: { type: 'string' } }, { min: 1, max: 1, usage: 'record abandon <R-n> [--note TEXT]' });
  const id = positionals[0];
  const { added } = mutate(openOrg(), (s) => {
    const run = s.runs.get(id);
    if (!run) throw new UserError(`unknown run ${id}`);
    if (run.report) throw new UserError(`${id} already has a report; nothing to abandon`);
    if (run.abandoned) return { add: [] };
    return { add: [{ type: 'run.abandoned', id, note: values.note ?? null }] };
  });
  out(added.length
    ? `${id} abandoned; its item is free for a new run; a later report will not be ingested\n`
    : `${id} was already abandoned; a later report will not be ingested\n`);
  return 0;
}

function brief(argv) {
  const { positionals, values } = args(argv, { 'prepare-start': { type: 'boolean' } },
    { min: 1, max: 1, usage: 'record brief <R-n> [--prepare-start]' });
  const ctx = openOrg();
  const run = ctx.state.runs.get(positionals[0]);
  if (!run) throw new UserError(`unknown run ${positionals[0]}`);
  if (values['prepare-start']) {
    const source = ctx.events.find(e => e.type === 'run.started' && e.id === run.id);
    if (!source?.preparation_deferred) throw new UserError(`${run.id} has no deferred start preparation`);
    // Include an atomic reopen, if present. Replay only publication of these
    // original facts, never the start mutation or its authority checks.
    const reopen = ctx.events.find(e => e.seq === source.seq - 1 && e.type === 'item.reopened' &&
      e.id === run.item && e.note === `reopened by starting ${run.id}`);
    publishCloseoutEvents({ org: ctx.dir, added: [...(reopen ? [reopen] : []), source], deferBusy: true });
    if (reopen) {
      try { requestRetirement({ org: ctx.dir, eventSeq: source.seq, source: 'record start' }); }
      catch (e) { err(`record: retirement request deferred: ${e.message}\n`); }
    }
    fs.mkdirSync(path.dirname(run.report_path), { recursive: true });
  }
  if (!fs.existsSync(run.brief_path)) writeFileAtomic(run.brief_path, renderBrief(ctx.state, run.id,
    { ...view(ctx), ...briefArchive(run.workspace) }));
  out(fs.readFileSync(run.brief_path, 'utf8'));
  return 0;
}

function status(argv) {
  const { values } = args(argv, { json: { type: 'boolean' } }, { max: 0, usage: 'record status [--json]' });
  const ctx = openOrg();
  out(values.json ? JSON.stringify(statusJson(ctx.state, view(ctx)), null, 2) + '\n' : renderStatus(ctx.state, view(ctx)));
  return 0;
}

function snapshot(argv) {
  args(argv, {}, { max: 0, usage: 'record snapshot' });
  const ctx = openOrg();
  const text = renderSnapshot(ctx.state, view(ctx));
  out(text);
  err(`snapshot: ${text.length} chars ≈ ${approxTokens(text)} tokens\n`);
  return 0;
}

function show(argv) {
  const { values, positionals } = args(argv, { json: { type: 'boolean' }, compact: { type: 'boolean' } }, { min: 1, max: 1, usage: 'record show <ID> [--json] [--compact]' });
  const ctx = openOrg({ readOnly: true, compact: values.compact });
  try {
    const id = positionals[0];
    if (ctx.state.items.has(id)) {
      out(values.json ? JSON.stringify(itemJson(ctx.state, id), null, 2) + '\n' : renderShowItem(ctx.state, id, view(ctx)));
    } else if (ctx.state.runs.has(id)) {
      out(values.json ? JSON.stringify(ctx.state.runs.get(id), null, 2) + '\n' : renderShowRun(ctx.state, id, view(ctx)));
    } else {
      throw new UserError(`unknown item or run ${id}`);
    }
  } finally { ctx.close?.(); }
  return 0;
}

function today(argv) {
  const { values } = args(argv, { json: { type: 'boolean' }, parked: { type: 'boolean' } }, { max: 0, usage: 'record today [--json] [--parked]' });
  const ctx = openOrg();
  const doc = todayJson(ctx.state, { orgDir: ctx.dir, config: ctx.config, now: ctx.now });
  if (values.parked) doc.waiting = doc.waiting.filter(w => w.parked);
  out(values.json ? JSON.stringify(doc, null, 2) + '\n' : renderToday(doc, { parked: values.parked }));
  return 0;
}

export function parseSince(text, now) {
  const relative = /^(\d+)\s*([mhd])$/.exec(text);
  if (relative) return new Date(now.getTime() - Number(relative[1]) * { m: 60000, h: 3600000, d: 86400000 }[relative[2]]);
  const time = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (time) {
    const d = new Date(now);
    d.setHours(Number(time[1]), Number(time[2]), 0, 0);
    return d;
  }
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) throw new UserError(`--since expects 2h, 30m, 1d, 09:00 or a date (got "${text}")`);
  return d;
}

function log(argv) {
  const { values } = args(argv, { since: { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean' } },
    { max: 0, usage: 'record log [--since 2h|09:00|DATE] [--limit N] [--json]' });
  const ctx = openOrg();
  let events = ctx.events;
  if (values.since) {
    const since = parseSince(values.since, ctx.now);
    events = events.filter((e) => new Date(e.at) >= since);
  }
  const limit = values.limit != null ? Number(values.limit) : values.since ? Infinity : 30;
  if (Number.isFinite(limit)) events = events.slice(-limit);
  out(values.json ? events.map((e) => JSON.stringify(e) + '\n').join('') : renderLog(events));
  return 0;
}

const lazy = (file, name) => async (argv) => (await import(file))[name](argv);

const COMMANDS = {
  obligations: lazy('../lib/obligations-command.mjs', 'obligationsCommand'),
  template: argv => { args(argv, {}, { max: 0, usage: 'record template' }); out(DISPATCH_TEMPLATE); return 0; },
  lookup: argv => import('../lib/lookup.mjs').then(module => module.lookupCommand(argv, { out })),
  messages: async argv => (await import('../messages/record-command.mjs')).messagesCommand(argv, { openOrg, mutate, out }),
  nudge: async argv => (await import('../measurement/nudge-command.mjs')).nudgeCommand(argv, { openOrg, mutate, out }),
  witness: async argv => (await import('../measurement/witness-command.mjs')).witnessCommand(argv, { openOrg, mutate, out }),
  lesson, lessons,
  'complete-batch': argv => completeBatchCommand(argv, { openOrg, mutate, out }),
  releases: argv => releasesCommand(argv, { openOrg, out }),
  handoffs: argv => handoffsCommand(argv, { openOrg, mutate, out }),
  init, add, 'queue-review': queueReview,
  proposals: async argv => (await import('../lib/proposals-command.mjs')).proposalsCommand(argv, { openOrg, mutate, out }),
  block, unblock: (argv) => block(argv, true), note, 'amend-accept': amendAccept, ask, answer, set, close, reopen,
  start, worker, check, ingest, sync, abandon, brief, status, snapshot, show, log, today,
  // Module views load only when used, so a fault in one of them cannot break every record command.
  claim: lazy('../lib/run-owner.mjs', 'claimCommand'),
  handoff: lazy('../lib/retire-command.mjs', 'handoffCommand'),
  'pane-release': lazy('../lib/retire-command.mjs', 'releaseCommand'),
  'report-available': lazy('../lib/report-availability.mjs', 'reportAvailableCommand'),
  'session-bind': lazy('../dispatch/session-bind-command.mjs', 'sessionBindCommand'),
  desks: lazy('../settle/desks-command.mjs', 'desksCommand'),
  config: lazy('../lib/config-command.mjs', 'configCommand'),
  adopt: lazy('../lib/adopt-command.mjs', 'adoptCommand'),
  routes: lazy('../lanes/routes-command.mjs', 'routesCommand'),
  housekeeping: lazy('../housekeeping/command.mjs', 'housekeepingCommand'),
  summary: lazy('../lib/project-summary.mjs', 'summaryCommand'),
};

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) {
    out(USAGE);
    return 0;
  }
  if (!Object.hasOwn(COMMANDS, command)) throw new UserError(`unknown command "${command}" (see: record help)`);
  const result = await COMMANDS[command](rest);
  return result;
}

process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

try {
  // Explicit messages/queue-review source entries are scoped to this real root.
  // Immutable release continuations and every other record command retain pin
  // selection. This selector never supplies native, record or run authority.
  const selected = ['messages', 'queue-review'].includes(process.argv[2]) && process.env.HERDR_BRAIN_ROOT ? bundleRelease() : null;
  const sourceEntry = selected && !selected.commit;
  if (sourceEntry && (fs.realpathSync(process.env.HERDR_BRAIN_ROOT) !== selected.root ||
      gitProject(selected.root, { env: projectEnvironment() }).checkout !== selected.root))
    throw new UserError('HERDR_BRAIN_ROOT must match the invoked development source root; no source action performed');
  const forwarded = sourceEntry || ['help', '--help', '-h'].includes(process.argv[2]) ? null : forwardRelease('bin/org.mjs', process.cwd());
  process.exitCode = forwarded ?? await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UserError || error instanceof FleetError || String(error.code).startsWith('ERR_PARSE_ARGS')) {
    err(`record: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  } else {
    throw error;
  }
}
