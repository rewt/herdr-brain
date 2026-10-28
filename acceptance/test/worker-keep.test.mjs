import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertWorkerKept } from '../run.mjs';

test('cwd retention requires the exact lane and a live owned worker process', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-keep-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const job = { run: 'R-1', lane: 'case', pane: 'own:p1', info: { workspace: root, meta: { worker_workspace: 'own' } } };
  const reason = /^process cwd reference \d+$/;
  const kept = { action: 'keep', cwd: root, branch: 'lane/case', why: 'process cwd reference 42' };
  const pane = { pane_id: 'own:p1', workspace_id: 'own', foreground_cwd: root };
  const processes = { shell_pid: 42, foreground_processes: [{ pid: 43 }] };
  const lane = () => JSON.stringify(kept);
  const h = (group, verb) => verb === 'get' ? { pane } : { process_info: processes };
  assertWorkerKept(job, { lane, reason, h });
  processes.shell_pid = 41;
  assert.throws(() => assertWorkerKept(job, { lane, reason, h }), /does not belong/);
  processes.shell_pid = 42; pane.workspace_id = 'foreign';
  assert.throws(() => assertWorkerKept(job, { lane, reason, h }));
  pane.workspace_id = 'own'; kept.branch = 'lane/foreign';
  assert.throws(() => assertWorkerKept(job, { lane, reason, h }), /expected worker KEEP/);
  kept.branch = 'lane/case'; kept.cwd = path.dirname(root);
  assert.throws(() => assertWorkerKept(job, { lane, reason, h }), /expected worker KEEP/);
});
