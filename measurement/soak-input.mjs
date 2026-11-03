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
    const historyId = trial[field].historyEvidence;
    trial[field] = field === 'probation' ? {archive: original, evidence: [id]} : {...original, evidence: [id]};
    if (field === 'probation' && historyId) {
      if (!saved.has(historyId)) throw Error('probation.historyEvidence must name a verified history packet');
      const history = JSON.parse(saved.get(historyId));
      trial.probation.history = {...history, evidence: [historyId], files: (history.files ?? []).map(ref => {
        const bytes = saved.get(ref.evidence);
        if (!bytes || digest(bytes) !== ref.sha256) throw Error('history archive must name verified original bytes');
        return {file: ref.file, sha256: ref.sha256, bytes: bytes.toString('utf8'), evidence: [ref.evidence]};
      })};
    }
  }
  trial.turnWitnesses = (trial.turnEvidence ?? []).filter(id => saved.has(id)).map(id => ({bytes: saved.get(id).toString('utf8'), evidence: [id]}));
  if (trial.capacity) {
    const c = trial.capacity;
    // Ignore supplied hydrated state. Only the original hash-verified bytes
    // enter scoring, with their absolute journal paths retained separately.
    c.saved = Object.fromEntries([c.inventoryEvidence, c.configEvidence, c.censusEvidence,
      ...(c.journalRefs ?? []).map(r => r.evidence)].filter(id => saved.has(id)).map(id => [id, saved.get(id).toString('utf8')]));
  }
  return {trial, verifiedEvidence: [...saved.keys()]};
}

// Emit only from the hydrated original archive and the assessment of those
// same saved inputs. A failed/incomplete soak can never create a passing stage.
export function probationStage(file, trial, assessment, assessmentBytes) {
  const probation = trial.probation, archive = probation?.archive;
  const ref = trial.evidence?.[probation?.evidence?.[0]];
  if (!archive || !ref) throw Error('probation output requires a verified original trial archive');
  return {schema: 'brain.probation-stage/v1', status: assessment.status, candidate: assessment.candidate,
    trial: archive.id, project: archive.project, authority: archive.authority,
    archive: {file: fs.realpathSync(path.resolve(path.dirname(file), ref.path)), sha256: ref.sha256},
    assessmentSha256: digest(assessmentBytes), issues: assessment.issues,
    limits: ['Saved probation evidence only; no trial, offer, READY or runtime effect is performed.']};
}
