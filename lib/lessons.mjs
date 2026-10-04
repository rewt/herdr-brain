// Model-free lesson validation and selection. No filesystem lookup is needed:
// paths are literal project-relative prefixes and modules are exact names.
import path from 'node:path';
import { compareIds, lessonState } from './state.mjs';
import { UserError } from './store.mjs';

export const LESSON_TEXT_LIMIT = 400;
export const LESSON_SCOPES = ['project', 'fleet', 'framework'];
export const LESSON_STATES = ['proposed', 'active', 'retired', 'superseded'];

export function normalizeLessonPath(value) {
  const raw = value.trim();
  const normalized = path.posix.normalize(raw).replace(/\/$/, '') || '.';
  if (!raw || path.posix.isAbsolute(raw) || /^[a-z]:/i.test(raw) || /[\\*?\[\]\x00-\x1f\x7f]/.test(raw)
    || normalized === '..' || normalized.startsWith('../')) {
    throw new UserError('lesson paths must be literal project-relative paths (no wildcards or parent escape)');
  }
  return normalized;
}

export function normalizeLessonModule(value) {
  const name = value.trim();
  if (!name) throw new UserError('a lesson module name must not be empty');
  return name;
}

export function validateLessonScope(scope) {
  if (!LESSON_SCOPES.includes(scope)) throw new UserError(`lesson scope must be ${LESSON_SCOPES.join(', ')}`);
}

export function lessonProposal(s, events, { text, scope = 'project', paths = [], modules = [], evidence = [] }) {
  const claim = text.replace(/\s+/g, ' ').trim();
  if (!claim || [...claim].length > LESSON_TEXT_LIMIT)
    throw new UserError(`lesson text must contain 1..${LESSON_TEXT_LIMIT} Unicode code points`);
  validateLessonScope(scope);
  if (!evidence.length) throw new UserError('a lesson needs at least one --evidence item, run or event reference');
  const refs = [...new Set(evidence)].map(ref => {
    if (s.runs.has(ref)) return { kind: 'run', id: ref };
    if (s.items.has(ref)) return { kind: 'item', id: ref };
    const match = /^event:([1-9]\d*)$/.exec(ref);
    if (match) {
      const seq = Number(match[1]);
      if (Number.isSafeInteger(seq) && events.some(e => e.seq === seq)) return { kind: 'event', seq };
    }
    throw new UserError(`unknown evidence ${ref} (use an existing item ID, run ID or event:N)`);
  });
  return { text: claim, scope, paths: [...new Set(paths.map(normalizeLessonPath))],
    modules: [...new Set(modules.map(normalizeLessonModule))], evidence: refs };
}

function relevance(lesson, targetPath, module) {
  const paths = lesson.paths ?? [], modules = lesson.modules ?? [];
  if (targetPath == null && module == null) return [0, 0];
  if (!paths.length && !modules.length) return [0, 0];
  const scores = [];
  for (const prefix of paths) {
    if (targetPath == null) continue;
    if (prefix === targetPath) scores.push([2, prefix.length]);
    else if (prefix === '.' || targetPath.startsWith(`${prefix}/`)) scores.push([1, prefix === '.' ? 0 : prefix.length]);
  }
  if (module != null && modules.includes(module)) scores.push([2, module.length]);
  return scores.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0] ?? null;
}

// JSON retains all matches and provenance. Only the human text view is bounded.
// Targeted matches lead broad lessons; project, fleet, framework and numeric ID
// break ties, so output never depends on time, directory contents or a model.
export function lessonsJson(s, { path: queryPath, module, scope, state = 'active' } = {}) {
  if (scope != null) validateLessonScope(scope);
  if (state !== 'all' && !LESSON_STATES.includes(state))
    throw new UserError(`lesson state must be ${[...LESSON_STATES, 'all'].join(', ')}`);
  const targetPath = queryPath == null ? null : normalizeLessonPath(queryPath);
  const targetModule = module == null ? null : normalizeLessonModule(module);
  return [...s.lessons.values()].flatMap(lesson => {
    const derived = lessonState(lesson);
    if ((scope != null && lesson.scope !== scope) || (state !== 'all' && derived !== state)) return [];
    const score = relevance(lesson, targetPath, targetModule);
    return score ? [{ lesson: { ...lesson, state: derived }, score }] : [];
  }).sort((a, b) => b.score[0] - a.score[0] || b.score[1] - a.score[1]
    || LESSON_SCOPES.indexOf(a.lesson.scope) - LESSON_SCOPES.indexOf(b.lesson.scope)
    || compareIds(a.lesson.id, b.lesson.id)).map(row => row.lesson);
}
