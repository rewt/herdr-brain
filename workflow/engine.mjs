// Foreground, synchronous workflow interpreter. No shell, scheduler or model.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { plainDirectory, readPlainFile, writeFileAtomic } from '../lib/files.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(v => typeof v === 'string' && v.trim());
const commandArray = value => Array.isArray(value) && value.length > 0 &&
  value.every(v => typeof v === 'string' && !v.includes('\0')) && value[0].trim();
const fail = message => { throw new Error(`workflow: ${message}`); };
const hash = value => createHash('sha256').update(value).digest('hex');
function keys(value, allowed, label) {
  if (!object(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unknown ${label} field: ${key}`);
}

// Field values are JSON: an intentionally small, unambiguous YAML subset.
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) fail('expected --- frontmatter');
  const metadata = {};
  for (const line of match[1].split(/\r?\n/).filter(line => line.trim())) {
    const field = /^([a-z][a-z_]*):\s*(.+)$/.exec(line);
    if (!field) fail('frontmatter uses key: JSON-value on one line');
    if (Object.hasOwn(metadata, field[1])) fail(`duplicate field: ${field[1]}`);
    try { metadata[field[1]] = JSON.parse(field[2]); }
    catch { fail(`invalid JSON value for ${field[1]}`); }
  }
  keys(metadata, ['name', 'trigger', 'inputs', 'permissions', 'imports'], 'frontmatter');
  if (typeof metadata.name !== 'string' || !metadata.name.trim() ||
      typeof metadata.trigger !== 'string' || !metadata.trigger.trim()) fail('name and trigger are required strings');
  if (!object(metadata.inputs) || !strings(metadata.permissions)) fail('inputs object and permissions array are required');
  if (new Set(metadata.permissions).size !== metadata.permissions.length) fail('duplicate permission');
  for (const [name, input] of Object.entries(metadata.inputs)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) fail(`invalid input name: ${name}`);
    keys(input, ['required', 'default'], `input ${name}`);
    if (input.required !== undefined && typeof input.required !== 'boolean') fail(`invalid required for ${name}`);
    if (input.default !== undefined && typeof input.default !== 'string') fail(`input ${name} default must be a string`);
  }
  if (metadata.imports !== undefined && !strings(metadata.imports)) fail('imports must be relative paths');
  return { metadata, body: text.slice(match[0].length) };
}

function bodySections(body) {
  const sections = new Map();
  let current, fence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^```/.test(line)) fence = !fence;
    const heading = !fence && /^## (.+)$/.exec(line);
    if (heading) {
      current = heading[1];
      if (!['Steps', 'Gates', 'On failure'].includes(current) || sections.has(current)) fail(`unknown or duplicate section: ${current}`);
      sections.set(current, []);
    } else if (current) sections.get(current).push(line);
  }
  if (fence) fail('unclosed code fence');
  return new Map([...sections].map(([name, lines]) => [name, lines.join('\n').trim()]));
}
function stepsFrom(body) {
  const sections = bodySections(body), steps = [];
  if (!sections.has('Steps')) fail('missing ## Steps');
  let current, fence = false;
  for (const line of sections.get('Steps').split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    const heading = !fence && /^### ([a-z][a-z0-9-]*)(?: — (.+))?$/.exec(line);
    if (heading) { current = { id: heading[1], title: heading[2] ?? heading[1], lines: [] }; steps.push(current); }
    else if (current) current.lines.push(line);
    else if (line.trim()) fail('Steps must start with ### step-id');
  }
  for (const step of steps) {
    const content = step.lines.join('\n').trim();
    const blocks = [...content.matchAll(/^```json\n([\s\S]*?)\n```$/gm)];
    if (blocks.length !== 1 || (content.match(/^```/gm) ?? []).length !== 2) fail(`step ${step.id} needs one JSON block`);
    let definition;
    try { definition = JSON.parse(blocks[0][1]); } catch { fail(`invalid JSON in step ${step.id}`); }
    keys(definition, ['command', 'route', 'permission'], `step ${step.id}`);
    const command = definition.command !== undefined;
    if (command === (definition.route !== undefined)) fail(`step ${step.id} needs command or route`);
    if (command ? !commandArray(definition.command) : typeof definition.route !== 'string' || !definition.route.trim()) fail(`invalid command or route in ${step.id}`);
    if (typeof definition.permission !== 'string' || !definition.permission.trim()) fail(`step ${step.id} needs permission`);
    step.prose = content.replace(blocks[0][0], '').trim();
    if (!command && !step.prose) fail(`agent step ${step.id} needs prose`);
    Object.assign(step, definition, { kind: command ? 'command' : 'agent' });
    delete step.lines;
  }
  if (!steps.length) fail('workflow needs steps');
  return { steps, sections };
}
function complete(metadata, body, imported = []) {
  const { steps: own, sections } = stepsFrom(body), steps = [...imported, ...own];
  for (const section of ['Gates', 'On failure']) if (!sections.has(section)) fail(`missing ## ${section}`);
  const ids = new Set();
  for (const step of steps) {
    if (ids.has(step.id)) fail(`duplicate step: ${step.id}`);
    ids.add(step.id);
    if (!metadata.permissions.includes(step.permission)) fail(`undeclared permission: ${step.permission}`);
  }
  // Gates name command steps whose successful exit is required for completion.
  let gates;
  try { gates = JSON.parse(sections.get('Gates')); } catch { fail('Gates must be a JSON array of step ids'); }
  if (!strings(gates) || new Set(gates).size !== gates.length || gates.some(id => !steps.some(step => step.id === id && step.kind === 'command'))) fail('Gates must name unique command steps');
  if (!sections.get('On failure')) fail('On failure needs recovery prose');
  return { ...metadata, steps, gates, on_failure: sections.get('On failure') };
}

export function parseWorkflow(text) {
  const { metadata, body } = frontmatter(text.replace(/\r\n/g, '\n'));
  if (metadata.imports?.length) fail('use loadWorkflow to resolve imports');
  return complete(metadata, body);
}
export function loadWorkflow(file) {
  file = fs.realpathSync(file);
  const root = path.dirname(file), sources = [], seen = new Set();
  const read = name => { const text = readPlainFile(name); sources.push({ file: name, hash: hash(text) }); return text.replace(/\r\n/g, '\n'); };
  const { metadata, body } = frontmatter(read(file));
  const imported = [];
  for (const relative of metadata.imports ?? []) {
    if (path.isAbsolute(relative) || !relative.endsWith('.md')) fail('imports must be local .md paths');
    const target = fs.realpathSync(path.resolve(root, relative));
    const within = path.relative(root, target);
    if (within.startsWith('..' + path.sep) || within === '..' || path.isAbsolute(within) || target === file) fail('import escapes workflow directory or imports itself');
    if (seen.has(target)) fail('duplicate import');
    seen.add(target);
    const fragment = read(target);
    const parsed = stepsFrom(fragment);
    if (fragment.startsWith('---') || parsed.sections.size !== 1) fail('imports contain only ## Steps (no metadata or nested imports)');
    imported.push(...parsed.steps);
  }
  const workflow = complete(metadata, body, imported);
  return { ...workflow, file, sources, hash: hash(JSON.stringify(sources.map(source => ({ file: path.relative(root, source.file), hash: source.hash })))) };
}

function inputsFor(workflow, supplied) {
  const values = {};
  for (const name of Object.keys(supplied)) if (!Object.hasOwn(workflow.inputs, name)) fail(`unknown input: ${name}`);
  for (const [name, input] of Object.entries(workflow.inputs)) {
    const value = supplied[name] ?? input.default;
    if (value === undefined && input.required) fail(`missing input: ${name}`);
    if (value !== undefined && typeof value !== 'string') fail(`input ${name} must be a string`);
    values[name] = value;
  }
  return values;
}
const substitute = (text, values) => text.replace(/\{([a-z][a-z0-9_]*)\}/g, (_, name) => {
  if (values[name] === undefined) fail(`unbound input: ${name}`);
  return values[name];
});

// The host grants capabilities and may register local command verbs. Otherwise
// command arrays go directly to spawnSync. Grants are not an OS sandbox.
export function runWorkflow(workflow, { directory, inputs = {}, grants = [], cwd = process.cwd(), env = process.env,
  runCommand = (argv, options) => spawnSync(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }), dispatch, onStart } = {}) {
  const values = inputsFor(workflow, inputs);
  for (const permission of workflow.permissions) if (!grants.includes(permission)) fail(`permission not granted: ${permission}`);
  // Resolve all templates before any effect, including in a later step.
  const steps = workflow.steps.map(step => ({ ...step, prose: substitute(step.prose, values),
    ...(step.command ? { command: step.command.map(arg => substitute(arg, values)) } : { route: substitute(step.route, values) }) }));
  for (const step of steps) if (step.command ? !commandArray(step.command) : !step.route.trim() || step.route.includes('\0')) fail(`invalid resolved command or route in ${step.id}`);
  const runId = randomUUID(), runDirectory = plainDirectory(path.join(directory, runId));
  const run = { schema: 'workflow-run/v1', id: runId, name: workflow.name, workflow: workflow.file ?? null,
    workflow_hash: workflow.hash ?? hash(JSON.stringify(workflow)), status: 'running', started_at: new Date().toISOString(), steps: [] };
  const manifest = path.join(runDirectory, 'run.json');
  const save = () => writeFileAtomic(manifest, JSON.stringify(run, null, 2) + '\n', 0o600);
  save();
  onStart?.({ id: runId, manifest });
  let stopped = false, error;
  for (const step of steps) {
    const receipt = { schema: 'workflow-step/v1', run: runId, id: step.id, kind: step.kind, title: step.title,
      ...(step.command ? { command: step.command } : { route: step.route }),
      status: stopped ? 'skipped' : 'running', started_at: null, finished_at: null,
      output_path: path.join(runDirectory, `${step.id}.log`), receipt: path.join(runDirectory, `${step.id}.json`) };
    const persist = () => { writeFileAtomic(receipt.receipt, JSON.stringify(receipt, null, 2) + '\n', 0o600); save(); };
    run.steps.push(receipt);
    writeFileAtomic(receipt.output_path, '', 0o600);
    if (stopped) { receipt.reason = 'earlier step stopped this execution'; persist(); continue; }
    receipt.started_at = new Date().toISOString(); persist();
    try {
      const result = step.kind === 'command' ? runCommand(step.command, { cwd, env, step }) :
        dispatch ? dispatch({ route: step.route, prompt: step.prose, inputs: values, step: step.id, receipt: receipt.receipt }) : fail('agent step requires a dispatch adapter');
      if (!result || typeof result !== 'object' || typeof result.then === 'function') fail('adapter must return a synchronous result');
      if (result.error) throw result.error;
      writeFileAtomic(receipt.output_path, `${result.stdout ?? ''}${result.stderr ?? ''}`, 0o600);
      if (step.kind === 'agent') {
        if (typeof result.id !== 'string' || !result.id) fail('dispatch must return a durable id');
        receipt.status = 'dispatched'; receipt.dispatch_id = result.id; run.status = 'waiting'; stopped = true;
      } else {
        if ((!Number.isInteger(result.status) || result.status < 0) && !result.signal) fail('command must return a nonnegative exit status or signal');
        receipt.exit_code = result.status; receipt.signal = result.signal ?? null;
        receipt.status = result.status === 0 && !receipt.signal ? 'succeeded' : 'failed';
        if (result.output_path) receipt.artifact = result.output_path;
        if (receipt.status === 'failed' || result.halt) { stopped = true; run.status = receipt.status === 'failed' ? 'failed' : 'stopped'; }
      }
    } catch (caught) {
      error = caught; receipt.status = 'failed'; receipt.error = caught.message;
      writeFileAtomic(receipt.output_path, caught.message + '\n', 0o600); stopped = true; run.status = 'failed';
    }
    receipt.finished_at = new Date().toISOString(); persist();
  }
  if (!stopped) run.status = workflow.gates.every(id => run.steps.find(step => step.id === id)?.status === 'succeeded') ? 'succeeded' : 'failed';
  run.finished_at = new Date().toISOString(); save();
  return { ...run, manifest, error };
}
