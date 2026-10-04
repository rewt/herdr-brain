// Plan user lifecycle hooks in the same transaction as wrappers and shell entry.
import path from 'node:path';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { quote } from '../discovery/runtime.mjs';
import { bytes } from './entry-transaction.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function document(content, file) {
  const data = content.length ? JSON.parse(content.toString('utf8')) : {};
  if (!object(data) || (data.hooks !== undefined && !object(data.hooks)) ||
      (data.hooks?.SessionStart !== undefined && !Array.isArray(data.hooks.SessionStart))) throw new Error(`invalid native hook configuration: ${file}`);
  return data;
}
export function planNativeHooks({ bin, runtime, kinds, inspect, change }) {
  const marker = path.join(bin, '.monitor-native-hooks.json'), current = inspect(marker);
  const prior = current ? JSON.parse(current.content.toString('utf8')) : { version: 1, hooks: [] };
  if (prior.version !== 1 || !Array.isArray(prior.hooks) || new Set(prior.hooks.map(h => h.kind)).size !== prior.hooks.length) throw new Error('invalid native hook receipt');
  for (const h of prior.hooks) {
    if (!['codex', 'claude'].includes(h.kind) || !path.isAbsolute(h.file) || path.basename(h.file) !== (h.kind === 'codex' ? 'hooks.json' : 'settings.json') ||
        typeof h.missing !== 'boolean' || !Number.isInteger(h.mode) || h.mode < 0 || h.mode > 0o777 || !object(h.group)) throw new Error('invalid native hook receipt');
    bytes(h.before);
  }
  const receipts = [];
  const removedDirectories = [];
  for (const kind of new Set([...prior.hooks.map(h => h.kind), ...kinds])) {
    const previous = prior.hooks.find(h => h.kind === kind);
    // Retain the original config destination across an upgrade or removal.
    const file = previous?.file ?? path.join(kind === 'codex' ? process.env.CODEX_HOME || path.join(process.env.HOME, '.codex')
      : process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude'), kind === 'codex' ? 'hooks.json' : 'settings.json');
    const state = inspect(file), content = state?.content ?? Buffer.alloc(0), data = document(content, file);
    const before = previous ? bytes(previous.before) : content, original = document(before, file);
    let groups = data.hooks?.SessionStart ?? [];
    if (previous) {
      const matches = groups.filter(group => isDeepStrictEqual(group, previous.group));
      if (matches.length !== 1) throw new Error(`managed native hook changed: ${file}`);
      groups = groups.filter(group => !isDeepStrictEqual(group, previous.group));
      if (groups.length || original.hooks?.SessionStart !== undefined) data.hooks.SessionStart = groups;
      else delete data.hooks.SessionStart;
      if (!Object.keys(data.hooks).length && original.hooks === undefined) delete data.hooks;
    }
    if (kinds.includes(kind)) {
      const fleet = process.env.HERDR_MONITOR_FLEET ? path.resolve(process.env.HERDR_MONITOR_FLEET) : previous?.fleet;
      const command = `${quote(process.execPath)} ${quote(path.join(runtime, 'herdr/native-entry.mjs'))} --bin ${quote(bin)}${fleet ? ` --fleet ${quote(fleet)}` : ''}`;
      const group = { matcher: '^(startup|resume|clear|compact)$', hooks: [{ type: 'command', command, timeout: 30 }] };
      // Never adopt or remove a hook the operator installed independently.
      if (groups.some(g => g.hooks?.some(h => h.command?.includes('/herdr/native-entry.mjs')))) throw new Error(`unmanaged Monitor native hook: ${file}`);
      data.hooks ??= {}; data.hooks.SessionStart = [...groups, group];
      const next = Buffer.from(JSON.stringify(data, null, 2) + '\n');
      change(file, { content: isDeepStrictEqual(document(content, file), data) ? content : next, mode: state?.mode ?? 0o600 });
      receipts.push(previous ? { ...previous, group, fleet } : { kind, file, group, fleet, before: before.toString('base64'), missing: !state, directoryMissing: !fs.existsSync(path.dirname(file)), mode: state?.mode ?? 0o600 });
    } else {
      const restored = isDeepStrictEqual(data, original) ? before : Buffer.from(JSON.stringify(data, null, 2) + '\n');
      change(file, previous.missing && restored.length === 0 ? null : { content: restored, mode: state.mode });
      if (previous.directoryMissing) removedDirectories.push(path.dirname(file));
    }
  }
  change(marker, receipts.length ? { content: Buffer.from(JSON.stringify({ version: 1, hooks: receipts }, null, 2) + '\n'), mode: 0o600 } : null);
  return () => {
    for (const directory of removedDirectories) {
      try { fs.rmdirSync(directory); }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    }
  };
}
