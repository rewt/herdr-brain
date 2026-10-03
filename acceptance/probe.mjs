import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadTimeout } from './deadline.mjs';
import { HarnessLimit } from './limits.mjs';

export function liveSocket(inherited) {
  const socket = path.resolve(inherited.HERDR_SOCKET_PATH ?? path.join(os.homedir(), '.config/herdr/herdr.sock'));
  let stat;
  try { stat = fs.statSync(socket); } catch (error) { throw new HarnessLimit(`live Herdr socket unavailable: ${socket}: ${error.code}`); }
  if (!stat.isSocket()) throw new HarnessLimit(`live Herdr endpoint is not a socket: ${socket}`);
  return socket;
}

// Git writes use a disposable fixture inside this session's temp. It uses the
// same explicit common-directory grants as the real project, without changing
// the main checkout while another discovery session may already be working.
export function boundaryScript({ repo, temp, candidate, root, socket, gitProbe }) {
  const literal = JSON.stringify;
  return `import fs from 'node:fs';import net from 'node:net';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
    const blocked=[];for(const [label,fn] of [
      ['parent-list',()=>fs.readdirSync(${literal(path.dirname(repo))})],
      ['candidate-policy',()=>fs.readFileSync(${literal(path.join(candidate, 'AGENTS.md'))})],
      ['harness-read',()=>fs.readFileSync(${literal(path.join(root, 'protected-read-canary'))})],
      ['harness-write',()=>fs.writeFileSync(${literal(path.join(root, 'forbidden-write-canary'))},'bad')]
    ]){let denied=false;try{fn()}catch(e){denied=['EPERM','EACCES'].includes(e.code)}assert.ok(denied,label+' must be denied');blocked.push(label)}
    fs.writeFileSync(${literal(path.join(temp, 'allowed'))},'temporary');
    for(const file of ['config','hooks/pre-commit']){let denied=false;try{fs.writeFileSync(${literal(path.join(gitProbe, '.git'))}+'/'+file,'unsafe config/hook')}catch(e){denied=['EPERM','EACCES'].includes(e.code)}assert.ok(denied,'Git '+file+' must be read-only');blocked.push('git-'+file)}
    const git=(...args)=>{const r=spawnSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',${literal(gitProbe)},...args],{encoding:'utf8'});assert.equal(r.status,0,'sandboxed Git '+args.join(' ')+': '+r.stderr);return r.stdout.trim()};
    const worktree=${literal(path.join(temp, 'probe-worktree'))};
    git('worktree','add','-b','acceptance-git-proof',worktree);
    fs.writeFileSync(worktree+'/proof.txt','sandboxed Git writes');
    const commit=spawnSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',worktree,'commit','-am','Sandboxed Git proof'],{encoding:'utf8'});
    assert.equal(commit.status,0,'sandboxed commit: '+commit.stderr);
    const head=git('rev-parse','acceptance-git-proof');git('update-ref','refs/acceptance/probe',head);assert.equal(git('rev-parse','refs/acceptance/probe'),head);
    const connection=net.createConnection(${literal(socket)});
    await new Promise((resolve,reject)=>{const t=setTimeout(()=>{connection.destroy();reject(Error('socket probe timed out'))},${loadTimeout(2000)});connection.once('connect',()=>{clearTimeout(t);connection.destroy();reject(Error('direct live Herdr socket allowed'))});connection.once('error',e=>{clearTimeout(t);if(['EPERM','EACCES'].includes(e.code))resolve();else reject(e)})});
    assert.ok(!Object.keys(process.env).some(k=>/^(HERDR|ACCEPTANCE)/.test(k)));
    console.log(JSON.stringify({blocked:[...blocked,'live-herdr-socket'],git:{commit:head,worktree,ref:'refs/acceptance/probe'},writable:[${literal(repo)},${literal(temp)}],socket:${literal(socket)}}));`;
}
