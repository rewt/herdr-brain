import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { ptyCommand, PTY_SKIP_REASON } from '../../test/helpers/pty.mjs';
import { nativeEntryReceipt, assertLessonEntry } from '../entry.mjs';
import { lessonsEntryCase } from '../lessons.mjs';
import { cases, runCase } from '../cases.mjs';
import { gateOutcome } from '../results.mjs';

const product = path.resolve(import.meta.dirname, '../..');
test('native receipts require actual lesson prompt arguments for each transport', () => {
  const installation = '/scratch/product', lesson = 'Planted lesson';
  const policy = `/scratch/product/discovery/policy.mjs\nActive lessons for this project and entered area:\n${lesson}`;
  for (const kind of ['codex', 'claude']) {
    const args = kind === 'codex' ? ['-c', `developer_instructions=${JSON.stringify(policy)}`] : ['--append-system-prompt', policy];
    const receipt = { ...nativeEntryReceipt(kind, args, installation, '/scratch/lane'), nativePid: 123 };
    const options = { kind, installation, lesson };
    assertLessonEntry(receipt, options);
    for (const bad of [{ ...receipt, nativePid: undefined }, { ...receipt, args: [] },
      { ...receipt, policy: 'invented receipt' }, { ...receipt, source: '/foreign/policy.mjs' }])
      assert.throws(() => assertLessonEntry(bad, options));
    assert.throws(() => assertLessonEntry(receipt, { ...options, lesson: 'Missing lesson' }));
    assert.throws(() => assertLessonEntry(receipt, { ...options, kind: kind === 'codex' ? 'claude' : 'codex' }));
  }
});

test('skipped fresh lessons sessions keep the release gate pending without launching anything', async () => {
  const results = [{ ...cases.fixture, status: 'PASS' }];
  await runCase(results, cases.lessons, () => lessonsEntryCase({ opt: { 'skip-live': true } }));
  assert.equal(results[1].status, 'PENDING'); assert.match(results[1].detail, /explicitly skipped/);
  assert.equal(gateOutcome(results).ready, false);
});

function fixture(t, { activate = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/lesson-gate-test-'));
  const scratchRoots = [root], discoveryRoots = [], evidence = path.join(root, 'evidence');
  fs.mkdirSync(evidence);
  t.after(() => { for (const directory of scratchRoots) fs.rmSync(directory, { recursive: true, force: true }); });
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
  const read = file => fs.readFileSync(file, 'utf8');
  write(path.join(root, 'ownership.json'), JSON.stringify({ creationRoots: [] }));
  fs.copyFileSync(path.join(product, 'lib/deadline.mjs'), path.join(root, 'deadline.mjs'));
  fs.copyFileSync(path.join(product, 'acceptance/producers.mjs'), path.join(root, 'producers.mjs'));
  const binaries = {};
  for (const kind of ['codex', 'claude']) {
    binaries[kind] = path.join(root, `offline-${kind}`);
    write(binaries[kind], `#!${process.execPath}\nif(process.argv.includes('--help')||process.argv.includes('--version'))process.exit(0);console.log(${JSON.stringify(kind === 'codex' ? 'OpenAI Codex offline UI' : 'Claude Code offline UI')});setInterval(()=>{},1000);\n`);
    fs.chmodSync(binaries[kind], 0o755);
  }
  const children = [], screens = new Map(), closed = [];
  const run = (file, args, options = {}) => {
    if (file === 'which') return { status: 0, stdout: binaries[args[0]] };
    const result = spawnSync(file, args, { cwd: options.cwd ?? root, env: options.isolatedEnv ?? { ...process.env, ...options.extra }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.error?.message); return result;
  };
  const node = (file, args, options = {}) => {
    if (file === path.join(root, 'herdr.mjs') && args[1] === 'read') return { stdout: screens.get(args[2]) ?? '' };
    if (!activate && args[0] === 'lesson' && args[1] === 'activate') return { stdout: '' };
    return run(process.execPath, [file, ...args], options);
  };
  const initRepo = repo => {
    fs.mkdirSync(repo);
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Lesson gate'], ['config', 'user.email', 'gate@example.invalid'],
      ['commit', '--allow-empty', '-qm', 'Seed']]) run('git', args, { cwd: repo });
  };
  let count = 0, cwd;
  const h = (...args) => {
    if (args[0] === 'workspace' && args[1] === 'create') {
      assert.ok(args.includes('--no-focus'));
      cwd = args[args.indexOf('--cwd') + 1]; count++;
      return { workspace: { workspace_id: `w${count}` }, root_pane: { pane_id: `w${count}:p1` } };
    }
    if (args[1] === 'get') return { pane: { foreground_cwd: cwd } };
    if (args[1] === 'run') {
      const pane = args[2], transport = ptyCommand('/bin/sh', ['-c', args[3]]);
      const child = spawnChild(t, transport.file, transport.args, { cwd, env: process.env });
      child.stdout.on('data', data => screens.set(pane, (screens.get(pane) ?? '') + data));
      child.stderr.on('data', data => screens.set(pane, (screens.get(pane) ?? '') + data));
      children.push(child); return {};
    }
    if (args[1] === 'close') { closed.push(args[2]); return {}; }
    assert.fail(`Unexpected Herdr operation ${args.join(' ')}`);
  };
  const until = async (check, label) => {
    const deadline = Date.now() + 12000;
    while (!check()) {
      assert.ok(Date.now() < deadline, `${label}: ${[...screens.values()].join('\n')}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  return { options: { root, scratchRoots, discoveryRoots, candidate: product, evidence, run, node, initRepo, h, until, write, read },
    closed, children, read, evidence, root };
}

const skip = process.platform !== 'darwin' ? 'entry UI canary uses macOS sandbox-exec' : PTY_SKIP_REASON;
test('release lesson case uses real installed automatic adapters and owned PTYs with offline native stand-ins', { skip }, async t => {
  const f = fixture(t);
  assert.match(await lessonsEntryCase(f.options), /fresh Codex and Claude/);
  assert.deepEqual(f.closed, ['w1', 'w2']);
  const planted = JSON.parse(f.read(path.join(f.evidence, 'lessons-planted.json')));
  for (const kind of ['codex', 'claude']) {
    const receipt = JSON.parse(f.read(path.join(f.evidence, `lessons-${kind}.entry.json`)));
    assert.match(receipt.policy, /entered area \(area\)/);
    assert.ok(receipt.policy.includes(planted.lesson));
    assert.match(f.read(path.join(f.evidence, `lessons-${kind}.screen.txt`)), /offline UI/);
    assert.ok(receipt.cwd !== planted.repo);
  }
  for (const child of f.children) await waitForExit(child);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'producers')), []);
});

test('a proposed canary cannot pass entry delivery and its fresh session still stops', { skip }, async t => {
  const f = fixture(t, { activate: false });
  await assert.rejects(lessonsEntryCase(f.options), /Active lessons|planted active lesson/);
  assert.deepEqual(f.closed, ['w1']);
  for (const child of f.children) await waitForExit(child);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'producers')), []);
});
