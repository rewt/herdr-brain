// The reviewed manifest is authority. Scanning can only narrow its components.
// This module never executes candidate bytes or chooses validation commands.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sourceReach } from './green-reach.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, reason, extra = {}) => ({ eligible: false, code, reason, ...extra });
const regular = mode => mode === '100644';
const safePath = file => typeof file === 'string' && /^[\w./-]+$/.test(file) && !path.isAbsolute(file) && file.split('/').every(p => p && p !== '.' && p !== '..');
export const INTERIM_MS = 10 * 24 * 60 * 60 * 1000;
export function checkActivation(activatedAt, now = Date.now()) {
  const start = Date.parse(activatedAt);
  if (typeof activatedAt !== 'string' || !Number.isFinite(start) || new Date(start).toISOString() !== activatedAt || start > now || now - start >= INTERIM_MS)
    throw Error('GREEN_EXPIRED: activation is missing, in the future or outside the ten-day interim');
}

// Deliberately small initial contract: change only render()'s default width.
// The full reviewed source is bound after replacing this one numeric slot.
// Computed data reads/callbacks in the unchanged body need no scanner exemption.
export function componentShape(source, profile) {
  if (profile !== 'board-default-width/v1') throw Error('unknown component profile');
  const prefix = 'export function render(snapshot, { width = ';
  const suffix = ', height = Infinity, now = Date.now() } = {}) {';
  const lines = source.split('\n'), indices = lines.flatMap((line, i) => line.startsWith(prefix) ? [i] : []);
  if (indices.length !== 1) throw Error('missing or duplicate renderer width slot');
  const line = lines[indices[0]], value = line.slice(prefix.length, -suffix.length);
  if (!line.endsWith(suffix) || !/^(?:[89]\d|1\d\d|2[0-3]\d|240)$/.test(value)) throw Error('width must be an integer from 80 to 240');
  const scan = sourceReach('width.mjs', `export const width = ${value};\n`, new Map());
  if (scan.unknown.length || scan.dependencies.length) throw Error('width outside the closed data profile');
  lines[indices[0]] = prefix + '<reviewed-width>' + suffix;
  return { sha256: hash(lines.join('\n')), width: Number(value) };
}

// Build a review input, never an approval or an enablement operation. Include
// the whole runtime/configuration universe conservatively, without treating
// ordinary test bodies as promotion authority. Unknown wrappers cannot gain a
// candidate-selected target: all this code is frozen and the only variable is
// a bounded presentation integer. Expanding that surface needs ordinary review.
export const BOOTSTRAP_FILES = [
  'supervisor/green-contracts.json', 'supervisor/green-pass.mjs',
  'supervisor/green-reach.mjs', 'supervisor/green-manifest.mjs',
  'supervisor/GREEN-COHORT.md', 'supervisor/GREEN-CONTRACTS.md',
];
export function boundaryRole(file) {
  if (/^(?:promote|settle|acceptance|test\/helpers)\//.test(file) ||
      /^(?:supervisor\/(?:autopilot|clean-pass|fast-path-timing|supervisor|entry|context|notice-lock|status|safe-point)\.mjs|lanes\/validation\.mjs)$/.test(file)) return 'promotion-authority';
  if (file === 'supervisor/reconcile.mjs' || file === 'bin/org.mjs') return 'bch-entry';
  return 'runtime-or-configuration';
}
export function boundaryInput(file) {
  if (BOOTSTRAP_FILES.includes(file) || file === 'board/render.mjs') return false;
  if (file.startsWith('test/helpers/')) return true;
  if (/(?:^|\/)(?:test|tests)\//.test(file) || /\.test\.mjs$/.test(file) || /^(?:docs|archive)\//.test(file)) return false;
  // Include instructions and extensionless launch/config files too. Runtime
  // directories are a closed universe, not a list of executable suffixes.
  return true;
}
export const LOADER_ENV = ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'PATH', 'HERDR_MONITOR_FLEET', 'HOME', 'XDG_CONFIG_HOME'];
export const loaderEnvironment = () => Object.fromEntries([...new Set([...LOADER_ENV,
  ...Object.keys(process.env).filter(key => /^(?:GIT_|NODE_|DYLD_|LD_)/.test(key)),
])].sort().map(key => [key, hash(process.env[key] ?? '')]));
export function externalDescriptor(file) {
  if (!path.isAbsolute(file)) throw Error('external input requires an absolute path');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { path: file, sha256: null };
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 2 * 1024 * 1024) throw Error(`non-regular external boundary: ${file}`);
  return { path: file, realpath: fs.realpathSync(file), sha256: hash(fs.readFileSync(file)) };
}
export function executableDescriptor(name) {
  const selected = (process.env.PATH ?? '').split(path.delimiter).map(dir => path.resolve(dir, name)).find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  });
  if (!selected || fs.statSync(selected).size > 128 * 1024 * 1024) throw Error(`missing or oversized executable: ${name}`);
  return { path: selected, realpath: fs.realpathSync(selected), sha256: hash(fs.readFileSync(selected)) };
}
export function buildManifest(tree, { bindings, externalInputs = [] }) {
  const boundary = {};
  for (const file of [...tree.files.keys()].filter(boundaryInput).sort()) {
    const mode = tree.files.get(file).mode;
    if (!['100644', '100755'].includes(mode)) throw Error(`non-regular boundary input: ${file}`);
    boundary[file] = { mode, sha256: hash(tree.bytes ? tree.bytes(file) : tree.read(file)), role: boundaryRole(file) };
  }
  return {
    version: 2, bindings: { brain: bindings.brain, lab: bindings.lab ?? null },
    interimDays: 10, bootstrapFiles: BOOTSTRAP_FILES,
    entries: [{ project: 'brain', path: 'supervisor/reconcile.mjs', contract: 'reconcile-complete-batch/v1' }],
    externalConsumers: [{ entry: 'contrib/settle-watch.mjs', source: 'immutable installed release', switch: 'release suites, live acceptance and BCH seam checks' }],
    contracts: ['supervisor/GREEN-CONTRACTS.md'],
    environment: loaderEnvironment(), node: { path: fs.realpathSync(process.execPath), sha256: hash(fs.readFileSync(process.execPath)), version: 'v20.19.4', execArgv_sha256: hash(JSON.stringify(process.execArgv)) },
    git: executableDescriptor('git'), externalInputs: externalInputs.map(externalDescriptor),
    components: [{ project: 'brain', path: 'board/render.mjs', profile: 'board-default-width/v1',
      shape_sha256: componentShape(tree.read('board/render.mjs'), 'board-default-width/v1').sha256,
      effects: 'presentation width only; no change to live(), imports, calls, loaders, configuration or project targeting',
      lifecycle: false, validation: ['test/board-view.test.mjs'] }],
    boundary,
  };
}

export function checkDeployment(manifest, trusted) {
  try {
    for (const file of BOOTSTRAP_FILES) trusted(file, '100644');
    for (const [file, pin] of Object.entries(manifest.boundary)) {
      if (!safePath(file) || hash(trusted(file, pin.mode, true)) !== pin.sha256) throw Error(`running boundary drift: ${file}`);
    }
    if (process.version !== manifest.node?.version || fs.realpathSync(process.execPath) !== manifest.node.path ||
        hash(fs.readFileSync(process.execPath)) !== manifest.node.sha256 || hash(JSON.stringify(process.execArgv)) !== manifest.node.execArgv_sha256) throw Error('Node launcher drift');
    if (JSON.stringify(executableDescriptor('git')) !== JSON.stringify(manifest.git)) throw Error('Git launcher drift');
    if (JSON.stringify(loaderEnvironment()) !== JSON.stringify(manifest.environment)) throw Error('loader/environment drift');
    for (const descriptor of manifest.externalInputs) {
      if (JSON.stringify(externalDescriptor(descriptor.path)) !== JSON.stringify(descriptor)) throw Error(`external configuration drift: ${descriptor.path}`);
    }
    for (const component of manifest.components) {
      if (component.project === 'brain' && componentShape(trusted(component.path, '100644'), component.profile).sha256 !== component.shape_sha256) throw Error(`running component drift: ${component.path}`);
    }
  } catch (error) { throw Error(`GREEN_REACH_UNKNOWN: ${error.message}`); }
}

export function manifestScope(before, after, { manifest, trusted, project = 'brain', changes, reviewFile, review }) {
  try {
    if (manifest.version !== 2 || manifest.interimDays !== 10 || !manifest.bindings?.brain ||
        !Array.isArray(manifest.components) || !manifest.boundary || !Array.isArray(manifest.externalInputs) ||
        JSON.stringify(manifest.bootstrapFiles) !== JSON.stringify(BOOTSTRAP_FILES)) throw Error('incomplete containment manifest');
    // No lab component is established yet. An optional binding is not permission
    // to execute arbitrary lab files, copy Brain policy, or target another record.
    if (project !== 'brain') return fail('GREEN_REACH_UNKNOWN', 'no reviewed lab component contract');
    for (const change of changes) {
      if (BOOTSTRAP_FILES.includes(change.file) || boundaryRole(change.file) === 'promotion-authority') return fail('GREEN_SELF_AUTHORITY', `frozen eligibility or promotion authority: ${change.file}`);
      if (manifest.boundary[change.file]) return fail(manifest.boundary[change.file].role === 'bch-entry' ? 'GREEN_BCH_CONSUMED' : 'GREEN_BOUNDARY_CHANGED', `reviewed boundary input changed: ${change.file}`);
    }
    // Both committed trees must contain exactly the reviewed boundary universe.
    // New/deleted runtime files and configs invalidate, even if unrelated to the
    // changed renderer. Also check running bytes: stale imports cannot be used
    // to authorize a candidate against modified on-disk authority.
    for (const tree of [before, after]) {
      const inventory = [...tree.files.keys()].filter(boundaryInput).sort();
      if (JSON.stringify(inventory) !== JSON.stringify(Object.keys(manifest.boundary).sort())) throw Error('runtime/configuration inventory drift');
      for (const file of BOOTSTRAP_FILES) {
        if (!regular(tree.files.get(file)?.mode) || tree.read(file) !== trusted(file, '100644')) throw Error(`bootstrap authority drift: ${file}`);
      }
      for (const [file, pin] of Object.entries(manifest.boundary)) {
        if (!safePath(file) || tree.files.get(file)?.mode !== pin.mode || hash(tree.bytes ? tree.bytes(file) : tree.read(file)) !== pin.sha256) throw Error(`boundary version drift: ${file}`);
      }
    }
    checkDeployment(manifest, trusted);
    const components = [];
    for (const change of changes) {
      if (reviewFile?.startsWith('docs/reviews/') && change.file === reviewFile && change.before === '000000' && change.after === '100644' && change.status === 'A' && review?.sha256 === hash(after.read(change.file))) continue;
      if (![change.before, change.after].every(regular)) return fail('GREEN_NATIVE_ISOLATION', `only regular non-executable component modifications qualify: ${change.file}`);
      const component = manifest.components.find(c => c.project === project && c.path === change.file);
      if (!component) return fail('GREEN_REACH_UNKNOWN', `outside reviewed component contracts: ${change.file}`);
      if (component.lifecycle) throw Error('no protected lifecycle profile has been established');
      for (const tree of [before, after]) if (componentShape(tree.read(change.file), component.profile).sha256 !== component.shape_sha256) throw Error(`component boundary expanded: ${change.file}`);
      components.push({ path: change.file, profile: component.profile, before: componentShape(before.read(change.file), component.profile).width,
        after: componentShape(after.read(change.file), component.profile).width });
    }
    if (!components.length) throw Error('no reviewed component change');
    return { eligible: true, components, lifecycle: false,
      reach: { contract: 'reviewed-manifest/v2', paths: Object.keys(manifest.boundary) },
      authority: { paths: Object.keys(manifest.boundary).filter(file => manifest.boundary[file].role === 'promotion-authority') } };
  } catch (error) { return fail('GREEN_REACH_UNKNOWN', error.message); }
}
