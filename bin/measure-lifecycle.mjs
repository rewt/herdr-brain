#!/usr/bin/env node
// All output goes to stdout; redirect it to the owning evidence directory.
import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {measureLifecycle} from '../measurement/lifecycle.mjs';
import {readCloseoutMeasurement} from '../line-service/closeout-measurement-audit.mjs';

try {
  const {values, positionals} = parseArgs({options: {
    events: {type: 'string'}, project: {type: 'string'}, from: {type: 'string'}, cutoff: {type: 'string'},
    'through-seq': {type: 'string'}, census: {type: 'string'},
    'line-actor': {type: 'string', multiple: true}, 'hand-actor': {type: 'string', multiple: true}
  }});
  if (positionals.length || !values.events) throw Error('usage: node bin/measure-lifecycle.mjs --events FILE --project COMMON --from ISO --cutoff ISO [--through-seq N] [--census FILE] [--hand-actor ACTOR] [--line-actor ACTOR]');
  const events = fs.readFileSync(values.events, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const result = measureLifecycle({events, project: values.project, from: values.from, cutoff: values.cutoff,
    throughSeq: values['through-seq'] === undefined ? undefined : Number(values['through-seq']),
    lineActors: values['line-actor'], handActors: values['hand-actor'],
    census: values.census ? readCloseoutMeasurement(values.census) : null});
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write(`measurement failed: ${error.message}\n`); process.exitCode = 1; }
