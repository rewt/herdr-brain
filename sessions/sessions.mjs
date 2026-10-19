import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { loadDiscoveredRoutes } from '../lanes/routes.mjs';
import { findOrgDir, loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { canonicalProject, safeProjectPath } from './project.mjs';
import { parseManifest, validateManifest, validateSet } from './manifest.mjs';

const templates = fileURLToPath(new URL('./templates/', import.meta.url));
function read({ file, committed }, project) {
  if (committed) {
    if (!['100644', '100755'].includes(committed.mode)) throw Error('committed manifest must be a regular file');
    return parseManifest(execFileSync('git', ['-C', project.root, 'show', `${committed.head}:${committed.relative}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 + 1 }));
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw Error('manifest must be a regular file of at most 1 MiB');
  return parseManifest(fs.readFileSync(file, 'utf8'));
}

export function discoverManifests(project, workspace = 'home', diagnostics = []) {
  const names = ['chat.md', 'supervisor.md', 'logs-viewer.md', workspace === 'home' ? 'logs-triage.md' : 'triage-status.md'];
  const files = new Map(names.map(name => [name, { file: path.join(templates, name), template: true }]));
  const git = args => execFileSync('git', ['-C', project.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // Freeze canonical HEAD once. Neither working-tree nor index bytes are
  // desired configuration, even if a discovered file is edited or removed.
  let head;
  try { head = git(['rev-parse', '--verify', '-q', 'HEAD^{commit}']).trim(); }
  catch (error) { if (error.status !== 1) throw error; } // An unborn project has no committed overrides.
  const isTopLevel = file => /^\.sessions\/[^/]+\.md$/u.test(file);
  const tracked = head ? git(['ls-tree', '-r', '-z', '--full-tree', head, '--', '.sessions/']) : '';
  const committedFiles = new Map(), referenced = new Set();
  for (const row of tracked.split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t'), relative = row.slice(tab + 1), mode = row.slice(0, tab).split(' ')[0];
    const input = { file: path.join(project.root, relative), template: false, committed: { head, relative, mode } };
    committedFiles.set(relative, input);
    if (isTopLevel(relative)) files.set(relative.slice('.sessions/'.length), input);
  }
  // Nested Markdown has historically been opaque. Only a committed, valid
  // top-level Workspace can opt its exact resource paths into discovery.
  for (const input of [...files.values()].filter(input => !input.template)) {
    try {
      const manifest = read(input, project);
      if (manifest.kind !== 'Workspace') continue;
      validateManifest(manifest, { project });
      for (const reference of manifest.spec.sessions) {
        const relative = `.sessions/${reference}`;
        referenced.add(relative);
        if (committedFiles.has(relative)) files.set(reference, committedFiles.get(relative));
      }
    } catch { /* Inspection below reports invalid top-level manifests. */ }
  }
  const isManifest = file => isTopLevel(file) || referenced.has(file);
  const diffArgs = ['--name-only', '-z', '--no-ext-diff', '--no-textconv', '--no-renames'];
  const changed = new Set([
    ...git(['diff', ...diffArgs, '--', '.sessions/']).split('\0'),
    ...git(['diff', '--cached', ...diffArgs, ...(head ? [head] : []), '--', '.sessions/']).split('\0'),
  ].filter(isManifest));
  for (const relative of [...changed].sort()) diagnostics.push({ file: path.join(project.root, relative), level: 'warning', message: `uncommitted manifest ignored: ${relative}; inspection uses committed HEAD` });
  const untracked = git(['ls-files', '--others', '-z', '--', '.sessions/']).split('\0').filter(isManifest);
  for (const relative of untracked.sort()) {
    if (!changed.has(relative)) diagnostics.push({ file: path.join(project.root, relative), level: 'warning', message: `untracked manifest ignored: ${relative}; inspection uses committed HEAD` });
  }
  return [...files.values()];
}

export function inspect({ files = [], cwd = process.cwd(), workspace = 'home', env = process.env } = {}) {
  const project = canonicalProject(cwd);
  const routes = loadDiscoveredRoutes({ cwd: project.root, env });
  const entries = [], workspaces = [], diagnostics = [];
  const inputs = files.length ? files.map(file => ({ file: path.resolve(file), template: false })) : discoverManifests(project, workspace, diagnostics);
  const parsed = [];
  for (const input of inputs) {
    try {
      const manifest = read(input, project);
      if (input.template) {
        manifest.spec.workspaceRef = workspace;
        manifest.metadata.uid = `default-${manifest.spec.role}-${createHash('sha256').update(JSON.stringify([project.common, workspace])).digest('hex').slice(0, 16)}`;
      }
      parsed.push({ input, manifest });
    } catch (error) { diagnostics.push({ file: input.file, level: 'error', message: error.message }); }
  }
  const compositions = parsed.filter(p => p.manifest.kind === 'Workspace');
  const selected = new Map();
  let suppressDefaults = false;
  if (compositions.length) {
    for (const { input, manifest } of compositions) {
      try {
        const validated = validateManifest(manifest, { config: routes.config, project });
        const relative = path.relative(project.root, input.file);
        if (safeProjectPath(project.root, relative) !== input.file || !relative.startsWith(`.sessions${path.sep}`))
          throw Error('Workspace must be inside the canonical .sessions directory');
        for (const reference of manifest.spec.sessions) {
          const file = safeProjectPath(path.join(project.root, '.sessions'), reference);
          // Discovery uses ONLY blobs in the same frozen canonical HEAD.
          // A same-named bundled default or uncommitted file cannot satisfy it.
          const resource = input.committed ? parsed.find(p => p.input.file === file && p.input.committed?.head === input.committed.head)
            : { input: { file, template: false }, manifest: read({ file }, project) };
          if (!resource) throw Error(`Workspace reference is not a committed resource: ${reference}`);
          if (!['Session', 'LogViewer'].includes(resource.manifest.kind)) throw Error(`Workspace reference must be Session or LogViewer: ${reference}`);
          if (resource.manifest.spec?.workspaceRef !== manifest.spec.workspaceRef) throw Error(`Workspace reference disagrees with workspaceRef: ${reference}`);
          validateManifest(resource.manifest, { config: routes.config, project });
          if (selected.has(file)) throw Error(`resource referenced by multiple Workspaces: ${reference}`);
          selected.set(file, resource);
        }
        workspaces.push({ file: input.file, ...validated });
        if (manifest.spec.workspaceRef === workspace) suppressDefaults = true;
      } catch (error) { diagnostics.push({ file: input.file, level: 'error', message: error.message }); }
    }
    // Preserve independently declared resources and closed-field validation.
    // Suppress implicit defaults only for the selected workspace's valid
    // composition; compositions for other workspaces cannot remove them.
    for (const resource of parsed.filter(p => (!p.input.template || !suppressDefaults) && p.manifest.kind !== 'Workspace')) {
      if (!selected.has(resource.input.file)) selected.set(resource.input.file, resource);
    }
  } else for (const resource of parsed) selected.set(resource.input.file, resource);
  for (const { input, manifest } of selected.values()) {
    try {
      const validated = validateManifest(manifest, { config: routes.config, project });
      entries.push({ file: input.file, ...validated });
      diagnostics.push(...validated.diagnostics.map(d => ({ file: input.file, ...d })));
    } catch (error) { diagnostics.push({ file: input.file, level: 'error', message: error.message }); }
  }
  diagnostics.push(...validateSet([...workspaces, ...entries]));
  const refs = new Set();
  for (const entry of workspaces) {
    const ref = entry.manifest.spec.workspaceRef;
    if (refs.has(ref)) diagnostics.push({ file: entry.file, level: 'error', message: `duplicate Workspace workspaceRef ${ref}` });
    refs.add(ref);
  }
  const workers = entries.filter(e => e.manifest.spec.intent.kind === 'work-item');
  if (workers.length) {
    try {
      const org = findOrgDir({ cwd: project.root, env });
      if (!org) throw Error('work-item inspection requires a readable project record');
      const loaded = loadEvents(org);
      if (loaded.tornTail) throw Error('work-item inspection requires a complete record tail');
      const state = fold(loaded.events);
      for (const worker of workers) if (!state.items.has(worker.manifest.spec.intent.item)) {
        diagnostics.push({ file: worker.file, level: 'error', message: `unknown work item ${worker.manifest.spec.intent.item}` });
      }
    } catch (error) { diagnostics.push({ level: 'error', message: error.message }); }
  }
  return { apiVersion: 'session-inspection/v1', project, workspace, routeFiles: routes.files, suggestedRoutes: Boolean(routes.suggested),
    entries, workspaces, diagnostics, valid: !diagnostics.some(d => d.level === 'error') };
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string', default: process.cwd() }, workspace: { type: 'string' },
    authorization: { type: 'string' }, plan: { type: 'string' }, evidence: { type: 'string' },
    role: { type: 'string' }, actor: { type: 'string' }, actions: { type: 'string' },
    'operator-decision': { type: 'string' }, expires: { type: 'string' },
    operation: { type: 'string' }, disposition: { type: 'string' }
  }, usage: 'Usage: node sessions/sessions.mjs inspect|plan|apply|authorize|dispose-start [FILE ...] --project PATH [--workspace REF] [--authorization FILE --plan FILE --evidence FILE] [--role supervisor --actor NAME --actions KINDS --operator-decision ID:SEQ --expires UTC] [--operation ID --disposition FILE]' });
  const command = positionals.shift();
  if (!['inspect', 'plan', 'apply', 'authorize', 'dispose-start'].includes(command)) throw Error('expected inspect, plan, apply, authorize or dispose-start');
  const options = { files: positionals, cwd: values.project, workspace: values.workspace, authorization: values.authorization,
    planFile: values.plan, evidence: values.evidence };
  let result;
  if (command === 'authorize') {
    if (positionals.length) throw Error('authorize takes no manifest files');
    const match = /^([A-Za-z0-9-]+):([1-9][0-9]*)$/u.exec(values['operator-decision'] ?? '');
    if (!match) throw Error('--operator-decision requires RECORD-ID:SEQ');
    result = (await import('./authorization.mjs')).authorize({ ...options, role: values.role, actor: values.actor,
      actions: values.actions?.split(','), operatorDecision: { id: match[1], seq: Number(match[2]) }, expiresAt: values.expires });
  } else if (command === 'dispose-start') {
    if (positionals.length) throw Error('dispose-start takes no manifest files');
    result = (await import('./disposition.mjs')).disposeStart({ ...options, role: values.role, actor: values.actor,
      operationId: values.operation, dispositionFile: values.disposition });
  } else if (command === 'inspect') result = inspect(options);
  else if (command === 'plan') result = await (await import('./plan.mjs')).plan(options);
  else result = await (await import('./apply.mjs')).apply(options);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.valid === false || result.apply?.state === 'refused') process.exitCode = 1;
}
if (isMain(import.meta.url)) {
  main().catch(error => { process.stderr.write(`sessions: ${error.message}\n`); process.exitCode = 1; });
}
