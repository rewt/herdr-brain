// Foreground session recovery only. No model, scheduler, promotion or settlement.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownerAlive } from '../lib/process-owner.mjs';
import { lookupProcess } from '../lib/processes.mjs';
import { gitProject } from '../lib/project.mjs';
import { sanitizeTerminal } from '../lib/sanitize.mjs';
import { coldStart, receiptDirectory } from './context.mjs';
import { housekeepingSnapshot } from '../housekeeping/command.mjs';

const local = name => fileURLToPath(new URL(name, import.meta.url));
const hash = identity => createHash('sha256').update(identity).digest('hex').slice(0, 20);
function dead(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('owner PID is missing or invalid; inspect');
  try { process.kill(pid, 0); return false; }
  catch (e) { if (e.code === 'ESRCH') return true; throw e; }
}

// Read only known lock locations bound to this Git common-directory identity.
export function inspectEntryLocks(project, report) {
  const inspect = (file, readPid) => {
    try { if (dead(readPid())) report(`Stale lock (owner gone; retained): ${file}\n`); }
    catch (e) { report(`Lock inspection: ${file}: ${e.message}\n`); }
  };
  const owner = directory => {
    if (fs.existsSync(directory)) inspect(directory, () => JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8')).pid);
  };
  owner(path.join(project.identity, 'lane-promote.lock')); // Both promotion and release.
  for (const name of ['queue.lock', 'worker.lock']) owner(path.join(project.identity, 'promote', name));
  const directory = receiptDirectory(project.org, project.identity);
  if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) if (/^(R-\d+|cursor)\.lock$/.test(name)) owner(path.join(directory, name));
  const settle = path.join(project.org, 'settle');
  if (fs.existsSync(settle)) for (const name of fs.readdirSync(settle)) {
    if (!name.startsWith(`${hash(project.identity)}-`) || !name.endsWith('.locks')) continue;
    const dir = path.join(settle, name);
    for (const entry of fs.readdirSync(dir)) inspect(path.join(dir, entry), () => Number(entry.split('-')[0]));
  }
}

export function enterSupervisor({ cwd = process.cwd(), org, role, to = process.env.MONITOR_SUPERVISOR_AGENT || 'supervisor-herdr',
  command = spawnSync, readProcess, output = text => process.stdout.write(text) } = {}) {
  const report = text => output(sanitizeTerminal(text));
  const attempt = (name, task) => { try { return task(); } catch (e) { report(`Supervisor entry ${name}: ${e.message}; session may continue.\n`); } };
  // All failures are diagnostics, including discovery; entry must never veto a session.
  return attempt('recovery', () => {
    if (role !== 'supervisor') return;
    const project = gitProject(cwd);
    if (project.checkout !== project.canonical) { report('Supervisor entry skipped: a lane checkout is never a project supervisor.\n'); return; }
    report(`Read the supervisor protocol: ${local('./PROTOCOL.md')}\n`);
    const deadline = Date.now() + 20000;
    const readOwner = readProcess ?? (pid => lookupProcess(pid, { identityOnly: true,
      allowance: ms => Math.min(ms, 2000), pause: () => {},
      execute: (file, args, options) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { error: new Error('entry time limit reached') };
        return spawnSync(file, args, { ...options, timeout: Math.min(remaining, options.timeout) });
      },
    }));
    const call = (file, args) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('entry time limit reached; inspect or repeat entry');
      const r = command(process.execPath, [file, ...args], { cwd: project.canonical, encoding: 'utf8',
        env: { ...process.env, ORG_DIR: org }, timeout: Math.min(remaining, 11000), killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
      if (r.error || r.status !== 0) throw new Error((r.stderr || r.error?.message || `exit ${r.status}`).trim());
      return r.stdout;
    };
    attempt('brief', () => report(call(local('./supervisor.mjs'), ['brief', '--repo', project.canonical, ...(org ? ['--org', org] : [])])));
    const doc = attempt('record', () => coldStart({ cwd: project.canonical, org, readProcess: readOwner }));
    if (!doc) return;
    project.org = doc.project.org;
    org = project.org;
    attempt('locks', () => inspectEntryLocks(project, report));
    // STOP/torn record permits the cold start and lock inspection, never recovery mutations.
    if (doc.project.stopped || doc.project.torn_tail) { report('Supervisor entry recovery paused: STOP or incomplete record event; inspect.\n'); return; }
    attempt('housekeeping', () => {
      const snapshot = housekeepingSnapshot({ cwd: project.canonical, org, readProcess: readOwner });
      if (snapshot.configError) throw new Error(snapshot.configError);
      if (!snapshot.config.enabled || !snapshot.config.resume) { report('Supervisor entry housekeeping: disabled or resume=false.\n'); return; }
      if (snapshot.process === 'running') return;
      if (!['stopped', 'stale lock'].includes(snapshot.process)) throw new Error(snapshot.warnings.join('; ') || snapshot.process);
      report(call(local('../housekeeping/housekeeping.mjs'), ['--start', '--resume', '--cwd', project.canonical, '--org', org]));
    });
    for (const run of doc.running) attempt(`watch ${run.run}`, () => {
      // Unknown/deleted/legacy repository binding cannot authorize a new watcher.
      if (run.repository_binding !== project.identity || run.checkout_missing || !run.agent) return;
      if (run.watcher_pid !== null && ownerAlive({ pid: Number(run.watcher_pid), identity: run.watcher_identity }, readOwner)) return;
      // The fold can change while the brief is printed or housekeeping starts.
      const current = JSON.parse(call(local('../bin/org.mjs'), ['show', run.run, '--json']));
      if (current.report || current.abandoned || current.workspace !== run.workspace || current.meta.agent !== run.agent) return;
      if (gitProject(current.workspace).identity !== project.identity) throw new Error('run repository binding changed');
      if (current.meta.watcher_pid != null && ownerAlive({ pid: Number(current.meta.watcher_pid), identity: current.meta.watcher_identity }, readOwner)) return;
      let recipient = to;
      if (current.meta.dispatch_journal) {
        let receipt;
        try { receipt = JSON.parse(fs.readFileSync(current.meta.dispatch_journal, 'utf8')); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (receipt) {
          if (receipt.run !== run.run || (receipt.to != null && (typeof receipt.to !== 'string' || !receipt.to.trim()))) throw new Error('dispatch recipient receipt is invalid; inspect');
          recipient = receipt.to ?? recipient;
        }
      }
      recipient = (typeof recipient === 'string' && recipient.trim()) || 'supervisor-herdr';
      const watched = JSON.parse(call(local('../watch/watch.mjs'), [run.run, '--org', org, '--to', recipient,
        '--cwd', project.canonical, '--detach', '--log', path.join(org, 'dispatch', `${run.run}.watch.log`)]));
      if (watched.run !== run.run || typeof watched.log !== 'string' || !ownerAlive(watched, readOwner)) throw new Error('watcher startup receipt is invalid or owner died; inspect before retry');
      call(local('../bin/org.mjs'), ['set', run.run, `watcher_pid=${watched.pid}`, `watcher_identity=${watched.identity}`, `watcher_log=${watched.log}`]);
      report(`Supervisor entry watch: re-armed ${run.run} (pid ${watched.pid}).\n`);
    });
  });
}
