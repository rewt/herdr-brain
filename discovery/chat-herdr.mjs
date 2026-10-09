// Canonical project setting: a lane or environment variable cannot widen it.
import fs from 'node:fs';
import path from 'node:path';

export function chatHerdrMode(context) {
  const file = path.join(context.canonical, '.lane.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (config.chat !== undefined && (!config.chat || typeof config.chat !== 'object' || Array.isArray(config.chat)))
    throw new Error(`invalid chat settings in ${file}: expected an object`);
  const mode = config.chat?.herdr_mode === undefined ? 'full' : config.chat.herdr_mode;
  if (!['full', 'read'].includes(mode)) throw new Error(`invalid chat.herdr_mode in ${file}: expected full or read`);
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
  return { wrapper, protectedPaths: [directory, path.join(receipt.product, 'discovery/herdr-read.mjs'), receipt.herdrNative, process.execPath] };
}
