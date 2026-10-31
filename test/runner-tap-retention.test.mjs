import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnScenarioChild, waitForExit } from './helpers/child.mjs';
import { pruneExecutions, EXECUTIONS_PER_PROFILE, RETENTION_SCHEMA } from '../test-slot/retention.mjs';
import { tapArtifactPrefix } from '../test-slot/tap-artifacts.mjs';
import { parseLog } from '../promote/metrics.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-tap-retention-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('execution retention prunes its nested TAP family and preserves current, live, unknown and redirected evidence', t => {
  const root = fixture(t), profile = 'fixture/tap';
  const receipts = Array.from({ length: EXECUTIONS_PER_PROFILE + 7 }, (_, index) => {
    const file = path.join(root, `${1000 + index}-${index.toString(16).padStart(16, '0')}.execution.json`);
    const value = { finished_at: '2026-10-31T00:00:00Z', resource: { profile: { id: profile } },
      retention: { schema: RETENTION_SCHEMA, holder: { token: String(index), state: 'gone' }, lock_paths: [] } };
    if (index === 1) value.retention.holder.state = 'live';
    if (index === 2) value.retention.holder.state = 'unknown';
    fs.writeFileSync(file, JSON.stringify(value));
    fs.writeFileSync(`${file}.timings.jsonl`, '{}\n');
    fs.writeFileSync(`${file}.samples.jsonl`, '{}\n');
    const artifacts = Array.from({ length: 2 }, () => {
      const directory = fs.mkdtempSync(tapArtifactPrefix(`${file}.timings.jsonl`));
      fs.writeFileSync(path.join(directory, '1.tap'), 'TAP version 13\n# unfinished evidence\n');
      fs.writeFileSync(path.join(directory, '1.tap.stderr'), 'raw diagnostic');
      return directory;
    });
    return { file, artifacts };
  });
  const foreign = path.join(root, 'foreign'); fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'keep'), 'foreign bytes');
  const redirected = receipts[3].artifacts[0];
  fs.rmSync(redirected, { recursive: true }); fs.symlinkSync(foreign, redirected);
  const legacy = fs.mkdtempSync(path.join(root, 'test-file-tap-'));
  const unrelated = fs.mkdtempSync(tapArtifactPrefix(path.join(root, 'another-journal')));
  assert.equal(pruneExecutions(receipts[0].file, profile, holder => ({ state: holder.state })), 3);
  for (const [index, receipt] of receipts.entries()) {
    const retained = index < 4 || index >= 7;
    assert.equal(fs.existsSync(receipt.file), retained, receipt.file);
    assert.equal(fs.existsSync(`${receipt.file}.timings.jsonl`), retained);
    assert.equal(fs.existsSync(`${receipt.file}.samples.jsonl`), retained);
    for (const artifact of receipt.artifacts) assert.equal(fs.existsSync(artifact), retained, artifact);
  }
  assert.equal(fs.readFileSync(path.join(foreign, 'keep'), 'utf8'), 'foreign bytes');
  assert.ok(fs.existsSync(legacy)); assert.ok(fs.existsSync(unrelated));
});

test('real multi-file TAP is attributed to the completed file, including a failure without a file location', async t => {
  const root = fixture(t), journal = path.join(root, 'timings.jsonl');
  const files = ['slow pass', 'fast failure'].map((name, index) => {
    const file = path.join(root, `${name}.test.mjs`);
    fs.writeFileSync(file, `import test from 'node:test'; test(${JSON.stringify(name)},async()=>{
      await new Promise(r=>setTimeout(r,${index ? 10 : 100})); ${index ? "throw Error('deliberate failure')" : ''}
    });`);
    return file;
  });
  const runner = fileURLToPath(new URL('./helpers/run.mjs', import.meta.url));
  const child = spawnScenarioChild(t, process.execPath, [runner, '--load-factor=1', ...files], {
    env: { ...process.env, MONITOR_TEST_TIMINGS_PATH: journal, MONITOR_TEST_CONCURRENCY: '2', MONITOR_TEST_FILE_TIMEOUT_MS: '0' },
  });
  const result = await waitForExit(child);
  assert.equal(result.code, 1, result.stderr); assert.equal(result.signal, null);
  const parsed = parseLog(result.stdout, [root]);
  assert.equal(parsed.groups.length, 0);
  assert.equal(parsed.files.length, 2);
  for (const [index, file] of files.entries()) {
    const row = parsed.files.find(row => row.name === path.basename(file));
    assert.ok(row, JSON.stringify(parsed)); assert.equal(row.failed, Boolean(index));
    assert.ok(row.duration_s > 0);
  }
  assert.ok(parsed.failing_files.includes('fast failure.test.mjs'));
  const references = [...result.stderr.matchAll(/^FILE_TAP_COMPLETE: (.*)$/gm)].map(match => JSON.parse(match[1]));
  assert.equal(references.length, 2);
  for (const reference of references) {
    assert.ok(path.dirname(reference.artifact).startsWith(tapArtifactPrefix(journal)));
    assert.ok(result.stdout.includes(fs.readFileSync(reference.artifact, 'utf8')));
  }
});

test('partial and malformed document labels do not contaminate later totals or legacy groups', () => {
  const total = '# duration_ms 2000\n';
  const parsed = parseLog(`> sample@1 test:checks
> node test/helpers/run.mjs test/first.test.mjs test/second.test.mjs
# FILE_TAP: {"file":"test/capped.test.mjs"}
TAP version 13
# Subtest: unfinished
# FILE_TAP: {"file":"test/second.test.mjs"}
TAP version 13
ok 1 - recovered peer
${total}# FILE_TAP: invalid
TAP version 13
ok 1 - legacy
${total}`);
  assert.deepEqual(parsed.files.map(row => [row.name, row.duration_s]), [['test/second.test.mjs', 2]]);
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.groups[0].name, 'test/first.test.mjs + test/second.test.mjs');
});
