import { stripVTControlCharacters } from 'node:util';

// Inspect the visible screen, not scrollback where a resolved dialog can remain.
export function hookReviewDialog(screen) {
  const text = stripVTControlCharacters(screen);
  return text.match(/(?:^|\n)[^\p{L}\p{N}\n]*(\d+\s+hooks?\s+needs?\s+review)[^\p{L}\p{N}\n]*(?=\n|$)/iu)?.[1].replace(/\s+/gu, ' ');
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
