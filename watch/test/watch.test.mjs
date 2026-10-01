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
  const org = path.join(root, 'org');
  const herdr = path.join(root, 'herdr');
  executable(org, `case "$1" in
  show) printf '%s\\n' '{"id":"R-8","item":"ENG-4","meta":{"agent":"lane-eight"},"report_path":"${report}","started":{"at":"2026-10-01T00:00:00.000Z"}}' ;;
  check) printf '%s\\n' 'ok: done · 0 blockers' ;;
  *) exit 2 ;;
esac`);
  executable(herdr, `case "$1 $2" in
  "agent get") printf '%s\\n' '{"result":{"agent":{"agent_status":"working"}}}' ;;
  "agent wait") sleep 10 ;;
  "agent prompt") printf '%s\\n' "$*" >> "${calls}" ;;
  *) exit 2 ;;
esac`);
  const child = spawn(process.execPath, [
    WATCH, 'R-8', '--org', path.join(root, '.org'), '--org-cli', org, '--herdr', herdr, '--to', 'supervisor-test',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(report, `---\nrun: R-8\noutcome: done\nsummary: Report arrived.\nheadline: The report arrived\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(calls, 'utf8'), /\[org-report\] run=R-8 item=ENG-4/);
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
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '%s\\n' '{"result":{"agent":{"agent_status":"blocked"}}}' ;;
  "agent wait") sleep 10 ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-blocked*) "${fixture.writer}" ;; esac ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher([...fixture.args, '--start-grace', '0']));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(fixture.calls, 'utf8'), /\[watch-blocked\].*state=blocked/);
});

test('a still-working worker delivers the long-running notice', async () => {
  const fixture = watcherFixture('R-14');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") printf '%s\\n' '{"result":{"agent":{"agent_status":"working"}}}' ;;
  "agent wait") sleep 10 ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-long-running*) "${fixture.writer}" ;; esac ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher([...fixture.args, '--long-after', '0']));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(fixture.calls, 'utf8'), /\[watch-long-running\].*still-running=/);
});

test('a Herdr outage is delivered after Herdr recovers, never reported as gone', async () => {
  const fixture = watcherFixture('R-15');
  const counter = path.join(fixture.root, 'gets');
  executable(fixture.herdr, `case "$1 $2" in
  "agent get") n=$(($(cat "${counter}" 2>/dev/null || echo 0)+1)); printf '%s' "$n" > "${counter}"; if [ "$n" -eq 1 ]; then printf '%s\\n' '{"error":{"code":"socket_unavailable","message":"server down"}}' >&2; exit 1; fi; printf '%s\\n' '{"result":{"agent":{"agent_status":"working"}}}' ;;
  "agent wait") sleep 10 ;;
  "agent prompt") printf '%s\\n' "$*" >> "${fixture.calls}"; case "$4" in *watch-unavailable*) "${fixture.writer}" ;; esac ;;
  *) exit 2 ;;
esac`);
  const result = await waitForExit(startWatcher(fixture.args));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const calls = fs.readFileSync(fixture.calls, 'utf8');
  assert.match(calls, /\[watch-unavailable\].*socket_unavailable.*server down/);
  assert.doesNotMatch(calls, /\[watch-no-report\]/);
});
