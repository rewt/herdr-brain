import { operatorWaivedGate } from '../lib/validation-declaration.mjs';

// Read-only proof of the exact reviewed diff and successful integration.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readPlainFile } from '../lib/files.mjs';

export function verifyTrainResult(result, { project, saved }) {
  try {
    if (result.source_head !== saved.head || typeof result.receipt !== 'string' ||
        path.relative(path.join(project.identity, 'promote/batches'), result.receipt).startsWith('..')) return false;
    const plan = JSON.parse(readPlainFile(result.receipt));
    const job = plan.jobs.find(j => j.id === result.id);
    if (plan.schema !== 'promotion-train/v1' || plan.identity !== project.identity || plan.id !== result.batch ||
        job?.expectedHead !== saved.head || job.run !== saved.run || job.org !== saved.org || job.topic !== saved.lane) return false;
    const attempt = plan.attempts.find(a => ['integrated', 'complete'].includes(a.phase) && a.tips[result.id] === result.tip);
    const captured = attempt?.jobs.find(j => j.id === result.id);
    // The request binds the union of component checks and deferred review
    // evidence. Older requests stored only the latter.
    const required = saved.requiredTests ?? (saved.test_evidence && !saved.test_evidence.reexecuted ? saved.test_evidence.files : undefined);
    if (required !== undefined && JSON.stringify(job.requiredTests ?? []) !== JSON.stringify(required)) return false;
    if (captured?.sourceHead !== saved.head || (!operatorWaivedGate(attempt.gate) && attempt.gate?.exit_code !== 0) || attempt.gate.signal !== null || attempt.gate.head !== attempt.tip) return false;
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
