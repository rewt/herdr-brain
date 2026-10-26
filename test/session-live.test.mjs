import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspect } from '../sessions/sessions.mjs';
import { apply } from '../sessions/apply.mjs';
import { checkAuthorization, ACTIONS } from '../sessions/authorization.mjs';
import { recordStandardSlot } from '../sessions/receipts.mjs';
import { readControllerJournal, runtimePaths, durableWrite } from '../sessions/runtime.mjs';
import { createLiveActions, readAdapterReceipts, herdrEdge } from '../sessions/live.mjs';
import { disposeStart } from '../sessions/disposition.mjs';
import { createHash } from 'node:crypto';
import { digest, persistHandoff } from '../sessions/lifecycle-evidence.mjs';
import { Receiver, addressKey } from '../messages/receiver.mjs';
import { transferSessionInbox } from '../messages/session-transfer.mjs';
import { LogJournal } from '../logs/journal.mjs';
import { nativeResumeVeto } from '../sessions/native-conversation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'sessions/sessions.mjs');
import { fixture, document } from './helpers/session-live.mjs';
const starts = f => f.read().calls.filter(a=>a[0]==='agent'&&a[1]==='start');
const mutations = f => f.read().calls.filter(a=>['start','run','create','close'].includes(a[1]));
const startInstructions = args => args.includes('--append-system-prompt-file')
  ? fs.readFileSync(args.at(-1), 'utf8') : JSON.parse(args.at(-1).slice('developer_instructions='.length));
function checkInstructionsReceipt(f) {
  const op = readControllerJournal(f.project.common).operations.at(-1), args = starts(f).at(-1);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.project.common, 'sessions/contexts', op.id + '.json')));
  const instructions = startInstructions(args);
  assert.equal(instructions, f.read().instructionsAtStart);
  assert.equal(createHash('sha256').update(instructions).digest('hex'), receipt.instructionsSha256);
  assert.equal(args.some(arg => /[\x00-\x1f\x7f-\x9f]/u.test(arg)), false);
  if (args.includes('--append-system-prompt-file')) {
    assert.equal(args.at(-1), path.join(f.project.common, 'sessions/contexts', op.id + '.instructions.md'));
    assert.equal(fs.statSync(args.at(-1)).mode & 0o777, 0o600);
    assert.equal(createHash('sha256').update(fs.readFileSync(args.at(-1))).digest('hex'), receipt.instructionsSha256);
  }
}

for (const role of ['chat','supervisor']) for (const kind of ['claude','codex']) test(role + ' ' + kind + ': real adapter and fake CLI start, observed exact binding, no replay', async t => {
  const f=fixture(t,role,kind), result=await f.apply();
  assert.equal(result.apply.state,'attempted',JSON.stringify(result)); assert.equal(result.decisions[0].decision,'KEEP',JSON.stringify(result));
  assert.equal(starts(f).length,1); assert.equal(readControllerJournal(f.project.common).operations[0].state,'acknowledged');
  assert.equal((await f.apply()).apply.state,'observed'); assert.equal(starts(f).length,1);
  assert.deepEqual(f.read().launchEnvironment,{role,name:f.binding().agentName,actor:f.binding().agentName,record:f.org});
  const args=starts(f)[0]; assert.ok(args.includes('--model'));assert.match(startInstructions(args),new RegExp(role==='chat'?'project chat':'supervisor'));
  assert.match(startInstructions(args),/Host memory: available unknown/);
  checkInstructionsReceipt(f);
});
test('fake Herdr rejects old inline multiline and control arguments before starting a session', t => {
  const f=fixture(t), herdr=herdrEdge(f.env);
  for(const control of ['\n','\r','\t','\x01','\x7f','\x85']) assert.throws(()=>herdr([
    'agent','start','inline','--kind','claude','--pane','pane','--','--append-system-prompt','first'+control+'second']),/invalid_agent_argument/);
  assert.equal(f.read().agents.length,0);
});
test('Claude instructions are exclusive per operation, including a repeated launch attempt', async t => {
  const f=fixture(t);await f.apply();checkInstructionsReceipt(f);
  const op=readControllerJournal(f.project.common).operations[0], file=starts(f)[0].at(-1), original=fs.readFileSync(file);
  f.change(s=>{s.agents=[];s.screen='fixture % ';});
  const observe=async()=>{const s=f.read();return {...s,panes:s.panes.map(p=>({...p,emptyConfirmed:true}))};};
  const actions=createLiveActions({project:f.project,workspace:'w',authorization:f.auth().file,env:f.env,permit:()=>{},observe});
  await assert.rejects(actions.start(op),{code:'EEXIST'});
  assert.deepEqual(fs.readFileSync(file),original);assert.equal(starts(f).length,1);
});
test('lost start reply holds with no second launch, even if native occupant appeared', async t => {
  const f=fixture(t);f.change(s=>s.lostStart=true);
  const first=await f.apply();assert.equal(first.decisions[0].decision,'Hold');
  await f.apply();assert.equal(starts(f).length,1);assert.equal(readAdapterReceipts(f.project.common).length,0);
});
test('pane run accepts only successful empty output and other commands remain strict JSON', t => {
  const f=fixture(t), herdr=herdrEdge(f.env);
  for(const output of ['', '  \n\t', '{"result":{}}']) {
    f.change(s=>s.paneRunOutput=output);
    assert.deepEqual(herdr(['pane','run','pane',"printf '%s%s' 'fixture' '-marker'"]),{});
  }
  f.change(s=>{s.paneRunOutput='';s.paneRunExit=7;});
  assert.throws(()=>herdr(['pane','run','pane',"printf '%s' 'marker'"]),/Herdr exited 7/);
  f.change(s=>{s.paneRunExit=0;s.paneRunOutput='malformed';});
  assert.throws(()=>herdr(['pane','run','pane',"printf '%s' 'marker'"]),SyntaxError);
  f.change(s=>s.emptyAgentList=true);
  assert.throws(()=>herdr(['agent','list']),SyntaxError);
});
test('an empty failing pane run stops the live start before launching', async t => {
  const f=fixture(t);f.change(s=>s.paneRunExit=7);
  const result=await f.apply();assert.match(result.adapterError,/Herdr exited 7/);
  assert.equal(starts(f).length,0);assert.equal(result.decisions[0].decision,'Hold');
  await f.apply();assert.equal(starts(f).length,0);
});
async function unresolvedStart(t) {
  const f=fixture(t);f.change(s=>s.paneRunOutput='malformed');
  const result=await f.apply();assert.equal(result.decisions[0].decision,'Hold');assert.equal(starts(f).length,0);
  const op=readControllerJournal(f.project.common).operations[0];
  const source=path.join(f.scratch,'failed-apply.json');fs.writeFileSync(source,JSON.stringify(result));
  const now=Date.now(); // Disposition freshness must not depend on fake-process spawn time.
  const d={schema:'session-start-disposition/v1',common:f.project.common,operationId:op.id,operationDigest:digest(op),
    target:{...op.target,terminalId:'term'},outcome:'never-started',launchInvoked:false,shellOnly:true,
    agentPresent:false,sessionPresent:false,launchPending:false,role:'supervisor',actor:'fixture-supervisor',
    observedAt:new Date(now).toISOString(),reason:'Adapter parse failed during marker probe before agent start; marker seen in shell-only pane.',
    evidence:[{file:source,sha256:createHash('sha256').update(fs.readFileSync(source)).digest('hex')}]};
  const dispositionFile=path.join(f.scratch,'disposition.json');fs.writeFileSync(dispositionFile,JSON.stringify(d));
  const options={cwd:f.cwd,workspace:'w',authorization:f.auth({now:()=>now}).file,operationId:op.id,dispositionFile,
    role:d.role,actor:d.actor,env:f.env,now:()=>now};
  return {...f,op,d,source,dispositionFile,dispose:()=>disposeStart(options),disposeOptions:options};
}
function unrelatedChurn(f) {
  f.change(s=>{
    s.workspaces.push({workspace_id:'elsewhere',worktree:{repo_key:'/other/repo',checkout_path:'/other/checkout'}});
    s.tabs.push({tab_id:'other-tab',workspace_id:'w'});
    s.panes.push({pane_id:'other-pane',tab_id:'other-tab',workspace_id:'w',terminal_id:'other-term',foreground_cwd:f.cwd});
    s.agents.push({name:'other-agent',pane_id:'other-pane',tab_id:'other-tab',workspace_id:'w',terminal_id:'other-term',cwd:f.cwd,
      agent_session:{value:'other-native'},agent_status:'idle'});
    s.agents.push({name:'foreign-agent',pane_id:'foreign-pane',tab_id:'foreign-tab',workspace_id:'elsewhere',terminal_id:'foreign-term',
      cwd:'/other/checkout',agent_session:{value:'foreign-native'},agent_status:'working'});
    // Even target-workspace display changes are outside its identity/worktree.
    s.churn={workspaces:['w','elsewhere'],agents:['other-agent','foreign-agent']};
  });
}
test('never-started disposition succeeds through unrelated workspace and agent churn', async t => {
  const f=await unresolvedStart(t);unrelatedChurn(f);
  f.change(s=>{
    s.captureObservations=true;
    s.changeOnCall={command:'workspace list',at:2,patch:{
      tabs:s.tabs.map(tab=>tab.tab_id==='other-tab'?{...tab,title:'unrelated change'}:tab),
      panes:s.panes.map(pane=>pane.pane_id==='other-pane'?{...pane,title:'unrelated change'}:pane)}};
  });
  const before=f.read(), count=mutations(f).length;
  const saved=f.dispose(), after=f.read();
  assert.equal(saved.state,'never-started');assert.equal(mutations(f).length,count);
  for(const rows of ['workspaces','agents']) {
    const observations=after.observations.filter(o=>o.result[rows]).map(o=>o.result[rows]);
    assert.equal(observations.length,2,rows);
    for(let i=0;i<observations[0].length;i++) for(const key of ['title','status','revision','focused'])
      assert.notEqual(observations[0][i][key],observations[1][i][key],`${rows}[${i}].${key}`);
  }
  assert.equal(after.calls.slice(before.calls.length).filter(a=>a[0]==='workspace'&&a[1]==='list').length,2);
  assert.equal((await f.plan()).action.kind,'start-standard-slot');
});
test('plan and apply launch the exact target through unrelated workspace and agent churn', async t => {
  const f=fixture(t);unrelatedChurn(f);
  const first=await f.plan(), result=await f.apply();
  assert.equal(first.action.kind,'start-standard-slot');
  assert.equal(result.apply.state,'attempted',JSON.stringify(result));
  assert.equal(result.decisions[0].decision,'KEEP',JSON.stringify(result));assert.equal(starts(f).length,1);
  assert.equal(f.binding().pane,'pane');
  assert.ok(f.read().agents.find(a=>a.name==='other-agent').revision>0);
});
test('never-started disposition holds on target changes between observations without changing the journal', async t => {
  const f=await unresolvedStart(t), native=f.read(), journal=fs.readFileSync(runtimePaths(f.project.common).journal);
  const topology=/changed topology or agent present/, changed=/disposition observation changed/;
  const slotName=`slot-${createHash('sha256').update(f.op.id).digest('hex').slice(0,24)}`;
  for(const [label, patch, expected, command='workspace list', at=2] of [
    ['workspace identity',{workspaces:[{...native.workspaces[0],workspace_id:'replacement'}]},topology],
    ['workspace repo',{workspaces:[{...native.workspaces[0],worktree:{...native.workspaces[0].worktree,repo_key:f.scratch}}]},topology],
    ['workspace checkout',{workspaces:[{...native.workspaces[0],worktree:{...native.workspaces[0].worktree,checkout_path:f.scratch}}]},topology],
    ['workspace worktree metadata',{workspaces:[{...native.workspaces[0],worktree:{...native.workspaces[0].worktree,is_linked_worktree:true}}]},changed],
    ['tab identity',{tabs:[{...native.tabs[0],tab_id:'replacement'}]},topology],
    ['tab metadata',{tabs:[{...native.tabs[0],title:'changed target'}]},changed],
    ['pane metadata',{panes:[{...native.panes[0],title:'changed target'}]},changed],
    ['terminal',{panes:[{...native.panes[0],terminal_id:'replacement'}]},topology],
    ['pane tab',{panes:[{...native.panes[0],tab_id:'replacement'}]},topology],
    ['extra pane in target tab',{panes:[...native.panes,{...native.panes[0],pane_id:'extra',terminal_id:'extra-term'}]},topology],
    ['foreground process',{processInfo:{shell_pid:14,foreground_processes:[{pid:14}]}},changed],
    ['agent on pane',{agents:[{name:'appeared',pane_id:'pane',terminal_id:'elsewhere'}]},topology],
    ['agent on terminal',{agents:[{name:'appeared',pane_id:'elsewhere',terminal_id:'term'}]},topology],
    ['slot-named agent',{agents:[{name:slotName,pane_id:'elsewhere',terminal_id:'elsewhere'}]},topology],
    ['pane get across observations',{paneGetFields:{title:'get-only change'}},changed],
    ['pane get around process read',{paneGetFields:{title:'get-only change'}},/sole shell, session absence or launch state is uncertain/,'pane get',2]
  ]) {
    fs.writeFileSync(f.state,JSON.stringify(native));
    f.change(s=>s.changeOnCall={command,at,patch});
    assert.throws(f.dispose,expected,label);
    assert.equal(f.read().changeOnCall.seen,at,`${label}: injected change was reached`);
    assert.deepEqual(fs.readFileSync(runtimePaths(f.project.common).journal),journal,label);
    assert.equal(mutations(f).length,mutations({read:()=>native}).length,label);
  }
});
test('explicit never-started disposition retains the intent and permits a newly planned start once', async t => {
  const f=await unresolvedStart(t);
  assert.equal((await f.plan()).decisions[0].decision,'Hold','evidence file alone never disposes an intent');
  const count=mutations(f).length;
  const saved=f.dispose();assert.equal(saved.state,'never-started');assert.equal(mutations(f).length,count);
  const j=readControllerJournal(f.project.common);assert.equal(j.operations[0].id,f.op.id);assert.deepEqual(j.operations[0].disposition.request,f.d);
  assert.equal((await f.plan()).action.kind,'start-standard-slot');
  f.change(s=>delete s.paneRunOutput);
  await f.apply();assert.equal(starts(f).length,1);assert.equal(readControllerJournal(f.project.common).operations.length,2);
  await f.apply();assert.equal(starts(f).length,1);await f.boundary();
  const reset=await f.plan();assert.equal(reset.action?.stage,'close',JSON.stringify(reset));
  assert.throws(f.dispose,/unresolved start intent/);
  const file=path.join(f.project.common,'sessions/adapter-receipts.json'), receipts=JSON.parse(fs.readFileSync(file));
  receipts.receipts.push({...receipts.receipts[0],operationId:f.op.id});fs.writeFileSync(file,JSON.stringify(receipts));
  const contradicted=await f.plan();assert.equal(contradicted.action,null);assert.match(contradicted.errors.join(';'),/contradicts/);
});
test('CLI dispose-start records only the explicitly named never-started intent before re-planning', async t => {
  const f=await unresolvedStart(t), count=mutations(f).length;
  const result=await child(['dispose-start','--project',f.cwd,'--workspace','w','--role','supervisor','--actor','fixture-supervisor',
    '--authorization',f.disposeOptions.authorization,'--operation',f.op.id,'--disposition',f.dispositionFile],f.env);
  assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).operationId,f.op.id);
  assert.equal(mutations(f).length,count);assert.equal((await f.plan()).action.kind,'start-standard-slot');
});
test('never-started disposition refuses uncertain claims, stale/foreign evidence, sources, receipts and launch context', async t => {
  const f=await unresolvedStart(t), original=fs.readFileSync(f.dispositionFile), journal=fs.readFileSync(runtimePaths(f.project.common).journal);
  const invalid=/invalid or mismatched never-started evidence/;
  for(const [edit, expected] of [
    [d=>delete d.launchInvoked,invalid], [d=>d.launchInvoked=true,invalid],
    [d=>d.shellOnly=false,invalid], [d=>d.agentPresent=true,invalid],
    [d=>d.sessionPresent=true,invalid], [d=>d.launchPending=true,invalid],
    [d=>d.operationId='other',invalid], [d=>d.operationDigest='0'.repeat(64),invalid],
    [d=>d.common=f.scratch,invalid], [d=>d.target.terminalId='changed',/changed topology or agent present/],
    [d=>d.observedAt='2020-01-01T00:00:00Z',/never-started evidence is stale/], [d=>d.evidence=[],invalid],
    [d=>d.evidence[0].sha256='0'.repeat(64),/disposition source hash changed/]
  ]) {
    const d=structuredClone(f.d);edit(d);fs.writeFileSync(f.dispositionFile,JSON.stringify(d));
    assert.throws(f.dispose,expected);assert.deepEqual(fs.readFileSync(runtimePaths(f.project.common).journal),journal);
    assert.equal((await f.plan()).decisions[0].decision,'Hold');
  }
  fs.writeFileSync(f.dispositionFile,original);
  assert.throws(()=>disposeStart({...f.disposeOptions,authorization:undefined}),/authorization/);
  assert.throws(()=>disposeStart({...f.disposeOptions,role:'worker'}),/supervisor/);
  const context=path.join(f.project.common,'sessions/contexts',f.op.id+'.json');fs.mkdirSync(path.dirname(context));fs.writeFileSync(context,'{}');
  assert.throws(f.dispose,/launch evidence/);fs.unlinkSync(context);
  const receipts=path.join(f.project.common,'sessions/adapter-receipts.json');
  fs.writeFileSync(receipts,JSON.stringify({schema:'session-adapter-receipts/v1',common:f.project.common,receipts:[{operationId:f.op.id,uid:f.op.uid,
    generation:f.op.generation,specDigest:f.op.specDigest,binding:{...f.d.target,agentName:'launched',nativeSessionId:'native'}}]}));
  assert.throws(f.dispose,/launch evidence/);fs.unlinkSync(receipts);
  fs.writeFileSync(f.source,'changed');assert.throws(f.dispose,/source hash changed/);
  assert.deepEqual(fs.readFileSync(runtimePaths(f.project.common).journal),journal);
});
test('never-started disposition and planning hold with an agent, session, pending launch, busy or changed pane', async t => {
  const f=await unresolvedStart(t), native=f.read(), original=fs.readFileSync(runtimePaths(f.project.common).journal);
  const topology=/changed topology or agent present/, shell=/sole shell, session absence or launch state is uncertain/;
  for(const [edit, expected] of [
    [s=>s.agents.push({name:'unexpected',pane_id:'pane',terminal_id:'term'}),topology],
    [s=>s.panes[0].agent='claude',shell], [s=>s.panes[0].agent_session={value:'native'},shell],
    [s=>s.panes[0].agent_session={},shell], [s=>s.panes[0].launch_pending=true,shell],
    [s=>s.panes[0].restore_error='unknown',shell], [s=>s.busy=true,shell],
    [s=>s.panes[0].terminal_id='other',topology], [s=>s.tabs=[],topology]
  ]) {
    fs.writeFileSync(f.state,JSON.stringify(native));f.change(edit);
    assert.throws(f.dispose,expected);assert.deepEqual(fs.readFileSync(runtimePaths(f.project.common).journal),original);
    assert.equal((await f.plan()).decisions[0].decision,'Hold');
  }
  fs.writeFileSync(f.state,JSON.stringify(native));f.dispose();
  f.change(s=>s.agents.push({name:'unexpected',pane_id:'pane',terminal_id:'term'}));
  assert.equal((await f.plan()).decisions[0].decision,'Hold','even a completed disposition cannot authorize starting over an agent');
});
test('fake Herdr removes only the workspace emptied by its last tab close', t => {
  const f=fixture(t);
  f.change(s=>{
    s.tabs=s.tabs.filter(t=>t.tab_id==='tab');s.panes=s.panes.filter(p=>p.tab_id==='tab');
    s.workspaces.push({workspace_id:'elsewhere'});s.tabs.push({tab_id:'elsewhere-tab',workspace_id:'elsewhere'});
  });
  herdrEdge(f.env)(['tab','close','tab']);
  assert.deepEqual(f.read().workspaces,[{workspace_id:'elsewhere'}]);
  assert.deepEqual(f.read().tabs,[{tab_id:'elsewhere-tab',workspace_id:'elsewhere'}]);
  assert.deepEqual(f.read().panes,[]);
});

test('last-tab plan and apply Hold before intent; an owned second slot permits exactly one close and respawn', async t => {
  const f=fixture(t);await f.apply();await f.boundary();
  const planFile=path.join(f.scratch,'eligible-close.json');fs.writeFileSync(planFile,JSON.stringify(await f.plan()));
  const authorization=f.auth().file;
  const journalFile=runtimePaths(f.project.common).journal, original=fs.readFileSync(journalFile), count=mutations(f).length;
  const keeper=f.read().panes.find(p=>p.tab_id==='keep-tab');
  // A tab in a different workspace cannot preserve the enrolled workspace.
  f.change(s=>{
    s.tabs.find(t=>t.tab_id==='keep-tab').workspace_id='elsewhere';
    s.panes.find(p=>p.tab_id==='keep-tab').workspace_id='elsewhere';
  });
  for (const result of [await f.plan(),await f.apply(),await apply({...f.options,authorization,planFile})]) {
    assert.equal(result.action,null);assert.equal(result.decisions[0].decision,'Hold');
    assert.equal(result.decisions[0].holdCode,'last-tab-close');
    assert.match(result.decisions[0].reason,/last-tab close refused: workspace w/);
    if(result.apply) { assert.equal(result.apply.state,'refused');assert.match(result.apply.reason,/last-tab close refused/); }
  }
  assert.deepEqual(fs.readFileSync(journalFile),original,'refusal cannot journal any lifecycle intent');
  assert.equal(mutations(f).length,count);
  f.change(s=>{
    s.tabs.find(t=>t.tab_id==='keep-tab').workspace_id='w';
    s.panes.find(p=>p.tab_id==='keep-tab').workspace_id='w';
  });
  recordStandardSlot({cwd:f.cwd,action:'adopt',uid:'second-owned-slot',actor:'fixture',why:'preserve disposable workspace',slot:{
    server:f.env.HERDR_SOCKET_PATH,workspace:'w',checkout:f.cwd,tab:'keep-tab',standardSlot:'supervisor',panes:[{pane:'keep-pane',paneSlot:'primary'}]}});
  assert.equal((await f.plan()).action?.stage,'close');
  const closed=await f.apply();assert.equal(closed.decisions[0].phase,'ClosedForReset',JSON.stringify(closed));
  assert.deepEqual(f.read().tabs,[{tab_id:'keep-tab',workspace_id:'w'}]);
  assert.deepEqual(f.read().panes,[keeper]);assert.equal(f.read().workspaces.length,1);
  assert.deepEqual(f.read().calls.filter(a=>a[1]==='close'),[['tab','close','tab']]);
  await f.apply();await f.apply();
  assert.equal(starts(f).length,2);assert.equal(f.read().tabs.length,2);
  assert.deepEqual(f.read().panes.find(p=>p.pane_id==='keep-pane'),keeper);
  assert.equal(readControllerJournal(f.project.common).operations.at(-1).state,'acknowledged');
  assert.deepEqual(f.read().calls.filter(a=>a[1]==='close'),[['tab','close','tab']]);
});

for (const reverse of [false, true]) test(`concurrent owned resets respawn the closed slot before closing the last tab (${reverse ? 'reversed' : 'original'} manifest order)`, async t => {
  const f=fixture(t);await f.apply();const chat=f.binding();
  const supervisor=JSON.parse(fs.readFileSync(path.join(root,'sessions/templates/supervisor.md'),'utf8').split('```json')[1].split('```')[0]);
  supervisor.spec.workspaceRef='w';
  const file=path.join(f.scratch,'supervisor.md');fs.writeFileSync(file,document(supervisor));f.options.files.push(file);
  recordStandardSlot({cwd:f.cwd,action:'adopt',uid:'second-owned-slot',actor:'fixture',why:'concurrent reset fixture',slot:{
    server:f.env.HERDR_SOCKET_PATH,workspace:'w',checkout:f.cwd,tab:'keep-tab',standardSlot:'supervisor',panes:[{pane:'keep-pane',paneSlot:'primary'}]}});
  assert.equal((await f.apply()).apply.state,'attempted');const sibling=f.binding();
  await f.boundary();
  f.updateEvidence(e=>{
    e.quiescence[f.uid].binding=chat;
    e.resetRequests[supervisor.metadata.uid]=structuredClone(e.resetRequests[f.uid]);
    e.resetRequests[supervisor.metadata.uid].boundary.ref='sibling-boundary';
    e.quiescence[supervisor.metadata.uid]={...structuredClone(e.quiescence[f.uid]),ref:'sibling-quiescence',binding:sibling};
  });
  if(reverse) f.options.files.reverse();
  const selected=(await f.plan()).action.operation;
  const survivor=selected.uid===f.uid?sibling:chat;
  const closed=await f.apply();assert.equal(closed.apply.state,'attempted',JSON.stringify(closed));
  assert.deepEqual(f.read().tabs,[{tab_id:survivor.tab,workspace_id:'w'}]);
  const preview=await f.plan();
  assert.equal(preview.action?.stage,'respawn',JSON.stringify(preview));
  const deferred=preview.decisions.find(d=>d.uid!==selected.uid);
  assert.equal(deferred.decision,'Defer');assert.equal(deferred.holdCode,'last-tab-close');assert.equal(deferred.action,null);
  assert.match(deferred.reason,/awaiting another slot respawn/);
  f.change(s=>s.agents.find(a=>a.name===survivor.agentName).agent_session.value='changed-native');
  const held=await f.plan();assert.equal(held.action,null,'changed ownership still fences the respawn');
  assert.equal(held.decisions.find(d=>d.uid!==selected.uid).decision,'Hold');
  f.change(s=>s.agents.find(a=>a.name===survivor.agentName).agent_session.value=survivor.nativeSessionId);
  const respawned=await f.apply();assert.equal(respawned.apply.state,'attempted',JSON.stringify(respawned));
  assert.equal(f.read().tabs.length,2);assert.equal(starts(f).length,3);
  assert.deepEqual(f.read().calls.filter(a=>a[1]==='close'),[['tab','close',selected.target.tab]]);
  const next=await f.plan();assert.equal(next.action?.stage,'close',JSON.stringify(next));
  assert.equal(next.action.operation.target.tab,survivor.tab);
  assert.equal((await f.apply()).apply.state,'attempted');
  assert.equal(f.read().workspaces.length,1);assert.equal(f.read().tabs.length,1);
  assert.deepEqual(f.read().calls.filter(a=>a[1]==='close'),[['tab','close',selected.target.tab],['tab','close',survivor.tab]]);
  const calls=f.read().calls.filter(a=>a[0]==='tab'&&['close','create'].includes(a[1]));
  assert.deepEqual(calls.map(a=>a[1]),['close','create','close']);
});

test('physical close edge refuses when the surviving tab disappears after the adapter observation', async t => {
  const f=fixture(t);await f.apply();await f.boundary();
  const preview=await f.plan(), op={...preview.action.operation,id:'edge-close',state:'close-intent',history:['reset-prepared','close-intent']};
  const journal=readControllerJournal(f.project.common);journal.operations.push(op);durableWrite(runtimePaths(f.project.common).journal,journal);
  f.change(s=>s.changeOnCall={command:'tab list',at:1,patch:{
    tabs:s.tabs.filter(t=>t.tab_id==='tab'),panes:s.panes.filter(p=>p.tab_id==='tab')}});
  const actions=createLiveActions({project:f.project,workspace:'w',authorization:f.auth().file,env:f.env,permit:()=>{},observe:async()=>f.read()});
  await assert.rejects(actions.close(op),/last-tab close refused: workspace w/);
  assert.equal(f.read().changeOnCall.seen,1,'the physical observation reached the race');
  assert.equal(f.read().calls.filter(a=>a[1]==='close').length,0);
  assert.equal(f.read().workspaces.length,1);assert.equal(readAdapterReceipts(f.project.common).some(r=>r.kind==='close'),false);
});

test('unexpected workspace removal after a physical close is named and never respawns or closes twice', async t => {
  const f=fixture(t);await f.apply();await f.boundary();
  f.change(s=>s.changeOnCall={command:'tab close',at:1,patch:{
    tabs:s.tabs.filter(t=>t.tab_id==='tab'),panes:s.panes.filter(p=>p.tab_id==='tab')}});
  const result=await f.apply();
  assert.match(result.adapterError,/unexpected workspace removal: w/);
  assert.equal(result.decisions[0].decision,'Hold');assert.match(result.decisions[0].reason,/unexpected workspace removal: w/);
  assert.equal(result.decisions[0].holdCode,'unexpected-workspace-removal');
  assert.deepEqual(f.read().workspaces,[]);assert.deepEqual(f.read().tabs,[]);assert.deepEqual(f.read().panes,[]);assert.deepEqual(f.read().agents,[]);
  assert.equal(readControllerJournal(f.project.common).operations.at(-1).state,'close-intent');
  assert.equal(readAdapterReceipts(f.project.common).some(r=>r.kind==='close'),false);
  for(let n=0;n<2;n++) {
    const held=await f.apply();assert.equal(held.decisions[0].decision,'Hold');assert.match(held.apply.reason,/unexpected workspace removal/);
  }
  assert.deepEqual(f.read().calls.filter(a=>a[1]==='close'),[['tab','close','tab']]);
  assert.equal(starts(f).length,1);assert.equal(f.read().calls.some(a=>a[1]==='create'),false);
});

test('exact tab close refuses a multi-owner tab in the real adapter', async t => {
  const f=fixture(t);await f.apply();await f.boundary();
  const preview=await f.plan(), op={...preview.action.operation,id:'manual-close',state:'close-intent',history:['reset-prepared','close-intent']};
  const journal=readControllerJournal(f.project.common);journal.operations.push(op);durableWrite(runtimePaths(f.project.common).journal,journal);
  f.change(s=>s.panes.push({...s.panes[0],pane_id:'foreign-pane'}));
  const actions=createLiveActions({project:f.project,workspace:'w',authorization:f.auth().file,env:f.env,permit:()=>{},observe:async()=>f.read()});
  await assert.rejects(actions.close(op),/multi-owner/);assert.equal(f.read().calls.filter(a=>a[1]==='close').length,0);
});
test('close and respawn bind a new incarnation, with one action per apply', async t => {
  const f=fixture(t);await f.apply();const old=f.binding();await f.boundary();
  const closed=await f.apply();assert.equal(closed.decisions[0].phase,'ClosedForReset',JSON.stringify(closed));assert.equal(starts(f).length,1);
  const spawned=await f.apply();assert.equal(starts(f).length,2,JSON.stringify(spawned));
  const b=f.binding();assert.notEqual(b.tab,old.tab);assert.notEqual(b.nativeSessionId,old.nativeSessionId);
  assert.equal(readControllerJournal(f.project.common).operations.at(-1).state,'acknowledged');
  assert.match(startInstructions(starts(f).at(-1)),/Verified handoff/);
  checkInstructionsReceipt(f);
});
for (const kind of ['claude','codex']) test(kind + ' resume delegates the same native reference only after confirmed exit', async t => {
  const f=fixture(t,'chat',kind);await f.apply();const b=f.binding(), spec=inspect(f.options).entries[0].resolvedSpec;
  if (kind === 'claude') f.persistConversation(b);
  f.change(s=>{s.agents=[];s.screen='fixture % ';});
  f.updateEvidence(e=>{
    e.losses=[{binding:b,state:'confirmed-exit',ref:'exit-receipt',processConfirmedGone:true,restore:{state:'none'},failures:0,backoffReady:true}];
    e.recovery[f.uid]={mode:'resume',contextRef:path.join(f.project.common,'sessions/contexts',readControllerJournal(f.project.common).operations[0].id+'.json'),contextVerified:true,contextHash:digest(JSON.parse(fs.readFileSync(path.join(f.project.common,'sessions/contexts',readControllerJournal(f.project.common).operations[0].id+'.json')))),nativeSessionId:b.nativeSessionId,route:spec.resolvedRoute};
  });
  const result=await f.apply();assert.equal(starts(f).length,2,JSON.stringify(result));assert.equal(f.binding().nativeSessionId,b.nativeSessionId);
  assert.notEqual(f.binding().terminalId,b.terminalId);assert.equal(readControllerJournal(f.project.common).operations.at(-1).state,'acknowledged');
  checkInstructionsReceipt(f);
});
test('Claude recovery without a persisted conversation holds at plan time before intent or native input', async t => {
  const f = fixture(t); await f.apply(); const b = f.loss();
  // Same ID elsewhere, another ID in this project and a name-based match do
  // not establish persistence of this exact conversation.
  for (const file of [f.transcript({ nativeSessionId: 'different-native' }),
    path.join(f.env.CLAUDE_CONFIG_DIR, 'projects', 'other-project', `${b.nativeSessionId}.jsonl`)]) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, b.agentName);
  }
  const journalFile = runtimePaths(f.project.common).journal, original = fs.readFileSync(journalFile), before = mutations(f);
  const reason = 'native session has no persisted conversation; resume impossible; use declared-boundary reconstruct';
  const preview = await f.plan();
  assert.equal(preview.decisions[0].decision, 'Hold'); assert.equal(preview.decisions[0].reason, reason);
  assert.equal(preview.action, null); assert.deepEqual(fs.readFileSync(journalFile), original);
  const result = await f.apply();
  assert.equal(result.decisions[0].decision, 'Hold'); assert.equal(result.decisions[0].reason, reason);
  assert.deepEqual(fs.readFileSync(journalFile), original); assert.deepEqual(mutations(f), before);
});
test('Claude recovery checks only file metadata and resumes an unreadable opaque conversation', async t => {
  const f = fixture(t); await f.apply(); const b = f.loss(), transcript = f.persistConversation(b);
  const metadata = [], lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', function(file, ...args) {
    if (String(file).startsWith(f.env.CLAUDE_CONFIG_DIR + path.sep)) metadata.push(String(file));
    return lstat.call(this, file, ...args);
  });
  for (const method of ['readFileSync', 'openSync', 'createReadStream', 'readdirSync']) {
    const original = fs[method];
    t.mock.method(fs, method, function(file, ...args) {
      assert.equal(String(file).startsWith(f.env.CLAUDE_CONFIG_DIR), false, `native conversation ${method} forbidden`);
      return original.call(this, file, ...args);
    });
  }
  const preview = await f.plan(); assert.equal(preview.action.stage, 'resume', JSON.stringify(preview));
  const result = await f.apply();
  assert.equal(result.decisions[0].decision, 'KEEP', JSON.stringify(result));
  assert.equal(starts(f).length, 2); assert.equal(f.binding().nativeSessionId, b.nativeSessionId);
  assert.notEqual(f.binding().terminalId, b.terminalId); assert.ok(metadata.length > 1);
  assert.deepEqual([...new Set(metadata)], [transcript]);
});
test('a Claude transcript disappearing after a saved plan holds without a launch', async t => {
  const f = fixture(t); await f.apply(); f.loss(); const transcript = f.persistConversation();
  const planFile = path.join(f.scratch, 'saved-resume.json'), preview = await f.plan();
  assert.equal(preview.action.stage, 'resume'); fs.writeFileSync(planFile, JSON.stringify(preview));
  const journalFile = runtimePaths(f.project.common).journal, original = fs.readFileSync(journalFile), before = mutations(f);
  fs.unlinkSync(transcript);
  const result = await apply({ ...f.options, authorization: f.auth().file, planFile });
  assert.equal(result.apply.state, 'refused'); assert.match(result.decisions[0].reason, /native session has no persisted conversation/);
  assert.deepEqual(fs.readFileSync(journalFile), original); assert.deepEqual(mutations(f), before);
});
test('Claude resume rechecks persistence after shell readiness before agent start', async t => {
  const f = fixture(t); await f.apply(); f.loss(); const transcript = f.persistConversation();
  f.change(s => { s.removeOnMarker = transcript; });
  const result = await f.apply();
  assert.match(result.adapterError, /native session has no persisted conversation/, JSON.stringify(result));
  assert.equal(result.decisions[0].decision, 'Hold'); assert.equal(starts(f).length, 1);
  assert.equal(readControllerJournal(f.project.common).operations.at(-1).state, 'resume-intent');
  await f.apply(); assert.equal(starts(f).length, 1, 'uncertain resume intent never permits a second launch');
});
test('Claude conversation lookup follows the launch environment and refuses non-files and unsafe IDs', t => {
  const f = fixture(t), checkout = path.join(f.cwd, '.worktrees', 'with.dots_and spaces');
  const participant = { binding: { checkout, nativeSessionId: 'known-native' }, spec: { resolvedRoute: { kind: 'claude', env: [] } } };
  const slug = checkout.replace(/[^A-Za-z0-9]/g, '-');
  const fileAt = config => path.join(config, 'projects', slug, 'known-native.jsonl');
  const persist = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'opaque'); };
  const fallback = fileAt(path.join(f.scratch, 'home', '.claude')); persist(fallback);
  assert.equal(nativeResumeVeto(participant, { HOME: path.join(f.scratch, 'home') }), null);
  assert.match(nativeResumeVeto(participant, { HOME: path.join(f.scratch, 'home'), CLAUDE_CONFIG_DIR: f.env.CLAUDE_CONFIG_DIR }), /no persisted conversation/);
  participant.spec.resolvedRoute.env = ['CLAUDE_CONFIG_DIR=../../../route-config'];
  const routeFile = fileAt(path.resolve(checkout, '../../../route-config')); persist(routeFile);
  assert.equal(nativeResumeVeto(participant, f.env), null);
  fs.unlinkSync(routeFile); fs.mkdirSync(routeFile);
  assert.match(nativeResumeVeto(participant, f.env), /not a regular file/);
  fs.rmdirSync(routeFile); fs.symlinkSync(fallback, routeFile);
  assert.match(nativeResumeVeto(participant, f.env), /not a regular file/);
  participant.binding.nativeSessionId = '../known-native';
  assert.match(nativeResumeVeto(participant, f.env), /location unknown/);
  participant.spec.resolvedRoute.kind = 'codex';
  assert.equal(nativeResumeVeto(participant, f.env), null);
});
test('apply refusals are read-only without authorization, under STOP/hold, on expiry/mismatch, and after plan drift', async t => {
  const f=fixture(t), before=fs.readdirSync(path.join(f.project.common,'sessions'));
  assert.equal((await apply(f.options)).apply.state,'refused');assert.deepEqual(fs.readdirSync(path.join(f.project.common,'sessions')),before);
  assert.equal(mutations(f).length,0);
  const {file,receipt}=f.auth(), planFile=path.join(f.scratch,'saved-plan.json');fs.writeFileSync(planFile,JSON.stringify(await f.plan()));
  const call=()=>apply({...f.options,authorization:file,planFile});
  for(const edit of [r=>r.workspace.workspace='another',r=>r.actions=['close'],r=>{r.createdAt='2020-01-01T00:00:00Z';r.expiresAt='2020-01-02T00:00:00Z';}]) {
    const r=structuredClone(receipt);edit(r);fs.writeFileSync(file,JSON.stringify(r));assert.equal((await call()).apply.state,'refused');
  }
  fs.writeFileSync(file,JSON.stringify(receipt));
  for(const hold of [path.join(f.org,'STOP'),path.join(f.cwd,'.lane/supervisor/HOLD-WORKER-TAB-CLOSE')]) {
    fs.mkdirSync(path.dirname(hold),{recursive:true});fs.symlinkSync('absent',hold);assert.equal((await call()).apply.state,'refused');fs.unlinkSync(hold);
  }
  f.change(s=>s.panes[0].terminal_id='drifted');assert.equal((await call()).apply.state,'refused');assert.equal(mutations(f).length,0);
});
test('authorize validates record reference, role, workspace and durable receipt without invoking Herdr', t => {
  const f=fixture(t);const sync=fs.fsyncSync,calls=[];t.mock.method(fs,'fsyncSync',fd=>{calls.push(fs.fstatSync(fd).isDirectory()?'directory':'file');return sync(fd);});
  const a=f.auth();assert.deepEqual(JSON.parse(fs.readFileSync(a.file)),a.receipt);assert.ok(calls.includes('file'));assert.ok(calls.includes('directory'));
  assert.equal(checkAuthorization({file:a.file,project:f.project,workspace:'w',env:f.env}).id,a.receipt.id);assert.equal(f.read().calls.length,0);
  for(const change of [{role:'worker'},{workspace:'absent'},{operatorDecision:{id:'ENG-1',seq:1}},{actions:['destroy']},{expiresAt:'2020-01-01T00:00:00Z'}]) assert.throws(()=>f.auth(change));
});
test('authorize refuses auto answers, supervisor decision notes and other machine or unattributed answers', t => {
  const f=fixture(t), original=f.events();
  const cases=[
    events=>{events[3].fields.meta.answered_by='auto';},
    events=>{events[2].by='fixture-supervisor';delete events[2].kind;},
    events=>{for(const e of events.slice(2))e.by='fixture-supervisor';events[3].fields.meta.answered_by='fixture-supervisor';},
    events=>{events[2].kind='supervisor-decision';},
    events=>{for(const e of events.slice(2))e.unattributed=true;},
    events=>{events[3].fields.meta.answer='no';},
  ];
  for(const edit of cases) {
    const events=structuredClone(original);edit(events);f.writeEvents(events);
    assert.throws(()=>f.auth(),/attributed human record answer yes/);
  }
  assert.equal(fs.existsSync(path.join(f.project.common,'sessions/authorizations')),false);assert.equal(f.read().calls.length,0);
});
test('operator approval binds the workspace and actions before the answer and is rechecked on use', t => {
  const f=fixture(t), original=f.events();
  for(const edit of [s=>s.workspace='another',s=>s.server='another',s=>s.common=f.scratch,s=>s.checkout=f.scratch,s=>s.actions=['close']]) {
    const events=structuredClone(original),scope=JSON.parse(events[1].meta.session_authorization);edit(scope);events[1].meta.session_authorization=JSON.stringify(scope);f.writeEvents(events);
    assert.throws(()=>f.auth(),/workspace or action scope mismatch/);
  }
  f.writeEvents(original);const a=f.auth({actions:['close']});
  assert.equal(checkAuthorization({file:a.file,project:f.project,workspace:'w',env:f.env}).id,a.receipt.id);
  const later={seq:6,at:'2026-10-16T19:00:00Z',by:'fixture-supervisor',type:'item.updated',id:'HUM-1',fields:{meta:{session_authorization:'{}'}}};
  f.writeEvents([...original,later]);
  assert.throws(()=>f.auth(),/scope recorded before/);
  assert.throws(()=>checkAuthorization({file:a.file,project:f.project,workspace:'w',env:f.env}),/scope recorded before/);
  f.writeEvents([...original,{...later,type:'item.reopened'}]);
  assert.throws(()=>checkAuthorization({file:a.file,project:f.project,workspace:'w',env:f.env}),/attributed human record answer yes/);
  f.writeEvents(original);
  execFileSync(process.execPath,[path.join(root,'bin/org.mjs'),'answer','HUM-1','no','--overrule'],{cwd:f.cwd,env:{...f.env,ORG_ACTOR:'human'},stdio:['ignore','pipe','pipe']});
  assert.throws(()=>checkAuthorization({file:a.file,project:f.project,workspace:'w',env:f.env}),/attributed human record answer yes/);
  const missing=structuredClone(original);delete missing[1].meta.session_authorization;f.writeEvents(missing);
  assert.throws(()=>f.auth(),/scope recorded before/);
  f.writeEvents([...missing,{...later,fields:{meta:{session_authorization:original[1].meta.session_authorization}}}]);
  assert.throws(()=>f.auth(),/scope recorded before/);assert.equal(f.read().calls.length,0);
});
test('real adapters reject work items, reviewers and triage before the physical seam', async t => {
  const f=fixture(t);let permits=0;const actions=createLiveActions({project:f.project,env:f.env,observe:async()=>f.read(),permit:()=>permits++});
  for(const role of ['engineer','reviewer','logs-triage']) for(const method of ['start','close','respawn','resume','transfer']) {
    await assert.rejects(actions[method]({spec:{role,intent:{kind:'work-item'}}}),/standard slots/);
  }
  assert.equal(permits,0);assert.equal(f.read().calls.length,0);
});
async function inboxFixture(t, f) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'brain-transport-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'FIXTURE'),'brain.transport-fixture/v1\n',{mode:0o600});
  const role={identity:'fixture',projectRef:f.project.common,role:{name:`project-${f.role}`,bindingRef:f.uid}};
  const sender={identity:'fixture',projectRef:f.project.common,session:{uid:'fixture-sender',incarnation:'first'}};
  const recipient=addressKey(role),receiver=new Receiver({root});
  await receiver.initialize({supervisor:role,recipients:[{address:role,consumer:'reader'}],senders:[{receipt:'sender-launch',producer:'sender',epoch:'one',address:sender,recipients:[recipient],bodyRoots:[root]}]});
  const event={schema:'brain.log/v1',eventId:'pending-1',producer:{id:'sender',epoch:'one',sequence:1},occurredAt:'2026-10-16T18:00:00Z',type:'session.message.v1',level:'info',identity:'fixture',project:{commonDir:f.project.common},correlationId:'thread-1',
    payload:{from:sender,to:[role],kind:'question',refs:[],reply_to:null,priority:'normal',reply_by:null,summary:'Pending question',body_ref:null,decision_ref:null}};
  await receiver.accept(event,{sender:'sender-launch',recipient});
  return {root,recipient,receiver,event};
}
test('respawn then stage-8 role inbox transfer retains IDs and open questions without a prompt', async t => {
  const f=fixture(t);await f.apply();const inbox=await inboxFixture(t,f);await f.boundary(['pending-1']);
  const e=JSON.parse(fs.readFileSync(f.evidence)),old=e.resetRequests[f.uid].handoff;
  const h=persistHandoff({file:old.file,markdown:fs.readFileSync(old.file,'utf8'),recordRefs:old.recordRefs,unresolvedMessageIds:old.unresolvedMessageIds,inboxCursor:`transport:${inbox.receiver.records().length}`});
  f.updateEvidence(e=>{e.resetRequests[f.uid].handoff=h;e.quiescence[f.uid].inboxCursor=h.inboxCursor;e.inbox={root:inbox.root,recipient:inbox.recipient};});
  await f.apply();await f.apply();
  assert.equal(readControllerJournal(f.project.common).operations.at(-1).state,'restarted');
  assert.equal(inbox.receiver.records().some(r=>r.type==='session-role-transfer'),false);
  const result=await f.apply();assert.equal(result.apply.state,'attempted',JSON.stringify(result));
  assert.equal(readControllerJournal(f.project.common).operations.at(-1).state,'acknowledged');
  const saved=inbox.receiver.records().filter(r=>r.type==='session-role-transfer');assert.equal(saved.length,1);assert.deepEqual(saved[0].messageIds,['pending-1']);
  assert.equal(inbox.receiver.state().entries[0].state,'accepted');assert.equal(f.read().calls.some(a=>a[1]==='prompt'),false);
  await f.apply();assert.equal(inbox.receiver.records().filter(r=>r.type==='session-role-transfer').length,1);
});
test('stage-8 transfer never redirects exact-session addresses and never mutates a live root', async t => {
  const f=fixture(t);await f.apply();const i=await inboxFixture(t,f),old=f.binding(),next={...old,terminalId:'replacement',nativeSessionId:'replacement'};
  const args={root:i.root,recipient:i.recipient,common:f.project.common,uid:f.uid,role:f.role,operationId:'transfer-fixture',previous:old,next,messageIds:['pending-1'],cursor:`transport:${i.receiver.records().length}`};
  await assert.rejects(transferSessionInbox({...args,recipient:addressKey(i.event.payload.from)}),/logical role/);
  await assert.rejects(transferSessionInbox({...args,root:f.cwd}),/fixture root/);
  const before=i.receiver.records().length;await assert.rejects(transferSessionInbox({...args,messageIds:[]}),/coverage/);assert.equal(i.receiver.records().length,before);
});
test('logs viewer uses the existing foreground viewer and never starts a model', async t => {
  const f=fixture(t,'logs');
  const journal=new LogJournal({identity:'fixture',commonDir:f.project.common,env:f.env});
  await journal.append({schema:'brain.log/v1',eventId:'fixture-project-event',producer:{id:'fixture',epoch:'one',sequence:1},
    occurredAt:'2026-10-16T18:00:00Z',level:'info',identity:'fixture',project:{commonDir:f.project.common},
    type:'herdr.observation',payload:{summary:'Fixture project event is visible'}});
  const result=await f.apply();
  assert.equal(result.decisions[0].decision,'KEEP',JSON.stringify(result));assert.equal(starts(f).length,0);assert.match(f.read().viewer,/logs\/logs.mjs.*view/);
  assert.match(f.read().viewerOutput,/herdr.observation.*Fixture project event is visible/);
  assert.equal((await f.apply()).apply.state,'observed');
});
async function child(args, env) {
  const p=spawn(process.execPath,[cli,...args],{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
  const code=await new Promise((resolve,reject)=>{p.once('exit',resolve);p.once('error',reject);});return {code,stdout,stderr};
}
test('CLI authorize only records, and apply requires explicit workspace, receipt and current saved plan', async t => {
  const f=fixture(t),sockets=new Set(),rpc=[];
  const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let pending='';socket.on('data',b=>{pending+=b;for(;;){const end=pending.indexOf('\n');if(end<0)break;const q=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);rpc.push(q.method);
    const result=q.method==='session.snapshot'?{type:'session_snapshot',snapshot:f.read()}:{agent:f.read().agents.find(a=>a.name===q.params.target)};
    socket.write(JSON.stringify({id:q.id,result})+'\n');}});});
  await new Promise(resolve=>server.listen(f.env.HERDR_SOCKET_PATH,resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  const base=['--project',f.cwd,'--workspace','w'];
  const auth=await child(['authorize',...base,'--role','supervisor','--actor','fixture-supervisor','--actions',ACTIONS.join(','),'--operator-decision','HUM-1:3','--expires',new Date(Date.now()+3600000).toISOString()],f.env);
  assert.equal(auth.code,0,auth.stderr);assert.equal(rpc.length,0);assert.equal(f.read().calls.length,0);
  const receipt=JSON.parse(auth.stdout).file;
  const noAuth=await child(['apply',f.file,...base],f.env);assert.equal(noAuth.code,1);assert.match(noAuth.stdout,/authorization receipt required/);
  const p=await child(['plan',f.file,...base,'--evidence',f.evidence],f.env);assert.equal(p.code,0,p.stderr);
  const planFile=path.join(f.scratch,'cli-plan.json');fs.writeFileSync(planFile,p.stdout);
  const noWorkspace=await child(['apply',f.file,'--project',f.cwd,'--authorization',receipt,'--plan',planFile],f.env);assert.equal(noWorkspace.code,1);
  const applied=await child(['apply',f.file,...base,'--evidence',f.evidence,'--authorization',receipt,'--plan',planFile],f.env);
  assert.equal(applied.code,0,applied.stderr+applied.stdout);assert.equal(JSON.parse(applied.stdout).apply.state,'attempted');assert.equal(starts(f).length,1);
});

test('STOP or terminal replacement during shell readiness prevents agent start', async t => {
  for (const mode of ['stopOnMarker', 'stopAfterMarkerProcess', 'replaceOnMarker']) {
    const f=fixture(t);f.change(s=>s[mode]=mode.startsWith('stop')?path.join(f.org,'STOP'):true);
    const result=await f.apply();assert.equal(starts(f).length,0,JSON.stringify(result));
    assert.equal(result.decisions[0].decision,mode.startsWith('stop')?'Observe':'Hold');
    if(mode.startsWith('stop')) fs.unlinkSync(path.join(f.org,'STOP'));
    await f.apply();assert.equal(starts(f).length,0,'uncertain intent is never replayed');
  }
});
test('unconfirmed exit, native restore ownership and changed context receipts cannot resume', async t => {
  const f=fixture(t);await f.apply();const b=f.binding(),op=readControllerJournal(f.project.common).operations[0],contextRef=path.join(f.project.common,'sessions/contexts',op.id+'.json');
  f.persistConversation(b);
  const contextHash=digest(JSON.parse(fs.readFileSync(contextRef))),spec=inspect(f.options).entries[0].resolvedSpec;
  f.change(s=>{s.agents=[];s.screen='fixture % ';});
  f.updateEvidence(e=>{e.losses=[{binding:b,state:'unknown',ref:'exit-1',processConfirmedGone:false,restore:{state:'none'},failures:0,backoffReady:true}];e.recovery[f.uid]={mode:'resume',contextRef,contextHash,contextVerified:true,nativeSessionId:b.nativeSessionId,route:spec.resolvedRoute};});
  await f.apply();assert.equal(starts(f).length,1);
  f.updateEvidence(e=>{e.losses[0].state='confirmed-exit';e.losses[0].processConfirmedGone=true;e.losses[0].restore.state='pending';});
  await f.apply();assert.equal(starts(f).length,1);
  f.updateEvidence(e=>e.losses[0].restore.state='none');fs.writeFileSync(contextRef,'{}');
  const held=await f.apply();assert.equal(starts(f).length,1);assert.equal(held.decisions[0].decision,'Hold');
  assert.match(held.adapterError,/context receipt changed/);
});
test('a copied receipt, stale saved plan and missing enrollment never grant action authority', async t => {
  const f=fixture(t),auth=f.auth(),copy=path.join(f.scratch,'copied-authorization.json');fs.copyFileSync(auth.file,copy);
  assert.equal((await f.apply(copy)).apply.state,'refused');
  const saved=await f.plan();saved.observedAt='2020-01-01T00:00:00Z';const planFile=path.join(f.scratch,'stale.json');fs.writeFileSync(planFile,JSON.stringify(saved));
  assert.equal((await apply({...f.options,authorization:auth.file,planFile})).apply.state,'refused');
  recordStandardSlot({cwd:f.cwd,action:'withdraw',uid:'fixture-slot',actor:'fixture',why:'test authorization invalidation'});
  await assert.rejects(apply({...f.options,authorization:auth.file,planFile}),/enrollment/);assert.equal(mutations(f).length,0);
});
test('the real adapter cannot invoke a launcher without its exact durable intent', async t => {
  const f=fixture(t),selected=(await f.plan()).action;
  const actions=createLiveActions({project:f.project,workspace:'w',authorization:f.auth().file,env:f.env,permit:()=>{},observe:async()=>f.read()});
  const count=mutations(f).length;
  await assert.rejects(actions.start({...selected,id:'unjournaled',state:'intent'}),/durable journal intent/);
  assert.equal(mutations(f).length,count);
});
test('stage-8 handover excludes an active receiver offer through its existing delivery lock', async t => {
  const f=fixture(t);await f.apply();const i=await inboxFixture(t,f),previous=f.binding(),next={...previous,terminalId:'next-term',nativeSessionId:'next-native'};
  const args={root:i.root,recipient:i.recipient,common:f.project.common,uid:f.uid,role:f.role,operationId:'locked-transfer',previous,next,messageIds:['pending-1'],cursor:`transport:${i.receiver.records().length}`};
  let enter,release;const entered=new Promise(resolve=>enter=resolve),paused=new Promise(resolve=>release=resolve);
  const offering=i.receiver.deliverNext({id:'held-offer',deliver:async()=>{enter();await paused;return {state:'pending',reason:'no native input'};}},async()=>({}));
  await entered;
  try {await assert.rejects(transferSessionInbox(args),error=>error.code==='EEXIST');}
  finally {release();await offering;}
  assert.equal(i.receiver.records().some(r=>r.type==='session-role-transfer'),false);
  await transferSessionInbox(args);assert.equal(i.receiver.records().filter(r=>r.type==='session-role-transfer').length,1);
});

test('A2 opted-in supervisor and chat launches remain human-typed and hook-free', async t => {
  for (const role of ['supervisor', 'chat']) {
    const f = fixture(t, role);
    fs.writeFileSync(path.join(f.project.root, '.hook-pull.json'), '{"enabled":true}\n');
    const result = await f.apply();
    assert.equal(result.decisions[0].decision, 'KEEP', JSON.stringify(result));
    assert.equal(starts(f)[0].includes('--settings'), false);
    assert.equal(fs.existsSync(path.join(f.project.common, 'sessions/hook-pull')), false);
  }
});
