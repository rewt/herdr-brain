// Canonical project setting: a lane or environment variable cannot widen it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { within } from './paths.mjs';

export function chatHerdrMode(context) {
  const file = path.join(context.canonical, '.lane.json');
  const parseMode = source => {
    const config = JSON.parse(source);
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        (config.chat !== undefined && (!config.chat || typeof config.chat !== 'object' || Array.isArray(config.chat))))
      throw new Error(`invalid chat settings in ${file}: expected an object`);
    const mode = config.chat?.herdr_mode === undefined ? 'full' : config.chat.herdr_mode;
    if (!['full', 'read'].includes(mode)) throw new Error(`invalid chat.herdr_mode in ${file}: expected full or read`);
    return mode;
  };
  const git = args => execFileSync('git', ['-C', context.canonical, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
  let source = '{}';
  try {
    if (git(['ls-tree', '--name-only', 'HEAD', '--', '.lane.json']).trim())
      source = git(['show', 'HEAD:.lane.json']);
  } catch {
    // Only a symbolic HEAD whose branch ref is absent is an unborn repository.
    // Corrupt refs, missing objects and other Git failures still fail closed.
    let unborn = false;
    try {
      const ref = git(['symbolic-ref', '--quiet', 'HEAD']).trim();
      try { git(['show-ref', '--verify', '--quiet', ref]); }
      catch (error) { unborn = error.status === 1; }
    } catch {}
    if (!unborn) throw new Error(`cannot read committed chat settings from HEAD in ${context.canonical}; repair the Git repository before launching a chat`);
  }
  const mode = parseMode(source);
  let working = 'full';
  try { working = parseMode(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (mode === 'read' && working !== mode)
    throw new Error(`read-mode chat refuses launch: chat.herdr_mode in ${file} differs from committed HEAD; restore the working tree or have the operator commit the mode change outside the chat`);
  return mode;
}

export function installedHerdrRead(entryBin) {
  if (!entryBin) throw new Error('read-mode chats require the installed herdr-read entry wrapper');
  const directory = fs.realpathSync(entryBin), wrapper = path.join(directory, 'herdr-read');
  if (!/^\/[A-Za-z0-9_./-]+$/u.test(wrapper)) throw new Error('read-mode wrapper path must contain only letters, numbers, slash, dot, underscore and hyphen for exact native command matching');
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, '.monitor-entry.json'), 'utf8'));
  if (!receipt.herdrNative || !receipt.files?.['herdr-read'] || !fs.lstatSync(wrapper).isFile() ||
      fs.readFileSync(wrapper, 'utf8') !== receipt.files['herdr-read'])
    throw new Error('read-mode chats require an intact installed herdr-read wrapper and resolved Herdr binary');
  for (const binary of [wrapper, receipt.herdrNative]) fs.accessSync(binary, fs.constants.X_OK);
  if (!path.isAbsolute(receipt.herdrNative) || !fs.statSync(receipt.herdrNative).isFile()) throw new Error('installed Herdr binary is unavailable');
  if (typeof receipt.product !== 'string' || !path.isAbsolute(receipt.product)) throw new Error('installed product root must be an absolute directory');
  const productRoot = fs.realpathSync(receipt.product);
  if (!fs.statSync(productRoot).isDirectory()) throw new Error('installed product root is unavailable');
  return { wrapper, productRoot, protectedPaths: [directory, receipt.product, productRoot, receipt.herdrNative, process.execPath] };
}

export function protectReadProduct(reader, writableRoots) {
  const root = writableRoots.find(root => within(root, reader.productRoot));
  if (root) throw new Error(`read-mode chat refuses launch: installed product ${reader.productRoot} lies inside writable root ${root}; install from a release outside the project or use full mode deliberately`);
}
