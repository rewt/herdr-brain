import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture as dispatchFixture, WATCH} from '../../dispatch/test/dispatch-fixture.mjs';
import {writeFakeHerdr} from '../../lanes/test/lane-fixture.mjs';
import {setSessionEnvironment} from './session-environment.mjs';
import {spawnChild, waitForExit} from './child.mjs';
import {waitForFile} from './file-wait.mjs';
import {loadEvents, transact} from '../../lib/store.mjs';
import {fold} from '../../lib/state.mjs';
import {gitProject} from '../../lib/project.mjs';
import {createLineService, serviceDirectory} from '../../line-service/line-service.mjs';
import {runCloseoutTurn} from '../../line-service/closeout-turn.mjs';

const source=fs.realpathSync(fileURLToPath(new URL('../../',import.meta.url)));

// Compose existing native and dispatch fixtures. Only Herdr and the launch-time
// watcher are fake: lane open/dispatch, Git, record, foreground watcher and line
// consumers execute product code. No service installation or live socket exists.
export function notificationFixture(t, {startFail=false,topic='topic'}={}) {
  const f=dispatchFixture(t),bin=path.join(f.root,'bin'),lane=path.join(f.root,`lane-${topic}`);
  setSessionEnvironment(t,{HERDR_MONITOR_FLEET:f.env.HERDR_MONITOR_FLEET});
  Object.assign(f.env,{HERDR_BRAIN_ROOT:source,LANE_WORKTREE_ROOT:f.root,
    MONITOR_SUPERVISOR_AGENT:'supervisor-test',HERDR_TEST_SCRATCH_ROOTS:'[]'});
  fs.writeFileSync(path.join(f.repo,'.git/info/exclude'),'.org/\n.lane/\n.lane.json\n');
  fs.writeFileSync(path.join(f.repo,'.lane.json'),JSON.stringify({main:'main',
    routes:{engineer:{kind:'codex'},reviewer:{kind:'codex'}},
    dispatch:{max_sessions:4,max_unlanded:8},retirement:{line_service_cleanup:false}}));
  const native=writeFakeHerdr({...f,bin},{lanePath:lane,branch:`lane/${topic}`,startFail});
  // Preserve the dispatch fixture's owned watcher PID receipts and teardown.
  fs.writeFileSync(path.join(bin,'lane'),`#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nconst r=spawnSync(process.execPath,[${JSON.stringify(path.join(source,'lanes/lane.mjs'))},...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);\n`,{mode:0o755});
  const events=()=>loadEvents(f.org).events,state=()=>fold(events()),project=gitProject(f.repo);
  const add=rows=>transact(f.org,()=>({add:rows}),{actor:'notification-fixture'});
  const directory=serviceDirectory(f.org,project.identity);
  fs.mkdirSync(directory,{recursive:true});
  // A scratch installation receipt selects the existing finite owner. It does
  // not install/start launchd, change source pins, or wake a live service.
  fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({repo:f.repo,org:f.org,source,
    node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.fixture`}));
  const boundary={id:'notification-fixture',project:project.identity,repo:f.repo,org:f.org,source,
    main:'main',canonical_head:f.git(['rev-parse','HEAD'])};
  add(['line-service.cutover','line-service.phase0'].map(type=>({...boundary,type})));
  const execute=(file,args,env=f.env)=>spawnSync(process.execPath,[path.join(source,file),...args],{
    cwd:f.repo,env,encoding:'utf8',maxBuffer:16*1024*1024});
  const cli=(file,args)=>{const r=execute(file,args,{...f.env,ORG_ACTOR:'line-service'});
    assert.equal(r.status,0,r.stderr+r.stdout);return r.stdout;};
  const turn=()=>runCloseoutTurn({project,org:f.org,env:f.env,guard:()=>{},maxSteps:1,cli,measure:()=>{}});
  const commands=[];
  const pass=()=>createLineService({repo:f.repo,org:f.org,to:'supervisor-test',env:f.env,
    maxStarts:0,haltAfter:100,closeoutMeasure:()=>{},command:(exe,args,options)=>{
      commands.push(args);return spawnSync(exe,args,{...options,env:f.env,encoding:'utf8'});
    }}).pass();
  const job=()=>{const journal=f.jobs()[0];return{journal,...JSON.parse(fs.readFileSync(journal))};};
  const patchNative=change=>fs.writeFileSync(f.env.FAKE_HERDR_STATE,JSON.stringify({...native.state(),...change}));
  const writeReport=(run,outcome='done')=>{
    const report=state().runs.get(run).report_path;
    fs.mkdirSync(path.dirname(report),{recursive:true});
    fs.writeFileSync(report,`---\nrun: ${run}\noutcome: ${outcome}\nsummary: The assigned fixture work finished.\nheadline: The fixture work finished\nblockers: ${outcome==='done'?'[]':'[Specific fixture follow-up remains]'}\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
    return report;
  };
  const watchArgs=run=>[WATCH,run,'--org',f.org,'--cwd',f.repo,'--herdr',path.join(bin,'herdr'),
    '--to','supervisor-test','--record-only','--start-grace','0','--retry-after','0.02'];
  const watch=run=>spawnSync(process.execPath,watchArgs(run),{cwd:f.repo,env:f.env,encoding:'utf8'});
  // Nonterminal watcher notices keep watching. Wait for the actual durable note
  // before STOP, then join the owned child instead of polling by elapsed time.
  const watchUntil=async(run,pattern)=>{
    const child=spawnChild(t,process.execPath,watchArgs(run),{cwd:f.repo,env:f.env,stdio:['ignore','pipe','pipe']});
    const done=waitForExit(child);let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    let failure;
    try{await waitForFile(path.join(f.org,'events.jsonl'),text=>pattern.test(text));}catch(error){failure=error;}
    finally{fs.mkdirSync(path.join(f.repo,'.lane/supervisor'),{recursive:true});
      fs.writeFileSync(path.join(f.repo,'.lane/supervisor/STOP'),'fixture watcher stop');}
    const result=await done;assert.equal(result.code,0,output);
    fs.rmSync(path.join(f.repo,'.lane/supervisor/STOP'));
    if(failure)throw failure;
  };
  const assertOpened=()=>{
    assert.equal(gitProject(lane).identity,project.identity);
    assert.equal(native.state().opened,true);
    assert.ok(native.calls().some(a=>a[0]==='worktree'&&a[1]==='open'));
    assert.equal(f.git(['rev-parse','--abbrev-ref','HEAD'],lane),`lane/${topic}`);
  };
  return{...f,lane,native,events,state,project,directory,add,execute,turn,pass,commands,job,
    patchNative,writeReport,watch,watchUntil,assertOpened};
}
