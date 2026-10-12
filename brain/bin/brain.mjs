#!/usr/bin/env node
// brain digest: a foreground, model-free record signal digest for lesson
// distillation. It reads the record and writes only its own cursor state.
//
//   brain digest --org DIR [--limit N] [--max-chars N] [--json]
//   brain digest --org DIR --ack PASS     after the distill pass completes
import process from 'node:process';
import { parseArgs, cliHelp } from '../../lib/cli-help.mjs';
import { recordDigest, renderDigest } from '../lib/signals.mjs';

const USAGE = 'Usage: brain digest --org DIR [--limit N] [--max-chars N] [--json] [--ack PASS]';
cliHelp(import.meta.url, USAGE);

function main(argv) {
  if (argv[0] !== 'digest') {
    process.stderr.write(`${USAGE}\n  model-free record signals for distillation; acknowledge a pass only after it completes\n`);
    return 2;
  }
  const { values, positionals } = parseArgs({ usage: USAGE, args: argv.slice(1), allowPositionals: true, options: {
    org: { type: 'string' }, limit: { type: 'string' }, 'max-chars': { type: 'string' },
    json: { type: 'boolean' }, ack: { type: 'string' },
  } });
  if (positionals.length) throw new Error('brain digest takes no positional arguments');
  if (values.ack && (values.limit || values['max-chars'])) throw new Error('--ack cannot change digest bounds');
  const d = recordDigest({ orgDir: values.org ?? process.env.ORG_DIR,
    limit: values.limit === undefined ? undefined : Number(values.limit),
    maxChars: values['max-chars'] === undefined ? undefined : Number(values['max-chars']), ack: values.ack });
  process.stdout.write(values.json ? JSON.stringify(d, null, 2) + '\n' : renderDigest(d));
  return 0;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
