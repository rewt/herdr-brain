// One-shot ENG-555 inventory. Read pinned Git objects, never the new selector.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from '../../lib/cli-help.mjs';
import { releasePhases } from './release-suites.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const SOURCE_COMMIT = '876f08b45a07ebfd01c4d9a8ab96203f0f45d674';
export const MONOLITH = 'dispatch/test/dispatch.test.mjs';
export const DISPATCH_FILES = ['admission', 'options', 'recovery', 'session'].map(name => `dispatch/test/dispatch-${name}.test.mjs`);
export const SMOKE_FILES = ['compat', 'contracts-conformance', 'flow', 'formats', 'main-module', 'processes', 'report', 'tier-plan'].map(name => `test/${name}.test.mjs`);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
const readGit = (commit, file) => git(['show', `${commit}:${file}`]);
export function checkFiles(files) {
  assert.ok(Array.isArray(files) && files.every(file => typeof file === 'string' && /^[\w./-]+\.test\.mjs$/.test(file) && !path.isAbsolute(file) && !file.split('/').includes('..')), 'invalid bootstrap test paths');
  assert.equal(new Set(files).size, files.length, 'duplicate bootstrap test paths');
  return files;
}
export function replaceDispatch(files) {
  return [...new Set(files.flatMap(file => file === MONOLITH ? DISPATCH_FILES : [file]))].sort();
}
export function reconcileDispatch(before, after) {
  const sorted = rows => [...rows].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const rows = Object.values(after).flat();
  assert.equal(before.length, 100, 'expected 100 original dispatch registrations');
  assert.equal(new Set(before.map(row => row.name)).size, 100);
  assert.equal(new Set(rows.map(row => row.name)).size, 100);
  assert.deepEqual(sorted(rows), sorted(before), 'dispatch names or callback bodies changed');
  return { registered_names: rows.length, registrations_sha256: sha256(JSON.stringify(sorted(rows))),
    groups: Object.fromEntries(Object.entries(after).map(([file, entries]) => [file, entries.length])), registrations: sorted(before) };
}

// Registration only: imports of product/fixture modules are inert, and test()
// records the function text without invoking it. No native fixture is started.
export async function collectDispatch(read, commit, file) {
  assert.ok(vm.SourceTextModule, 'regenerate with node --experimental-vm-modules');
  const rows = [], modules = new Map();
  const test = (name, options, callback) => rows.push({ name, body_sha256: sha256(String(typeof options === 'function' ? options : callback)) });
  const entry = new vm.SourceTextModule(read(commit, file), {
    identifier: pathToFileURL(path.join(root, file)).href,
    initializeImportMeta(meta, module) { meta.url = module.identifier; },
  });
  await entry.link(async specifier => {
    if (modules.has(specifier)) return modules.get(specifier);
    let values;
    if (specifier === 'node:fs') values = { default: { readFileSync: () => '' } };
    else if (specifier.startsWith('node:')) values = await import(specifier);
    else if (specifier.endsWith('/bounded-test.mjs')) values = { default: test };
    else {
      const clauses = [...read(commit, file).matchAll(/^import\s+(.+?)\s+from\s+['"]([^'"]+)['"];?$/gm)].filter(match => match[2] === specifier);
      const names = clauses.flatMap(([, clause]) => clause.startsWith('{')
        ? clause.slice(1, -1).split(',').map(name => name.trim().split(/\s+as\s+/)[0]) : ['default']);
      values = Object.fromEntries(names.map(name => [name, undefined]));
    }
    const module = new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    });
    modules.set(specifier, module);
    return module;
  });
  await entry.evaluate({ timeout: 5000 });
  return rows;
}

export async function generateCoverage(inputs, { read = readGit, list = git, collect = collectDispatch } = {}) {
  assert.equal(inputs.source_commit, SOURCE_COMMIT, 'bootstrap base must stay frozen');
  const base = inputs.source_commit, split = inputs.stack_commits['lane/dispatch-test-split'];
  const tier = read(base, 'test/helpers/tier.mjs'), pkg = read(base, 'package.json');
  const literal = tier.match(/const promotion = (\[[\s\S]*?\n\]);/);
  assert.ok(literal, 'old promotion list is missing');
  const promotion = [...literal[1].matchAll(/'([^']+\.test\.mjs)'/g)].map(match => match[1]);
  const slot = list(['ls-tree', '-r', '--name-only', base, '--', 'test-slot/test']).trim().split('\n').filter(file => /^test-slot\/test\/[^/]+\.test\.mjs$/.test(file));
  assert.equal(promotion.length, 78, 'old whole-file promotion count changed');
  assert.equal(slot.length, 16, 'old slot count changed');
  const scripts = JSON.parse(pkg).scripts;
  const witnesses = name => scripts[name].split(/\s+/).filter(word => /^[\w./-]+\.test\.mjs$/.test(word));
  const coverage = { promotion, slot, lane: witnesses('test:promotion:lanes'), logic: witnesses('test:promotion:logic'), smoke: SMOKE_FILES };
  assert.equal(coverage.lane.length, 1); assert.equal(coverage.logic.length, 11);
  const required = inputs.required_tests.flatMap(row => checkFiles(row.files));
  const changed = [...new Set(Object.values(inputs.stack_commits).flatMap(head => list(['diff', '--name-only', '--diff-filter=ACMRT', base, head]).trim().split('\n').filter(file => file.endsWith('.test.mjs'))))].sort();
  const files = checkFiles(replaceDispatch([...Object.values(coverage).flat(), ...required, ...changed, ...inputs.bootstrap_tests]));
  const before = await collect(read, base, MONOLITH), after = {};
  for (const file of DISPATCH_FILES) after[file] = await collect(read, split, file);
  const dispatch = { source_commit: split, ...reconcileDispatch(before, after),
    original_sha256: sha256(read(base, MONOLITH)),
    sources: Object.fromEntries([...DISPATCH_FILES, 'dispatch/test/dispatch-fixture.mjs'].map(file => [file, sha256(read(split, file))])) };
  // Pin the reviewed capacity prerequisite and the existing containment guards.
  const guards = ['test/helpers/release-suites.mjs', 'test/helpers/runner-limits.mjs', 'test/helpers/fixture-policy.mjs', 'test/helpers/processes.mjs',
    'test/helpers/offline-herdr.mjs', 'test/helpers/fixture-lifetime.mjs', 'test/helpers/fixture-lifetime.c', 'test/helpers/bounded-test.mjs', 'lib/deadline.mjs'];
  const capacity = inputs.stack_commits['lane/runner-capacity'];
  const execution = [...guards.map(file => [file, base]), ['test/helpers/run.mjs', capacity], ['test-slot/load.mjs', capacity],
    ['test-slot/run.mjs', base], ['test-slot/test-slot.mjs', capacity]];
  const groups = releasePhases(files);
  return { schema: 'bootstrap-coverage/v1', source_commit: base,
    generation_command: 'node --experimental-vm-modules test/helpers/bootstrap-coverage.mjs', inputs_sha256: sha256(JSON.stringify(inputs)),
    source_sha256: { tier: sha256(tier), package: sha256(pkg) }, stack_commits: inputs.stack_commits,
    coverage, required_tests: inputs.required_tests.map(({ source, sha256: digest, files: rows }) => ({ source, sha256: digest, file_count: rows.length })),
    changed_tests: changed, bootstrap_tests: inputs.bootstrap_tests, dispatch,
    execution_sources: Object.fromEntries(execution.map(([file, commit]) => [file, { commit, sha256: sha256(read(commit, file)) }])),
    file_count: files.length, files_sha256: sha256(JSON.stringify(files)), files, groups_sha256: sha256(JSON.stringify(groups)), groups };
}

export async function main(argv = process.argv.slice(2)) {
  assert.ok(argv.length === 0 || (argv.length === 1 && argv[0] === '--stdout'), 'expected no arguments or --stdout');
  const inputs = JSON.parse(fs.readFileSync(new URL('./bootstrap-inputs.json', import.meta.url), 'utf8'));
  const output = JSON.stringify(await generateCoverage(inputs), null, 2) + '\n';
  if (argv[0] === '--stdout') process.stdout.write(output);
  else {
    fs.writeFileSync(new URL('./bootstrap-coverage.json', import.meta.url), output);
    console.log(`Frozen ${JSON.parse(output).file_count} files from ${inputs.source_commit}; manifest sha256 ${sha256(output)}`);
  }
}
if (isMain(import.meta.url)) await main();
