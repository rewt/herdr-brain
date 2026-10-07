#!/usr/bin/env node
// Per-launch question guard. The model records its question through the CLI;
// this hook never chooses an answer, grants permission or writes the record.
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from '../lib/cli-help.mjs';
import { operatorPresence } from './operator-presence.mjs';
import { gitProject } from '../lib/project.mjs';
import { supervisorBinding } from './session-binding.mjs';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const tools = { claude: ['AskUserQuestion'], codex: ['request_user_input'] };

export function questionMode(context, env = process.env, binding = () => supervisorBinding(gitProject(context.canonical), env.HERDR_PANE_ID)) {
  // Launch kind is separate from the supervisor workflow role. ENG-248 chats
  // use this explicit machine-owned environment, never display session metadata.
  if (context.role === 'worker' || env.MONITOR_ENTRY_BYPASS === '1' || env.MONITOR_SESSION_ROLE === 'worker') return 'ops';
  if (context.role === 'supervisor') return ['chat', 'combined'].includes(env.MONITOR_SESSION_KIND) ? 'conversation' : 'ops';
  // A restored interactive pane may have lost its environment. Only the
  // verified canonical launch receipt may recover its conversation kind.
  if (!context.role && env.HERDR_PANE_ID) {
    try { return ['chat', 'combined'].includes(binding()?.session_kind) ? 'conversation' : 'ops'; }
    catch { return 'ops'; }
  }
  return 'ops';
}

export function unattendedHookArguments(kind, context, root, env = process.env) {
  if (!tools[kind]) return [];
  const command = [process.execPath, path.join(root, 'supervisor/unattended.mjs'),
    questionMode(context, env), context.org || '', path.join(root, 'bin/org.mjs')].map(quote).join(' ');
  const group = { matcher: `^(${tools[kind].join('|')})$`, hooks: [{ type: 'command', command, timeout: 10 }] };
  if (kind === 'claude') return ['--settings', JSON.stringify({ hooks: { PreToolUse: [group] } })];
  return ['-c', `hooks.PreToolUse=[{matcher=${JSON.stringify(group.matcher)},hooks=[{type="command",command=${JSON.stringify(command)},timeout=10}]}]`];
}

export function questionDecision(input, { mode = 'ops', org = '', record = '', presence = operatorPresence } = {}) {
  if (input?.hook_event_name !== 'PreToolUse' || !Object.values(tools).flat().includes(input.tool_name)) return null;
  const state = mode === 'conversation' ? presence() : { away: true, reason: 'operations session' };
  if (state?.away === false) return null;
  const cli = org && record ? `ORG_DIR=${quote(org)} ${quote(process.execPath)} ${quote(record)}` : 'record';
  const reason = `Unattended question policy (${state?.reason || 'presence unknown'}): do not open a blocking question. ` +
    `Record each question with ${cli} ask "<yes/no question>" --parent <current item> --category <action category> --recommend <yes|no safe default> --why "<reason and chosen default>". ` +
    'Do not use --wait. Take the safe default and continue independent work. ' +
    'For funds/chain actions, publishing, credentials or permission expansion, the safe default is no: leave that action pending and continue other work. ' +
    'A recommendation is not operator approval; never answer an operator question on their behalf. If there is no proven safe default, recommend no and defer the dependent action. ' +
    'If recording fails, retain the question in your report and continue only safe independent work. Do not retry through another blocking question channel.';
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

if (isMain(import.meta.url)) {
  const [mode, org, record] = process.argv.slice(2);
  try {
    const decision = questionDecision(JSON.parse(fs.readFileSync(0, 'utf8')), { mode, org, record });
    if (decision) process.stdout.write(JSON.stringify(decision) + '\n');
  } catch {
    // A malformed invocation must not accidentally open an unattended dialog.
    process.stderr.write('Unattended question guard could not read the request. Record ask with a safe default (no for funds/chain, publishing, credentials or permission expansion), without --wait; defer the dependent action and continue independent work.\n');
    process.exitCode = 2;
  }
}
