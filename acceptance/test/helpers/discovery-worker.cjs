// Fixed offline replacement for a model turn, executed inside the gate's real
// native sandbox. All workflow mutations still cross the installed client.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const [installation, task] = process.argv.slice(2);
function cli(file, args, ok = true) {
  const result = spawnSync(process.execPath, [path.join(installation, file), ...args], { encoding: 'utf8', timeout: 60000 });
  if (ok) assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}
const client = (...args) => cli('discovery/client.mjs', args).stdout;
const context = JSON.parse(client('context'));
assert.notEqual(context.workspace, context.canonical);
assert.equal(context.org, path.join(context.canonical, '.org'));
assert.notEqual(process.env.TMPDIR, process.env.HOME);
// Request writes work, while canonical project/Git, fleet, harness state and
// the surrounding scratch home remain protected. Private run temp still works.
for (const file of [path.join(context.org, 'events.jsonl'), path.join(context.canonical, '.lane/escape'),
  path.join(context.canonical, '.git/config'), path.join(process.env.HOME, 'f/fleet.json'), path.join(process.env.HOME, 'escape')])
  assert.throws(() => fs.writeFileSync(file, 'escape'), e => ['EPERM', 'EACCES'].includes(e.code), file);
fs.writeFileSync(path.join(process.env.TMPDIR, 'private-temp'), 'allowed');
const binding = JSON.parse(task === 'routing-apply' ? client('resume', context.routing.parent) : client('start', `Offline ${task}`));
if (task === 'routing') {
  const refused = cli('discovery/client.mjs', ['apply-routes'], false);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /operator answer/);
} else if (task === 'routing-apply') {
  const applied = JSON.parse(client('apply-routes'));
  assert.equal(applied.file, path.join(binding.workspace, '.lane.json'));
  assert.ok(!fs.existsSync(path.join(binding.canonical, '.lane.json')));
} else {
  // Independent files make the stale-base rebase deterministic and conflict-free.
  fs.writeFileSync(path.join(binding.workspace, `${task}.mjs`), `export default '${task}';\n`);
  fs.writeFileSync(path.join(binding.workspace, `test/${task}.test.mjs`),
    `import test from 'node:test';import assert from 'node:assert/strict';import greeting from '../${task}.mjs';test('${task}',()=>assert.equal(greeting,'${task}'));\n`);
  fs.writeFileSync(path.join(process.env.TMPDIR, 'ready'), 'ready');
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(path.join(process.env.TMPDIR, 'release'))) {
    assert.ok(Date.now() < deadline, 'offline concurrent barrier timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}
const outcome = task === 'routing' ? 'needs_human' : 'done';
fs.mkdirSync(path.dirname(binding.report), { recursive: true });
fs.writeFileSync(binding.report, `---\nrun: ${binding.run}\noutcome: ${outcome}\nsummary: Fixed offline discovery task\nheadline: Offline discovery completed\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
cli('bin/org.mjs', ['check', binding.report]);
client('commit', `Offline ${task}`);
if (outcome === 'done') {
  assert.match(client('check'), /GATE .* exit=0/);
  assert.match(client('promote'), /fast-forward/);
}
client('finish');
console.log(JSON.stringify({ context: binding, outcome }));
