// The only boundary between untrusted source data and presentation.
import fs from 'node:fs';
import path from 'node:path';

export const WITHHELD = 'withheld';
export const phases = ['queued', 'admission', 'stage', 'reconcile', 'landed', 'failed', 'interrupted', 'unknown'];
const kinds = ['promotion', 'gate', 'certification', 'preparation', 'release'];
const controls = /[\x00-\x1f\x7f-\x9f]/;
const secrets = /secret|token|passw|mnemonic|seed|private|witness|bearer|auth|cookie|key=/i;
const matches = (v, re) => typeof v === 'string' && !controls.test(v) && re.test(v);
const checked = (v, ok) => ok ? v : WITHHELD;
const nullable = (v, predicate) => checked(v, v === null || predicate(v));
const integer = v => Number.isSafeInteger(v) && v >= 0;
export const safeProject = v => checked(v, matches(v, /^[a-z0-9._-]{1,40}$/));
export const safeTime = v => nullable(v, s => matches(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/) && Number.isFinite(Date.parse(s)));
export const safeStatus = v => checked(v, matches(v, /^[A-Za-z0-9 .,:;=()%_+<>-]{0,96}$/) && !/[a-f0-9]{16}/i.test(v) && !secrets.test(v));
export const within = (root, file) => file === root || file.startsWith(root + path.sep);

export function safeLog(file, roots = []) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || controls.test(file) || file.split(path.sep).includes('..')) return WITHHELD;
  const segments = file.split(path.sep).filter(Boolean);
  if (segments.some(s => secrets.test(s))) return WITHHELD;
  try {
    // Check every component: realpath containment alone would admit internal symlinks.
    let component = path.parse(file).root;
    for (const segment of segments) {
      component = path.join(component, segment);
      if (fs.lstatSync(component).isSymbolicLink()) return WITHHELD;
    }
    if (!fs.statSync(file).isFile()) return WITHHELD;
    const real = fs.realpathSync(file);
    if (!roots.some(root => { try { return within(fs.realpathSync(root), real); } catch { return false; } })) return WITHHELD;
    return file;
  } catch { return WITHHELD; }
}
export function safeWorktree(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || controls.test(value)) return WITHHELD;
  try { return fs.statSync(value).isDirectory() ? fs.realpathSync(value) : WITHHELD; }
  catch { return WITHHELD; }
}

export function validateRow(raw, { project, roots = [], panes = new Set() } = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const stage = r.stage;
  const clocks = !Object.hasOwn(r, 'clocks') ? [] : Array.isArray(r.clocks) && r.clocks.length <= 4 ? r.clocks.map(c => ({
    label: checked(c?.label, matches(c?.label, /^[a-z0-9 ._>-]{1,32}$/)),
    seconds: checked(c?.seconds, integer(c?.seconds)),
    legacy: c && typeof c === 'object' && !Array.isArray(c) && !Object.hasOwn(c, 'legacy') ? false : checked(c?.legacy, typeof c?.legacy === 'boolean'),
  })) : WITHHELD;
  return {
    project: safeProject(project),
    id: checked(r.id, matches(r.id, /^[A-Za-z0-9._:-]{1,80}$/)),
    item: nullable(r.item, v => matches(v, /^[A-Z][A-Z0-9]*-[0-9]+$/)),
    lane: nullable(r.lane, v => matches(v, /^[a-z0-9][a-z0-9._/-]{0,80}$/)),
    kind: checked(r.kind, kinds.includes(r.kind)), phase: checked(r.phase, phases.includes(r.phase)),
    stage: stage === null ? null : stage && Number.isInteger(stage.n) && Number.isInteger(stage.m) && stage.n >= 1 && stage.n <= stage.m && stage.m <= 999
      ? { n: stage.n, m: stage.m } : WITHHELD,
    startedAt: safeTime(r.startedAt), phaseAt: safeTime(r.phaseAt), endedAt: safeTime(r.endedAt), clocks,
    status: { code: checked(r.status?.code, matches(r.status?.code, /^[a-z0-9._-]{1,40}$/)), text: safeStatus(r.status?.text) },
    result: {
      exit: nullable(r.result?.exit, v => integer(v) && v <= 255),
      main: nullable(r.result?.main, v => matches(v, /^[a-fA-F0-9]{40}$/)),
      candidate: nullable(r.result?.candidate, v => matches(v, /^[a-fA-F0-9]{40}$/)),
    },
    where: {
      pane: checked(r.where?.pane, matches(r.where?.pane, /^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/) && panes.has(r.where.pane)),
      log: safeLog(r.where?.log, roots),
    },
    worktree: safeWorktree(r.worktree),
  };
}
export const ERROR_CODES = ['source-timeout', 'source-exit', 'source-oversize', 'source-json', 'source-schema', 'source-read'];
export function errorDocument(project, code) {
  if (!ERROR_CODES.includes(code)) code = 'source-read';
  return { schema: 'board-rows/v1', project, generatedAt: null, rows: [{ id: code, item: null, lane: null,
    kind: 'promotion', phase: 'unknown', stage: null, startedAt: null, phaseAt: null, endedAt: null, clocks: [],
    status: { code, text: code }, result: { exit: null, main: null, candidate: null }, where: {}, worktree: null }] };
}
export function validateDocument(doc, options = {}) {
  const schemaOK = doc && doc.schema === 'board-rows/v1' && Array.isArray(doc.rows);
  const source = schemaOK ? doc : errorDocument(options.project, 'source-schema');
  return { schema: 'board-rows/v1', project: safeProject(source.project), generatedAt: safeTime(source.generatedAt),
    rows: source.rows.map(row => validateRow(row, { ...options, project: source.project })) };
}
