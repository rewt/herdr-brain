import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { configFixture } from '../../test/helpers/config-home-fixture.mjs';
import { policyLocation } from '../../lib/config-home.mjs';

// Exercise the actual builder beyond the CLI's existing ASCII topic policy.
const source = readFileSync(new URL('../lane.mjs', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const root = '/identity-a', common = '/project/.git', checkout = '/project', lane = '/lanes/topic';
const label = runInNewContext([
  section('function samePath(', 'function candidateIsCanonicalCheckout('),
  section('function workspaceMatches(', 'function parentWorkspaceId('),
  section('const GRAPHEME_SEGMENTER =', 'function newAgentName('),
  'workspaceLabel',
].join('\n'), { createHash, realpathSync, resolve, ROOT_IDENTITY: root, REPO_IDENTITY: common,
  REPO_ROOT: checkout, fail: message => { throw Error(message); } });
const digest = (topic, length = 8) => createHash('sha256').update(`${root}\0${common}\0${topic}`).digest('hex').slice(0, length);
const foreign = value => ({ label: value, worktree: { repo_key: '/foreign/.git', repo_root: '/foreign',
  checkout_path: '/foreign/lane', is_linked_worktree: true } });

test('workspace labels keep topics verbatim through the native 64-codepoint boundary', () => {
  for (const topic of ['rehearsal-component-current', 'a'.repeat(64), 'e\u0301'.repeat(32), '👨‍👩‍👧‍👦'.repeat(9)]) {
    assert.equal(label(topic, lane), topic);
  }
});

test('workspace label overflow preserves complete Unicode graphemes plus an opaque digest', () => {
  for (const grapheme of ['e\u0301', '👨‍👩‍👧‍👦', '🇺🇸']) {
    const topic = grapheme.repeat(70);
    const value = label(topic, lane);
    assert.ok([...value].length <= 64);
    assert.ok(value.endsWith(`…~${digest(topic)}`));
    const prefix = value.slice(0, -10);
    assert.ok(prefix.length > 0);
    assert.equal(prefix, grapheme.repeat(prefix.length / grapheme.length));
  }
});

test('workspace label collisions extend only the necessary digest and retain the length bound', () => {
  const topic = 'topic-' + 'a'.repeat(55);
  const occupied = [foreign(topic)];
  let value = label(topic, lane, occupied);
  assert.equal(value, `${topic.slice(0, 54)}…~${digest(topic)}`);
  for (let length = 8; length < 62; length += 1) {
    occupied.push(foreign(value));
    value = label(topic, lane, occupied);
    assert.ok([...value].length <= 64);
    assert.ok(value.endsWith(`~${digest(topic, length + 1)}`));
  }
  occupied.push(foreign(value));
  assert.throws(() => label(topic, lane, occupied), /cannot produce a unique Herdr workspace label/);
});

test('a matching display label never overrides canonical workspace ownership', () => {
  const topic = 'shared-topic';
  const own = { label: topic, worktree: { repo_key: common, repo_root: checkout,
    checkout_path: lane, is_linked_worktree: true } };
  assert.equal(label(topic, lane, [own]), topic);
  for (const field of ['repo_key', 'repo_root', 'checkout_path', 'is_linked_worktree']) {
    const impostor = { ...own, worktree: { ...own.worktree, [field]: field === 'is_linked_worktree' ? false : '/foreign' } };
    assert.equal(label(topic, lane, [impostor]), `${topic}~${digest(topic)}`);
  }
});

test('purpose-label source entry reaches pinned projects without changing their pin or immutable runtime', async t => {
  const f = configFixture(t); await f.adopt();
  const sourceRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  const sourceCLI = join(sourceRoot, 'lanes/lane.mjs');
  const pinnedCLI = join(f.bundle, 'lanes/lane.mjs');
  // Seal a distinguishable scratch fixture entry, never the installed bundle.
  writeFileSync(pinnedCLI, "process.stdout.write('pinned lane entry\\n');\n");
  const manifest = spawnSync(process.execPath, [join(sourceRoot, 'herdr/releases.mjs'), 'manifest', f.bundle,
    join(f.bundle, '.release-acceptance.json')], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
  assert.equal(manifest.status, 0, manifest.stderr);
  const pin = policyLocation(f.cwd, 'pin', f.env).file, before = readFileSync(pin);
  const run = (entry, selected) => spawnSync(process.execPath, [entry, 'config'], {
    cwd: f.cwd, env: { ...f.env, HERDR_BRAIN_ROOT: selected }, encoding: 'utf8',
  });
  const normal = run(sourceCLI, '');
  assert.equal(normal.status, 0, normal.stderr); assert.equal(normal.stdout, 'pinned lane entry\n');
  const selected = run(sourceCLI, sourceRoot);
  assert.equal(selected.status, 0, selected.stderr); assert.match(selected.stdout, /^main\t/m);
  const mismatch = run(sourceCLI, f.cwd);
  assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /must match the invoked development source root/);
  const saved = run(pinnedCLI, sourceRoot);
  assert.equal(saved.status, 0, saved.stderr); assert.equal(saved.stdout, 'pinned lane entry\n');
  assert.deepEqual(readFileSync(pin), before);
});
