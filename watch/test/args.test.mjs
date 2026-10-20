import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from '../../test/helpers/bounded-test.mjs';
import { seedOwnedRun } from '../../test/helpers/run-claim.mjs';
import { createReceiptTracker } from '../../test/helpers/receipts.mjs';
import { seedSpawnRun } from './record-fixture.mjs';

const WATCH = fileURLToPath(new URL('../watch.mjs', import.meta.url));
async function exited(pid, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    if (Date.now() > deadline) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

for (const scenario of ['supplied', 'repeated', 'discovered']) {
  test(`spawn freezes ${scenario} bindings once and preserves the other arguments`, t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-args-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'checkout'), org = path.join(root, '.org');
    fs.mkdirSync(cwd);
    seedSpawnRun(org, cwd);
    const bindings = scenario === 'supplied'
      ? ['--org', './.org', '--to', 'named-supervisor', '--cwd', './checkout']
      : scenario === 'repeated'
        ? ['--org=./old-org', '--to', 'old-supervisor', '--cwd=./old-checkout',
          '--org', './.org', '--to=named-supervisor', '--cwd', './checkout']
        : [];
    const recipient = scenario === 'discovered' ? 'adapter-supervisor' : 'named-supervisor';
    const extra = ['--workspace', 'fixture-workspace', '--report=--spawn', '--log=--detach'];
    const result = spawnSync(process.execPath, [WATCH, 'R-6', ...bindings, ...extra, '--spawn', '--dry-run'], {
      cwd: root, encoding: 'utf8', env: { ...process.env,
        ORG_DIR: './.org', MONITOR_SUPERVISOR_AGENT: 'adapter-supervisor',
        HERDR_MONITOR_FLEET: path.join(root, 'fleet.json') },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const expected = scenario === 'discovered'
      ? ['R-6', ...extra, '--dry-run', '--org', org, '--cwd', root, '--to', recipient]
      : ['R-6', '--org', org, '--to', recipient, '--cwd', cwd, ...extra, '--dry-run'];
    const command = [process.execPath, WATCH, ...expected, '--close-tab-on-exit'].map(quote).join(' ');
    assert.ok(result.stdout.trimEnd().endsWith(`and run ${command}`), result.stdout);
  });
}

for (const scenario of ['supplied', 'repeated', 'discovered']) {
  test(`detach carries ${scenario} bindings once into the real child`, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-detach-args-')));
    const receipts = createReceiptTracker();
    t.after(() => { receipts.cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
    const cwd = path.join(root, 'checkout'), org = path.join(root, '.org');
    seedOwnedRun(org, 'R-6');
    const capture = path.join(root, 'capture.mjs'), argvFile = path.join(root, 'argv.json');
    const orgCli = path.join(root, 'record'), log = path.join(root, 'watch.log');
    fs.mkdirSync(cwd);
    // The real child acknowledges its lock/configuration and then stops on an
    // abandoned run, without any delivery or native Herdr calls.
    fs.writeFileSync(orgCli, `#!${process.execPath}\nconsole.log(JSON.stringify({item:'ENG-9',meta:{agent:'fixture'},report_path:'unused',abandoned:true}));\n`, { mode: 0o755 });
    fs.writeFileSync(capture, `import fs from 'node:fs';\nif (process.send && process.argv[1] === ${JSON.stringify(WATCH)}) fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv));\n`);
    const bindings = scenario === 'supplied'
      ? ['--org', './.org', '--to', 'named-supervisor', '--cwd', './checkout']
      : scenario === 'repeated'
        ? ['--org=./old-org', '--to', 'old-supervisor', '--cwd=./old-checkout',
          '--org', './.org', '--to=named-supervisor', '--cwd', './checkout']
        : [];
    const recipient = scenario === 'discovered' ? 'adapter-supervisor' : 'named-supervisor';
    const extra = ['--org-cli', orgCli, '--report=--detach', '--log', log];
    const result = spawnSync(process.execPath, [WATCH, 'R-6', ...bindings, ...extra, '--detach'], {
      cwd: root, encoding: 'utf8', env: { ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${capture}`,
        ORG_DIR: './.org', MONITOR_SUPERVISOR_AGENT: 'adapter-supervisor',
        HERDR_MONITOR_FLEET: path.join(root, 'fleet.json') },
    });
    const expected = [process.execPath, WATCH, ...(scenario === 'discovered'
      ? ['R-6', ...extra, '--org', org, '--cwd', root, '--to', recipient]
      : ['R-6', '--org', org, '--to', recipient, '--cwd', cwd, ...extra])];
    const pid = result.status === 0 ? JSON.parse(result.stdout).pid : undefined;
    if (pid) receipts.remember(pid, expected.join(' '));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, 'utf8')), expected);
    // The child stops by itself on the abandoned run; let it (and its record call) finish rather than
    // killing it mid-call, which leaves the record child behind as a surviving fixture.
    await exited(pid);
  });
}
