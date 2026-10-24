// Use the train's durable supervisor inbox; its existing delivery owner drains it.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Load the transport only for a notice. Keep its supervisor cycle imports out
// of lane startup, while retaining synchronous durable enqueue and its API.
const enqueue = `import fs from 'node:fs';
import { enqueueSupervisor } from ${JSON.stringify(new URL('../supervisor/prompt-supervisor.mjs', import.meta.url).href)};
process.stdout.write(JSON.stringify(enqueueSupervisor(...JSON.parse(fs.readFileSync(0, 'utf8')))));`;

export const NOTICE_ENV = 'MONITOR_GATE_NOTICE_CONTEXT';
export function silenceNotice(observation, { label, receipt, runId = randomUUID(), env = process.env } = {}) {
  try {
    const context = JSON.parse(env[NOTICE_ENV] ?? '{}');
    const to = context.to ?? env.MONITOR_SUPERVISOR_AGENT ?? 'supervisor-herdr';
    const message = `[test-watch] ${label}: no output for ${observation.silence_s.toFixed(3)}s; test continues${receipt ? `; receipt=${receipt}` : ''}`;
    const options = {
      ...context, id: `test-watch:${createHash('sha256').update(JSON.stringify([receipt ?? null, runId])).digest('hex')}`, waitSeconds: 0, title: 'Test run silence observation',
      shadowEvidence: { channel: 'test-watch', validated: true },
    };
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', enqueue], {
      encoding: 'utf8', input: JSON.stringify([to, message, options]),
    });
    if (result.error || result.signal || result.status !== 0)
      throw Error(result.error?.message ?? (result.stderr.trim() || `notice enqueue exited ${result.status ?? result.signal}`));
    return JSON.parse(result.stdout);
  } catch (error) { return { error: error.message }; }
}
