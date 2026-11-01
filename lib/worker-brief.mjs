// New line assignments use existing run metadata; saved launches stay untouched.
// This is a brief contract, not failure-count automation or route selection policy.
import fs from 'node:fs';
import path from 'node:path';
import { roleIs } from './roles.mjs';
import { sanitizeTerminal } from './sanitize.mjs';
import {resolveLaunchRoute} from '../lanes/routes.mjs';
import {readProjectPolicy} from './config-policy.mjs';
import {gitProject} from './project.mjs';
import {uncertainOutcomeDoctrine} from './uncertain-outcome.mjs';
import {isDispatchPrompt} from './dispatch-template.mjs';

const text = value => typeof value === 'string' && Boolean(value.trim());
const absolute = value => text(value) && path.isAbsolute(value);
const failure = missing => Object.assign(Error(`Worker brief missing required fields: ${missing.join(', ')}; no worker spawned`), { code: 'WORKER_BRIEF_REQUIRED' });

export function projectExceptionAddress(repo, config, route, env = process.env) {
  const explicit = env.MONITOR_SUPERVISOR_AGENT?.trim();
  if (explicit) return { to: explicit, source: 'parent MONITOR_SUPERVISOR_AGENT' };
  const setting = resolveLaunchRoute(config, {route}).env.filter(pair => pair.startsWith('MONITOR_SUPERVISOR_AGENT=')).at(-1);
  const configured = setting?.slice('MONITOR_SUPERVISOR_AGENT='.length).trim();
  if (configured) return { to: configured, source: 'effective launch MONITOR_SUPERVISOR_AGENT' };
  try {
    const policy = readProjectPolicy(repo, 'promote', env, {canonical:gitProject(repo).canonical});
    if (policy.config.to) return {to:policy.config.to.trim(),source:'project promote.to',file:policy.file};
    return {to:null,source:'unknown',reason:'No project-specific exception address is configured.'};
  } catch(error) { return {to:null,source:'unknown',reason:error.message}; }
}

export function validateWorkerBrief(contract, { execution = false } = {}) {
  const missing = [];
  if (contract?.version !== 1) missing.push('version');
  for (const key of ['item', 'role', 'purpose', 'outcome', 'scope', 'unchanged', 'evidence', 'ledger', 'lane', 'route', 'harness', 'review_route', 'reply_to'])
    if (!text(contract?.[key])) missing.push(key);
  for (const key of ['project', 'org', 'ask']) if (!absolute(contract?.[key])) missing.push(key);
  if (!text(contract?.exception?.to)) missing.push('PROJECT SUPERVISOR address (configure owning project promote.to or launch MONITOR_SUPERVISOR_AGENT)');
  if (!text(contract?.exception?.source)) missing.push('exception address source');
  if (!['worker', 'reviewer', 'decision'].includes(contract?.guidance?.role) || !text(contract?.guidance?.text)) missing.push('selected role guidance');
  if (execution && !absolute(contract?.workspace)) missing.push('workspace');
  if (missing.length) throw failure(missing);
  return contract;
}

export function createWorkerBrief({ item, ask, askText, extra = '', project, org, lane, route, harness, reviewRoute, exception }) {
  const role = roleIs(item, 'DEC') ? 'decision' : roleIs(item, 'REV') ? 'reviewer' : 'worker';
  const contract = {
    version: 1, item: item.id, role: item.role,
    purpose: item.meta?.purpose ?? item.created?.why ?? item.title,
    outcome: item.meta?.outcome ?? (item.accept?.length ? isDispatchPrompt(item.accept[0]) ? 'See Dispatch prompt: Measure and How we will know it works.' : item.accept.join('\n') : item.title),
    scope: item.meta?.scope ?? (text(askText) ? `Named change: ${item.title}. Full scope: ${ask}${extra ? `; --extra: ${extra}` : ''}` : ''),
    unchanged: item.meta?.unchanged ?? 'Outside the named scope; native, reserved, ownership and STOP/HOLD boundaries remain in force.',
    evidence: item.meta?.evidence ?? (role === 'reviewer' ? 'Captured diff and inherited producer evidence only; zero reviewer suites.' : `One changed-focused check selected from ${ask}${extra ? ' and explicit --extra scope' : ''}; no selection means unrun, never PASS.`),
    ledger: `Use ${item.id} fields/notes and the report for premise, failed fix attempt, check and result. A failed reframe reshapes the item instead of extending the old trajectory.`,
    project, org, ask, lane, route, harness, review_route: reviewRoute,
    reply_to: 'record', exception,
    guidance: { role, text: item.meta?.uncertain_outcome ? 'Inspect only the captured subject and recorded producer statuses. Return an ordinary done report with the premise, confidence, falsifying observation and concrete next step. Zero suites, source edits, lifecycle, native or outward effects. This report grants no authority to clear a refusal. '+uncertainOutcomeDoctrine : fs.readFileSync(new URL(`../supervisor/roles/${role}.md`, import.meta.url), 'utf8').trim() },
  };
  return validateWorkerBrief(contract);
}

export function runWorkerBrief(run) {
  const raw = run.meta?.worker_brief;
  if (raw === undefined) return null;
  let contract;
  try { contract = JSON.parse(raw); } catch { throw failure(['worker_brief JSON']); }
  validateWorkerBrief(contract, { execution: true });
  const missing = [];
  for (const [key, actual] of Object.entries({ item: run.item, workspace: run.workspace, lane: run.meta.lane, route: run.meta.route, harness: run.meta.harness }))
    if (contract[key] !== actual) missing.push(`${key} differs from recorded execution`);
  if (missing.length) throw failure(missing);
  return contract;
}

export function renderWorkerBrief(contract) {
  validateWorkerBrief(contract, { execution: true });
  return sanitizeTerminal([
    '## Role guidance', contract.guidance.text, '',
    '## Execution contract',
    ...['purpose', 'outcome', 'scope', 'unchanged', 'evidence', 'ledger'].map(key => `${key[0].toUpperCase()}${key.slice(1)}: ${contract[key]}`),
    `Execution: item ${contract.item}; role ${contract.role}; project ${contract.project}; record ${contract.org}; lane ${contract.lane}; workspace ${contract.workspace}.`,
    `Routing: assigned ${contract.route} (${contract.harness}); review ${contract.review_route}; replies ${contract.reply_to}; PROJECT SUPERVISOR ${contract.exception.to} (${contract.exception.source}).`,
    'Worker identity is bound after native launch; labels and estimates grant no authority.',
  ].join('\n'));
}

// Older installed record renderers cannot render worker_brief metadata. Adapt
// only their wholly absent section; partial/changed contracts still refuse.
// The durable run and saved request, not renderer version or a pin, bind it.
export function compatibleLineBrief({ job, run, brief }) {
  const contract = runWorkerBrief(run);
  if (!contract || JSON.stringify(contract) !== JSON.stringify(job.workerBrief)) throw failure(['saved/recorded contract differs']);
  if (!/^## (?:Role guidance|Execution contract)\s*$/m.test(brief)) {
    const heading = `# Brief: run ${run.id} on ${run.item}\n`;
    if (!brief.startsWith(heading) || brief.split('## Work item\n').length !== 2) throw failure(['recognized record brief']);
    brief = brief.replace('## Work item\n', `${renderWorkerBrief(contract)}\n\n## Work item\n`);
  }
  validateLineExecution({ job, run, brief });
  return brief;
}

// The exact generated brief is delivered inline, so its role page is loaded once
// in worker context. Do not ask the worker to read the same brief again.
export function validateLineExecution({ job, run, brief }) {
  const contract = runWorkerBrief(run);
  if (!contract || JSON.stringify(contract) !== JSON.stringify(job.workerBrief)) throw failure(['saved/recorded contract differs']);
  const section = renderWorkerBrief(contract);
  if (brief.split(section).length !== 2) throw failure(['generated execution contract/role guidance']);
  for (const [key, actual] of Object.entries({ project: job.repo, org: job.org, ask: job.brief, lane: job.lane, workspace: job.workspace, route: job.route, harness: job.declared.harness }))
    if (contract[key] !== actual) throw failure([`actual launch ${key} binding`]);
  return contract;
}

export function lineWorkerPrompt({ job, run, brief, producer = '', node, laneCLI }) {
  const contract = validateLineExecution({ job, run, brief });
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const exceptionCommand = `SUPERVISOR_INPUT_WAIT_SECONDS=0 ${[
    node, path.resolve(path.dirname(laneCLI), '../supervisor/prompt-supervisor.mjs'), contract.exception.to,
    `[worker-exception] run=${run.id} item=${run.item} worker=${job.worker.agentName} EXPLANATION; evidence=PATH; held-action=ACTION`,
    '--org', contract.org, '--run', run.id, '--id', `${run.id}:exception:STABLE_ID`, '--project-supervisor',
  ].map(quote).join(' ')}`;
  const waitCommand = [node, path.resolve(path.dirname(laneCLI), '../dispatch/worker-session.mjs'),
    '--run', run.id, '--journal', run.meta.dispatch_journal, '--org', contract.org].map(quote).join(' ');
  return [
    [1, 2].includes(job.workerSessionWaitProtocol) ? `Before reading the ask, running ownership preflight, editing or checking source, or writing a report, run this foreground read-only binding wait as your first tool action: ${waitCommand}\nContinue task work only on exit 0 with status ready, which proves the original worker session is committed.${job.workerSessionWaitProtocol === 2 ? ' Readiness requires its explicit run.session_bound event, including when the launch receipt already contains a session ID.' : ''} Exit 3 means pending: repeat this same read-only command and keep the run/report open while the original dispatcher or line settles its saved binding. A saved proposal or journal status alone is not readiness. On any other exit, preserve the refusal and route one exception through the PROJECT SUPERVISOR command below; do not substitute identity, resend the prompt or replay the launch. This wait grants no mutation authority; fresh native/claim/source/STOP/HOLD checks still apply.` : '',
    `You are run ${run.id} on org item ${run.item}. Read ${contract.ask} (the ask). The generated record brief follows, also saved at ${run.brief_path}; use this included copy once. Do not reload the brief or role page.`,
    brief.trimEnd(),
    `Your recorded worker agent is ${job.worker.agentName}; the existing report watcher targets ${job.to}. Retain that watcher. Routine completion, status and landing go only in the report/record; do not send an operator message for them. Send an operator message only when the brief explicitly asks for an operator-facing message. Use --to ${job.worker.agentName} for ordinary settle/queued-promotion notices and existing prompt delivery for review completion. Exceptions go to your PROJECT SUPERVISOR at ${JSON.stringify(contract.exception.to)}. A native refusal stops that effect; preserve it and continue independent work. Never borrow supervisor identity or invoke its cycle mutations.`,
    `Before native input, store each exception through the existing durable supervisor inbox with this source command (fill in the explanation, evidence, held action and one stable ID): ${exceptionCommand}\nDo not use a direct herdr agent prompt for exceptions. A missing supervisor binding stays pending for the existing inbox owner to re-resolve; exit 3 with queued=true is retained, not delivered. Keep the receipt and original ID; do not replace or replay refused/uncertain attempts. Record the exception on the owning item/run too. This mode grants no native identity or authority and changes no saved watcher or callback.`,
    contract.guidance.role !== 'worker' ? '' : `Land with ${JSON.stringify(node)} ${JSON.stringify(laneCLI)} promote ${contract.lane} --expected-head-from-worktree. Rebase moved main in your lane, record the resulting committed candidate head, and verify the command's captured head matches it. This form applies the native worker/run/claim ownership guard across the fast-forward. Capture the selected check on the clean committed candidate with the same lane CLI: check --cmd 'COMMAND', using the existing project runner/file groups/limits. It records command, status, TAP totals and Node version; do not repeat a check to obtain a receipt. A formal correction's explicit final-head authorization in its fix context permits its selected unrun control after a required rebase. Hand landed base/head/evidence through the report to the single record queue-review path; never start parallel settle/lane review or replace existing/UNKNOWN attempts. The final-release obligation remains with its release coordinator.`,
    producer,
    job.reviewQueueBrief ?? '', job.extra ?? '',
  ].filter(Boolean).join('\n\n') + '\n';
}
