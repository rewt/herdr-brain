// Offline correction-8 verification. All slots/history are disposable. The
// loaded mode also stretches two scheduling windows deterministically, so a
// quiet host can reproduce the same fixed-bound and publication-race defects.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { loadTimeout } from '../../../../lib/deadline.mjs';
import { testSlotEnvironment } from '../../../../test/helpers/test-slot-env.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const mode = process.argv[2] ?? 'plain';
assert.ok(['plain', 'outer', 'main-legacy', 'lane-check'].includes(mode));
const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'eng274-r349-'));
const slot = path.join(root, 'slot'), receipt = path.join(root, 'outer.json');
const env = { ...testSlotEnvironment(), MONITOR_GATE_HISTORY_ROOT: path.join(root, 'history'),
  MONITOR_TEST_SLOT_PATH: slot, MONITOR_TEST_SLOT_COMPAT_PATH: slot };
const files = ['test-slot/test/test-slot.test.mjs', 'test-slot/test/gate-profile.test.mjs'];
const busy = [];
let result;
try {
  let cwd = repo;
  let tests = [process.execPath, '--test', ...files];
  if (mode === 'outer' || mode === 'main-legacy') {
    // Four owned, finite busy loops add genuine contention. The preload makes
    // slow gate startup (3 s per attempt) and delayed workspace publication
    // (until the command marker, then 500 ms) repeatable instead of depending
    // on machine scheduling luck.
    for (let i = 0; i < 4; i++) busy.push(spawn(process.execPath, ['-e',
      'const end=Date.now()+300000;while(Date.now()<end){}'], { env, stdio: 'ignore' }));
    const preload = path.join(root, 'slow.cjs');
    fs.writeFileSync(preload, `const fs=require('fs'),path=require('path'),cp=require('child_process');
      const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
      if(process.argv[1]?.endsWith('/gate.cjs'))pause(3000);
      // Observer fixtures replace NODE_OPTIONS; keep this runner's scheduling
      // instrumentation in those children as well.
      for(const name of ['spawn','spawnSync']){const original=cp[name];cp[name]=function(cmd,args,opts){
        if(opts?.env&&!opts.env.NODE_OPTIONS?.includes(__filename))opts={...opts,env:{...opts.env,
          NODE_OPTIONS:(opts.env.NODE_OPTIONS??'')+' --require='+JSON.stringify(__filename)}};
        return original.call(this,cmd,args,opts);
      };}require('module').syncBuiltinESMExports();
      const rename=fs.renameSync;let delayed=false;
      fs.renameSync=function(from,to,...args){
        if(!delayed&&path.resolve(to)===process.env.MONITOR_TEST_SLOT_PATH){
          let record;try{record=JSON.parse(fs.readFileSync(from,'utf8'))}catch{}
          if(record?.label==='workspace'&&record.pgid!==null){
            delayed=true;const marker=path.join(path.dirname(path.resolve(to)),'waiter.ran');
            const end=Date.now()+5000;while(!fs.existsSync(marker)&&Date.now()<end)pause(10);
            pause(500);
          }
        }
        return rename.call(this,from,to,...args);
      };`);
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}`;
    Object.assign(env, { MONITOR_TEST_SLOT_WAIT_SECONDS: '7200', BCH_CLOAK_TEST_SLOT_WAIT_SECONDS: '7200',
      MONITOR_TEST_SLOT_TIMEOUT_RETRIED: '1', BCH_CLOAK_TEST_SLOT_PATH: slot });
    if (mode === 'main-legacy') {
      // Run the existing main regression unmodified, including main's product
      // code, to distinguish a pre-existing fixture race from a lane regression.
      cwd = path.join(root, 'main'); fs.mkdirSync(cwd);
      const archive = spawnSync('git', ['archive', 'main'], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
      assert.equal(archive.status, 0);
      const extract = spawnSync('tar', ['-x', '-C', cwd], { input: archive.stdout });
      assert.equal(extract.status, 0);
      tests = [process.execPath, '--test', '--test-name-pattern=legacy bridge during workspace migration', files[0]];
    }
    result = spawnSync(process.execPath, [path.join(repo, 'test-slot/test-slot.mjs'), 'run', 'outer',
      '--project-common', root, '--timeout-seconds', '600', '--result-path', receipt, '--', ...tests],
    { cwd, env, stdio: 'inherit', timeout: loadTimeout(650000) });
    const execution = JSON.parse(fs.readFileSync(receipt));
    assert.equal(execution.command_started, true);
    assert.equal(execution.gate_timeout, null);
    assert.equal(execution.attempts, 1);
    assert.equal(fs.existsSync(slot), false, 'outer scratch slot released');
    console.log(`Outer scratch gate exit=${result.status}, attempts=1; slot released; four busy loops`);
  } else if (mode === 'lane-check') {
    result = spawnSync(process.execPath, ['lanes/lane.mjs', 'check', '--cmd',
      'node --test --test-name-pattern="three-lane red bisection|legacy bridge during workspace migration" ' + files.join(' ')],
    { cwd, env, stdio: 'inherit', timeout: loadTimeout(120000) });
  } else result = spawnSync(tests[0], tests.slice(1), { cwd, env, stdio: 'inherit', timeout: loadTimeout(300000) });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  for (const child of busy) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
  }
  fs.rmSync(root, { recursive: true, force: true });
}
