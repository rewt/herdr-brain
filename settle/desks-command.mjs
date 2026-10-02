import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { routesSnapshot, editProjectConfig } from '../lanes/routes-command.mjs';
import { UserError } from '../lib/store.mjs';
import { renderDesks } from '../lib/render.mjs';
import { DESK_FIELDS, DESK_DEFAULTS, parseDeskValue, validateDeskSettings } from './config.mjs';
import { resolveValidation } from '../lanes/validation.mjs';
import path from 'node:path';

export function desksSnapshot(cwd = process.cwd()) {
  const routes = routesSnapshot(cwd);
  let settings = {}, source = 'default';
  for (const file of routes.files) {
    const layer = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Object.hasOwn(layer, 'settle')) { settings = layer.settle; source = file; }
  }
  validateDeskSettings(settings, routes.config);
  const lifecycle = Object.assign({}, ...routes.files.map(file => JSON.parse(fs.readFileSync(file, 'utf8'))));
  const sources = {};
  for (const file of routes.files) for (const key of Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))) sources[key] = file;
  const validation = resolveValidation({ root: path.dirname(routes.target), config: lifecycle, sources, env: {} });
  return { ...routes, settings, source, defaults: DESK_DEFAULTS, validation };
}
export function setProjectDesks(patch, unset = [], options = {}) {
  for (const key of [...Object.keys(patch), ...unset]) if (!DESK_FIELDS.includes(key)) throw new UserError(`unknown desk field: ${key}`);
  editProjectConfig((next, current) => {
    // Settle uses whole-object precedence: retain every other effective field,
    // including extension fields, when adopting a parent's settings.
    const settings = { ...desksSnapshot(options.cwd).settings, ...patch };
    for (const key of unset) delete settings[key];
    validateDeskSettings(settings, current.config);
    next.settle = settings;
  }, { ...options, adoptRoutes: false });
  return desksSnapshot(options.cwd);
}
export function desksCommand(argv) {
  try {
    const options = Object.fromEntries(DESK_FIELDS.map(key => [key.replaceAll('_', '-'), { type: 'string' }]));
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      ...options, unset: { type: 'string', multiple: true }, expect: { type: 'string' }, json: { type: 'boolean' },
    } });
    const patch = Object.fromEntries(DESK_FIELDS.flatMap(key => values[key.replaceAll('_', '-')] === undefined ? [] : [[key, parseDeskValue(key, values[key.replaceAll('_', '-')].trim())]]));
    let result;
    if (!positionals.length && !Object.keys(patch).length && !values.unset && !values.expect) result = desksSnapshot();
    else if (positionals.length === 1 && positionals[0] === 'set' && (Object.keys(patch).length || values.unset?.length)) result = setProjectDesks(patch, values.unset, { expect: values.expect });
    else throw new UserError('usage: record desks [--json] | record desks set --review-route ROUTE --fix-route ROUTE --review-round-cap N --timeout SECONDS --reuse true|false --to AGENT [--unset FIELD] [--expect REV]');
    process.stdout.write(values.json ? JSON.stringify(result, null, 2) + '\n' : renderDesks(result));
    return 0;
  } catch (error) { throw new UserError(error.message); }
}
