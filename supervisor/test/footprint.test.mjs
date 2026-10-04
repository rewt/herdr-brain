import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { measureArea, projectFootprint, formatBytes } from '../footprint.mjs';
import { coldStart, renderColdStart } from '../context.mjs';
import { fixture } from '../../settle/test/fixture.mjs';

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('footprint measures allocated and apparent bytes, deduplicates hardlinks and excludes symlink targets', t => {
  const root = directory(t), area = path.join(root, 'area'), outside = path.join(root, 'outside');
  fs.mkdirSync(area); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(area, 'small'), Buffer.alloc(1234));
  fs.linkSync(path.join(area, 'small'), path.join(area, 'hardlink'));
  fs.writeFileSync(path.join(outside, 'large'), Buffer.alloc(1024 ** 2));
  fs.symlinkSync(outside, path.join(area, 'link'));
  const doc = measureArea(area);
  const own = ['.', 'small', 'link'].map(name => fs.lstatSync(path.join(area, name)));
  assert.equal(doc.bytes, own.reduce((n, s) => n + s.blocks * 512, 0));
  assert.equal(doc.apparent_bytes, own.reduce((n, s) => n + s.size, 0));
  assert.match(doc.warning, /symlink targets excluded/);
  assert.equal(measureArea(path.join(root, 'missing')).bytes, 0);
  assert.equal(measureArea(path.join(root, 'missing')).warning, null);
  assert.match(measureArea(area, { maxEntries: 1 }).warning, /lower bound/);
  assert.match(measureArea(area, { maxMs: 0 }).warning, /lower bound/);
  assert.deepEqual([123, 1024, 1024 ** 2, 1024 ** 3].map(formatBytes), ['123 B', '1.0 KiB', '1.0 MiB', '1.0 GiB']);
});

test('cold start renders exactly four storage advisories scoped to the Git common directory without writes or refusal', t => {
  const f = fixture(t), project = { identity: path.join(f.repo, '.git') };
  for (const area of ['release', 'lane-validation', 'promote']) {
    fs.mkdirSync(path.join(project.identity, area), { recursive: true });
    fs.writeFileSync(path.join(project.identity, area, 'bytes'), Buffer.alloc(4321));
  }
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  const doc = coldStart({ cwd: f.workspace, org: f.org, env: f.env,
    memory: { total: 16 * 1024 ** 3, available: 8 * 1024 ** 3, swap_used: 0 }, processes: { by_memory: [], by_cpu: [] } });
  assert.deepEqual(doc.footprint, projectFootprint(project, f.org));
  assert.deepEqual(doc.footprint.map(row => row.area), ['record', 'release', 'lane validation', 'promote batches']);
  assert.ok(doc.footprint.every(row => row.bytes > 0));
  const text = renderColdStart(doc);
  assert.equal(text.split('\n').filter(line => line.startsWith('Storage advisory:')).length, 4);
  assert.match(text, /Storage advisory: release .* on disk .* apparent/);
  assert.doesNotMatch(text, /Wait before/);
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
  assert.equal(fs.existsSync(path.join(f.org, 'supervisor')), false);
});
