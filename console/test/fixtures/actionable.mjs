import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createFeedReader } from '../../modern/feed.mjs';

export const now = Date.parse('2026-10-04T17:00:00Z');
export const at = minutes => new Date(now - minutes * 60000).toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');

export function actionableFixture(t, { telemetry = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'actionable-console-')));
  t?.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const init = spawnSync('git', ['init', '-q', root]);
  if (init.status !== 0) throw Error('Fixture Git init failed');
  const org = path.join(root, 'org'), repoKey = path.join(root, '.git');
  const project = { name: 'Workshop', cwd: root, root, org, repoKey, git: true };
  fs.mkdirSync(path.join(org, 'reports'), { recursive: true }); fs.mkdirSync(path.join(org, 'settle'));
  fs.mkdirSync(path.join(org, 'supervisor'));
  const runs = [1, 2, 3, 4].map(n => {
    const outcome = n === 3 ? 'blocked' : 'done';
    const raw = `---\nrun: R-${n}\noutcome: ${outcome}\nsummary: The console opens durable evidence.\nheadline: Every row now opens its evidence\nblockers: ${n === 3 ? '["Waiting for the operator"]' : '[]'}\nproposals: []\nartifacts: ["console/modern/details.mjs"]\ndecisions: []\n---\n\n## What changed\n\nA **readable report** with a long paragraph that wraps to the viewport.\n\n- First verified fact\n- Second verified fact\n\n${'More evidence.\n\n'.repeat(40)}`;
    const file = `reports/R-${n}.md`; fs.writeFileSync(path.join(org, file), raw);
    return { id: `R-${n}`, item: `ENG-${n}`, workspace: root, meta: { agent: 'worker', agent_session_id: 's', lane: `lane-${n}`, harness: 'codex' },
      started: { at: at(60) }, notes: [{ at: at(15), by: 'supervisor', decision: true, text: 'Settle: promotable. Review recorded.' }],
      report: n === 1 ? null : { at: at(30), outcome, summary: 'The console opens durable evidence.', headline: 'Every row now opens its evidence', file, sha256: hash(raw) } };
  });
  const items = runs.map(r => ({ id: r.item, title: 'Make every console row useful', runs: [r.id], notes: [], status: r.report ? 'done' : 'active' }));
  const status = { runs, items };
  const reviewText = '**PASS**\nSchema: lane-review/v1\n\n## Findings\n- [Minor] The old receipt has no review clock.\n- [Minor] A second retained finding.\n\n## Non-claims\nNone\n\n<!-- lane-review-complete -->\n';
  for (const r of runs.slice(1)) fs.writeFileSync(path.join(org, 'settle', `${r.id}.json`), JSON.stringify({
    run: r.id, item: r.item, org, common: repoKey, lane: r.meta.lane, head: 'abc1234', finalHead: 'def5678', round: 1, stage: 'complete',
    reportText: fs.readFileSync(path.join(org, r.report.file), 'utf8'), review: { verdict: 'PASS', text: reviewText, sha256: hash(reviewText), route: 'review' },
    result: { result: 'promotable', reason: 'Review recorded; ready for the train' },
  }));
  const journal = runs.slice(1).map(r => ({ type: 'notice', id: `notice:${r.id}`, at: r.report.at,
    message: `[org-report] run=${r.id} item=${r.item} check=pass` }));
  fs.writeFileSync(path.join(org, 'supervisor/inbox.log'), journal.map(JSON.stringify).join('\n') + '\n');
  const events = [];
  for (const r of runs) {
    events.push({ type: 'item.added', id: r.item, title: items.find(i => i.id === r.item).title, at: at(60) },
      { type: 'run.started', id: r.id, item: r.item, workspace: root, meta: r.meta, at: at(60) });
    if (r.report) events.push({ type: 'report.ingested', run: r.id, report: r.report, sha256: r.report.sha256, file: r.report.file, at: r.report.at });
  }
  fs.writeFileSync(path.join(org, 'events.jsonl'), events.map((e, i) => JSON.stringify({ ...e, seq: i + 1, by: 'fixture' })).join('\n') + '\n');
  const batchDir = path.join(repoKey, 'promote/batches/batch-1'); fs.mkdirSync(batchDir, { recursive: true });
  const batchFile = path.join(batchDir, 'train.json'), checkLog = path.join(batchDir, 'check.log');
  fs.writeFileSync(checkLog, 'check started\nfirst suite passed\n' + Array.from({ length: 14 }, (_, i) => `suite ${i + 2} passed\n`).join(''));
  fs.writeFileSync(path.join(batchDir, 'train.log'), 'validating in /scratch: node offline-check.mjs\n');
  const gate = { command: 'node offline-check.mjs', started_at: at(2), log: checkLog };
  const batch = { id: 'batch-1', identity: repoKey, created_at: at(5), phase: 'pending', jobs: [{ id: 'job-1', topic: 'console', run: 'R-4' }],
    attempts: [{ phase: telemetry ? 'validating' : 'prepared', scratch: '/scratch', jobs: [{ id: 'job-1', topic: 'console', run: 'R-4' }], ...(telemetry ? { gate } : {}) }] };
  fs.writeFileSync(batchFile, JSON.stringify(batch));
  const result = { id: 'landed', topic: 'lane-2', run: 'R-2', batch: 'old-batch', outcome: 'promoted', reason: 'green batch fast-forward',
    tip: 'def5678', queued: at(10), integrated_at: at(1), report_to_main_s: 1740, receipt: batchFile, log: path.join(batchDir, 'train.log'),
    gate: { command: 'node offline-check.mjs', started_at: at(9), finished_at: at(2), duration_s: 420, exit_code: 0 } };
  const oldDirectory = path.join(repoKey, 'promote/batches/old-batch'); fs.mkdirSync(oldDirectory);
  result.receipt = path.join(oldDirectory, 'train.json'); result.log = path.join(oldDirectory, 'train.log');
  fs.writeFileSync(result.log, 'Earlier batch finished green.\n');
  fs.writeFileSync(result.receipt, JSON.stringify({ id: 'old-batch', identity: repoKey, phase: 'complete', jobs: [{ id: 'landed', topic: 'lane-2', run: 'R-2' }],
    attempts: [{ phase: 'complete', gate: result.gate }], results: { landed: result } }));
  const queue = { identity: repoKey, current: { id: batch.id, phase: 'batching', jobs: batch.jobs }, pending: [{ id: 'waiting', topic: 'next-lane', run: 'R-3', queued: at(1) }], results: [result] };
  const queueFile = path.join(repoKey, 'promote/queue.json'); fs.writeFileSync(queueFile, JSON.stringify(queue));
  const reader = createFeedReader();
  const agents = [{ name: 'worker', pane: 'w:p1', tab: 'w:t1', workspace: 'w', cwd: root, tool: 'codex', session: 's', status: 'working' }];
  return { root, org, project, status, batch, queue, batchFile, queueFile, checkLog, journal,
    config: { projects: [{ name: project.name, cwd: root, org }], refresh_seconds: 10 },
    deps: { identity: () => ({ key: repoKey, root, git: true }), now: () => now, details: () => ({}),
      herdrAgents: async () => ({ ok: true, agents }), herdrList: async () => [], orgStatus: async () => status,
      journal: reader.journal, train: reader.train,
      runs: () => ({ lanes: runs.map((r, i) => ({ run: r.id, item: r.item, title: items[i].title, stage: ['engineering', 'landed', 'blocked', 'finished'][i],
        provider: 'codex', agent: 'worker', pane: 'w:p1', started: r.started.at, running_seconds: 1800 })) }),
    },
  };
}
