import fs from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseUniqueJson } from './json.mjs';
import { safeProjectPath } from './project.mjs';
import { resolveLaunchRoute } from '../lanes/routes.mjs';
import { ROUTE_PRESET } from '../lanes/preset.mjs';

export const API_VERSION = 'brain.herdr.dev/v1alpha1';
export const SLOT_PANES = { chat: ['primary'], supervisor: ['primary'], logs: ['viewer', 'triage'] };
const sources = ['identity-instructions', 'project-cold-start', 'latest-chat-handoff', 'supervisor-protocol', 'latest-supervisor-handoff',
  'run-brief', 'item-lessons', 'latest-review', 'item-handoff', 'workspace-event-filter', 'triage-contract',
  'committed-project-log-cursor', 'materialized-batch-and-cited-reports', 'project-triage-status', 'file'];
const subscriptions = ['operator-requested-summary', 'exception', 'review-ready', 'authorized-correction-ready', 'triage-batch-ready', 'supervisor-handoff-draft-request'];
const fail = message => { throw Error(message); };
const obj = (value, fields, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`unknown field ${label}.${key}`);
};
const str = (value, label) => { if (typeof value !== 'string' || !value.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) fail(`${label} must be a non-empty string`); };
const id = (value, label, scoped = false) => {
  if (typeof value !== 'string' || value.length > 200 || !(scoped ? value.split('/') : [value]).every(part => /^[a-z0-9][a-z0-9._-]*$/iu.test(part)) || value.includes('..')) fail(`malformed id ${label}`);
};
const choice = (value, allowed, label) => { if (!allowed.includes(value)) fail(`${label} must be ${allowed.join(' | ')}`); };
const bool = (value, label) => { if (typeof value !== 'boolean') fail(`${label} must be boolean`); };
const positive = (value, label) => { if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive integer`); };
const optional = (value, check, label) => { if (value !== undefined) check(value, label); };

export function parseManifest(markdown) {
  if (Buffer.byteLength(markdown) > 1024 * 1024) fail('manifest exceeds 1 MiB');
  let section = false, fence = null, lines = [], blocks = [], headings = 0;
  for (const line of markdown.split(/\r?\n/u)) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.char}{${fence.size},}\\s*$`, 'u').test(line)) {
        if (fence.json && fence.section) blocks.push(lines.join('\n'));
        fence = null; lines = [];
      } else lines.push(line);
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (open) {
      if (section && open[2].trim() !== 'json') fail('Manifest section requires exactly one fenced block labelled json');
      fence = { char: open[1][0], size: open[1].length, json: open[2].trim() === 'json', section }; continue;
    }
    if (/^## Manifest\s*$/u.test(line)) { section = true; headings++; }
    else if (/^#{1,2}\s/u.test(line)) section = false;
  }
  if (fence) fail('unclosed Markdown fence');
  if (headings !== 1 || blocks.length !== 1) fail('expected exactly one json fenced block under one ## Manifest heading');
  return parseUniqueJson(blocks[0]);
}

export function validateManifest(manifest, { config, project } = {}) {
  obj(manifest, ['apiVersion', 'kind', 'metadata', 'spec'], 'manifest');
  choice(manifest.apiVersion, [API_VERSION], 'apiVersion');
  choice(manifest.kind, ['Session', 'LogViewer'], 'kind');
  const { metadata: m, spec: s } = manifest;
  obj(m, ['name', 'uid', 'namespace', 'generation'], 'metadata');
  id(m.name, 'metadata.name'); id(m.uid, 'metadata.uid'); id(m.namespace, 'metadata.namespace', true); positive(m.generation, 'metadata.generation');
  const isSession = manifest.kind === 'Session';
  obj(s, ['workspaceRef', 'role', 'standardSlot', 'paneSlot', 'intent', 'context', 'memory', 'permissions', 'logs', 'lifecycle',
    ...(isSession ? ['route', 'launch', 'execution', 'personality', 'singletonScope', 'tools'] : ['viewer'])], 'spec');
  id(s.workspaceRef, 'spec.workspaceRef', true);
  choice(s.role, isSession ? ['chat', 'supervisor', 'engineer', 'reviewer', 'logs-triage'] : ['logs', 'triage-status'], 'spec.role');
  if (s.standardSlot !== undefined) {
    choice(s.standardSlot, Object.keys(SLOT_PANES), 'standardSlot');
    if (s.standardSlot === 'logs' && s.paneSlot === undefined) fail('logs requires paneSlot');
    choice(s.paneSlot ?? 'primary', SLOT_PANES[s.standardSlot], 'paneSlot');
    const role = s.standardSlot === 'logs' ? (s.paneSlot === 'viewer' ? 'logs' : isSession ? 'logs-triage' : 'triage-status') : s.standardSlot;
    if (s.role !== role) fail('standardSlot/paneSlot and role disagree');
  } else if (s.paneSlot !== undefined) fail('paneSlot requires standardSlot');
  if (['chat', 'supervisor', 'logs', 'triage-status'].includes(s.role) && !s.standardSlot) fail('standard role requires standardSlot');
  obj(s.intent, ['kind', 'purpose', 'item', 'authorityRef'], 'spec.intent');
  choice(s.intent.kind, ['conversation', 'coordination', 'work-item', 'view', 'bounded-triage'], 'intent.kind'); str(s.intent.purpose, 'intent.purpose');
  optional(s.intent.authorityRef, id, 'intent.authorityRef');
  optional(s.intent.item, value => { if (!/^[A-Z][A-Z0-9]*-[1-9]\d*$/u.test(value)) fail('malformed item id'); }, 'intent.item');
  if (['engineer', 'reviewer'].includes(s.role) !== (s.intent.kind === 'work-item') || (s.intent.kind === 'work-item' && !s.intent.item)) fail('work-item intent requires a worker role and item');
  if ((s.role === 'logs-triage' && s.intent.kind !== 'bounded-triage') || (!isSession && s.intent.kind !== 'view')) fail('intent and role disagree');
  if (!Array.isArray(s.context)) fail('context must be an array');
  const diagnostics = [];
  for (const [index, c] of s.context.entries()) {
    obj(c, ['source', 'required', 'limit', 'path'], `context[${index}]`);
    choice(c.source, sources, 'context.source'); bool(c.required, 'context.required'); optional(c.limit, positive, 'context.limit');
    if (c.source === 'file' && c.path === undefined) fail('file context requires path');
    if (c.path !== undefined) {
      if (typeof project?.root !== 'string' || !isAbsolute(project.root)) fail('context path validation requires a canonical project');
      const file = safeProjectPath(project.root, c.path);
      try { if (!fs.statSync(file).isFile()) fail(`context is not a regular file: ${c.path}`); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (c.required) fail(`required context missing: ${c.path}`);
        diagnostics.push({ level: 'info', message: `optional context absent: ${c.path}` });
      }
    }
  }
  obj(s.memory, ['recordLessons', 'claudeMem', 'handoff', 'mode'], 'memory');
  optional(s.memory.recordLessons, bool, 'memory.recordLessons'); optional(s.memory.handoff, str, 'memory.handoff');
  optional(s.memory.mode, value => choice(value, ['none', 'cursor-only'], 'memory.mode'));
  if (s.memory.claudeMem !== undefined) {
    obj(s.memory.claudeMem, ['mode', 'domain', 'required'], 'memory.claudeMem');
    choice(s.memory.claudeMem.mode, ['off', 'optional', 'required'], 'memory.claudeMem.mode');
    optional(s.memory.claudeMem.domain, id, 'memory.claudeMem.domain'); optional(s.memory.claudeMem.required, bool, 'memory.claudeMem.required');
    if (s.memory.claudeMem.mode !== 'off' && !s.memory.claudeMem.domain) fail('memory adapter requires identity-scoped domain reference');
  }
  if (isSession && s.role !== 'logs-triage' && (typeof s.memory.recordLessons !== 'boolean' || !s.memory.claudeMem || !s.memory.handoff || s.memory.mode !== undefined)) fail('Session requires record, adapter and handoff memory intent');
  if (s.role === 'logs-triage' && (s.memory.mode !== 'cursor-only' || s.memory.handoff !== 'committed-project-log-cursor' || s.memory.claudeMem !== undefined || s.memory.recordLessons !== undefined)) fail('logs-triage memory must use only its committed cursor');
  obj(s.permissions, ['owner', 'profileRef', 'serviceAccess'], 'permissions');
  choice(s.permissions.owner, ['native'], 'permissions.owner'); id(s.permissions.profileRef, 'permissions.profileRef');
  optional(s.permissions.serviceAccess, value => choice(value, ['read'], 'permissions.serviceAccess'));
  obj(s.logs, ['serviceRef', 'subscribe', 'delivery', 'batchPolicyRef', 'start', 'scope'], 'logs'); id(s.logs.serviceRef, 'logs.serviceRef', true);
  if (s.logs.subscribe !== undefined) {
    if (!Array.isArray(s.logs.subscribe)) fail('logs.subscribe must be an array');
    for (const value of s.logs.subscribe) choice(value, subscriptions, 'logs.subscribe');
  }
  optional(s.logs.delivery, value => choice(value, ['durable-inbox-when-quiet', 'existing-dispatch-only'], 'logs.delivery'));
  optional(s.logs.batchPolicyRef, id, 'logs.batchPolicyRef');
  optional(s.logs.start, value => choice(value, ['saved-cursor-or-recent'], 'logs.start'));
  optional(s.logs.scope, value => choice(value, ['workspace', 'project'], 'logs.scope'));
  const l = s.lifecycle;
  obj(l, ['scope', 'automaticRetirement', 'reset', 'restartPolicy', 'recovery', 'onRefusal', 'replicas', 'afterReport', 'corrections', 'retainUntil', 'resetWhileParked'], 'lifecycle');
  choice(l.scope, ['operator-conversation', 'supervisor-decision-cycle', 'work-item', 'workspace-slot', 'project-triage-batch'], 'lifecycle.scope');
  choice(l.automaticRetirement, ['never', 'safe-planner-after-disposition'], 'lifecycle.automaticRetirement');
  choice(l.onRefusal, ['hold'], 'lifecycle.onRefusal');
  choice(l.restartPolicy, ['on-confirmed-exit-with-context-evidence', 'on-confirmed-exit-resume-known-session', 'on-confirmed-exit-with-backoff', 'on-confirmed-exit-from-committed-cursor'], 'lifecycle.restartPolicy');
  const scope = { chat: 'operator-conversation', supervisor: 'supervisor-decision-cycle', engineer: 'work-item', reviewer: 'work-item', logs: 'workspace-slot', 'triage-status': 'workspace-slot', 'logs-triage': 'project-triage-batch' }[s.role];
  if (l.scope !== scope) fail('lifecycle scope and role disagree');
  optional(l.replicas, positive, 'lifecycle.replicas'); optional(l.resetWhileParked, bool, 'lifecycle.resetWhileParked');
  for (const [field, values] of Object.entries({ afterReport: ['park-awaiting-review'], corrections: ['reuse-same-session'], retainUntil: ['landed-or-explicit-disposition'], reset: ['close-and-respawn-at-safe-boundary', 'close-and-respawn-at-committed-batch-boundary', 'never-while-work-item-open'] })) {
    optional(l[field], value => choice(value, values, `lifecycle.${field}`));
  }
  if (s.standardSlot && l.automaticRetirement !== 'never') fail('standard slot cannot opt into automatic retirement');
  if (l.recovery !== undefined) {
    obj(l.recovery, ['knownNativeSession', 'freshContext', 'missingEvidence', 'freshContextWhileItemOpen', 'uncommittedBatch'], 'lifecycle.recovery');
    for (const [field, values] of Object.entries({ knownNativeSession: ['resume'], freshContext: ['declared-safe-boundary-with-handoff'], missingEvidence: ['hold'], freshContextWhileItemOpen: ['explicit-recovery-disposition-only'], uncommittedBatch: ['retain-and-surface-in-next-summary'] })) {
      optional(l.recovery[field], value => choice(value, values, `recovery.${field}`));
    }
    if (l.recovery.missingEvidence !== 'hold') fail('missing recovery evidence must hold');
  }
  if (isSession && (!l.recovery || l.reset === undefined)) fail('Session requires reset and recovery policy');
  if (['chat', 'supervisor'].includes(s.role) && (l.reset !== 'close-and-respawn-at-safe-boundary' || l.restartPolicy !== 'on-confirmed-exit-with-context-evidence' ||
      l.recovery?.freshContext !== 'declared-safe-boundary-with-handoff' || l.recovery?.knownNativeSession !== 'resume')) fail('standard Session requires safe-boundary handoff recovery');
  if (s.role === 'logs-triage' && (l.reset !== 'close-and-respawn-at-committed-batch-boundary' || l.restartPolicy !== 'on-confirmed-exit-from-committed-cursor' ||
      l.recovery?.uncommittedBatch !== 'retain-and-surface-in-next-summary')) fail('logs-triage requires committed batch recovery');
  if (!isSession && l.restartPolicy !== 'on-confirmed-exit-with-backoff') fail('LogViewer requires model-free backoff restart policy');
  if (s.intent.kind === 'work-item') {
    if (l.scope !== 'work-item' || l.afterReport !== 'park-awaiting-review' || l.corrections !== 'reuse-same-session' || l.retainUntil !== 'landed-or-explicit-disposition' ||
        l.resetWhileParked !== false || l.reset !== 'never-while-work-item-open' || l.restartPolicy !== 'on-confirmed-exit-resume-known-session' ||
        l.recovery?.freshContextWhileItemOpen !== 'explicit-recovery-disposition-only') fail('work-item lifecycle must retain through review and corrections');
  }
  let route;
  if (isSession) {
    id(s.route, 'spec.route');
    obj(s.execution, ['host', 'billing', 'modelApi'], 'execution');
    if (s.execution.host !== 'herdr' || s.execution.billing !== 'subscription' || s.execution.modelApi !== 'forbidden') fail('Session requires Herdr/subscription/no-model-API execution assertions');
    obj(s.personality, ['profile', 'instructions'], 'personality'); id(s.personality.profile, 'personality.profile'); str(s.personality.instructions, 'personality.instructions');
    route = resolveLaunchRoute(config, { route: s.route });
    if (s.launch !== undefined) {
      obj(s.launch, ['harness', 'model', 'effort'], 'launch');
      for (const [key, value] of Object.entries(s.launch)) {
        str(value, `launch.${key}`);
        if (value !== route[key === 'harness' ? 'kind' : key]) fail(`launch.${key} assertion disagrees with resolved route ${s.route}`);
      }
    }
    if (s.singletonScope !== undefined) choice(s.singletonScope, ['canonical-project'], 'singletonScope');
    if (s.tools !== undefined) {
      obj(s.tools, ['input', 'allowed'], 'tools');
      choice(s.tools.input, ['preloaded-scoped-files'], 'tools.input');
      if (!Array.isArray(s.tools.allowed) || s.tools.allowed.length !== 1 || s.tools.allowed[0] !== 'write-own-triage-output') fail('tools may only write own triage output');
    }
    if (s.role === 'logs-triage') {
      if (s.standardSlot !== 'logs' || s.paneSlot !== 'triage' || s.workspaceRef !== 'home' || s.singletonScope !== 'canonical-project' || l.replicas !== 1) fail('logs-triage requires home logs/triage singleton with replicas 1');
      if (!s.tools || s.permissions.profileRef !== 'triage-output-only') fail('logs-triage requires output-only tools and native profile assertion');
      const hygiene = resolveLaunchRoute(ROUTE_PRESET, { route: 'triage' });
      if (s.route === 'triage' || ['kind', 'model', 'effort'].every(key => route[key] === hygiene[key])) fail('logs-triage cannot resolve to preset triage (record hygiene) route');
    } else if (s.singletonScope !== undefined || s.tools !== undefined) fail('singletonScope/tools are reserved for logs-triage');
  } else {
    choice(s.viewer, ['brain-structured-events', 'project-triage-status'], 'viewer');
    if ((s.viewer === 'project-triage-status') !== (s.role === 'triage-status') || s.memory.mode !== 'none' || s.memory.claudeMem !== undefined || s.memory.recordLessons !== undefined) fail('LogViewer must be model-free with matching status adapter and memory none');
    if (s.role === 'triage-status' && s.workspaceRef === 'home') fail('home triage pane is reserved for the project singleton Session');
  }
  return { manifest, resolvedSpec: { ...s, ...(route ? { resolvedRoute: route } : {}) }, diagnostics };
}

export function validateSet(entries) {
  const diagnostics = [], uids = new Set(), slots = new Set(); let triage = false;
  for (const entry of entries) {
    const { metadata: m, spec: s } = entry.manifest;
    // The inspected set belongs to one canonical common dir, regardless of
    // human namespace or workspace names.
    if (uids.has(m.uid)) diagnostics.push({ file: entry.file, level: 'error', message: `duplicate uid ${m.uid}` });
    uids.add(m.uid);
    if (s.standardSlot) {
      const key = JSON.stringify([s.workspaceRef, s.standardSlot, s.paneSlot ?? 'primary']);
      if (slots.has(key)) diagnostics.push({ file: entry.file, level: 'error', message: 'duplicate standard tab/pane position' });
      slots.add(key);
    }
    if (s.role === 'logs-triage') {
      if (triage) diagnostics.push({ file: entry.file, level: 'error', message: 'second logs-triage session for canonical project' });
      triage = true;
    }
  }
  return diagnostics;
}
