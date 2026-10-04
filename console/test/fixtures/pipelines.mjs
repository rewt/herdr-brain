import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { actionableFixture, at } from './actionable.mjs';

export function pipelineFixture(t, state = 'running') {
  const f = actionableFixture(t);
  f.batch.phase = 'validating'; f.batch.started_at = at(5);
  f.batch.jobs[0].queued = at(6);
  f.batch.attempts[0].phase = 'prepared';
  if (['failed', 'refused', 'interrupted'].includes(state)) {
    const attempt = f.batch.attempts[0];
    if (state !== 'interrupted') {
      f.batch.phase = 'complete';
      attempt.phase = state === 'failed' ? 'red' : 'invalid';
      attempt.gate = { ...attempt.gate, finished_at: at(1), duration_s: 60, exit_code: state === 'failed' ? 1 : 0 };
    }
    const result = { id: 'job-1', run: 'R-4', topic: 'console', batch: f.batch.id, outcome: state === 'interrupted' ? 'interrupted' : 'refused',
      reason: state === 'failed' ? 'batch validation failed (exit 1)' : state === 'refused' ? 'main moved after CI' : 'batch interrupted',
      gate: state === 'interrupted' ? undefined : attempt.gate };
    f.batch.results = { 'job-1': result };
    f.queue.current = null; f.queue.results.push(result);
    if (state === 'interrupted') f.queue.interrupted = [{ id: f.batch.id, jobs: f.batch.jobs }];
  }
  if (state === 'multi') {
    for (const [i, r] of f.status.runs.slice(1).entries()) {
      r.item = 'ENG-2';
      const file = path.join(f.org, 'settle', `${r.id}.json`), saved = JSON.parse(fs.readFileSync(file));
      saved.item = 'ENG-2'; saved.review.verdict = i === 2 ? 'PASS' : 'NEEDS-WORK';
      saved.review.text = `${saved.review.verdict}\n\n## Findings\n${i === 2 ? 'All findings addressed.' : '- A correction is required.'}\n`;
      saved.review.sha256 = createHash('sha256').update(saved.review.text).digest('hex');
      saved.review.started_at = at(20 - i * 2); saved.review.finished_at = at(19 - i * 2);
      saved.review.duration_s = 60;
      if (i < 2) saved.fixRun = `R-${i + 3}`;
      fs.writeFileSync(file, JSON.stringify(saved));
    }
    f.status.items[1].runs = ['R-2', 'R-3', 'R-4'];
  }
  fs.writeFileSync(f.batchFile, JSON.stringify(f.batch)); fs.writeFileSync(f.queueFile, JSON.stringify(f.queue));
  return f;
}
