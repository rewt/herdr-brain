// Native worker/validator transport is scripted; requests, lane checks, project
// validation and integration use the copied product and its real Git worktrees.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

module.exports = async function () {
  if (['--help', '--version'].includes(process.argv[2])) return 0;
  if (process.argv[2] === 'sandbox') return require('./lifetime.cjs')(process.argv.slice(2));
  const { loadTimeout } = await import('../../../lib/deadline.mjs');
  const product = process.env.PROBE_PRODUCT;
  const invoke = (binary, args, cwd = process.cwd()) => {
    const result = spawnSync(binary, args, { cwd, env: process.env, encoding: 'utf8', timeout: loadTimeout(15000), killSignal: 'SIGKILL' });
    assert.ifError(result.error);
    return { ...result, output: result.stdout + result.stderr };
  };
  const monitor = (...args) => invoke(process.execPath, [path.join(product, 'discovery/client.mjs'), ...args]);
  const success = (result) => { assert.equal(result.status, 0, result.output); return result.stdout.trim(); };
  const refusal = (result, reason) => { assert.notEqual(result.status, 0, result.output); assert.match(result.output, reason); };
  const git = (...args) => success(invoke('git', args));
  const routing = process.env.PROBE_TASK === 'routes';
  const context = JSON.parse(success(monitor('start', routing ? 'Apply approved routes' : 'Add French greeting')));
  assert.equal(context.workspace, process.cwd());
  assert.match(context.branch, /^lane\//u);
  const base = git('rev-parse', 'main');
  const frenchTest = path.join(context.workspace, 'test/french.test.mjs');
  const greenTest = "import test from 'node:test'; import assert from 'node:assert/strict'; import {greetings} from '../greetings.mjs'; test('French added',()=>assert.equal(greetings.fr,'Bonjour'));\n";
  if (routing) success(monitor('apply-routes'));
  else {
    fs.writeFileSync('greetings.mjs', "export const greetings = { en: 'Hello', fr: 'Bonjour' };\n");
    fs.writeFileSync(frenchTest, greenTest);
  }
  fs.mkdirSync(path.dirname(context.report), { recursive: true });
  fs.writeFileSync(context.report, `---\nrun: ${context.run}\noutcome: done\nsummary: ${routing ? 'Applied approved routes.' : 'Added a tested French greeting.'}\nheadline: The project change is ready\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
  success(monitor('commit', routing ? 'Apply approved model routes' : 'Add French greeting'));
  const checked = success(monitor('check'));
  assert.match(checked, /English stays/u);
  assert.match(checked, /French added/u);
  assert.match(checked, /GATE .* exit=0/u);

  if (!routing) {
    // These refusals come from the copied CLI, including its imported guard.
    fs.writeFileSync('uncommitted', 'keep the lane dirty\n');
    refusal(monitor('check'), /worktree is not clean/u);
    refusal(monitor('promote'), /worktree is not clean/u);
    fs.unlinkSync('uncommitted');
    fs.writeFileSync(frenchTest, greenTest.replace("'Bonjour'", "'wrong'"));
    success(monitor('commit', 'Exercise a failing project gate'));
    refusal(monitor('check'), /exit=1/u);
    refusal(monitor('promote'), /validation failed/u);
    fs.writeFileSync(frenchTest, greenTest);
    success(monitor('commit', 'Restore the green project gate'));
    refusal(invoke(process.execPath, [path.join(product, 'lanes/lane.mjs'), 'promote', context.topic, '--expected-head', base]), /lane tip differs from expected head/u);
    const stop = path.join(context.canonical, '.lane/supervisor/STOP');
    fs.mkdirSync(path.dirname(stop), { recursive: true }); fs.writeFileSync(stop, 'test stop\n');
    try { refusal(monitor('promote'), /supervisor STOP exists/u); }
    finally { fs.unlinkSync(stop); }
    assert.equal(git('rev-parse', 'main'), base, 'no refused attempt integrates work');
    success(monitor('check'));
  }
  const head = git('rev-parse', 'HEAD');
  const promoted = success(monitor('promote'));
  assert.match(promoted, /validating in/u);
  if (/REUSE/u.test(promoted)) {
    const gate = JSON.parse(fs.readFileSync('.lane/gate.json', 'utf8'));
    assert.equal(gate.reused, true); assert.equal(gate.tier, 'promotion');
    assert.match(fs.readFileSync(gate.log, 'utf8'), /French added/u);
  } else assert.match(promoted, /French added/u);
  assert.match(promoted, /fast-forward/u);
  assert.equal(git('rev-parse', 'main'), head);
  success(monitor('finish'));
  fs.writeFileSync(process.env.PROBE_WORKER_RECEIPT, JSON.stringify({ context, checked, promoted, head }));
  return 0;
};
