#!/usr/bin/env node
import { captureCloseoutLaunch } from '../lib/closeout-code.mjs';
import { parseArgs } from 'node:util';
import { isMain } from '../lib/cli-help.mjs';
import { gitProject } from '../lib/project.mjs';

export async function closeoutMain(argv = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    keys: { type: 'string' }, receipt: { type: 'string' }, deadline: { type: 'string' }, 'no-restart': { type: 'boolean' },
    repo: { type: 'string', default: process.cwd() }, org: { type: 'string' }, seq: { type: 'string' }, why: { type: 'string' },
  } });
  const [command, topic] = positionals, cwd = values.repo;
  // Bind both identities before importing any queue/consumer/retirement code.
  const loadedCode = command === 'drain' ? captureCloseoutLaunch(gitProject(cwd)) : undefined;
  const { findOrgDir, loadEvents } = await import('../lib/store.mjs');
  const { readCloseoutEntries, retryCloseout, publishCloseoutEvents, endReviewFollowup } = await import('../lib/closeout.mjs');
  const org = values.org ?? findOrgDir({ cwd });
  let result;
  if (command === 'drain' && positionals.length === 1) {
    const keys = values.keys === undefined ? undefined : JSON.parse(values.keys), deadline = values.deadline ? Number(values.deadline) : Date.now() + 180000;
    if ((keys !== undefined && (!Array.isArray(keys) || keys.some(k => !/^[a-f0-9]{64}$/.test(k)))) || !Number.isSafeInteger(deadline)) throw Error('invalid closer keys/deadline');
    const { drainCloseout } = await import('../lib/closeout-consumer.mjs');
    const { restartCloseout } = await import('../lib/closeout-attempt.mjs');
    result = drainCloseout({ cwd, org, keys, loadedCode, retirementOptions: { deadline } });
    if (result.restart) result.successor = restartCloseout({ cwd, org, restart: result.restart, deadline, noRestart: values['no-restart'] });
  }
  else if (command === 'handoff' && positionals.length === 1 && values.receipt) {
    const { handoffCloseout } = await import('../lib/closeout-handoff.mjs');
    const { joinedCloseoutAttempt } = await import('../lib/closeout-attempt.mjs');
    const keys = handoffCloseout({ cwd, org, receipt: values.receipt });
    result = joinedCloseoutAttempt({ cwd, org, keys });
  }
  else if (command === 'migrate' && positionals.length === 2) {
    const { migrateCloseout } = await import('../lib/closeout-handoff.mjs');
    const { joinedCloseoutAttempt } = await import('../lib/closeout-attempt.mjs');
    const keys = migrateCloseout({ cwd, org, key: topic, receipt: values.receipt });
    result = joinedCloseoutAttempt({ cwd, org, keys });
  }
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

if (isMain(import.meta.url)) try { await closeoutMain(); }
catch (e) { process.stderr.write(`closeout: ${e.message}\n`); process.exitCode = 1; }
