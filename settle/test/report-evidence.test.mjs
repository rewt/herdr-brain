import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture } from './fixture.mjs';
import { reportIngestReceipt, remainingUnverified, RECORD_CHECK_CLAIM, LEGACY_RECORD_CHECK_CLAIM } from '../report-evidence.mjs';
const result = r => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const journal = (f, run) => JSON.parse(fs.readFileSync(path.join(f.org, 'settle', `${run}.json`), 'utf8'));

for (const preIngested of [false, true]) test(`review brief carries a matching ingest validation receipt (${preIngested ? 'previous' : 'new'} intake)`, t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  if (preIngested) {
    f.record(['ingest', f.show(run).report_path]);
    fs.writeFileSync(f.show(run).report_path, 'The source has since changed.');
  }
  const settled = result(f.settle(run)), job = journal(f, run), receipt = settled.report_ingest;
  assert.equal(settled.result, 'promotable');
  assert.deepEqual(receipt, job.reportIngest);
  assert.equal(receipt.run, run); assert.equal(receipt.report, job.report);
  assert.equal(receipt.ingested_report, path.join(f.org, f.show(run).report.file));
  for (const file of [receipt.report, receipt.ingested_report])
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), receipt.sha256);
  assert.equal(receipt.sha256, f.show(run).report.sha256);
  assert.deepEqual(receipt.validation, { result: 'passed', via: 'record ingest', equivalent_to: 'record check' });
  const brief = fs.readFileSync(path.join(f.org, 'settle', `${run}.review-brief.md`), 'utf8');
  assert.ok(brief.includes(JSON.stringify(receipt, null, 2)));
  assert.ok(brief.includes(RECORD_CHECK_CLAIM));
  assert.match(brief, /does not prove historical command execution, commit timing, tests/);
  assert.match(brief, /maximum count 0 for each command/);
  assert.match(fs.readFileSync(settled.review.path, 'utf8'), /## Re-executed\n```json\n\[\]/);
});

for (const claim of [RECORD_CHECK_CLAIM, LEGACY_RECORD_CHECK_CLAIM]) test(`matching intake discharges only report validity: ${claim}`, t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  fs.writeFileSync(path.join(f.root, 'review-result.json'), JSON.stringify({ unverified: claim }));
  const settled = result(f.settle(run));
  assert.equal(settled.result, 'promotable');
  assert.ok(fs.readFileSync(settled.review.path, 'utf8').includes(claim.replaceAll('`', '\\`')), 'public independent review is preserved');
  assert.equal(result(f.settle(run)).result, 'promotable');
  assert.equal(f.calls().filter(args => args[1] === 'start').length, 1);
  assert.equal(remainingUnverified(claim, null), claim, 'absent receipt never discharges a claim');
  assert.equal(remainingUnverified(claim.replaceAll('`', '\\`'), settled.report_ingest), '');
  assert.equal(remainingUnverified(`${claim}\n- Deployment remains unverified.`, settled.report_ingest), '- Deployment remains unverified.');
  assert.equal(remainingUnverified(`${claim} Also claims tests passed.`, settled.report_ingest), `${claim} Also claims tests passed.`);
});

for (const changed of ['report', 'ingested_report', 'reportText', 'reportHash', 'run', 'abandoned', 'missing']) test(`ingest proof refuses mismatched or absent evidence: ${changed}`, t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const settled = result(f.settle(run)), job = journal(f, run);
  const input = { ...job, runId: run, run: f.show(run) };
  if (changed === 'report' || changed === 'ingested_report') {
    const file = settled.report_ingest[changed]; fs.chmodSync(file, 0o600); fs.appendFileSync(file, '\nChanged evidence.\n');
  } else if (changed === 'run') input.run = { ...input.run, id: 'R-999' };
  else if (changed === 'abandoned') input.run = { ...input.run, abandoned: true };
  else if (changed === 'missing') input.run = { ...input.run, report: null };
  else input[changed] += 'changed';
  assert.throws(() => reportIngestReceipt(input), /does not match|do not match/);
  if (['report', 'ingested_report'].includes(changed)) {
    const retry = f.settle(run);
    assert.equal(retry.status, 1); assert.match(JSON.parse(retry.stdout).reason, /report bytes do not match/);
    assert.equal(f.calls().filter(args => args[1] === 'start').length, 1, 'damaged evidence cannot launch a reviewer');
  }
});
