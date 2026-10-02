import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalWorkspaceId } from '../supervisor/workspace.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-identity-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), foreign = path.join(root, 'other', 'project');
  fs.mkdirSync(cwd); fs.mkdirSync(foreign, { recursive: true });
  for (const repo of [cwd, foreign]) execFileSync('git', ['init', '-q', repo]);
  const metadata = { repo_key: path.join(cwd, '.git'), repo_root: cwd, checkout_path: cwd, is_linked_worktree: false };
  const receipt = { source: { repo_key: metadata.repo_key, repo_root: cwd, source_checkout_path: cwd },
    worktrees: [{ path: cwd, is_linked_worktree: false, open_workspace_id: 'opaque-canonical' }] };
  const workspaces = [{ workspace_id: 'opaque-canonical', label: 'unrelated display label' }];
  const calls = [];
  const herdr = (args) => {
    calls.push(args);
    return { ok: true, result: args[0] === 'worktree' ? receipt : { workspaces } };
  };
  return { root, cwd, foreign, metadata, receipt, workspaces, calls, herdr };
}

test('canonical background lookup uses native Git identity without publishing metadata or focus', (t) => {
  const f = fixture(t);
  assert.equal(canonicalWorkspaceId(f.cwd, f.herdr), 'opaque-canonical');
  assert.deepEqual(f.calls, [['worktree', 'list', '--cwd', f.cwd], ['workspace', 'list']]);
  assert.equal(f.workspaces[0].worktree, undefined);
  f.workspaces[0].worktree = f.metadata;
  assert.equal(canonicalWorkspaceId(f.cwd, f.herdr), 'opaque-canonical');
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.cwd, alias);
  assert.equal(canonicalWorkspaceId(alias, f.herdr), 'opaque-canonical');
});

test('lookup refuses foreign source identity, linked source and stale workspace metadata', (t) => {
  for (const key of ['repo_key', 'repo_root', 'source_checkout_path']) {
    const f = fixture(t); f.receipt.source[key] = key === 'repo_key' ? path.join(f.foreign, '.git') : f.foreign;
    assert.throws(() => canonicalWorkspaceId(f.cwd, f.herdr), /repository identity mismatch/);
  }
  for (const key of ['repo_key', 'repo_root', 'checkout_path', 'is_linked_worktree']) {
    const f = fixture(t); f.workspaces[0].worktree = { ...f.metadata,
      [key]: key === 'is_linked_worktree' ? true : key === 'repo_key' ? path.join(f.foreign, '.git') : f.foreign };
    assert.throws(() => canonicalWorkspaceId(f.cwd, f.herdr), /refusing stale metadata/);
  }
});

test('lookup refuses absent, closed, linked and ambiguous canonical receipts', (t) => {
  for (const change of [
    (f) => { delete f.receipt.worktrees[0].open_workspace_id; },
    (f) => { f.receipt.worktrees[0].is_linked_worktree = true; },
    (f) => { f.receipt.worktrees.push({ ...f.receipt.worktrees[0] }); },
    (f) => { f.workspaces.length = 0; },
  ]) {
    const f = fixture(t); change(f);
    assert.throws(() => canonicalWorkspaceId(f.cwd, f.herdr), /no Herdr workspace|no longer open/);
  }
});

test('lookup refuses a linked caller and surfaces native failures without a guessed ID', (t) => {
  const f = fixture(t);
  execFileSync('git', ['-C', f.cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'Initial']);
  const linked = path.join(f.root, 'linked');
  execFileSync('git', ['-C', f.cwd, 'worktree', 'add', '-qb', 'lane', linked]);
  assert.throws(() => canonicalWorkspaceId(linked, f.herdr), /not the canonical checkout/);
  assert.deepEqual(f.calls, []);
  assert.throws(() => canonicalWorkspaceId(f.cwd, () => ({ ok: false, error: 'native unavailable' })), /worktree list failed: native unavailable/);
  assert.throws(() => canonicalWorkspaceId(f.cwd, (args) => args[0] === 'worktree' ? f.herdr(args) : { ok: false, error: 'native unavailable' }), /workspace list failed: native unavailable/);
  // A restart must resolve the new opaque ID, never reuse an earlier receipt.
  f.receipt.worktrees[0].open_workspace_id = f.workspaces[0].workspace_id = 'after-restart';
  assert.equal(canonicalWorkspaceId(f.cwd, f.herdr), 'after-restart');
});
