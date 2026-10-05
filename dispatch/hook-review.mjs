import { stripVTControlCharacters } from 'node:util';

// Inspect the visible screen, not scrollback where a resolved dialog can remain.
export function hookReviewDialog(screen) {
  // Remove dialog borders, but retain composer markers and prose so they cannot
  // turn quoted task text into a dialog marker. Whitespace allows wrapped rows.
  const text = stripVTControlCharacters(screen).split(/\r?\n/u)
    .map(line => line.replace(/^[\t │┃║]+|[\t │┃║]+$/gu, '')).join('\n');
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
