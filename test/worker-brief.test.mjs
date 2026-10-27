import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fold } from '../lib/state.mjs';
import { DEFAULT_CONFIG } from '../lib/store.mjs';
import { renderBrief } from '../lib/render.mjs';
import { productFiles } from '../lib/product-files.mjs';
import { createWorkerBrief, validateWorkerBrief, runWorkerBrief, renderWorkerBrief, validateLineExecution, compatibleLineBrief, lineWorkerPrompt } from '../lib/worker-brief.mjs';
import { fileURLToPath } from 'node:url';
import {uncertainOutcomeDoctrine} from '../lib/uncertain-outcome.mjs';

function assignment({ role = 'engineer', address = 'supervisor-herdr', project = '/brain', extra = '' } = {}) {
  const item = { id: role === 'reviewer' ? 'REV-1' : 'ENG-1', title: 'Deliver the named change', role,
    why: 'Make worker assignments usable', accept: ['Preserve routing and native boundaries.'],
    meta: { purpose: 'A usable assignment', outcome: 'The changed brief reaches workers', scope: 'Worker prompt and generated brief', unchanged: 'Native identity and saved routes', evidence: 'node test/helpers/run.mjs test/worker-brief.test.mjs' } };
  const input = { item, ask: '/record/ask.md', askText: '# Deliver the named change', extra,
    project, org: '/record', lane: 'line-topic', route: role === 'reviewer' ? 'review' : 'engineer-max',
    harness: 'opaque-harness', reviewRoute: 'review', exception: { to: address, source: 'project promote.to' } };
  const contract = createWorkerBrief(input);
  contract.workspace = `${project}/lanes/line-topic`;
  const start = { type: 'run.started', id: 'R-1', item: item.id, workspace: contract.workspace,
    brief_path: '/record/runs/R-1/brief.md', report_path: '/record/runs/R-1/report.md',
    meta: { lane: input.lane, route: input.route, harness: input.harness, worker_brief: JSON.stringify(contract) } };
  const state = fold([{ type: 'item.added', ...item, at: '2026-10-27T00:00:00Z', seq: 1 }, { ...start, at: '2026-10-27T00:00:01Z', seq: 2 },
    { type: 'note.added', id: item.id, text: 'Premise: required fields reach worker context; attempt: initial implementation; check: selected; result: unrun.', at: '2026-10-27T00:00:02Z', seq: 3 }]);
  const run = state.runs.get('R-1');
  const job = { workerBrief: contract, repo: project, org: input.org, brief: input.ask, lane: input.lane, workspace: contract.workspace, route: input.route, declared: { harness: input.harness },
    worker: { agentName: 'actual-native-worker' }, to: 'actual-native-worker', extra };
  const render = (config = DEFAULT_CONFIG) => renderBrief(state, 'R-1', { config, cli: 'record', archive: [] });
  const prompt = brief => lineWorkerPrompt({ job, run, brief, node: '/node20', laneCLI: '/brain/lanes/lane.mjs', producer: 'Use the pinned owning record messages command.' });
  return { input, contract, state, run, job, render, prompt };
}

test('producer linked doctrine reaches current worker reviewer and decision guidance without changing saved contracts',()=>{
  for(const role of ['engineer','reviewer']){const f=assignment({role});assert.ok(f.contract.guidance.text.includes(uncertainOutcomeDoctrine));assert.ok(f.prompt(f.render()).includes(uncertainOutcomeDoctrine));}
});

for (const [project, address] of [['/brain', 'supervisor-herdr'], ['/bch', 'supervisor-opus']]) test(`actual brief and prompt carry one role page with isolated ${address} routing`, () => {
  const f = assignment({ project, address, extra: 'Keep the check focused.' }), brief = f.render(), prompt = f.prompt(brief);
  assert.equal(brief.split(f.contract.guidance.text).length, 2);
  assert.equal(prompt.split(f.contract.guidance.text).length, 2);
  assert.ok(prompt.includes(brief.trimEnd()), 'the actual prompt delivers the generated brief rather than a second role copy');
  assert.match(prompt, /use this included copy once\. Do not reload the brief or role page/);
  for (const label of ['Purpose', 'Outcome', 'Scope', 'Unchanged', 'Evidence', 'Ledger', 'Execution', 'Routing']) assert.ok(brief.includes(`${label}:`));
  assert.ok(brief.includes(`PROJECT SUPERVISOR ${address} (project promote.to)`));
  assert.ok(brief.includes(`project ${project};`));
  assert.doesNotMatch(brief, /actual-native-worker/);
  assert.match(prompt, /watcher targets actual-native-worker/);
  assert.match(prompt, /Use --to actual-native-worker/);
  assert.match(prompt, /Premise: required fields reach worker context; attempt: initial implementation/);
  assert.doesNotMatch(brief, /# Under the current land-first waiver/);
  assert.match(prompt, /single record queue-review path/);
  assert.match(prompt, /Keep the check focused\./);
  assert.equal(runWorkerBrief(f.run).harness, 'opaque-harness');
  assert.doesNotMatch(prompt, address === 'supervisor-herdr' ? /supervisor-opus/ : /supervisor-herdr/);
});

test('missing scope/execution/routing fields refuse before the launch caller proceeds and list every blocker', () => {
  const f = assignment(), contract = structuredClone(f.contract);
  delete contract.scope; delete contract.lane; delete contract.route; delete contract.workspace;
  contract.exception.to = null;
  let launched = false;
  assert.throws(() => { validateWorkerBrief(contract, { execution: true }); launched = true; }, error => {
    for (const field of ['scope', 'lane', 'route', 'workspace', 'PROJECT SUPERVISOR address']) assert.ok(error.message.includes(field));
    return error.code === 'WORKER_BRIEF_REQUIRED';
  });
  assert.equal(launched, false);
  for (const key of ['purpose', 'outcome', 'unchanged', 'evidence', 'ledger', 'role', 'harness', 'review_route', 'reply_to', 'project', 'org', 'ask', 'guidance']) {
    const bad = structuredClone(f.contract); delete bad[key];
    assert.throws(() => validateWorkerBrief(bad, { execution: true }), /missing required fields/);
  }
  assert.throws(() => createWorkerBrief({ ...f.input, exception: { to: null, source: 'unknown' } }), /configure owning project promote.to/);
  assert.throws(() => createWorkerBrief({ ...f.input, reviewRoute: '' }), /review_route/);
  assert.throws(() => createWorkerBrief({ ...f.input, item: { ...f.input.item, meta: {} }, askText: '' }), /scope/);
});

test('prelaunch validation rejects absent, changed or duplicated generated contracts and recorded bindings', () => {
  const f = assignment(), brief = f.render(), section = renderWorkerBrief(f.contract);
  assert.deepEqual(validateLineExecution({ job: f.job, run: f.run, brief }), f.contract);
  for (const changed of [brief.replace(section, ''), `${brief}\n${section}`, brief.replace(f.contract.guidance.text, 'A different role page')])
    assert.throws(() => validateLineExecution({ job: f.job, run: f.run, brief: changed }), /generated execution contract\/role guidance/);
  const changed = structuredClone(f.run); changed.workspace = '/foreign/lane';
  assert.throws(() => validateLineExecution({ job: f.job, run: changed, brief }), /workspace differs/);
  for (const key of ['repo', 'org', 'brief', 'lane', 'workspace', 'route']) {
    const job = { ...f.job, [key]: '/foreign' };
    assert.throws(() => validateLineExecution({ job, run: f.run, brief }), /actual launch .* binding/);
  }
  const missing = structuredClone(f.run); delete missing.meta.worker_brief;
  assert.throws(() => validateLineExecution({ job: f.job, run: missing, brief }), /saved\/recorded contract differs/);
  const malformed = structuredClone(f.run); malformed.meta.worker_brief = '{';
  assert.throws(() => runWorkerBrief(malformed), /worker_brief JSON/);
});

test('an older installed renderer receives the bound contract exactly once while partial or foreign briefs refuse', () => {
  const f=assignment(),current=f.render(),section=renderWorkerBrief(f.contract),legacy=current.replace(section+'\n\n','');
  const compatible=compatibleLineBrief({job:f.job,run:f.run,brief:legacy});
  assert.equal(compatible,current);
  assert.equal(compatibleLineBrief({job:f.job,run:f.run,brief:compatible}),current);
  assert.match(f.prompt(compatible),/PROJECT SUPERVISOR supervisor-herdr/);
  for(const brief of [current.replace(f.contract.guidance.text,'Changed guidance'),legacy.replace('R-1 on ENG-1','R-2 on ENG-2'),legacy+'\n## Execution contract\npartial'])
    assert.throws(()=>compatibleLineBrief({job:f.job,run:f.run,brief}),/missing required fields/);
  const job={...f.job,workspace:'/foreign'};
  assert.throws(()=>compatibleLineBrief({job,run:f.run,brief:legacy}),/actual launch workspace/);
});

test('item fields and ask supply real scope while estimates and first reds never become launch gates', () => {
  const f = assignment(), item = { ...f.input.item, created: { why: 'The recorded purpose' }, meta: { estimate: 100000, size: 100000, first_reds: 8 } };
  const contract = createWorkerBrief({ ...f.input, item, extra: 'One selected check only.' });
  assert.equal(contract.purpose, 'The recorded purpose');
  assert.equal(contract.outcome, item.accept.join('\n'));
  assert.match(contract.scope, /Full scope: \/record\/ask.md; --extra: One selected check only/);
  assert.match(contract.evidence, /no selection means unrun, never PASS/);
  assert.equal(Object.hasOwn(contract, 'failed_fixes'), false);
  const config = structuredClone(DEFAULT_CONFIG); config.budget.max_runs = 0;
  assert.match(f.render(config), /expected ≤ 0; limits are advisory/);
  assert.match(f.contract.guidance.text, /two test the premise; three, or a fix exposing a NEW issue, stop with failure log/);
  assert.match(f.contract.guidance.text, /First reds, setup slips and already-red main are recorded, not failed fixes or stop reasons/);
  assert.match(f.contract.guidance.text, /Use bare single Git commands/);
});

test('reviewer brief selects only its short page and never prescribes worker checks or landing', () => {
  const f = assignment({ role: 'reviewer' }), prompt = f.prompt(f.render());
  assert.equal(f.contract.guidance.role, 'reviewer');
  assert.match(prompt, /zero test\/build\/install\/prepare\/probe suites and no source edits/);
  assert.match(prompt, /One formal correction; later findings fix forward/);
  assert.doesNotMatch(prompt, /check --cmd|promote line-topic|Land finished OWN/);
  assert.equal(prompt.split(f.contract.guidance.text).length, 2);
});

test('legacy runs retain their original brief and the role pages ship in the existing product inventory', () => {
  const f = assignment(); delete f.run.meta.worker_brief;
  assert.equal(runWorkerBrief(f.run), null);
  const brief = f.render();
  assert.doesNotMatch(brief, /## Role guidance|## Execution contract/);
  assert.match(brief, /# Under the current land-first waiver/);
  const files = productFiles(fileURLToPath(new URL('../', import.meta.url)));
  for (const role of ['worker', 'reviewer']) {
    const file = `supervisor/roles/${role}.md`;
    assert.ok(files.includes(file));
    const words = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').trim().split(/\s+/).length;
    assert.ok(words >= 90 && words <= 150, `${role} guidance is about 100 words (${words})`);
  }
});
