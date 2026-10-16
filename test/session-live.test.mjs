import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspect } from '../sessions/sessions.mjs';
import { plan } from '../sessions/plan.mjs';
import { apply } from '../sessions/apply.mjs';
import { authorize, checkAuthorization, ACTIONS } from '../sessions/authorization.mjs';
import { recordStandardSlot } from '../sessions/receipts.mjs';
import { readControllerJournal, runtimePaths, durableWrite } from '../sessions/runtime.mjs';
import { createLiveActions, readAdapterReceipts } from '../sessions/live.mjs';
import { digest, persistHandoff } from '../sessions/lifecycle-evidence.mjs';
import { Receiver, addressKey } from '../messages/receiver.mjs';
import { transferSessionInbox } from '../messages/session-transfer.mjs';
import { LogJournal } from '../logs/journal.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'sessions/sessions.mjs');
const fake = `#!${process.execPath}
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const file = process.env.SESSION_FAKE_STATE, s = JSON.parse(fs.readFileSync(file)), a = process.argv.slice(2);
s.calls.push(a);
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const out = result => { save(); console.log(JSON.stringify({result})); };
const value = f => a[a.indexOf(f)+1];
if (a[0] === 'workspace' && a[1] === 'list') out({workspaces:s.workspaces});
else if (a[0] === 'tab' && a[1] === 'list') out({tabs:s.tabs.filter(t=>t.workspace_id===value('--workspace'))});
else if (a[0] === 'pane' && a[1] === 'list') out({panes:s.panes.filter(p=>p.workspace_id===value('--workspace'))});
else if (a[0] === 'agent' && a[1] === 'list') out({agents:s.agents});
else if (a[0] === 'agent' && a[1] === 'get') out({agent:s.agents.find(g=>g.name===a[2])});
else if (a[0] === 'pane' && a[1] === 'get') out({pane:s.panes.find(p=>p.pane_id===a[2])});
else if (a[0] === 'pane' && a[1] === 'process-info') {
  if(s.stopAfterMarkerProcess && s.calls.some(c=>c[0]==='pane'&&c[1]==='run')) fs.writeFileSync(s.stopAfterMarkerProcess,'STOP');
  out({process_info:{shell_pid:12,foreground_processes:[{pid:s.busy?13:12}]}});
}
else if (a[0] === 'pane' && a[1] === 'read') { save(); console.log(s.screen || 'fixture % '); }
else if (a[0] === 'pane' && a[1] === 'run') {
  if(a[3].startsWith('printf ')) { const parts = [...a[3].matchAll(/'([^']*)'/g)]; s.screen = parts.slice(-2).map(m=>m[1]).join('')+'\\nfixture % '; }
  else { s.viewer = a[3]; s.viewerOutput = execFileSync('/bin/sh', ['-c', a[3]], {encoding:'utf8'}); s.screen = s.viewerOutput+'\\nfixture % '; }
  if(s.stopOnMarker) fs.writeFileSync(s.stopOnMarker,'STOP');
  if(s.replaceOnMarker) s.panes.find(p=>p.pane_id===a[2]).terminal_id='other-terminal';
  out({});
} else if(a[0]==='tab' && a[1]==='create') {
  const n=++s.counter, tab={tab_id:'new-tab-'+n,workspace_id:value('--workspace')};
  const pane={pane_id:'new-pane-'+n,tab_id:tab.tab_id,workspace_id:tab.workspace_id,terminal_id:'new-term-'+n,foreground_cwd:value('--cwd')};
  s.tabs.push(tab);s.panes.push(pane);s.screen='fixture % ';out({tab,root_pane:pane});
} else if(a[0]==='tab' && a[1]==='close') {
  const ids=s.panes.filter(p=>p.tab_id===a[2]).map(p=>p.pane_id);
  s.tabs=s.tabs.filter(t=>t.tab_id!==a[2]);s.panes=s.panes.filter(p=>!ids.includes(p.pane_id));s.agents=s.agents.filter(g=>!ids.includes(g.pane_id));out({});
} else if(a[0]==='agent' && a[1]==='start') {
  s.launchEnvironment={role:process.env.MONITOR_SESSION_ROLE,name:process.env.HERDR_AGENT_NAME,actor:process.env.ORG_ACTOR,record:process.env.ORG_DIR};
  const p=s.panes.find(p=>p.pane_id===value('--pane')), n=++s.counter;
  const idx=a.indexOf('--resume'), ri=a.indexOf('resume'), native=idx>=0?a[idx+1]:ri>=0?a[ri+1]:'native-'+n;
  if(idx>=0||ri>=0) p.terminal_id='resumed-term-'+n;
  s.agents.push({name:a[2],agent:value('--kind'),pane_id:p.pane_id,tab_id:p.tab_id,workspace_id:p.workspace_id,
    terminal_id:p.terminal_id,cwd:p.foreground_cwd,agent_session:{value:native},agent_status:'idle'});
  if(s.lostStart) { save(); console.error('lost acknowledgement');process.exit(1); }
  out({});
} else { save();console.error('unexpected fake CLI '+JSON.stringify(a));process.exit(1); }
`;
const document = m => `## Manifest\n\`\`\`json\n${JSON.stringify(m)}\n\`\`\`\n`;
function fixture(t, role = 'chat') {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-session-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const cwd = path.join(scratch, 'repo'); fs.mkdirSync(cwd);
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(cwd, 'seed'), 'fixture'); git('add', '.'); git('commit', '-qm', 'fixture');
  const org = path.join(scratch, 'record'); fs.mkdirSync(org);
  fs.writeFileSync(path.join(org, 'events.jsonl'), [
    { seq: 1, at: '2026-10-16T18:00:00Z', by: 'fixture-supervisor', type: 'item.added', id: 'ENG-1', title: 'Disposable fixture', role: 'engineer' },
    { seq: 2, at: '2026-10-16T18:00:01Z', by: 'fixture-supervisor', type: 'item.added', id: 'HUM-1', title: 'Approve the scoped fixture experiment?', role: 'human', parent: 'ENG-1',
      meta: { category:'security', session_authorization:JSON.stringify({schema:'session-authorization-scope/v1',common:path.join(cwd,'.git'),
        server:path.join(scratch,'native.sock'),workspace:'w',checkout:cwd,actions:ACTIONS}) } }
  ].map(JSON.stringify).join('\n') + '\n');
  const bin = path.join(scratch, 'fake-herdr.mjs'), state = path.join(scratch, 'native.json');
  fs.writeFileSync(bin, fake, { mode: 0o755 });
  const env = { ...process.env, ORG_DIR: org, LANE_CONFIG: undefined, HERDR_BIN_PATH: bin, SESSION_FAKE_STATE: state,
    HERDR_SOCKET_PATH: path.join(scratch, 'native.sock'), HERDR_MONITOR_FLEET: path.join(scratch, 'fleet'), BRAIN_SHADOW_ROOT: path.join(scratch, 'shadow'), BRAIN_IDENTITY:'fixture' };
  // Use the real operator-answer producer, with an explicit simulated human.
  execFileSync(process.execPath,[path.join(root,'bin/org.mjs'),'answer','HUM-1','yes'],{cwd,env:{...env,ORG_ACTOR:'human'},stdio:['ignore','pipe','pipe']});
  const m = JSON.parse(fs.readFileSync(path.join(root, `sessions/templates/${role === 'logs' ? 'logs-viewer' : role}.md`), 'utf8').split('```json')[1].split('```')[0]);
  m.spec.workspaceRef = 'w';
  const file = path.join(scratch, 'manifest.md'); fs.writeFileSync(file, document(m));
  const inspection = inspect({ cwd, files: [file], env }), project = inspection.project;
  assert.equal(inspection.valid, true, JSON.stringify(inspection.diagnostics));
  const native = { server: env.HERDR_SOCKET_PATH, complete: true, workspaces: [{workspace_id:'w',worktree:{repo_key:project.common,checkout_path:cwd}}],
    tabs:[{tab_id:'tab',workspace_id:'w'}],panes:[{pane_id:'pane',tab_id:'tab',workspace_id:'w',terminal_id:'term',foreground_cwd:cwd}],agents:[],receipts:[],errors:[],counter:0,calls:[] };
  if (role === 'logs') native.panes.push({pane_id:'triage-pane',tab_id:'tab',workspace_id:'w',terminal_id:'triage-term',foreground_cwd:cwd});
  fs.writeFileSync(state, JSON.stringify(native));
  const read = () => JSON.parse(fs.readFileSync(state)), change = fn => { const s = read(); fn(s); fs.writeFileSync(state, JSON.stringify(s)); };
  recordStandardSlot({ cwd, action: 'adopt', uid: 'fixture-slot', actor: 'fixture', why: 'disposable offline test', slot: {
    server: env.HERDR_SOCKET_PATH, workspace: 'w', checkout: cwd, tab: 'tab', standardSlot: role,
    panes: role === 'logs' ? [{pane:'pane',paneSlot:'viewer'},{pane:'triage-pane',paneSlot:'triage'}] : [{pane:'pane',paneSlot:'primary'}] } });
  const evidence = path.join(scratch, 'evidence.json');
  fs.writeFileSync(evidence, JSON.stringify({schema:'session-experiment-evidence/v1',common:project.common,server:env.HERDR_SOCKET_PATH,workspace:'w',resetRequests:{},recovery:{},quiescence:{},losses:[]}));
  const updateEvidence = fn => { const e = JSON.parse(fs.readFileSync(evidence)); fn(e); fs.writeFileSync(evidence,JSON.stringify(e)); };
  const observer = { observe: async () => read(), close() {} };
  const options = {cwd,files:[file],workspace:'w',env,observer,evidence};
  const f = {scratch,cwd,org,env,state,read,change,project,file,evidence,updateEvidence,options,uid:m.metadata.uid,role};
  f.events = () => fs.readFileSync(path.join(org,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  f.writeEvents = events => fs.writeFileSync(path.join(org,'events.jsonl'),events.map(JSON.stringify).join('\n')+'\n');
  f.auth = changes => authorize({cwd,workspace:'w',actions:ACTIONS,operatorDecision:{id:'HUM-1',seq:3},expiresAt:new Date(Date.now()+3600000).toISOString(),role:'supervisor',actor:'fixture-supervisor',env,...changes});
  f.plan = () => plan(options);
  f.apply = async (authorization = f.auth().file) => {
    const planFile=path.join(scratch,'plan.json'); fs.writeFileSync(planFile,JSON.stringify(await f.plan()));
    return apply({...options,authorization,planFile});
  };
  f.binding = () => { const j=readControllerJournal(project.common); return j.incarnations.at(-1)?.binding ?? j.operations[0]?.receipt?.binding; };
  f.boundary = async (pending = []) => {
    const b=f.binding(), h=persistHandoff({file:path.join(scratch,'handoff.md'),markdown:'# Handoff\nPreserve fixture question.\n',recordRefs:['ENG-1'],unresolvedMessageIds:pending,inboxCursor:'transport:0'});
    updateEvidence(e=>{
      e.resetRequests[f.uid]={boundary:{kind:'handoff',ref:'boundary-1',declared:true,draft:'complete'},handoff:h};
      e.quiescence[f.uid]={ref:'q-1',binding:b,recordSeq:5,callbacksQuiesced:true,openWork:[],openReviews:[],inFlightDeliveries:[],pendingInboxIds:pending,recordRefs:h.recordRefs,unresolvedMessageIds:pending,inboxCursor:h.inboxCursor};
    });
  };
  return f;
}
const starts = f => f.read().calls.filter(a=>a[0]==='agent'&&a[1]==='start');
const mutations = f => f.read().calls.filter(a=>['start','run','create','close'].includes(a[1]));

for (const role of ['chat','supervisor']) test(`${role}: real adapter and fake CLI start, observed exact binding, no replay`, async t => {
  const f=fixture(t,role), result=await f.apply();
  assert.equal(result.apply.state,'attempted',JSON.stringify(result)); assert.equal(result.decisions[0].decision,'KEEP',JSON.stringify(result));
  assert.equal(starts(f).length,1); assert.equal(readControllerJournal(f.project.common).operations[0].state,'acknowledged');
  assert.equal((await f.apply()).apply.state,'observed'); assert.equal(starts(f).length,1);
  assert.deepEqual(f.read().launchEnvironment,{role,name:f.binding().agentName,actor:f.binding().agentName,record:f.org});
  const args=starts(f)[0]; assert.ok(args.includes('--model'));assert.match(args.join(' '),new RegExp(role==='chat'?'project chat':'supervisor'));
  assert.match(args.join(' '),/Host memory: available unknown/);
});
test('lost start reply holds with no second launch, even if native occupant appeared', async t => {
  const f=fixture(t);f.change(s=>s.lostStart=true);
  const first=await f.apply();assert.equal(first.decisions[0].decision,'Hold');
  await f.apply();assert.equal(starts(f).length,1);assert.equal(readAdapterReceipts(f.project.common).length,0);
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
  assert.match(starts(f).at(-1).join(' '),/Verified handoff/);
});
test('resume delegates the same native reference only after confirmed exit', async t => {
  const f=fixture(t);await f.apply();const b=f.binding(), spec=inspect(f.options).entries[0].resolvedSpec;
  f.change(s=>{s.agents=[];s.screen='fixture % ';});
  f.updateEvidence(e=>{
    e.losses=[{binding:b,state:'confirmed-exit',ref:'exit-receipt',processConfirmedGone:true,restore:{state:'none'},failures:0,backoffReady:true}];
    e.recovery[f.uid]={mode:'resume',contextRef:path.join(f.project.common,'sessions/contexts',readControllerJournal(f.project.common).operations[0].id+'.json'),contextVerified:true,contextHash:digest(JSON.parse(fs.readFileSync(path.join(f.project.common,'sessions/contexts',readControllerJournal(f.project.common).operations[0].id+'.json')))),nativeSessionId:b.nativeSessionId,route:spec.resolvedRoute};
  });
  const result=await f.apply();assert.equal(starts(f).length,2,JSON.stringify(result));assert.equal(f.binding().nativeSessionId,b.nativeSessionId);
  assert.notEqual(f.binding().terminalId,b.terminalId);assert.equal(readControllerJournal(f.project.common).operations.at(-1).state,'acknowledged');
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
