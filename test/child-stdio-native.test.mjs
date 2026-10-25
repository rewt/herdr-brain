import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { spawnChild, spawnScenarioChild, waitForExit, childProcessEntry } from './helpers/child.mjs';
import { lookupProcess } from './helpers/processes.mjs';

const runner = fileURLToPath(new URL('./helpers/run.mjs', import.meta.url));
const bounded = new URL('./helpers/bounded-test.mjs', import.meta.url).href;
const helper = new URL('./helpers/child.mjs', import.meta.url).href;
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
function pipeWriter() {
  const fs = require('node:fs'), [root, mode] = process.argv.slice(2);
  const out = fs.createWriteStream(null, { fd: 1, autoClose: true });
  const err = fs.createWriteStream(null, { fd: 2, autoClose: true });
  out.write('out-prefix\n');
  err.write('err-prefix\n');
  process.send({ writer: process.pid }, () => process.disconnect());
  const release = () => {
    if (!fs.existsSync(root + '/release')) { setTimeout(release, 10); return; }
    if (mode === 'survivor') setInterval(() => {}, 1000);
    out.end('out-tail\n');
    err.end('err-tail\n');
  };
  release();
}
function target() {
  const cp = require('node:child_process'), path = require('node:path');
  const [root, mode] = process.argv.slice(2);
  const writer = cp.spawn(process.execPath, [path.join(root, 'writer.cjs'), root, mode],
    { stdio: ['ignore', 1, 2, 'ipc'] });
  writer.unref();
  writer.once('error', error => { throw error; });
  writer.once('exit', (code, signal) => {
    if (code !== 0 || signal) throw Error('writer failed: ' + JSON.stringify({ code, signal }));
  });
  writer.once('message', value => process.send(value));
  process.once('message', value => { process.exitCode = value.code; process.disconnect(); });
}
async function nestedCase(t, root, mode, target) {
  const publish = (name, value) => {
    fs.writeFileSync(root + '/' + name + '.tmp', JSON.stringify(value));
    fs.renameSync(root + '/' + name + '.tmp', root + '/' + name);
  };
  const child = spawnChild(t, process.execPath, [target, root, mode],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let out = '', err = '', result, failure, closed = false;
  child.stdout.on('data', bytes => { out += bytes; });
  child.stderr.on('data', bytes => { err += bytes; });
  child.once('close', () => { closed = true; });
  const done = waitForExit(child);
  done.then(value => { result = value; }, error => { failure = error; });
  const wait = async name => {
    while (!fs.existsSync(root + '/' + name)) {
      if (failure) throw failure;
      if (result) throw Error('child completed before ' + name + ': ' + JSON.stringify(result));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const ready = await Promise.race([once(child, 'message').then(values => values[0]),
    done.then(value => { throw Error('child closed before readiness: ' + JSON.stringify(value)); })]);
  publish('ready', { file: process.pid, worker: process.ppid, target: child.pid, writer: ready.writer });
  await wait('start');
  const exit = once(child, 'exit');
  child.send({ code: mode === 'exit7' ? 7 : 0 });
  const [code, signal] = await exit;
  while (out !== 'out-prefix\n' || err !== 'err-prefix\n') {
    if (failure) throw failure;
    assert.equal(result, undefined, 'held writer must prevent completion');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(result, undefined);
  assert.equal(closed, false);
  publish('pending', { code, signal, out, err, closed });
  const value = await done;
  assert.equal(closed, true, 'result requires actual native close');
  assert.deepEqual(value, { code, status: code, signal, stdout: 'out-prefix\nout-tail\n', stderr: 'err-prefix\nerr-tail\n' });
  assert.equal(await waitForExit(child), value);
  publish('closed', value);
  while (!fs.existsSync(root + '/finish')) await new Promise(resolve => setTimeout(resolve, 10));
}
function read(pid) {
  assert.ok(Number.isInteger(pid) && pid > 1);
  const value = lookupProcess(pid);
  assert.ok(value.ok, value.error);
  return value.value;
}
async function gone(entries) {
  for (;;) {
    const live = entries.filter(entry => read(entry.pid)?.identity === entry.identity);
    if (!live.length) return;
    await pause();
  }
}
function fixture(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'child-stdio-native-'));
  let child, complete = false, result, failure;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      assert.equal(child.kill('SIGTERM'), true);
      await waitForExit(child);
    }
    if (complete) fs.rmSync(root, { recursive: true, force: true });
  });
  const target = path.join(root, 'target.cjs'), file = path.join(root, 'case.test.mjs');
  fs.writeFileSync(path.join(root, 'writer.cjs'), pipeWriter.toString() + '\npipeWriter();\n');
  fs.writeFileSync(target, targetBody + '\ntarget();\n');
  fs.writeFileSync(file, [
    'import test from ' + JSON.stringify(bounded) + ';',
    "import assert from 'node:assert/strict';",
    "import fs from 'node:fs';",
    "import {once} from 'node:events';",
    'import {spawnChild,waitForExit} from ' + JSON.stringify(helper) + ';',
    'test("native pipe fixture",t=>(' + nestedCase.toString() + ')(t,' +
      JSON.stringify(root) + ',' + JSON.stringify(mode) + ',' + JSON.stringify(target) + '));',
  ].join('\n'));
  child = spawnScenarioChild(t, process.execPath, [runner, file]);
  const done = waitForExit(child);
  done.then(value => { result = value; }, error => { failure = error; });
  return { root, mode, child, done, file, target,
    release: name => fs.writeFileSync(path.join(root, name), 'go'),
    complete: () => { complete = true; },
    async wait(name) {
      while (!fs.existsSync(path.join(root, name))) {
        if (failure) throw failure;
        assert.equal(result, undefined, 'nested runner ended before ' + name + ': ' + JSON.stringify(result));
        await pause();
      }
      return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    },
  };
}
const targetBody = target.toString();
function capture(f, receipt) {
  const owner = read(f.child.pid), worker = read(receipt.worker), file = read(receipt.file);
  const target = read(receipt.target), writer = read(receipt.writer);
  for (const row of [owner, worker, file, target, writer]) assert.ok(row);
  const owned = childProcessEntry(f.child);
  assert.equal(owner.identity, owned.identity);
  assert.equal(owner.command, owned.command);
  assert.equal(worker.ppid, owner.pid);
  assert.equal(worker.pgid, worker.pid);
  assert.ok(worker.command.includes(runner + ' --worker '));
  assert.ok(file.command.includes(f.file));
  assert.equal(file.ppid, worker.pid);
  assert.equal(target.ppid, file.pid);
  assert.equal(writer.ppid, target.pid);
  for (const row of [file, target, writer]) assert.equal(row.pgid, worker.pid);
  assert.equal(target.command, [process.execPath, f.target, f.root, f.mode].join(' '));
  assert.equal(writer.command, [process.execPath, path.join(f.root, 'writer.cjs'), f.root, f.mode].join(' '));
  return { owner, worker, file, target, writer };
}
for (const mode of ['exit0', 'exit7', 'survivor', 'cancel']) {
  test(mode + ': actual pipe close, strict audit and owned cancellation', async t => {
    const f = fixture(t, mode);
    const sentinel = spawnChild(t, process.execPath,
      ['-e', "process.on('message',()=>process.disconnect());process.send('ready')"],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const ready = await Promise.race([once(sentinel, 'message'), waitForExit(sentinel).then(value => {
      throw Error('sentinel exited before readiness: ' + JSON.stringify(value));
    })]);
    assert.equal(ready[0], 'ready');
    const entries = capture(f, await f.wait('ready'));
    f.release('start');
    const pending = await f.wait('pending');
    assert.deepEqual(pending, { code: mode === 'exit7' ? 7 : 0, signal: null,
      out: 'out-prefix\n', err: 'err-prefix\n', closed: false });
    if (mode === 'cancel') {
      assert.equal(f.child.kill('SIGTERM'), true);
    } else {
      f.release('release');
      const closed = await f.wait('closed');
      assert.equal(closed.code, pending.code);
      assert.equal(closed.stdout, 'out-prefix\nout-tail\n');
      assert.equal(closed.stderr, 'err-prefix\nerr-tail\n');
      if (mode === 'survivor') assert.equal(read(entries.writer.pid)?.identity, entries.writer.identity);
      else await gone([entries.writer, entries.target]);
      f.release('finish');
    }
    const outcome = await f.done;
    assert.equal(outcome.code, mode === 'survivor' || mode === 'cancel' ? 1 : 0, outcome.stdout + outcome.stderr);
    if (mode === 'survivor') {
      assert.match(outcome.stderr, /Surviving fixture:/);
      assert.ok(outcome.stderr.includes(path.join(f.root, 'writer.cjs')), outcome.stderr);
    }
    await gone(Object.values(entries));
    assert.equal(sentinel.exitCode, null);
    assert.equal(sentinel.signalCode, null);
    sentinel.send('finish');
    assert.equal((await waitForExit(sentinel)).code, 0);
    f.complete();
  });
}
