import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { productFiles } from '../lib/product-files.mjs';
import { tierFiles } from './helpers/tier.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('every registry format row and machine inventory entry agree in both directions', () => {
  const registry = fs.readFileSync(new URL('../docs/contracts/REGISTRY.md', import.meta.url), 'utf8');
  const catalog = JSON.parse(fs.readFileSync(new URL('../docs/contracts/formats.json', import.meta.url), 'utf8'));
  assert.equal(catalog.schema, 'brain-formats/v1');
  const rows = registry.split('\n').filter(line => /^\| /.test(line) && !/^\| (Identifier|---)/.test(line));
  const persisted = [];
  for (const row of rows) {
    const cell = row.split(' | ')[0];
    const marker = /<!-- persisted: ([\w./-]+) -->/.exec(cell);
    assert.ok(marker || cell.includes('<!-- transient -->'), `classify registry row as persisted or transient: ${cell}`);
    if (marker) persisted.push(marker[1]);
  }
  const ids = catalog.formats.map(f => f.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(persisted).size, persisted.length);
  assert.deepEqual(ids.sort(), persisted.sort());
  for (const f of catalog.formats) {
    assert.ok(f.version && f.writer && f.location, `${f.id}: required version/writer/location`);
    assert.ok(['additive', 'closed'].includes(f.rule));
    assert.ok(Boolean(f.probe) !== Boolean(f.notCovered), `${f.id}: probe or named gap`);
    for (const module of f.writer.split('; ')) {
      if (module.startsWith('external ')) continue;
      assert.ok(fs.statSync(new URL('../' + module, import.meta.url)).isFile(), `${f.id}: writer exists`);
    }
  }
  assert.ok(productFiles(root).includes('docs/contracts/formats.json'), 'NEW installed bundles ship their list');
  for (const file of ['test/formats.test.mjs', 'test/compat.test.mjs']) assert.ok(tierFiles('promotion').includes(file));
});
