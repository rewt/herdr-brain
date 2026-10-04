// Shared entry context, independent of the native prompt transport.
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { lessonsJson } from '../lib/lessons.mjs';
import { renderLessons } from '../lib/render.mjs';

export function entryLessons({ org, enteredPath = '.' }) {
  // Filesystem names are not CLI lesson selectors: brackets, wildcard-looking
  // characters and whitespace in an entered directory must stay literal.
  // The unfiltered read supplies active rows in scope/ID order; a stable sort
  // preserves those tie breakers after exact and longest-prefix matches.
  const rows = lessonsJson(fold(loadEvents(org).events)).flatMap(lesson => {
    if (!lesson.paths.length && !lesson.modules.length) return [{ lesson, score: [0, 0] }];
    const scores = lesson.paths.flatMap(prefix => prefix === enteredPath ? [[2, prefix.length]]
      : prefix === '.' || enteredPath.startsWith(`${prefix}/`) ? [[1, prefix === '.' ? 0 : prefix.length]] : []);
    const score = scores.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0];
    return score ? [{ lesson, score }] : [];
  }).sort((a, b) => b.score[0] - a.score[0] || b.score[1] - a.score[1]).map(row => row.lesson);
  if (!rows.length) return '';
  return `Active lessons for this project and entered area (${enteredPath}):\n${renderLessons(rows)}`;
}
