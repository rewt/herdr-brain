// Routing edits belong to a validating CLI, never to a console file writer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { gitProject } from '../lib/project.mjs';
import { UserError } from '../lib/store.mjs';
import { renderRoutes } from '../lib/render.mjs';
import { loadDiscoveredRoutes, mergeRoutesConfig, resolveRoute, validateRoutesConfig } from './routes.mjs';

export function routesSnapshot(cwd = process.cwd()) {
  let project;
  try { project = gitProject(cwd); } catch { /* Plain folders can inspect defaults. */ }
  // Console edits are project overrides. LANE_CONFIG is a launch-time override,
  // so never use an inherited environment variable to choose a write target.
  const root = project?.canonical ?? fs.realpathSync(cwd);
  const loaded = loadDiscoveredRoutes({ cwd: root, env: {} });
  const target = path.join(root, '.lane.json');
  const bytes = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  const revision = crypto.createHash('sha256').update(JSON.stringify([loaded, target, bytes])).digest('hex');
  return { ...loaded, target, editable: Boolean(project), revision };
}

function safeTarget(target) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.nlink !== 1) throw new UserError('project .lane.json must be a regular, unlinked file to edit');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function setProjectRoute(name, patch, { cwd = process.cwd(), expect } = {}) {
  const before = routesSnapshot(cwd);
  if (!before.editable) throw new UserError('route edits require a Git project');
  if (!Object.hasOwn(before.config.routes ?? {}, name)) throw new UserError(`unknown route: ${name}`);
  if (!name.trim() || /[\x00-\x1f\x7f]/u.test(name)) throw new UserError('route name must be non-empty printable text');
  const lock = `${before.target}.lock`;
  try { fs.mkdirSync(lock); }
  catch (error) { if (error.code === 'EEXIST') throw new UserError(`route config is locked: ${lock}`); throw error; }
  let temporary;
  try {
    safeTarget(before.target);
    const current = routesSnapshot(cwd);
    if (expect && current.revision !== expect) throw new UserError('routes changed since you opened the editor; refresh and review again');
    const own = fs.existsSync(current.target) ? JSON.parse(fs.readFileSync(current.target, 'utf8')) : {};
    // Materialize the portable preset on its first edit so one override does not
    // silently remove every other suggested route and the selection policy.
    const next = current.suggested ? structuredClone(current.config) : own;
    if (current.suggested) next.authority = 'Project routes confirmed by the operator';
    const effective = resolveRoute(current.config, { route: name });
    next.routes = { ...next.routes, [name]: { ...current.config.routes[name],
      kind: effective.kind, ...(effective.model ? { model: effective.model } : {}),
      ...(effective.effort ? { effort: effective.effort } : {}), ...patch } };
    validateRoutesConfig(next, { references: false });
    // Project route maps replace individual inherited routes; all policy
    // references must still resolve before any bytes are replaced.
    mergeRoutesConfig([current.config, next]);
    const content = JSON.stringify(next, null, 2) + '\n';
    temporary = `${current.target}.tmp-${crypto.randomUUID()}`;
    const mode = fs.existsSync(current.target) ? fs.statSync(current.target).mode & 0o777 : 0o644;
    const fd = fs.openSync(temporary, 'wx', mode);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (routesSnapshot(cwd).revision !== current.revision) throw new UserError('routes changed while saving; refresh and review again');
    safeTarget(current.target);
    fs.renameSync(temporary, current.target);
    temporary = null;
    return routesSnapshot(cwd);
  } finally {
    if (temporary) fs.rmSync(temporary, { force: true });
    fs.rmdirSync(lock);
  }
}

export function routesCommand(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    json: { type: 'boolean' }, kind: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, expect: { type: 'string' },
  } });
  const [verb, name] = positionals;
  const patch = Object.fromEntries(['kind', 'model', 'effort'].filter(k => values[k] !== undefined).map(k => [k, values[k]]));
  let result;
  try {
    if (!verb && !Object.keys(patch).length && !values.expect) result = routesSnapshot();
    else if (verb === 'set' && name && positionals.length === 2 && Object.keys(patch).length) {
      result = setProjectRoute(name, patch, { expect: values.expect });
    } else throw new UserError('usage: record routes [--json] | record routes set NAME --kind K --model M --effort E [--expect REV]');
  } catch (error) { throw new UserError(error.message); }
  process.stdout.write(values.json ? JSON.stringify(result, null, 2) + '\n' : renderRoutes(result));
  return 0;
}
