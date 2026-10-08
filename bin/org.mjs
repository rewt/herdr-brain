#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gitProject, ignoreRuntime } from '../lib/project.mjs';
import { readFleet, FleetError } from '../lib/fleet.mjs';
import {
  UserError, findOrgDir, initOrg, isOrgDir, loadEvents, now as clock, readConfig, transact, writeFileAtomic, writer,
} from '../lib/store.mjs';
import {
  BUDGET_KEYS, attention, blockedBy, fold, isResolved, itemStatus, laterRuns, nextItemId, nextRunId, openRuns,
  wouldCycleBlock, wouldCycleParent, releases, nextLessonId, lessonState, wouldCycleLesson,
} from '../lib/state.mjs';
import { lessonProposal, lessonsJson } from '../lib/lessons.mjs';
import { readReport } from '../lib/report.mjs';
import { approvalPolicy, CATEGORY_CHECKLIST, categoryFlag, categoryFlagText, reportCategoryFlags } from '../lib/discernment.mjs';
import { sanitizeTerminal } from '../lib/sanitize.mjs';
import { renderToday, todayJson } from '../lib/today.mjs';
import { blockJson, renderBlock } from '../lib/block.mjs';
import { digestJson, readDigestJournal } from '../lib/digest.mjs';
import { loadDiscoveredRoutes, resolveRoute } from '../lanes/routes.mjs';
import { desksCommand } from '../settle/desks-command.mjs';
import { routesCommand } from '../lanes/routes-command.mjs';
import { housekeepingCommand } from '../housekeeping/command.mjs';
import { releaseRecordCommand } from '../lib/release-record.mjs';
import { prioritiesJson, itemServes, validateServes } from '../lib/priorities.mjs';
import {
  approxTokens, describeEvent, itemJson, renderBrief, renderLog, renderShowItem, renderShowRun,
  renderSnapshot, renderStatus, statusJson, truncate, renderPriorities, renderLessons,
  renderDigest,
} from '../lib/render.mjs';

const BIN = fileURLToPath(import.meta.url);

const USAGE = `record: durable organizational state for agent R&D (no daemon, no inference)

Setup
  record init [dir]                       create a record (default ./.org)

Work
  record add <title> [--goal] [--role R] [--capability C] [--parent ID]
          [--blocked-by ID]... [--accept TEXT]... [--priority N] [--budget key=N]...
  record block <ID> --by <ID>             record that --by blocks ID
  record unblock <ID> --by <ID>           remove that blocking link
  record note <ID> <text> [--decision [--summary TEXT]]
                                          attach a note or decision (summary: one plain sentence)

Questions for the operator
  record ask "<yes/no question>" --parent ID --category C --recommend ANSWER --why TEXT
          [--on-yes T] [--on-no T] [--memo PATH] [--blocks ID]... [--priority N] [--wait]
                                          a role=human item; --wait always requires an operator answer
  record answer <ID> yes|no|"<text>" [--note WHY] [--overrule]
                                          a "no" keeps the work it blocks blocked
  record priorities [--json]             operator outcomes, ranks, work and who/why
  record priorities add TITLE --why TEXT  operator adds an outcome at the end
  record priorities rank P-n --rank N --why TEXT [--expect REV]
  record priorities propose QUESTION --parent ID --recommend yes --why TEXT
  record set <ID> key=value...            edit an item (title role capability priority parent
                                          budget.<key> meta.<key>) or record run metadata
                                          (e.g. record set R-3 tokens_in=48210 tokens_out=5120)
  record close <ID> [--dropped] [--note T] [--if-current-run R-n]
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
  record start <ID> [--route R [--route-config FILE] | --harness H --model M --effort E] [--workspace DIR]
          [--report PATH] [--escalation] [--meta key=value]... [--if-current-run R-n]
  record worker <R-n> --agent NAME --pane ID --worker-workspace ID --cwd DIR
          [--terminal-id ID] [--agent-session-id ID]
                                          launcher receipt; use dispatch/record-worker.mjs at launch
  record check <report.md>                validate a report without recording anything
  record ingest <report.md> [--run R-n] [--if-current-run R-n]
                                          record a report; optional guard checked under the log lock
  record sync                             record every report waiting at an open run's report path
  record abandon <R-n> [--note T]         give up on a run (a later report is still accepted)
  record brief <R-n>                      print the brief a run was given

Views (zero inference)
  record status [--json]                  one-screen overview
  record snapshot                         markdown state for a fresh session of any harness
  record show <ID> [--json]               an item or run with its reports and history
  record log [--since 2h|09:00|DATE] [--limit N] [--json]
  record digest [--since 2h|09:00|DATE | --after CURSOR] [--limit N] [--width N] [--json]
                                          chat catch-up; read-only, cursor belongs to the chat
  record today [--json] [--parked]        what waits on the operator; --parked lists questions older than 7 days
  record recap [--back N] [--json]        the latest work block top down: threads, what they spawned,
                                          asked and were told, what is pending (--back 1: the one before)
  record console [--project NAME] [--modern] the Herdr Monitor console (needs: npm --prefix console ci)
  record housekeeping [--json]            schedule status, last scan and recent activity
  record releases [--json] [--identity DIR] candidates, gate evidence and operator decisions
  record release cut --file JSON | start RC-n | result RC-n --file JSON
                                          release-module receipts (never executes a gate or ship)
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
Runs name alignment with start --serves P-n (or --meta serves=P-n). Item meta.serves
inherits through parents; --serves= starts explicitly unaligned. Alignment is advisory.
Priority changes require ORG_ACTOR=human; named agents propose waiting questions.
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

function openOrg({ readOnly = false } = {}) {
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
  const { events, tornTail } = loadEvents(dir);
  return { dir, events, tornTail, state: fold(events), config: readConfig(dir), now: clock() };
}

function view(ctx) {
  return { orgDir: ctx.dir, events: ctx.events, tornTail: ctx.tornTail, config: ctx.config, now: ctx.now, cli: cliString(ctx.dir) };
}

let warnedUnattributed = false;
function mutate(ctx, fn) {
  const who = writer();
  if (who.unattributed && !warnedUnattributed) {
    warnedUnattributed = true;
    err('record: recorded as human but unattributed (no ORG_ACTOR, no terminal). An agent session sets ORG_ACTOR=<its session name>.\n');
  }
  const res = transact(ctx.dir, (events) => fn(fold(events), events), {
    at: ctx.now,
    actor: who.actor,
    unattributed: who.unattributed,
  });
  if (res.repaired) err('record: repaired an incomplete last event left by an interrupted write\n');
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
  readFleet();
  const { positionals } = args(argv, {}, { max: 1, usage: 'record init [dir]' });
  const dir = path.resolve(positionals[0] ?? process.env.ORG_DIR ?? '.org');
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
    priority: { type: 'string' },
    budget: { type: 'string', multiple: true },
    meta: { type: 'string', multiple: true },
  }, { min: 1, usage: 'record add <title> [options]' });
  const title = positionals.join(' ').trim();
  if (!title) throw new UserError('a title is required');
  const budget = parsePairs(values.budget, '--budget');
  for (const [key, value] of Object.entries(budget)) checkBudget(key, value);
  const priority = values.priority == null ? null : Number(values.priority);
  if (values.priority != null && !Number.isFinite(priority)) throw new UserError('--priority must be a number');
  const kind = values.goal ? 'goal' : 'work';
  const { result } = mutate(openOrg(), (s) => {
    validateServes(s, parsePairs(values.meta, '--meta').serves);
    if (values.parent) requireItem(s, values.parent);
    const blockers = [...new Set(values['blocked-by'] ?? [])];
    blockers.forEach((b) => requireItem(s, b));
    const id = nextItemId(s, { kind, role: values.role });
    const events = [{
      type: 'item.added', id, kind, title,
      role: values.role?.toLowerCase() ?? null,
      capability: values.capability ?? null,
      parent: values.parent ?? null,
      priority,
      accept: values.accept ?? [],
      budget,
      meta: parsePairs(values.meta, '--meta'),
    }];
    for (const blocker of blockers) events.push({ type: 'link.added', blocker, blocked: id });
    return { add: events, result: id };
  });
  out(`${result}\n`);
  return 0;
}

function block(argv, remove = false) {
  const usage = `record ${remove ? 'unblock' : 'block'} <ID> --by <ID>`;
  const { values, positionals } = args(argv, { by: { type: 'string', multiple: true } }, { min: 1, max: 1, usage });
  if (!values.by?.length) throw new UserError(`usage: ${usage}`);
  const target = positionals[0];
  const { added } = mutate(openOrg(), (s) => {
    requireItem(s, target);
    const events = [];
    for (const by of new Set(values.by)) {
      requireItem(s, by);
      const exists = s.links.some((l) => l.blocker === by && l.blocked === target);
      if (remove) {
        if (exists) events.push({ type: 'link.removed', blocker: by, blocked: target });
      } else if (!exists) {
        if (wouldCycleBlock(s, by, target)) throw new UserError(`${by} cannot block ${target}: that would create a blocking cycle`);
        events.push({ type: 'link.added', blocker: by, blocked: target });
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
    // The console opens the memo; a directory, app bundle or device is not a document.
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
      { type: 'item.added', id, kind: 'work', title, role: 'human', capability: null, parent: values.parent, priority, accept: [], budget: {},
        meta: Object.fromEntries(Object.entries(meta).filter(([, v]) => v != null)) },
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
  const { values, positionals } = args(argv, { note: { type: 'string' }, overrule: { type: 'boolean' } },
    { min: 2, usage: 'record answer <ID> yes|no|"<text>" [--note WHY] [--overrule]' });
  const [id, ...words] = positionals;
  const { answer: reply, rest } = parseReply(words.join(' '));
  if (!reply) throw new UserError('an answer is required: yes, no or a short text');
  const { actor } = writer();
  const note = [rest, values.note?.replace(/\s+/g, ' ').trim()].filter(Boolean).join('; ') || null;
  const { result } = mutate(openOrg(), (s) => {
    const item = requireItem(s, id);
    if (item.role !== 'human') throw new UserError(`${id} is not a question (only role=human items are answered)`);
    if (item.meta.category === 'priorities' && actor !== 'human') throw new UserError('priority questions wait for the operator');
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
    const events = [];
    if (item.closed) events.push({ type: 'item.reopened', id, note: 'reopened to overrule its answer' });
    events.push(
      { type: 'note.added', id, text: [`Answered ${reply}${values.overrule ? ` (overruling ${item.meta.answer})` : ''}`, note].filter(Boolean).join(': '), decision: true, kind: 'answer' },
      { type: 'item.updated', id, fields: { meta: { answer: reply, answered_by: actor, ...(values.overrule ? { overruled: true } : {}) } } },
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
  const { added } = mutate(openOrg(), (s) => {
    const parsed = parsePairs(pairs, 'record set');
    if (s.runs.has(id)) {
      const meta = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k.replace(/^meta\./, ''), v]));
      validateServes(s, meta.serves);
      return { add: [{ type: 'run.updated', id, meta }] };
    }
    const target = requireItem(s, id);
    if (target.meta.operator_reserved && Object.keys(parsed).some(key => ['role', 'meta.operator_reserved', 'meta.category', 'meta.release', 'meta.answer', 'meta.answered_by'].includes(key))) throw new UserError('release decision fields are immutable; use record answer as the operator');
    const fields = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith('budget.')) {
        checkBudget(key.slice(7), value);
        fields.budget = { ...fields.budget, [key.slice(7)]: value };
      } else if (key.startsWith('meta.')) {
        if (key === 'meta.serves') validateServes(s, value);
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
  out(describeEvent(added[0]) + '\n');
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
    if (values['if-current-run'] !== undefined) {
      const runId = values['if-current-run'];
      requireCurrentRun(s, id, runId);
      const run = s.runs.get(runId);
      if (run.abandoned || run.report?.outcome !== 'done') throw new UserError('conditional close requires a recorded done report');
      if (item.outcome && item.outcome.run !== runId) throw new UserError(`${id} outcome does not belong to ${runId}`);
      const blocked = s.links.some((l) => l.blocked === id && !releases(s, l.blocker, itemStatus(s, l.blocker)));
      if (openRuns(s, id).length || blocked || ['blocked', 'needs_human', 'dropped'].includes(itemStatus(s, id))) throw new UserError('conditional close needs supervisor judgment: work, blockers or outcome changed');
      // A done report may survive explicit reopening. Its ingestion revision
      // binds completion to the first subsequent closure, even for old receipts.
      // Read that history inside this transaction, alongside the current-run guard.
      if (!item.closed && events.some((e) => e.type === 'item.closed' && e.id === id && e.seq > run.report.seq)) {
        throw new UserError(`${id} was reopened after completion of ${runId}; conditional close needs supervisor judgment`);
      }
    }
    if (item.closed?.as === as) return { add: [], result: [] };
    return { add: [{ type: 'item.closed', id, as, note: values.note ?? null }], result: openRuns(s, id).map((r) => r.id) };
  });
  if (!added.length) {
    out(`${id} is already ${as}\n`);
    return 0;
  }
  out(`${id} closed as ${as}\n`);
  if (result.length) out(`note: ${result.join(', ')} still open; a report from it will still be recorded\n`);
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
    serves: { type: 'string' },
    'if-current-run': { type: 'string' },
    meta: { type: 'string', multiple: true },
  }, { min: 1, max: 1, usage: 'record start <ID> [--route R [--route-config FILE] | --harness H --model M --effort E] [options]' });
  const id = positionals[0];
  const meta = parsePairs(values.meta, '--meta');
  if (values.serves !== undefined) meta.serves = values.serves || null;
  if (values['route-config'] !== undefined && values.route === undefined) {
    throw new UserError('--route-config requires --route');
  }
  if (values.route !== undefined) {
    const copied = ['harness', 'model', 'effort'].filter((key) => values[key] !== undefined);
    if (copied.length > 0) throw new UserError(`--route cannot be combined with ${copied.map((key) => `--${key}`).join(', ')}`);
    let resolved;
    try {
      const loaded = loadDiscoveredRoutes({ cwd: process.cwd(), file: values['route-config'] });
      resolved = resolveRoute(loaded.config, { route: values.route });
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
  const ctx = openOrg();
  const { result } = mutate(ctx, (s) => {
    const item = requireItem(s, id);
    if (item.meta.operator_reserved && writer().actor !== 'human') throw new UserError('release questions are reserved for the operator');
    if (values['if-current-run'] !== undefined) {
      requireCurrentRun(s, id, values['if-current-run']);
      if (item.closed) throw new UserError(`${id} is closed; conditional start needs supervisor judgment`);
      if (item.outcome && item.outcome.run !== values['if-current-run']) throw new UserError(`${id} outcome does not belong to ${values['if-current-run']}`);
    }
    if (!Object.hasOwn(meta, 'serves')) {
      const inherited = itemServes(s, id);
      if (inherited != null) meta.serves = inherited;
    }
    validateServes(s, meta.serves);
    const runId = nextRunId(s);
    const runDir = path.join(ctx.dir, 'runs', runId);
    const events = [];
    if (item.closed) events.push({ type: 'item.reopened', id, note: `reopened by starting ${runId}` });
    events.push({
      type: 'run.started',
      id: runId,
      item: id,
      meta,
      workspace: path.resolve(values.workspace ?? process.cwd()),
      report_path: path.resolve(values.report ?? path.join(runDir, 'report.md')),
      brief_path: path.join(runDir, 'brief.md'),
    });
    return { add: events, result: { runId, reopened: Boolean(item.closed), parallel: openRuns(s, id).map((r) => r.id) } };
  });

  const after = openOrg();
  const run = after.state.runs.get(result.runId);
  const brief = renderBrief(after.state, run.id, view(after));
  writeFileAtomic(run.brief_path, brief);
  fs.mkdirSync(path.dirname(run.report_path), { recursive: true });

  const label = [meta.harness, meta.model, meta.effort].filter(Boolean).join(' · ');
  safeOut(`${run.id} started on ${id} "${truncate(after.state.items.get(id).title, 60)}"${label ? ` [${label}]` : ''}\n`);
  if (result.reopened) safeOut(`  (${id} was closed; reopened)\n`);
  safeOut(`  brief   ${run.brief_path}  (${brief.length} chars ≈ ${approxTokens(brief)} tokens)\n`);
  safeOut(`  report  ${run.report_path}\n`);
  safeOut(`  prompt  Read ${run.brief_path} and follow it.\n`);
  safeOut(meta.serves ? `  serves  ${meta.serves}\n` : '  alignment: Unaligned · no operator priority named (advisory)\n');
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

function ingestFile(ctx, file, runHint, currentRun) {
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
  const { result } = mutate(ctx, (s) => {
    const run = s.runs.get(runId);
    if (!run) throw new UserError(`unknown run ${runId}`);
    if (currentRun !== undefined) {
      if (currentRun !== runId) throw new UserError(`conditional ingest names ${currentRun}, but the report belongs to ${runId}`);
      requireCurrentRun(s, run.item, currentRun);
    }
    if (run.report) {
      if (run.report.sha256 === sha256) return { add: [], result: { already: true, runId } };
      throw new UserError(`${runId} already has a report (recorded ${run.report.at}); start a new run to report again`);
    }
    if (run.abandoned) {
      return { add: [], result: { skipped: true, runId, item: run.item } };
    }
    // Validate the complete proposal batch under the lock before writing its
    // immutable report copy or appending any of the report's events.
    for (const proposal of parsed.report.proposals) validateServes(s, proposal.extra?.serves);
    const stored = path.join('reports', `${runId}.md`);
    writeFileAtomic(path.join(ctx.dir, stored), text, 0o444);
    const report = { ...parsed.report, run: runId };
    const late = laterRuns(s, runId).some((r) => r.report);
    const events = [{ type: 'report.ingested', run: runId, item: run.item, file: stored, source: abs, sha256, late, report }];
    const categoryFlags = reportCategoryFlags(ctx.config, report);
    for (const flag of categoryFlags) events.push({ type: 'category.flagged', id: run.item, run: runId, ...flag });
    const taken = new Set();
    const created = [];
    for (const p of report.proposals) {
      const id = nextItemId(s, { kind: 'work', role: p.role }, taken);
      taken.add(id);
      events.push({
        type: 'item.added', id, kind: 'work', title: p.title, role: p.role ?? null, capability: p.capability ?? null,
        parent: run.item, accept: p.accept ?? [], why: p.why ?? null, from_run: runId, meta: p.extra ?? {},
      });
      const blocking = p.blocking ?? report.outcome === 'blocked';
      if (blocking) events.push({ type: 'link.added', blocker: id, blocked: run.item, from_run: runId });
      created.push({ id, title: p.title, role: p.role, blocking });
    }
    return {
      add: events,
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
    return true;
  }
  safeOut(`${res.runId} → ${res.outcome} on ${res.item}${res.late ? ' (late: a newer run already has a report)' : ''}: ${truncate(res.summary, 100)}\n`);
  for (const c of res.created) {
    safeOut(`  + ${c.id} "${truncate(c.title, 60)}"${c.role ? ` (${c.role})` : ''}${c.blocking ? ` blocks ${res.item}` : ''}\n`);
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

function ingest(argv) {
  const { values, positionals } = args(argv, { run: { type: 'string' }, 'if-current-run': { type: 'string' } }, { min: 1, max: 1, usage: 'record ingest <report.md> [--run R-n] [--if-current-run R-n]' });
  return printIngest(ingestFile(openOrg(), positionals[0], values.run, values['if-current-run'])) ? 0 : 1;
}

function sync(argv) {
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
    if (!printIngest(ingestFile(openOrg(), run.report_path, run.id))) failed++;
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
  const { positionals } = args(argv, {}, { min: 1, max: 1, usage: 'record brief <R-n>' });
  const ctx = openOrg();
  const run = ctx.state.runs.get(positionals[0]);
  if (!run) throw new UserError(`unknown run ${positionals[0]}`);
  if (!fs.existsSync(run.brief_path)) writeFileAtomic(run.brief_path, renderBrief(ctx.state, run.id, view(ctx)));
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
  const { values, positionals } = args(argv, { json: { type: 'boolean' } }, { min: 1, max: 1, usage: 'record show <ID> [--json]' });
  const ctx = openOrg();
  const id = positionals[0];
  if (ctx.state.items.has(id)) {
    out(values.json ? JSON.stringify(itemJson(ctx.state, id), null, 2) + '\n' : renderShowItem(ctx.state, id, view(ctx)));
  } else if (ctx.state.runs.has(id)) {
    out(values.json ? JSON.stringify(ctx.state.runs.get(id), null, 2) + '\n' : renderShowRun(ctx.state, id, view(ctx)));
  } else {
    throw new UserError(`unknown item or run ${id}`);
  }
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

function digest(argv) {
  const { values } = args(argv, { since: { type: 'string' }, after: { type: 'string' },
    limit: { type: 'string' }, width: { type: 'string' }, json: { type: 'boolean' } },
  { max: 0, usage: 'record digest [--since TIME | --after CURSOR] [--limit N] [--width N] [--json]' });
  if (values.since !== undefined && values.after !== undefined) throw new UserError('choose --since or --after, not both');
  const limit = values.limit === undefined ? 8 : Number(values.limit);
  const width = values.width === undefined ? 72 : Number(values.width);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new UserError('--limit expects a positive whole number');
  if (!Number.isSafeInteger(width) || width < 32 || width > 240) throw new UserError('--width expects a whole number from 32 to 240');
  const ctx = openOrg({ readOnly: true });
  const { journal, warnings } = readDigestJournal(ctx.dir);
  const doc = digestJson(ctx.state, ctx.events, journal, { orgDir: ctx.dir, now: ctx.now,
    since: values.after === undefined ? parseSince(values.since ?? '1d', ctx.now) : null,
    after: values.after, warnings: [...warnings, ...(ctx.tornTail ? ['Incomplete record tail ignored.'] : [])] });
  out(values.json ? JSON.stringify(doc, null, 2) + '\n' : renderDigest(doc, { limit, width }));
  return 0;
}

function recap(argv) {
  const { values } = args(argv, { json: { type: 'boolean' }, back: { type: 'string' } }, { max: 0, usage: 'record recap [--back N] [--json]' });
  const back = values.back == null ? 0 : Number(values.back);
  if (!Number.isInteger(back) || back < 0) throw new UserError('--back expects a whole number of blocks (0 is the latest)');
  const ctx = openOrg();
  const doc = blockJson(ctx.state, ctx.events, { orgDir: ctx.dir, now: ctx.now, back });
  out(values.json ? JSON.stringify(doc, null, 2) + '\n' : renderBlock(doc));
  return 0;
}

// The console is an isolated package with its own dependencies; the core only launches it.
function consoleApp(argv) {
  const { values } = args(argv, { project: { type: 'string' }, modern: { type: 'boolean' }, folder: { type: 'string' }, help: { type: 'boolean' } }, { max: 0, usage: 'record console [--project NAME] [--modern] [--folder PATH] [--help]' });
  const dir = path.resolve(process.env.HERDR_ORG_CONSOLE_DIR || path.join(path.dirname(BIN), '..', 'console'));
  if (!fs.existsSync(path.join(dir, 'node_modules', 'ink', 'package.json'))) {
    throw new UserError(`the console's dependencies are not installed; run: npm --prefix ${shq(dir)} ci`);
  }
  const r = spawnSync(process.execPath, [path.join(dir, 'app.mjs'), ...(values.project ? ['--project', values.project] : []), ...(values.modern ? ['--modern'] : []), ...(values.folder ? ['--folder', values.folder] : []), ...(values.help ? ['--help'] : [])], {
    stdio: 'inherit',
    env: { ...process.env, HERDR_ORG_BIN: BIN },
  });
  if (r.error) throw r.error;
  return r.status ?? 1;
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

function priorities(argv) {
  const [command, ...rest] = argv;
  if (command === 'propose') return ask([...rest, '--category=priorities', '--wait']);
  if (!command || command === '--json') {
    args(argv, { json: { type: 'boolean' } }, { max: 0, usage: 'record priorities [--json]' });
    const doc = prioritiesJson(openOrg().state);
    out(command === '--json' ? JSON.stringify(doc, null, 2) + '\n' : renderPriorities(doc));
    return 0;
  }
  if (!['add', 'rank'].includes(command)) throw new UserError('usage: record priorities [--json] | add TITLE --why TEXT | rank P-n --rank N --why TEXT [--expect REV] | propose QUESTION --parent ID --recommend yes --why TEXT');
  if (writer().actor !== 'human') throw new UserError('only the operator changes priorities; propose with record priorities propose QUESTION --parent ID --recommend yes --why TEXT');
  const { values, positionals } = args(rest, { why: { type: 'string' }, rank: { type: 'string' }, expect: { type: 'string' } },
    { min: 1, ...(command === 'rank' ? { max: 1 } : {}), usage: `record priorities ${command} ${command === 'rank' ? 'P-n --rank N' : 'TITLE'} --why TEXT [--expect REV]` });
  const why = values.why?.trim();
  if (!why) throw new UserError('--why is required to change priorities');
  const { result } = mutate(openOrg(), s => {
    if (values.expect !== undefined && String(s.priorityRevision) !== values.expect) throw new UserError('priorities changed since you opened the editor; refresh and review again');
    if (command === 'add') {
      const title = positionals.join(' ').trim();
      if (!title) throw new UserError('a priority title is required');
      const number = Math.max(0, ...[...s.priorities.keys()].map(id => Number(id.slice(2)))) + 1;
      const id = `P-${number}`;
      return { add: [{ type: 'priority.added', id, title, why }], result: id };
    }
    const id = positionals[0], rank = Number(values.rank);
    if (!s.priorities.has(id)) throw new UserError(`unknown priority ${id}`);
    if (!Number.isInteger(rank) || rank < 1 || rank > s.priorityOrder.length) throw new UserError(`--rank must be from 1 to ${s.priorityOrder.length}`);
    if (s.priorityOrder.indexOf(id) === rank - 1) return { add: [], result: `${id} already ranks ${rank}; nothing written` };
    const order = s.priorityOrder.filter(p => p !== id);
    order.splice(rank - 1, 0, id);
    return { add: [{ type: 'priorities.ranked', order, previous: s.priorityOrder, why }], result: `${id} ranks ${rank}` };
  });
  out(result + '\n');
  return 0;
}

const COMMANDS = {
  lesson, lessons,
  release: argv => releaseRecordCommand(argv, { openOrg, mutate, out }),
  releases: argv => releaseRecordCommand(['list', ...argv], { openOrg, mutate, out }),
  init, add, block, unblock: (argv) => block(argv, true), note, ask, answer, set, close, reopen,
  start, worker, check, ingest, sync, abandon, brief, status, snapshot, show, log, today, digest, recap, priorities, console: consoleApp, desks: desksCommand, routes: routesCommand, housekeeping: housekeepingCommand,
};

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) {
    out(USAGE);
    return 0;
  }
  if (!Object.hasOwn(COMMANDS, command)) throw new UserError(`unknown command "${command}" (see: record help)`);
  return COMMANDS[command](rest);
}

process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UserError || error instanceof FleetError || String(error.code).startsWith('ERR_PARSE_ARGS')) {
    err(`record: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
