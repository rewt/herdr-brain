#!/usr/bin/env node
// All output goes to stdout; redirect it to the owning evidence directory.
import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {measureLifecycle} from '../measurement/lifecycle.mjs';
import {readCloseoutMeasurement} from '../line-service/closeout-measurement-audit.mjs';
import {measureLinePasses} from '../measurement/line-passes.mjs';

try {
  const {values, positionals} = parseArgs({options: {
    events: {type: 'string'}, passes: {type: 'string'}, project: {type: 'string'}, from: {type: 'string'}, cutoff: {type: 'string'},
    'through-seq': {type: 'string'}, census: {type: 'string'},
    'line-actor': {type: 'string', multiple: true}, 'hand-actor': {type: 'string', multiple: true}
  }});
  if (positionals.length || Boolean(values.events)===Boolean(values.passes)) throw Error('usage: node bin/measure-lifecycle.mjs (--events FILE --project COMMON | --passes FILE) --from ISO --cutoff ISO [--through-seq N] [--census FILE] [--hand-actor ACTOR] [--line-actor ACTOR]');
  if(values.passes){process.stdout.write(JSON.stringify(await measureLinePasses({file:values.passes,from:values.from,cutoff:values.cutoff}),null,2)+'\n');}
  else{
  const events = fs.readFileSync(values.events, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const result = measureLifecycle({events, project: values.project, from: values.from, cutoff: values.cutoff,
    throughSeq: values['through-seq'] === undefined ? undefined : Number(values['through-seq']),
    lineActors: values['line-actor'], handActors: values['hand-actor'],
    census: values.census ? readCloseoutMeasurement(values.census) : null});
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
} catch (error) { process.stderr.write(`measurement failed: ${error.message}\n`); process.exitCode = 1; }
