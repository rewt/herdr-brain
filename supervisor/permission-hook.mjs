#!/usr/bin/env node
// Keep this emergency response independent of checkout modules: a rebase or
// missing dependency must still close the native dialog with a denial.
const DENIAL_NUDGE = 'Do not work around this denial. Record the question with record ask --category security --recommend no --why "Steward declined the permission request" (under your work item), then continue with other work. Only the operator may authorize a later retry.';
let body = '';
try {
  const { handlePermission } = await import('./permission-hooks.mjs');
  for await (const chunk of process.stdin) {
    body += chunk;
    if (Buffer.byteLength(body) > 65536) throw Error('permission input exceeds bound');
  }
  let event = {};
  try { event = JSON.parse(body); } catch { /* Audited malformed denial. */ }
  let binding = null;
  try { binding = JSON.parse(process.env.MONITOR_PERMISSION_BINDING); } catch { /* Audited unbound denial. */ }
  const result = await handlePermission(event, binding);
  process.stdout.write(JSON.stringify(result.output) + '\n');
  // The decision is already emitted; alert failures cannot emit a second one.
  try { await result.notify?.(); } catch (error) { process.stderr.write(`Steward alert failed: ${error.message}\n`); }
} catch (error) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: DENIAL_NUDGE } } }) + '\n');
  process.stderr.write(`Steward permission hook failed: ${error.message}. ${DENIAL_NUDGE}\n`);
  process.exitCode = 2;
}
