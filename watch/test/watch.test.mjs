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
