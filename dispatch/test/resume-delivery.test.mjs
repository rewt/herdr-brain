import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareResumeDelivery, observeResumeDelivery, resumePrompt, validResumeDelivery } from '../resume-delivery.mjs';
import { resumeSessionArguments } from '../../lanes/routes.mjs';
import { observeSessionBinding } from '../session-bind.mjs';

const session = '01a173a6-8116-7051-a945-b630511218dd';
function fixture(t, harness) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resume-delivery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'lane with spaces'), env = { HOME: root }, route = { kind: harness, launch: ['/owned/bin/ai'] };
  const file = harness === 'codex' ? path.join(root, '.codex/sessions/2026/10/28', `rollout-date-${session}.jsonl`)
    : path.join(root, '.claude/projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const append = rows => fs.appendFileSync(file, rows.map(r => JSON.stringify(r) + '\n').join(''));
  append([harness === 'codex' ? { type: 'session_meta', payload: { id: session, cwd: '/retired/old-lane' } }
    : { type: 'user', sessionId: session, cwd: '/retired/old-lane', message: { content: 'old task' } }]);
  const delivery = prepareResumeDelivery({ route, session, workspace: cwd, template: 'new task for WORKER with "quotes"\nand $literal', marker: 'WORKER', env, now: () => 1000 });
  const rows = (folder = cwd, prompt = resumePrompt(delivery, 'worker')) => harness === 'codex'
    ? [{ type: 'turn_context', payload: { cwd: folder } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }]
    : [{ type: 'user', sessionId: session, cwd: folder, message: { content: [{ type: 'text', text: prompt }] } }];
  return { root, cwd, file, route, env, append, rows, delivery };
}
for (const harness of ['codex', 'claude']) {
  test(`${harness}: resume passes literal task argv and qualifies only fresh prompt in the requested folder`, t => {
    const f = fixture(t, harness), prompt = resumePrompt(f.delivery, 'worker');
    assert.deepEqual(resumeSessionArguments(f.route, session, { cwd: f.cwd, prompt }), harness === 'codex'
      ? ['resume', session, '-C', f.cwd, '--', prompt] : ['--resume', session, '--', prompt]);
    assert.equal(observeResumeDelivery(f.delivery, 'worker'), null);
    f.append(f.rows());
    const receipt = observeResumeDelivery(f.delivery, 'worker', () => 2000);
    assert.equal(receipt.session, session); assert.equal(receipt.cwd, f.cwd); assert.ok(receipt.end > receipt.offset);
    f.delivery.receipt = receipt;
    const job = { resumeDeliveryProtocol: 1, resumeDelivery: f.delivery, resumeSession: session, workspace: f.cwd, worker: { agentName: 'worker' } };
    const proposed = { session, prompted_at: f.delivery.started_at, observed_at: new Date(2100).toISOString() };
    assert.equal(validResumeDelivery(job, proposed), true);
    assert.equal(validResumeDelivery(job, { ...proposed, session: 'invented' }), false);
    f.delivery.receipt.prompt_sha256 = 'forged'; assert.equal(validResumeDelivery(job, proposed), false);
  });
  test(`${harness}: stale history, wrong task, wrong folder and replaced transcript cannot qualify delivery`, t => {
    const f = fixture(t, harness);
    f.append(f.rows(f.cwd, 'another task'));
    assert.equal(observeResumeDelivery(f.delivery, 'worker'), null);
    f.append(f.rows('/retired/old-lane'));
    assert.throws(() => observeResumeDelivery(f.delivery, 'worker'), /folder/);
    fs.renameSync(f.file, f.file + '.saved'); fs.writeFileSync(f.file, fs.readFileSync(f.file + '.saved'));
    assert.throws(() => observeResumeDelivery(f.delivery, 'worker'), /replaced/);
  });
}
test('Codex receipt requires fresh turn context, tolerates incomplete appends, and rejects ambiguous or redirected lookup', t => {
  const f = fixture(t, 'codex');
  f.append(f.rows().slice(1)); assert.equal(observeResumeDelivery(f.delivery, 'worker'), null);
  fs.appendFileSync(f.file, '{"type":"turn_context","payload":{"cwd":');
  assert.equal(observeResumeDelivery(f.delivery, 'worker'), null);
  fs.appendFileSync(f.file, JSON.stringify(f.cwd) + '}}\n');
  assert.ok(observeResumeDelivery(f.delivery, 'worker'));
  fs.copyFileSync(f.file, path.join(path.dirname(f.file), `rollout-other-${session}.jsonl`));
  const prepare = () => prepareResumeDelivery({ route: f.route, session, workspace: f.cwd, template: 'task', marker: 'worker', env: f.env });
  assert.throws(prepare, /ambiguous/);
  fs.unlinkSync(path.join(path.dirname(f.file), `rollout-other-${session}.jsonl`));
  fs.renameSync(f.file, f.file + '.saved'); fs.symlinkSync(f.file + '.saved', f.file);
  assert.throws(prepare, /missing|redirected/);
});
test('Codex task and folder must belong to the same new turn', t => {
  const f = fixture(t, 'codex');
  f.append([{type:'event_msg',payload:{type:'task_started',turn_id:'earlier'}},
    {type:'turn_context',payload:{cwd:f.cwd,turn_id:'earlier'}},
    {type:'event_msg',payload:{type:'task_started',turn_id:'task'}}, ...f.rows().slice(1)]);
  assert.equal(observeResumeDelivery(f.delivery,'worker'),null,'an earlier turn context cannot qualify the task');
  f.append([{type:'event_msg',payload:{type:'task_started',turn_id:'unrelated'}},
    {type:'turn_context',payload:{cwd:f.cwd,turn_id:'unrelated'}}]);
  assert.equal(observeResumeDelivery(f.delivery,'worker'),null,'a later unrelated folder cannot qualify the task');
  f.append([{type:'event_msg',payload:{type:'task_started',turn_id:'delivered'}}, ...f.rows()]);
  assert.ok(observeResumeDelivery(f.delivery,'worker'));
});
test('qualification cannot bind a native ID alone, renew an expired deadline, or survive process replacement', async () => {
  for (const mode of ['qualified', 'missing', 'replacement', 'expired']) {
    let time = 1000, commits = 0, reads = 0;
    const process = { pid: 123, identity: 'original birth' };
    const job = { run: 'R-1', sessionBinding: { status: 'observing', process, receipt: {}, prompted_at: new Date(time).toISOString(), deadline: new Date(2000).toISOString() } };
    await observeSessionBinding({ job, save() {}, now: () => time, monotonic: () => time,
      observe: () => { reads++; return { process: mode === 'replacement' ? { ...process, identity: 'replacement birth' } : process, session: session }; },
      qualify: () => mode === 'missing' ? null : (mode === 'expired' ? (time = 3000, session) : session),
      record: () => commits++, pause: async ms => { time += ms; } });
    assert.equal(commits, mode === 'qualified' ? 1 : 0, mode);
    assert.equal(job.sessionBinding.status, mode === 'qualified' ? 'bound' : 'unbound', mode);
    const savedReads = reads;
    await observeSessionBinding({ job, save() {}, observe: () => { throw Error('must not reobserve'); }, record: () => commits++ });
    assert.equal(reads, savedReads);
  }
});
