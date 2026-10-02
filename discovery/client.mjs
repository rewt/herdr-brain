#!/usr/bin/env node
// A request to the session-scoped parent, not an arbitrary command executor.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requestTimeout } from './deadlines.mjs';
const [op, ...words] = process.argv.slice(2);
try {
  if (!op || ['--help', '-h', 'help'].includes(op)) {
    console.log('monitor <context|start TASK|resume ITEM|commit SUBJECT|check|promote|rebase|continue|abort|apply-routes|finish>');
    console.log('continue: stage the files you resolved through the bounded Git adapter and continue your paused rebase. No direct git add is required.');
    console.log('finish: ingest the exact run report; done requires successful promotion. A second different report is refused by record.');
    process.exit(0);
  }
  const root = process.env.MONITOR_REQUEST_DIR;
  if (!root) throw new Error('enter through the installed Monitor adapter first');
  const id = randomUUID();
  const request = path.join(root, `${id}.request.json`), reply = path.join(root, `${id}.reply.json`);
  fs.writeFileSync(`${request}.tmp`, JSON.stringify({ op, ...(words.length ? { text: words.join(' ') } : {}) }), { mode: 0o600 });
  fs.renameSync(`${request}.tmp`, request);
  const deadline = Date.now() + requestTimeout(op);
  while (!fs.existsSync(reply)) {
    if (Date.now() >= deadline) throw new Error('session adapter timed out; inspect before retrying a mutation');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const response = JSON.parse(fs.readFileSync(reply, 'utf8'));
  fs.rmSync(request); fs.rmSync(reply);
  if (response.error) throw new Error(response.error);
  console.log(typeof response.result === 'string' ? response.result : JSON.stringify(response.result, null, 2));
} catch (e) { console.error(`monitor: ${e.message}`); process.exitCode = 1; }
