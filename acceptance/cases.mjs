// Stable identities and dependencies. Ordinals belong only to presentation.
import assert from 'node:assert/strict';
import { classifyFailure, requirePrerequisite } from './limits.mjs';

const spec = (key, name, prerequisites = [], options = {}) => Object.freeze({ key, name, prerequisites: Object.freeze(prerequisites), ...options });
const compatibility = { existingProject: true };
export const cases = Object.freeze({
  tools: spec('required-tools', 'Required tools'),
  snapshot: spec('candidate-snapshot', 'Candidate snapshot'),
  record: spec('new-project-record', 'New project: record discovers and populates'),
  routes: spec('new-project-routes', 'New project: routes resolve without config'),
  entry: spec('supervisor-entry', 'New project: installed supervisor entry and record bootstrap'),
  fixture: spec('herdr-fixture', 'Real Herdr boundary and configured fixture'),
  cycle: spec('configured-cycle', 'Configured cycle: dispatch/report/ingest/promote/close', ['herdr-fixture']),
  queue: spec('promotion-queue', 'Unconfigured promotion queue: FIFO, notices and refusal', ['herdr-fixture']),
  missing: spec('missing-worker', 'Failure path: missing worker', ['herdr-fixture']),
  invalid: spec('invalid-worker', 'Failure path: invalid worker', ['herdr-fixture']),
  blocked: spec('blocked-worker', 'Failure path: blocked worker', ['herdr-fixture']),
  fix: spec('fix-round', 'Fix round: same worker, fresh durable run', ['herdr-fixture']),
  grace: spec('watch-grace', 'Watch cutover: idle grace and exclusive watcher', ['herdr-fixture']),
  housekeeping: spec('housekeeping', 'Housekeeping closes only eligible finished workers', ['herdr-fixture']),
  release: spec('scratch-release', 'Scratch release build/activate/rollback/restore'),
  copy: spec('existing-copy', 'Existing project: copy live calls and inventory drift', ['herdr-fixture'], compatibility),
  wrappers: spec('existing-wrappers', 'Existing project: routing and both wrapper dry runs', ['existing-copy'], compatibility),
  path: spec('org-path', 'Existing project: org PATH consumers', ['existing-copy'], compatibility),
  switches: spec('cutover-switches', 'ENG-64: every file switch and rollback', ['existing-copy'], compatibility),
  retirement: spec('contrib-retirement', 'ENG-64: contrib retirement refused while the launcher calls it', ['cutover-switches'], compatibility),
  discovery: spec('discovery-concurrent', 'Real discovery: concurrent lanes and promotion'),
  routingQuestion: spec('discovery-routing', 'Real discovery: routing question waits and answer applies'),
  lessons: spec('lessons-entry', 'Active lesson reaches fresh Codex and Claude at installed entry', ['herdr-fixture']),
  defaultCycle: spec('default-cycle', 'New project: default supervisor dispatch/watch/ingest cycle', ['herdr-fixture']),
  settle: spec('settle-cycle', 'New project: report/settle/fix/settle/promotable without config'),
  supervisor: spec('supervisor-cycle', 'New project: fresh/history supervisor, notices, fix, promotion and record completion'),
  cleanup: spec('scope-cleanup', 'Cleanup and scope audit', [], { cleanup: true }),
  focus: spec('operator-focus', 'Background work preserves operator focus'),
});
export const cutoverChecks = Object.freeze({
  name: spec('stable-name', 'stable name: startup and missing-target refusal'),
  routes: spec('routed-wrappers', 'routing suite and continue wrapper with the switched arm wrapper'),
  canary: spec('switched-canary', 'dispatch and arm: real canary'),
  recovery: spec('tidy-recovery', 'tidy recovery across multiple run logs', ['switched-canary']),
  cleanup: spec('copied-cleanup', 'copied cleanup: close done, preserve blocked and needs_human', ['switched-canary']),
  notices: spec('notice-contract', 'SETTLE and WORK-PATTERN consumer contract'),
  retirement: spec('notify-retirement', 'notify retirement has zero callers'),
  rollback: spec('exact-rollback', 'rollback: all switched bytes/modes and restored legacy routes/wrappers'),
  legacy: spec('legacy-canary', 'rollback: real restored notify canary'),
});

export async function runCase(results, definition, fn, { scratchRoot, scratchRoots, load, existingProjectConfigured = true } = {}) {
  assert.ok(definition?.key && definition?.name, 'case requires a stable key and name');
  assert.ok(!results.some((result) => result.key === definition.key), `duplicate case key: ${definition.key}`);
  const result = { id: String(results.length + 1).padStart(2, '0'), key: definition.key, name: definition.name,
    status: 'PASS', origin: 'product', detail: '' };
  if (definition.existingProject && !existingProjectConfigured) {
    Object.assign(result, { status: 'SKIP', origin: 'optional',
      detail: 'No existing project configured; supply --bch-cloak LIVE_REPO to run compatibility checks' });
    results.push(result);
    return result;
  }
  try {
    for (const key of definition.prerequisites) requirePrerequisite(results, key);
    result.detail = await fn() ?? '';
  } catch (error) { Object.assign(result, classifyFailure(error, { cleanup: definition.cleanup, scratchRoot, scratchRoots, load: load?.() })); }
  results.push(result);
  return result;
}
