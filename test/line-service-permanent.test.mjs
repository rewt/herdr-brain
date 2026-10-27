import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {fold} from '../lib/state.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {sourceRoot,serviceDirectory} from '../line-service/line-service.mjs';
import {recordReviewResults,recordReviewCompletion,reviewCompletionPlan} from '../line-service/phase1.mjs';
import {chainFor,terminalReason} from '../lib/retire.mjs';
import {readCloseoutEntries} from '../lib/closeout.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(t){
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,identity=gitProject(f.cwd).identity,base=f.git('rev-parse','HEAD');fs.writeFileSync(path.join(f.cwd,'source'),'actual changed source');f.git('add','source');f.git('commit','-qm','Source change');
  const head=f.git('rev-parse','HEAD'),workspace=path.join(f.ownerRoot,'review-lane');f.git('worktree','add','-qb','lane/review-source-1',workspace);
  const sourceText=`---\nrun: R-0\noutcome: done\nsummary: Landed source.\nartifacts:\n  - "Commit: ${head}"\n---\n`;fs.writeFileSync(path.join(org,'reports/R-0.md'),sourceText);
  const target={head,base,reportHash:hash(sourceText),evidence:path.join(org,'reports/R-0.md')},key=`ENG-1:${head}`,directory=serviceDirectory(org,identity),owner={controller:'brain',legacy:false,release:{id:'source',root:sourceRoot,identity:gitProject(sourceRoot).identity}};
  const text='---\nrun: R-1\noutcome: done\nsummary: Completed independent judgment.\nverdict: FAIL\nproposals: []\n---\nVerdict: **FAIL**\n- [Major] source:1 - correction remains independently owned.\n';fs.writeFileSync(path.join(org,'reports/R-1.md'),text);
  transact(org,()=>({add:[{type:'item.added',id:'G-1',kind:'goal',title:'Goal'}, {type:'item.added',id:'ENG-1',role:'engineer',title:'Source',parent:'G-1'},
    {type:'run.started',id:'R-0',item:'ENG-1',workspace:f.cwd},{type:'run.claimed',run:'R-0',record:org,project:identity,owner},
    {type:'report.ingested',run:'R-0',file:'reports/R-0.md',sha256:hash(sourceText),report:{outcome:'done',artifacts:[`Commit: ${head}`],extra:{},blockers:[],proposals:[]}},
    {type:'item.added',id:'REV-1',role:'reviewer',title:'Review',parent:'G-1',meta:{review_source_item:'ENG-1',review_source_run:'R-0',review_key:key,review_target:target,review_round_cap:1}},
    {type:'run.started',id:'R-1',item:'REV-1',workspace,meta:{lane:'review-source-1',agent:'reviewer',pane:'review:p',worker_workspace:'review-w',terminal_id:'review-term',agent_session_id:'review-sid'}},
    {type:'run.claimed',run:'R-1',record:org,project:identity,owner},
    {type:'report.ingested',run:'R-1',file:'reports/R-1.md',sha256:hash(text),report:{run:'R-1',outcome:'done',summary:'Judgment complete',blockers:[],proposals:[],extra:{verdict:'FAIL'}}}]}));
  const policy=JSON.parse(fs.readFileSync(path.join(f.cwd,'.lane.json')));policy.retirement={closeout_queue:true};fs.writeFileSync(path.join(f.cwd,'.lane.json'),JSON.stringify(policy));f.git('add','.lane.json');f.git('commit','-qm','Fixture closeout policy');
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({at:'2026-10-27T01:00:00Z',repo:f.cwd,org,source:sourceRoot,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  const env={...f.env};delete env.HERDR_ENV;delete env.HERDR_PANE_ID;
  const context=()=>{const events=loadEvents(org).events;return{events,state:fold(events)};},add=rows=>transact(org,()=>({add:rows}));
  return{...f,org,identity,key,directory,workspace,env,context,add,args:{repo:f.cwd,org,runId:'R-1',env}};
}
test('permanent flow completion releases a FAIL reviewer with its open linked fix and queues guarded retirement without closing product work',t=>{
  const f=fixture(t),release=noticeLock(path.join(f.directory,'pass.lock'));
  try{
    recordReviewResults(f.args);const c=f.context(),fix=[...c.state.items.values()].find(i=>i.meta.review_fix_of===f.key);assert.ok(fix);f.add([{type:'link.added',blocker:fix.id,blocked:'REV-1'}]);
    assert.equal(recordReviewCompletion(f.args).review_closed,true);assert.equal(recordReviewCompletion(f.args).review_closed,false);
    const done=f.context(),review=done.state.items.get('REV-1');assert.equal(review.closed.as,'done');assert.equal(done.state.items.get(fix.id).closed,null);assert.equal(done.state.items.get('ENG-1').closed,null);
    const entry=readCloseoutEntries(f.identity).find(e=>e.run==='R-1'&&e.signal==='landed');assert.ok(entry);assert.equal(entry.panes[0].session,'review-sid');
    const record={...done.state,reviewCompletions:done.events.filter(e=>e.type==='change.reviewed'||e.type==='item.closed')},run=done.state.runs.get('R-1'),chain=chainFor(record,run);
    assert.equal(chain.ids.has(fix.id),false);assert.equal(terminalReason(chain,{path:f.workspace,clean:true,integrated:true,lane:'review-source-1'}),null);
    f.add([{type:'item.added',id:'HUM-1',role:'human',parent:'REV-1',title:'New reserved decision',meta:{operator_reserved:true}}]);
    const held=f.context();assert.match(terminalReason(chainFor({...held.state,reviewCompletions:record.reviewCompletions},held.state.runs.get('R-1'))),/HUM-1/);
  }finally{release();}
});
test('permanent flow completion retains missing verdict held reopened foreign-owned and independently blocked reviews',t=>{
  for(const kind of ['missing','held','reopened','blocker','question','owner']){
    const f=fixture(t),release=noticeLock(path.join(f.directory,'pass.lock'));
    try{
      if(kind!=='missing')recordReviewResults(f.args);
      if(kind==='held')f.add([{type:'item.updated',id:'REV-1',fields:{meta:{hold:true}}}]);
      if(kind==='reopened')f.add([{type:'item.closed',id:'REV-1',as:'done'},{type:'item.reopened',id:'REV-1'}]);
      if(kind==='blocker')f.add([{type:'item.added',id:'ENG-99',role:'engineer',title:'Independent unfinished work'},{type:'link.added',blocker:'ENG-99',blocked:'REV-1'}]);
      if(kind==='question')f.add([{type:'item.added',id:'HUM-1',role:'human',parent:'REV-1',title:'Reserved decision',meta:{operator_reserved:true}}]);
      if(kind==='owner')f.add([{type:'run.claimed',run:'R-1',record:f.org,project:f.identity,owner:{controller:'foreign',release:{id:'source',root:sourceRoot},legacy:false}}]);
      assert.throws(()=>recordReviewCompletion(f.args),/verdict|judgment|reopened|blocker|OWNED|controller/i);assert.equal(f.context().state.items.get('REV-1').closed,null);
    }finally{release();}
  }
});
