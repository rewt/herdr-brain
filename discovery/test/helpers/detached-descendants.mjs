// Runs only through the bounded test/helpers/detached-fixture.mjs entrypoint.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runBounded } from '../../bounded.mjs';
import { lookupProcess } from '../../../test/helpers/processes.mjs';

const [root, mode] = process.argv.slice(2);
const deadlineBinary = path.join(root, 'fixture-deadline');
const marker = path.join(root, 'late-write'), receipt = path.join(root, 'leaf.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Each process records its own group while alive, before its parent exits.
// The native exec launcher records getpgrp before Node starts. macOS forbids
// executing the setuid ps binary inside the product sandbox.
const group = `Number(process.env.HERDR_FIXTURE_PGID)`;
const writeReceipt = `const value={pid:process.pid,pgid:${group},parentGroup:Number(process.argv[1])};require('fs').writeFileSync(${JSON.stringify(receipt + '.tmp')},JSON.stringify(value));require('fs').renameSync(${JSON.stringify(receipt + '.tmp')},${JSON.stringify(receipt)});`;
const writer = `${writeReceipt}setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'unsafe'),2500);`;
const middleReceipt = path.join(root, 'middle.json');
const middle = `const pgid=${group};require('fs').writeFileSync(${JSON.stringify(middleReceipt)},JSON.stringify({pid:process.pid,pgid,parentGroup:Number(process.argv[1])}));const c=require('child_process').spawn(${JSON.stringify(deadlineBinary)},[process.execPath,'-e',${JSON.stringify(writer)},String(pgid)],{detached:true,stdio:'ignore'});c.unref();`;
const parent = `const pgid=${group};const c=require('child_process').spawn(${JSON.stringify(deadlineBinary)},[process.execPath,'-e',${JSON.stringify(middle)},String(pgid)],{detached:true,stdio:'ignore'});c.unref();const poll=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(receipt)})&&${mode === 'completion'})clearInterval(poll);},10);`;
async function launched() {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(receipt) && Date.now() < deadline) await delay(10);
  assert.ok(fs.existsSync(receipt), 'detached leaf actually launched');
  const rows = [JSON.parse(fs.readFileSync(receipt)), ...(fs.existsSync(middleReceipt) ? [JSON.parse(fs.readFileSync(middleReceipt))] : [])];
  for (const row of rows) {
    assert.equal(row.pgid, row.pid, 'detached descendant is a group leader');
    assert.notEqual(row.pgid, row.parentGroup, 'detached descendant left its parent group');
  }
}
if (mode === 'completion' || mode === 'deadline') {
  const unrelated = path.join(root, 'unrelated');
  const other = spawn(process.execPath, ['-e', `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(unrelated)},'alive'),900);`], { stdio: 'ignore' });
  const closed = new Promise(resolve => other.once('close', resolve));
  const status = await runBounded(deadlineBinary, [process.execPath, '-e', parent], { timeoutMs: mode === 'deadline' ? 1500 : 5000 });
  assert.equal(status, mode === 'deadline' ? 124 : 0);
  await launched();
  assert.ok(fs.existsSync(middleReceipt), 'both double-fork generations launched');
  await delay(2700);
  assert.ok(!fs.existsSync(marker), 'no descendant writes after return');
  await closed;
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'alive', 'unrelated same-group process survives');
} else if (mode === 'wrapper-death') {
  const command = `const c=require('child_process').spawn(${JSON.stringify(deadlineBinary)},[process.execPath,'-e',${JSON.stringify(writer)},String(${group})],{detached:true,stdio:'ignore'});c.unref();setInterval(()=>{},1000);`;
  const source = `import {runBounded} from ${JSON.stringify(new URL('../../bounded.mjs', import.meta.url).href)};await runBounded(${JSON.stringify(deadlineBinary)},[process.execPath,'-e',${JSON.stringify(command)}],{timeoutMs:6000});`;
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'inherit' });
  const closed = new Promise(resolve => wrapper.once('close', resolve));
  await launched();
  wrapper.kill('SIGKILL'); await closed;
  await delay(2700);
  assert.ok(!fs.existsSync(marker), 'native owner cleaned detached descendants after wrapper death');
} else {
  const current = lookupProcess(process.pid);
  assert.ok(current.ok && current.value, current.error);
  const pgid = current.value.pgid;
  const program = mode === 'early-cancel' ? `while(true){} // ${root}` : `${writeReceipt}${mode === 'blocked-leaf' ? 'while(true){}' : 'setInterval(()=>{},1000);'}`;
  const child = spawn(deadlineBinary, [process.execPath, '-e', program, String(pgid)], { detached: true, stdio: 'ignore' });
  child.unref();
  fs.writeFileSync(path.join(root, 'spawned.json.tmp'), JSON.stringify({ pid: child.pid }));
  fs.renameSync(path.join(root, 'spawned.json.tmp'), path.join(root, 'spawned.json'));
  if (mode !== 'early-cancel') await launched();
  if (mode === 'failure') assert.fail('injected detached fixture assertion failure');
  if (mode === 'blocked') { while (true) {} }
  await new Promise(() => { setInterval(() => {}, 1000); });
}
