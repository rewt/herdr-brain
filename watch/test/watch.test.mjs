import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  blockedNotice,
  invalidReportNotice,
  longRunningNotice,
  noReportNotice,
  reportNotice,
  unavailableNotice,
} from '../notice.mjs';

const WATCH = fileURLToPath(new URL('../watch.mjs', import.meta.url));

function executable(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function reportText(run, headline = 'The report arrived') {
  return `---\nrun: ${run}\noutcome: done\nsummary: Report arrived.\nheadline: ${headline}\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`;
}

function watcherFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-module-branch-'));
  const report = path.join(root, 'report.md');
  const calls = path.join(root, 'herdr-calls');
  const org = path.join(root, 'org');
  const herdr = path.join(root, 'herdr');
  const writer = path.join(root, 'write-report');
  const started = new Date().toISOString();
  executable(org, `case "$1" in
  show) printf '%s\\n' '{"id":"${run}","item":"ENG-9","meta":{"agent":"lane-nine"},"report_path":"${report}","started":{"at":"${started}"}}' ;;
  check) printf '%s\\n' 'ok: done · 0 blockers' ;;
  *) exit 2 ;;
esac`);
  executable(writer, `printf '%s' '${reportText(run)}' > '${report}'`);
  const args = [
    WATCH, run, '--org', path.join(root, '.org'), '--org-cli', org, '--herdr', herdr,
    '--to', 'supervisor-test', '--retry-after', '0',
  ];
  return { root, report, calls, org, herdr, writer, args };
}

function startWatcher(args) {
  return spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function waitForExit(child, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`watcher did not exit:\n${stdout}${stderr}`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function waitForText(file, pattern, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (pattern.test(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${pattern} in ${file}`);
}

test('every terminal condition has a distinct, compact supervisor notice', () => {
  const common = { run: 'R-7', item: 'ENG-3', agent: 'lane-seven', report: '/tmp/report.md' };
  assert.equal(
    reportNotice({ ...common, outcome: 'done', headline: 'The work landed', check: 'pass' }),
    '[org-report] run=R-7 item=ENG-3 outcome=done headline="The work landed" check=pass report=/tmp/report.md',
  );
  assert.match(invalidReportNotice({ ...common, error: 'outcome is required' }), /^\[watch-invalid-report\].*check=fail.*outcome is required/);
  assert.match(noReportNotice({ ...common, state: 'gone' }), /^\[watch-no-report\].*state=gone/);
  assert.match(blockedNotice(common), /^\[watch-blocked\].*state=blocked/);
  assert.match(longRunningNotice({ ...common, minutes: 60 }), /^\[watch-long-running\].*still-running=60m/);
  assert.match(unavailableNotice({ ...common, error: 'permission denied' }), /^\[watch-unavailable\].*permission denied/);
});

test('spawn resolves the cwd workspace when it is run outside a Herdr pane', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-module-spawn-'));
  const cwd = path.join(root, 'checkout');
  const herdr = path.join(root, 'herdr');
  fs.mkdirSync(cwd);
  executable(herdr, `case "$1 $2" in
  "workspace list") printf '%s\\n' '{"result":{"workspaces":[{"workspace_id":"w-canonical","worktree":{"checkout_path":"${cwd}"}}]}}' ;;
  *) exit 2 ;;
esac`);
  const result = spawnSync(process.execPath, [
    WATCH, 'R-6', '--org', path.join(root, '.org'), '--herdr', herdr,
    '--cwd', cwd, '--spawn', '--dry-run',
  ], { encoding: 'utf8', env: { ...process.env, HERDR_WORKSPACE_ID: '' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /would create tab "watch R-6" in w-canonical/);
});

test('a valid report is checked and delivered without Herdr being present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-module-'));
  const report = path.join(root, 'report.md');
  const calls = path.join(root, 'herdr-calls');
  const org = path.join(root, 'org');
  const herdr = path.join(root, 'herdr');
  fs.writeFileSync(report, `---\nrun: R-7\noutcome: done\nsummary: Work landed.\nheadline: The work landed\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
  executable(org, `case "$1" in
  show) printf '%s\\n' '{"id":"R-7","item":"ENG-3","meta":{"agent":"lane-seven"},"report_path":"${report}","started":{"at":"2026-10-01T00:00:00.000Z"}}' ;;
  check) printf '%s\\n' 'ok: done · 0 blockers' ;;
  *) exit 2 ;;
esac`);
  executable(herdr, `printf '%s\\n' "$*" >> "${calls}"
case "$1 $2" in
  "agent get") printf '%s\\n' '{"result":{"agent":{"agent_status":"done"}}}' ;;
  "agent prompt") printf '%s\\n' '{"result":{"type":"agent_prompt"}}' ;;
  *) exit 2 ;;
esac`);
  const result = spawnSync(process.execPath, [
    WATCH, 'R-7', '--org', path.join(root, '.org'), '--org-cli', org, '--herdr', herdr, '--to', 'supervisor-test',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const sent = fs.readFileSync(calls, 'utf8');
  assert.match(sent, /agent prompt supervisor-test \[org-report\] run=R-7 item=ENG-3 outcome=done/);
  assert.match(sent, /headline="The work landed" check=pass/);
});

test('a report landing wakes the watcher without polling Herdr', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-module-landing-'));
  const report = path.join(root, 'report.md');
  const calls = path.join(root, 'herdr-calls');
  const state = path.join(root, 'worker-state');
  const org = path.join(root, 'org');
  const herdr = path.join(root, 'herdr');
  const started = new Date().toISOString();
  fs.writeFileSync(state, 'working');
  executable(org, `case "$1" in
  show) printf '%s\\n' '{"id":"R-8","item":"ENG-4","meta":{"agent":"lane-eight"},"report_path":"${report}","started":{"at":"${started}"}}' ;;
  check) printf '%s\\n' 'ok: done · 0 blockers' ;;
  *) exit 2 ;;
esac`);
  executable(herdr, `case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait") while [ "$(cat '${state}')" = working ]; do sleep 0.02; done ;;
  "agent prompt") printf '%s\\n' "$*" >> "${calls}" ;;
  *) exit 2 ;;
esac`);
  const child = spawn(process.execPath, [
    WATCH, 'R-8', '--org', path.join(root, '.org'), '--org-cli', org, '--herdr', herdr, '--to', 'supervisor-test',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(report, reportText('R-8', 'Draft report'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterDraft = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  fs.writeFileSync(report, reportText('R-8', 'Final report'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterFinal = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  fs.writeFileSync(state, 'idle');
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.doesNotMatch(afterDraft, /\[org-report\]/, 'a valid report is not delivered while the worker is working');
  assert.doesNotMatch(afterFinal, /\[org-report\]/, 'a rewritten valid report still waits for the worker to stop');
  const sent = fs.readFileSync(calls, 'utf8');
  assert.match(sent, /\[org-report\] run=R-8 item=ENG-4.*headline="Final report"/);
  assert.doesNotMatch(sent, /Draft report/);
});

test('a valid report also waits while the worker state is unknown', async () => {
  const fixture = watcherFixture('R-17');
  const state = path.join(fixture.root, 'worker-state');
  fs.writeFileSync(fixture.report, reportText('R-17'));
  fs.writeFileSync(state, 'unknown');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait") while [ "$(cat '${state}')" = unknown ]; do sleep 0.02; done ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}" ;;
  *) exit 2 ;;
esac`);
  const child = startWatcher(fixture.args);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(fixture.calls), false, 'an unknown worker is not treated as stopped');
  fs.writeFileSync(state, 'idle');
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(fixture.calls, 'utf8'), /\[org-report\] run=R-17/);
});

test('a mismatched report is invalid even when org check passes', async () => {
  const fixture = watcherFixture('R-9');
  fs.writeFileSync(fixture.report, reportText('R-99', 'Stale report'));
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '%s\\n' '{"result":{"agent":{"agent_status":"done"}}}' ;;
  "agent wait") sleep 10 ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-invalid-report*) "${fixture.writer}" ;; esac ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher([...fixture.args, '--start-grace', '0']));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.match(calls, /\[watch-invalid-report\].*report run R-99 does not match watched run R-9/);
  assert.match(calls, /\[org-report\] run=R-9/);
});

test('a vanished worker delivers exited-without-report and stops', async () => {
  const fixture = watcherFixture('R-10');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '%s\\n' '{"error":{"code":"agent_not_found","message":"gone"}}' >&2; exit 1 ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}" ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher([...fixture.args, '--start-grace', '0']));
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(fs.readFileSync(fixture.calls, 'utf8'), /\[watch-no-report\].*state=gone/);
});

test('an initially idle worker is not terminal until it has worked', async () => {
  const fixture = watcherFixture('R-11');
  const counter = path.join(fixture.root, 'gets');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") n=$(($(cat "${counter}" 2>/dev/null || echo 0)+1)); printf '%s' "$n" > "${counter}"; case "$n" in 1) state=idle ;; 2) state=working ;; *) state=idle ;; esac; printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$state" ;;
  "agent wait") exit 0 ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-no-report*) "${fixture.writer}" ;; esac ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher([...fixture.args, '--start-grace', '10']));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.equal((calls.match(/\[watch-no-report\]/g) ?? []).length, 1, calls);
  assert.match(calls, /\[org-report\] run=R-11/);
});

test('idle grace waits for a late report before sending a no-report notice', async () => {
  const fixture = watcherFixture('R-19');
  const state = path.join(fixture.root, 'worker-state');
  const waitStarted = path.join(fixture.root, 'wait-started');
  fs.writeFileSync(state, 'working');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait") printf yes > "${waitStarted}"; case " $* " in
    *" --until working "*) while [ "$(cat '${state}')" != working ]; do sleep 0.02; done ;;
    *) while [ "$(cat '${state}')" = working ]; do sleep 0.02; done ;;
  esac ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}" ;;
  *) exit 2 ;;
esac`);
  const child = startWatcher([...fixture.args, '--idle-grace', '1']);
  await waitForText(waitStarted, /yes/);
  fs.writeFileSync(state, 'idle');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fs.existsSync(fixture.calls), false, 'idle grace suppresses the early no-report notice');
  fs.writeFileSync(fixture.report, reportText('R-19', 'Late final report'));
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.match(calls, /\[org-report\] run=R-19.*headline="Late final report"/);
  assert.doesNotMatch(calls, /\[watch-no-report\]/);
  assert.match(result.stdout, /waiting up to 1s .* report or resume/);
});

test('idle grace does not start before the worker has been seen working', async () => {
  const fixture = watcherFixture('R-20');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '%s\\n' '{"result":{"agent":{"agent_status":"idle"}}}' ;;
  "agent wait") sleep 10 ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-no-report*) "${fixture.writer}" ;; esac ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher([
    ...fixture.args, '--start-grace', '0', '--idle-grace', '10',
  ]));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.match(calls, /\[watch-no-report\].*state=idle/);
  assert.match(calls, /\[org-report\] run=R-20/);
  assert.doesNotMatch(result.stdout, /report or resume before sending a no-report notice/);
});

test('idle grace notices a blocked worker immediately and keeps watching', async (t) => {
  const fixture = watcherFixture('R-21');
  const state = path.join(fixture.root, 'worker-state');
  const waits = path.join(fixture.root, 'waits');
  fs.writeFileSync(state, 'working');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait")
    printf '%s state=%s\\n' "$*" "$(cat '${state}')" >> "${waits}"
    while :; do
      current=$(cat '${state}')
      case " $* " in *" --until $current "*) exit 0 ;; esac
      sleep 0.02
    done ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}" ;;
  *) exit 2 ;;
esac`);
  const child = startWatcher([...fixture.args, '--idle-grace', '10']);
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await waitForText(waits, /state=working/);
  fs.writeFileSync(state, 'idle');
  await waitForText(waits, /state=idle/);
  fs.writeFileSync(state, 'blocked');
  const blockedCalls = await waitForText(fixture.calls, /\[watch-blocked\]/);
  assert.doesNotMatch(blockedCalls, /\[watch-no-report\]|\[org-report\]/);
  assert.equal(child.exitCode, null, 'a blocked worker remains watched');
  fs.writeFileSync(fixture.report, reportText('R-21', 'Finished after grace block'));
  await waitForText(waits, /state=blocked/);
  assert.doesNotMatch(fs.readFileSync(fixture.calls, 'utf8'), /\[org-report\]/,
    'a valid report stays intermediate while the worker is blocked');
  fs.writeFileSync(state, 'idle');
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.equal((calls.match(/\[watch-blocked\]/g) ?? []).length, 1, calls);
  assert.doesNotMatch(calls, /\[watch-no-report\]/);
  assert.match(calls, /\[org-report\] run=R-21.*headline="Finished after grace block"/);
});

test('idle, working, idle without a report delivers both stop notices', async () => {
  const fixture = watcherFixture('R-12');
  const counter = path.join(fixture.root, 'gets');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") n=$(($(cat "${counter}" 2>/dev/null || echo 0)+1)); printf '%s' "$n" > "${counter}"; case "$n" in 2|4) state=idle ;; *) state=working ;; esac; printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$state" ;;
  "agent wait") exit 0 ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-no-report*) n=$(grep -c watch-no-report "${fixture.calls}"); [ "$n" -eq 2 ] && "${fixture.writer}" ;; esac ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher(fixture.args));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.equal((calls.match(/\[watch-no-report\]/g) ?? []).length, 2, calls);
  assert.match(calls, /\[org-report\] run=R-12/);
});

test('a blocked worker delivers its distinct notice', async () => {
  const fixture = watcherFixture('R-13');
  const state = path.join(fixture.root, 'worker-state');
  fs.writeFileSync(state, 'blocked');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait") while [ "$(cat '${state}')" = blocked ]; do sleep 0.02; done ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-blocked*) "${fixture.writer}"; printf '%s' idle > '${state}' ;; esac ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher([...fixture.args, '--start-grace', '0']));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(fixture.calls, 'utf8'), /\[watch-blocked\].*state=blocked/);
});

test('a valid report stays intermediate while blocked and is final only after idle', async () => {
  const fixture = watcherFixture('R-18');
  const state = path.join(fixture.root, 'worker-state');
  fs.writeFileSync(fixture.report, reportText('R-18', 'Finished after unblocking'));
  fs.writeFileSync(state, 'blocked');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait") while [ "$(cat '${state}')" = blocked ]; do sleep 0.02; done ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}" ;;
  *) exit 2 ;;
esac`);
  const child = startWatcher([...fixture.args, '--start-grace', '0']);
  const whileBlocked = await waitForText(fixture.calls, /\[watch-blocked\]/);
  assert.doesNotMatch(whileBlocked, /\[org-report\]/);
  fs.writeFileSync(state, 'idle');
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.ok(calls.indexOf('[watch-blocked]') < calls.indexOf('[org-report]'), calls);
  assert.match(calls, /\[org-report\] run=R-18.*headline="Finished after unblocking"/);
});

test('a failed intermediate delivery notifies the operator and keeps watching for the final report', async () => {
  const fixture = watcherFixture('R-16');
  const state = path.join(fixture.root, 'worker-state');
  fs.writeFileSync(state, 'blocked');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait") sleep 10 ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-blocked*) exit 1 ;; esac ;;
  "notification show") printf '%s\\n' "$*" >> "${fixture.calls}"; "${fixture.writer}"; printf '%s' idle > '${state}' ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher([
    ...fixture.args, '--start-grace', '0', '--delivery-attempts', '1',
  ]));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.match(calls, /agent prompt supervisor-test \[watch-blocked\]/);
  assert.match(calls, /notification show R-16 watch could not deliver/);
  assert.match(calls, /agent prompt supervisor-test \[org-report\] run=R-16/);
});

test('a still-working worker delivers the long-running notice', async () => {
  const fixture = watcherFixture('R-14');
  const state = path.join(fixture.root, 'worker-state');
  fs.writeFileSync(state, 'working');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait") while [ "$(cat '${state}')" = working ]; do sleep 0.02; done ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-long-running*) "${fixture.writer}"; printf '%s' idle > '${state}' ;; esac ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher([...fixture.args, '--long-after', '0']));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.match(calls, /\[watch-long-running\].*still-running=/);
  assert.ok(calls.indexOf('[watch-long-running]') < calls.indexOf('[org-report]'), calls);
});

test('a Herdr outage is delivered after Herdr recovers, never reported as gone', async () => {
  const fixture = watcherFixture('R-15');
  const counter = path.join(fixture.root, 'gets');
  const state = path.join(fixture.root, 'worker-state');
  fs.writeFileSync(state, 'working');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") n=$(($(cat "${counter}" 2>/dev/null || echo 0)+1)); printf '%s' "$n" > "${counter}"; if [ "$n" -eq 1 ]; then printf '%s\\n' '{"error":{"code":"socket_unavailable","message":"server down"}}' >&2; exit 1; fi; printf '{"result":{"agent":{"agent_status":"%s"}}}\\n' "$(cat '${state}')" ;;
  "agent wait") while [ "$(cat '${state}')" = working ]; do sleep 0.02; done ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-unavailable*) "${fixture.writer}"; printf '%s' idle > '${state}' ;; esac ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher(fixture.args));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.match(calls, /\[watch-unavailable\].*socket_unavailable.*server down/);
  assert.doesNotMatch(calls, /\[watch-no-report\]/);
});
