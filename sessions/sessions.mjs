import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { loadDiscoveredRoutes } from '../lanes/routes.mjs';
import { findOrgDir, loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { canonicalProject } from './project.mjs';
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
  const isManifest = file => /^\.sessions\/[^/]+\.md$/u.test(file);
  const tracked = head ? git(['ls-tree', '-r', '-z', '--full-tree', head, '--', '.sessions/']) : '';
  for (const row of tracked.split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t'), relative = row.slice(tab + 1), mode = row.slice(0, tab).split(' ')[0];
    if (isManifest(relative)) files.set(path.basename(relative), { file: path.join(project.root, relative), template: false, committed: { head, relative, mode } });
  }
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
  const entries = [], diagnostics = [];
  const inputs = files.length ? files.map(file => ({ file: path.resolve(file), template: false })) : discoverManifests(project, workspace, diagnostics);
  for (const input of inputs) {
    try {
      const manifest = read(input, project);
      if (input.template) {
        manifest.spec.workspaceRef = workspace;
        manifest.metadata.uid = `default-${manifest.spec.role}-${createHash('sha256').update(JSON.stringify([project.common, workspace])).digest('hex').slice(0, 16)}`;
      }
      const validated = validateManifest(manifest, { config: routes.config, project });
      entries.push({ file: input.file, ...validated });
      diagnostics.push(...validated.diagnostics.map(d => ({ file: input.file, ...d })));
    } catch (error) { diagnostics.push({ file: input.file, level: 'error', message: error.message }); }
  }
  diagnostics.push(...validateSet(entries));
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
    entries, diagnostics, valid: !diagnostics.some(d => d.level === 'error') };
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string', default: process.cwd() }, workspace: { type: 'string', default: 'home' } },
    usage: 'Usage: node sessions/sessions.mjs inspect|plan [FILE ...] [--project PATH] [--workspace home|REF]' });
  const command = positionals.shift();
  if (!['inspect', 'plan'].includes(command)) throw Error('expected inspect or plan');
  const options = { files: positionals, cwd: values.project, workspace: values.workspace };
  const result = command === 'inspect' ? inspect(options) : await (await import('./plan.mjs')).plan(options);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.valid) process.exitCode = 1;
}
if (isMain(import.meta.url)) {
  main().catch(error => { process.stderr.write(`sessions: ${error.message}\n`); process.exitCode = 1; });
}
