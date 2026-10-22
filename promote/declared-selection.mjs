// The canonical declaration supplies coverage. Planner output selects only IDs.
import { closed, nonempty, object, hash, gateDefinition, validateDeclared, SELECTION_SCHEMA, MAX_PLAN_BYTES, refuse } from './declaration.mjs';

export function bindRequirements(required, declaration) {
  if (!Array.isArray(required) || required.length > 512) throw refuse('invalid required inventory');
  const seen = new Set();
  return required.map(row => {
    let result = row;
    if (typeof row === 'string') { if (!nonempty(row)) throw refuse('invalid required coverage token'); }
    else {
      closed(row, ['gate', 'definition'], 'gate requirement');
      const definition = gateDefinition(declaration, row.gate);
      if (!definition) throw refuse(`unknown required gate: ${row.gate}`);
      if (row.definition !== undefined && hash(row.definition) !== hash(definition)) throw refuse(`required gate definition changed: ${row.gate}`);
      result = { gate: row.gate, definition: structuredClone(definition) };
    }
    const key = typeof row === 'string' ? `token:${row}` : `gate:${row.gate}`;
    if (seen.has(key)) throw refuse('duplicate required evidence');
    seen.add(key); return result;
  });
}
export function assertBoundRequirements(required, declaration) {
  validateDeclared(declaration);
  if (!Array.isArray(required) || required.some(row => typeof row !== 'string' && (!object(row) || !object(row.definition)))) throw refuse('gate requirement lost its admission definition');
  return bindRequirements(required, declaration);
}
export function unionRequirements(jobs) {
  const all = new Map();
  for (const job of jobs) for (const row of job.requiredTests ?? []) {
    const key = typeof row === 'string' ? `token:${row}` : `gate:${row.gate}`;
    if (all.has(key) && hash(all.get(key)) !== hash(row)) throw refuse('conflicting bound gate requirements');
    all.set(key, row);
  }
  if (all.size > 512) throw refuse('required union exceeds 512 entries');
  return [...all.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}
export function selectDeclared(value, declaration, required) {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_PLAN_BYTES) throw refuse('selection exceeds 1 MiB');
  closed(value, ['schema', 'gates', 'deferred', 'unknown', 'budget'], 'promotion selection');
  if (value.schema !== SELECTION_SCHEMA) throw refuse('unsupported promotion selection schema');
  assertBoundRequirements(required, declaration);
  const parse = (rows, deferred) => {
    if (!Array.isArray(rows) || rows.length > 512) throw refuse('invalid selected/deferred gate inventory');
    const seen = new Set();
    return rows.map(row => {
      closed(row, ['id', 'reason', 'estimated_ms', 'estimate', ...(deferred ? ['destination'] : [])], 'gate selection');
      if (!nonempty(row.id) || !Object.hasOwn(declaration.gates ?? {}, row.id) || seen.has(row.id) || !nonempty(row.reason)) throw refuse('unknown, duplicate or unexplained selected gate');
      seen.add(row.id);
      if (row.estimated_ms !== undefined && (!Number.isSafeInteger(row.estimated_ms) || row.estimated_ms <= 0)) throw refuse('gate estimate must be a positive safe integer');
      if (row.estimate !== undefined && !['measured', 'fallback'].includes(row.estimate)) throw refuse('invalid gate estimate source');
      if (deferred && row.destination !== 'release-candidate') throw refuse('deferred gate needs release-candidate destination');
      return { ...row, estimated_ms: row.estimated_ms ?? 60000, estimate: row.estimate ?? 'fallback' };
    });
  };
  const gates = parse(value.gates, false), deferred = parse(value.deferred, true);
  if (deferred.some(row => gates.some(gate => gate.id === row.id))) throw refuse('deferred/selected overlap');
  if (!Array.isArray(value.unknown) || value.unknown.length > 512 || value.unknown.some(v => !nonempty(v)) || value.unknown.length) throw refuse('unknown promotion obligations');
  const selected = new Set(['promotion', ...gates.map(row => row.id)]);
  const coverage = new Set(declaration.coverage.promotion);
  const needed = new Set();
  for (const row of required.filter(row => typeof row !== 'string')) {
    if (!selected.has(row.gate) || hash(gateDefinition(declaration, row.gate)) !== hash(row.definition)) throw refuse(`missing or changed required gate: ${row.gate}`);
    if (row.gate !== 'promotion') needed.add(row.gate);
  }
  // Assign each token to its first declared provider in execution order. This
  // counts required work first without letting a planner relabel optional work.
  const obligations = required.filter(row => typeof row === 'string');
  for (const gate of gates) {
    const covers = declaration.gates[gate.id].covers;
    if (obligations.some(token => !coverage.has(token) && covers.includes(token))) needed.add(gate.id);
    for (const token of covers) coverage.add(token);
  }
  for (const token of obligations) if (!coverage.has(token)) throw refuse(`missing required coverage: ${token}`);
  const budget = { extras_ms: 300000, max_extra_gates: 10, ...value.budget };
  if (value.budget !== undefined) closed(value.budget, ['extras_ms', 'max_extra_gates'], 'budget');
  if (Object.values(budget).some(v => !Number.isSafeInteger(v) || v < 0)) throw refuse('invalid optional gate budget');
  const requiredRows = gates.filter(row => needed.has(row.id)), optionalRows = gates.filter(row => !needed.has(row.id));
  const cost = rows => rows.reduce((total, row) => total + row.estimated_ms, 0);
  const requiredCost = cost(requiredRows), totalCost = cost(gates);
  if (!Number.isSafeInteger(totalCost)) throw refuse('gate estimates exceed safe bounds');
  if (optionalRows.length && (optionalRows.length > Math.max(0, budget.max_extra_gates - requiredRows.length) || cost(optionalRows) > Math.max(0, budget.extras_ms - requiredCost))) throw refuse('selected optional gates exceed the declared budget');
  return { schema: SELECTION_SCHEMA, gates, deferred, unknown: [], required: structuredClone(required), coverage: [...coverage].sort(),
    budget: { ...budget, estimated_ms: totalCost, required_over_budget: requiredRows.length > budget.max_extra_gates || requiredCost > budget.extras_ms } };
}
