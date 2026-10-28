// Durable handoff at the existing report/closer boundary. No native effects.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fold } from './state.mjs';
import { readPlainFile } from './files.mjs';
import { gitProject } from './project.mjs';
import { loadDiscoveredRoutes } from '../lanes/routes.mjs';
import { roleIs } from './roles.mjs';
import { assertOwner, readOwnedRun, requireController } from './run-owner-guard.mjs';
import { correctionBrief } from './correction-brief.mjs';
import { declaredSourceRanges } from '../settle/review-range.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function currentAllocationOwner({ request, item, org, events, project, cwd }) {
  const job = request?.job, journal = request?.journal;
  if (!job?.run) return null;
  const run = assertOwner(readOwnedRun(org, job.run, events), job.ownership);
  requireController(run, 'brain');
  const record = fs.realpathSync(org);
  if (run.report || run.abandoned || item.runs.at(-1) !== run.id || run.item !== item.id || job.item !== item.id ||
      job.common !== project.identity || job.org !== record || job.workspace !== cwd || run.workspace !== cwd ||
      path.dirname(journal ?? '') !== path.join(record, 'dispatch') ||
      run.meta.dispatch_journal !== journal || run.meta.dispatch_attempt !== job.token ||
      run.meta.dispatch_project !== project.identity || run.meta.dispatch_record !== record ||
      run.meta.lane !== job.lane || run.meta.route !== job.route ||
      Object.entries(job.declared ?? {}).some(([key, value]) => (run.meta[key] ?? null) !== value))
    throw Error('current correction request/run/claim does not own the saved allocation');
  return run.id;
}

export function preserveReportContext(entry, events) {
  const run = fold(events).runs.get(entry.run);
  if (!run?.report?.seq && !run?.abandoned?.seq) throw Error('direct close requires an ingested report or authorized abandonment');
  const report = path.resolve(entry.org, run.report?.file ?? `runs/${run.id}/report.md`);
  const bytes = fs.existsSync(report) ? readPlainFile(report) : null;
  if (bytes && /^[a-f0-9]{64}$/.test(run.report?.sha256 ?? '') && sha(bytes) !== run.report?.sha256)
    throw Error('author report changed before preservation; keep');
  let dispatch;
  if (run.meta?.dispatch_journal && fs.existsSync(run.meta.dispatch_journal))
    dispatch = JSON.parse(readPlainFile(run.meta.dispatch_journal));
  const base = dispatch?.base ?? git(entry.project, ['merge-base', 'HEAD', entry.head]);
  const gate = path.join(entry.cwd, '.lane/gate.json');
  const document = { schema: 'report-closeout-context/v1', run: run.id, item: run.item,
    report, report_sha256: run.report?.sha256, author: run.report ?? run.abandoned, report_text: bytes?.toString('utf8') ?? null,
    ask: run.brief_path, ask_text: run.brief_path && fs.existsSync(run.brief_path) ? readPlainFile(run.brief_path).toString('utf8') : null,
    base, head: entry.head, branch: entry.branch, diff: git(entry.project, ['diff', '--no-ext-diff', '--no-textconv', base, entry.head]),
    check: fs.existsSync(gate) ? JSON.parse(readPlainFile(gate)) : { executed: false, outcome: 'unrun' },
    proof_locations: run.report?.artifacts ?? [], native: { ...run.meta }, source: entry.source };
  const content = JSON.stringify(document, null, 2) + '\n', hash = sha(content);
  const directory = path.join(entry.common, 'retirement/report-evidence');
  fs.mkdirSync(directory, { recursive: true });
  if (fs.realpathSync(directory) !== directory) throw Error('report evidence directory redirected; keep');
  const packet = path.join(directory, `${run.id}-${hash}.json`);
  let fd;
  try { fd = fs.openSync(packet, 'wx', 0o600); fs.writeFileSync(fd, content); fs.fsyncSync(fd); }
  catch (error) { if (error.code !== 'EEXIST' || sha(readPlainFile(packet)) !== hash) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  const dir = fs.openSync(directory, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  return { packet, sha256: hash, base, head: entry.head, branch: entry.branch, report };
}

// The exact kept ref is preferred over main. A dirty registered folder is an
// explicit handback, never silently bypassed by a new branch.
function reportEvidence(run, events) {
  if (!run) return { run };
  const witness = events.findLast(e => e.type === 'closeout.effect' && e.run === run?.id && e.outcome?.action === 'report-evidence')?.outcome;
  if (!witness) return { run };
  const bytes = readPlainFile(witness.packet);
  if (sha(bytes) !== witness.sha256) throw Error('saved author evidence changed');
  return { run, witness, saved: JSON.parse(bytes) };
}

export function correctionSource({ item, state, events, repo, org, request }) {
  const formal = Boolean(item.meta?.review_fix_of);
  // A queued review stays on its immutable captured head; it is never a fix continuation.
  if (!formal && roleIs(item, 'REV') && item.meta?.review_source_item) return null;
  const review = formal ? state.items.get(item.parent) : null;
  const target = review?.meta.review_target;
  if (formal && (!target || review.meta.review_source_run !== item.meta.review_source_run)) throw Error('correction immutable review source is missing');
  const author = state.runs.get(formal ? item.meta.review_source_run : item.runs.filter(id => id !== request?.job?.run).at(-1));
  if (!formal && (!author?.report || author.report.outcome === 'done')) return null;
  const { witness, saved } = reportEvidence(author, events);
  const prior = formal ? item.runs.filter(id => id !== request?.job?.run).map(id => state.runs.get(id))
    .filter(run => run?.report).map(run => reportEvidence(run, events)) : [];
  // A second fixer must retain the first fix's unlanded commits, while the
  // original reports/review tuple below remain the immutable review context.
  const source = prior.at(-1) ?? { run: author, saved };
  const branch = source.saved?.branch ?? (source.run?.meta.lane ? `lane/${source.run.meta.lane}` : null);
  const project = gitProject(repo);
  const { layers } = loadDiscoveredRoutes({ cwd: project.canonical, canonical: project.canonical });
  // The routes projection omits lifecycle keys for unbound projects; use the
  // validated owning policy layers, as the lane CLI does for CONFIG.main.
  const main = Object.assign({}, ...layers.map(layer => layer.config)).main ?? 'main';
  // Resolve the owning project's actual integration ref on every invocation,
  // including the existing launch-time source/CAS recheck. A linked caller's
  // HEAD and a previously supplied main SHA are not fallback authority.
  const integration = git(project.canonical, ['rev-parse', '--verify', `refs/heads/${main}^{commit}`]);
  let head;
  if (branch) head = git(project.canonical, ['for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`]) || undefined;
  if (head) {
    const trees = git(repo, ['worktree', 'list', '--porcelain']).split('\n\n');
    const tree = trees.find(t => t.split('\n').includes(`branch refs/heads/${branch}`));
    const cwd = tree?.split('\n').find(l => l.startsWith('worktree '))?.slice(9);
    if (cwd && git(cwd, ['status', '--porcelain'])) throw Error(`unsaved author work kept at ${cwd}; owner must preserve or commit it before a fresh fix`);
    const active = cwd ? [...state.runs.values()].filter(r => r.workspace === cwd && !r.report && !r.abandoned) : [];
    const current = active.some(r => r.id === request?.job?.run) ? currentAllocationOwner({ request, item, org, events, project, cwd }) : null;
    if (active.some(r => r.id !== current)) throw Error('active run owns the saved author allocation');
    const ancestry = (() => { try { git(project.canonical, ['merge-base', '--is-ancestor', head, integration]); return true; } catch (e) { if (e.status === 1) return false; throw e; } })();
    if (ancestry) head = null;
  }
  const findings = events.filter(e => e.type === 'review.finding-linked' && e.correction_item === item.id);
  const reviewRun = state.runs.get(findings[0]?.review_run ?? review?.runs.findLast(id => state.runs.get(id)?.report));
  const landed = events.filter(e => e.type === 'change.landed' && e.run === author?.id);
  const ranges = declaredSourceRanges(author?.report?.artifacts ?? []);
  const recorded = landed.length ? { base: landed[0].base, head: landed.at(-1).head }
    : ranges.length === 1 ? ranges[0] : null;
  return { base: head ?? integration, ...(head ? { ref: `refs/heads/${branch}`, head } : {}),
    brief: correctionBrief({ item, author, saved, witness, target: target ?? (saved ? null : recorded), findings, reviewRun, prior, org, repo }) };
}
