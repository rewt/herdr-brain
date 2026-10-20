#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { isMain } from '../lib/cli-help.mjs';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir, loadEvents } from '../lib/store.mjs';
import { drainCloseout } from '../lib/closeout-consumer.mjs';
import { readCloseoutEntries, retryCloseout, publishCloseoutEvents, endReviewFollowup } from '../lib/closeout.mjs';

export function closeoutMain(argv = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    repo: { type: 'string', default: process.cwd() }, org: { type: 'string' }, seq: { type: 'string' }, why: { type: 'string' },
  } });
  const [command, topic] = positionals, cwd = values.repo, org = values.org ?? findOrgDir({ cwd });
  let result;
  if (command === 'drain' && positionals.length === 1) result = drainCloseout({ cwd, org });
  else if (command === 'status' && positionals.length === 1) result = readCloseoutEntries(gitProject(cwd).identity);
  else if (command === 'retry' && positionals.length === 2) result = retryCloseout({ cwd, org, topic, why: values.why });
  else if (command === 'followup-ended' && positionals.length === 2) result = endReviewFollowup({ cwd, org, reviewId: topic, why: values.why });
  else if (command === 'event' && positionals.length === 1) {
    const event = loadEvents(org).events.find(e => e.seq === Number(values.seq));
    if (!event) throw Error('event recovery requires a committed --seq N');
    result = publishCloseoutEvents({ cwd, org, added: [event] });
  } else throw Error('usage: closeout.mjs drain|status|retry TOPIC --why TEXT|event --seq N [--repo PROJECT --org RECORD]');
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (isMain(import.meta.url)) try { closeoutMain(); }
catch (e) { process.stderr.write(`closeout: ${e.message}\n`); process.exitCode = 1; }
