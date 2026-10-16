// Best-effort pruning of automatic evidence only; never lock or history files.
import fs from 'node:fs';
import path from 'node:path';
import { readPlainFile } from '../lib/files.mjs';

export const EXECUTIONS_PER_PROFILE = 20;
export const RETENTION_SCHEMA = 'test-slot-retention/v1';

export function pruneExecutions(currentFile, profileId, stateOfHolder) {
  const directory = path.dirname(currentFile);
  const rows = [];
  for (const name of fs.readdirSync(directory)) {
    if (!/^\d+-[0-9a-f]{16}\.execution\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    try {
      const bytes = readPlainFile(file), value = JSON.parse(bytes);
      if (value.resource?.profile?.id !== profileId || value.retention?.schema !== RETENTION_SCHEMA) continue;
      rows.push({ file, bytes, value, order: Number(name.split('-')[0]) });
    } catch { /* Unknown, redirected and legacy files are not deletion authority. */ }
  }
  rows.sort((a, b) => b.order - a.order || b.file.localeCompare(a.file));
  let pruned = 0;
  for (const row of rows.slice(EXECUTIONS_PER_PROFILE)) {
    if (row.file === currentFile) continue;
    try {
      const holder = row.value.retention.holder;
      // A wrapper killed before its final receipt may not have persisted group
      // registration. Its spawned command PID still identifies the owned group;
      // absent birth data makes a live/reused leader unknown, never deletable.
      if (!row.value.finished_at && (!Number.isSafeInteger(row.value.command_pid) || row.value.command_pid < 1)) continue;
      const saved = row.value.finished_at ? holder : { ...holder, pgid: row.value.command_pid, groupStart: null, groupBirth: null };
      if (stateOfHolder(saved).state !== 'gone') continue;
      // An early receipt can predate group registration. Read the current lock
      // too, so an orphan command or a live/unknown holder keeps its evidence.
      let protectedByLock = false;
      for (const lock of row.value.retention.lock_paths) {
        let current;
        try { current = JSON.parse(readPlainFile(lock)); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (current?.token === holder.token && stateOfHolder(current).state !== 'gone') protectedByLock = true;
      }
      if (protectedByLock || readPlainFile(row.file) !== row.bytes) continue;
      const samples = `${row.file}.samples.jsonl`;
      // Do not follow a telemetry pointer from receipt content, or remove a
      // redirected/non-file sibling. Only this fixed managed pair is eligible.
      try { if (!fs.lstatSync(samples).isFile()) continue; fs.unlinkSync(samples); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.unlinkSync(row.file);
      pruned++;
    } catch { /* Liveness or storage uncertainty preserves the receipt. */ }
  }
  return pruned;
}
