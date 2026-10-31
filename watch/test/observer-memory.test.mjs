// Isolated real host + finite consumers over the existing socket adapter. This
// is a synthetic consumer witness, never an installed/live acceptance claim.
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {spawnChild,waitForExit} from '../../test/helpers/child.mjs';
import {initOrg,transact} from '../../lib/store.mjs';
import {brainOwner} from '../../lib/run-owner.mjs';
import {gitProject} from '../../lib/project.mjs';
import {nativeBinding,sharedDirectory,stepFile} from '../shared.mjs';

test('isolated shared host serves four runs with bounded finite consumers and records aggregate RSS',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'observer-memory-'))),repo=path.join(root,'project'),org=path.join(repo,'.org'),socket=path.join(root,'herdr.sock');fs.mkdirSync(repo);
  const fleet=process.env.HERDR_MONITOR_FLEET;process.env.HERDR_MONITOR_FLEET=path.join(root,'fleet');
  const source=path.resolve(import.meta.dirname,'../..');
  const env={...process.env,HERDR_SOCKET_PATH:socket,HERDR_MONITOR_FLEET:process.env.HERDR_MONITOR_FLEET};
  assert.equal(spawnSync('git',['init','-qb','main'],{cwd:repo,env}).status,0);initOrg(org);
  const project=gitProject(repo),owner=brainOwner(),agents=[],duties=[];
  fs.mkdirSync(sharedDirectory(org),{recursive:true});
  const herdr=path.join(root,'herdr');
  fs.writeFileSync(herdr,`#!${process.execPath}\nimport fs from 'node:fs';const agents=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root,'agents.json'))}));const a=agents.find(a=>a.name===process.argv[4]||a.pane_id===process.argv[4]);console.log(JSON.stringify({result:{agent:a}}));\n`,{mode:0o755});
  for(let i=1;i<=4;i++){
    const run=`R-${i}`,agent={name:`worker-${i}`,pane_id:`w1:p${i}`,workspace_id:'w1',terminal_id:`term-${i}`,cwd:repo,agent_session:{value:`session-${i}`},agent_status:'working',state_change_seq:i,completion_seq:0};agents.push(agent);
    const result=transact(org,events=>({add:[{type:'item.added',id:`ENG-${i}`,title:'Fixture work',role:'engineer'},
      {type:'run.started',id:run,item:`ENG-${i}`,workspace:repo,report_path:path.join(root,`${run}.md`),meta:{agent:agent.name,pane:agent.pane_id,worker_workspace:agent.workspace_id,terminal_id:agent.terminal_id,agent_session_id:agent.agent_session.value}},
      {type:'run.claimed',run,owner,record:org,project:project.identity}]}));
    const generation=result.added.at(-1).seq;
    duties.push({schema:'brain.shared-watch/v1',run,org,project:project.identity,repo,cwd:repo,source,ownership:{owner,generation},native:nativeBinding(agent),to:'supervisor-test',report:path.join(root,`${run}.md`),
      argv:[run,'--org',org,'--cwd',repo,'--to','supervisor-test','--herdr',herdr,'--record-only'],consumer:'watch/watch.mjs --step',wake_fact:'coarse-safety-reconciliation',stuck_owner:'supervisor-test'});
  }
  transact(org,()=>({add:Array.from({length:3000},(_,i)=>({type:'note.added',id:'ENG-1',text:`Representative retained history ${i} `+'x'.repeat(100),decision:false}))}));
  fs.writeFileSync(path.join(root,'agents.json'),JSON.stringify(agents));
  for(const d of duties)fs.writeFileSync(path.join(sharedDirectory(org),d.run+'.json'),JSON.stringify(d));
  const peers=new Set();const server=net.createServer(s=>{
    peers.add(s);s.on('close',()=>peers.delete(s));let buffer='';s.on('data',bytes=>{buffer+=bytes;let end;while((end=buffer.indexOf('\n'))>=0){const q=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
      const result=q.method==='events.subscribe'?{type:'subscription_started'}:{type:'session_snapshot',snapshot:{protocol:22,version:'fixture',agents,panes:agents.map(a=>({pane_id:a.pane_id}))}};
      s.write(JSON.stringify({id:q.id,result})+'\n');
    }});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
  t.after(async()=>{for(const s of peers)s.destroy();await new Promise(resolve=>server.close(resolve));if(fleet===undefined)delete process.env.HERDR_MONITOR_FLEET;else process.env.HERDR_MONITOR_FLEET=fleet;fs.rmSync(root,{recursive:true,force:true});});
  const child=spawnChild(t,process.execPath,[path.join(source,'watch/observer.mjs'),'--repo',repo,'--org',org,'--once'],{cwd:repo,env});
  let aggregatePeakKb=0,childPeak=0,samplingError=null;const samples=[];
  const timer=setInterval(()=>{
    const r=spawnSync('ps',['-axo','pid=,ppid=,rss='],{encoding:'utf8'});if(r.status!==0||r.error){samplingError=r.stderr||r.error?.message||`exit ${r.status}`;clearInterval(timer);return;}
    const rows=r.stdout.trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number)),ids=new Set([child.pid]);
    for(let i=0;i<5;i++)for(const [pid,ppid]of rows)if(ids.has(ppid))ids.add(pid);
    const selected=rows.filter(([pid])=>ids.has(pid)),rss=selected.reduce((n,row)=>n+row[2],0);aggregatePeakKb=Math.max(aggregatePeakKb,rss);childPeak=Math.max(childPeak,selected.length-1);samples.push(rss);
  },100);
  let result;try{result=await waitForExit(child);}finally{clearInterval(timer);}
  assert.equal(result.code,0,result.stderr||result.stdout);
  for(const d of duties)assert.equal(JSON.parse(fs.readFileSync(stepFile(org,d.run))).phase,'waiting');
  const rows=fs.readFileSync(path.join(org,'watch/observer/observations.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const reconciled=rows.filter(r=>r.action==='reconciled'),starts=rows.filter(r=>r.action==='consumer-start');
  assert.equal(starts.length,4);assert.ok(reconciled.every(r=>r.active<=2));assert.equal(reconciled.at(-1).counters.repairs,0);assert.ok(samples.length||samplingError,'sampler records either evidence or its original refusal');
  const evidence={witness:'isolated-observer-memory',runs:4,retained_notes:3000,host_rss_bytes:reconciled.map(r=>r.rss),aggregate_peak_kib:samples.length?aggregatePeakKb:null,rss_sampling:samplingError?{status:'unavailable',error:samplingError}:{status:'measured'},
    host_high_water_rss_bytes:Math.max(...reconciled.map(r=>r.high_water_rss_bytes)),watcher_high_water_rss_bytes:duties.map(d=>JSON.parse(fs.readFileSync(stepFile(org,d.run))).high_water_rss_bytes),
    peak_descendant_processes:childPeak,samples:samples.length,queue_ms:starts.map(r=>r.queue_ms),consumer_ms:rows.filter(r=>r.action==='consumer-finished').map(r=>r.duration_ms),
    repairs:0,consumer_starts:4,lost:0,duplicates:0,node:process.version,installed_live_acceptance:'UNRUN'};
  t.diagnostic(JSON.stringify(evidence));
  if(process.env.ENG1033_EVIDENCE){fs.mkdirSync(process.env.ENG1033_EVIDENCE,{recursive:true});fs.writeFileSync(path.join(process.env.ENG1033_EVIDENCE,'isolated-observer-memory.json'),JSON.stringify(evidence,null,2)+'\n');}
});
