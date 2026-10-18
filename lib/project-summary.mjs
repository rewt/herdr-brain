// Owner-published, display-only projection. No grants, endpoints or event writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { gitProject } from './project.mjs';
import { findOrgDir, loadEvents, now as clock, UserError } from './store.mjs';
import { fold, statusMap } from './state.mjs';
import { dayBounds } from './today.mjs';
import { sanitizeTerminal } from './sanitize.mjs';
import { renderProjectSummary, renderPublishedSummaryStatus } from './render.mjs';
import { createRetirement, readRetirementWorktrees } from './retire-runtime.mjs';
import { retirementStatus, RETIREMENT_CLASSES } from './retire-status.mjs';
import { queueJobs } from '../promote/promote.mjs';
import { brainPhase } from '../board/brain.mjs';
import { readConfig as housekeepingConfig } from '../housekeeping/config.mjs';

export const SUMMARY_SCHEMA = 'project-summary/v1';
export const SUMMARY_MAX_AGE_SECONDS = 300;
const hash = value => createHash('sha256').update(value).digest('hex');
const projectId = project => hash(project.identity);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const itemId = value => typeof value === 'string' && /^[A-Z][A-Z0-9]*-\d+$/.test(value) ? value : null;
const runId = value => typeof value === 'string' && /^R-\d+$/.test(value) ? value : null;
const releaseId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const STATUSES = ['open', 'ready', 'active', 'blocked', 'needs_human', 'done', 'dropped', 'unknown'];
const UNRESOLVED = ['ACTIVE', 'WAITING', 'IDLE-NONTERMINAL', 'UNKNOWN'];
const EXCEPTIONS = ['record-tail-incomplete', 'decision-summary-missing', 'lanes-unavailable', 'lanes-unknown',
  'retirement-held', 'unresolved-age-unknown', 'unresolved-owner-unknown', 'current-release-unavailable',
  'release-pin-unavailable', 'release-status-unavailable', 'promotion-queue-unavailable', 'worktrees-unavailable'];

// Only editorial titles/plain summaries enter this function, never note bodies,
// answers, report bodies, warnings, prompts, argv or file contents. Redaction is
// additional protection for accidental paths/credentials in those allowed fields.
function line(value) {
  if (typeof value !== 'string') return null;
  const text = sanitizeTerminal(value).replace(/\s+/g, ' ').trim();
  if (/-----BEGIN|\b(?:password|passwd|secret|token|api[_ -]?key|credential|authorization)\s*[:=]|\b(?:sk-|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_-]{8,}/i.test(text)) return '[redacted]';
  return text.replace(/(?:https?:\/\/|file:\/\/|(?:^|(?<=[\s("'`=:]))(?:[A-Za-z]:[\\/]|~?\/|\.\.?\/))[^\s<>"'`]+/g, '[path]').slice(0, 160) || null;
}

// ENG-386 integration seam: replace this reader with the owning project's pin
// helper when it lands. Until then current has release.sh status semantics:
// the installed unpinned current link, never a candidate or a guessed Git tag.
export function readProjectReleaseIds(_project, { env = process.env } = {}) {
  const home = path.resolve(env.HERDR_MONITOR_HOME ?? path.join(os.homedir(), '.local/share/herdr-monitor'));
  let current = null;
  try {
    const target = path.resolve(home, fs.readlinkSync(path.join(home, 'current')));
    if (path.dirname(target) === path.join(home, 'releases')) current = releaseId(path.basename(target));
  } catch (error) { if (error.code !== 'ENOENT') return { current, pinned: null, unavailable: true }; }
  return { current, pinned: null };
}

export function projectSummary({ project, state, lanes, jobs = [], releases = {}, now,
  exceptions = [], staleAfterSeconds = SUMMARY_MAX_AGE_SECONDS }) {
  const generatedAt = iso(now);
  if (!generatedAt) throw Error('summary requires a valid observation time');
  if (!Number.isSafeInteger(staleAfterSeconds) || staleAfterSeconds < 1) throw Error('invalid summary maximum age');
  const named = new Set(exceptions.filter(name => EXCEPTIONS.includes(name))), { start, end, date } = dayBounds(new Date(generatedAt));
  const today = at => iso(at) && Date.parse(at) >= start.getTime() && Date.parse(at) < end.getTime();
  const statuses = statusMap(state), counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const status of statuses.values()) counts[STATUSES.includes(status) ? status : 'unknown']++;
  const decisions = [];
  for (const target of [...state.items.values(), ...state.runs.values()]) {
    for (const note of target.notes) {
      if (!note.decision || note.kind === 'answer' || !today(note.at)) continue;
      if (!note.summary) named.add('decision-summary-missing');
      decisions.push({ id: itemId(target.id) ?? runId(target.id), at: iso(note.at),
        summary: line(note.summary) ?? 'Decision recorded; plain summary unavailable.' });
    }
    if (target.role === 'human' && target.meta.answer != null && target.closed && today(target.closed.at))
      decisions.push({ id: itemId(target.id), at: iso(target.closed.at), summary: line(target.title) ?? 'Question answered.' });
  }
  const landings = jobs.filter(j => j.outcome === 'promoted' && today(j.integrated_at ?? j.finished)).map(j => {
    const run = state.runs.get(j.run), item = state.items.get(run?.item);
    return { item: itemId(item?.id), run: runId(run?.id), at: iso(j.integrated_at ?? j.finished),
      summary: line(run?.report?.headline) ?? line(item?.title) ?? 'Integrated work; plain summary unavailable.' };
  });
  const order = (a, b) => b.at.localeCompare(a.at) || JSON.stringify(a).localeCompare(JSON.stringify(b));
  landings.sort(order); decisions.sort(order);
  const laneCounts = Object.fromEntries(RETIREMENT_CLASSES.map(c => [c, count(lanes?.counts?.[c])]));
  if (!lanes) named.add('lanes-unavailable');
  if (laneCounts.UNKNOWN) named.add('lanes-unknown');
  if (lanes?.held) named.add('retirement-held');
  const oldest = (lanes?.rows ?? []).filter(r => r.type !== 'pane' && UNRESOLVED.includes(r.class)).map(row => {
    const job = jobs.find(j => j.id === row.id);
    const runs = String(row.run ?? '').split(', ').map(runId).filter(Boolean);
    if (!runs.length && runId(job?.run)) runs.push(job.run);
    const items = String(row.item ?? '').split(', ').map(itemId).filter(Boolean);
    const starts = runs.map(id => iso(state.runs.get(id)?.started.at)).filter(Boolean);
    const since = starts.sort()[0] ?? iso(job?.queued) ?? null;
    const owner = line(row.nextActor) ?? (row.class === 'WAITING' ? line(row.nextAction) : null) ?? line(row.agent) ??
      (row.type === 'promotion' ? line(state.runs.get(job?.run)?.meta.agent) : null);
    if (!since) named.add('unresolved-age-unknown');
    if (!owner) named.add('unresolved-owner-unknown');
    return { type: ['tab', 'worktree', 'promotion', 'diagnostic'].includes(row.type) ? row.type : 'diagnostic',
      class: row.class, runs, items, owner, since,
      age_seconds: since ? Math.max(0, Math.floor((Date.parse(generatedAt) - Date.parse(since)) / 1000)) : null };
  }).sort((a, b) => (b.age_seconds ?? -1) - (a.age_seconds ?? -1) || JSON.stringify(a).localeCompare(JSON.stringify(b))).slice(0, 10);
  const current = releaseId(releases.current), pinned = releaseId(releases.pinned);
  if (!current) named.add('current-release-unavailable');
  if (!pinned) named.add('release-pin-unavailable');
  if (releases.unavailable) named.add('release-status-unavailable');
  // This literal object is the publication allowlist. Never spread source data.
  return { schema: SUMMARY_SCHEMA, project: { id: projectId(project), name: line(path.basename(project.canonical)) },
    generated_at: generatedAt, stale_after_seconds: staleAfterSeconds,
    status: { counts }, today: { date, start: start.toISOString(), end: end.toISOString(), landings, decisions },
    lanes: { counts: laneCounts, oldest_unresolved: oldest }, releases: { current, pinned },
    exceptions: [...named].sort().map(name => ({ name })) };
}

export function collectProjectSummary({ cwd = process.cwd(), org, snapshot, command, main, herdr = 'herdr',
  now = clock().toISOString(), env = process.env } = {}) {
  const project = gitProject(cwd);
  if (project.checkout !== project.canonical) throw Error('publish summaries from the canonical project checkout');
  org = org ?? findOrgDir({ cwd, env });
  if (!org) throw Error('no record discovered');
  org = fs.realpathSync(org);
  let loaded = snapshot ? { events: snapshot.events, tornTail: false } : loadEvents(org);
  const exceptions = [];
  let jobs = [];
  try {
    const queue = JSON.parse(fs.readFileSync(path.join(project.identity, 'promote/queue.json'), 'utf8'));
    if (queue.identity !== project.identity) throw Error('foreign promotion queue');
    jobs = queueJobs(queue).filter(j => typeof j.org === 'string' && path.resolve(j.org) === org);
  } catch (error) { if (error.code !== 'ENOENT') exceptions.push('promotion-queue-unavailable'); }
  env = { ...env, GIT_OPTIONAL_LOCKS: '0', ORG_DIR: org };
  if (!snapshot) {
    const retirement = createRetirement({ cwd, org, herdr, command, main, env });
    main = retirement.main;
    try { snapshot = retirement.observe(); loaded = { events: snapshot.events, tornTail: false }; }
    catch {
      exceptions.push('lanes-unavailable');
      snapshot = { common: project.identity, errors: ['observation unavailable'], retirementHold: retirement.hold() };
    }
  }
  const state = fold(loaded.events);
  if (loaded.tornTail) exceptions.push('record-tail-incomplete');
  let worktrees = [];
  try { worktrees = readRetirementWorktrees(project.identity, { main, command, env }); }
  catch { exceptions.push('worktrees-unavailable'); }
  const promotions = jobs.map(j => ({ id: j.id, item: state.runs.get(j.run)?.item, phase: brainPhase({ job: j, result: j.result ?? (j.outcome ? j : null) }),
    where: {}, project: '', status: { text: '' } }));
  const lanes = retirementStatus(snapshot, { generatedAt: now, worktrees, promotions });
  const config = housekeepingConfig(path.join(project.canonical, '.housekeeping.json'));
  return { org, doc: projectSummary({ project, state, lanes, jobs, now, exceptions,
    releases: readProjectReleaseIds(project, { env }), staleAfterSeconds: Math.max(SUMMARY_MAX_AGE_SECONDS, Math.ceil(config.tick_seconds * 3)) }) };
}

// Both paths switch as one generation, via one same-directory symlink rename.
// The public directory is owned exclusively by this publisher. Retain the prior
// generation for readers; remove only our two generated files from older ones.
export function writeProjectSummary(org, doc) {
  org = fs.realpathSync(org);
  const lock = path.join(org, '.summary-publish.lock');
  fs.mkdirSync(lock);
  const publicPath = path.join(org, 'published'), generations = path.join(org, '.published-summaries');
  const temporary = path.join(org, `.published-${randomUUID()}`);
  try {
    let previous;
    try {
      if (!fs.lstatSync(publicPath).isSymbolicLink()) throw Error('published must be the summary generation link');
      previous = fs.readlinkSync(publicPath);
      if (!/^\.published-summaries\/[a-f0-9]{64}$/.test(previous)) throw Error('unrecognised summary generation');
      const owner = JSON.parse(fs.readFileSync(path.join(publicPath, 'summary.json'), 'utf8'));
      if (owner.project?.id !== doc.project.id) throw Error('record summary belongs to a different canonical project');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.mkdirSync(generations, { recursive: true });
    if (fs.lstatSync(generations).isSymbolicLink()) throw Error('summary generations must be a local directory');
    const json = JSON.stringify(doc, null, 2) + '\n', markdown = renderProjectSummary(doc), name = hash(json + markdown);
    const generation = path.join(generations, name);
    let created = false;
    try {
      fs.mkdirSync(generation);
      created = true;
      fs.writeFileSync(path.join(generation, 'summary.json'), json, { flag: 'wx' });
      fs.writeFileSync(path.join(generation, 'summary.md'), markdown, { flag: 'wx' });
    } catch (error) {
      if (created) {
        for (const file of ['summary.json', 'summary.md']) fs.rmSync(path.join(generation, file), { force: true });
        fs.rmdirSync(generation);
        throw error;
      }
      if (error.code !== 'EEXIST' || !fs.lstatSync(generation).isDirectory() || fs.readFileSync(path.join(generation, 'summary.json'), 'utf8') !== json ||
          fs.readFileSync(path.join(generation, 'summary.md'), 'utf8') !== markdown) throw error;
    }
    const target = `.published-summaries/${name}`;
    fs.symlinkSync(target, temporary);
    fs.renameSync(temporary, publicPath);
    for (const old of fs.readdirSync(generations).filter(n => /^[a-f0-9]{64}$/.test(n) && n !== name && `.published-summaries/${n}` !== previous)) {
      const directory = path.join(generations, old);
      if (!fs.lstatSync(directory).isDirectory()) continue;
      try {
        for (const file of ['summary.json', 'summary.md']) fs.rmSync(path.join(directory, file), { force: true });
        fs.rmdirSync(directory);
      } catch { /* Preserve anything not generated here; publication has succeeded. */ }
    }
    return doc;
  } finally {
    fs.rmSync(temporary, { force: true });
    fs.rmdirSync(lock);
  }
}

export function publishProjectSummary(options) {
  const { org, doc } = collectProjectSummary(options);
  return writeProjectSummary(org, doc);
}

// Read only the published projection, never its sources. Missing/invalid files
// retain an unknown age; mtime is never substituted for observation time.
export function publishedSummaryStatus(org, { now = clock().toISOString(), project } = {}) {
  const result = { status: 'missing', generated_at: null, age_seconds: null, stale_after_seconds: null };
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(org, 'published/summary.json'), 'utf8'));
    if (doc.schema !== SUMMARY_SCHEMA || !iso(doc.generated_at) || !Number.isSafeInteger(doc.stale_after_seconds) || doc.stale_after_seconds < 1 ||
        (project && doc.project?.id !== projectId(project)))
      return { ...result, status: 'invalid' };
    const age = (Date.parse(now) - Date.parse(doc.generated_at)) / 1000;
    if (!Number.isFinite(age) || age < 0) return { ...result, status: 'invalid' };
    return { status: age > doc.stale_after_seconds ? 'stale' : 'fresh', generated_at: iso(doc.generated_at),
      age_seconds: Math.floor(age), stale_after_seconds: doc.stale_after_seconds };
  } catch (error) { return { ...result, status: error.code === 'ENOENT' ? 'missing' : 'invalid' }; }
}

export async function summaryCommand(argv) {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      json: { type: 'boolean' }, herdr: { type: 'string' },
    } });
    if (positionals.length > 1 || (positionals.length && positionals[0] !== 'publish') || (values.herdr && !positionals.length))
      throw Error('usage: record summary [--json] | publish [--json] [--herdr COMMAND]');
    const org = findOrgDir();
    if (!org) throw Error('no record discovered');
    if (positionals.length) {
      const doc = publishProjectSummary({ org, herdr: values.herdr });
      process.stdout.write(values.json ? JSON.stringify(doc, null, 2) + '\n' : renderProjectSummary(doc));
    } else {
      const status = publishedSummaryStatus(org);
      process.stdout.write(values.json ? JSON.stringify(status, null, 2) + '\n' : renderPublishedSummaryStatus(status));
    }
    return 0;
  } catch (error) { throw new UserError(error.message); }
}
