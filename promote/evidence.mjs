// Read-only proof of the exact reviewed diff and successful integration.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readPlainFile } from '../lib/files.mjs';
import { hash, sameDeclaration, DECLARED_SCHEMA } from './declaration.mjs';
import { validDeclaredGateEvidence } from './declared-evidence.mjs';

export function verifyTrainResult(result, { project, saved }) {
  return verifyResult(result, { project, saved });
}
function verifyResult(result, { project, saved, plan, phases = ['integrated', 'complete'] }) {
  try {
    if (result.source_head !== saved.head || typeof result.receipt !== 'string' ||
        path.relative(path.join(project.identity, 'promote/batches'), result.receipt).startsWith('..')) return false;
    plan ??= JSON.parse(readPlainFile(result.receipt));
    const job = plan.jobs.find(j => j.id === result.id);
    if (!['promotion-train/v1', 'promotion-train/v2'].includes(plan.schema) || plan.identity !== project.identity || plan.id !== result.batch ||
        job?.expectedHead !== saved.head || job.run !== saved.run || job.org !== saved.org || job.topic !== saved.lane) return false;
    const attempt = plan.attempts.find(a => phases.includes(a.phase) && a.tips[result.id] === result.tip);
    const captured = attempt?.jobs.find(j => j.id === result.id);
    // The request binds the union of component checks and deferred review
    // evidence. Older requests stored only the latter.
    const required = saved.requiredTests ?? (saved.test_evidence && !saved.test_evidence.reexecuted ? saved.test_evidence.files : undefined);
    if (required !== undefined && JSON.stringify(job.requiredTests ?? []) !== JSON.stringify(required)) return false;
    if (captured?.sourceHead !== saved.head || attempt.gate?.exit_code !== 0 || attempt.gate.signal !== null || attempt.gate.head !== attempt.tip) return false;
    if (job.gate_mode && (plan.schema !== 'promotion-train/v2' || !validDeclaredGateEvidence(attempt.gate, attempt.declared_spec))) return false;
    const git = args => {
      const r = spawnSync('git', ['-C', project.canonical, ...args], { encoding: 'utf8' });
      if (r.error || r.status !== 0) throw new Error('train Git proof refused');
      return r.stdout.trim();
    };
    const log = readPlainFile(attempt.gate.log);
    if (createHash('sha256').update(JSON.stringify(log)).digest('hex') !== attempt.gate.log_hash ||
        attempt.gate.tree !== git(['rev-parse', `${attempt.tip}^{tree}`])) return false;
    git(['merge-base', '--is-ancestor', result.tip, attempt.tip]);
    const index = attempt.jobs.findIndex(j => j.id === result.id);
    const onto = index ? attempt.tips[attempt.jobs[index - 1].id] : attempt.base;
    const expected = git(['merge-tree', '--write-tree', onto, saved.head]).split('\n')[0];
    return expected === git(['rev-parse', `${result.tip}^{tree}`]) && git(['merge-base', onto, result.tip]) === onto &&
      git(['rev-list', '--merges', `${onto}..${result.tip}`]) === '';
  } catch { return false; }
}

// A declaration mismatch cannot undo an already integrated effect. Prove the
// original admission, literal gate, reviewed diff and containment before using
// its captured declaration for bookkeeping, including a lost FF response.
export function terminalTrainJobs({ file, project, jobs }) {
  const recovered = new Set();
  if (!jobs.some(job => job.gate_mode === DECLARED_SCHEMA)) return recovered;
  let plan;
  try { plan = JSON.parse(readPlainFile(file)); } catch { return recovered; }
  if (plan.schema !== 'promotion-train/v2' || plan.identity !== project.identity || !Array.isArray(plan.jobs) ||
      path.dirname(file) !== path.join(project.identity, 'promote/batches', plan.id)) return recovered;
  const branch = plan.integration_branch ?? plan.completion?.branch;
  const current = spawnSync('git', ['-C', project.canonical, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' });
  const admission = job => hash(['id', 'topic', 'expectedHead', 'run', 'org', 'gate_mode', 'declared', 'execution_identity', 'requiredTests', 'release'].map(key => job[key]));
  for (const job of jobs) {
    if (job.gate_mode !== DECLARED_SCHEMA) continue;
    const original = plan.jobs?.find(row => row.id === job.id);
    if (!original || admission(original) !== admission(job)) continue;
    const final = plan.results?.[job.id];
    const mayHaveIntegrated = (plan.attempts ?? []).some(attempt => {
      if (!attempt.jobs?.some(row => row.id === job.id)) return false;
      if (['integrated', 'complete'].includes(attempt.phase)) return true;
      if (attempt.phase !== 'validated' || attempt.gate?.exit_code !== 0) return false;
      // Validation alone is no integration checkpoint. A lost FF response
      // still requires the full proof below if its candidate is contained.
      // Unknown ancestry cannot authorize refusal-only recovery either.
      const contained = spawnSync('git', ['-C', project.canonical, 'merge-base', '--is-ancestor', attempt.tip, 'HEAD'], { encoding: 'utf8' });
      return Boolean(contained.error || contained.status !== 1);
    });
    // A refusal-only (or already refused member of a mixed batch) is just as
    // terminal as an integration. No current config or execution admission is
    // needed to finish its bookkeeping. Bind it to the saved job and candidate.
    if (!mayHaveIntegrated && ['refused', 'timeout'].includes(final?.outcome) && typeof final.reason === 'string' && final.reason && final.batch === plan.id &&
        (plan.attempts ?? []).filter(a => a.jobs?.some(j => j.id === job.id)).every(a => a.jobs.filter(j => j.id === job.id).every(j => admission(j) === admission(original) && j.sourceHead === original.expectedHead))) {
      recovered.add(job.id); continue;
    }
    if (!branch || current.error || current.status !== 0 || current.stdout.trim() !== branch) continue;
    for (const attempt of plan.attempts ?? []) {
      if (!['validated', 'integrated', 'complete'].includes(attempt.phase)) continue;
      const captured = attempt.jobs?.find(row => row.id === job.id), spec = attempt.declared_spec;
      if (!captured || admission(captured) !== admission(original) || !spec || spec.base !== attempt.base || spec.candidate !== attempt.tip ||
          spec.common !== project.identity || hash(spec.identity) !== hash(attempt.execution_identity) ||
          hash(attempt.execution_identity) !== hash(job.execution_identity) || hash(spec) !== hash(attempt.gate?.declared_gate)) continue;
      try {
        sameDeclaration(job.declared, spec.declaration);
        const contained = spawnSync('git', ['-C', project.canonical, 'merge-base', '--is-ancestor', attempt.tip, 'HEAD'], { encoding: 'utf8' });
        if (contained.error || contained.status !== 0) continue;
        if (verifyResult({ id: job.id, source_head: captured.sourceHead, tip: attempt.tips[job.id], receipt: file, batch: plan.id }, {
          project, saved: { head: job.expectedHead, run: job.run, org: job.org, lane: job.topic, requiredTests: job.requiredTests },
          plan, phases: ['validated', 'integrated', 'complete'],
        })) recovered.add(job.id);
      } catch { /* Incomplete or changed evidence remains subject to admission. */ }
    }
  }
  return recovered;
}
