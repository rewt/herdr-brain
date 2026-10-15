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
function read(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw Error('manifest must be a regular file of at most 1 MiB');
  return parseManifest(fs.readFileSync(file, 'utf8'));
}

export function discoverManifests(project, workspace = 'home') {
  const names = ['chat.md', 'supervisor.md', 'logs-viewer.md', workspace === 'home' ? 'logs-triage.md' : 'triage-status.md'];
  const files = new Map(names.map(name => [name, { file: path.join(templates, name), template: true }]));
  // Only tracked project documents override/add defaults, always from the
  // canonical checkout. Untracked lane files and display sidecars do nothing.
  const tracked = execFileSync('git', ['-C', project.root, 'ls-files', '-z', '--', '.sessions/'], { encoding: 'utf8' });
  for (const relative of tracked.split('\0').filter(file => /^\.sessions\/[^/]+\.md$/u.test(file))) {
    files.set(path.basename(relative), { file: safeProjectPath(project.root, relative), template: false });
  }
  return [...files.values()];
}

export function inspect({ files = [], cwd = process.cwd(), workspace = 'home', env = process.env } = {}) {
  const project = canonicalProject(cwd);
  const routes = loadDiscoveredRoutes({ cwd: project.root, env });
  const inputs = files.length ? files.map(file => ({ file: path.resolve(file), template: false })) : discoverManifests(project, workspace);
  const entries = [], diagnostics = [];
  for (const input of inputs) {
    try {
      const manifest = read(input.file);
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

export function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string', default: process.cwd() }, workspace: { type: 'string', default: 'home' } },
    usage: 'Usage: node sessions/sessions.mjs inspect [FILE ...] [--project PATH] [--workspace home|REF]' });
  if (positionals.shift() !== 'inspect') throw Error('expected inspect');
  const result = inspect({ files: positionals, cwd: values.project, workspace: values.workspace });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.valid) process.exitCode = 1;
}
if (isMain(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`sessions: ${error.message}\n`); process.exitCode = 1; }
}
