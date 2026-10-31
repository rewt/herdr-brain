// Explicit early integration evidence; never a landing or release gate.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMain } from '../../lib/cli-help.mjs';
import { affectedTestPlan, boundAffectedTests } from './affected-tests.mjs';
import { trackedTestInventory } from './test-inventory.mjs';
import { compactPlanDetails } from '../../promote/plan-details.mjs';
import { main as runSelected, releasePhases } from './release-suites.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}
function assertSource(root, head) {
  if (git(root, ['rev-parse', 'HEAD']) !== head) throw Error('combined-check source HEAD moved; retain results for the captured target');
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) throw Error('combined checks require a clean committed worktree');
}
export function combinedPlan({ cwd = process.cwd(), base, extra = [], ...budget } = {}) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '')) throw Error('--base requires an immutable full commit SHA');
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (path.resolve(cwd) !== path.resolve(root)) throw Error('run combined checks from the worktree root');
  const head = git(root, ['rev-parse', 'HEAD']);
  assertSource(root, head);
  if (git(root, ['rev-parse', '--verify', `${base}^{commit}`]) !== base) throw Error('base is not the named commit');
  if (git(root, ['merge-base', base, head]) !== base) throw Error('combined-check base must be an ancestor of HEAD; combine or rebase the sources first');
  const { files, tests } = trackedTestInventory(root);
  if (extra.some(file => !/^[\w./-]+\.test\.mjs$/.test(file) || file.split('/').includes('..') || path.isAbsolute(file) || !tests.includes(file))) {
    throw Error('--extra requires a tracked test file in the candidate');
  }
  // Disable rename detection to retain both old and new paths for consumers.
  const changed = git(root, ['diff', '--no-renames', '--name-only', '-z', base, head, '--']).split('\0').filter(Boolean);
  const analysis = affectedTestPlan({ root, changed, files, tests });
  const selection = boundAffectedTests({ ...budget, candidates: analysis.candidates, consumers: analysis.consumers, changed, required: extra });
  assertSource(root, head);
  return { base, head, tree: git(root, ['rev-parse', 'HEAD^{tree}']), changed, ...selection,
    groups: selection.files.length ? releasePhases(selection.files) : [],
    graph: analysis.graph, unknown: analysis.unknown, root };
}
export function main(argv = process.argv.slice(2), {
  cwd = process.cwd(), output = text => console.log(text),
  execute = files => { runSelected(files); return process.exitCode ?? 0; },
} = {}) {
  let base, planOnly = false;
  const extra = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plan') { planOnly = true; continue; }
    if (!['--base', '--extra'].includes(argv[i]) || !argv[i + 1]) throw Error('usage: combined-checks.mjs --base FULL_SHA [--extra TEST_FILE] [--plan]');
    if (argv[i] === '--extra') extra.push(argv[++i]);
    else { if (base !== undefined) throw Error('--base may only be supplied once'); base = argv[++i]; }
  }
  const plan = combinedPlan({ cwd, base, extra });
  output(JSON.stringify(compactPlanDetails({ ...plan, execution: planOnly ? 'unrun-plan' : plan.files.length ? 'selected-checks' : 'unrun-empty' })));
  if (planOnly) return 0;
  if (!plan.files.length) {
    output('No focused tests selected; no tests executed. This is not full coverage or a test PASS.');
    return 3; // Unrun must not become a green lane receipt or invoke the full inventory.
  }
  assertSource(plan.root, plan.head);
  let status;
  try { status = execute(plan.files); }
  finally { assertSource(plan.root, plan.head); }
  output(JSON.stringify({ base: plan.base, head: plan.head, tree: plan.tree, exit_code: status,
    selected: plan.files, deferred: plan.deferred, unknown: plan.unknown, coverage: 'focused; unselected tests unrun' }));
  return status;
}
if (isMain(import.meta.url)) process.exitCode = main();
