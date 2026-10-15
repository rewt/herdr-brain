#!/usr/bin/env node
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { gitProject } from '../lib/project.mjs';
import { stateDirectory, readJournal, report } from './journal.mjs';
import { identityAt } from './mirror.mjs';
import fs from 'node:fs/promises';

export async function main(args = process.argv.slice(2)) {
  const { values: opt, positionals } = parseArgs({ args, allowPositionals: true,
    usage: 'Usage: node messages/messages.mjs shadow-report --identity NAME [--root DIR] [--common-dir DIR] [--since UTC] [--json]',
    options: { identity: { type: 'string' }, root: { type: 'string' }, 'common-dir': { type: 'string' }, since: { type: 'string' }, json: { type: 'boolean' } } });
  if (positionals.length !== 1 || positionals[0] !== 'shadow-report') throw Error('expected shadow-report');
  const commonDir = await fs.realpath(opt['common-dir'] ?? gitProject().identity);
  const directory = stateDirectory({ identity: opt.identity ?? await identityAt(commonDir), commonDir, root: opt.root });
  const result = report(await readJournal(directory), { since: opt.since });
  process.stdout.write(JSON.stringify(result, null, opt.json ? 0 : 2) + '\n');
  return result;
}
if (isMain(import.meta.url)) main().catch(error => { console.error(`messages: ${error.message}`); process.exitCode = 1; });
