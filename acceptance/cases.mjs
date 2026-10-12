// Stable identities and dependencies. Ordinals belong only to presentation.
import assert from 'node:assert/strict';
import { classifyFailure, requirePrerequisite } from './limits.mjs';

const spec = (key, name, prerequisites = [], options = {}) => Object.freeze({ key, name, prerequisites: Object.freeze(prerequisites), ...options });
export const cases = Object.freeze({
  tools: spec('required-tools', 'Required tools'),
  snapshot: spec('candidate-snapshot', 'Candidate snapshot'),
  record: spec('new-project-record', 'New project: record discovers and populates'),
  routes: spec('new-project-routes', 'New project: routes resolve without config'),
  policy: spec('supervisor-policy', 'New project: foreground supervisor context'),
  fixture: spec('herdr-fixture', 'Real Herdr boundary and configured fixture'),
  cycle: spec('configured-cycle', 'Configured cycle: dispatch/report/ingest/promote/close', ['herdr-fixture']),
  queue: spec('promotion-queue', 'Unconfigured promotion queue: FIFO, notices and refusal', ['herdr-fixture']),
  missing: spec('missing-worker', 'Failure path: missing worker', ['herdr-fixture']),
  invalid: spec('invalid-worker', 'Failure path: invalid worker', ['herdr-fixture']),
  blocked: spec('blocked-worker', 'Failure path: blocked worker', ['herdr-fixture']),
  fix: spec('fix-round', 'Fix round: same worker, fresh durable run', ['herdr-fixture']),
  grace: spec('watch-grace', 'Watch cutover: idle grace and exclusive watcher', ['herdr-fixture']),
  housekeeping: spec('housekeeping', 'Housekeeping closes only eligible finished workers', ['herdr-fixture']),
  release: spec('scratch-release', 'Scratch release build/activate/rollback'),
  defaultCycle: spec('default-cycle', 'New project: default supervisor dispatch/watch/ingest cycle', ['herdr-fixture']),
  settle: spec('settle-cycle', 'New project: report/settle/fix/settle/promotable without config'),
  supervisor: spec('supervisor-cycle', 'New project: fresh/history supervisor, notices, fix, promotion and record completion'),
  cleanup: spec('scope-cleanup', 'Cleanup and scope audit', [], { cleanup: true }),
  focus: spec('operator-focus', 'Background work preserves operator focus'),
});
export async function runCase(results, definition, fn, { scratchRoot, scratchRoots, load } = {}) {
  assert.ok(definition?.key && definition?.name, 'case requires a stable key and name');
  assert.ok(!results.some((result) => result.key === definition.key), `duplicate case key: ${definition.key}`);
  const result = { id: String(results.length + 1).padStart(2, '0'), key: definition.key, name: definition.name,
    status: 'PASS', origin: 'product', detail: '' };
  try {
    for (const key of definition.prerequisites) requirePrerequisite(results, key);
    result.detail = await fn() ?? '';
  } catch (error) { Object.assign(result, classifyFailure(error, { cleanup: definition.cleanup, scratchRoot, scratchRoots, load: load?.() })); }
  results.push(result);
  return result;
}
