// Typed selection validation is independent of the planner and runner.
import { object, closed, argv, relative, nonempty, hash, refuse, SELECTION_SCHEMA, MAX_PLAN_BYTES } from './declaration.mjs';

export const validFile = file => relative(file) && /^[\w./-]+\.test\.mjs$/.test(file);
const inventory = (rows, label) => {
  if (!Array.isArray(rows) || rows.length > 512) throw refuse(`${label} exceeds 512 or is not an array`);
  return rows;
};
const fileList = (rows, label) => {
  inventory(rows, label);
  if (rows.some(file => !validFile(file)) || new Set(rows).size !== rows.length) throw refuse(`invalid ${label}`);
};
export const obligationKey = row => typeof row === 'string' ? `file:${row}` : `step:${hash([row.runner, row.args])}`;
function invocation(row, runners) {
  if (!object(row) || !Object.hasOwn(runners, row.runner) || !Array.isArray(row.args) || !argv(['runner', ...row.args])) throw refuse('undeclared runner or invalid step argv');
}
export function bindRequirements(required, declaration, binding) {
  inventory(required, 'required inventory');
  const seen = new Set();
  return required.map(row => {
    if (typeof row === 'string') { if (!validFile(row)) throw refuse('invalid required file'); }
    else {
      closed(row, ['runner', 'args', 'definition', 'scope', 'toolchain'], 'required step');
      invocation(row, declaration.runners);
    }
    const key = obligationKey(row);
    if (seen.has(key)) throw refuse('duplicate required obligation');
    seen.add(key);
    if (typeof row === 'string') return row;
    const scope = typeof binding === 'function' ? binding(row) : binding;
    const expected = { runner: row.runner, args: [...row.args], definition: declaration.runners[row.runner], scope: scope.scope, toolchain: scope.toolchain };
    if (row.definition !== undefined && hash(row) !== hash(expected)) throw refuse('bound runner definition, toolchain or scope changed');
    return expected;
  }).sort((a, b) => obligationKey(a).localeCompare(obligationKey(b)));
}
export function unionRequirements(jobs) {
  const seen = new Map();
  for (const row of jobs.flatMap(job => job.requiredTests ?? [])) {
    const key = obligationKey(row);
    if (seen.has(key) && hash(seen.get(key)) !== hash(row)) throw refuse('incompatible bound requirements in batch');
    seen.set(key, row);
  }
  if (seen.size > 512) throw refuse('required union exceeds 512');
  return [...seen.values()].sort((a, b) => obligationKey(a).localeCompare(obligationKey(b)));
}
function estimate(row) {
  if (row.estimated_ms !== undefined || row.estimate !== undefined) {
    if (!Number.isFinite(row.estimated_ms) || row.estimated_ms <= 0 || !['measured', 'fallback'].includes(row.estimate)) throw refuse('invalid obligation estimate');
  }
  if (row.measured_at !== undefined && !Number.isFinite(Date.parse(row.measured_at))) throw refuse('invalid estimate timestamp');
}
export function validateSelection(plan, { declaration, required = [] }) {
  if (Buffer.byteLength(JSON.stringify(plan)) > MAX_PLAN_BYTES) throw refuse('selection exceeds 1 MiB');
  closed(plan, ['schema', 'files', 'steps', 'covered', 'selected', 'deferred', 'budget', 'graph', 'unknown'], 'selection');
  if (plan.schema !== SELECTION_SCHEMA) throw refuse('unsupported selection schema');
  fileList(plan.files, 'files'); fileList(plan.covered ?? [], 'covered');
  if (plan.files.some(file => (plan.covered ?? []).includes(file))) throw refuse('selected and covered files overlap');
  inventory(plan.steps, 'steps');
  if (plan.steps.length + plan.files.length > 512) throw refuse('selected obligations exceed 512');
  if (plan.files.length && !Object.hasOwn(declaration.runners, 'node-test')) throw refuse('file shorthand requires a declared node-test runner');
  const selected = new Set(plan.files.map(obligationKey));
  const executionKey = row => hash([declaration.runners[row.runner], row.args]);
  const selectedInvocations = new Set(plan.files.map(file => executionKey({ runner: 'node-test', args: [file] })));
  const coveredInvocations = new Set((plan.covered ?? []).map(file => executionKey({ runner: 'node-test', args: [file] })));
  for (const step of plan.steps) {
    closed(step, ['runner', 'args', 'reason', 'estimated_ms', 'estimate', 'measured_at'], 'step');
    invocation(step, declaration.runners);
    if (!nonempty(step.reason)) throw refuse('step needs a reason');
    estimate(step);
    const key = obligationKey(step);
    if (selected.has(key) || selectedInvocations.has(executionKey(step))) throw refuse('duplicate selected obligation');
    selected.add(key);
    selectedInvocations.add(executionKey(step));
  }
  const details = new Map();
  if (plan.selected !== undefined) {
    inventory(plan.selected, 'selected details');
    for (const row of plan.selected) {
      closed(row, ['file', 'reason', 'estimated_ms', 'estimate', 'measured_at'], 'selected detail');
      if (!plan.files.includes(row.file) || details.has(row.file) || !nonempty(row.reason)) throw refuse('invalid selected details');
      if (row.estimated_ms === undefined || row.estimate === undefined) throw refuse('selected file details retain the v1 estimate fields');
      estimate(row); details.set(row.file, row);
    }
    if (details.size !== plan.files.length) throw refuse('selected details must describe every file');
  }
  if (plan.unknown !== undefined && (!Array.isArray(plan.unknown) || plan.unknown.length > 512 || plan.unknown.some(p => !relative(p)))) throw refuse('invalid unknown inventory');
  if (plan.unknown?.length) throw refuse('unknown selection requires explicit conservative work or refusal');
  if (plan.graph !== undefined && !object(plan.graph)) throw refuse('invalid graph');
  const requiredKeys = new Set();
  inventory(required, 'required');
  for (const row of required) {
    const key = obligationKey(row); requiredKeys.add(key);
    if (typeof row === 'string') {
      if (!plan.files.includes(row) && !(plan.covered ?? []).includes(row)) throw refuse('plan omits a required whole file');
    } else {
      invocation(row, declaration.runners);
      if (hash(row.definition) !== hash(declaration.runners[row.runner]) || !selected.has(key)) throw refuse('plan omits or narrows a bound typed invocation');
    }
  }
  const deferred = new Set();
  inventory(plan.deferred ?? [], 'deferred');
  for (const row of plan.deferred ?? []) {
    closed(row, ['file', 'runner', 'args', 'reason', 'estimated_ms', 'estimate', 'measured_at', 'destination'], 'deferred');
    let key;
    if (row.file !== undefined) {
      if (!validFile(row.file) || row.runner !== undefined || row.args !== undefined) throw refuse('invalid deferred file');
      key = obligationKey(row.file);
    } else { invocation(row, declaration.runners); key = obligationKey(row); }
    estimate(row);
    const deferredInvocation = row.file === undefined ? executionKey(row) : Object.hasOwn(declaration.runners, 'node-test') ? executionKey({ runner: 'node-test', args: [row.file] }) : key;
    if (!nonempty(row.reason) || row.destination !== 'release-candidate' || !row.estimated_ms || deferred.has(deferredInvocation) || selectedInvocations.has(deferredInvocation) || coveredInvocations.has(deferredInvocation) || selected.has(key) || requiredKeys.has(key) || (plan.covered ?? []).some(file => obligationKey(file) === key)) throw refuse('invalid or overlapping deferred obligation');
    deferred.add(deferredInvocation);
  }
  const budget = { time_ms: 300000, max_files: 10, unknown_file_ms: 60000, ...plan.budget };
  if (plan.budget !== undefined) closed(plan.budget, ['time_ms', 'max_files', 'unknown_file_ms', 'estimated_ms', 'required_over_budget'], 'budget');
  for (const key of ['time_ms', 'max_files', 'unknown_file_ms']) if (!Number.isSafeInteger(budget[key]) || budget[key] < 1) throw refuse('invalid finite selection budget');
  if (budget.required_over_budget !== undefined && typeof budget.required_over_budget !== 'boolean') throw refuse('invalid required_over_budget');
  const rows = [...plan.files.map(file => ({ key: obligationKey(file), cost: details.get(file)?.estimated_ms ?? budget.unknown_file_ms })),
    ...plan.steps.map(step => ({ key: obligationKey(step), cost: step.estimated_ms ?? budget.unknown_file_ms }))];
  const requiredRows = rows.filter(row => requiredKeys.has(row.key)), extras = rows.filter(row => !requiredKeys.has(row.key));
  const requiredCost = requiredRows.reduce((total, row) => total + row.cost, 0), total = rows.reduce((sum, row) => sum + row.cost, 0);
  const over = requiredCost > budget.time_ms || requiredRows.length > budget.max_files;
  if (extras.length && (rows.length > budget.max_files || total > budget.time_ms)) throw refuse('optional selection exceeds time or count budget; defer it explicitly');
  if (budget.estimated_ms !== undefined && budget.estimated_ms !== total) throw refuse('selection estimate does not match obligations');
  if (over && budget.required_over_budget !== true) throw refuse('required_over_budget must record the required exception');
  return { ...plan, covered: plan.covered ?? [], deferred: plan.deferred ?? [], required,
    budget: { ...budget, estimated_ms: total, required_over_budget: over } };
}
