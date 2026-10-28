import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, events, effects, lanes } from './helpers/closeout-fixture.mjs';
import { fixture as dispatchFixture } from '../dispatch/test/dispatch-fixture.mjs';
import { completionSession, completedSession, closedSessionCompletion } from '../lib/completion-session.mjs';
import { resumeSource } from '../dispatch/resume-source.mjs';
import { fold } from '../lib/state.mjs';
import { fold as olderFold } from './fixtures/state-v0.mjs';
import { sessionBindFact } from './helpers/session-bind.mjs';

const session = '01a173a6-8116-7051-a945-b630511218dd';
const source = path.resolve(import.meta.dirname, '..');

for (const harness of ['codex', 'claude']) for (const late of [false, true]) {
  test(`${harness}: report ingestion snapshots ${late ? 'late-bound' : 'launch'} identity without changing old folds`, t => {
    const f = dispatchFixture(t);
    const run = f.rec(['start', f.item, '--workspace', f.repo, '--meta', 'lane=topic', '--meta', `harness=${harness}`,
      '--meta', 'agent=worker', '--meta', 'pane=w:p', '--meta', 'worker_workspace=w', '--meta', 'terminal_id=term',
      ...(late ? [] : ['--meta', `agent_session_id=${session}`])]).match(/^(R-\d+) started/m)[1];
    if (late) {
      const file = path.join(f.org, 'events.jsonl'), all = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
      const start = all.find(e => e.type === 'run.started' && e.id === run);
      Object.assign(start.meta, { dispatch_attempt: 'attempt', dispatch_journal: path.join(f.org, 'dispatch/attempt.json'),
        dispatch_project: f.git(['rev-parse', '--git-common-dir']), dispatch_record: f.org });
      const receipt = { type: 'run.updated', id: run, meta: { ...start.meta }, seq: all.at(-1).seq + 1, at: start.at };
      all.push(receipt);
      const state = fold(all);
      all.push(sessionBindFact(state.runs.get(run), state, { session, seq: receipt.seq + 1, at: Date.parse(start.at) + 1 }));
      fs.writeFileSync(file, all.map(e => JSON.stringify(e) + '\n').join(''));
    }
    const report = path.join(f.root, 'completion.md');
    fs.writeFileSync(report, `---\nrun: ${run}\noutcome: blocked\nsummary: Saved for continuation\n---\n`);
    f.rec(['ingest', report]);
    const all = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const completion = all.find(e => e.type === 'report.ingested' && e.run === run);
    assert.equal(completion.agent_session_id, session); assert.equal(completion.harness, harness);
    assert.deepEqual(completion.resume, { workspace: f.repo, lane: 'topic', branch: 'lane/topic' });
    assert.equal(completedSession([completion], session).agent_session_id, session, 'completion needs no binding join');
    const stripped = all.map(e => { const { agent_session_id, harness, resume, ...old } = e; return old; });
    assert.deepEqual(olderFold(all), olderFold(stripped));
    assert.deepEqual(fold(all).runs, fold(stripped).runs, 'current completion fingerprints also stay unchanged');
    const before = fs.readFileSync(path.join(f.org, 'events.jsonl'));
    f.rec(['ingest', report]); assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
  });
}

// Native adapters assert Brain's original-cwd/UUID contract while retaining a
// transcript. Git, record intake, retirement, lane reopening, dispatch guards
// and prompt/watch orchestration below are the actual product code. No models.
function resumeAdapters(f, harness, transcript) {
  const calls = path.join(f.scratch, 'resume-calls.jsonl'), worker = path.join(f.scratch, 'resumed-worker.json');
  const common = `import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const a=process.argv.slice(2),calls=${JSON.stringify(calls)},file=${JSON.stringify(worker)};
const emit=x=>console.log(JSON.stringify(x));
const call=(exe,args)=>{const r=spawnSync(exe,args,{encoding:'utf8'});if(r.status)throw Error(r.stderr);return r.stdout;};
fs.appendFileSync(calls,JSON.stringify({type:process.argv[1].split('/').at(-1),a})+'\\n');\n`;
  const lane = path.join(f.scratch, 'resume-lane.mjs');
  fs.writeFileSync(lane, common + `
if(a[0]==='open')process.stdout.write(call(process.execPath,[${JSON.stringify(lanes)},...a]));
if(a[0]==='prepare'&&!fs.existsSync(${JSON.stringify(f.lane)}))throw Error('worktree missing');
if(a[0]==='dispatch'){
 const job=JSON.parse(fs.readFileSync(a[a.indexOf('--dispatch-journal')+1]));
 const {resumeSessionArguments}=await import(${JSON.stringify(new URL('../lanes/routes.mjs', import.meta.url).href)});
 const argv=resumeSessionArguments({kind:${JSON.stringify(harness)},launch:['/owned/bin/ai']},job.resumeSession);
 const saved=JSON.parse(fs.readFileSync(${JSON.stringify(transcript)}));
 if(saved.cwd!==job.workspace||saved.id!==job.resumeSession)throw Error('saved context unavailable at this cwd');
 fs.appendFileSync(calls,JSON.stringify({type:'ai',cwd:job.workspace,argv,context:saved.context})+'\\n');
 const agent={name:'resumed-worker',agent:${JSON.stringify(harness)},pane_id:'new:p',workspace_id:'new:w',terminal_id:'new:t',cwd:job.workspace,agent_session:{value:job.resumeSession},agent_status:'idle'};
 fs.writeFileSync(file,JSON.stringify(agent));emit({agentName:agent.name,pane:agent.pane_id,workspaceId:agent.workspace_id,terminalId:agent.terminal_id,agentSessionId:job.resumeSession,cwd:job.workspace});
}
if(a[0]==='verify-agent'){const w=JSON.parse(fs.readFileSync(file));if(w.name!==a[1]||w.cwd!==a[2])throw Error('wrong worker');}
`);
  const native = path.join(f.scratch, 'herdr');
  fs.writeFileSync(native, `#!${process.execPath}\n` + common + `
const agent=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
if(a[0]==='agent'&&a[1]==='get'){
 if(a[2]==='supervisor-herdr')emit({result:{agent:{name:a[2],agent_status:'idle'}}});
 else if(agent?.name===a[2])emit({result:{agent}});else{console.error('agent_not_found');process.exit(1);}
}
if(a[0]==='pane'&&a[1]==='read')process.stdout.write('› Ready for a task');
if(a[0]==='pane'&&a[1]==='process-info')emit({result:{process_info:{foreground_processes:[]}}});
if(a[0]==='agent'&&a[1]==='prompt'){
 if(agent.name!==a[2])throw Error('task targeted another agent');
 const saved=JSON.parse(fs.readFileSync(${JSON.stringify(transcript)}));saved.prompts.push(a[3]);
 fs.writeFileSync(${JSON.stringify(transcript)},JSON.stringify(saved));emit({result:{}});
}
`, { mode: 0o755 });
  const watch = path.join(f.scratch, 'resume-watch.mjs');
  fs.writeFileSync(watch, common + `
const {ownerIdentity}=await import(${JSON.stringify(new URL('../lib/process-owner.mjs', import.meta.url).href)});
emit({pid:process.ppid,identity:ownerIdentity(process.ppid),log:${JSON.stringify(path.join(f.scratch, 'watch.log'))}});
`);
  return { lane, watch, calls };
}

for (const harness of ['codex', 'claude']) for (const integrated of [false, true]) {
  test(`${harness}: close and resume at the recorded path from ${integrated ? 'main' : 'the kept branch'}, delivering the new task and supervisor watch`, t => {
    const f = setup(t, { direct: true, merged: integrated });
    const all = events(f), run = all.find(e => e.type === 'run.started');
    Object.assign(run.meta, { harness, agent_session_id: session });
    fs.writeFileSync(f.eventFile, all.map(e => JSON.stringify(e) + '\n').join(''));
    f.state.agents[0].agent = harness; f.state.agents[0].agent_session.value = session;
    f.state.screen = fs.readFileSync(new URL(`../supervisor/test/fixtures/${harness}-empty.ansi`, import.meta.url), 'utf8');
    f.state.info.foreground_processes[0].name = harness;
    f.state.info.process_tree[1].command = `[${harness}]`; f.save();
    const transcript = path.join(f.scratch, `${session}.json`);
    fs.writeFileSync(transcript, JSON.stringify({ id: session, cwd: f.lane, context: 'prior conversation sentinel', prompts: [] }));
    const state = fold(events(f));
    f.append([{ type: 'report.ingested', run: 'R-1', item: 'ENG-1', report: { outcome: 'blocked', summary: 'Continue from saved context' },
      ...completionSession(state.runs.get('R-1'), state) }]);
    const result = f.drain();
    assert.equal(fs.existsSync(f.lane), false, JSON.stringify(result));
    assert.equal(Boolean(f.git(['branch', '--list', 'lane/topic'])), !integrated);
    const closed = effects(f).filter(e => e.action === 'closed' && e.tab_id);
    assert.ok(closed.length); assert.ok(closed.every(e => e.agent_session_id === session && e.harness === harness));
    const record = events(f).find(e => e.type === 'closeout.effect' && e.outcome.action === 'closed' && e.outcome.tab_id);
    assert.equal(completedSession([record], session).resume.workspace, f.lane);
    fs.writeFileSync(path.join(f.scratch, '.lane.json'), JSON.stringify({ launch: ['/owned/bin/ai'] }));
    const config = { worktree_root: f.scratch, routes: { engineer: { kind: harness } }, retirement: { closeout_queue: false } };
    fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify(config));
    const input = { events: [record], session, item: { id: 'ENG-1' }, lane: 'topic', harness, repo: f.repo };
    const resume = resumeSource(input);
    assert.equal(resume.base, integrated ? f.git(['rev-parse', 'main']) : f.head);
    assert.throws(() => resumeSource({ ...input, harness: harness === 'codex' ? 'claude' : 'codex' }), /harness differs/);
    assert.throws(() => resumeSource({ ...input, lane: 'another' }), /original recorded lane/);
    assert.throws(() => resumeSource({ ...input, item: { id: 'ENG-2' } }), /another item/);
    const adapters = resumeAdapters(f, harness, transcript);
    const brief = path.join(f.scratch, 'resume-ask.md'); fs.writeFileSync(brief, 'Resume task sentinel');
    const dispatch = spawnSync(process.execPath, [path.join(source, 'dispatch/dispatch.mjs'), 'ENG-1', '--repo', f.repo,
      '--org', f.org, '--lane', 'topic', '--route', 'engineer', '--brief', brief, '--resume-session', session,
      '--lane-cli', adapters.lane, '--watch-cli', adapters.watch], {
      cwd: f.repo, encoding: 'utf8', env: { ...f.env, MONITOR_SUPERVISOR_AGENT: 'supervisor-herdr', LANE_CONFIG: undefined },
    });
    assert.equal(dispatch.status, 0, dispatch.stderr);
    assert.equal(f.git(['rev-parse', 'HEAD'], f.lane), resume.base);
    const calls = fs.readFileSync(adapters.calls, 'utf8').trim().split('\n').map(JSON.parse);
    const ai = calls.find(c => c.type === 'ai');
    assert.equal(ai.cwd, f.lane); assert.equal(ai.context, 'prior conversation sentinel');
    assert.deepEqual(ai.argv, harness === 'codex' ? ['resume', session] : ['--resume', session]);
    const watcher = calls.find(c => c.type === 'resume-watch.mjs');
    assert.equal(watcher.a[watcher.a.indexOf('--to') + 1], 'supervisor-herdr');
    const resumed = JSON.parse(dispatch.stdout);
    const prompts = JSON.parse(fs.readFileSync(transcript)).prompts;
    assert.equal(prompts.length, 1); assert.match(prompts[0], new RegExp(`run ${resumed.run} on org item ENG-1`));
    assert.ok(prompts[0].includes(brief));
    fs.writeFileSync(path.join(f.lane, 'unsaved'), 'keep owner changes');
    assert.throws(() => resumeSource({ ...input, events: events(f) }), /unsaved author work/);
  });
}

test('conflicting session bindings never become a resumable completion identity', () => {
  const run = { id: 'R-1', workspace: '/saved/lane', meta: { harness: 'codex', agent_session_id: session } };
  const state = { sessionBindings: new Map([['R-1', [{ session }, { session: 'other' }]]]) };
  assert.equal(completionSession(run, state).agent_session_id, null);
  assert.equal(completedSession([], session), null);
});

test('a linked reviewer completion retains its own native conversation and family', () => {
  const run = { id: 'R-1', workspace: '/saved/lane', meta: { harness: 'codex', agent_session_id: session, lane: 'topic' } };
  const reviewer = '01a173a6-8116-7051-a945-b630511218de';
  const closed = closedSessionCompletion(run, {}, { session: reviewer, harness: 'claude', workspace: '/saved/lane', branch: 'lane/topic' });
  assert.equal(closed.agent_session_id, reviewer); assert.equal(closed.harness, 'claude');
  assert.deepEqual(closed.resume, { workspace: '/saved/lane', lane: 'topic', branch: 'lane/topic' });
});
