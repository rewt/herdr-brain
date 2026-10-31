// Read candidate bytes only. Static paths are conservative edges, never proof
// that computed runtime inputs have been enumerated or tests have executed.
import fs from 'node:fs';
import path from 'node:path';
import { safeInputPath, testInventory } from './test-inventory.mjs';

export const CONSUMER_MANIFEST = 'test/helpers/test-consumers.json';
const sourceFile = file => /\.(?:mjs|js|cjs|sh)$/.test(file);

function explicitConsumers(root, files) {
  if (!files.includes(CONSUMER_MANIFEST)) return {};
  const absolute = path.join(root, CONSUMER_MANIFEST);
  if (!fs.lstatSync(absolute).isFile() || fs.realpathSync(absolute) !== absolute) throw Error('non-regular test consumer manifest');
  if (fs.statSync(absolute).size > 1024 * 1024) throw Error('test consumer manifest exceeds 1 MiB');
  const manifest = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  if (manifest?.schema !== 'test-consumers/v1' || !manifest.consumers ||
      Array.isArray(manifest.consumers) || typeof manifest.consumers !== 'object' ||
      Object.keys(manifest).some(key => !['schema', 'consumers'].includes(key))) throw Error('invalid test consumer manifest');
  return manifest.consumers;
}

export function affectedTestPlan({ root, changed, files, tests = testInventory(files), consumers }) {
  root = fs.realpathSync(root);
  const inventoryTests = testInventory(files);
  if (!Array.isArray(changed) || changed.length > 10000 || changed.some(file => !safeInputPath(file))) {
    throw Error('affected-test graph requires at most 10000 safe changed paths');
  }
  if (tests.some(file => !inventoryTests.includes(file))) throw Error('test candidate is outside the live inventory');
  const known = new Set([...files, ...changed]), reverse = new Map(), opaque = new Set();
  const declared = consumers ?? explicitConsumers(root, files);
  if (!declared || Array.isArray(declared) || typeof declared !== 'object') throw Error('invalid explicit consumers');
  for (const [consumer, inputs] of Object.entries(declared)) {
    if (!safeInputPath(consumer) || !files.includes(consumer) || !Array.isArray(inputs) ||
        inputs.some(input => !safeInputPath(input))) throw Error(`invalid explicit consumer: ${consumer}`);
  }
  const edge = (input, consumer, kind) => {
    if (!known.has(input)) return;
    if (!reverse.has(input)) reverse.set(input, new Map());
    // Preserve explicit attribution when a static reference names the same edge.
    if (kind === 'explicit' || !reverse.get(input).has(consumer)) reverse.get(input).set(consumer, kind);
  };
  // Test names in tier lists/manifests describe membership, not content inputs.
  // Actual imports/calls and explicit declarations still establish dependencies.
  const literalEdge = (input, consumer) => {
    if (!input.endsWith('.test.mjs')) edge(input, consumer, 'static');
  };
  const basenames = new Map();
  for (const file of known) {
    const name = path.posix.basename(file);
    if (!basenames.has(name)) basenames.set(name, []);
    basenames.get(name).push(file);
  }
  let bytes = 0;
  for (const file of files.filter(sourceFile)) {
    const absolute = path.join(root, file);
    if (!fs.lstatSync(absolute).isFile() || fs.realpathSync(absolute) !== absolute) {
      throw Error(`non-regular affected-test source: ${file}`);
    }
    bytes += fs.statSync(absolute).size;
    if (bytes > 32 * 1024 * 1024) throw Error('affected-test graph exceeds 32 MiB');
    const text = fs.readFileSync(absolute, 'utf8');
    // Exact import/require paths may omit extensions (CommonJS). The general
    // literal pass also covers fixture data, new URL and spawned script paths.
    const imports = /(?:\b(?:import|export)\s*(?:[^;'"`]*?\bfrom\s*)?|\b(?:import|require)\s*\(\s*)(['"])([^'"\r\n]+)\1/g;
    for (const match of text.matchAll(imports)) {
      if (!match[2].startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[2]));
      const resolved = [target, `${target}.mjs`, `${target}.js`, `${target}.cjs`, `${target}/index.js`].find(name => known.has(name));
      if (resolved) edge(resolved, file, 'static');
    }
    for (const match of text.matchAll(/['"`]([^'"`\n]+\.[A-Za-z0-9_-]+)['"`]/g)) {
      const literal = match[1];
      if (literal.includes('${')) continue;
      for (const target of [path.posix.normalize(path.posix.join(path.posix.dirname(file), literal)), literal]) literalEdge(target, file);
      if (!literal.includes('/') && sourceFile(literal)) {
        for (const target of basenames.get(literal) ?? []) literalEdge(target, file);
      }
    }
    // Opaque call sites are reported even when a different, static consumer was
    // found. Declaring this consumer's runtime inputs discharges this warning;
    // it is an explicit author assertion, not a coverage attestation.
    const calls = /\b(?:import|require|(?:new\s+)?URL|readFile(?:Sync)?|readdir(?:Sync)?)\s*\(\s*([^\n]*)/g;
    for (const match of text.matchAll(calls)) {
      const literal = match[1].match(/^(['"`])([^'"`\r\n]*)\1\s*[,)]/);
      if (!literal || literal[2].includes('${') || /^readdir/.test(match[0])) opaque.add(file);
      else for (const target of [path.posix.normalize(path.posix.join(path.posix.dirname(file), literal[2])), literal[2]]) edge(target, file, 'static');
    }
  }
  for (const [consumer, inputs] of Object.entries(declared)) {
    for (const input of inputs) edge(input, consumer, 'explicit');
    edge(CONSUMER_MANIFEST, consumer, 'explicit');
  }
  const reachableTests = start => {
    const seen = new Set([start]), pending = [{ file: start, via: [start], explicit: false }], found = [];
    for (let index = 0; index < pending.length; index++) {
      const current = pending[index];
      if (tests.includes(current.file)) found.push(current);
      for (const [consumer, kind] of reverse.get(current.file) ?? []) {
        if (seen.has(consumer)) continue;
        seen.add(consumer);
        pending.push({ file: consumer, via: [...current.via, consumer], explicit: current.explicit || kind === 'explicit' });
      }
    }
    return found;
  };
  const reasons = [], unknown = [];
  for (const input of [...new Set(changed)].sort()) {
    const found = reachableTests(input);
    if (!found.length) unknown.push(`unmapped-input: ${input}`);
    for (const { file, via, explicit } of found) reasons.push({ input, file, via,
      reason: input === file ? 'changed-test' : explicit ? 'explicit-consumer' : via.length === 2 ? 'direct-reference' : 'transitive-reference' });
  }
  if (changed.length) for (const file of [...opaque].sort()) {
    if (!Object.hasOwn(declared, file) && reachableTests(file).length) unknown.push(`opaque-inputs: ${file}; declare runtime inputs in ${CONSUMER_MANIFEST}`);
  }
  return { candidates: [...new Set(reasons.map(row => row.file))].sort(), consumers: reasons, unknown,
    graph: { paths: files.length, inventory: inventoryTests, test_files: inventoryTests.length,
      consumers: reasons, max_paths: 10000, max_bytes: 32 * 1024 * 1024, max_suite_files: 4, hops: 'transitive' } };
}
