#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Keep this emergency response independent of checkout modules: a rebase or
// missing dependency must still close the native dialog with a denial.
const DENIAL_NUDGE = 'Do not work around this denial. Record the question with record ask --category security --recommend no --why "Steward declined the permission request" (under your work item), then continue with other work. Only the operator may authorize a later retry.';
const emergency = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: DENIAL_NUDGE } } };
const hook = fileURLToPath(import.meta.url);

if (process.argv[2] === '--decision') {
  try {
    const { handlePermission } = await import('./permission-hooks.mjs');
    let body = '';
    for await (const chunk of process.stdin) body += chunk;
    let event = {}, binding = null;
    try { event = JSON.parse(body); } catch { /* Audited malformed denial. */ }
    try { binding = JSON.parse(process.env.MONITOR_PERMISSION_BINDING); } catch { /* Audited unbound denial. */ }
    const result = await handlePermission(event, binding, { deadline: Number(process.argv[3]) });
    process.stdout.write(JSON.stringify({ output: result.output, notification: result.notification }) + '\n');
  } catch (error) {
    process.stderr.write(`Steward permission hook failed: ${error.message}. ${DENIAL_NUDGE}\n`);
    process.exitCode = 2;
  }
} else {
  // Synchronous filesystem/lock work cannot block this watchdog's event loop.
  // One absolute, unscaled budget covers input, imports, locks, recovery and Git.
  const deadline = Date.now() + 8000;
  let worker, finished = false, body = '';
  const timer = setTimeout(() => fail('permission decision deadline reached'), 8000);
  function finish(output, notification, code = 0) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    worker?.kill('SIGKILL');
    process.stdout.write(JSON.stringify(output) + '\n', () => {
      if (notification) {
        try {
          const child = spawn(process.execPath, [fileURLToPath(new URL('./permission-alert.mjs', import.meta.url)), JSON.stringify(notification)], {
            detached: true, stdio: 'ignore', shell: false,
          });
          child.on('error', () => {});
          child.unref();
        } catch { /* An alert failure cannot change or repeat the decision. */ }
      }
      process.exit(code);
    });
  }
  function fail(reason) {
    if (finished) return;
    process.stderr.write(`Steward permission hook failed: ${reason}. ${DENIAL_NUDGE}\n`);
    finish(emergency, null, 2);
  }
  try {
    for await (const chunk of process.stdin) {
      body += chunk;
      if (Buffer.byteLength(body) > 65536) throw Error('permission input exceeds bound');
    }
    if (Date.now() >= deadline) throw Error('permission decision deadline reached');
    worker = spawn(process.execPath, [hook, '--decision', String(deadline)], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let response = '';
    worker.stdout.on('data', chunk => {
      response += chunk;
      if (Buffer.byteLength(response) > 65536) fail('permission response exceeds bound');
    });
    worker.stderr.on('data', chunk => process.stderr.write(chunk));
    worker.on('error', error => fail(error.message));
    worker.stdin.on('error', error => fail(error.message));
    worker.on('close', code => {
      if (finished) return;
      if (Date.now() >= deadline) return fail('permission decision deadline reached');
      if (code !== 0) return fail('permission decision worker failed');
      try {
        const result = JSON.parse(response);
        if (!['allow', 'deny'].includes(result.output?.hookSpecificOutput?.decision?.behavior)) throw Error('invalid permission decision');
        finish(result.output, result.notification);
      } catch (error) { fail(error.message); }
    });
    worker.stdin.end(body);
  } catch (error) { fail(error.message); }
}
