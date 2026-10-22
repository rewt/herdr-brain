// Recovery verifies captured evidence without resolving today's owner policy.
import path from 'node:path';
import { readPlainFile } from '../lib/files.mjs';
import { hash, bytesHash, ATTEMPT_SCHEMA, EXECUTION_SCHEMA } from './declaration.mjs';
import { validCommandEvidence, verifySource } from './declared-receipts.mjs';

export function validDeclaredGateEvidence(gate, spec) {
  try {
    if (gate.schema !== ATTEMPT_SCHEMA || spec.schema !== EXECUTION_SCHEMA || hash(gate.declared_gate) !== hash(spec) ||
        path.dirname(gate.log) !== spec.directory || path.dirname(gate.result) !== spec.directory ||
        hash(readPlainFile(gate.log)) !== gate.log_hash || hash(readPlainFile(gate.result)) !== gate.result_hash ||
        hash(readPlainFile(gate.execution_receipt)) !== gate.execution_hash) return false;
    const execution = JSON.parse(readPlainFile(gate.execution_receipt));
    if (!execution.command_started || execution.exit_code !== 0 || execution.signal || execution.gate_timeout || execution.cleanup_error) return false;
    const saved = JSON.parse(readPlainFile(gate.result)), manifest = JSON.parse(readPlainFile(gate.log));
    if (saved.schema !== ATTEMPT_SCHEMA || saved.spec_hash !== hash(spec) || manifest.spec_hash !== hash(spec) ||
        !saved.finished_at || saved.error || hash(saved.gates) !== hash(gate.gates) || hash(manifest.gates) !== hash(gate.gates) ||
        gate.gates.length !== spec.commands.length) return false;
    for (const row of manifest.logs) {
      if (path.dirname(row.log) !== spec.directory || path.dirname(row.stderr_log) !== spec.directory ||
          bytesHash(readPlainFile(row.log, null)) !== row.log_hash || bytesHash(readPlainFile(row.stderr_log, null)) !== row.stderr_hash) return false;
    }
    for (let index = 0; index < gate.gates.length; index++) {
      const row = gate.gates[index], bound = spec.commands[index];
      if (row.id !== bound.id) return false;
      if (row.outcome === 'executed') {
        if (row.execution.command !== bound.definition.command || !validCommandEvidence(row.execution)) return false;
      } else if (row.outcome === 'reused') {
        const source = verifySource(spec.common, row.source, row.observation, Date.now() + 5000);
        if (!source || hash(source.source.definition) !== hash(bound.definition) || !row.integration_observation || row.integration_observation.key !== row.observation.key) return false;
      } else return false;
    }
    return true;
  } catch { return false; }
}
