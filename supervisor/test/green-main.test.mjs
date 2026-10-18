// Real-tree readiness evidence, separate from the isolated admission fixtures.
// All Git commands are reads. Candidate bytes exist only in memory.
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gitProject } from '../../lib/project.mjs';
import { GREEN_CONTRACTS, greenExecutionScope } from '../green-pass.mjs';
import { executionClosure, sourceReach } from '../green-reach.mjs';

test('read-only main probe records the ordinary candidate and both frozen refusals', t => {
  const checkout = fs.realpathSync(new URL('../../', import.meta.url));
  const root = gitProject(checkout).canonical;
  const git = args => {
    const result = spawnSync('git', ['--no-optional-locks', '-C', checkout, ...args], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  const main = git(['rev-parse', 'main']).trim(), files = new Map(), cache = new Map();
  for (const line of git(['ls-tree', '-r', '-z', main]).split('\0').filter(Boolean)) {
    const match = /^(\d{6}) \w+ ([a-f0-9]+)\t(.+)$/.exec(line);
    assert.ok(match, 'complete Git tree entry'); files.set(match[3], { mode: match[1], oid: match[2] });
  }
  const before = { files, root, read(file) {
    assert.ok(['100644', '100755'].includes(files.get(file)?.mode), `regular tracked input: ${file}`);
    if (!cache.has(file)) cache.set(file, git(['cat-file', 'blob', files.get(file).oid]));
    return cache.get(file);
  } };
  const inventory = executionClosure(before, GREEN_CONTRACTS.entries.filter(e => e.project === 'brain').map(e => e.path));
  const authority = executionClosure(before, GREEN_CONTRACTS.authorityEntries);
  const ordinary = 'board/render.mjs';
  const oldLine = 'export function render(snapshot, { width = 120, height = Infinity, now = Date.now() } = {}) {';
  const newLine = 'export function render(snapshot, { width = 121, height = Infinity, now = Date.now() } = {}) {';
  const original = before.read(ordinary);
  assert.ok(original.includes(oldLine), 'real candidate changes an existing source line');
  const candidate = original.replace(oldLine, newLine);
  const digest = text => createHash('sha256').update(text).digest('hex');
  const outcomes = [];
  for (const [label, file, contents] of [
    ['ordinary', ordinary, candidate],
    ['inventory', 'supervisor/reconcile.mjs', before.read('supervisor/reconcile.mjs') + '// R-544 frozen inventory probe\n'],
    ['authority', 'housekeeping/config.mjs', before.read('housekeeping/config.mjs') + '// R-544 frozen authority probe\n'],
  ]) {
    const after = { ...before, read: name => name === file ? contents : before.read(name) };
    const result = greenExecutionScope(before, after, { sourceRoot: checkout, changes: [{ file, status: 'M', before: files.get(file).mode, after: files.get(file).mode }] });
    if (label === 'ordinary') {
      assert.ok(!inventory.paths.includes(file) && !authority.paths.includes(file));
      assert.ok(!result.authority || !Object.values(result.authority).some(reach => reach.paths.includes(file)), 'candidate is outside all known frozen authority paths');
      assert.ok(result.eligible || result.code === 'GREEN_REACH_UNKNOWN', JSON.stringify(result));
    } else {
      assert.equal(result.eligible, false);
      assert.ok(['GREEN_BCH_CONSUMED', 'GREEN_SELF_AUTHORITY'].includes(result.code), JSON.stringify(result));
    }
    outcomes.push({ label, file, eligible: result.eligible, code: result.code ?? null, reason: result.reason ?? null,
      before_sha256: digest(before.read(file)), after_sha256: digest(contents),
      ...(label === 'ordinary' ? { running_authority: result.authority?.running } : {}) });
  }
  const entryDiagnostics = GREEN_CONTRACTS.authorityEntries.concat('supervisor/reconcile.mjs').map(file => ({ file,
    unknown: files.has(file) ? sourceReach(file, before.read(file), files, { root }).unknown : [{ file, reason: 'missing execution input on main' }],
  }));
  const evidence = { schema: 'green-main-probe/v1', main, stage: 'execution scope; full admission also requires canonical identity, matching policy bytes and evidence',
    readiness: outcomes[0].eligible ? 'execution-known' : 'blocked', main_policy_present: files.has('supervisor/green-contracts.json'),
    candidate: { file: ordinary, old_line: oldLine, new_line: newLine, reach: executionClosure({ ...before, read: file => file === ordinary ? candidate : before.read(file) }, [ordinary]) },
    outcomes, inventory, authority, entry_diagnostics: entryDiagnostics,
  };
  t.diagnostic(`GREEN_MAIN_PROBE ${JSON.stringify(evidence)}`);
  t.diagnostic(`main candidate readiness: ${evidence.readiness}; ordinary=${outcomes[0].code ?? 'execution-known'}, inventory=${outcomes[1].code}, authority=${outcomes[2].code}`);
});
