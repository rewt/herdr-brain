#!/usr/bin/env node
// Operator-invoked setup test uses this same argv-only transport.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const [recipient, encoded] = process.argv.slice(2);
try {
  const payload = JSON.parse(encoded);
  if (!recipient || /[\x00-\x1f]/.test(recipient) || Object.keys(payload).sort().join(',') !== 'kind,project,session' || Object.values(payload).some(v => typeof v !== 'string')) throw Error('recipient and project/session/kind JSON required');
  await promisify(execFile)('/usr/bin/osascript', ['-e', `on run argv
  tell application "Messages"
    set targetService to first service whose service type is iMessage
    set targetBuddy to buddy (item 1 of argv) of targetService
    send (item 2 of argv) to targetBuddy
  end tell
end run`, recipient, JSON.stringify(payload)], { timeout: 10000, maxBuffer: 65536 });
} catch (error) { console.error(error.message); process.exitCode = 1; }
