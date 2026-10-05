import { stripVTControlCharacters } from 'node:util';

// Inspect the visible screen, not scrollback where a resolved dialog can remain.
export function hookReviewDialog(screen) {
  // Remove dialog borders, but retain composer markers and prose so they cannot
  // turn quoted task text into a dialog marker. Whitespace allows wrapped rows.
  const text = stripVTControlCharacters(screen).split(/\r?\n/u)
    .map(line => line.replace(/^[\t │┃║]+|[\t │┃║]+$/gu, '')).join('\n');
  // The /hooks event table can be the startup screen too. Only accept its
  // warning-prefixed count alongside the heading, table and review controls;
  // a warning glyph in quoted composer prose is not a dialog by itself.
  const table = /(?:^|\n)Hooks(?=\n|$)/u.test(text) &&
    /(?:^|\n)Event\s+Installed\s+Active\s+Review\s+Description(?=\n|$)/u.test(text) &&
    /(?:^|\n)t trust all · enter review · esc close(?=\n|$)/u.test(text);
  const warning = text.match(/(?:^|\n)⚠\uFE0F?\s+(\d+\s+hooks?\s+needs?\s+review\s+before\s+(?:it|they)\s+can\s+run\.?)(?=\n|$)/iu)?.[1];
  if (table && warning) return warning.replace(/\s+/gu, ' ');
  const count = text.match(/(?:^|\n)(\d+\s+hooks?\s+(?:is|are)\s+new\s+or\s+changed\.?)(?=\n|$)/iu)?.[1];
  const title = /(?:^|\n)Hooks\s+need\s+review(?=\n|$)/iu.test(text);
  const trustOption = /(?:^|\n)(?:[›>❯]\s*)?(?:\d+[.)]\s*)?Trust all and continue(?=\n|$)/iu.test(text);
  if (title && (count || trustOption)) return count?.replace(/\s+/gu, ' ') ?? 'Hooks need review';
  return text.match(/(?:^|\n)(\d+\s+hooks?\s+needs?\s+review(?:\s+before\s+(?:it|they)\s+can\s+run\.?)?)(?=\n|$)/iu)?.[1]
    .replace(/\s+/gu, ' ');
}

export function codexProfile(args) {
  let profile;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-p' || args[i] === '--profile') profile = args[++i];
    else if (args[i].startsWith('--profile=')) profile = args[i].slice(10);
    else if (args[i].startsWith('-p') && args[i].length > 2) profile = args[i].slice(2).replace(/^=/u, '');
  }
  return profile;
}
