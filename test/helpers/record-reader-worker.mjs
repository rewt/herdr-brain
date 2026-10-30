// Isolated measurement process; no native service, watcher or live mutation.
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadRecord, loadRecordReader } from '../../lib/store.mjs';

const [mode, dir, idsJSON, role = 'leaf', verify = 'false'] = process.argv.slice(2);
const ids = JSON.parse(idsJSON), children = [], messages = [];
let held;
process.on('disconnect', () => { for (const child of children) child.disconnect(); process.exit(0); });
if (role === 'parent') {
  for (let i = 0; i < 2; i++) {
    const child = fork(new URL(import.meta.url), [mode, dir, idsJSON, 'leaf', verify], { execArgv: ['--expose-gc'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.stderr.on('data', bytes => process.stderr.write(bytes));
    child.on('message', message => { messages.push(message); publish(); });
    child.on('exit', code => { if (code) { process.stderr.write(`reader child exited ${code}\n`); process.exit(1); } });
    children.push(child);
  }
  process.send({ kind: 'pids', pids: [process.pid, ...children.map(c => c.pid)] });
}
function fingerprint(state) {
  const hash = createHash('sha256');
  for (const name of ['items', 'runs', 'lessons', 'candidates', 'workerReceipts', 'sessionBindings', 'obligations']) {
    hash.update(name);
    for (const entry of state[name]) hash.update(JSON.stringify(entry));
  }
  for (const name of ['links', 'categoryFlags', 'lastAt']) hash.update(JSON.stringify(state[name]));
  return hash.digest('hex');
}
function historyFingerprint(events) {
  const hash = createHash('sha256');
  for (const event of events) hash.update(JSON.stringify(event) + '\n');
  return hash.digest('hex');
}
const readMs = [], start = performance.now();
for (let i = 0; i < (verify === 'true' ? 1 : 3); i++) {
  held?.close?.(); held = null; global.gc();
  const before = performance.now();
  held = mode === 'compact' ? loadRecordReader(dir) : loadRecord(dir);
  const facts = ids.map(id => held.state.items.get(id) ?? held.state.runs.get(id));
  readMs.push(performance.now() - before);
  // Deliberately keep the selected current work, as consumers do.
  held.selected = facts;
}
const summary = {
  kind: 'reader', role, pid: process.pid, mode, read_ms: readMs,
  facts: createHash('sha256').update(JSON.stringify(held.selected)).digest('hex'),
  ...(verify === 'true' ? { all_facts: fingerprint(held.state), events: historyFingerprint(mode === 'compact' ? held.events() : held.events) } : {}),
  count: held.state.eventCount, items: held.state.items.size, runs: held.state.runs.size,
  elapsed_ms: performance.now() - start,
};
global.gc();
summary.idle_rss_bytes = process.memoryUsage().rss;
summary.high_water_rss_bytes = process.resourceUsage().maxRSS * 1024;
function publish() {
  if (role === 'parent' && messages.length === 2) process.send({ kind: 'group', readers: [summary, ...messages] });
}
if (role === 'leaf') process.send(summary); else publish();

