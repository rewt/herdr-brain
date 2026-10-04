// Shared entry context, independent of the native prompt transport.
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { lessonsJson } from '../lib/lessons.mjs';
import { renderLessons } from '../lib/render.mjs';

export function entryLessons({ org, enteredPath = '.' }) {
  const rows = lessonsJson(fold(loadEvents(org).events), { path: enteredPath });
  if (!rows.length) return '';
  return `Active lessons for this project and entered area (${enteredPath}):\n${renderLessons(rows)}`;
}
