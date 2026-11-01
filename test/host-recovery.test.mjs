import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fold} from '../lib/state.mjs';
import {hostRecoveryNotices} from '../line-service/host-recovery.mjs';
import {loginRegistration,inspectLoginRegistration,createLoginRegistration} from '../line-service/login-registration.mjs';

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'host-recovery-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const repo=path.join(root,'repo'),org=path.join(root,'org'),directory=path.join(org,'line-service','a'.repeat(20));
  fs.mkdirSync(repo);fs.mkdirSync(directory,{recursive:true});
  const identity=path.join(repo,'.git'),file=path.join(directory,'service.plist');fs.writeFileSync(file,'original plist');
  const installation={repo,org,file,source:root,node:process.execPath,recipient:'supervisor-fixture'};
  const events=[{type:'item.added',id:'ENG-1',role:'engineer',title:'Recover'},
    {type:'run.started',id:'R-1',item:'ENG-1',workspace:repo,meta:{dispatch_project:identity,dispatch_journal:path.join(org,'dispatch/original.json'),agent:'original-worker',pane:'original-pane',watcher_pid:123,watcher_identity:'original-birth'}}];
  const options={repo,org,identity,directory,installation,state:fold(events),alive:()=>false,loaded:false};
  return {root,repo,org,directory,file,installation,events,options,notices:()=>hostRecoveryNotices(options)};
}

test('login registration is read-only to inspect and never replaces an existing or redirected entry',t=>{
  const f=fixture(t),login=loginRegistration('dev.herdr.line.'+'a'.repeat(20),f.file,f.root);
  assert.equal(inspectLoginRegistration(login).registered,false);assert.equal(fs.existsSync(path.dirname(login.file)),false);
  assert.equal(createLoginRegistration(login).registered,true);assert.equal(fs.readlinkSync(login.file),f.file);
  assert.throws(()=>createLoginRegistration(login),/already exists/);
  fs.unlinkSync(login.file);fs.writeFileSync(login.file,'foreign');assert.throws(()=>inspectLoginRegistration(login),/differs/);
  assert.equal(fs.readFileSync(login.file,'utf8'),'foreign');
  fs.unlinkSync(login.file);fs.symlinkSync(f.repo,login.file);assert.throws(()=>inspectLoginRegistration(login),/differs/);
  fs.unlinkSync(login.file);fs.rmdirSync(path.dirname(login.file));fs.symlinkSync(f.repo,path.dirname(login.file));
  assert.throws(()=>createLoginRegistration(login),/ELOOP|ENOTDIR|redirected/);
  assert.deepEqual(fs.readdirSync(f.repo),[]);
});

test('host recovery names the supervisor, exact source controls and original watcher recovery without mutating runs',t=>{
  const f=fixture(t),before=structuredClone(f.options.state),plist=fs.readFileSync(f.file);
  const notices=f.notices();
  assert.ok(notices.every(n=>n.owner==='supervisor-fixture'));
  const login=notices.find(n=>n.boundary==='login-registration');assert.match(login.action,/stop .*restart/);
  assert.ok(login.action.includes(path.join(f.root,'line-service/launchd.mjs')));
  assert.ok(notices.some(n=>n.boundary==='service-unloaded'));
  const watcher=notices.find(n=>n.boundary==='watcher-stopped');assert.equal(watcher.run,'R-1');
  assert.match(watcher.action,/original dispatch --retry R-1/);assert.match(watcher.action,/never create a replacement run/);
  assert.deepEqual(f.options.state,before);assert.deepEqual(fs.readFileSync(f.file),plist);
});

test('host recovery keeps STOP and HOLD explicit and recognizes successful login and watcher recovery',t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.directory,'STOP'),'retained stop');fs.mkdirSync(path.join(f.repo,'.lane/supervisor'),{recursive:true});
  fs.writeFileSync(path.join(f.repo,'.lane/supervisor/HOLD'),'retained hold');
  assert.equal(f.notices().filter(n=>n.boundary==='fence').length,2);
  assert.equal(fs.readFileSync(path.join(f.directory,'STOP'),'utf8'),'retained stop');
  fs.unlinkSync(path.join(f.directory,'STOP'));fs.unlinkSync(path.join(f.repo,'.lane/supervisor/HOLD'));
  f.installation.login=loginRegistration('dev.herdr.line.'+'a'.repeat(20),f.file,f.root);createLoginRegistration(f.installation.login);
  f.options.loaded=true;f.options.alive=()=>true;assert.deepEqual(f.notices(),[]);
});

test('host recovery preserves unknown watcher identity and excludes reported, abandoned and foreign runs',t=>{
  const f=fixture(t);f.options.alive=()=>{throw Error('native process source refused');};
  assert.ok(f.notices().some(n=>n.boundary==='watcher-unknown'));
  assert.equal(f.notices().some(n=>n.boundary==='watcher-stopped'),false);
  const run=f.options.state.runs.get('R-1');run.report={};assert.equal(f.notices().some(n=>n.run),false);
  delete run.report;run.abandoned={};assert.equal(f.notices().some(n=>n.run),false);
  delete run.abandoned;run.meta.dispatch_project='/foreign';assert.equal(f.notices().some(n=>n.run),false);
});

test('host recovery surfaces the saved sign-in hold while retaining malformed stop evidence',t=>{
  const f=fixture(t),file=path.join(f.org,'watch/usage-stops/R-1.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({kind:'sign-in-required',phase:'held',reason:'restore original sign-in'}));
  const stop=f.notices().find(n=>n.boundary==='sign-in-required');assert.match(stop.action,/original-worker/);assert.match(stop.action,/no implicit rebind/);
  fs.writeFileSync(file,'{broken');assert.ok(f.notices().some(n=>n.boundary==='worker-stop-unknown'));
  assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});
