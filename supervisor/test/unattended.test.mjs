import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { operatorPresence, parsePresence } from '../operator-presence.mjs';
import { questionDecision, questionMode, unattendedHookArguments } from '../unattended.mjs';
import { sessionHookArguments } from '../session-hooks.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const input = tool_name => ({ hook_event_name: 'PreToolUse', tool_name,
  tool_input: { questions: [{ question: 'May I add a scoped permission rule for payto/paytomany on fusion_chipnet?' }] } });
const consoleRow = (extra = '') => `"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSessionLoginDoneKey"=Yes,"kCGSSessionUserIDKey"=501${extra}})`;
const idle = seconds => `"HIDIdleTime" = ${BigInt(seconds) * 1_000_000_000n}`;

test('Mac presence switches at fifteen minutes, on lock and on unknown state', () => {
  assert.equal(parsePresence(idle(899), consoleRow(), 501).away, false);
  assert.equal(parsePresence(idle(900), consoleRow(), 501).away, true);
  assert.equal(parsePresence(idle(1), consoleRow(',"IOConsoleSessionScreenIsLocked"=Yes'), 501).reason, 'screen locked');
  assert.equal(parsePresence(idle(1), consoleRow(',"IOConsoleSessionScreenIsLocked"=No'), 501).away, false);
  for (const [hid, users, uid] of [
    ['', consoleRow(), 501], [idle(0), '', 501], [idle(0), consoleRow(), 502],
    [idle(0), consoleRow().replace('OnConsoleKey"=Yes', 'OnConsoleKey"=No'), 501],
    [idle(0), consoleRow().replace('LoginDoneKey"=Yes', 'LoginDoneKey"=No'), 501],
    [idle(0), consoleRow(',"IOConsoleSessionScreenIsLocked"=Unknown'), 501],
    [idle(0) + '\n' + idle(0), consoleRow(), 501],
    [idle(0), consoleRow().replace('})', ',' + consoleRow().match(/\{.*\}/)[0] + ')'), 501],
    [idle(0), consoleRow().replace('})', '},' + consoleRow().match(/\{.*\}/)[0] + ')'), 501],
    [idle(0), consoleRow(), undefined],
  ]) assert.equal(parsePresence(hid, users, uid).away, true, users);
});

test('presence reads are bounded absolute native commands and failures default away', () => {
  const calls = [];
  const run = (binary, args, options) => {
    calls.push({ binary, args, options });
    return { status: 0, stdout: args.includes('IOHIDSystem') ? idle(2) : consoleRow() };
  };
  assert.equal(operatorPresence({ platform: 'darwin', uid: 501, run }).away, false);
  assert.deepEqual(calls.map(c => c.binary), ['/usr/sbin/ioreg', '/usr/sbin/ioreg']);
  assert.ok(calls.every(c => c.options.timeout <= 1500 && c.options.killSignal === 'SIGKILL'));
  for (const result of [{ status: 1 }, { error: Error('timeout') }, { status: 0, signal: 'SIGKILL' }, { status: 0, stdout: 'unreadable' }])
    assert.equal(operatorPresence({ platform: 'darwin', uid: 501, run: () => result }).away, true);
  assert.equal(operatorPresence({ platform: 'darwin', run: () => { throw Error('read denied'); } }).away, true);
  assert.equal(operatorPresence({ platform: 'linux', run: () => assert.fail('no macOS read on Linux') }).away, true);
});

test('explicit launch kind separates chats and combined conversations from ops and inherited worker metadata', () => {
  for (const kind of ['chat', 'combined']) {
    assert.equal(questionMode({ role: 'supervisor' }, { MONITOR_SESSION_KIND: kind }), 'conversation');
    assert.equal(questionMode({ role: 'worker' }, { MONITOR_SESSION_KIND: kind }), 'ops');
    assert.equal(questionMode({ role: 'supervisor' }, { MONITOR_SESSION_KIND: kind, MONITOR_ENTRY_BYPASS: '1' }), 'ops');
  }
  for (const kind of [undefined, 'ops', 'autopilot', 'invalid'])
    assert.equal(questionMode({ role: 'supervisor', session: { kind: 'chat' } }, { MONITOR_SESSION_KIND: kind }), 'ops');
  const read = () => ({ session_kind: 'chat' });
  assert.equal(questionMode({}, { HERDR_PANE_ID: 'saved-pane' }, read), 'conversation');
  assert.equal(questionMode({ role: 'worker' }, { HERDR_PANE_ID: 'saved-pane' }, read), 'ops');
  assert.equal(questionMode({}, { HERDR_PANE_ID: 'saved-pane', MONITOR_ENTRY_BYPASS: '1' }, read), 'ops');
  assert.equal(questionMode({ role: 'supervisor' }, { HERDR_PANE_ID: 'saved-pane' }, read), 'ops', 'new ops launch does not inherit the previous chat role');
  assert.equal(questionMode({}, { HERDR_PANE_ID: 'saved-pane' }, () => { throw Error('stale receipt'); }), 'ops');
});

test('ops never consult presence; both question channels get record-and-default instructions', () => {
  for (const tool of ['AskUserQuestion', 'request_user_input']) {
    const decision = questionDecision(input(tool), { presence: () => assert.fail('ops must never ask normally') });
    const output = decision.hookSpecificOutput;
    assert.equal(output.permissionDecision, 'deny');
    for (const text of ['record ask', '--recommend', '--why', 'Do not use --wait', 'funds/chain', 'publishing', 'credentials', 'permission expansion', 'safe default is no', 'continue independent work', 'not operator approval'])
      assert.ok(output.permissionDecisionReason.includes(text), text);
    assert.equal(Object.hasOwn(output, 'updatedInput'), false, 'do not invent an operator answer');
  }
});

test('a conversation rechecks presence for every question and resumes normal asking when the operator returns', () => {
  const states = [{ away: false }, { away: true, reason: 'screen locked' }, { away: true, reason: 'Mac idle for at least 15 minutes' }, { away: true, reason: 'presence unknown' }, { away: false }];
  for (const state of states) {
    const result = questionDecision(input('AskUserQuestion'), { mode: 'conversation', presence: () => state });
    assert.equal(Boolean(result), state.away);
    if (result) assert.match(result.hookSpecificOutput.permissionDecisionReason, new RegExp(state.reason));
  }
  assert.equal(questionDecision(input('Read')), null);
  assert.equal(questionDecision(input('request_user_input_async')), null, 'the async tool is not a blocking dialog');
  assert.equal(questionDecision({ ...input('AskUserQuestion'), hook_event_name: 'PermissionRequest' }), null);
});

test('per-launch hooks quote paths, retain SessionStart and run as native stdin command hooks without record writes', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "question ' launch-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const linked = path.join(scratch, "tooling ' root"); fs.symlinkSync(root, linked);
  const org = path.join(scratch, "record ' with spaces"); fs.mkdirSync(org);
  const context = { role: 'supervisor', canonical: scratch, org };
  for (const kind of ['claude', 'codex']) {
    const args = unattendedHookArguments(kind, context, linked, {});
    const command = kind === 'claude' ? JSON.parse(args[1]).hooks.PreToolUse[0].hooks[0].command
      : JSON.parse(args[1].match(/command=("(?:[^"\\]|\\.)*")/)[1]);
    const run = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify(input(kind === 'claude' ? 'AskUserQuestion' : 'request_user_input')), encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
    const reason = JSON.parse(run.stdout).hookSpecificOutput.permissionDecisionReason;
    assert.ok(reason.includes('ORG_DIR=')); assert.ok(reason.includes('bin/org.mjs'));
    assert.deepEqual(fs.readdirSync(org), []);
    const malformed = spawnSync('/bin/sh', ['-c', command], { input: '{', encoding: 'utf8', timeout: 10000 });
    assert.equal(malformed.status, 2); assert.match(malformed.stderr, /Record ask/);
    const registered = sessionHookArguments(kind, context, linked);
    assert.match(registered.join(' '), /session-start.mjs/);
    assert.match(registered.join(' '), /unattended.mjs/);
  }
});
