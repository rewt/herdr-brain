#!/usr/bin/env node
// Retired transport: read-only compatibility for issued descriptors and claims.
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from '../lib/cli-help.mjs';
import { readPlainFile } from '../lib/files.mjs';
import { Receiver, addressKey } from './receiver.mjs';

export function readHookSession(file) {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file || (fs.lstatSync(file).mode & 0o077)) throw Error('private canonical hook session required');
  const session = JSON.parse(readPlainFile(file));
  if (session.schema !== 'brain.hook-session/v1' || !['claude', 'codex'].includes(session.kind) ||
      !['plain', 'teammate'].includes(session.rendering) || session.kind !== 'claude' && session.rendering !== 'plain' ||
      typeof session.humanTyped !== 'boolean' || !session.consumer || !path.isAbsolute(session.root ?? '') ||
      !path.isAbsolute(session.cwd ?? '') || !path.isAbsolute(session.common ?? '') || session.address?.projectRef !== session.common ||
      addressKey(session.address) !== session.recipient) throw Error('invalid hook session');
  return session;
}

export function hookHandoff(session) {
  const state = new Receiver({ root: session.root }).state();
  const entries = state.entries.filter(e => e.recipient === session.recipient && e.receipts.some(r => r.transport === 'hook-pull/v1' &&
    r.consumer === session.consumer && r.state === 'delivered') && e.state !== 'consumed');
  const claimedIds = entries.map(e => e.event.eventId);
  return { claimedIds, markdown: `## Hook-pull handoff\n\nClaimed but unprocessed message IDs: ${claimedIds.map(id => JSON.stringify(id)).join(', ') || 'none'}.\n` };
}
if (isMain(import.meta.url)) {
  // Saved Stop/UserPromptSubmit commands stay inert. Only explicit inspection
  // reads historical claims; neither path appends a receiver receipt.
  const args = process.argv.slice(2);
  if (args[0] === 'handoff') {
    try {
      if (args.length !== 3 || args[1] !== '--session') throw Error('expected handoff --session FILE');
      process.stdout.write(hookHandoff(readHookSession(args[2])).markdown);
    } catch (error) { console.error(`hook handoff: ${error.message}`); process.exitCode = 1; }
  }
}
