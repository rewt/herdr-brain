// Priority-answer attribution, never a general human impersonation mechanism.
import fs from './record-observation.mjs';
import path from 'node:path';
import { gitProject } from './project.mjs';
import { readConfig, UserError } from './store.mjs';
import { invokeHerdr } from './herdr-command.mjs';

const fields = ['actor', 'common', 'server', 'workspace', 'pane', 'terminal_id', 'agent_session_id'];
const text = value => typeof value === 'string' && value.trim() && !/[\x00-\x1f\x7f]/u.test(value);
const fail = reason => { throw new UserError(`operator answer relay: ${reason}`); };

export function operatorAnswerRelay({ org, actor, verbatim, source, saidAt, now,
  cwd = process.cwd(), env = process.env, call = invokeHerdr }) {
  const binding = readConfig(org).approvals.operator_relay;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
      Object.keys(binding).some(key => !fields.includes(key)) || !fields.every(key => text(binding[key])) ||
      !path.isAbsolute(binding.common) || !path.isAbsolute(binding.server) || binding.actor === 'human')
    fail('the owning record needs an explicit approvals.operator_relay native binding');
  if (actor !== binding.actor || actor === 'human') fail('writer is not the recorded operator chat');
  if (typeof verbatim !== 'string' || !verbatim.trim() || !text(source)) fail('verbatim reply and --source are required');
  // Require an explicit timezone; a local wall clock is not durable provenance.
  if (typeof saidAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(saidAt) ||
      !Number.isFinite(Date.parse(saidAt)) || Date.parse(saidAt) > now.getTime())
    fail('--said-at must be an ISO timestamp with timezone, no later than recording');
  if (env.HERDR_ENV !== '1' || env.HERDR_SOCKET_PATH !== binding.server ||
      env.HERDR_PANE_ID !== binding.pane || env.HERDR_WORKSPACE_ID !== binding.workspace)
    fail('caller is outside the recorded operator chat');
  const project = gitProject(cwd);
  if (project.identity !== binding.common || fs.realpathSync(binding.common) !== binding.common)
    fail('source Git common-directory differs from the recorded operator chat');
  // No input, alternate executor, retries or role/name lookup on refusal.
  const native = JSON.parse(call(env.HERDR_BIN_PATH || 'herdr', ['agent', 'get', binding.pane], { env, cwd })).result?.agent;
  if (!native || native.pane_id !== binding.pane || native.workspace_id !== binding.workspace ||
      native.terminal_id !== binding.terminal_id || native.agent_session?.value !== binding.agent_session_id ||
      (native.name && native.name !== actor) || typeof native.cwd !== 'string' || fs.realpathSync(native.cwd) !== project.checkout ||
      (env.CODEX_THREAD_ID && env.CODEX_THREAD_ID !== binding.agent_session_id))
    fail('native caller no longer matches the recorded operator chat');
  return { schema: 'operator-answer-relay/v1', operator: 'human', relayer: actor, verbatim,
    source, said_at: saidAt, record: fs.realpathSync(org), binding: { ...binding } };
}
