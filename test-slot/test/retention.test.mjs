import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pruneExecutions, EXECUTIONS_PER_PROFILE, RETENTION_SCHEMA } from '../retention.mjs';
import { boundedTelemetry, TELEMETRY_ROWS, measureFamily } from '../measurement.mjs';
import { resourceStanza } from '../resources.mjs';
import { historyFile } from '../limits.mjs';
import { processStartRecord } from '../lock-support.mjs';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function receipt(directory, index, changes = {}) {
  const file = path.join(directory, `${1000 + index}-${index.toString(16).padStart(16, '0')}.execution.json`);
  const value = { resource: { profile: { id: 'fixture/profile' } }, finished_at: '2026-10-16T00:00:00Z',
    retention: { schema: RETENTION_SCHEMA, holder: { pid: 2147483647, pgid: null, token: `token-${index}`, liveness: 'gone' }, lock_paths: [] }, ...changes };
  fs.writeFileSync(file, JSON.stringify(value));
  fs.writeFileSync(`${file}.samples.jsonl`, '{}\n');
  return file;
}

test('retention keeps newest evidence per profile and protects current, live, unknown, unfinished and redirected receipts', t => {
  const root = fixture(t), files = Array.from({ length: 40 }, (_, i) => receipt(root, i));
  const change = (index, update) => {
    const value = JSON.parse(fs.readFileSync(files[index])); update(value); fs.writeFileSync(files[index], JSON.stringify(value));
  };
  change(1, value => { value.retention.holder.liveness = 'live'; });
  change(2, value => { value.retention.holder.liveness = 'unknown'; });
  change(3, value => { delete value.finished_at; });
  const lock = path.join(root, 'live-lock');
  fs.writeFileSync(lock, JSON.stringify({ token: 'token-4', liveness: 'live' }));
  change(4, value => { value.retention.lock_paths = [lock]; });
  const foreign = path.join(root, 'foreign'); fs.writeFileSync(foreign, 'must survive');
  fs.unlinkSync(`${files[5]}.samples.jsonl`); fs.symlinkSync(foreign, `${files[5]}.samples.jsonl`);
  change(6, value => { value.measurement = { telemetry_path: foreign, telemetry_file: '../foreign' }; });
  change(7, value => { delete value.finished_at; value.command_pid = 2147483647; });
  const other = receipt(root, 50, { resource: { profile: { id: 'fixture/other' } } });
  const legacy = receipt(root, 51, { retention: undefined });
  const before = new Map([...files.slice(0, 6), ...files.slice(20), other, legacy].map(file => [file, fs.readFileSync(file, 'utf8')]));
  const pruned = pruneExecutions(files[0], 'fixture/profile', holder => ({ state: holder?.liveness ?? 'unknown' }));
  assert.equal(pruned, 14);
  for (const [file, bytes] of before) assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  for (const file of files.slice(6, 20)) {
    assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(`${file}.samples.jsonl`), false);
  }
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'must survive');
});

test('automatic CLI receipt writes prune managed pairs without altering exit status or other profiles', t => {
  const root = fixture(t), common = path.join(root, 'common'), lock = path.join(root, 'slot');
  fs.mkdirSync(common);
  const env = { ...testSlotEnvironment(), MONITOR_GATE_HISTORY_ROOT: path.join(root, 'history'),
    MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock };
  const argv = [process.execPath, '-e', 'setTimeout(()=>process.exit(7),100)'];
  const directory = path.join(path.dirname(historyFile(common, 'fixture', argv, undefined, env)), 'executions');
  fs.mkdirSync(directory, { recursive: true });
  const old = Array.from({ length: EXECUTIONS_PER_PROFILE + 1 }, (_, index) => receipt(directory, index));
  const identity = processStartRecord(process.pid);
  const live = JSON.parse(fs.readFileSync(old[0]));
  live.retention.holder = { pid: process.pid, pgid: null, processStart: identity.start, processBirth: identity.birth, token: 'live-holder' };
  fs.writeFileSync(old[0], JSON.stringify(live));
  const other = receipt(directory, 100, { resource: { profile: { id: 'fixture/other' } } });
  const cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'run', 'fixture', '--project-common', common, '--lock-path', lock,
    '--resource', JSON.stringify(resourceStanza('fixture/profile', argv)), '--', ...argv],
  { cwd: root, env, encoding: 'utf8', timeout: loadTimeout(15000) });
  assert.equal(result.status, 7, result.stderr);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(other), true);
  assert.equal(fs.existsSync(old[0]), true, 'an older live holder retains its exact receipt');
  assert.deepEqual(JSON.parse(fs.readFileSync(old[0])), live);
  assert.equal(fs.existsSync(old[1]), false);
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.execution.json'));
  const values = files.map(name => JSON.parse(fs.readFileSync(path.join(directory, name))));
  assert.equal(values.filter(value => value.resource.profile.id === 'fixture/profile').length, EXECUTIONS_PER_PROFILE + 1);
  const saved = values.find(value => value.command_started);
  assert.equal(saved.exit_code, 7); assert.equal(saved.retention.newest_per_profile, EXECUTIONS_PER_PROFILE);
  assert.ok(saved.retention.holder.processBirth); assert.ok(saved.retention.holder.pgid);
  assert.equal(saved.measurement.telemetry.truncated, false);
});

test('telemetry retains at most the last 256 rows and reports truncation', t => {
  const root = fixture(t), file = path.join(root, 'samples.jsonl'), writer = boundedTelemetry(file);
  for (let index = 0; index < TELEMETRY_ROWS + 5; index++) writer.write({ index });
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, TELEMETRY_ROWS); assert.equal(rows[0].index, 5);
  assert.equal(rows.at(-1).index, TELEMETRY_ROWS + 4);
  assert.deepEqual(writer.summary(), { policy: 'last rows across all attempts', row_limit: 256,
    rows_observed: 261, rows_retained: 256, rows_dropped: 5, truncated: true, write_failures: 0 });
});

test('retry phases share the telemetry bound while aggregates retain observations removed from the tail', t => {
  const root = fixture(t), file = path.join(root, 'samples.jsonl'), telemetry = boundedTelemetry(file, 3);
  let bytes = 9000;
  const meter = () => measureFamily({ pid: 10, identity: 'birth', telemetryPath: file, telemetry, intervalMs: 60000,
    workers: () => ({}), load: () => 1, memory: () => ({ source: '/proc/meminfo', available: 10000 }),
    lookup: () => ({ ok: true, value: new Map([[10, { pid: 10, ppid: 1, pgid: 10, identity: 'birth' }]]) }),
    rss: () => new Map([[10, bytes]]) });
  const first = meter(); bytes = 10;
  const a = first.finish(), b = meter().finish();
  assert.equal(a.sampled_sum_owned_rss_peak_bytes, 9000); assert.equal(b.sampled_sum_owned_rss_peak_bytes, 10);
  assert.equal(a.samples + b.samples, 4);
  assert.equal(b.telemetry.rows_observed, 4); assert.equal(b.telemetry.rows_dropped, 1); assert.equal(b.telemetry.truncated, true);
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3); assert.ok(rows.every(row => row.sampled_sum_owned_rss_bytes === 10));
});
