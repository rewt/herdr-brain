import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnScenarioChild, waitForExit } from './helpers/child.mjs';
import { lookupProcess } from './helpers/processes.mjs';

const runner = fileURLToPath(new URL('./helpers/run.mjs', import.meta.url));

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-output-order-')));
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
  // Node may finish the cancelled reporter before the coordinator kills the
  // group. Its optional completion does not change the finished peers' proof.
  assert.equal(new Set(result.references.map(entry => entry.file)).size, result.references.length, result.stderr);
  for (const reference of result.references) {
    assert.ok([blocked, failing, passing].includes(reference.file), result.stderr);
    if (reference.file === blocked) assert.equal(reference.exit_code, 1);
  }
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

test('a capped first file frees admission while a concurrent peer and every queued file finish', async t => {
  const f = fixture(t);
  const entered = path.join(f.root, 'entered.json'), released = path.join(f.root, 'released');
  const peerActive = path.join(f.root, 'peer-active');
  const blocked = f.file('first-cap', `import {spawn} from 'node:child_process';
    const writes=[],write=process.stdout.write;
    process.stdout.write=function(bytes,...args){writes.push(Buffer.from(bytes));return write.call(this,bytes,...args);};
    test('partial result before cap',()=>{});
    test('blocked first file',async()=>{
      // Observe the old synchronous-block boundary before yielding. Node's
      // async serializer need not have written the preceding result yet.
      const beforeYield=Buffer.concat(writes).toString('base64');
      process.stdout.write=write;
      // Block only after the real reporter has retained a passing result.
      // The cap must preserve this observed prefix, not manufacture a result
      // that never reached the file runner before the synchronous block.
      let partial;
      while(!partial){
        for(const name of fs.readdirSync(${JSON.stringify(f.root)}).filter(name=>name.startsWith('test-file-tap-'))){
          const artifact=${JSON.stringify(f.root)}+'/'+name+'/1.tap';
          if(!fs.existsSync(artifact))continue;
          const tap=fs.readFileSync(artifact,'utf8');
          if(/^ok 1 - partial result before cap$/m.test(tap)){partial={artifact,tap,beforeYield};break;}
        }
        if(!partial)await new Promise(resolve=>setTimeout(resolve,10));
      }
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);
      fs.writeFileSync(${JSON.stringify(entered)},JSON.stringify({file:process.pid,worker:process.ppid,fixture:child.pid,partial}));
      fs.writeSync(2,'FIRST-CAP-DIAGNOSTIC\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
    });`);
  // Admit the peer later so it can survive the first file's cap and still
  // finish within its own unchanged cap once a queued file releases it.
  const stagger = f.file('stagger', `test('stagger peer admission',async()=>{
    while(!fs.existsSync(${JSON.stringify(entered)}))await new Promise(r=>setTimeout(r,10));
    await new Promise(r=>setTimeout(r,1000));
  });`);
  const peer = f.file('peer', `test('concurrent peer survives first cap',async()=>{
    fs.writeFileSync(${JSON.stringify(peerActive)},'');
    while(!fs.existsSync(${JSON.stringify(released)}))await new Promise(r=>setTimeout(r,10));
  });`);
  const release = f.file('release', `test('queued file runs after cap',()=>{
    if(!fs.existsSync(${JSON.stringify(peerActive)}))throw Error('concurrent peer did not start');
    fs.writeFileSync(${JSON.stringify(released)},'');
  });`);
  const diagnostic = `AFTER-CAP-CRASH-${'é'.repeat(128 * 1024)}-END`;
  const crash = f.file('crash', `await new Promise(resolve=>process.stderr.write(${JSON.stringify(diagnostic)},resolve));process.kill(process.pid,'SIGTERM');`);
  const last = f.file('last', "test('last queued file completes',()=>{});");
  const files = [blocked, stagger, peer, release, crash, last];
  const result = await f.run(files, { MONITOR_TEST_FILE_TIMEOUT_MS: '5000' });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.references.length, files.length, result.stderr);
  assert.equal(new Set(result.references.map(row => row.file)).size, files.length);
  assert.equal(result.rows.filter(row => row.reason === 'suite-cancelled').length, 0);
  const suite = result.rows.find(row => row.kind === 'suite' && row.event === 'start');
  assert.equal(result.rows.filter(row => row.kind === 'suite' && row.event === 'finish').length, 1);
  const timeout = result.rows.find(row => row.kind === 'file' && row.reason === 'file-timeout');
  assert.ok(timeout, JSON.stringify(result.rows));
  const owned = JSON.parse(fs.readFileSync(entered, 'utf8'));
  const beforeYield = Buffer.from(owned.partial.beforeYield, 'base64');
  t.diagnostic(JSON.stringify({ partial: { original_boundary_stdout_bytes: beforeYield.length,
    original_boundary_pass_serialized: beforeYield.includes(Buffer.from('test:pass')), retained_prefix: owned.partial.tap } }));
  t.diagnostic(JSON.stringify({ file_terminal_evidence: result.references }));
  const evidence = [];
  for (const file of files) {
    const reference = result.references.find(row => row.file === file);
    assert.ok(reference, file);
    assert.deepEqual(JSON.parse(fs.readFileSync(reference.completion_artifact, 'utf8')), reference);
    const tap = fs.readFileSync(reference.artifact, 'utf8');
    assert.ok(result.stdout.includes(tap), 'retained per-file TAP must reach the log');
    const starts = result.rows.filter(row => row.kind === 'file' && row.event === 'start' && path.resolve(row.name) === file);
    assert.equal(starts.length, 1, file);
    const [start] = starts, finishes = result.rows.filter(row => row.id === start.id && row.event === 'finish');
    assert.equal(start.suite, suite.id);
    assert.equal(start.depth, suite.depth);
    assert.equal(finishes.length, 1, file);
    const failed = file === blocked || file === crash;
    // file-timing observes the in-process exit hook. A self-signal can arrive
    // after that hook reports zero; the native completion below must still
    // fail with SIGTERM and retain the entire crash diagnostic.
    if (file !== crash) assert.equal(finishes[0].exit_code, failed ? 1 : 0, file);
    assert.equal(reference.exit_code, failed ? 1 : 0, file);
    if (!failed) assert.match(tap, /# pass 1\n# fail 0\n/);
    if (file === blocked) {
      assert.equal(owned.partial.artifact, reference.artifact);
      assert.match(owned.partial.tap, /^ok 1 - partial result before cap$/m);
      assert.ok(tap.startsWith(owned.partial.tap), 'the exact TAP observed before blocking must survive the cap');
      assert.equal(reference.reason, 'file-timeout');
      assert.equal(reference.tap_complete, false);
      assert.match(fs.readFileSync(reference.stderr_artifact, 'utf8'), /FIRST-CAP-DIAGNOSTIC/);
    }
    if (file === crash) {
      assert.equal(reference.failure.signal, 'SIGTERM');
      assert.equal(fs.readFileSync(reference.stderr_artifact, 'utf8'), diagnostic);
      assert.ok(result.stderr.includes(diagnostic), 'raw crash stderr must reach the log after the cap');
    }
    if (file === release || file === last) assert.ok(Date.parse(start.at) > Date.parse(timeout.at), 'queued files must start after the cap');
    if (file === peer) {
      assert.ok(Date.parse(start.at) < Date.parse(timeout.at), 'peer must already be running at the cap');
      assert.ok(Date.parse(finishes[0].at) > Date.parse(timeout.at), 'peer must complete after the cap');
    }
    evidence.push({ file: path.basename(file), exit_code: reference.exit_code, timing_exit_code: finishes[0].exit_code,
      ...(reference.failure?.signal ? { signal: reference.failure.signal } : {}), tap_bytes: Buffer.byteLength(tap), start: start.at, finish: finishes[0].at });
  }
  const reaped = { file: owned.file, worker: owned.worker, fixture: owned.fixture };
  for (const pid of Object.values(reaped)) {
    const current = lookupProcess(pid);
    assert.equal(current.ok, true, current.error);
    assert.ok(!current.value || /^Z/.test(current.value.state), `capped file descendant ${pid} survived`);
  }
  t.diagnostic(JSON.stringify({ cap_ms: 5000, concurrency: 2, result: result.code, timeout, crash_stderr_bytes: Buffer.byteLength(diagnostic), reaped, files: evidence }));
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
  const result = await f.run(['--test-name-pattern=^selected', ...files], { MONITOR_TEST_FILE_TIMEOUT_MS: '15000' });
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

test('live artifact writes keep output watchers informed before file completion', async t => {
  const f = fixture(t);
  const file = f.file('progress', `for(let i=0;i<4;i++)test('live progress '+i,async()=>{
    await new Promise(resolve=>setTimeout(resolve,650));
  });`);
  const result = await f.run([file]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const progress = [...result.stderr.matchAll(/^FILE_TAP_PROGRESS: (.*)$/gm)];
  assert.ok(progress.length >= 1, 'live TAP must notify the existing output watcher');
  let previous = 0;
  for (const match of progress) {
    const reference = JSON.parse(match[1]);
    assert.equal(reference.file, file);
    assert.ok(reference.bytes > previous, 'progress must reflect newly retained TAP');
    previous = reference.bytes;
    assert.ok(match.index < result.stderr.indexOf('FILE_TAP_COMPLETE:'), 'activity must be visible before completion');
  }
  assert.equal(result.references.length, 1);
  assert.match(fs.readFileSync(result.references[0].artifact, 'utf8'), /# tests 4\n# suites 0\n# pass 4\n# fail 0\n/);
});
