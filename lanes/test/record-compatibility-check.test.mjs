import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyProduct } from '../../lib/product-files.mjs';
import { RUNNER_ENVIRONMENT } from '../exact-validation.mjs';
import { makeFixture, ignoreLaneState, git, openLane, commitFile, lane, writeExecutable } from './lane-fixture.mjs';

const product = fileURLToPath(new URL('../../', import.meta.url));
const compatibilityTest = 'test/release-record-compatibility.test.mjs';
const directCommand = `node test/helpers/run.mjs ${compatibilityTest}`;

function brainFixture({ exact = false } = {}) {
  const f = makeFixture({ main: 'main', validate: 'selected-gate' });
  try {
    ignoreLaneState(f);
    copyProduct(product, f.repo);
    fs.cpSync(path.join(product, 'test/helpers'), path.join(f.repo, 'test/helpers'), { recursive: true });
    fs.copyFileSync(path.join(product, compatibilityTest), path.join(f.repo, compatibilityTest));
    // The inherited containment policy recognizes this original runner path
    // when giving nested suites their own process group. Keep that entrypoint.
    fs.writeFileSync(path.join(f.repo, 'test/helpers/run.mjs'),
      `import ${JSON.stringify(new URL('../../test/helpers/run.mjs', import.meta.url).href)};\n`);
    // The unmodified real file reads historical source objects with git show.
    // Only immutable objects are shared; refs, index and worktrees stay scratch.
    const common = git(product, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    fs.writeFileSync(path.join(f.repo, '.git/objects/info/alternates'), path.join(common, 'objects') + '\n');
    fs.symlinkSync(process.execPath, path.join(f.bin, 'node'));
    writeExecutable(f, 'selected-gate', "printf 'selected gate\\n'");
    if (exact) {
      // Select only required evidence: the real file runs only if check adds it.
      fs.writeFileSync(path.join(f.repo, 'planner.mjs'), `
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.argv[2] === '--plan') {
  const files = JSON.parse(process.argv[5]);
  for (const file of files) if (!fs.existsSync(file)) throw Error('missing required file: ' + file);
  console.log(JSON.stringify({ files }));
} else {
  const run = spawnSync(process.execPath, ['test/helpers/run.mjs', ...JSON.parse(process.argv[3])], { stdio: 'inherit' });
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
}
`);
      fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({
        promotion: 'selected-gate', promotion_tests: 'planner.mjs',
      }));
      fs.writeFileSync(path.join(f.repo, '.validation-receipts.json'), JSON.stringify({
        schema: 'validation-receipts/v1', exclude: [],
        environment: Object.keys(f.env).filter(key => !RUNNER_ENVIRONMENT.includes(key) &&
          !/^HERDR_(PANE|TAB|WORKSPACE)_ID$/.test(key)),
      }));
    }
    git(f.repo, ['add', '.']);
    git(f.repo, ['commit', '-qm', 'Real Brain compatibility fixture']);
    return f;
  } catch (error) { f.cleanup(); throw error; }
}

function check(f, workspace, label, args = ['--cmd', 'exit 0']) {
  const run = lane(f, ['check', ...args], { cwd: workspace });
  assert.ok(fs.existsSync(path.join(workspace, '.lane/gate.json')), run.stdout + run.stderr);
  const bytes = fs.readFileSync(path.join(workspace, '.lane/gate.json'));
  const gate = JSON.parse(bytes);
  assert.equal(gate.head, git(workspace, ['rev-parse', 'HEAD']));
  assert.equal(gate.exit_code, run.status, run.stdout + run.stderr);
  assert.equal(gate.executed, true);
  // Retain nested red/green receipts before scratch cleanup when requested.
  const evidence = process.env.RECORD_COMPATIBILITY_CHECK_EVIDENCE;
  if (evidence) {
    const directory = path.join(evidence, label);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'gate.json'), bytes);
    fs.writeFileSync(path.join(directory, 'output.txt'), run.stdout + run.stderr);
    const common = path.join(f.repo, '.git/lane-validation');
    fs.cpSync(common, path.join(directory, 'lane-validation'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'paths.json'), JSON.stringify({ original: common,
      preserved: path.join(directory, 'lane-validation') }, null, 2) + '\n');
  }
  console.log(`compatibility control ${label}: exit=${run.status} TAP=${JSON.stringify(gate.tap_totals)}`);
  return { run, gate };
}

function completeFile(gate, fail = false) {
  assert.equal(gate.tap_totals.length, 1, 'the complete real file runs exactly once');
  const totals = gate.tap_totals[0];
  assert.equal(totals.tests, 14);
  assert.equal(totals.skipped, 0);
  assert.equal(totals.cancelled, 0);
  if (fail) assert.ok(totals.fail > 0);
  else { assert.equal(totals.pass, 14); assert.equal(totals.fail, 0); }
}

test('check runs the real compatibility file for both pinned sources, with failure and recovery', () => {
  const f = brainFixture();
  try {
    for (const [index, source] of ['lib/state.mjs', 'lib/obligations.mjs'].entries()) {
      const workspace = openLane(f, `shape-${index}`);
      const original = fs.readFileSync(path.join(workspace, source), 'utf8');
      commitFile(workspace, source, original + '\n// source revision\n', 'Change pinned source');
      const { run, gate } = check(f, workspace, `shape-${index}`);
      assert.match(gate.command, /test\/release-record-compatibility\.test\.mjs/);
      assert.equal(run.status, index === 0 ? 0 : 1, run.stdout + run.stderr);
      completeFile(gate, index === 1);
      if (index === 1) {
        assert.match(run.stdout + run.stderr, /obligation fold for report.available/);
        commitFile(workspace, source, original, 'Restore registered helper');
        const state = fs.readFileSync(path.join(workspace, 'lib/state.mjs'), 'utf8');
        commitFile(workspace, 'lib/state.mjs', state + '\n// recovered shape\n', 'Keep affected state shape');
        const recovered = check(f, workspace, 'recovery', []);
        assert.equal(recovered.run.status, 0, recovered.run.stdout + recovered.run.stderr);
        assert.match(recovered.run.stdout, /selected gate/);
        completeFile(recovered.gate);
      }
    }
    const unrelated = openLane(f, 'unrelated');
    commitFile(unrelated, 'shared.txt', 'unrelated\n', 'Unrelated source');
    const selected = check(f, unrelated, 'unrelated', []);
    assert.equal(selected.run.status, 0, selected.run.stdout + selected.run.stderr);
    assert.equal(selected.gate.command, 'selected-gate');
    assert.equal(selected.gate.tap_totals, null);
  } finally { f.cleanup(); }
});

test('direct unfiltered compatibility run is not appended, while a name filter cannot hide the backstop', () => {
  const f = brainFixture();
  try {
    const workspace = openLane(f, 'direct');
    const state = fs.readFileSync(path.join(workspace, 'lib/state.mjs'), 'utf8');
    commitFile(workspace, 'lib/state.mjs', state + '\n// direct control\n', 'Change state shape');
    const direct = check(f, workspace, 'direct', ['--cmd', directCommand]);
    assert.equal(direct.run.status, 0, direct.run.stdout + direct.run.stderr);
    assert.equal(direct.gate.command, directCommand);
    completeFile(direct.gate);

    // Filter every selected name on an unregistered helper: only the appended
    // unfiltered real file can expose the failure.
    const helper = fs.readFileSync(path.join(workspace, 'lib/obligations.mjs'), 'utf8');
    commitFile(workspace, 'lib/obligations.mjs', helper + '\n// unregistered helper\n', 'Change helper bytes');
    const command = `node test/helpers/run.mjs --test-name-pattern=NO_MATCHING_COMPATIBILITY_TEST ${compatibilityTest}`;
    const filtered = check(f, workspace, 'name-filter', ['--cmd', command]);
    assert.equal(filtered.run.status, 1, filtered.run.stdout + filtered.run.stderr);
    assert.notEqual(filtered.gate.command, command);
    assert.equal(filtered.gate.tap_totals.length, 2);
    assert.equal(filtered.gate.tap_totals[0].skipped, 14);
    completeFile({ tap_totals: filtered.gate.tap_totals.slice(1) }, true);
  } finally { f.cleanup(); }
});

test('exact gate adds the real compatibility file to its required plan', () => {
  const f = brainFixture({ exact: true });
  try {
    const workspace = openLane(f, 'exact');
    const state = fs.readFileSync(path.join(workspace, 'lib/state.mjs'), 'utf8');
    commitFile(workspace, 'lib/state.mjs', state + '\n// exact control\n', 'Change state shape');
    const exact = check(f, workspace, 'exact', ['--gate']);
    assert.equal(exact.run.status, 0, exact.run.stdout + exact.run.stderr);
    assert.match(exact.run.stdout, /EXACT key=/);
    assert.match(exact.gate.command, /release-record-compatibility\.test\.mjs/);
    assert.deepEqual(exact.gate.exact.identity.commands, [exact.gate.command]);
    completeFile(exact.gate);
  } finally { f.cleanup(); }
});

for (const scenario of ['missing-main', 'unrelated-history']) {
  test(`other repositories keep their selected command with ${scenario}`, () => {
    const f = makeFixture({ main: 'main', validate: 'selected-gate' });
    try {
      ignoreLaneState(f);
      writeExecutable(f, 'selected-gate', "printf 'selected gate\\n'");
      const workspace = openLane(f, scenario);
      if (scenario === 'missing-main') git(f.repo, ['branch', '-m', 'main', 'trunk']);
      else {
        git(workspace, ['checkout', '--orphan', 'unrelated']);
        git(workspace, ['commit', '-qm', 'Unrelated root']);
      }
      const selected = check(f, workspace, scenario, []);
      assert.equal(selected.run.status, 0, selected.run.stdout + selected.run.stderr);
      assert.equal(selected.gate.command, 'selected-gate');
      assert.equal(selected.gate.tap_totals, null);
    } finally { f.cleanup(); }
  });
}
