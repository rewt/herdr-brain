import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPlainFile } from '../lib/files.mjs';
export const TEST_ESCALATION = 'The reviewer has unverified test evidence outside the promotion test plan; recorded re-execution is required';
export function deferredTests(text, inherited, { declared = false } = {}) {
  const lines = text.split('\n').filter(line => line !== inherited);
  if (declared) {
    const prefix = '- Test evidence not re-executed: ';
    if (!lines.length || lines.length > 512 || lines.some(line => !line.startsWith(prefix) || !line.slice(prefix.length).trim())) return null;
    const required = [];
    for (const line of lines) {
      const token = line.slice(prefix.length);
      if (token.startsWith('{')) {
        try {
          const row = JSON.parse(token);
          if (!row || Object.keys(row).length !== 1 || typeof row.gate !== 'string' || !row.gate.trim()) return null;
          required.push(row);
        } catch { return null; }
      } else required.push(token);
    }
    return [...new Map(required.map(row => [JSON.stringify(row), row])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (!lines.length || lines.some(line => !/^- Test evidence not re-executed: [\w./-]+\.test\.mjs$/.test(line))) return null;
  const files = lines.map(line => line.slice('- Test evidence not re-executed: '.length));
  if (files.some(file => path.isAbsolute(file) || file.split('/').includes('..'))) return null;
  return [...new Set(files)].sort();
}
export function recordedTestEvidence({ notes, common, head, tree, files }) {
  for (const note of notes) {
    if (!note.decision || !note.text.startsWith('Test re-execution evidence: ')) continue;
    const file = note.text.slice('Test re-execution evidence: '.length);
    try {
      if (path.dirname(file) !== path.join(common, 'lane-validation')) continue;
      const gate = JSON.parse(readPlainFile(file));
      const key = createHash('sha256').update(JSON.stringify({ schema: gate.schema, tree: gate.tree,
        command: gate.command, fingerprint: gate.environment_fingerprint })).digest('hex');
      if (!/^[0-9a-f]{64}$/.test(gate.key ?? '') || path.basename(file) !== `${gate.key}.json` ||
          gate.key !== key || !/^[0-9a-f]{64}$/.test(gate.environment_fingerprint ?? '') ||
          !Number.isFinite(Date.parse(gate.started_at)) || !Number.isFinite(Date.parse(gate.finished_at)) ||
          Date.parse(gate.finished_at) < Date.parse(gate.started_at) || !Number.isFinite(gate.duration_s) || gate.duration_s < 0 ||
          gate.schema !== 'lane-validation/v1' || gate.head !== head || gate.tree !== tree || gate.exit_code !== 0 || gate.signal !== null || path.dirname(gate.log) !== path.dirname(file)) continue;
      const hash = createHash('sha256').update(JSON.stringify(readPlainFile(gate.log))).digest('hex');
      if (hash !== gate.log_hash) continue;
      // Only a direct full-file test command can discharge a scoped deferral.
      // Shell chains, filters and npm aliases cannot prove coverage here.
      const argv = gate.command.split(/\s+/);
      if (!/^(?:node|\/[\w./-]+\/node)$/.test(argv[0]) || !['--test', 'test/helpers/run.mjs'].includes(argv[1]) || argv.slice(2).some(arg => !/^[\w./-]+\.test\.mjs$/.test(arg))) continue;
      if (files.every(f => argv.slice(2).includes(f))) return { receipt: file, head, files };
    } catch { /* Damaged evidence never authorizes promotion. */ }
  }
  return null;
}
