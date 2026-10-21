// Settle's observational planning uses the same owner host admission as a
// train. It never executes the candidate gate or writes a green receipt.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/cli-help.mjs';
import { writeFileAtomic } from '../lib/files.mjs';
import { gitProject } from '../lib/project.mjs';
import { readDeclared } from '../lanes/validation.mjs';
import { executionIdentity } from './execution-identity.mjs';
import { resolveGateProfile, runProjectGateSync } from './gate-profile.mjs';
import { planDeclaredGate } from './declared-gates.mjs';
import { snapshotDeclaration, MAX_PLAN_BYTES, refuse } from './declaration.mjs';

const self = fileURLToPath(import.meta.url), marker = 'DECLARED_PLAN_RESULT ';
export function admittedDeclaredTestPlan({ repo, base, cwd, candidate, required = [], changed, env = process.env }) {
  const project = gitProject(repo), identity = executionIdentity(project);
  const owner = readDeclared(project.canonical, { base, env });
  if (!owner) throw refuse('command planner requires a declared owner');
  const input = { repo: project.canonical, common: project.identity, base, cwd, candidate, required, changed, owner: snapshotDeclaration(owner), identity };
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > MAX_PLAN_BYTES) throw refuse('planning input exceeds 1 MiB');
  const id = randomUUID(), directory = path.join(project.identity, 'promote/planning', id);
  const profile = resolveGateProfile(project.canonical, env);
  fs.mkdirSync(directory, { recursive: true });
  const receipt = path.join(directory, 'planning.json'), log = path.join(directory, 'planning.log');
  writeFileAtomic(receipt, JSON.stringify({ schema: 'declared-gate-attempt/v1', id, identity: project.identity, base, candidate,
    execution_identity: identity, declaration: owner.source, jobs: [{ id: 'planning-only' }], phase: 'planning-only' }, null, 2) + '\n', 0o600);
  const fd = fs.openSync(log, 'wx', 0o600);
  let result;
  try { result = runProjectGateSync({ canonical: project.canonical, receipt,
    argv: [self, serialized, receipt], cwd: project.canonical, env: profile.env, stdio: ['ignore', fd, fd] }); }
  finally { fs.closeSync(fd); }
  const saved = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  writeFileAtomic(receipt, JSON.stringify({ ...saved, finished_at: new Date().toISOString(), exit_code: result.status,
    signal: result.signal ?? null, error: result.error?.code ?? null }, null, 2) + '\n', 0o600);
  const output = fs.readFileSync(log, 'utf8');
  if (result.error || result.status !== 0 || result.signal) throw refuse(`canonical planning refused; inspect ${receipt} and ${log}`);
  const line = output.split('\n').findLast(row => row.startsWith(marker));
  if (!line) throw refuse('canonical planning returned no bounded result');
  const plan = JSON.parse(line.slice(marker.length));
  return { ...plan, planning_evidence: { receipt, log, base, candidate, declaration: owner.source } };
}
if (isMain(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || Buffer.byteLength(process.argv[2]) > MAX_PLAN_BYTES) throw refuse('invalid planning probe arguments');
    const input = JSON.parse(process.argv[2]), receipt = process.argv[3];
    executionIdentity(gitProject(input.repo), { bound: input.identity });
    const evidence = { commands: [] };
    const result = planDeclaredGate({ ...input, selectionOnly: true, evidence,
      profile: resolveGateProfile(input.repo), onUpdate: () => {
        const saved = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        writeFileAtomic(receipt, JSON.stringify({ ...saved, evidence }, null, 2) + '\n', 0o600);
      } });
    process.stdout.write(marker + JSON.stringify(result.plan) + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
