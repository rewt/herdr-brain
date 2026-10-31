#!/usr/bin/env node
import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {evaluateSoak} from '../measurement/canary-soak.mjs';
import {readSoakInput} from '../measurement/soak-input.mjs';

try {
  const {values, positionals} = parseArgs({options: {events: {type: 'string'}, trial: {type: 'string'}}});
  if (positionals.length || !values.events || !values.trial) throw Error('usage: node bin/evaluate-canary-soak.mjs --events SNAPSHOT.jsonl --trial TRIAL.json');
  const {trial, verifiedEvidence} = readSoakInput(values.trial);
  const events = fs.readFileSync(values.events, 'utf8').split('\n').filter(s => s.trim()).map(s => JSON.parse(s));
  process.stdout.write(JSON.stringify(evaluateSoak({events, trial, verifiedEvidence}), null, 2) + '\n');
} catch (error) { process.stderr.write(`soak evaluation failed: ${error.message}\n`); process.exitCode = 1; }
