// ENG-537: no project can activate v2 until ENG-538 completes the identity fence.
// Deliberately no configuration, environment switch or execution bypass.
export function refuseDeclaredGatesV2() {
  throw Object.assign(Error('DECLARED_GATES_V2_INERT: declared-gates/v2 is inactive pending ENG-538 (complete the identity fence)'),
    { code: 'DECLARED_GATES_V2_INERT' });
}

// Current declarations and saved work both count, including cleanup after the
// owner rolls back its declaration. Inspect only authority-bearing containers.
export function fenceCapturedDeclared(value) {
  if (Array.isArray(value)) { for (const row of value) fenceCapturedDeclared(row); return; }
  if (!value || typeof value !== 'object') return;
  if (value.schema === 'declared-gates/v2' || value.gate_mode === 'declared-gates/v2') refuseDeclaredGatesV2();
  for (const key of ['value', 'declared', 'declaration', 'jobs', 'attempts', 'declared_spec', 'declared_gate']) fenceCapturedDeclared(value[key]);
}
