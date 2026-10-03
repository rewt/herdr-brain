import * as W from './workspace.mjs';
import { spawn } from 'node:child_process';
const ws = W.loadWorkspace(process.argv[2]);
const cwds = ['/Users/rewt/development/rewt/herdr-brain', '/Users/rewt/development/rewt/.worktrees/herdr-brain/lane-workspace',
  '/Users/rewt/development/bastian/bch-cloak', '/Users/rewt/development/rewt/coach', '/Users/rewt/development/bastian/apnt', '/Users/rewt/development/rewt'];
for (const cwd of cwds) {
  const p = W.resolveProject(ws, cwd);
  console.log(`\n${cwd}\n  ->`, p.project === null ? p : { name: p.name, joined: p.joined, record: p.record, worktrees: p.worktrees, temp: W.runTemp(ws, p, 'R-151', 60) });
}
const bch = W.resolveProject(ws, '/Users/rewt/development/bastian/bch-cloak');
console.log('\nbch-cloak effective guardrails:', JSON.stringify(W.effective(ws, bch, { lanes: { max_workers: 2 }, memory: { min_free_percent: 10 }, approvals: { reserved: ['prover'] } }), null, 1));
const live = [spawn('sleep', ['30']), spawn('sleep', ['30'])];
const dead = spawn('true'); await new Promise((r) => dead.on('exit', r));
console.log('\nleases (cap 2):');
console.log(' dead holder', W.lease(ws, 'workers', 2, { project: 'coach', run: 'R-1', pid: process.pid }).granted);
// simulate a crashed holder by rewriting its pid to the dead one
import fs from 'node:fs'; import path from 'node:path';
const f = path.join(ws.home, 'leases/workers/coach-R-1.json'); const l = JSON.parse(fs.readFileSync(f)); l.pid = dead.pid; fs.writeFileSync(f, JSON.stringify(l));
for (const [i, c] of live.entries()) console.log(` live holder ${i}`, JSON.stringify(W.lease(ws, 'workers', 2, { project: i ? 'bch-cloak' : 'herdr-brain', run: `R-${i}`, pid: c.pid })));
console.log(' third', JSON.stringify(W.lease(ws, 'workers', 2, { project: 'herdr-brain', run: 'R-9', pid: process.pid })));
live.forEach((c) => c.kill());
