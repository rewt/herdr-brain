// Summary and cycle-time pairs share one lock and one atomic generation switch.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { plainDirectory, readPlainFile } from './files.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const generated = name => /^(?:summary|cycle-time-[a-f0-9]{24})\.(?:json|md)$/.test(name);

// Replace one complete pair while carrying the other publisher's latest pair
// forward. The directory and lock names retain the existing summary layout.
export function writeProjectPublication(org, { projectId, files }) {
  const names = Object.keys(files).sort();
  if (names.length !== 2 || !names.every(generated) || !names[0].endsWith('.json') ||
      names[1] !== names[0].replace(/\.json$/, '.md') || names.some(n => typeof files[n] !== 'string'))
    throw Error('publication requires one complete generated pair');
  const kind = names[0] === 'summary.json' ? 'summary' : 'cycle-time';
  org = fs.realpathSync(org);
  const lock = path.join(org, '.summary-publish.lock');
  fs.mkdirSync(lock);
  const publicPath = path.join(org, 'published'), generations = path.join(org, '.published-summaries');
  const temporary = path.join(org, `.published-${randomUUID()}`);
  try {
    let previous;
    try {
      if (!fs.lstatSync(publicPath).isSymbolicLink()) throw Error('published must be the summary generation link');
      previous = fs.readlinkSync(publicPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const combined = {};
    let emptyPrevious, retained = [];
    if (previous !== undefined) {
      if (!/^\.published-summaries\/[a-f0-9]{64}$/.test(previous)) throw Error('unrecognised summary generation');
      let directory;
      try {
        directory = plainDirectory(path.join(org, previous), { create: false });
        const entries = fs.readdirSync(directory);
        if (!entries.length) emptyPrevious = directory;
        retained = entries.filter(generated).sort();
        if (entries.length && !retained.length) throw Error('incomplete publication generation');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const name of retained.filter(n => n.endsWith('.json'))) {
        const json = readPlainFile(path.join(directory, name));
        const owner = JSON.parse(json);
        const ownerId = name === 'summary.json' ? owner.project?.id :
          typeof owner.project?.identity === 'string' ? hash(owner.project.identity) : null;
        if (ownerId !== projectId) throw Error('record publication belongs to a different canonical project');
      }
      if (retained.length > 4 || retained.some(name => !retained.includes(
        name.endsWith('.json') ? name.replace(/\.json$/, '.md') : name.replace(/\.md$/, '.json'))))
        throw Error('incomplete publication generation');
      for (const name of retained) {
        if ((name.startsWith('summary.') ? 'summary' : 'cycle-time') !== kind)
          combined[name] = readPlainFile(path.join(directory, name));
      }
    }
    Object.assign(combined, files);
    plainDirectory(generations);
    const entries = Object.entries(combined).sort(([a], [b]) => a.localeCompare(b));
    const name = hash(JSON.stringify(entries)), generation = path.join(generations, name);
    let created = false;
    try {
      // An identical refresh can name the missing/empty predecessor itself.
      // Drop its invalid link so rebuilding cannot expose a partial pair.
      if (!retained.length && previous === `.published-summaries/${name}`) {
        fs.unlinkSync(publicPath);
        if (generation === emptyPrevious) fs.rmdirSync(generation);
      }
      fs.mkdirSync(generation);
      created = true;
      for (const [file, content] of entries) fs.writeFileSync(path.join(generation, file), content, { flag: 'wx' });
    } catch (error) {
      if (created) {
        for (const [file] of entries) fs.rmSync(path.join(generation, file), { force: true });
        fs.rmdirSync(generation);
        throw error;
      }
      if (error.code !== 'EEXIST') throw error;
      plainDirectory(generation, { create: false });
      if (entries.some(([file, content]) => readPlainFile(path.join(generation, file)) !== content)) throw error;
    }
    fs.symlinkSync(`.published-summaries/${name}`, temporary);
    fs.renameSync(temporary, publicPath);
    for (const old of fs.readdirSync(generations).filter(n => /^[a-f0-9]{64}$/.test(n) && n !== name && `.published-summaries/${n}` !== previous)) {
      const directory = path.join(generations, old);
      if (!fs.lstatSync(directory).isDirectory()) continue;
      try {
        for (const file of fs.readdirSync(directory).filter(generated)) fs.rmSync(path.join(directory, file), { force: true });
        fs.rmdirSync(directory);
      } catch { /* Preserve anything not generated here; publication has succeeded. */ }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
    fs.rmdirSync(lock);
  }
}
