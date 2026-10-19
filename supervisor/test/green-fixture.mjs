// Fixed reviewed bytes, read as data: ordinary board edits cannot break fixtures.
import fs from 'node:fs';
export const renderer = fs.readFileSync(new URL('./fixtures/green-renderer.mjs', import.meta.url), 'utf8');
