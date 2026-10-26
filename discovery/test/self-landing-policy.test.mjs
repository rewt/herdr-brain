import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryPolicy } from '../policy.mjs';
import { fixture } from '../../dispatch/test/dispatch-fixture.mjs';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

test('entry policies keep ordinary landing with workers and supervisor authority at exceptions', t => {
  const f = fixture(t), priorFleet = process.env.HERDR_MONITOR_FLEET;
  process.env.HERDR_MONITOR_FLEET = f.env.HERDR_MONITOR_FLEET;
  t.after(() => {
    if (priorFleet === undefined) delete process.env.HERDR_MONITOR_FLEET;
    else process.env.HERDR_MONITOR_FLEET = priorFleet;
  });
  const context = { canonical: f.repo, org: f.org };
  const worker = entryPolicy({ ...context, role: 'worker' }, root);
  assert.ok(worker.includes(`${root}/lanes/lane.mjs`));
  assert.match(worker, /promote TOPIC --expected-head FULL_COMMIT/);
  assert.match(worker, /--parallel-review --run RUN --captured-head FULL_COMMIT --captured-base BASE_COMMIT --round 1 --timeout 0/);
  assert.match(worker, /zero reviewer suites/);
  assert.match(worker, /native identity\/claim.*source\/CAS\/fast-forward, STOP, HOLD and archives/);
  assert.match(worker, /Workers never run the release gate or start housekeeping/);
  assert.doesNotMatch(worker, /--role supervisor|supervisor\/supervisor.mjs|--start/);
  const chat = entryPolicy({ ...context, role: 'chat' }, root);
  assert.match(chat, /follow-up belongs to the recorded owning worker/);
  assert.doesNotMatch(chat, /Route routine notices to.*supervisor/);
  const supervisor = entryPolicy({ ...context, role: 'supervisor' }, root);
  assert.match(supervisor, /reserve supervisor mutations for actual exceptions\/recovery/);
  assert.match(supervisor, /Workers never borrow this role/);
  assert.match(supervisor, /bootstrap watcher already targeting the supervisor stays intact/);
  assert.match(supervisor, /do not invoke a second settle\/review/);
  assert.match(supervisor, /signed source-ready-to-land\/report-to-land gaps/);
  assert.match(supervisor, /direct source invocation does not update installed current/);
  const dispatch = fs.readFileSync(path.join(root, 'dispatch/README.md'), 'utf8');
  assert.match(dispatch, /after `record worker` and fresh live occupant verification/);
  assert.match(dispatch, /retries retain it/);
  assert.match(dispatch, /must not launch a duplicate review/);
  assert.match(dispatch, /installed `current`, running sessions and saved claimed operations/);
});
