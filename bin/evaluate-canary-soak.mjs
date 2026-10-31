#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {evaluateSoak, digest} from '../measurement/canary-soak.mjs';

try {
  const {values, positionals} = parseArgs({options: {events: {type: 'string'}, trial: {type: 'string'}}});
  if (positionals.length || !values.events || !values.trial) throw Error('usage: node bin/evaluate-canary-soak.mjs --events SNAPSHOT.jsonl --trial TRIAL.json');
  const trial = JSON.parse(fs.readFileSync(values.trial, 'utf8')), verifiedEvidence = [], saved = new Map();
  for (const [id, ref] of Object.entries(trial.evidence ?? {})) {
    const file = path.resolve(path.dirname(values.trial), ref.path);
    const bytes = fs.readFileSync(file);
    if (digest(bytes) !== ref.sha256) throw Error(`evidence digest mismatch: ${id}`);
    saved.set(id, bytes);
    verifiedEvidence.push(id);
  }
  // The actual A2 packet/A3 archive are authoritative inputs. Inline status
  // prose cannot turn a retained failed packet into a passing packet.
  if (trial.scripted) {
    const id = trial.scripted.packetEvidence;
    if (!saved.has(id)) throw Error('scripted.packetEvidence must name a verified installed-canary packet');
    trial.scripted = {...JSON.parse(saved.get(id)), evidence: [id]};
  }
  if (trial.probation) {
    const id = trial.probation.archiveEvidence;
    if (!saved.has(id)) throw Error('probation.archiveEvidence must name the verified original authority archive');
    trial.probation = {archive: JSON.parse(saved.get(id)), evidence: [id]};
  }
  const events = fs.readFileSync(values.events, 'utf8').split('\n').filter(s => s.trim()).map(s => JSON.parse(s));
  process.stdout.write(JSON.stringify(evaluateSoak({events, trial, verifiedEvidence}), null, 2) + '\n');
} catch (error) { process.stderr.write(`soak evaluation failed: ${error.message}\n`); process.exitCode = 1; }
