import test from '../../test/helpers/pending-declared.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { declaredFixture, declaration } from './helpers/declared-fixture.mjs';

// Tools are offline fixture inputs, never product dependencies or downloads.
// The engineer supplies a hash-locked artifact made from an existing tool cache.
test('opaque BCH-shaped Vitest, dependency build, pnpm recipe and Python fixture execute unchanged in declared order', { timeout: 60000 }, t => {
  const artifactFile = process.env.DECLARED_GATES_TEST_ARTIFACT;
  if (!artifactFile) { t.skip('supply DECLARED_GATES_TEST_ARTIFACT for the real offline mixed-runner witness'); return; }
  const runtime = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
  assert.equal(createHash('sha256').update(fs.readFileSync(runtime.artifact)).digest('hex'), runtime.sha256);
  const value = declaration(), pnpm = 'node node_modules/pnpm/bin/pnpm.cjs';
  value.gates = {
    'dependency-build': { command: `${pnpm} exec tsc -p packages/dependency/tsconfig.json`, cwd: '.', covers: ['build:@example/dependency'] },
    'pool-vitest': { command: `${pnpm} exec vitest run tools/pool-action-modules/test/canonical.test.ts --maxWorkers=1 --fileParallelism=false`, cwd: '.', covers: ['tools/pool-action-modules/test/canonical.test.ts'] },
    'pnpm-recipe': { command: `${pnpm} validate:fixture-controls`, cwd: '.', covers: ['recipe:fixture-controls'] },
    'python-fixture': { command: 'python3 tools/example/scripts/test-runtime-no-proof.py', cwd: '.', covers: ['fixture:runtime-no-proof'] },
  };
  value.gate.prepare = [{ run: 'node scripts/prepare.mjs' }];
  const f = declaredFixture(t, { declared: value });
  f.write('runtime.json', JSON.stringify(runtime));
  f.write('scripts/prepare.mjs', `import fs from 'node:fs';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';const r=JSON.parse(fs.readFileSync('runtime.json','utf8'));if(createHash('sha256').update(fs.readFileSync(r.artifact)).digest('hex')!==r.sha256)throw Error('offline artifact changed');execFileSync('tar',['-xf',r.artifact],{stdio:'inherit'});`);
  f.write('package.json', JSON.stringify({ private: true, type: 'module', scripts: { 'validate:fixture-controls': 'node scripts/recipe.mjs' } }));
  f.write('pnpm-lock.yaml', "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n");
  f.write('packages/dependency/value.ts', 'export const answer: number = 42;\n');
  f.write('packages/dependency/tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', outDir: 'dist', skipLibCheck: true, ignoreDeprecations: '6.0' }, files: ['value.ts'] }));
  f.write('tools/pool-action-modules/test/canonical.test.ts', `import {test,expect} from 'vitest';import fs from 'node:fs';import {answer} from '../../../packages/dependency/dist/value.js';test('whole-file positive and negative controls',()=>{expect(answer).toBe(42);expect(()=>{if(answer!==41)throw Error('negative fixture');}).toThrow('negative fixture');fs.appendFileSync(process.env.CHECK_LOG!,'vitest controls\\n');});`);
  f.write('scripts/recipe.mjs', "import fs from 'node:fs';import assert from 'node:assert/strict';import {answer} from '../packages/dependency/dist/value.js';assert.equal(answer,42);assert.throws(()=>assert.equal(answer,41));fs.appendFileSync(process.env.CHECK_LOG,'pnpm controls\\n');");
  f.write('tools/example/scripts/fixture_support.py', "def validate(value):\n    if value != 'valid':\n        raise ValueError('negative fixture')\n    return True\n");
  f.write('tools/example/scripts/test-runtime-no-proof.py', "import os,tempfile\nfrom fixture_support import validate\nwith tempfile.TemporaryDirectory() as fixture:\n    assert os.path.isdir(fixture)\n    assert validate('valid')\n    try:\n        validate('invalid')\n        raise AssertionError('negative control did not fire')\n    except ValueError:\n        pass\n    with open(os.environ['CHECK_LOG'],'a') as log:\n        log.write('python controls\\n')\n");
  f.write('inventory.mjs', `export const extra=${JSON.stringify(Object.keys(value.gates))};\n`);
  f.commit(); f.git(['rebase', 'main'], f.workspace);
  const execution = f.plan({ required: Object.keys(value.gates).map(gate => ({ gate })) }), gate = f.execute(execution);
  assert.equal(gate.exit_code, 0, JSON.stringify(gate));
  assert.deepEqual(gate.command_order, [value.promotion, ...Object.values(value.gates).map(row => row.command)]);
  assert.deepEqual(gate.gates.map(row => row.outcome), Array(5).fill('executed'));
  assert.deepEqual(f.lines(), ['baseline', 'vitest controls', 'pnpm controls', 'python controls']);
  assert.ok(fs.existsSync(f.workspace + '/packages/dependency/dist/value.js'));
  const vitest = gate.gates.find(row => row.id === 'pool-vitest'); assert.match(fs.readFileSync(vitest.execution.log, 'utf8'), /1 passed/);
  for (const row of gate.gates) assert.ok(fs.existsSync(row.execution.execution_receipt));
  // A real runner failure is red and prevents the recipe and fixture drivers.
  f.write('tools/pool-action-modules/test/canonical.test.ts', "import {test,expect} from 'vitest';test('negative whole-file witness',()=>expect(1).toBe(2));", f.workspace); f.commit(f.workspace);
  const red = f.execute(f.plan({ required: Object.keys(value.gates).map(gate => ({ gate })) }));
  assert.notEqual(red.exit_code, 0); assert.deepEqual(red.gates.map(row => row.outcome), ['executed', 'executed', 'failed', 'not reached', 'not reached']);
});
