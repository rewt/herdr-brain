import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('closeout source lookup is lazy across import, injected source and later Git changes',t=>{
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'closeout-source-')));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const module=new URL('../line-service/closeout-measurement.mjs',import.meta.url).href;
  // A fresh process observes the first import, including transitive imports.
  // Intercept the actual builtin so an eager lookup cannot evade the test seam.
  const script=`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const calls=[],first='a'.repeat(40),second='b'.repeat(40);
    let commit=first;
    childProcess.spawnSync=(exe,args,options)=>{
      calls.push({exe,args,options});
      assert.equal(exe,'git');
      assert.deepEqual(args.slice(-2),['rev-parse','HEAD']);
      assert.equal(options.env.GIT_OPTIONAL_LOCKS,'0');
      return {status:0,stdout:commit+'\\n'};
    };
    syncBuiltinESMExports();
    const {recordCloseoutTurn}=await import(${JSON.stringify(module)});
    assert.equal(calls.length,0,'import must not spawn Git');
    const org=${JSON.stringify(directory)};
    fs.writeFileSync(path.join(org,'events.jsonl'),'');
    const args={org,project:{identity:'/fixture/project/.git',canonical:'/fixture/project'},
      historical:[],collect:()=>({coverage:{native:true,git:true,process:true},errors:[]}),now:()=>120000};
    const supplied={commit:'c'.repeat(40),module_sha256:'d'.repeat(64)};
    const read=result=>JSON.parse(fs.readFileSync(result.file)).source;
    assert.deepEqual(read(recordCloseoutTurn({...args,source:supplied})),supplied);
    assert.equal(calls.length,0,'injected source must not spawn Git');
    const initial=read(recordCloseoutTurn(args));
    assert.equal(calls.length,1,'first default-source turn resolves Git once');
    assert.equal(initial.commit,first);assert.equal(initial.loaded_commit,first);assert.equal(initial.changed,false);
    commit=second;
    const later=read(recordCloseoutTurn(args));
    assert.equal(calls.length,2,'later turn rechecks the current commit once');
    assert.equal(later.commit,second);assert.equal(later.loaded_commit,first);assert.equal(later.changed,true);
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr||result.stdout);
});
