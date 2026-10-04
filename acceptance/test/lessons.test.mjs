import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnScenarioChild, waitForExit } from '../../test/helpers/child.mjs';
import { ptyCommand, PTY_SKIP_REASON } from '../../test/helpers/pty.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { nativeEntryReceipt, assertLessonEntry } from '../entry.mjs';
import { lessonsEntryCase, nativeUiReady } from '../lessons.mjs';
import { cases, runCase } from '../cases.mjs';
import { gateOutcome, resultLine } from '../results.mjs';

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

test('native interactive readiness requires more than a retained banner', () => {
  for (const kind of ['codex', 'claude']) {
    const banner = kind === 'codex' ? 'OpenAI Codex' : 'Claude Code';
    const prompt = kind === 'codex' ? '› Ask a question' : '❯ Try a command';
    assert.equal(nativeUiReady(kind, `${banner}\nStartup failed`), false);
    assert.equal(nativeUiReady(kind, prompt), false);
    assert.equal(nativeUiReady(kind, `${banner}\n${prompt}`), true);
  }
  assert.equal(nativeUiReady('codex', 'Welcome to Codex\n1. Sign in with ChatGPT'), true);
  assert.equal(nativeUiReady('claude', 'Welcome to Claude Code\nChoose the text style\nEnter to confirm'), true);
});

function fixture(t, { activate = true, claudeProfile = true, missingNative = false, exitKind, exitCode = 1, exitWithPrompt = false, delayedCleanup = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/lesson-gate-test-'));
  const scratchRoots = [root], discoveryRoots = [], evidence = path.join(root, 'evidence');
  fs.mkdirSync(evidence);
  t.after(() => { for (const directory of scratchRoots) fs.rmSync(directory, { recursive: true, force: true }); });
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
  // Explicit offline stand-in profile: no real credentials or host profile reads.
  const profile = path.join(root, 'dedicated-profile');
  if (claudeProfile) write(path.join(profile, 'profile-marker'), 'offline profile');
  const terminationObservations = [];
  const read = file => {
    if (delayedCleanup && file.endsWith(`/${exitKind}/native.done.json`)) terminationObservations.push({
      cleanupBlocked: fs.existsSync(path.join(path.dirname(file), 'cleanup-blocked')),
      adapterDone: fs.existsSync(path.join(root, 'live-jobs', `lessons-${exitKind}.done`)),
    });
    return fs.readFileSync(file, 'utf8');
  };
  write(path.join(root, 'ownership.json'), JSON.stringify({ creationRoots: [] }));
  fs.copyFileSync(path.join(product, 'lib/deadline.mjs'), path.join(root, 'deadline.mjs'));
  fs.copyFileSync(path.join(product, 'acceptance/producers.mjs'), path.join(root, 'producers.mjs'));
  const binaries = {};
  for (const kind of ['codex', 'claude']) {
    binaries[kind] = path.join(root, `offline-${kind}`);
    const banner = kind === 'codex' ? 'OpenAI Codex offline UI' : 'Claude Code offline UI';
    const prompt = kind === 'codex' ? '› Ask a question' : '❯ Try a command';
    const screen = kind !== exitKind || exitWithPrompt ? `${banner}\n${prompt}` : banner;
    // Finish writing the retained screen before the scripted exit. A timer or
    // process.exit immediately after console.log can race PTY output drainage.
    const profileCheck = kind === 'claude' ? `const fs=require('node:fs'),path=require('node:path');const config=process.env.CLAUDE_CONFIG_DIR;if(config!==${JSON.stringify(claudeProfile ? path.join(root, 'claude-runtime') : '')}&& !config.startsWith(process.env.HOME+'/'))throw Error('profile escaped scratch');if(fs.existsSync(path.join(config,'profile-marker'))!==${claudeProfile})throw Error('wrong profile mode');` : '';
    write(binaries[kind], `#!${process.execPath}\nif(process.argv.includes('--help')||process.argv.includes('--version'))process.exit(0);${profileCheck}process.stdout.write(${JSON.stringify(`${screen}\n`)},()=>{${kind === exitKind ? `process.exit(${exitCode});` : 'setInterval(()=>{},1000);'}});\n`);
    fs.chmodSync(binaries[kind], 0o755);
  }
  const children = [], paneChildren = new Map(), screens = new Map(), closed = [];
  const run = (file, args, options = {}) => {
    if (file === 'which') return { status: 0, stdout: binaries[args[0]] };
    const result = spawnSync(file, args, { cwd: options.cwd ?? root, env: options.isolatedEnv ?? { ...process.env, ...options.extra }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.error?.message); return result;
  };
  const node = (file, args, options = {}) => {
    if (file === path.join(root, 'herdr.mjs') && args[1] === 'read') {
      // Exiting stand-ins expose retained scrollback after native termination,
      // rather than racing a legitimate observation while the UI is still alive.
      if (exitKind && args[2] === (exitKind === 'codex' ? 'w1:p1' : 'w2:p1')) {
        const scratch = JSON.parse(read(path.join(root, 'ownership.json'))).creationRoots[0];
        if (!fs.existsSync(path.join(scratch, exitKind, 'native.done.json'))) return { stdout: '' };
      }
      return { stdout: screens.get(args[2]) ?? '' };
    }
    if (!activate && args[0] === 'lesson' && args[1] === 'activate') return { stdout: '' };
    return run(process.execPath, [file, ...args], options);
  };
  const initRepo = repo => {
    fs.mkdirSync(repo);
    if (delayedCleanup) {
      // Hold the real installed adapter's cleanup until harness teardown asks
      // it to stop. This is a gate, not a race against a chosen timeout.
      const temp = path.join(path.dirname(repo), exitKind);
      const adapter = path.join(path.dirname(repo), 'product/discovery/adapters', `${exitKind}.mjs`);
      const source = fs.readFileSync(adapter, 'utf8');
      assert.ok(source.includes('clearInterval(timer);'));
      fs.writeFileSync(adapter, source.replace("import { spawn }", "import fsCleanup from 'node:fs';\nimport { spawn }").replaceAll('clearInterval(timer);',
        `fsCleanup.writeFileSync(${JSON.stringify(path.join(temp, 'cleanup-blocked'))}, 'blocked'); while (!fsCleanup.existsSync(${JSON.stringify(path.join(temp, 'stop'))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); clearInterval(timer);`));
    }
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
      if (missingNative && count === 2) fs.unlinkSync(binaries.claude);
      const pane = args[2], transport = ptyCommand('/bin/sh', ['-c', args[3]]);
      const child = spawnScenarioChild(t, transport.file, transport.args, { cwd, env: process.env });
      child.stdout.on('data', data => screens.set(pane, (screens.get(pane) ?? '') + data));
      child.stderr.on('data', data => screens.set(pane, (screens.get(pane) ?? '') + data));
      children.push(child); paneChildren.set(pane, child); return {};
    }
    if (args[1] === 'close') { closed.push(args[2]); return {}; }
    assert.fail(`Unexpected Herdr operation ${args.join(' ')}`);
  };
  const until = async (check, label) => {
    const deadline = Date.now() + loadTimeout(12000);
    if (exitKind && !delayedCleanup && label === `lessons-${exitKind} native entry receipt`) {
      // native.done is published on the UI child's exit, before the transport
      // and installed adapter close. Let the whole session exit naturally:
      // otherwise the harness's finally/stop can signal that closing adapter
      // and replace its scripted completion code with a null/signal result.
      // waitForExit retains the close event and the scenario child bounds it
      // with a load-aware allowance; no chosen delay stands in for completion.
      const pane = exitKind === 'codex' ? 'w1:p1' : 'w2:p1';
      const completion = await waitForExit(paneChildren.get(pane));
      assert.equal(completion.signal, null);
    }
    const exitReady = () => {
      if (!exitKind || label !== `lessons-${exitKind} native entry receipt`) return true;
      const scratch = JSON.parse(read(path.join(root, 'ownership.json'))).creationRoots[0];
      const pane = exitKind === 'codex' ? 'w1:p1' : 'w2:p1';
      return fs.existsSync(path.join(scratch, exitKind, 'native.done.json')) && (screens.get(pane) ?? '').includes('offline UI') &&
        (!delayedCleanup || fs.existsSync(path.join(scratch, exitKind, 'cleanup-blocked')));
    };
    while (!exitReady() || !check()) {
      assert.ok(Date.now() < deadline, `${label}: ${[...screens.values()].join('\n')}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  return { options: { opt: claudeProfile ? { 'claude-profile': profile } : {}, root, scratchRoots, discoveryRoots, candidate: product, evidence, run, node, initRepo, h, until, write, read },
    closed, children, read, evidence, root, terminationObservations };
}

const skip = process.platform !== 'darwin' ? 'entry UI canary uses macOS sandbox-exec' : PTY_SKIP_REASON;
test('release lesson case uses real installed automatic adapters and owned PTYs with offline native stand-ins', { skip }, async t => {
  const f = fixture(t);
  assert.match(await lessonsEntryCase(f.options), /fresh Codex and Claude native UIs with interactive readiness; explicit Claude profile/);
  assert.equal(f.read(path.join(f.options.opt['claude-profile'], 'profile-marker')), 'offline profile');
  assert.equal(fs.existsSync(path.join(f.root, 'claude-runtime')), false);
  assert.deepEqual(f.closed, ['w1', 'w2']);
  const planted = JSON.parse(f.read(path.join(f.evidence, 'lessons-planted.json')));
  for (const kind of ['codex', 'claude']) {
    const receipt = JSON.parse(f.read(path.join(f.evidence, `lessons-${kind}.entry.json`)));
    assert.match(receipt.policy, /entered area \(area\)/);
    assert.ok(receipt.policy.includes(planted.lesson));
    assert.match(f.read(path.join(f.evidence, `lessons-${kind}.screen.txt`)), /offline UI/);
    const completion = JSON.parse(f.read(path.join(f.evidence, `lessons-${kind}.native.done.json`)));
    assert.equal(completion.nativePid, receipt.nativePid);
    assert.equal(completion.signal, 'SIGTERM');
    assert.ok(receipt.cwd !== planted.repo);
  }
  for (const child of f.children) await waitForExit(child);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'producers')), []);
});

for (const exitCode of [0, 1]) for (const exitWithPrompt of [false, true]) {
  test(`uncredentialed Claude ${exitWithPrompt ? 'prompt' : 'banner'} then exit ${exitCode} passes only delivery and start`, { skip }, async t => {
    const f = fixture(t, { claudeProfile: false, exitKind: 'claude', exitCode, exitWithPrompt, delayedCleanup: exitWithPrompt });
    const results = [{ ...cases.fixture, status: 'PASS' }];
    await runCase(results, cases.lessons, () => lessonsEntryCase(f.options));
    assert.equal(results[1].status, 'PASS', results[1].detail);
    assert.equal(gateOutcome(results).ready, true);
    assert.match(results[1].detail, /Claude lesson delivery and native process start only/);
    assert.match(results[1].detail, /interactive readiness unproven/);
    assert.match(results[1].detail, /Codex lesson delivery and interactive readiness proven/);
    assert.match(resultLine(results[1]), /PASS.*LIMITATION:.*interactive readiness unproven/);
    const planted = JSON.parse(f.read(path.join(f.evidence, 'lessons-planted.json')));
    const scratch = JSON.parse(f.read(path.join(f.root, 'ownership.json'))).creationRoots[0];
    for (const kind of ['codex', 'claude']) assertLessonEntry(JSON.parse(f.read(path.join(f.evidence, `lessons-${kind}.entry.json`))), {
      kind, installation: path.join(scratch, 'product'), lesson: planted.lesson,
    });
    const completion = JSON.parse(f.read(path.join(f.evidence, 'lessons-claude.native.done.json')));
    assert.equal(completion.code, exitCode);
    assert.equal(completion.signal, null);
    assert.deepEqual(f.closed, ['w1', 'w2']);
    for (const child of f.children) await waitForExit(child);
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'producers')), []);
  });
}

test('uncredentialed Claude still stops a running native child after delivery proof', { skip }, async t => {
  const f = fixture(t, { claudeProfile: false });
  assert.match(await lessonsEntryCase(f.options), /LIMITATION/);
  assert.equal(JSON.parse(f.read(path.join(f.evidence, 'lessons-claude.native.done.json'))).signal, 'SIGTERM');
  assert.deepEqual(f.closed, ['w1', 'w2']);
  for (const child of f.children) await waitForExit(child);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'producers')), []);
});

test('uncredentialed Claude cannot pass without a native spawn receipt', { skip }, async t => {
  const f = fixture(t, { claudeProfile: false, missingNative: true });
  const results = [{ ...cases.fixture, status: 'PASS' }];
  await runCase(results, cases.lessons, () => lessonsEntryCase(f.options));
  assert.equal(results[1].status, 'FAIL', results[1].detail);
  assert.match(results[1].detail, /entry exited before/);
  assert.equal(fs.existsSync(path.join(f.evidence, 'lessons-claude.entry.json')), false);
  assert.equal(gateOutcome(results).ready, false);
  assert.deepEqual(f.closed, ['w1', 'w2']);
  for (const child of f.children) await waitForExit(child);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'producers')), []);
});

for (const exitWithPrompt of [false, true]) test(`Codex ${exitWithPrompt ? 'prompt' : 'banner'} then exit still fails without a Claude profile`, { skip }, async t => {
  const f = fixture(t, { claudeProfile: false, exitKind: 'codex', exitWithPrompt, delayedCleanup: exitWithPrompt });
  const results = [{ ...cases.fixture, status: 'PASS' }];
  await runCase(results, cases.lessons, () => lessonsEntryCase(f.options));
  assert.equal(results[1].status, 'FAIL');
  assert.match(results[1].detail, /entry exited before interactive readiness/);
  assert.equal(gateOutcome(results).ready, false);
  assert.deepEqual(f.closed, ['w1']);
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

for (const kind of ['codex', 'claude']) for (const exitCode of [0, 1]) {
  test(`${kind} banner then exit ${exitCode} fails the gate and closes its owned session`, { skip }, async t => {
    const f = fixture(t, { exitKind: kind, exitCode });
    const results = [{ ...cases.fixture, status: 'PASS' }];
    await runCase(results, cases.lessons, () => lessonsEntryCase(f.options));
    assert.equal(results[1].status, 'FAIL');
    assert.match(results[1].detail, /entry exited before interactive readiness/);
    assert.equal(gateOutcome(results).ready, false);
    assert.equal(fs.existsSync(path.join(f.root, 'claude-runtime')), false);
    assert.deepEqual(f.closed, kind === 'codex' ? ['w1'] : ['w1', 'w2']);
    const scratch = JSON.parse(f.read(path.join(f.root, 'ownership.json'))).creationRoots[0];
    const planted = JSON.parse(f.read(path.join(f.evidence, 'lessons-planted.json')));
    assertLessonEntry(JSON.parse(f.read(path.join(scratch, kind, 'entry.json'))), {
      kind, installation: path.join(scratch, 'product'), lesson: planted.lesson,
    });
    const completion = JSON.parse(f.read(path.join(f.evidence, `lessons-${kind}.done.json`)));
    assert.equal(completion.code, exitCode);
    assert.equal(completion.signal, null);
    const nativeCompletion = JSON.parse(f.read(path.join(f.evidence, `lessons-${kind}.native.done.json`)));
    assert.equal(nativeCompletion.code, exitCode);
    assert.equal(nativeCompletion.signal, null);
    assert.match(f.read(path.join(f.evidence, `lessons-${kind}.screen.txt`)), /offline UI/);
    for (const child of f.children) await waitForExit(child);
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'producers')), []);
  });
}

for (const kind of ['codex', 'claude']) for (const exitCode of [0, 1]) test(`${kind} prompt then exit ${exitCode} fails while adapter cleanup is blocked`, { skip }, async t => {
  const f = fixture(t, { exitKind: kind, exitCode, exitWithPrompt: true, delayedCleanup: true });
  const results = [{ ...cases.fixture, status: 'PASS' }];
  await runCase(results, cases.lessons, () => lessonsEntryCase(f.options));
  assert.equal(results[1].status, 'FAIL');
  assert.match(results[1].detail, /entry exited before interactive readiness/);
  assert.equal(gateOutcome(results).ready, false);
  assert.equal(fs.existsSync(path.join(f.root, 'claude-runtime')), false);
  assert.deepEqual(f.terminationObservations[0], { cleanupBlocked: true, adapterDone: false });
  const completion = JSON.parse(f.read(path.join(f.evidence, `lessons-${kind}.native.done.json`)));
  assert.equal(completion.code, exitCode);
  assert.equal(completion.signal, null);
  assert.equal(nativeUiReady(kind, f.read(path.join(f.evidence, `lessons-${kind}.screen.txt`))), true);
  assert.deepEqual(f.closed, kind === 'codex' ? ['w1'] : ['w1', 'w2']);
  for (const child of f.children) await waitForExit(child);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'producers')), []);
});
