// Native resource inputs for the offline world. Never run a host-wide lsof or
// process inventory. Scripted native workers have private process births;
// kernel birth lookups for real harness children stay real.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import net from 'node:net';
import {Duplex} from 'node:stream';
import {EventEmitter} from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fs.realpathSync(process.env.INSTALLED_CYCLE_ROOT);
// Declared native observation seam: the installed observer speaks its normal
// protocol to an in-memory scratch transport. No real socket is ever opened.
// Deliberately send no hints: only its unchanged 30 s safety timer can recover.
if(process.argv[1]?.endsWith('/watch/observer.mjs')) {
  net.createConnection=function(socket,...args){
    if(socket!==process.env.HERDR_SOCKET_PATH)throw Error('foreign observer transport');
    const stream=new Duplex({read(){},write(bytes,_encoding,done){
      for(const line of bytes.toString().trim().split('\n')) {
        const request=JSON.parse(line),native=JSON.parse(fs.readFileSync(path.join(root,'native.json'))),ws=Object.values(native.workspaces);
        const result=request.method==='session.snapshot'?{type:'session_snapshot',snapshot:{protocol:22,version:'scripted-installed-canary',
          agents:ws.flatMap(w=>w.agent?[{...w.agent,state_change_seq:native.seq??1,completion_seq:native.seq??1}]:[]),panes:ws.map(w=>w.pane)}}:
          request.method==='events.subscribe'?{type:'subscription_started'}:null;
        if(!result)throw Error('unexpected observer request');
        fs.appendFileSync(path.join(root,'evidence/observer-transport.jsonl'),JSON.stringify({at:new Date().toISOString(),request,result})+'\n');
        this.push(JSON.stringify({id:request.id,result})+'\n');
      }done();
    }});
    stream.setEncoding('utf8');stream.setTimeout=()=>stream;
    queueMicrotask(()=>stream.emit('connect'));return stream;
  };
  if(process.env.INSTALLED_CYCLE_DROP_HINTS==='1')fs.watch=()=>Object.assign(new EventEmitter(),{close(){}});
}
fs.appendFileSync(path.join(root,'evidence/executables.jsonl'),JSON.stringify({pid:process.pid,node:process.execPath,
  entry:process.argv[1],cwd:process.cwd()})+'\n');
// sandbox-exec drops the host preload. Propagate this local native fixture
// explicitly to every installed product child after the boundary is entered.
const preload = `--import=${fileURLToPath(import.meta.url)}`;
if (!process.env.NODE_OPTIONS?.includes(preload)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${preload}`.trim();
// os.userInfo is a native account lookup and ignores HOME. Match the scratch
// account in every process so default installed entries use the fixture home.
const account = os.userInfo();
os.userInfo = options => ({ ...account, homedir: options?.encoding === 'buffer' ? Buffer.from(process.env.HOME) : process.env.HOME });
const original = childProcess.spawnSync;
childProcess.spawnSync = function (file, args = [], options = {}) {
  if (file === '/usr/sbin/lsof') {
    if (!args.includes('-Fpn0') && !args.includes('-Fpfn0')) throw Error('unexpected installed-fixture resource inventory');
    const cwd = process.cwd();
    if (!cwd.startsWith(root + path.sep)) throw Error('resource observer left scratch');
    fs.appendFileSync(path.join(root, 'evidence/native-observations.jsonl'), JSON.stringify({
      scripted: true, file, args, pid: process.pid, cwd }) + '\n');
    // Complete caller anchor in both native formats. Scripted workers have no
    // host process or open descriptors; real harness children run in the repo.
    return { status: 0, signal: null, stdout: `p${process.pid}\0\nfcwd\0n${cwd}\0\n`, stderr: '' };
  }
  if (String(file).includes('/lib/native/process-source-')) {
    if (!args.some(a => /^[1-9]\d*$/.test(a))) throw Error('unscoped host process inventory forbidden in installed fixture');
    const pid = Number(args.at(-1)), scripted = pid > 1_000_000_000;
    fs.appendFileSync(path.join(root, 'evidence/native-observations.jsonl'), JSON.stringify({ file, args, caller: process.pid, scripted }) + '\n');
    if (scripted) {
      const native = JSON.parse(fs.readFileSync(path.join(root, 'native.json')));
      const row = Object.values(native.workspaces).flatMap(w => [w.shellProcess, ...(w.agent ? [w.agentProcess] : [])])
        .find(p => p?.pid === pid);
      return { status: row ? 0 : 1, signal: null, stdout: row ? JSON.stringify(row) + '\n' : '', stderr: '' };
    }
  }
  return original.call(this, file, args, options);
};
syncBuiltinESMExports();
