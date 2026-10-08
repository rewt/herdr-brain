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
    const emitted = process.send ? new Promise(resolve => {
      process.once('message', message => resolve(message?.emitted === true));
      process.once('disconnect', () => resolve(false));
    }) : null;
    const { handlePermission } = await import('./permission-hooks.mjs');
    let body = '';
    for await (const chunk of process.stdin) body += chunk;
    let event = {}, binding = null;
    try { event = JSON.parse(body); } catch { /* Audited malformed denial. */ }
    try { binding = JSON.parse(process.env.MONITOR_PERMISSION_BINDING); } catch { /* Audited unbound denial. */ }
    const result = await handlePermission(event, binding, {
      deadline: Number(process.argv[3]), deferApproval: true,
      startAlert: notification => {
        try {
          const child = spawn(process.execPath, [fileURLToPath(new URL('./permission-alert.mjs', import.meta.url)), JSON.stringify(notification)], {
            detached: true, stdio: 'ignore', shell: false,
          });
          child.on('error', () => {});
          child.unref();
        } catch { /* An alert failure cannot change or repeat the denial. */ }
      },
    });
    process.stdout.write(JSON.stringify({ output: result.output, receipt: result.receipt }) + '\n');
    if (result.receipt && await emitted) {
      const { confirmPermissionApproval } = await import('../brain/lib/permission-audit.mjs');
      confirmPermissionApproval(result.receipt, { deadline: Number(process.argv[3]) });
    }
  } catch (error) {
    process.stderr.write(`Steward permission hook failed: ${error.message}. ${DENIAL_NUDGE}\n`);
    process.exitCode = 2;
  } finally { if (process.connected) process.disconnect(); }
} else {
  // Synchronous filesystem/lock work cannot block this watchdog's event loop.
  // One absolute, unscaled budget covers input, imports, locks, recovery and Git.
  const deadline = Date.now() + 8000;
  let worker, finished = false, body = '';
  const timer = setTimeout(() => fail('permission decision deadline reached'), 8000);
  function finish(output, receipt, code = 0) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (!receipt) worker?.kill('SIGKILL');
    process.stdout.write(JSON.stringify(output) + '\n', error => {
      if (error || !receipt) { worker?.kill('SIGKILL'); process.exit(error ? 2 : code); }
      // The allow is already emitted. A bounded acknowledgement can confirm
      // its pending audit, and can never turn a watchdog denial into an approval.
      const cleanup = setTimeout(() => { worker.kill('SIGKILL'); process.exit(code); }, 1000);
      worker.once('close', () => { clearTimeout(cleanup); process.exit(code); });
      worker.send({ emitted: true }, () => {});
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
    worker = spawn(process.execPath, [hook, '--decision', String(deadline)], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], shell: false });
    let response = '';
    worker.stdout.on('data', chunk => {
      response += chunk;
      if (Buffer.byteLength(response) > 65536) return fail('permission response exceeds bound');
      if (finished || !response.includes('\n')) return;
      if (Date.now() >= deadline) return fail('permission decision deadline reached');
      try {
        const result = JSON.parse(response);
        const behavior = result.output?.hookSpecificOutput?.decision?.behavior;
        if (!['allow', 'deny'].includes(behavior) || (behavior === 'allow' && !result.receipt)) throw Error('invalid permission decision');
        finish(result.output, behavior === 'allow' ? result.receipt : null);
      } catch (error) { fail(error.message); }
    });
    worker.stderr.on('data', chunk => process.stderr.write(chunk));
    worker.on('error', error => fail(error.message));
    worker.stdin.on('error', error => fail(error.message));
    worker.on('close', () => {
      if (finished) return;
      fail('permission decision worker failed');
    });
    worker.stdin.end(body);
  } catch (error) { fail(error.message); }
}
