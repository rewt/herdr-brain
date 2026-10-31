#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {readEvidence, readSoakInput} from '../measurement/soak-input.mjs';
import {retirementCheckpoint, evaluateRetirement} from '../measurement/retirement-coverage.mjs';

try {
  const {values, positionals} = parseArgs({options: {manifest: {type: 'string'}, resume: {type: 'string'}, checkpoint: {type: 'boolean'}}});
  if (positionals.length || !values.manifest || values.resume && values.checkpoint)
    throw Error('usage: node bin/evaluate-retirement.mjs --manifest MANIFEST.json [--checkpoint | --resume CHECKPOINT.json]');
  const manifest = JSON.parse(fs.readFileSync(values.manifest, 'utf8')), saved = readEvidence(values.manifest, manifest);
  const bytes = field => {
    if (!saved.has(manifest[field])) throw Error(`${field} must name verified saved evidence`);
    return saved.get(manifest[field]);
  };
  const trialFile = path.resolve(path.dirname(values.manifest), manifest.evidence?.[manifest.trialEvidence]?.path ?? '');
  const {trial, verifiedEvidence: soakEvidence} = readSoakInput(trialFile, bytes('trialEvidence'));
  const input = {manifest, trial, soakEvidence, verifiedEvidence: [...saved.keys()],
    events: bytes('eventsEvidence').toString().split('\n').filter(s => s.trim()).map(s => JSON.parse(s)),
    observations: JSON.parse(bytes('observationsEvidence'))};
  const resume = values.resume ? JSON.parse(fs.readFileSync(values.resume, 'utf8')) : null;
  const result = values.checkpoint ? retirementCheckpoint(input) : evaluateRetirement(input, resume);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write(`retirement evaluation failed: ${error.message}\n`); process.exitCode = 1; }
