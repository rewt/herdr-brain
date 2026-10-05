// Same-machine fixed-work gate benchmark, not a validation suite.
// Usage: node docs/reports/evidence/ENG-210-R265/gate-wall.mjs before|after
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) throw Error('expected before or after');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r265-wall-'));
try {
  const calls = path.join(root, 'calls'), preload = path.join(root, 'count.mjs');
  fs.writeFileSync(preload, `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const execute=cp.spawnSync;cp.spawnSync=(file,...args)=>{if(String(file).includes('process-source-')||String(file).endsWith('/getconf'))fs.appendFileSync(${JSON.stringify(calls)},'source\\n');return execute(file,...args);};syncBuiltinESMExports();`);
  const gate = path.join(root, 'gate.cjs'), adapter = path.join(root, 'adapter.mjs');
  fs.writeFileSync(gate, `const crypto=require('crypto');for(let i=0;i<16;i++)crypto.pbkdf2Sync('gate','salt',1000000,32,'sha256');console.log('fixed work complete');`);
  fs.writeFileSync(adapter, `import {runTestSlotSync} from ${JSON.stringify(new URL('../../../../test-slot/run.mjs', import.meta.url).href)};
const r=runTestSlotSync('r265-wall',[process.execPath,${JSON.stringify(gate)}],{retryTimeout:false,stdio:'inherit'});process.exit(r.status??1);`);
  const env = { ...process.env, MONITOR_TEST_SLOT_PATH: path.join(root, 'slot'), MONITOR_TEST_SLOT_COMPAT_PATH: path.join(root, 'slot'), NODE_OPTIONS: `--import=${preload}` };
  for (const key of ['MONITOR_TEST_SLOT_TOKEN', 'BCH_CLOAK_TEST_SLOT_TOKEN', 'MONITOR_TEST_SLOT_TIMEOUT_RETRIED', 'NODE_TEST_CONTEXT']) delete env[key];
  const rows = [];
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(calls, '');
    const start = process.hrtime.bigint();
    const result = spawnSync(process.execPath, [adapter], { env, encoding: 'utf8', timeout: 60000 });
    if (result.status !== 0) throw Error(result.stderr || String(result.error));
    rows.push({ wall_s: Number(process.hrtime.bigint() - start) / 1e9, source_spawns: fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length });
  }
  const sorted = rows.map(r => r.wall_s).sort((a, b) => a - b);
  const result = { phase, platform: process.platform, arch: process.arch, node: process.version, workload: '16 sequential PBKDF2-SHA256 calls, 1000000 iterations each', rows, median_wall_s: sorted[2], mean_wall_s: rows.reduce((n, r) => n + r.wall_s, 0) / rows.length };
  fs.writeFileSync(new URL(`gate-wall-${phase}.json`, import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
