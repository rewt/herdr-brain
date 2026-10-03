// A separate process keeps observing while the runner blocks in spawnSync.
// All Herdr operations here are read-only. Never restore focus: owned or
// correlated changes fail; unrelated operator/client activity re-baselines.
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HerdrClient } from '../lanes/board/herdr-client.mjs';
import { HarnessLimit, ProductBoundary } from './limits.mjs';
import { loadTimeout } from '../lib/deadline.mjs';

const FILE = fileURLToPath(import.meta.url);
// Herdr 0.8.2's EventHub retains at most 512 lifecycle events (all kinds).
// Seeing this many focus events exhausts the initial replay even if live
// operator navigation keeps the stream busy. No candidate work precedes ready.
const MAX_REPLAY_EVENTS = 512;
const STARTUP_TIMEOUT_MS = 60_000;
function readCalls(evidence) {
  const file = path.join(evidence, 'focus-calls.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
}
function targetsDestination(call, pane, workspace) {
  if (call.targets?.panes?.includes(pane) || call.targets?.workspaces?.includes(workspace)) return true;
  if (call.created?.panes?.includes(pane) || call.created?.workspaces?.includes(workspace)) return true;
  return [call.args, call.requested].some((argv) => {
    const args = argv.slice(0, argv.includes('--') ? argv.indexOf('--') : argv.length);
    if (['pane', 'agent'].includes(args[0]) && args[2] === pane) return true;
    if (workspace && args[0] === 'workspace' && args[2] === workspace) return true;
    return args.some((arg, index) =>
      (arg === '--pane' && args[index + 1] === pane) ||
      (workspace && arg === '--workspace' && args[index + 1] === workspace));
  });
}
export function assertFocus(summary, { evidence, error } = {}) {
  const attempts = evidence ? readCalls(evidence).filter((row) => row.type === 'forbidden-focus') : summary?.forbiddenAttempts ?? [];
  if (attempts.length) {
    const first = attempts[0];
    throw new ProductBoundary(`acceptance_product_boundary: forbidden focus attempt at ${first.at}: ${first.requested.join(' ')}; ${first.error}; ${attempts.length} attempt(s)`);
  }
  if (summary?.changes?.length) {
    const first = summary.changes[0];
    const calls = first.calls.length ? first.calls.map((call) =>
      `${call.args.join(' ')} (requested ${call.requested.join(' ')})`).join('; ')
      : `harness-owned destination (${first.workspaces?.join(', ') || first.panes.join(', ')})`;
    throw new Error(`operator focus changed from ${first.from ?? summary.baseline} to ${first.panes.join(', ') || '(none)'} at ${first.at}; ${first.phase?.key ?? 'setup'}; ${calls}`);
  }
  if (error) throw error;
  if (!summary?.baseline || summary.samples < 2 || summary.errors.length) {
    throw new HarnessLimit(`operator focus trace incomplete: ${summary?.errors?.join('; ') || 'missing baseline or samples'}`);
  }
  return `${summary.samples} samples plus pane_focused events over ${summary.elapsedMs}ms; zero harness focus changes; ${summary.externalChanges?.length ?? 0} external changes recorded and re-baselined; ${summary.baseline} -> ${summary.currentBaseline ?? summary.baseline}`;
}

export async function startFocusMonitor({ socketPath, evidence, ownership = path.join(path.dirname(evidence), 'ownership.json'), intervalMs = 200 }) {
  const child = fork(FILE, ['--monitor', JSON.stringify({ socketPath, evidence, ownership, intervalMs })], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '', exited = false;
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('exit', () => { exited = true; });
  const message = (kind) => new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer); child.off('message', receive); child.off('exit', ended); child.off('error', failed);
      if (error) reject(error); else resolve(value);
    };
    const receive = (value) => { if (value.kind === kind) finish(undefined, value.summary); };
    const ended = () => finish(new HarnessLimit(`focus monitor exited early: ${stderr}`));
    const failed = (error) => finish(new HarnessLimit(`focus monitor unavailable: ${error.message}`));
    const timer = setTimeout(() => { child.kill(); finish(new HarnessLimit(`focus monitor ${kind} timeout: ${stderr}`)); }, loadTimeout(kind === 'ready' ? STARTUP_TIMEOUT_MS + 10000 : 7000));
    child.on('message', receive); child.once('exit', ended); child.once('error', failed);
  });
  const ready = await message('ready');
  if (ready.errors.length) {
    child.kill(); child.disconnect();
    throw new HarnessLimit(`focus monitor startup: ${ready.errors.join('; ')}`);
  }
  let stopping;
  return { baseline: ready.baseline, stop() {
    if (stopping) return stopping;
    if (exited) return Promise.reject(new HarnessLimit(`focus monitor exited early: ${stderr}`));
    const finished = message('finished');
    child.send({ kind: 'stop' });
    stopping = finished.finally(() => { if (child.connected) child.disconnect(); });
    return stopping;
  } };
}

async function monitor({ socketPath, evidence, ownership, intervalMs }) {
  const client = new HerdrClient({ socketPath });
  const trace = path.join(evidence, 'focus-trace.jsonl');
  const summaryPath = path.join(evidence, 'focus-summary.json');
  const summary = { baseline: null, currentBaseline: null, samples: 0, events: 0, startupEvents: [], changes: [], externalChanges: [], errors: [], startedAt: Date.now() };
  let stopping = false, monitoring = false, timer, inFlight, lastEventAt = 0, observations = Promise.resolve();
  const ownedPanes = new Set(), ownedWorkspaces = new Set(), paneWorkspaces = new Map();
  const append = (row) => fs.appendFileSync(trace, JSON.stringify(row) + '\n');
  const context = (at) => {
    const phaseFile = path.join(evidence, 'focus-phase.json');
    const phase = fs.existsSync(phaseFile) ? JSON.parse(fs.readFileSync(phaseFile)) : { key: 'setup' };
    const rows = readCalls(evidence);
    const active = new Map(), completed = [];
    for (const row of rows) {
      if (row.type === 'start') active.set(row.id, row);
      else if (row.type === 'end') {
        const call = active.get(row.id);
        active.delete(row.id);
        if (call && at - row.at < 1000) completed.push({ ...call, created: row.created, completedAt: row.at });
      }
    }
    // Capture temporal overlap as diagnostics. Only a matching destination
    // establishes correlation, including one second after its call completes.
    return { phase, nearbyCalls: [...active.values(), ...completed.sort((a, b) => b.completedAt - a.completedAt)] };
  };
  const error = (value) => {
    summary.errors.push(value.message ?? String(value));
    append({ type: 'error', at: Date.now(), error: summary.errors.at(-1) });
  };
  const observe = (panes, type) => {
    // Capture receipts at arrival, then serialize resolution so transient
    // events cannot overtake each other while checking their workspace IDs.
    const at = Date.now(), row = { type, at, panes, ...context(at) };
    observations = observations.then(async () => {
      const retainOwnership = () => {
        for (const receipt of readCalls(evidence)) {
          for (const id of receipt.created?.panes ?? []) ownedPanes.add(id);
          for (const id of receipt.created?.workspaces ?? []) ownedWorkspaces.add(id);
        }
        if (!fs.existsSync(ownership)) return;
        const ledger = JSON.parse(fs.readFileSync(ownership));
        for (const id of ledger.panes ?? []) ownedPanes.add(id);
        for (const id of ledger.workspaces ?? []) ownedWorkspaces.add(id);
      };
      retainOwnership();
      row.calls = [];
      row.from = summary.currentBaseline;
      if (panes.length !== 1) throw new Error(`expected one focused pane, received ${JSON.stringify(panes)}`);
      if (panes[0] !== summary.currentBaseline) {
        let workspace = paneWorkspaces.get(panes[0]);
        if (!workspace && !ownedPanes.has(panes[0]) && !row.nearbyCalls.some((call) => targetsDestination(call, panes[0]))) {
          const result = await client.request('pane.get', { pane_id: panes[0] });
          workspace = result.pane?.workspace_id;
          if (!workspace) throw new Error(`focus destination workspace unavailable: ${panes[0]}`);
          paneWorkspaces.set(panes[0], workspace);
        }
        // Creation may emit focus before its result/ownership receipt arrives.
        // Resolve only those already-active creation calls before classifying
        // a new destination; uncertainty must not green a transient move.
        const creators = row.nearbyCalls.filter((call) => call.completedAt === undefined &&
          ['workspace', 'worktree'].includes(call.args[0]) && ['create', 'open'].includes(call.args[1]));
        const deadline = Date.now() + 3000;
        let receipts = readCalls(evidence);
        while (!ownedPanes.has(panes[0]) && !ownedWorkspaces.has(workspace) && creators.some((call) =>
          !receipts.some((receipt) => receipt.type === 'end' && receipt.id === call.id))) {
          if (Date.now() >= deadline) throw new Error('focus destination creation receipt unavailable');
          await new Promise((resolve) => setTimeout(resolve, 25));
          receipts = readCalls(evidence);
        }
        retainOwnership();
        const matching = row.nearbyCalls.map((call) => ({ ...call,
          created: receipts.find((receipt) => receipt.type === 'end' && receipt.id === call.id)?.created ?? call.created,
        })).filter((call) => targetsDestination(call, panes[0], workspace));
        row.calls = matching.some((call) => call.completedAt === undefined)
          ? matching.filter((call) => call.completedAt === undefined) : matching.slice(0, 1);
        row.workspaces = workspace ? [workspace] : [];
        row.owned = ownedPanes.has(panes[0]) || ownedWorkspaces.has(workspace);
        row.classification = row.owned || row.calls.length ? 'harness' : 'external';
        if (row.classification === 'harness') summary.changes.push(row);
        else {
          summary.externalChanges.push(row);
          summary.currentBaseline = panes[0];
          row.rebaseline = panes[0];
        }
      }
      append(row);
    }).catch(error);
    return observations;
  };
  const sample = async () => {
    try {
      // With no caller_pane_id, pane.current reads the UI's global focus.
      // Avoid collecting every background pane's metadata on every sample.
      const result = await client.request('pane.current', {});
      const pane = result.pane;
      if (!pane?.focused || typeof pane.pane_id !== 'string' || !pane.workspace_id) throw new Error('pane.current returned no focused pane identity');
      paneWorkspaces.set(pane.pane_id, pane.workspace_id);
      const panes = [pane.pane_id];
      if (!summary.baseline) {
        if (panes.length !== 1) throw new Error(`expected one focused operator pane, received ${JSON.stringify(panes)}`);
        summary.baseline = summary.currentBaseline = panes[0];
      }
      summary.samples++;
      await observe(panes, 'sample');
    } catch (value) { error(value); }
  };
  client.on('event', (event) => {
    // Protocol 20 uses pane.focused for the subscription filter, but
    // pane_focused for event envelopes. HerdrClient forwards them unchanged.
    if (event.event !== 'pane_focused') return;
    lastEventAt = Date.now();
    if (typeof event.data?.pane_id !== 'string') { error(new Error('malformed pane_focused event')); return; }
    if (!monitoring) {
      // Herdr 0.8.2 replays retained lifecycle events after the acknowledgement,
      // one per 100ms poll, without an event timestamp or public cursor. Keep
      // them as startup diagnostics before allowing any candidate work.
      const row = { type: 'subscription-startup', at: lastEventAt, event };
      summary.startupEvents.push(row); append(row);
      return;
    }
    summary.events++;
    if (event.data.workspace_id) paneWorkspaces.set(event.data.pane_id, event.data.workspace_id);
    void observe([event.data.pane_id], 'event');
  });
  client.on('connectionError', error);
  client.on('disconnected', () => { if (!stopping) error(new Error('focus event subscription disconnected')); });
  const finish = async () => {
    if (stopping) return;
    stopping = true; clearTimeout(timer);
    await inFlight; await sample(); await observations;
    client.close();
    summary.forbiddenAttempts = readCalls(evidence).filter((row) => row.type === 'forbidden-focus');
    summary.finishedAt = Date.now(); summary.elapsedMs = summary.finishedAt - summary.startedAt;
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
    process.send?.({ kind: 'finished', summary });
  };
  process.on('message', (value) => { if (value.kind === 'stop') void finish(); });
  process.on('disconnect', () => { clearTimeout(timer); client.close(); process.exit(); });
  try {
    const server = await client.ping();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('focus event subscription timeout')), 3000);
      client.once('ready', () => { clearTimeout(timeout); resolve(); });
      client.subscribe([{ type: 'pane.focused' }]);
    });
    // A quiet stream takes the short path. Continuous live activity cannot
    // extend replay beyond the retained-event bound. Verify the implementation
    // version before using that bound; the wire protocol exposes no cursor.
    const drainingAt = Date.now();
    const deadline = drainingAt + loadTimeout(STARTUP_TIMEOUT_MS);
    let drainReason = 'quiet';
    lastEventAt = Math.max(lastEventAt, drainingAt);
    while (Date.now() - lastEventAt < 400) {
      if (summary.startupEvents.length >= MAX_REPLAY_EVENTS) {
        if (server.version !== '0.8.2' || server.protocol !== 20) throw new Error(`focus replay bound unavailable for Herdr ${server.version} protocol ${server.protocol}`);
        drainReason = 'replay-bound';
        break;
      }
      if (Date.now() >= deadline) throw new Error('focus subscription startup replay deadline exceeded');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    summary.startupDrain = { reason: drainReason,
      maxReplayEvents: MAX_REPLAY_EVENTS, server, elapsedMs: Date.now() - drainingAt };
    await sample();
    monitoring = true;
    summary.monitoringStartedAt = Date.now();
    await sample();
  } catch (value) { error(value); }
  process.send?.({ kind: 'ready', summary });
  const tick = () => { inFlight = sample().finally(() => { if (!stopping) timer = setTimeout(tick, intervalMs); }); };
  timer = setTimeout(tick, intervalMs);
}

if (process.argv[1] === FILE && process.argv[2] === '--monitor') await monitor(JSON.parse(process.argv[3]));
