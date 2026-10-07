#!/usr/bin/env node
import { handlePermission } from './permission-hooks.mjs';
import { permissionOutput, DENIAL_NUDGE } from '../brain/lib/permission-policy.mjs';
let body = '';
try {
  for await (const chunk of process.stdin) {
    body += chunk;
    if (Buffer.byteLength(body) > 65536) throw Error('permission input exceeds bound');
  }
  let event = {};
  try { event = JSON.parse(body); } catch { /* Audited malformed denial. */ }
  const result = await handlePermission(event, JSON.parse(process.env.MONITOR_PERMISSION_BINDING));
  process.stdout.write(JSON.stringify(result.output) + '\n');
  await result.notify?.();
} catch (error) {
  process.stdout.write(JSON.stringify(permissionOutput({ behavior: 'deny', message: DENIAL_NUDGE })) + '\n');
}
