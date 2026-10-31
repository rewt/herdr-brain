import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverScratch } from './helpers/scratch.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-preservation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scratch = path.join(root, 'scratch'), journal = path.join(root, 'owned.jsonl');
  fs.mkdirSync(scratch);
  const owner = { pid: 400, pgid: 400, identity: 'birth' };
  const register = directories => fs.writeFileSync(journal, directories.map(directory => {
    const stat = fs.lstatSync(directory, { bigint: true });
    return JSON.stringify({ schema: 'test-scratch/v1', root: directory, owner,
      dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) });
  }).join('\n'));
  const recover = () => recoverScratch(journal, { joined: true, suite: owner,
    lookup: () => ({ ok: true, value: null }), groupProbe: () => ({ ok: true, absent: true }) });
  return { root, scratch, journal, register, recover };
}

test('scratch recovery preserves whole evidence before an unlink fails midway', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.scratch, 'a-evidence'), 'first evidence');
  fs.mkdirSync(path.join(f.scratch, 'frozen'));
  fs.writeFileSync(path.join(f.scratch, 'frozen/.nvmrc'), '20.19.4\n', { mode: 0o444 });
  const foreign = path.join(f.root, 'foreign'); fs.writeFileSync(foreign, 'foreign');
  fs.symlinkSync(foreign, path.join(f.scratch, 'link'));
  f.register([f.scratch]);
  const remove = fs.rmSync;
  fs.rmSync = function (file, options) {
    if (file === f.scratch) {
      fs.unlinkSync(path.join(file, 'a-evidence'));
      throw Object.assign(Error('frozen .nvmrc'), { code: 'EACCES' });
    }
    return remove(file, options);
  };
  let result;
  try { result = f.recover(); } finally { fs.rmSync = remove; }
  assert.equal(result.removed, 0); assert.equal(result.retained, 1);
  const row = result.results[0], saved = row.preservation;
  assert.equal(saved.verified, true); assert.match(saved.sha256, /^[a-f0-9]{64}$/);
  assert.match(row.reason, /whole evidence preserved.*frozen .nvmrc/);
  assert.equal(fs.existsSync(path.join(f.scratch, 'a-evidence')), false, 'the injected unlink really was partial');
  assert.equal(fs.readFileSync(path.join(saved.root, 'a-evidence'), 'utf8'), 'first evidence');
  assert.equal(fs.readFileSync(path.join(saved.root, 'frozen/.nvmrc'), 'utf8'), '20.19.4\n');
  assert.equal(fs.statSync(path.join(saved.root, 'frozen/.nvmrc')).mode & 0o777, 0o444);
  assert.equal(fs.readlinkSync(path.join(saved.root, 'link')), foreign);
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign');
  const receipt = JSON.parse(fs.readFileSync(path.join(saved.directory, 'preservation.json')));
  assert.equal(receipt.source.root, f.scratch); assert.deepEqual(receipt.source.preservation, saved);
  console.error(`SCRATCH_PRESERVATION_WITNESS: ${JSON.stringify({ source: f.scratch, ...saved, retained: result.retained })}`);
});

test('scratch recovery leaves a frozen tree whole when copying or unlinking gets EACCES', t => {
  const f = fixture(t), frozen = path.join(f.scratch, 'z-frozen');
  fs.writeFileSync(path.join(f.scratch, 'a-evidence'), 'keep');
  fs.mkdirSync(frozen);
  fs.writeFileSync(path.join(frozen, '.nvmrc'), '20.19.4\n', { mode: 0o444 });
  f.register([f.scratch]); fs.chmodSync(frozen, 0o555);
  let result;
  try { result = f.recover(); } finally {
    fs.chmodSync(frozen, 0o755);
    // A copied read-only fixture is ours; restore it only for fixture teardown.
    for (const directory of fs.readdirSync(f.root).filter(name => name.startsWith('preserved-'))) {
      const copy = path.join(f.root, directory, 'tree/z-frozen');
      if (fs.existsSync(copy)) fs.chmodSync(copy, 0o755);
    }
  }
  assert.equal(result.retained, 1); assert.equal(result.removed, 0);
  const row = result.results[0], whole = row.preservation?.verified ? row.preservation.root : f.scratch;
  assert.equal(fs.readFileSync(path.join(whole, 'a-evidence'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(whole, 'z-frozen/.nvmrc'), 'utf8'), '20.19.4\n');
  assert.match(row.reason, /EACCES|permission denied/);
});

test('scratch recovery never unlinks source when checkpoint creation fails', t => {
  const f = fixture(t), nested = path.join(f.scratch, 'nested');
  fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, 'evidence'), 'keep'); f.register([f.scratch, nested]);
  const copy = fs.cpSync;
  fs.cpSync = () => { throw Object.assign(Error('checkpoint EACCES'), { code: 'EACCES' }); };
  let result;
  try { result = f.recover(); } finally { fs.cpSync = copy; }
  assert.equal(result.retained, 2); assert.equal(result.results[0].preservation.verified, false);
  assert.equal(fs.readFileSync(path.join(nested, 'evidence'), 'utf8'), 'keep');
  assert.match(result.results[0].reason, /preservation refused; source untouched/);
});

test('scratch recovery checkpoints ancestors before removing nested registered evidence', t => {
  const f = fixture(t), nested = path.join(f.scratch, 'nested'); fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'evidence'), 'nested evidence'); f.register([f.scratch, nested]);
  const remove = fs.rmSync;
  fs.rmSync = function (file, options) {
    if (file === f.scratch) throw Object.assign(Error('parent EACCES'), { code: 'EACCES' });
    return remove(file, options);
  };
  let result;
  try { result = f.recover(); } finally { fs.rmSync = remove; }
  assert.equal(result.removed, 1); assert.equal(result.retained, 1);
  assert.equal(fs.existsSync(nested), false);
  assert.equal(fs.readFileSync(path.join(result.results[0].preservation.root, 'nested/evidence'), 'utf8'), 'nested evidence');
});
