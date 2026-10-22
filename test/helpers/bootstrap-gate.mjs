// Request-scoped bootstrap only. The train runs its exported P after this F \ P.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isMain } from '../../lib/cli-help.mjs';
import { releasePhases } from './release-suites.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const RUNNER_OPTIONS = ['--file-timeout=480000', '--suite-timeout=540000'];
export function trainSelection(env = process.env) {
  // plannedCommand exports nothing when the captured plan has no append step.
  return JSON.parse(env.MONITOR_PROMOTION_TEST_FILES ?? '[]');
}
export function requireNoRetries(env = process.env) {
  // The appended --run uses release-suites' existing retrying slot adapter.
  // Reserve no retry budget in the train's environment, including its sibling
  // append step; setting this only inside the recipe subshell is insufficient.
  assert.equal(env.MONITOR_TEST_SLOT_TIMEOUT_RETRIED, '1', 'start the bootstrap train with MONITOR_TEST_SLOT_TIMEOUT_RETRIED=1 to disable appended-suite retries');
}
function uniquePaths(files) {
  assert.ok(Array.isArray(files) && files.every(file => typeof file === 'string' && /^[\w./-]+\.test\.mjs$/.test(file) && !path.isAbsolute(file) && !file.split('/').includes('..')), 'invalid bootstrap file list');
  assert.equal(new Set(files).size, files.length, 'bootstrap files must be unique');
}
export function planBootstrap(files, selected) {
  uniquePaths(files); uniquePaths(selected);
  assert.ok(files.length, 'empty bootstrap manifest');
  const frozen = new Set(files), appended = new Set(selected);
  assert.ok(selected.every(file => frozen.has(file)), `train selection outside frozen manifest: ${selected.filter(file => !frozen.has(file)).join(', ')}`);
  const own = files.filter(file => !appended.has(file));
  return { groups: own.length ? releasePhases(own) : [], selected: [...selected], files: own };
}
export function verifyManifest(text, digest, read = file => fs.readFileSync(path.join(root, file))) {
  assert.match(digest ?? '', /^[0-9a-f]{64}$/, 'supply the reviewed manifest digest');
  assert.equal(sha256(text), digest, 'bootstrap manifest digest changed');
  const manifest = JSON.parse(text);
  assert.equal(manifest.schema, 'bootstrap-coverage/v1');
  uniquePaths(manifest.files);
  assert.equal(manifest.file_count, manifest.files.length);
  assert.equal(manifest.files_sha256, sha256(JSON.stringify(manifest.files)));
  assert.deepEqual(manifest.groups, releasePhases(manifest.files), 'frozen bootstrap grouping changed');
  assert.equal(manifest.groups_sha256, sha256(JSON.stringify(manifest.groups)));
  for (const [file, expected] of Object.entries({ ...Object.fromEntries(Object.entries(manifest.execution_sources).map(([file, row]) => [file, row.sha256])), ...manifest.dispatch.sources })) {
    assert.equal(sha256(read(file)), expected, `bootstrap execution source changed: ${file}`);
  }
  return manifest;
}

export function failingFiles(output, files) {
  const diagnostics = output.split('\n').filter(line => /location:|File:|Files:|not ok /.test(line));
  return files.filter(file => diagnostics.some(line => line.includes(file)));
}
export function executeGroup(files) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, 'test/helpers/run.mjs'), ...RUNNER_OPTIONS, ...files], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error;
    for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on('data', chunk => { output += chunk; destination.write(chunk); });
    child.once('error', caught => { error = caught.message; });
    child.once('close', (status, signal) => resolve({ status: status ?? 1, signal, error, output }));
  });
}
export async function runBootstrap({ files, selected, execute = executeGroup, log = console.log, error = console.error }) {
  const plan = planBootstrap(files, selected);
  const passed = [], red = [], pending = plan.groups.flatMap(([, rows]) => rows);
  log(`Bootstrap: ${files.length} manifest files; ${plan.files.length} recipe files in ${plan.groups.length} sequential groups; ${selected.length} train-appended files`);
  for (const file of selected) log(`TRAIN PENDING: ${file}`);
  let exitCode = 0, failed = [];
  for (const [name, rows] of plan.groups) {
    log(`Bootstrap group ${name}: ${rows.join(', ')}`);
    let result;
    try { result = await execute(rows); }
    catch (caught) { result = { status: 1, error: caught.message }; }
    pending.splice(0, rows.length);
    if (result.status !== 0 || result.signal || result.error) {
      exitCode = result.status || 1; red.push(...rows);
      failed = failingFiles(result.output ?? '', rows);
      if (failed.length) for (const file of failed) error(`FAILED FILE: ${file}`);
      else error(`FAILED GROUP (file not localized): ${rows.join(', ')}`);
      if (result.error || result.signal) error(result.error ?? `signal ${result.signal}`);
      break;
    }
    passed.push(...rows);
  }
  const summary = { manifest: files.length, passed, red_group: red, failing_files: failed, not_run: pending, train_pending: selected };
  assert.deepEqual([...passed, ...red, ...pending, ...selected].sort(), [...files].sort(), 'bootstrap accounting lost or repeated a file');
  log(`Bootstrap summary: ${JSON.stringify(summary)}`);
  return { exitCode, ...summary };
}

export async function main(argv = process.argv.slice(2)) {
  assert.equal(process.version, 'v20.19.4', 'bootstrap requires Node v20.19.4');
  assert.equal(argv.length, 2, 'supply --manifest-sha256 and --recipe-sha256');
  assert.match(argv[0], /^--manifest-sha256=[0-9a-f]{64}$/);
  assert.match(argv[1], /^--recipe-sha256=[0-9a-f]{64}$/);
  assert.equal(sha256(fs.readFileSync(fileURLToPath(import.meta.url))), argv[1].split('=')[1], 'bootstrap recipe digest changed');
  requireNoRetries();
  const manifest = verifyManifest(fs.readFileSync(new URL('./bootstrap-coverage.json', import.meta.url), 'utf8'), argv[0].split('=')[1]);
  const selected = trainSelection();
  planBootstrap(manifest.files, selected); // Refuse unexpected P before starting any file.
  for (const file of manifest.files) assert.ok(fs.statSync(path.join(root, file)).isFile(), `missing bootstrap file: ${file}`);
  process.exitCode = (await runBootstrap({ files: manifest.files, selected })).exitCode;
}
if (isMain(import.meta.url)) await main();
