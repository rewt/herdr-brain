// The installed shell launcher pins both the binary and binding directory.
// Nothing in user argv, PATH, pane environment or run temp selects authority.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ownerProcess } from '../lib/process-owner.mjs';
import { writeFileAtomic, readPlainFile } from '../lib/files.mjs';
import { readArguments, executeRead } from './herdr-read.mjs';
import { chatHerdrPresets } from './chat-herdr.mjs';

const paneID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}:p[1-9][0-9]{0,9}$/u;
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const fail = message => { throw Error(`scoped Herdr refused: ${message}`); };

function plainRoot(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022) || fs.realpathSync(root) !== root)
    fail('binding directory is redirected or not privately owned');
}
export function processChain(pid = process.pid, read) {
  const chain = [];
  while (pid > 0 && chain.length < 128) {
    if (chain.some(row => row.pid === pid)) fail('cyclic process ancestry');
    const row = ownerProcess(pid, read);
    if (!row || !Number.isSafeInteger(row.ppid) || row.ppid < 0) fail('caller ancestry unavailable');
    chain.push(row); pid = row.ppid;
  }
  if (pid !== 0) fail('caller ancestry is too deep');
  // A reused PID or reparent during the walk must not connect unrelated trees.
  for (const row of chain) {
    const live = ownerProcess(row.pid, read);
    if (!live || live.identity !== row.identity || live.ppid !== row.ppid) fail('caller ancestry changed');
  }
  return chain;
}
const matches = (chain, owner) => owner && chain.some(row => row.pid === owner.pid && row.identity === owner.identity);
function bindings(root) {
  plainRoot(root);
  return fs.readdirSync(root).filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).map(name => {
    const file = path.join(root, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('unsafe binding file');
    const binding = JSON.parse(readPlainFile(file));
    if (binding.version !== 1 || !paneID.test(binding.pane) || typeof binding.workspace !== 'string' ||
      typeof binding.tab !== 'string' || !path.isAbsolute(binding.canonical ?? '') || !path.isAbsolute(binding.socket ?? '') || !binding.shell)
      fail('incomplete launcher binding');
    return { file, binding };
  });
}
export function createScopedBinding({ root, receipt, canonical, shell, socket }) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 }); plainRoot(root);
  const file = path.join(root, createHash('sha256').update(canonical).digest('hex') + '.json');
  const binding = { version: 1, workspace: receipt.workspace, tab: receipt.tab, pane: receipt.pane,
    canonical: fs.realpathSync(canonical), shell: { pid: shell.pid, identity: shell.identity }, socket };
  writeFileAtomic(file, JSON.stringify(binding) + '\n', 0o600);
  return file;
}
// Called only by the unsandboxed installed chat adapter, before native launch.
// A shell receipt comes from the tab launcher, never inherited pane variables.
export function claimScopedBinding(root, canonical, { pid = process.pid, read } = {}) {
  const chain = processChain(pid, read);
  const candidates = bindings(root).filter(({ binding }) => binding.canonical === fs.realpathSync(canonical) && matches(chain, binding.shell));
  if (candidates.length !== 1) fail('no unique launcher shell binding for this chat');
  const { file, binding } = candidates[0];
  if (binding.owner && ownerProcess(binding.owner.pid, read)?.identity === binding.owner.identity)
    fail('launcher binding already has a live chat owner');
  const owner = chain[0]; binding.owner = { pid: owner.pid, identity: owner.identity };
  writeFileAtomic(file, JSON.stringify(binding) + '\n', 0o600);
  return { file, owner: binding.owner };
}
export function releaseScopedBinding({ file, owner }) {
  let binding;
  try { binding = JSON.parse(readPlainFile(file)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (binding.owner?.pid === owner.pid && binding.owner.identity === owner.identity) {
    delete binding.owner; writeFileAtomic(file, JSON.stringify(binding) + '\n', 0o600);
  }
}
export function callerBinding(root, { pid = process.pid, read } = {}) {
  const chain = processChain(pid, read);
  const found = bindings(root).filter(({ binding }) => matches(chain, binding.owner) && matches(chain, binding.shell));
  if (found.length !== 1) fail('caller has no unique live launcher-owned chat binding');
  return found[0].binding;
}

export function scopedArguments(args) {
  try { return { kind: 'read', argv: readArguments(args) }; } catch {}
  if (args.some(arg => typeof arg !== 'string' || /[\r\n\0]/u.test(arg))) fail('invalid arguments');
  const [group, operation, target, ...rest] = args;
  if (group === 'preset' && operation === 'start' && /^[a-z][a-z0-9_-]{0,63}$/u.test(target ?? '') && rest.length === 2 && rest[0] === '--pane' && (rest[1] === 'new' || paneID.test(rest[1])))
    return { kind: 'preset', name: target, target: rest[1] };
  if (group !== 'pane') fail('only reads, pane layout, stop and declared presets are allowed');
  if (operation === 'new' && args.length === 2) return { kind: 'new' };
  if (!paneID.test(target ?? '')) fail('an explicit pane ID is required');
  if (['close', 'stop'].includes(operation) && !rest.length) return { kind: operation, target };
  if (operation === 'rename' && rest.length === 1 && /^[A-Za-z0-9 .,!?_:@/+=-]{1,128}$/u.test(rest[0])) return { kind: 'rename', target, label: rest[0] };
  if (operation === 'split' && rest.length === 2 && rest[0] === '--direction' && /^(right|down)$/u.test(rest[1])) return { kind: 'split', target, direction: rest[1] };
  if (['resize', 'focus'].includes(operation) && rest.length === 2 && rest[0] === '--direction' && /^(left|right|up|down)$/u.test(rest[1])) return { kind: operation, target, direction: rest[1] };
  fail('arbitrary run, send-keys, send-text and other commands are unavailable');
}
// Do not pass caller-selected socket/config/session/caller context to Herdr.
const scopedEnvironment = socket => ({ PATH: '/usr/bin:/bin', HOME: process.env.HOME, HERDR_SOCKET_PATH: socket });
export function scopedHerdr(binary, socket) {
  const env = scopedEnvironment(socket);
  return argv => {
    const result = spawnSync(binary, argv, { env, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) fail(`Herdr call failed: ${result.stderr || result.error?.message || result.status}`);
    return result.stdout;
  };
}

export function executeScoped(request, { binding, call, verifyCaller = () => {}, sleep = pause, now = Date.now, presets = () => chatHerdrPresets({ canonical: binding.canonical }) }) {
  const json = argv => {
    const body = JSON.parse(call(argv));
    if (body.ok === false || !body.result) fail('Herdr returned an uncertain result');
    return body.result;
  };
  const member = (id, anchor = false) => {
    verifyCaller();
    const own = json(['pane', 'get', binding.pane]).pane;
    if (own?.pane_id !== binding.pane || own.tab_id !== binding.tab || own.workspace_id !== binding.workspace) fail('chat pane moved or disappeared');
    const target = id === binding.pane ? own : json(['pane', 'get', id]).pane;
    if (target?.pane_id !== id || target.tab_id !== binding.tab || target.workspace_id !== binding.workspace) fail('target is outside the chat tab or membership is unknown');
    if (id === binding.pane && !anchor) fail('the chat own pane is protected');
  };
  // The immediately preceding operation is always a fresh membership lookup.
  const mutate = (id, argv, anchor = false) => {
    member(id, anchor);
    const output = call(argv), body = JSON.parse(output);
    if (body.ok === false || !body.result) fail('Herdr mutation returned an uncertain result');
    return output;
  };
  const empty = id => {
    member(id);
    const info = json(['pane', 'process-info', '--pane', id]).process_info;
    const text = call(['pane', 'read', id, '--format', 'text']).trimEnd();
    if (!Number.isSafeInteger(info?.shell_pid) || info.shell_pid < 1 || info.foreground_processes?.length !== 1 ||
      info.foreground_processes[0].pid !== info.shell_pid || !/[$#%❯➜›]$/u.test(text.split('\n').at(-1) ?? '')) return null;
    return { pid: info.shell_pid, text };
  };
  const ready = (id, wait = false) => {
    const deadline = now() + 3000;
    let samples = 0;
    let previous;
    do {
      const current = empty(id); samples++;
      if (current && previous?.pid === current.pid && previous.text === current.text) return;
      previous = current; sleep(100);
    } while ((wait || samples < 2) && now() < deadline);
    fail('preset destination is not a verified empty shell at a stable prompt');
  };
  const create = (anchor, direction = 'right', ownAnchor = false, cwd = binding.canonical) => {
    const result = JSON.parse(mutate(anchor, ['pane', 'split', anchor, '--direction', direction, '--cwd', cwd, '--no-focus'], ownAnchor));
    if (result.ok === false || !paneID.test(result.result?.pane?.pane_id ?? '')) fail('Herdr returned no new pane');
    const id = result.result.pane.pane_id; member(id); return { id, output: JSON.stringify(result) };
  };
  if (request.kind === 'new') return create(binding.pane, 'right', true).output;
  if (request.kind === 'split') return create(request.target, request.direction).output;
  if (request.kind === 'close') return mutate(request.target, ['pane', 'close', request.target]);
  if (request.kind === 'stop') {
    mutate(request.target, ['pane', 'send-keys', request.target, 'ctrl+c']);
    sleep(1000);
    return mutate(request.target, ['pane', 'close', request.target]);
  }
  if (request.kind === 'rename') return mutate(request.target, ['pane', 'rename', request.target, request.label]);
  if (request.kind === 'resize') return mutate(request.target, ['pane', 'resize', '--pane', request.target, '--direction', request.direction, '--amount', '0.05']);
  if (request.kind === 'focus') {
    member(request.target);
    const neighbor = json(['pane', 'neighbor', '--pane', request.target, '--direction', request.direction]).neighbor?.neighbor_pane_id;
    if (typeof neighbor !== 'string' || !paneID.test(neighbor)) fail('no focus neighbor');
    member(neighbor);
    // Neighbor identity can change too; refuse a change observed before focus.
    if (json(['pane', 'neighbor', '--pane', request.target, '--direction', request.direction]).neighbor?.neighbor_pane_id !== neighbor) fail('focus neighbor changed');
    member(neighbor);
    return mutate(request.target, ['pane', 'focus', '--pane', request.target, '--direction', request.direction]);
  }
  if (request.kind === 'preset') {
    const declared = presets();
    if (!Object.hasOwn(declared, request.name)) fail('undeclared preset');
    const preset = declared[request.name];
    // Creation accepts no caller cwd/env. The preset supplies both command/cwd.
    let id = request.target;
    if (id === 'new') id = create(binding.pane, 'right', true, preset.cwd).id;
    else member(id);
    ready(id, request.target === 'new');
    // Check emptiness again immediately before the final membership read/run.
    if (!empty(id)) fail('preset destination became busy');
    return mutate(id, ['pane', 'run', id, `cd -- ${quote(preset.cwd)} && ${preset.command}`]);
  }
  fail('unknown operation');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [binary, root, ...args] = process.argv.slice(2);
    if (!path.isAbsolute(binary ?? '') || !path.isAbsolute(root ?? '')) fail('installed launcher unavailable');
    const request = scopedArguments(args);
    // Reads need no tab scope, but require the caller binding for its pinned socket.
    const trusted = callerBinding(root);
    if (request.kind === 'read') {
      executeRead(binary, request.argv, { env: scopedEnvironment(trusted.socket), label: 'herdr-scoped' });
    } else {
      const call = scopedHerdr(binary, trusted.socket);
      const verifyCaller = () => {
        const live = callerBinding(root);
        if (JSON.stringify(live) !== JSON.stringify(trusted)) fail('launcher binding changed');
      };
      process.stdout.write(executeScoped(request, { binding: trusted, call, verifyCaller }));
    }
  } catch (error) { console.error(`herdr-scoped: ${error.message}`); process.exitCode = 1; }
}
