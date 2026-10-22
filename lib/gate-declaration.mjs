// Pure host-profile validation shared by both declaration versions.
import path from 'node:path';
import { limitSeconds } from '../test-slot/limits.mjs';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const check = (ok, message) => { if (!ok) throw Error(message); };
export function validateGateDeclaration(gate) {
  check(object(gate), 'promote gate must be an object');
  const fields = ['node_version_file', 'env', 'prepare', 'external_lock', 'refuse_processes', 'wait_seconds', 'timeout_seconds', 'idle_timeout_seconds', 'resource'];
  for (const key of Object.keys(gate)) check(fields.includes(key), `unknown promote gate field: ${key}`);
  if (gate.node_version_file !== undefined) check(typeof gate.node_version_file === 'string' && gate.node_version_file && !path.isAbsolute(gate.node_version_file) && !gate.node_version_file.split(/[\\/]/u).includes('..'), 'gate.node_version_file must be project-relative');
  if (gate.env !== undefined) check(object(gate.env) && Object.entries(gate.env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(k) && typeof v === 'string' && !v.includes('\0') && !/^(?:MONITOR_PROMOTION_|MONITOR_TEST_SLOT_(?:PATH|COMPAT_PATH|TOKEN)|BCH_CLOAK_TEST_SLOT_TOKEN|HERDR_(?:PANE|TAB|WORKSPACE)_ID|NODE_OPTIONS$)/u.test(k)), 'gate.env must map environment names to strings; slot paths/tokens, session transport and NODE_OPTIONS are host-owned');
  if (gate.prepare !== undefined) check(Array.isArray(gate.prepare) && gate.prepare.every(s => object(s) && Object.keys(s).every(k => ['run', 'unless'].includes(k)) && typeof s.run === 'string' && s.run.trim() && (s.unless === undefined || typeof s.unless === 'string' && !path.isAbsolute(s.unless) && !s.unless.split(/[\\/]/u).includes('..'))), 'invalid gate.prepare');
  if (gate.external_lock !== undefined) check(typeof gate.external_lock === 'string' && path.isAbsolute(gate.external_lock) && !gate.external_lock.includes('\0'), 'gate.external_lock must be absolute');
  if (gate.refuse_processes !== undefined) { check(Array.isArray(gate.refuse_processes) && gate.refuse_processes.every(p => typeof p === 'string' && p.trim()), 'invalid gate.refuse_processes'); for (const p of gate.refuse_processes) new RegExp(p); }
  if (gate.wait_seconds !== undefined) check(Number.isSafeInteger(gate.wait_seconds) && gate.wait_seconds >= 0 && gate.wait_seconds <= 9999999, 'invalid gate.wait_seconds');
  for (const k of ['timeout_seconds', 'idle_timeout_seconds']) if (gate[k] !== undefined) limitSeconds(gate[k], `gate.${k}`, { idle: k === 'idle_timeout_seconds' });
  if (gate.resource !== undefined) {
    const r = gate.resource;
    check(object(r) && typeof r.id === 'string' && /^[\w:./-]+$/u.test(r.id) && Number.isSafeInteger(r.revision) && r.revision > 0 &&
      (r.command === null || Array.isArray(r.command) && r.command.length > 0 && r.command.every(s => typeof s === 'string' && !s.includes('\0'))) && ['SHARED', 'EXCLUSIVE'].includes(r.admission_class) &&
      (r.M_bytes === null || Number.isSafeInteger(r.M_bytes) && r.M_bytes >= 0) && (r.C === null || Number.isSafeInteger(r.C) && r.C > 0) && object(r.worker_caps) &&
      Array.isArray(r.named_claims) && !r.named_claims.length && Array.isArray(r.evidence) &&
      (r.memory_floor_bytes === undefined || r.admission_class === 'EXCLUSIVE' && Number.isSafeInteger(r.memory_floor_bytes) && r.memory_floor_bytes >= 0), 'invalid gate.resource declaration');
  }
}
