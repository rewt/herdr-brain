import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnScenarioChild, waitForExit } from './helpers/child.mjs';

const runner = fileURLToPath(new URL('./helpers/run.mjs', import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-output-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = path.join(root, 'timings.jsonl');
  const file = (name, source) => {
    const target = path.join(root, `${name}.test.mjs`);
    fs.writeFileSync(target, `import test from 'node:test'; import fs from 'node:fs';\n${source}`);
    return target;
  };
  async function run(files, extra = {}) {
    const child = spawnScenarioChild(t, process.execPath, [runner, '--load-factor=1', ...files], {
      env: { ...process.env, MONITOR_TEST_TIMINGS_PATH: journal,
        MONITOR_TEST_FILE_TIMEOUT_MS: '0', MONITOR_TEST_CONCURRENCY: '2', ...extra },
    });
    const result = await waitForExit(child);
    const references = [...result.stderr.matchAll(/^FILE_TAP_COMPLETE: (.*)$/gm)].map(match => JSON.parse(match[1]));
    const rows = fs.readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    return { ...result, references, rows };
  }
  return { root, file, run };
}

test('a capped first file retains complete failing and passing TAP from later admitted files', async t => {
  const f = fixture(t);
  const blocked = f.file('blocked', "test('earlier blocked body', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));");
  const diagnostic = `LATER-BEGIN-${'é'.repeat(128 * 1024)}-LATER-END`;
  const failing = f.file('failing', `for(let i=1;i<=32;i++) test('later subtest '+i,t=>{
    if(i===32){t.diagnostic(${JSON.stringify(diagnostic)});throw Error('later deliberate failure');}
  });`);
  const passing = f.file('passing', "test('later admission after failure',()=>{});");
  const result = await f.run([blocked, failing, passing], { MONITOR_TEST_FILE_TIMEOUT_MS: '5000' });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /FILE_TIMEOUT: .*blocked\.test\.mjs exceeded 5000ms/);
  assert.equal(result.references.length, 2, result.stderr);
  for (const [file, count, failures] of [[failing, 32, 1], [passing, 1, 0]]) {
    const reference = result.references.find(entry => entry.file === file);
    assert.ok(reference, result.stderr);
    assert.equal(reference.exit_code, failures);
    const tap = fs.readFileSync(reference.artifact, 'utf8');
    assert.match(tap, new RegExp(`1\\.\\.${count}\\n# tests ${count}\\n# suites 0\\n# pass ${count - failures}\\n# fail ${failures}\\n`));
    assert.equal([...tap.matchAll(/^(?:not )?ok \d+ - /gm)].length, count);
    assert.ok(result.stdout.includes(tap), 'complete later-file TAP must also reach the build log');
    const start = result.rows.find(row => row.kind === 'file' && row.event === 'start' && path.resolve(row.name) === file);
    const finishes = result.rows.filter(row => row.id === start?.id && row.event === 'finish');
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].exit_code, failures);
    assert.ok(!finishes[0].reason, 'finished peers must not be relabelled as cancelled');
    if (failures) {
      assert.ok(tap.includes(diagnostic), 'the complete large Unicode diagnostic must survive');
      assert.match(tap, /later deliberate failure/);
    }
  }
  const timeout = result.rows.find(row => row.kind === 'file' && row.event === 'finish' && row.reason === 'file-timeout');
  assert.ok(timeout, JSON.stringify(result.rows));
  assert.equal(timeout.signal, 'SIGKILL');
  assert.equal(timeout.observed_by, 'coordinator');
  assert.equal(result.rows.filter(row => row.kind === 'suite' && row.event === 'finish' && row.exit_code === 1).length, 1);
  t.diagnostic(JSON.stringify({ cap_ms: 5000, result: result.code, completed: result.references, timeout }));
});

test('independent file reporters retain admission limits, name selection and successful output', async t => {
  const f = fixture(t);
  const files = Array.from({ length: 12 }, (_, i) => f.file(`selected-${i}`, `
    test('selected file ${i}',async()=>{
      const active=${JSON.stringify(f.root)}+'/active-${i}';
      fs.writeFileSync(active,'');
      if(fs.readdirSync(${JSON.stringify(f.root)}).filter(name=>name.startsWith('active-')).length>2)throw Error('admission cap exceeded');
      try{await new Promise(resolve=>setTimeout(resolve,30));}finally{fs.unlinkSync(active);}
    });
    test('excluded file ${i}',()=>{throw Error('name selection was lost');});`));
  const result = await f.run(['--test-name-pattern=^selected', ...files]);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.references.length, files.length);
  assert.doesNotMatch(result.stderr, /MaxListenersExceededWarning/);
  for (const reference of result.references) {
    const tap = fs.readFileSync(reference.artifact, 'utf8');
    assert.match(tap, /# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n/);
    assert.ok(result.stdout.includes(tap), 'completed file TAP must be contiguous');
  }
  const starts = result.rows.filter(row => row.kind === 'file' && row.event === 'start');
  assert.equal(starts.length, files.length);
  for (const start of starts) assert.equal(result.rows.filter(row => row.id === start.id && row.event === 'finish' && row.exit_code === 0).length, 1);
});
