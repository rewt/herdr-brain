#!/usr/bin/env node
import { isMain } from '../lib/cli-help.mjs';
import { readDeclared } from '../lanes/validation.mjs';
import { writeFileAtomic } from '../lib/files.mjs';
import { sameDeclaration, MAX_EXECUTION_BYTES, ATTEMPT_SCHEMA, hash, refuse } from './declaration.mjs';
import { executionIdentity } from './execution-identity.mjs';
import { planDeclaredGate } from './declared-gates.mjs';

export function main(args = process.argv.slice(2)) {
  let state, file;
  const save = () => writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n', 0o600);
  try {
    if (args.length !== 2 || Buffer.byteLength(args[0]) > MAX_EXECUTION_BYTES) throw refuse('invalid immutable planning argv');
    const input = JSON.parse(args[0]); file = args[1];
    executionIdentity({ canonical: input.repo, identity: input.common }, { bound: input.identity });
    const owner = readDeclared(input.repo, { base: input.base }); sameDeclaration(input.owner, owner);
    owner.source.revision = input.owner.source.revision;
    state = { schema: ATTEMPT_SCHEMA, kind: 'canonical-planning', binding_hash: hash(input), evidence: { commands: [] } }; save();
    const result = planDeclaredGate({ ...input, owner, env: process.env, evidence: state.evidence, onUpdate: save });
    state.spec = result.spec; state.plan = result.plan; state.finished_at = new Date().toISOString(); save();
  } catch (error) {
    if (state) { state.error = error.message; state.code = error.code ?? null; save(); }
    console.error(error.message); process.exitCode = 1;
  }
}
if (isMain(import.meta.url)) main();
