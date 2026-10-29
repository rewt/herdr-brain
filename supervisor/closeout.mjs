#!/usr/bin/env node
import { captureCloseoutLaunch } from '../lib/closeout-code.mjs';
import { parseArgs } from 'node:util';
import { isMain } from '../lib/cli-help.mjs';
import { gitProject } from '../lib/project.mjs';

export async function closeoutMain(argv = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    keys: { type: 'string' }, receipt: { type: 'string' }, deadline: { type: 'string' }, 'no-restart': { type: 'boolean' }, 'retry-safe': { type: 'boolean' },'sessions-only':{type:'boolean'}, owner:{type:'boolean'},
    repo: { type: 'string', default: process.cwd() }, org: { type: 'string' }, seq: { type: 'string' }, why: { type: 'string' },
    original: { type: 'string' }, candidate: { type: 'string' },
  } });
  const [command, topic] = positionals, cwd = values.repo;
  if (values.owner && command !== 'status') throw Error('--owner is a read-only status option');
  if ((values.original || values.candidate) && command !== 'packet') throw Error('--original/--candidate are read-only packet options');
  if (command === 'capabilities' && positionals.length === 1) {
    const { readCloseoutCapabilities } = await import('../lib/closeout-packet.mjs');
    process.stdout.write(JSON.stringify(readCloseoutCapabilities()) + '\n');
    return;
  }
  // Bind both identities before importing any queue/consumer/retirement code.
  const loadedCode = ['drain','refresh'].includes(command) ? captureCloseoutLaunch(gitProject(cwd)) : undefined;
  const { findOrgDir, loadEvents } = await import('../lib/store.mjs');
  const { readCloseoutEntries, retryCloseout, publishCloseoutEvents, endReviewFollowup } = await import('../lib/closeout.mjs');
  const org = values.org ?? findOrgDir({ cwd });
  let result;
  if(command==='refresh'&&positionals.length===1){
    const {refreshCloseouts}=await import('../lib/closeout-consumer.mjs');
    const deadline=values.deadline===undefined?Date.now()+45000:Number(values.deadline);
    if(!Number.isSafeInteger(deadline)||deadline<0)throw Error('invalid finite refresh deadline');
    result=refreshCloseouts({cwd,org,loadedCode,deadline});
  }
  else if (command === 'packet' && positionals.length === 1) {
    const { prepareCloseoutPacket } = await import('../lib/closeout-packet.mjs');
    result = prepareCloseoutPacket({ cwd, org, originalFile: values.original, candidateRoot: values.candidate });
  }
  else if (command === 'drain' && positionals.length === 1) {
    const keys = values.keys === undefined ? undefined : JSON.parse(values.keys), bound = values.deadline===undefined?Date.now()+180000:Number(values.deadline);
    if ((keys !== undefined && (!Array.isArray(keys) || keys.some(k => !/^[a-f0-9]{64}$/.test(k)))) || !Number.isSafeInteger(bound)||bound<0||(!bound||values['sessions-only'])&&keys===undefined) throw Error('invalid closer keys/deadline; unbounded/session phases need exact named targets');
    const deadline=bound===0?Infinity:bound;
    const { drainCloseout } = await import('../lib/closeout-consumer.mjs');
    const { restartCloseout } = await import('../lib/closeout-attempt.mjs');
    const command=bound===0?(await import('../dispatch/foreground-command.mjs')).foregroundCommand:undefined;
    result = drainCloseout({ cwd, org, keys, loadedCode, retrySafe: values['retry-safe'],sessionsOnly:values['sessions-only'], retirementOptions: { deadline,...(command?{command}:{}) } });
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
  else if (command === 'status' && positionals.length === 1) result = values.owner
    ? (await import('../lib/closeout-code.mjs')).readCloseoutOwnerStatus({cwd,org})
    : readCloseoutEntries(gitProject(cwd).identity);
  else if (command === 'retry' && positionals.length === 2) result = retryCloseout({ cwd, org, topic, why: values.why });
  else if (command === 'followup-ended' && positionals.length === 2) result = endReviewFollowup({ cwd, org, reviewId: topic, why: values.why });
  else if (command === 'event' && positionals.length === 1) {
    const event = loadEvents(org).events.find(e => e.seq === Number(values.seq));
    if (!event) throw Error('event recovery requires a committed --seq N');
    result = publishCloseoutEvents({ cwd, org, added: [event] });
  } else throw Error('usage: closeout.mjs capabilities|packet --original STATUS --candidate CODE|drain|status|retry TOPIC --why TEXT|event --seq N [--repo PROJECT --org RECORD]');
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (isMain(import.meta.url)) try { await closeoutMain(); }
catch (e) { process.stderr.write(`closeout: ${e.message}\n`); process.exitCode = 1; }
