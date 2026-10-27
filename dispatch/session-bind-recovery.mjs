// Explicit supervisor recovery of the original finished occupant. The ordinary
// dispatch writer, frozen journal, launch receipt and delivery window stay intact.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { findOrgDir, transact } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { gitProject } from '../lib/project.mjs';
import { readOwnedRun, requireController, assertOwner } from '../lib/run-owner-guard.mjs';
import { effectiveWorkerIdentity, sameReceipt, sharesWorker, validSessionBind } from '../lib/worker-identity.mjs';
import { protectRecordMutation } from '../lib/record-guard.mjs';
import { nativeSender } from '../messages/operator-inbox.mjs';
import { invokeHerdr } from '../supervisor/herdr-edge.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { lineDirectory } from '../line-service/cutoff.mjs';
import { nativeProcess } from './session-bind.mjs';
import { lockRequest } from './request-lock.mjs';

const source = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, args) => execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const plain = file => {
  if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== path.resolve(file)) throw Error('redirected session binding evidence');
  return fs.readFileSync(file);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const immutable = (file, bytes) => {
  const fd = fs.openSync(file, 'wx', 0o444);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const caller = n => ({ name: n.name, pane: n.pane_id, workspace: n.workspace_id,
  terminal: n.terminal_id, session: n.agent_session.value });
const sha = value => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value ?? '');
const proposalFields = ['type', 'run', 'dispatch', 'receipt', 'process', 'prompted_at', 'deadline', 'observed_at', 'session'];

export function recoverFinishedSessionBinding({ org, journal, role, id, decisionSeq, expectedHead,
  expectedSource, expectedSession, cwd = process.cwd(), env = process.env, call = invokeHerdr, readOwner }) {
  if (role !== 'supervisor' || !/^[-a-zA-Z0-9_]{1,80}$/.test(id ?? '') ||
      !Number.isSafeInteger(decisionSeq) || decisionSeq < 1 || !sha(expectedHead) || !sha(expectedSource) || !expectedSession?.trim())
    throw Error('finished session recovery needs supervisor mode, stable id, scoped decision, exact source/head and session');
  if (!env.HERDR_BRAIN_ROOT || fs.realpathSync(env.HERDR_BRAIN_ROOT) !== source)
    throw Error('finished session recovery needs the matching explicit development source');
  org = fs.realpathSync(org); journal = path.resolve(journal);
  if (path.dirname(journal) !== path.join(org, 'dispatch')) throw Error('foreign dispatch journal');
  const bytes = plain(journal), job = JSON.parse(bytes), b = job.sessionBinding;
  if (!/^R-\d+$/.test(job.run ?? '')) throw Error('original run id is unavailable');
  const project = gitProject(job.repo), repo = project.canonical;
  if (job.repo !== repo || job.common !== project.identity || job.org !== org ||
      fs.realpathSync(findOrgDir({ cwd: repo, env: { ...env, ORG_DIR: '' } }) ?? '') !== org)
    throw Error('original dispatch project/record differs');
  const binding = nativeSender(org, { cwd, env, call });
  if (binding.project.checkout !== repo || binding.project.identity !== project.identity)
    throw Error('finished session recovery requires the actual canonical native supervisor');
  const request = { id, decision_seq: decisionSeq, head: expectedHead, source: expectedSource,
    session: expectedSession, journal_sha256: hash(bytes) };
  const directory = path.join(org, 'evidence/session-bind', job.run);
  const held = lockRequest(journal); let release;
  try {
    release = acquireLock(path.join(project.identity, 'lane-promote.lock'));
    const result = transact(org, events => {
      const state = fold(events), run = state.runs.get(job.run), item = state.items.get(run?.item);
      if (!run || item?.id !== job.item || run.workspace !== job.workspace || run.abandoned ||
          item.runs.at(-1) !== run.id || item.role === 'human' ||
          ['hold', 'held', 'reserved', 'operator_reserved'].some(k => item.meta[k]))
        throw Error('original finished run is missing, superseded, reserved or held');
      const owned = readOwnedRun(org, run.id, events); requireController(owned);
      assertOwner(owned, job.ownership);
      const decision = events.find(e => e.seq === decisionSeq && e.type === 'note.added' && e.decision &&
        e.by === binding.native.name && [item.id, run.id].includes(e.id) &&
        [run.id, journal, id, expectedHead, expectedSource, expectedSession].every(v => e.text.includes(v)));
      if (!decision) throw Error('finished session recovery needs the actual supervisor scoped decision');
      const prior = state.sessionBindings.get(run.id) ?? [];
      if (prior.length) {
        const p = prior[0], r = p.recovery;
        if (prior.length !== 1 || effectiveWorkerIdentity(run, state).identity_conflict || !same(r?.request, request))
          throw Error('run already has a different or conflicting session bind; retain it');
        if (r.archive.file !== path.join(directory, 'manifest.json')) throw Error('original recovery archive changed');
        const manifest = JSON.parse(plain(r.archive.file));
        if (hash(plain(r.archive.file)) !== r.archive.sha256 || !same(manifest.request, request) ||
            manifest.files.some(f => path.dirname(f.archive) !== directory || hash(plain(f.archive)) !== f.sha256 ||
              ![journal, path.resolve(org, run.report?.file ?? 'reports')].includes(f.original) || hash(plain(f.original)) !== f.sha256))
          throw Error('original recovery archive changed');
        return { add: [] }; // Exact lost reply: no observation, prompt or second fact.
      }
      if (fs.existsSync(directory)) throw Error('original session recovery is UNKNOWN; retain its archive, no replacement');
      if (job.stage !== 'complete' || job.native_launch_attempted !== true || !['unbound', 'observing'].includes(b?.status) || /unknown/i.test(b.reason ?? '') ||
          !b.process || !same(b.process, job.launchProcess) || !b.receipt || b.receipt.agent_session_id ||
          !Number.isFinite(Date.parse(b.deadline)) || Date.now() <= Date.parse(b.deadline))
        throw Error('original launch/delivery continuity is unavailable, uncertain or not expired');
      const fact = { type: 'run.session_bound', run: run.id,
        dispatch: { journal, attempt: job.token, project: job.common, record: org },
        receipt: b.receipt, process: b.process, prompted_at: b.prompted_at, deadline: b.deadline,
        observed_at: b.prompted_at, session: expectedSession };
      if (!validSessionBind(run, fact, state) || (b.proposed && (b.proposed.type !== fact.type ||
          Object.keys(b.proposed).some(k => !proposalFields.includes(k)) || !validSessionBind(run, b.proposed, state) ||
          !sameReceipt(b.proposed.receipt, b.receipt) || !same(b.proposed.process, b.process) ||
          !same(b.proposed.dispatch, fact.dispatch) || b.proposed.prompted_at !== b.prompted_at ||
          b.proposed.deadline !== b.deadline || b.proposed.session !== expectedSession)))
        throw Error('original dispatch/launch receipt or saved proposal differs');
      if (!job.worker || job.worker.agentName !== b.receipt.agent || job.worker.pane !== b.receipt.pane ||
          job.worker.workspaceId !== b.receipt.worker_workspace || job.worker.terminalId !== b.receipt.terminal_id ||
          job.worker.cwd !== job.workspace || job.worker.agentSessionId && job.worker.agentSessionId !== expectedSession)
        throw Error('original dispatch/launch receipt or saved worker differs');
      if ([...state.runs.values()].some(other => other.started.seq > run.started.seq &&
          (other.workspace === run.workspace || sharesWorker(run, other, state) ||
           effectiveWorkerIdentity(other, state).agent_session_id === expectedSession)))
        throw Error('a newer run holds the original occupant/worktree');
      const fresh = nativeSender(org, { cwd, env, call });
      if (!same(caller(fresh.native), caller(binding.native))) throw Error('native supervisor changed');
      const guard = () => {
        for (const base of [repo, job.workspace]) for (const p of ['.lane/HOLD', '.lane/STOP', '.lane/supervisor/HOLD', '.lane/supervisor/STOP'])
          if (fs.existsSync(path.join(base, p))) throw Error('STOP/HOLD prevents finished session recovery');
        if (fs.existsSync(path.join(lineDirectory(org, project.identity), 'STOP'))) throw Error('STOP/HOLD prevents finished session recovery');
        const lane = gitProject(job.workspace);
        if (lane.checkout !== job.workspace || lane.identity !== project.identity || lane.canonical !== repo ||
            git(job.workspace, ['symbolic-ref', 'HEAD']) !== `refs/heads/lane/${job.lane}` ||
            git(job.workspace, ['rev-parse', 'HEAD']) !== expectedHead ||
            git(source, ['rev-parse', 'HEAD']) !== expectedSource ||
            [repo, job.workspace, source].some(p => git(p, ['status', '--porcelain=v1', '--untracked-files=all'])) ||
            hash(plain(journal)) !== request.journal_sha256) throw Error('committed source/head/clean journal CAS changed');
      };
      guard();
      const native = args => {
        const reply = JSON.parse(call('herdr', args));
        if (reply.error || !reply.result) throw Error('native original observation unavailable');
        return reply.result;
      };
      const observe = () => {
        const a = native(['agent', 'get', b.receipt.agent]).agent;
        if (!a || !['idle', 'done'].includes(a.agent_status) || a.name !== b.receipt.agent ||
            a.pane_id !== b.receipt.pane || a.workspace_id !== b.receipt.worker_workspace ||
            a.terminal_id !== b.receipt.terminal_id || a.agent_session?.value !== expectedSession ||
            fs.realpathSync(a.cwd) !== job.workspace ||
            (a.foreground_cwd && fs.realpathSync(a.foreground_cwd) !== job.workspace))
          throw Error('original native finished session/terminal/worktree differs or is UNKNOWN');
        const process = nativeProcess(a, native(['pane', 'process-info', '--pane', a.pane_id]).process_info, readOwner);
        if (!same(process, b.process)) throw Error('original native process changed');
        return { agent: a.name, pane: a.pane_id, terminal: a.terminal_id, session: expectedSession, process };
      };
      const observation = observe(); observe(); // One composite observation, checked across its process read.
      guard();
      const files = [{ original: journal, bytes }];
      if (run.report) {
        const file = path.resolve(org, run.report.file), report = plain(file);
        if (!file.startsWith(path.join(org, 'reports') + path.sep) || hash(report) !== run.report.sha256)
          throw Error('immutable original report changed');
        files.push({ original: file, bytes: report });
      }
      const parent = path.dirname(directory); fs.mkdirSync(parent, { recursive: true });
      if (fs.realpathSync(parent) !== parent) throw Error('redirected session recovery archive');
      fs.mkdirSync(directory);
      const archived = files.map((f, i) => {
        const archive = path.join(directory, `${i}.json`); immutable(archive, f.bytes);
        return { original: f.original, archive, sha256: hash(f.bytes) };
      });
      const manifest = Buffer.from(JSON.stringify({ request, files: archived, observation, supervisor: caller(fresh.native) }, null, 2) + '\n');
      const file = path.join(directory, 'manifest.json'); immutable(file, manifest);
      const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      guard();
      if (run.report && hash(plain(path.resolve(org, run.report.file))) !== run.report.sha256) throw Error('immutable original report changed');
      fact.observed_at = new Date().toISOString();
      fact.recovery = { kind: 'finished-original', request, supervisor: caller(fresh.native),
        generation: owned.owner_generation, report_seq: run.report?.seq ?? null, report_sha256: run.report?.sha256 ?? null,
        archive: { file, sha256: hash(manifest) } };
      return protectRecordMutation({ org, events, state, command: 'session-bind recover-finished', mutation: { add: [fact] } });
    }, { actor: binding.native.name, strictTail: true, lockOptions: { recover: false } });
    return { recorded: result.added.length > 0, run: job.run, session: expectedSession,
      archive: path.join(directory, 'manifest.json'), journal_unchanged: true };
  } finally { try { release?.(); } finally { held.release(); } }
}
