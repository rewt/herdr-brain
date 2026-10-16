// Canonical, KEEP-only enrollment history. This is NOT the display registry.
// Helpers do no live enrollment. Future enrollment must first prove native
// ownership using the existing lane/workspace guards, then record this receipt.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../lib/files.mjs';
import { parseUniqueJson } from './json.mjs';
import { canonicalProject } from './project.mjs';
import { SLOT_PANES } from './manifest.mjs';
import { readControllerJournal } from './runtime.mjs';

const schema = 'standard-slot-history/v1';
export const slotReceiptFile = common => path.join(common, 'sessions', 'standard-slots.json');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const text = value => typeof value === 'string' && value.trim() && !/[\x00-\x1f\x7f]/u.test(value);
const identifier = value => text(value) && /^[a-zA-Z0-9][a-zA-Z0-9:._/-]*$/u.test(value) && !value.includes('..');
function validate(history, common) {
  if (!exact(history, ['schema', 'common', 'operations']) || history.schema !== schema || history.common !== common || !Array.isArray(history.operations)) throw Error('invalid canonical standard-slot history');
  const adopted = new Map();
  for (const [index, op] of history.operations.entries()) {
    if (!exact(op, ['seq', 'action', 'uid', 'actor', 'why', 'at', 'slot']) || op.seq !== index + 1 || !['adopt', 'withdraw'].includes(op.action) ||
        !identifier(op.uid) || !text(op.actor) || !text(op.why) || !text(op.at) || !Number.isFinite(Date.parse(op.at))) throw Error('invalid standard-slot operation');
    if (op.action === 'adopt') {
      const s = op.slot;
      if (adopted.has(op.uid) || !exact(s, ['server', 'workspace', 'checkout', 'tab', 'standardSlot', 'panes']) ||
          !text(s.server) || !identifier(s.workspace) || !identifier(s.tab) || !path.isAbsolute(s.checkout ?? '') || path.normalize(s.checkout) !== s.checkout ||
          !Object.hasOwn(SLOT_PANES, s.standardSlot) || !Array.isArray(s.panes) || s.panes.length !== SLOT_PANES[s.standardSlot].length ||
          s.panes.some(p => !exact(p, ['pane', 'paneSlot']) || !identifier(p.pane) || !SLOT_PANES[s.standardSlot].includes(p.paneSlot)) ||
          new Set(s.panes.map(p => p.paneSlot)).size !== s.panes.length || new Set(s.panes.map(p => p.pane)).size !== s.panes.length) throw Error('invalid adopted standard-slot binding');
      if ([...adopted.values()].some(a => a.slot.server === s.server && (a.slot.tab === s.tab || (a.slot.workspace === s.workspace && a.slot.standardSlot === s.standardSlot)))) throw Error('duplicate adopted tab or standard slot');
      adopted.set(op.uid, op);
    } else {
      if (op.slot !== undefined || !adopted.has(op.uid)) throw Error('withdrawal requires an adopted slot');
      adopted.delete(op.uid);
    }
  }
  return [...adopted.values()].map(op => ({ uid: op.uid, common, ...op.slot }));
}

function load(common) {
  const file = slotReceiptFile(common);
  // lstat distinguishes an absent receipt from a broken symlink/unknown source.
  // Refuse symlinked receipt directories too: canonical evidence stays in Git.
  try { if (!fs.lstatSync(path.dirname(file)).isDirectory()) throw Error('receipt directory is not a regular directory'); }
  catch (error) { if (error.code === 'ENOENT') return { schema, common, operations: [] }; throw error; }
  try { if (!fs.lstatSync(file).isFile()) throw Error('receipt is not a regular file'); }
  catch (error) { if (error.code === 'ENOENT') return { schema, common, operations: [] }; throw error; }
  return parseUniqueJson(fs.readFileSync(file, 'utf8'));
}

export function readStandardSlots(common) {
  try {
    try { fs.lstatSync(path.join(path.dirname(slotReceiptFile(common)), 'standard-slots.lock')); throw Error('standard-slot operation in progress or lock unresolved'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const history = load(common);
    const slots = validate(history, common), journal = readControllerJournal(common);
    // Add KEEP for replacement layouts without withdrawing the old receipt.
    // Only a bound, validated incarnation can extend the protection set.
    for (const op of journal.operations.filter(op => op.history?.includes('restarted'))) {
      const adopted = slots.find(s => s.server === op.target.server && s.workspace === op.target.workspace && s.tab === op.target.tab);
      if (!adopted) continue; // A work-item resume does not enroll a standard slot.
      const incarnations = journal.incarnations.filter(i => i.operationId === op.id);
      if (incarnations.length !== op.participants.length) throw Error('incomplete replacement KEEP evidence');
      const b = incarnations[0].binding;
      if (b.tab === adopted.tab) continue;
      slots.push({ ...adopted, uid: `incarnation:${op.id}`, tab: b.tab, controllerOperation: op.id,
        panes: op.participants.map(p => ({ pane: incarnations.find(i => i.uid === p.uid).binding.pane, paneSlot: p.spec.paneSlot ?? 'primary' })) });
    }
    return { schema, slots, errors: [] };
  } catch (error) { return { schema, slots: [], errors: [`standard-slot protection evidence unreadable: ${error.message}; project kept`] }; }
}

// Explicit adoption/withdrawal always leaves actor, reason and history. There is
// intentionally no CLI for adopting current tabs or withdrawing them in bulk.
export function recordStandardSlot({ cwd = process.cwd(), action, uid, actor, why, slot, at = new Date().toISOString() }) {
  const { common } = canonicalProject(cwd), file = slotReceiptFile(common);
  if (action === 'adopt' && (!slot?.checkout || fs.realpathSync(slot.checkout) !== slot.checkout || canonicalProject(slot.checkout).common !== common)) throw Error('adoption checkout must have the same canonical Git common-directory identity');
  const before = load(common); validate(before, common);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, 'standard-slots.lock');
  fs.mkdirSync(lock); // Contention/abandoned locks hold; never guess ownership.
  try {
    const history = load(common); validate(history, common);
    const op = { seq: history.operations.length + 1, action, uid, actor, why, at, ...(slot === undefined ? {} : { slot }) };
    history.operations.push(op); validate(history, common);
    writeFileAtomic(file, JSON.stringify(history, null, 2) + '\n');
    // Do not acknowledge adoption/withdrawal until bytes and the renamed entry
    // are durable. An unresolved lock remains a KEEP input after interruption.
    for (const target of [file, directory]) {
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    return op;
  } finally { fs.rmdirSync(lock); }
}
