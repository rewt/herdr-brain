// Use the train's durable supervisor inbox; its existing delivery owner drains it.
import { enqueueSupervisor } from '../supervisor/prompt-supervisor.mjs';
import { createHash, randomUUID } from 'node:crypto';

export const NOTICE_ENV = 'MONITOR_GATE_NOTICE_CONTEXT';
export function silenceNotice(observation, { label, receipt, runId = randomUUID(), env = process.env } = {}) {
  try {
    const context = JSON.parse(env[NOTICE_ENV] ?? '{}');
    const to = context.to ?? env.MONITOR_SUPERVISOR_AGENT ?? 'supervisor-herdr';
    const notice = enqueueSupervisor(to,
      `[test-watch] ${label}: no output for ${observation.silence_s.toFixed(3)}s; test continues${receipt ? `; receipt=${receipt}` : ''}`, {
        ...context, id: `test-watch:${createHash('sha256').update(JSON.stringify([receipt ?? null, runId])).digest('hex')}`, waitSeconds: 0, title: 'Test run silence observation',
        shadowEvidence: { channel: 'test-watch', validated: true },
      });
    return notice;
  } catch (error) { return { error: error.message }; }
}
