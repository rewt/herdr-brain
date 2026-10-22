// Settle may inspect canonical declared coverage through the same host adapter.
// This path never executes candidate gates or certifies a promotion pass.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/cli-help.mjs';
import { writeFileAtomic, readPlainFile } from '../lib/files.mjs';
import { gitProject } from '../lib/project.mjs';
import { readDeclared } from '../lanes/validation.mjs';
import { executionIdentity } from './execution-identity.mjs';
import { refuseDeclaredGatesV2 } from './declared-inert.mjs';
import { runProjectGateSync, resolveGateProfile } from './gate-profile.mjs';
import { planDeclaredGateBounded } from './declared-gates.mjs';
import { bindRequirements } from './declared-selection.mjs';
import { snapshotDeclaration, sameDeclaration, MAX_EXECUTION_BYTES, refuse, ATTEMPT_SCHEMA } from './declaration.mjs';

const self = fileURLToPath(import.meta.url), marker = 'DECLARED_PLAN_RESULT ';
export function admittedDeclaredTestPlan({ repo, base, cwd, candidate, required = [], changed, env = process.env }) {
  refuseDeclaredGatesV2();
  const project = gitProject(repo), identity = executionIdentity(project);
  const owner = readDeclared(project.canonical, { base, env });
  if (!owner) throw refuse('command planner requires a resolved declared owner');
  const bound = { repo: project.canonical, common: project.identity, base, cwd, candidate, required: bindRequirements(required, owner.value), changed,
    owner: snapshotDeclaration(owner), identity };
  const serialized = JSON.stringify(bound);
  if (Buffer.byteLength(serialized) > MAX_EXECUTION_BYTES) throw refuse('planning binding exceeds 96 KiB');
  const id = randomUUID(), directory = path.join(project.identity, 'promote/planning', id);
  const profile = resolveGateProfile(project.canonical, env);
  fs.mkdirSync(directory, { recursive: true });
  const receipt = path.join(directory, 'planning.json'), log = path.join(directory, 'planning.log');
  writeFileAtomic(receipt, JSON.stringify({ schema: ATTEMPT_SCHEMA, id, identity: project.identity, base, candidate,
    execution_identity: identity, declaration: bound.owner, jobs: [{ id: 'planning-only' }], phase: 'planning-only' }, null, 2) + '\n', 0o600);
  const fd = fs.openSync(log, 'wx', 0o600);
  let result;
  try { result = runProjectGateSync({ canonical: project.canonical, receipt,
    argv: [self, serialized, receipt], cwd: project.canonical, env: profile.env, stdio: ['ignore', fd, fd] }); }
  finally { fs.closeSync(fd); }
  const saved = JSON.parse(readPlainFile(receipt));
  writeFileAtomic(receipt, JSON.stringify({ ...saved, finished_at: new Date().toISOString(), exit_code: result.status, signal: result.signal ?? null }, null, 2) + '\n', 0o600);
  if (result.error || result.status !== 0 || result.signal) {
    if (saved.native_context?.ok === false) throw Object.assign(Error(saved.native_context.reason), { code: saved.native_context.code });
    throw refuse(`canonical planning refused; inspect ${receipt} and ${log}`);
  }
  const line = readPlainFile(log).split('\n').findLast(row => row.startsWith(marker));
  if (!line) throw refuse('canonical planning returned no bounded result');
  return { ...JSON.parse(line.slice(marker.length)), planning_evidence: { receipt, log, base, candidate, declaration: bound.owner.source } };
}
if (isMain(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || Buffer.byteLength(process.argv[2]) > MAX_EXECUTION_BYTES) throw refuse('invalid planning binding');
    const input = JSON.parse(process.argv[2]), receipt = process.argv[3];
    refuseDeclaredGatesV2();
    executionIdentity(gitProject(input.repo), { bound: input.identity });
    const owner = readDeclared(input.repo, { base: input.base }); sameDeclaration(input.owner, owner);
    const evidence = { commands: [] };
    const result = planDeclaredGateBounded({ ...input, owner, selectionOnly: true, evidence,
      profile: resolveGateProfile(input.repo), env: process.env, onUpdate: () => {
        const saved = JSON.parse(readPlainFile(receipt));
        writeFileAtomic(receipt, JSON.stringify({ ...saved, evidence }, null, 2) + '\n', 0o600);
      } });
    process.stdout.write(marker + JSON.stringify(result.plan) + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
