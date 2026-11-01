#!/usr/bin/env node
import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {evaluateSoak} from '../measurement/canary-soak.mjs';
import {readSoakInput, probationStage} from '../measurement/soak-input.mjs';

try {
  const {values, positionals} = parseArgs({options: {events: {type: 'string'}, trial: {type: 'string'}, 'probation-output': {type: 'string'}}});
  if (positionals.length || !values.events || !values.trial) throw Error('usage: node bin/evaluate-canary-soak.mjs --events SNAPSHOT.jsonl --trial TRIAL.json [--probation-output NEW.json]');
  const {trial, verifiedEvidence} = readSoakInput(values.trial);
  const events = fs.readFileSync(values.events, 'utf8').split('\n').filter(s => s.trim()).map(s => JSON.parse(s));
  const assessment = evaluateSoak({events, trial, verifiedEvidence});
  const bytes = JSON.stringify(assessment, null, 2) + '\n';
  if (values['probation-output']) fs.writeFileSync(values['probation-output'],
    JSON.stringify(probationStage(values.trial, trial, assessment, bytes), null, 2) + '\n', {flag: 'wx', mode: 0o444});
  process.stdout.write(bytes);
} catch (error) { process.stderr.write(`soak evaluation failed: ${error.message}\n`); process.exitCode = 1; }
