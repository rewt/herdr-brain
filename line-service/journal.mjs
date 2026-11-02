// Effect intents/results stay in the strict journal. Negative observations are
// rebuildable acceleration, checkpointed only when the scheduling lock is yielded
// or released. No cache file can supply an action, receipt or native authority.
import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {readServiceJournal} from './review.mjs';
import {writeFileAtomic} from '../lib/store.mjs';

export const evaluationCacheFile = file => path.join(path.dirname(file), 'negative-evaluations.json');
const validCache = (cache, effects) => cache?.schema === 'line-negative-evaluation/v3' &&
  cache.identity === effects.identity && cache.org === effects.org &&
  cache.entries && typeof cache.entries === 'object' && !Array.isArray(cache.entries);

export function readSchedulingJournal(file) {
  const effects = readServiceJournal(file);
  if (!effects) return effects;
  const cacheFile = evaluationCacheFile(file);
  try {
    const stat = fs.lstatSync(cacheFile, {throwIfNoEntry:false});
    if (!stat) return effects; // One-time migration of an embedded legacy cache.
    delete effects.negative_evaluations;
    if (!stat.isFile() || fs.realpathSync(cacheFile) !== path.resolve(cacheFile)) return effects;
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (validCache(cache, effects)) effects.negative_evaluations = cache;
  } catch {
    delete effects.negative_evaluations; // Missing/damaged/foreign cache is cold.
  }
  return effects;
}

function write(file, value) {
  const start = performance.now(), bytes = JSON.stringify(value, null, 2) + '\n';
  const serialized = performance.now();
  writeFileAtomic(file, bytes, 0o600);
  return {bytes:Buffer.byteLength(bytes),serialize_ms:serialized-start,write_ms:performance.now()-serialized};
}

export function writeEffectJournal(file, effects) {
  const {negative_evaluations, ...critical} = effects;
  return write(file, critical);
}

export function writeEvaluationCache(file, effects) {
  if (!validCache(effects.negative_evaluations, effects)) return null;
  const cacheFile = evaluationCacheFile(file), stat = fs.lstatSync(cacheFile, {throwIfNoEntry:false});
  if (stat && (!stat.isFile() || fs.realpathSync(cacheFile) !== path.resolve(cacheFile)))
    throw Error('negative evaluation cache is redirected; retain it and evaluate fresh');
  return write(cacheFile, effects.negative_evaluations);
}
