// A separate process keeps observing while the runner blocks in spawnSync.
// All Herdr operations here are read-only. Never restore focus: a transient
// change is a failure even when another client subsequently restores it.
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HerdrClient } from '../lanes/board/herdr-client.mjs';
import { HarnessLimit, ProductBoundary } from './limits.mjs';

const FILE = fileURLToPath(import.meta.url);
function readCalls(evidence) {
  const file = path.join(evidence, 'focus-calls.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
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
      : 'outside a recorded harness call (external client or plugin hook)';
    throw new Error(`operator focus changed from ${summary.baseline} to ${first.panes.join(', ') || '(none)'} at ${first.at}; ${first.phase?.key ?? 'setup'}; ${calls}`);
  }
  if (error) throw error;
  if (!summary?.baseline || summary.samples < 2 || summary.errors.length) {
    throw new HarnessLimit(`operator focus trace incomplete: ${summary?.errors?.join('; ') || 'missing baseline or samples'}`);
  }
  return `${summary.samples} samples plus pane.focused events over ${summary.elapsedMs}ms; ${summary.baseline} unchanged; zero focus changes`;
}

export async function startFocusMonitor({ socketPath, evidence, intervalMs = 200 }) {
  const child = fork(FILE, ['--monitor', JSON.stringify({ socketPath, evidence, intervalMs })], {
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
    const timer = setTimeout(() => { child.kill(); finish(new HarnessLimit(`focus monitor ${kind} timeout: ${stderr}`)); }, 7000);
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

async function monitor({ socketPath, evidence, intervalMs }) {
  const client = new HerdrClient({ socketPath });
  const trace = path.join(evidence, 'focus-trace.jsonl');
  const summaryPath = path.join(evidence, 'focus-summary.json');
  const summary = { baseline: null, samples: 0, events: 0, changes: [], errors: [], startedAt: Date.now() };
  let stopping = false, timer, inFlight;
  const append = (row) => fs.appendFileSync(trace, JSON.stringify(row) + '\n');
  const context = () => {
    const phaseFile = path.join(evidence, 'focus-phase.json');
    const phase = fs.existsSync(phaseFile) ? JSON.parse(fs.readFileSync(phaseFile)) : { key: 'setup' };
    const rows = readCalls(evidence);
    const active = new Map(); let completed;
    for (const row of rows) {
      if (row.type === 'start') active.set(row.id, row);
      else if (row.type === 'end') {
        const call = active.get(row.id);
        active.delete(row.id);
        if (call && (!completed || row.at >= completed.completedAt)) completed = { ...call, completedAt: row.at };
      }
    }
    // A focus event may arrive just after the completion receipt. Keep that
    // call as a correlation, without claiming causality for outside clients.
    return { phase, calls: active.size ? [...active.values()] : completed && Date.now() - completed.completedAt < 1000 ? [completed] : [] };
  };
  const error = (value) => {
    summary.errors.push(value.message ?? String(value));
    append({ type: 'error', at: Date.now(), error: summary.errors.at(-1) });
  };
  const observe = (panes, type) => {
    const row = { type, at: Date.now(), panes, ...context() };
    if (summary.baseline && (panes.length !== 1 || panes[0] !== summary.baseline)) {
      summary.changes.push(row);
    }
    append(row);
  };
  const sample = async () => {
    try {
      const result = await client.request('pane.list');
      if (!Array.isArray(result.panes)) throw new Error('pane.list returned no panes');
      const panes = result.panes.filter((pane) => pane.focused).map((pane) => pane.pane_id);
      if (!summary.baseline) {
        if (panes.length !== 1) throw new Error(`expected one focused operator pane, received ${JSON.stringify(panes)}`);
        summary.baseline = panes[0];
      }
      summary.samples++;
      observe(panes, 'sample');
    } catch (value) { error(value); }
  };
  client.on('event', (event) => {
    if (event.event !== 'pane.focused') return;
    summary.events++;
    if (typeof event.data?.pane_id !== 'string') { error(new Error('malformed pane.focused event')); return; }
    observe([event.data.pane_id], 'event');
  });
  client.on('connectionError', error);
  client.on('disconnected', () => { if (!stopping) error(new Error('focus event subscription disconnected')); });
  const finish = async () => {
    if (stopping) return;
    stopping = true; clearTimeout(timer);
    await inFlight; await sample();
    client.close();
    summary.forbiddenAttempts = readCalls(evidence).filter((row) => row.type === 'forbidden-focus');
    summary.finishedAt = Date.now(); summary.elapsedMs = summary.finishedAt - summary.startedAt;
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
    process.send?.({ kind: 'finished', summary });
  };
  process.on('message', (value) => { if (value.kind === 'stop') void finish(); });
  process.on('disconnect', () => { clearTimeout(timer); client.close(); process.exit(); });
  try {
    await sample();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('focus event subscription timeout')), 3000);
      client.once('ready', () => { clearTimeout(timeout); resolve(); });
      client.subscribe([{ type: 'pane.focused' }]);
    });
    await sample();
  } catch (value) { error(value); }
  process.send?.({ kind: 'ready', summary });
  const tick = () => { inFlight = sample().finally(() => { if (!stopping) timer = setTimeout(tick, intervalMs); }); };
  timer = setTimeout(tick, intervalMs);
}

if (process.argv[1] === FILE && process.argv[2] === '--monitor') await monitor(JSON.parse(process.argv[3]));
