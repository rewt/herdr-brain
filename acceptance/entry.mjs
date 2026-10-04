import assert from 'node:assert/strict';
import path from 'node:path';

// Capture only the policy the candidate actually supplied at the native boundary.
export function nativeEntryReceipt(kind, args, installation, cwd) {
  const instruction = kind === 'codex' ? args.find(a => a.startsWith('developer_instructions='))
    : args[args.indexOf('--append-system-prompt') + 1];
  const policy = kind === 'codex' ? (instruction ? JSON.parse(instruction.slice('developer_instructions='.length)) : undefined)
    : (args.includes('--append-system-prompt') ? instruction : undefined);
  return { kind, source: path.join(installation, 'discovery/policy.mjs'), policy, args, cwd };
}

export function assertLessonEntry(receipt, { kind, installation, lesson }) {
  assert.equal(receipt.kind, kind);
  assert.equal(receipt.source, path.join(installation, 'discovery/policy.mjs'));
  assert.ok(receipt.nativePid > 1, 'fresh native session did not launch');
  assert.ok(!receipt.args.some(arg => ['--help', '--version', 'resume', '--resume', '--continue', 'exec', '--print'].includes(arg)), 'receipt must belong to a fresh interactive session');
  const delivered = nativeEntryReceipt(kind, receipt.args, installation, receipt.cwd);
  assert.equal(receipt.policy, delivered.policy, 'receipt must retain actual native arguments');
  assert.ok(receipt.policy?.includes(receipt.source), 'installed entry source missing');
  assert.match(receipt.policy, /Active lessons for this project and entered area/);
  assert.ok(receipt.policy.includes(lesson), 'planted active lesson absent at native entry');
}

// Shared by release/discovery probes and offline installed-entry regression. Watch is
// armed by dispatch; supervisor entry supplies the cold start and notice path.
export function assertSupervisorEntry(policy) {
  assert.match(policy, /dispatch.*ITEM/);
  assert.match(policy, /Only a supervisor/);
  assert.match(policy, /supervisor\/supervisor\.mjs/);
  assert.match(policy, /Cold start \(no model, no pane mutations\):\nSupervisor cold start/);
  assert.match(policy, /Running \(record; no live pane inference\) \(\d+\)/);
  assert.match(policy, /Reports and settlement \(\d+\)/);
  assert.match(policy, /Waiting on operator \(\d+\)/);
  assert.match(policy, /Next \(\d+\)/);
  assert.match(policy, /Every final `\[org-report\]` notice takes one path/);
  assert.match(policy, /handle --notice 'THE COMPLETE NOTICE' --role supervisor/);
  assert.match(policy, /invokes settle/);
  assert.match(policy, /promote RUN --why/);
  assert.match(policy, /\[promote-queue\]/);
}
