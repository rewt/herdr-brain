// Canonical project setting: a lane or environment variable cannot widen it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { within } from './paths.mjs';

function committedChatSource(context) {
  const git = args => execFileSync('/usr/bin/git', ['-C', context.canonical, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
      // Excluded wrappers must not inherit a chat-selected Git repository,
      // config injection, object directory or replacement-ref namespace.
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } });
  try {
    return git(['ls-tree', '--name-only', 'HEAD', '--', '.lane.json']).trim() ? git(['show', 'HEAD:.lane.json']) : '{}';
  } catch {
    let unborn = false;
    try {
      const ref = git(['symbolic-ref', '--quiet', 'HEAD']).trim();
      const loose = git(['rev-parse', '--git-path', ref]).trim();
      // Broken loose refs must never masquerade as an unborn repository.
      const refs = git(['for-each-ref', '--format=%(refname)', ref]);
      unborn = !fs.existsSync(path.resolve(context.canonical, loose)) && !refs.trim();
    } catch {}
    if (!unborn) throw new Error(`cannot read committed chat settings from HEAD in ${context.canonical}; repair the Git repository before launching a chat`);
    return '{}';
  }
}

export function chatHerdrPresets(context) {
  const presets = JSON.parse(committedChatSource(context)).chat?.presets ?? {};
  if (!presets || typeof presets !== 'object' || Array.isArray(presets)) throw Error('invalid chat.presets: expected named command/cwd objects');
  for (const [name, preset] of Object.entries(presets)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(name) || !preset || typeof preset !== 'object' || Array.isArray(preset) ||
      Object.keys(preset).some(key => !['command', 'cwd'].includes(key)) || typeof preset.command !== 'string' ||
      !preset.command.trim() || preset.command.length > 8192 || /[\0\r\n]/u.test(preset.command) ||
      typeof preset.cwd !== 'string' || !path.isAbsolute(preset.cwd) || /[\0\r\n]/u.test(preset.cwd))
      throw Error(`invalid chat preset ${name}: requires a fixed command and absolute cwd`);
  }
  return presets;
}

export function chatHerdrMode(context) {
  const file = path.join(context.canonical, '.lane.json');
  const parseMode = source => {
    const config = JSON.parse(source);
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        (config.chat !== undefined && (!config.chat || typeof config.chat !== 'object' || Array.isArray(config.chat))))
      throw new Error(`invalid chat settings in ${file}: expected an object`);
    const mode = config.chat?.herdr_mode === undefined ? 'full' : config.chat.herdr_mode;
    if (!['full', 'read', 'scoped'].includes(mode)) throw new Error(`invalid chat.herdr_mode in ${file}: expected full, read or scoped`);
    return mode;
  };
  const source = committedChatSource(context);
  const mode = parseMode(source);
  let working = 'full';
  try { working = parseMode(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (mode !== 'full' && working !== mode)
    throw new Error(`${mode}-mode chat refuses launch: chat.herdr_mode in ${file} differs from committed HEAD; restore the working tree or have the operator commit the mode change outside the chat`);
  return mode;
}

export function installedHerdrRead(entryBin, mode = 'read') {
  const name = mode === 'scoped' ? 'herdr-scoped' : 'herdr-read';
  if (!entryBin) throw new Error(`${mode}-mode chats require the installed ${name} entry wrapper`);
  const directory = fs.realpathSync(entryBin), wrapper = path.join(directory, name);
  if (!/^\/[A-Za-z0-9_./-]+$/u.test(wrapper)) throw new Error(`${mode}-mode wrapper path must contain only letters, numbers, slash, dot, underscore and hyphen for exact native command matching`);
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, '.monitor-entry.json'), 'utf8'));
  if (!receipt.herdrNative || !receipt.files?.[name] || !fs.lstatSync(wrapper).isFile() ||
      fs.readFileSync(wrapper, 'utf8') !== receipt.files[name])
    throw new Error(`${mode}-mode chats require an intact installed ${name} wrapper and resolved Herdr binary`);
  for (const binary of [wrapper, receipt.herdrNative]) fs.accessSync(binary, fs.constants.X_OK);
  if (!path.isAbsolute(receipt.herdrNative) || !fs.statSync(receipt.herdrNative).isFile()) throw new Error('installed Herdr binary is unavailable');
  if (typeof receipt.product !== 'string' || !path.isAbsolute(receipt.product)) throw new Error('installed product root must be an absolute directory');
  const productRoot = fs.realpathSync(receipt.product);
  if (!fs.statSync(productRoot).isDirectory()) throw new Error('installed product root is unavailable');
  return { wrapper, productRoot, scopeRoot: path.join(directory, '.herdr-scoped'), protectedPaths: [directory, receipt.product, productRoot, receipt.herdrNative, process.execPath] };
}

export function protectReadProduct(reader, writableRoots) {
  const root = writableRoots.find(root => within(root, reader.productRoot));
  if (root) throw new Error(`read-mode chat refuses launch: installed product ${reader.productRoot} lies inside writable root ${root}; install from a release outside the project or use full mode deliberately`);
}
