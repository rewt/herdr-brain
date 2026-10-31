// Shared saved-input reader. Hashes bytes before hydrating authoritative packets.
import fs from 'node:fs';
import path from 'node:path';
import {digest} from './canary-soak.mjs';

export function readEvidence(file, input) {
  const saved = new Map();
  for (const [id, ref] of Object.entries(input.evidence ?? {})) {
    const bytes = fs.readFileSync(path.resolve(path.dirname(file), ref.path));
    if (digest(bytes) !== ref.sha256) throw Error(`evidence digest mismatch: ${id}`);
    saved.set(id, bytes);
  }
  return saved;
}

export function readSoakInput(file, bytes = fs.readFileSync(file, 'utf8')) {
  const trial = JSON.parse(bytes), saved = readEvidence(file, trial);
  for (const [field, key] of [['scripted', 'packetEvidence'], ['probation', 'archiveEvidence']]) {
    if (!trial[field]) continue;
    const id = trial[field][key];
    if (!saved.has(id)) throw Error(`${field}.${key} must name a verified original packet`);
    const original = JSON.parse(saved.get(id));
    trial[field] = field === 'probation' ? {archive: original, evidence: [id]} : {...original, evidence: [id]};
  }
  return {trial, verifiedEvidence: [...saved.keys()]};
}
