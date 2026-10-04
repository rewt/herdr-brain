import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflow, loadWorkflow, runWorkflow } from '../../workflow/engine.mjs';

const step = (id, command) => `### ${id}\n\nRun a project check.\n\n\`\`\`json\n${JSON.stringify({ command, permission: 'commands' })}\n\`\`\``;
const document = (steps, fields = '', gates = []) => `---\nname: "Example"\ntrigger: "manual"\ninputs: {"value": {"required": true}}\npermissions: ["commands", "dispatch"]\n${fields}---\n\n# Example\n\n## Steps\n\n${steps}\n\n## Gates\n\n${JSON.stringify(gates)}\n\n## On failure\n\nKeep logs and inspect before retrying.\n`;
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const options = root => ({ directory: path.join(root, 'receipts'), cwd: root, inputs: { value: 'literal' }, grants: ['commands', 'dispatch'] });

test('workflow parses named command and routed prose steps without provider knowledge', () => {
  const agent = '### review\n\nReview {value} and write a report.\n\n```json\n{"route":"project-review", "permission":"dispatch"}\n```';
  const workflow = parseWorkflow(document(step('check', ['node', 'check.mjs', '{value}']) + '\n\n' + agent, '', ['check']));
  assert.equal(workflow.name, 'Example'); assert.equal(workflow.trigger, 'manual');
  assert.deepEqual(workflow.steps[0].command, ['node', 'check.mjs', '{value}']);
  assert.equal(workflow.steps[1].route, 'project-review');
  assert.equal(workflow.steps[1].prose, 'Review {value} and write a report.');
  assert.deepEqual(workflow.gates, ['check']);
});

test('workflow rejects ambiguous schema, shell text, missing sections and duplicate steps', () => {
  const good = document(step('check', ['node', 'check.mjs']), '', ['check']);
  for (const malformed of [
    good.replace('name: "Example"', 'name: Example'),
    good.replace('trigger: "manual"', 'trigger: "manual"\ntrigger: "twice"'),
    good.replace('trigger: "manual"', 'trigger: "manual"\nengine: "provider"'),
    good.replace('["node","check.mjs"]', '"node check.mjs"'),
    good.replace('"permission":"commands"', '"permission":"foreign"'),
    good.replace('## On failure', '## Recovery'),
    good.replace('["check"]', '["unknown"]'),
    document(step('check', ['true']) + '\n' + step('check', ['true'])),
    good.replace('{"command":', '{"route":"also-an-agent","command":'),
    good.replace('"required": true', '"required": "yes"'),
  ]) assert.throws(() => parseWorkflow(malformed), /workflow:/);
});

test('workflow local imports prepend reusable steps, hash their bytes and refuse escapes', t => {
  const root = fixture(t), directory = path.join(root, 'workflows'), file = path.join(directory, 'main.md'), fragment = path.join(directory, 'shared.md');
  fs.mkdirSync(directory);
  fs.writeFileSync(fragment, '## Steps\n\n' + step('setup', ['true']));
  fs.writeFileSync(file, document(step('check', ['true']), 'imports: ["shared.md"]\n', ['setup', 'check']));
  assert.throws(() => parseWorkflow(fs.readFileSync(file, 'utf8')), /loadWorkflow/);
  const first = loadWorkflow(file);
  assert.deepEqual(first.steps.map(s => s.id), ['setup', 'check']);
  fs.appendFileSync(fragment, '\nMore guidance.'); assert.notEqual(loadWorkflow(file).hash, first.hash);
  for (const imports of ['["../foreign.md"]', '["shared.md","shared.md"]', '["main.md"]']) {
    if (imports.includes('foreign')) fs.writeFileSync(path.join(root, 'foreign.md'), '## Steps\n' + step('foreign', ['true']));
    fs.writeFileSync(file, document(step('check', ['true']), `imports: ${imports}\n`));
    assert.throws(() => loadWorkflow(file));
    if (imports.includes('foreign')) fs.unlinkSync(path.join(root, 'foreign.md'));
  }
  fs.writeFileSync(fragment, document(step('setup', ['true'])));
  fs.writeFileSync(file, document(step('check', ['true']), 'imports: ["shared.md"]\n'));
  assert.throws(() => loadWorkflow(file), /only ## Steps/);
});

test('command substitutions are literal arguments and step receipts exist while work is running', t => {
  const root = fixture(t), literal = 'spaces; $(touch injected) `touch injected`';
  const workflow = parseWorkflow(document(step('check', [process.execPath, '-e', 'process.stdout.write(process.argv[1])', '{value}']), '', ['check']));
  const result = runWorkflow(workflow, { ...options(root), inputs: { value: literal } });
  assert.equal(result.status, 'succeeded');
  const receipt = JSON.parse(fs.readFileSync(result.steps[0].receipt));
  assert.equal(receipt.status, 'succeeded'); assert.equal(receipt.exit_code, 0);
  assert.ok(Date.parse(receipt.finished_at) >= Date.parse(receipt.started_at));
  assert.equal(fs.readFileSync(receipt.output_path, 'utf8'), literal);
  assert.equal(fs.existsSync(path.join(root, 'injected')), false);
  let manifest;
  const observed = runWorkflow(workflow, { ...options(root), onStart: value => { manifest = value.manifest; }, runCommand: () => {
    const running = JSON.parse(fs.readFileSync(manifest));
    assert.equal(running.status, 'running'); assert.equal(running.steps[0].status, 'running');
    const live = JSON.parse(fs.readFileSync(running.steps[0].receipt));
    assert.ok(Date.parse(live.started_at)); assert.equal(live.finished_at, null); assert.equal(live.exit_code, undefined);
    return { status: 0, stdout: 'observed' };
  } });
  assert.equal(observed.status, 'succeeded');
});

test('failed commands retain the real exit and skip later effects; launch errors and signals fail closed', t => {
  const root = fixture(t), workflow = parseWorkflow(document(step('check', ['unused']) + '\n' + step('after', ['unused']), '', ['check']));
  for (const result of [{ status: 7, stderr: 'red' }, { status: null, signal: 'SIGTERM' }, { error: new Error('launch failed') }]) {
    let calls = 0;
    const execution = runWorkflow(workflow, { ...options(root), runCommand: () => { calls++; return result; } });
    assert.equal(execution.status, 'failed'); assert.equal(calls, 1);
    assert.equal(execution.steps[0].status, 'failed'); assert.equal(execution.steps[1].status, 'skipped');
    assert.equal(execution.steps[1].started_at, null);
    if (result.status === 7) { assert.equal(execution.steps[0].exit_code, 7); assert.equal(fs.readFileSync(execution.steps[0].output_path, 'utf8'), 'red'); }
    if (result.signal) assert.equal(execution.steps[0].signal, 'SIGTERM');
  }
});

test('permissions and every input template are checked before any effect', t => {
  const root = fixture(t), workflow = parseWorkflow(document(step('check', ['unused']) + '\n' + step('later', ['unused', '{unknown}'])));
  let calls = 0;
  const opts = { ...options(root), runCommand: () => { calls++; return { status: 0 }; } };
  assert.throws(() => runWorkflow(workflow, { ...opts, grants: [] }), /permission not granted/);
  assert.throws(() => runWorkflow(workflow, { ...opts, inputs: {} }), /missing input/);
  assert.throws(() => runWorkflow(workflow, { ...opts, inputs: { value: 1 } }), /must be a string/);
  assert.throws(() => runWorkflow(workflow, { ...opts, inputs: { value: 'x', extra: 'x' } }), /unknown input/);
  assert.throws(() => runWorkflow(workflow, opts), /unbound input/);
  assert.equal(calls, 0); assert.equal(fs.existsSync(path.join(root, 'receipts')), false);
});

test('agent steps hand opaque routed prose to dispatch and pause without claiming completion', t => {
  const root = fixture(t), agent = '### review\n\nReview {value}.\n\n```json\n{"route":"opaque-route", "permission":"dispatch"}\n```';
  const workflow = parseWorkflow(document(agent + '\n' + step('after', ['unused'])));
  let request;
  const result = runWorkflow(workflow, { ...options(root), dispatch: value => { request = value; return { id: 'durable-dispatch-id' }; }, runCommand: () => assert.fail('must wait for the agent') });
  assert.equal(request.route, 'opaque-route'); assert.equal(request.prompt, 'Review literal.');
  assert.equal(result.status, 'waiting'); assert.equal(result.steps[0].status, 'dispatched');
  assert.equal(result.steps[0].dispatch_id, 'durable-dispatch-id'); assert.equal(result.steps[1].status, 'skipped');
  assert.equal(runWorkflow(workflow, options(root)).status, 'failed');
});

test('the bundled train parses into the four guarded migration stages', () => {
  const workflow = loadWorkflow(fileURLToPath(new URL('../../.herdr/workflows/train.md', import.meta.url)));
  assert.deepEqual(workflow.steps.map(s => s.command), ['prepare', 'validate', 'integrate', 'close'].map(id => ['train', id]));
  assert.deepEqual(workflow.gates, ['validate']);
});
