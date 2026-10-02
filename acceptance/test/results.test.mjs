import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { commandFailure, classifyFailure, HarnessLimit, Pending, ProductBoundary, requirePrerequisite } from '../limits.mjs';
import { retainedRoots, resultLine } from '../results.mjs';

test('fake product entry passing a bypass flag is refused before launch and its case reports product FAIL', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-product-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'project'), temp = path.join(root, 'session');
  fs.mkdirSync(repo); fs.mkdirSync(temp); fs.mkdirSync(path.join(root, 'live-jobs'));
  const marker = path.join(root, 'native-called'), binary = path.join(root, 'fake-native');
  fs.writeFileSync(binary, `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'unsafe');`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'live-jobs/job.json'), JSON.stringify({ repo, temp, binary }));
  const transport = path.resolve('acceptance/native-transport.mjs');
  const entry = path.join(root, 'fake-product-entry.mjs');
  fs.writeFileSync(entry, `import {spawnSync} from 'node:child_process';const r=spawnSync(${JSON.stringify(process.execPath)},${JSON.stringify([transport, root, 'job', 'exec', '--yolo'])},{stdio:'inherit'});process.exit(r.status);`);
  const child = spawnSync(process.execPath, [entry], { cwd: repo, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.notEqual(child.status, 0); assert.ok(!fs.existsSync(marker));
  const result = { id: '20', name: 'Real discovery', ...classifyFailure(commandFailure(child.stderr)) };
  assert.equal(result.status, 'FAIL'); assert.equal(result.origin, 'product');
  assert.match(resultLine(result), /FAIL.*\[SAFETY\]/); assert.doesNotMatch(resultLine(result), /HARNESS/);
});

test('candidate capability leaks, foreign roots and unowned target refusals are FAIL, capability probes remain pending', () => {
  for (const message of ['acceptance_product_boundary: leaked HERDR variables', 'acceptance_product_boundary: foreign root', '{"code":"acceptance_product_boundary","message":"unowned pane"}', 'acceptance_boundary: path outside scratch']) {
    assert.deepEqual(classifyFailure(commandFailure(message)), { status: 'FAIL', origin: 'product', detail: message });
  }
  assert.equal(classifyFailure(new HarnessLimit('native capability probe unavailable')).status, 'PENDING');
});

test('cleanup failure without keep reports every existing discovery root on the actual cleanup screen line', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-residue-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roots = ['project', 'session', 'removed'].map((name) => path.join(root, name));
  for (const directory of roots) fs.mkdirSync(directory);
  fs.rmSync(roots[2], { recursive: true });
  const residue = retainedRoots(roots); assert.deepEqual(residue, roots.slice(0, 2));
  const result = { id: '23', name: 'Cleanup and scope audit', ...classifyFailure(Error('injected close failure'), { cleanup: true }) };
  const summary = { keep: false, retainedDiscoveryRoots: residue };
  const line = resultLine(result, summary.retainedDiscoveryRoots);
  assert.match(line, /PENDING.*HARNESS.*retained:/);
  for (const directory of residue) assert.ok(line.includes(directory));
});


test('ordinary product entry and source-attribution gaps fail without a safety or harness marker', () => {
  for (const message of ['candidate installer did not expose its documented monitor-codex entry', 'product policy must name its installed source']) {
    const result = { id: '20', name: 'Discovery', ...classifyFailure(commandFailure(message)) };
    assert.equal(result.status, 'FAIL'); assert.equal(result.origin, 'product');
    assert.doesNotMatch(resultLine(result), /SAFETY|HARNESS/);
  }
});

test('dependent cutover/default-cycle cases preserve prerequisite causes and origins', () => {
  const scenarios=[
    {key:'cutover-switches',name:'Scratch switches',...classifyFailure(new Pending('pass --bch-cloak LIVE_REPO'))},
    {key:'cutover-switches',name:'Scratch switches',...classifyFailure(new HarnessLimit('stand-in acknowledgement unavailable'))},
    {key:'herdr-fixture',name:'Supervisor fixture',...classifyFailure(new HarnessLimit('native socket unavailable'))},
    {key:'cutover-switches',name:'Scratch switches',...classifyFailure(new Error('cutover candidate lacks supervisor/open-session.mjs'))},
    {key:'cutover-switches',name:'Scratch switches',...classifyFailure(new ProductBoundary('acceptance_product_boundary: foreign target'))},
  ];
  for (const prerequisite of scenarios) {
    let error;try{requirePrerequisite([prerequisite],prerequisite.key);}catch(e){error=e;}
    const result=classifyFailure(error);
    assert.equal(result.status,prerequisite.status);assert.equal(result.origin,prerequisite.origin);
    assert.ok(result.detail.includes(prerequisite.detail));
  }
  assert.doesNotThrow(()=>requirePrerequisite([{key:'cutover-switches',status:'PASS'}],'cutover-switches'));
  assert.throws(()=>requirePrerequisite([],'herdr-fixture'),HarnessLimit);
});
