// Offline controls only. The real launchd run is rollback-launchd.mjs itself.
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {copyProduct} from '../../lib/product-files.mjs';
import {bootoutOwned,exactPrerequisite,launchdView,payloadDifference,runWitness,sealedCopy} from '../rollback-launchd.mjs';

const product=fileURLToPath(new URL('../../',import.meta.url));
function scratch(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rollback-launchd-test-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}
function installed(home,id){
  const root=path.join(home,'releases',id);
  copyProduct(product,root);
  fs.writeFileSync(path.join(root,'.release-commit'),'2'.repeat(40)+'\n');
  execFileSync(process.execPath,[path.join(product,'herdr/releases.mjs'),'manifest',root],{cwd:root,stdio:['ignore','pipe','pipe']});
  return root;
}

test('launchd facts come from its own print, including a job that ended',()=>{
  const view=launchdView(`gui/501/dev.herdr.line.a = {
	state = not running
	program = /bin/node
	arguments = {
		/bin/node
		/r/line-service/line-service.mjs
		--once
	}
	runs = 3
	last exit code = 0
	spawn type = interactive (4)
	nice = 5
}`);
  assert.deepEqual(view,{state:'not running',program:'/bin/node',runs:3,last_exit:'0',arguments:['/bin/node','/r/line-service/line-service.mjs','--once'],spawn_type:'interactive (4)',nice:'5'});
  assert.equal(launchdView('state = running\n').last_exit,null);
});

test('a scratch copy changes only the release home, and cannot claim an unchanged payload',t=>{
  const root=scratch(t),source=installed(path.join(root,'source'),'candidate'),home=path.join(root,'home');
  fs.mkdirSync(path.join(home,'releases'),{recursive:true});
  const copy=sealedCopy(source,home,'scratch-offered');
  assert.deepEqual(payloadDifference(source,copy),['lib/releases.mjs']);
  assert.match(fs.readFileSync(path.join(copy,'lib/releases.mjs'),'utf8'),new RegExp(`releaseHome = \\(\\) => "${home}";`));
  // The line is matched exactly, so a moved home definition stops the run rather than leaving the real home in place.
  const moved=installed(path.join(root,'moved'),'candidate'),file=path.join(moved,'lib/releases.mjs');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('.local/share/herdr-monitor','.local/share/elsewhere'));
  assert.throws(()=>sealedCopy(moved,home,'scratch-moved'),/release home line not found/);
});

test('exact mode needs the named root READY in the real home itself',async t=>{
  const root=scratch(t),home=path.join(root,'home'),release=installed(home,'candidate');
  assert.deepEqual(exactPrerequisite(path.join(root,'elsewhere','candidate'),home),{ready:false,root:path.join(root,'elsewhere','candidate'),reason:'not an installed root of the real home'});
  const row=exactPrerequisite(release,home);
  assert.equal(row.ready,false);assert.match(row.reason,/acceptance-not-ready/);
  const evidence=path.join(root,'evidence');
  const result=await runWitness({oldRoot:release,candidateRoot:release,evidence,exact:true});
  assert.equal(result.status,'UNRUN');assert.equal(result.exact_candidate,'UNRUN');assert.equal(result.ready,false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(evidence,'outcome.json'))).status,'UNRUN');
  assert.equal(fs.existsSync(path.join(evidence,'steps.jsonl')),false);
});

test('cleanup only boots out a loaded target derived from its own scratch consumer',()=>{
  const scratchRoot='/scratch/run',good={directory:'/scratch/run/c/project/.org/line-service/abc',target:'gui/501/dev.herdr.line.abc'},calls=[];
  const run=loaded=>(exe,args)=>{calls.push(args);return {status:args[0]==='print'&&!loaded?113:0,stderr:''};};
  assert.equal(bootoutOwned(good,scratchRoot,run(false)),false);
  assert.deepEqual(calls.splice(0),[['print',good.target]]);
  assert.equal(bootoutOwned(good,scratchRoot,run(true)),true);
  assert.deepEqual(calls.splice(0),[['print',good.target],['bootout',good.target]]);
  for(const foreign of [{...good,directory:'/real/.org/line-service/abc'},{...good,target:'gui/501/dev.herdr.line.other'},{...good,target:'gui/501/com.rewt.herdr-brain'}])
    assert.throws(()=>bootoutOwned(foreign,scratchRoot,run(true)),/not a scratch target/);
  assert.deepEqual(calls,[]);
});
