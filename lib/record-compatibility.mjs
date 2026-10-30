// Admission for a stopped release handoff, including legacy protocol-1 bundles.
// Read the target's actual fold, not a capability claimed by newer tooling.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlainFile } from './files.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
function foldTypes(root) {
  const source = readPlainFile(path.join(root, 'lib/state.mjs'));
  // The supported legacy fold has one literal event switch. An unrecognized
  // implementation is uncertainty; do not infer compatibility from its version.
  const body = /function apply\(s, e\)\s*\{[\s\S]*?switch \(e\.type\)\s*\{([\s\S]*?)\n\s*default:/.exec(source)?.[1];
  if (!body) throw Error(`record-incompatible: unknown fold contract at ${root}`);
  return new Set([...body.matchAll(/^\s*case '([^']+)':/gm)].map(match => match[1]));
}

export function requireRecordCompatibility(root, events) {
  const reference = foldTypes(sourceRoot), target = foldTypes(root);
  const required = events.filter(event => reference.has(event.type) || /^(?:item|run|link|lesson|release|decision|category)\./.test(event.type));
  const missing = required.filter(event => !target.has(event.type));
  if (missing.length) {
    const types = [...new Set(missing.map(event => event.type))];
    throw Error(`record-incompatible: ${root} cannot fold ${types.join(', ')} (first sequence ${missing[0].seq ?? 'unknown'}); retain the stopped installation and captured work`);
  }
  return { root, required_types: [...new Set(required.map(event => event.type))].sort(), through: events.at(-1)?.seq ?? 0 };
}
