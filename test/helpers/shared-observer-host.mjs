// Script only process launch/liveness and native snapshot IO. The launcher,
// observer, immutable duties and (unless supplied) finite consumers are real.
import assert from 'node:assert/strict';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createObserver,startObserver} from '../../watch/observer.mjs';
import {ensureObserver} from '../../watch/host.mjs';
import {gitProject} from '../../lib/project.mjs';

export function observerHost(t,{repo,org,client,consume,subjects,notify=async()=>({queued:true}),socket=path.join(org,'socket')}) {
  const project=gitProject(repo),live=new Set(),hosts=[],rows=[];
  let current,pending;
  const exit=async()=>{if(current){const exiting=current;current=null;await exiting.observer.close();live.delete(exiting.owner.pid);}};
  t.after(exit);
  const start=async sourceRoot=>{
    const result=await ensureObserver({repo,org,project:project.identity,sourceRoot,env:{HERDR_SOCKET_PATH:socket},
      alive:o=>live.has(o.pid),birth:pid=>`host-birth:${pid}`,timeoutMs:1000,wait:async()=>{await pending;},
      start:(exe,args)=>{
        assert.equal(exe,process.execPath);assert.equal(args[0],path.join(sourceRoot,'watch/observer.mjs'));
        const pid=900+hosts.length+1,owner={schema:'brain.run-observer-owner/v1',repo,org,project:project.identity,
          source:sourceRoot,socket,pid,identity:`host-birth:${pid}`};
        const observer=createObserver({repo,org,sourceRoot,socket,client:client(),consume,subjects,notify,log:row=>rows.push(row),alive:o=>live.has(o.pid)});
        current={owner,observer};hosts.push(current);live.add(pid);
        pending=startObserver(observer,path.join(org,'watch/observer/owner.json'),owner);
        return Object.assign(new EventEmitter(),{pid,exitCode:null,unref(){}});
      }});
    assert.equal(result.state,'ready',JSON.stringify(result));await current.observer.idle();return current;
  };
  return {start,exit,hosts,rows,get current(){return current;}};
}
