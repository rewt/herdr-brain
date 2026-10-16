import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptSource, sourceEnvironment } from '../board/source.mjs';
import { validateDocument } from '../board/rows.mjs';
import { boardFixture } from './helpers/board-fixture.mjs';
import { lookupProcess } from './helpers/processes.mjs';

test('board script runs from its project with a minimal environment and validates its rows', async t => {
  const f = boardFixture(t);
  assert.deepEqual(sourceEnvironment({ PATH: 'p', HOME: 'h', ORG_DIR: 'o', ORG_ACTOR: 'a', SECRET: 'PLANTED', NODE_OPTIONS: 'PLANTED' }), { PATH: 'p', HOME: 'h', ORG_DIR: 'o', ORG_ACTOR: 'a' });
  const script = f.write('rows.mjs', `if(process.cwd()!==${JSON.stringify(f.root)}||process.env.PLANTED_ENV)process.exit(4); console.log(${JSON.stringify(JSON.stringify(f.document()))});`);
  const source = scriptSource({ name: 'bch', project: f.root, script, env: { ...process.env, PLANTED_ENV: 'PLANTED' } });
  const safe = validateDocument(await source.read(), f.options);
  assert.equal(safe.rows.length, 1); assert.equal(safe.rows[0].phase, 'stage');
  assert.equal(safe.rows[0].where.log, f.log);
});
test('board source failures produce exactly one fixed-code row and no child output', async t => {
  const f = boardFixture(t);
  const cases = [
    ['source-timeout', "console.error('PLANTED');setInterval(()=>{},1000);"],
    ['source-exit', "console.log('PLANTED');console.error('PLANTED');process.exit(3);"],
    ['source-oversize', "process.stdout.write('PLANTED'.repeat(200000));"],
    ['source-json', "console.log('PLANTED');"],
    ['source-schema', "console.log(JSON.stringify({schema:'wrong',rows:['PLANTED']}));"],
    ['source-schema', "console.log('null');"],
  ];
  for (let i = 0; i < cases.length; i++) {
    const [code, text] = cases[i], script = f.write(`case-${i}.mjs`, text);
    const safe = validateDocument(await scriptSource({ name: 'bch', project: f.root, script, timeout: code === 'source-timeout' ? 150 : 10000 }).read(), f.options);
    assert.equal(safe.rows.length, 1); assert.equal(safe.rows[0].status.code, code);
    assert.equal(JSON.stringify(safe).includes('PLANTED'), false);
  }
});
test('board script reads coalesce, enforce five seconds, and never overlap even on timeout', async t => {
  const f = boardFixture(t); let clock = 0;
  const script = f.write('coalesce.mjs', `import fs from 'node:fs'; const guard=${JSON.stringify(f.root + '/running')};try{fs.writeFileSync(guard,'',{flag:'wx'});}catch{process.exit(8)};fs.appendFileSync(${JSON.stringify(f.root + '/calls')},'call\\n');setTimeout(()=>{fs.unlinkSync(guard); console.log(${JSON.stringify(JSON.stringify(f.document()))});},200);`);
  const source = scriptSource({ name: 'bch', project: f.root, script, now: () => clock });
  const pending = source.read(); clock = 6000;
  const [a, b] = await Promise.all([pending, source.read()]); assert.deepEqual(a, b);
  const fs = await import('node:fs'); assert.equal(fs.readFileSync(f.root + '/calls', 'utf8'), 'call\n');
  await source.read(); assert.equal(fs.readFileSync(f.root + '/calls', 'utf8'), 'call\ncall\n');
  clock = 9999; await source.read(); assert.equal(fs.readFileSync(f.root + '/calls', 'utf8'), 'call\ncall\n');
  clock = 11000; await source.read(); assert.equal(fs.readFileSync(f.root + '/calls', 'utf8'), 'call\ncall\ncall\n');
  const hanging = f.write('hang.mjs', 'setInterval(()=>{},1000)');
  const timed = scriptSource({ name: 'bch', project: f.root, script: hanging, timeout: 150, now: () => clock });
  const first = timed.read(); clock += 6000; assert.deepEqual(await timed.read(), await first);
  assert.equal((await timed.read()).rows[0].status.code, 'source-timeout');
  const pipes = f.write('pipes.mjs', `import fs from 'node:fs';import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{stdio:['ignore',process.stdout,process.stderr]});fs.writeFileSync(${JSON.stringify(f.root + '/pipe-child')},String(child.pid));child.unref();`);
  const heldPipe = scriptSource({ name: 'bch', project: f.root, script: pipes, timeout: 500 });
  assert.equal((await heldPipe.read()).rows[0].status.code, 'source-timeout');
  const pid = Number(fs.readFileSync(f.root + '/pipe-child', 'utf8'));
  const deadline = Date.now() + 5000;
  for (;;) {
    const result = lookupProcess(pid); assert.ok(result.ok, result.error);
    if (result.value === null || result.value.state.startsWith('Z')) break;
    assert.ok(Date.now() < deadline, 'bounded inherited-pipe fixture exited');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
});
