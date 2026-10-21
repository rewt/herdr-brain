// Observed adoption proves KEEP ownership only. It never proves a launch.
import path from 'node:path';
import { readPlainFile } from '../lib/files.mjs';
import { digest, text, validBinding, bindingKeys } from './lifecycle-evidence.mjs';
import { parseUniqueJson } from './json.mjs';
import { humanAnswerEvidence } from './authorization.mjs';

const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k));
const hash = v => /^[a-f0-9]{64}$/u.test(v ?? '');
export function validAdoptOperation(op) {
  return exact(op, ['id', 'kind', 'uid', 'generation', 'specDigest', 'target', 'standardSlot', 'binding', 'origin', 'state', 'keep', 'authorization', 'evidence', 'adoptionId', 'nativeKind']) &&
    op.kind === 'adopt-standard-slot' && op.origin === 'observed-adoption' && text(op.id) && text(op.uid) && text(op.adoptionId) &&
    ['Session', 'LogViewer'].includes(op.nativeKind) && validBinding(op.binding, op.nativeKind) &&
    Number.isSafeInteger(op.generation) && op.generation > 0 && hash(op.specDigest) &&
    exact(op.target, bindingKeys.slice(0, 5)) && bindingKeys.slice(0, 5).every(k => op.target[k] === op.binding[k]) &&
    ['chat', 'supervisor', 'logs'].includes(op.standardSlot) && ['intent', 'acknowledged'].includes(op.state) &&
    exact(op.keep, ['uid', 'seq', 'sha256', 'operation']) && text(op.keep.uid) && Number.isSafeInteger(op.keep.seq) && op.keep.seq > 0 && hash(op.keep.sha256) &&
    op.keep.operation?.uid === op.keep.uid && op.keep.operation.seq === op.keep.seq && digest(op.keep.operation) === op.keep.sha256 &&
    exact(op.authorization, ['record', 'id', 'seq', 'sha256']) && path.isAbsolute(op.authorization.record ?? '') && text(op.authorization.id) && Number.isSafeInteger(op.authorization.seq) && hash(op.authorization.sha256) &&
    exact(op.evidence, ['file', 'sha256']) && path.isAbsolute(op.evidence.file ?? '') && hash(op.evidence.sha256);
}
export function verifyAdoptOperation(op, common) {
  if (!validAdoptOperation(op)) throw Error('invalid observed adoption operation');
  const evidence = parseUniqueJson(readPlainFile(op.evidence.file));
  if (op.evidence.file !== path.join(common, 'sessions/adoptions', `${op.adoptionId}.json`) || digest(evidence) !== op.evidence.sha256 || evidence.common !== common ||
      !evidence.slots?.some(s => s.members.some(m => m.uid === op.uid && digest(m.binding) === digest(op.binding) && m.specDigest === op.specDigest && m.generation === op.generation))) throw Error('observed adoption evidence changed; hold');
  if (digest(evidence.authorization) !== digest(op.authorization) || digest(humanAnswerEvidence({ record: op.authorization.record, ref: op.authorization,
    field: 'adoption_authorization', validateScope(scope) { if (digest(scope) !== digest(evidence.scope)) throw Error('adoption authorization scope changed'); } })) !== digest(op.authorization)) throw Error('observed adoption owner decision changed');
  const history = parseUniqueJson(readPlainFile(path.join(common, 'sessions/standard-slots.json')));
  const keep = history.operations?.find(o => o.seq === op.keep.seq);
  if (op.state === 'acknowledged' && (!keep || keep.action !== 'adopt' || keep.uid !== op.keep.uid || digest(keep) !== op.keep.sha256 ||
      !['server', 'workspace', 'checkout', 'tab', 'standardSlot'].every(k => keep.slot[k] === (k === 'standardSlot' ? op.standardSlot : op.binding[k])) ||
      !keep.slot.panes.some(p => p.pane === op.binding.pane))) throw Error('observed adoption KEEP evidence changed; hold');
  return true;
}
