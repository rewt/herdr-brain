// Explicit foreground migration. The only native capability is observation.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { gitProject } from './project.mjs';
import { projectFleet } from './fleet.mjs';
import { findOrgDir, initOrg, transact, writer } from './store.mjs';
import { readPlainFile, writeFileAtomic, plainDirectory } from './files.mjs';
import { configHome, homeProject, projectIdentity, component, POLICY_FILES, present, contentDigest, configDrift, readConfigJSON, configGitEnv, canonicalPath } from './config-home.mjs';
import { validatePolicy, readPolicyFile, readProjectPolicy, parsePolicyBytes } from './config-policy.mjs';
import { auditEvents, publishConfigBaseline } from './config-audit.mjs';
import { inspect } from '../sessions/sessions.mjs';
import { agentBinding, createHerdrObserver, readSessionFacts } from '../sessions/observe.mjs';
import { adoptionScope, authorizeAdoption, enrollObserved } from '../sessions/adopt.mjs';
import { acquireControllerLease, durableWrite, readControllerJournal } from '../sessions/runtime.mjs';
import { digest } from '../sessions/lifecycle-evidence.mjs';
import { herdrSocketPath } from '../lanes/board/herdr-client.mjs';
import { planSessions } from '../sessions/reconcile.mjs';
import { readStandardSlots } from '../sessions/receipts.mjs';

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function owningProject(cwd, argument, env) {
  const project = gitProject(cwd, { env });
  if (fs.realpathSync(cwd) !== project.canonical || project.checkout !== project.canonical) throw Error('adopt requires the canonical checkout as its own identity');
  if (argument !== path.basename(project.canonical) && (!present(path.resolve(cwd, argument)) || fs.realpathSync(path.resolve(cwd, argument)) !== project.canonical)) throw Error('adopt argument must resolve to this same canonical Git project');
  const owner = projectIdentity(project, env);
  return { project, owner };
}
function inventory(project, boundary, routing, env) {
  const sources = {}, bytes = {};
  for (const [kind, [, legacy]] of Object.entries(POLICY_FILES)) {
    if (kind === 'routing' && !routing) continue;
    const file = kind === 'routing' ? path.resolve(project.canonical, routing) : path.join(project.canonical, legacy);
    if (kind === 'routing' && !present(file)) throw Error(`${file}: explicitly selected routing source is missing`);
    let content = present(file) ? readPlainFile(file, null) : null;
    if (['pin', 'promote'].includes(kind)) {
      const head = git(project.canonical, ['rev-parse', '--verify', 'HEAD']).trim();
      const entry = git(project.canonical, ['ls-tree', head, '--', legacy]).trim();
      const accepted = entry ? execFileSync('git', ['-C', project.canonical, 'show', `${head}:${legacy}`], { encoding: 'buffer', env, stdio: ['ignore', 'pipe', 'pipe'] }) : null;
      if (content === null ? accepted !== null : accepted === null || !content.equals(accepted)) throw Error(`${file}: prepared ${kind} edit differs from accepted committed source`);
      content = accepted;
    }
    if (content !== null) { parsePolicyBytes(content, kind, file); bytes[kind] = content; }
    sources[kind] = { path: file, base: path.dirname(file), present: content !== null, ...(content !== null ? { sha256: contentDigest(content) } : {}) };
  }
  const parentFiles = (boundary.project ?? boundary.legacy)?.layers ?? [];
  // Ordinary legacy discovery contributes its nearest parent even without a
  // fleet; the route loader already proves that same eligible source order.
  const parents = parentFiles.length ? parentFiles : inspect({ cwd: project.canonical, env }).routeFiles.filter(file => path.dirname(file) !== project.canonical);
  const defaults = {}, origins = {};
  for (const file of parents) {
    const layer = readPolicyFile(file, 'identity', { cwd: project.canonical, env });
    for (const [key, value] of Object.entries(layer)) {
      defaults[key] = key === 'routes' ? { ...defaults.routes, ...value } : value;
      origins[key] = { path: file, base: path.dirname(file) };
    }
  }
  return { sources, bytes, parents, parent: parents.at(-1), defaults, origins };
}
function worktrees(project, boundary, scope, env) {
  if (boundary.project?.worktrees || boundary.legacy?.worktrees) return (boundary.project ?? boundary.legacy).worktrees;
  const files = [...scope.parents, scope.sources.lane.path].filter(Boolean);
  let root = path.join(env.HOME, '.herdr/worktrees', path.basename(project.canonical));
  for (const file of files) {
    if (!present(file)) continue;
    const config = readPolicyFile(file, 'lane', { cwd: project.canonical, env });
    if (config.worktree_root !== undefined) root = path.join(path.resolve(path.dirname(file), config.worktree_root), path.basename(project.canonical));
    else if (scope.parents.includes(file)) root = path.join(path.dirname(file), '.worktrees', path.basename(project.canonical));
  }
  return root;
}
function linkHome(project, directory) {
  const link = path.join(project.canonical, '.brain');
  if (git(project.canonical, ['ls-files', '--', '.brain']).trim()) throw Error(`${link}: refusing a tracked .brain path`);
  if (present(link) && (!fs.lstatSync(link).isSymbolicLink() || fs.realpathSync(link) !== fs.realpathSync(directory))) throw Error(`${link}: unrelated existing path`);
  const exclude = path.join(project.identity, 'info/exclude'), before = present(exclude) ? readPlainFile(exclude) : '';
  if (!before.split(/\r?\n/u).includes('/.brain')) writeFileAtomic(exclude, before + (before.endsWith('\n') || !before ? '' : '\n') + '/.brain\n');
  if (!present(link)) fs.symlinkSync(directory, link, 'dir');
}
function compatibleWriters(project, facts) {
  for (const run of facts.record.runs.filter(r => !r.report && !r.abandoned && r.workspace)) {
    let selected;
    try { selected = gitProject(run.workspace); } catch { continue; }
    if (selected.identity !== project.identity) continue;
    const job = facts.dispatches[run.id], root = job?.release?.root ?? run.owner?.release?.root;
    if (!root || readConfigJSON(path.join(root, '.release-manifest.json')).config_home !== 1) throw Error(`adopt requires owner drain of incompatible admitted run ${run.id}; retain its original run ownership`);
  }
  for (const ref of facts.references ?? []) if (ref.kind === 'promotion') throw Error('adopt requires owner drain of queued/current promotion writers');
}
export async function adopt({ cwd = process.cwd(), project: argument, name, routing, env = process.env, observer, scopeFile, decision, expiresAt,
  requester = env.ORG_ACTOR, inspectOnly = false, installationHome, afterPublish, afterIntent, afterKeep, now = Date.now } = {}) {
  env = configGitEnv(env);
  const { project, owner } = owningProject(cwd, argument, env), boundary = projectFleet(cwd, env);
  const previous = homeProject(cwd, env), warnings = configDrift(previous).map(d => d.warning);
  const selectedName = component(name ?? previous?.project ?? path.basename(project.canonical));
  if (selectedName.toLowerCase() === 'identity.json') throw Error(`reserved config-home project name: ${selectedName} collides with identity metadata`);
  const area = path.join(configHome(env), owner.name, selectedName), identityFile = path.join(path.dirname(area), 'identity.json');
  if (previous && previous.directory !== area) throw Error('project already has another canonical home binding');
  if (!previous && present(area)) throw Error(`${area}: project name collision or incomplete unrelated binding`);
  if (git(cwd, ['ls-files', '--', '.brain']).trim() || !previous && present(path.join(cwd, '.brain'))) throw Error('adopt refuses tracked, foreign or conflicting .brain paths');
  const existingRecord = previous?.record ?? findOrgDir({ cwd, env: { ...env, ORG_DIR: undefined } });
  if (env.ORG_DIR && existingRecord && canonicalPath(path.resolve(cwd, env.ORG_DIR)) !== canonicalPath(existingRecord)) throw Error('adopt held: ambient ORG_DIR differs from the existing owning record');
  const selectedRecord = existingRecord ?? findOrgDir({ cwd, env });
  if (!selectedRecord) throw Error('adopt requires an existing project record or an explicitly initialized new project record');
  const record = fs.realpathSync(selectedRecord);
  env = { ...env, ORG_DIR: record };
  auditEvents(record);
  const release = acquireControllerLease(project.identity);
  const heldConfigLocks = [];
  const ownedObserver = !observer;
  observer ??= createHerdrObserver({ socketPath: herdrSocketPath(env) });
  try {
    const inspection = inspect({ cwd, env }), observation = await observer.observe();
    const facts = readSessionFacts({ project: inspection.project, env });
    compatibleWriters(project, facts);
    const callerAgent = observation.agents.find(a => a.name === env.HERDR_AGENT_NAME && a.pane_id === env.HERDR_PANE_ID && a.workspace_id === env.HERDR_WORKSPACE_ID);
    const caller = callerAgent && agentBinding(callerAgent, observation.server, callerAgent.tab_id);
    let scope;
    if (scopeFile) {
      scope = readConfigJSON(scopeFile);
      if (path.resolve(scopeFile) !== path.join(project.identity, 'config-home/scopes', `${digest(scope)}.json`)) throw Error('adopt requires its canonical saved scope file');
      const boundRouting = scope.migration?.sources?.routing?.path;
      if (routing !== undefined && path.resolve(project.canonical, routing) !== boundRouting) throw Error('adopt routing argument conflicts with the saved scope');
      routing = boundRouting;
    }
    const inputs = previous ? null : inventory(project, boundary, routing, env);
    if (scopeFile) {
      const observed = adoptionScope({ inspection, observation, record, identity: owner.name,
        selections: scope.slots.map(s => ({ uid: s.uid, tab: s.slot.tab, panes: Object.fromEntries(s.members.map(m => [m.paneSlot, m.binding.pane])) })),
        caller, requester: scope.requester, expiresAt: scope.expiresAt, facts,
        now: previous?.adoption.completed ? () => Date.parse(scope.expiresAt) - 1 : now });
      if (digest({ ...observed, migration: scope.migration }) !== digest(scope)) throw Error('native binding, desired state, caller or record differs from saved adoption scope');
      if (inputs && digest({ sources: inputs.sources, defaults: inputs.defaults, origins: inputs.origins, worktrees: worktrees(project, boundary, inputs, env) }) !== digest(scope.migration)) throw Error('detected migration changed since owner scope capture');
    } else {
      const supervisor = inspection.entries.find(e => e.manifest.spec.role === 'supervisor');
      if (!supervisor || !caller) throw Error('adopt scope requires the native owning supervisor invocation');
      scope = adoptionScope({ inspection, observation, record, identity: owner.name,
        selections: [{ uid: supervisor.manifest.metadata.uid, tab: caller.tab }], caller, requester, expiresAt, facts, now });
      scope.migration = inputs ? { sources: inputs.sources, defaults: inputs.defaults, origins: inputs.origins, worktrees: worktrees(project, boundary, inputs, env) } : readConfigJSON(previous.adoption.scope_file).migration;
      scopeFile = path.join(project.identity, 'config-home/scopes', `${digest(scope)}.json`);
      if (!present(scopeFile)) durableWrite(scopeFile, scope);
    }
    if (inspectOnly) return { scopeFile, scope, migration: inputs?.sources ?? previous.sources, warnings, native_actions: [] };
    if (previous && digest(scope) !== previous.adoption.scope_sha256) throw Error('adoption held: saved scope differs from the original binding; owner disposition required');
    const operation = `adopt-${digest(scope).slice(0, 32)}`;
    if (!decision && !previous?.adoption.authorization) throw Error('adopt requires the affirmative workspace owner answer ID:SEQ for its exact saved scope');
    const authorization = authorizeAdoption(scope, decision ?? previous?.adoption.authorization, { now, expiredReadback: Boolean(previous?.adoption.completed) });
    if (previous?.adoption.completed) {
      const journal = readControllerJournal(project.identity), enrollment = readStandardSlots(project.identity);
      if (journal.operations.some(op => op.state !== 'acknowledged')) throw Error('adoption held: pending controller operation; completed adoption cannot clear it');
      const plan = planSessions({ inspection, enrollment, observation, facts, journal });
      if (enrollment.errors.length || scope.slots.flatMap(s => s.members).some(m => plan.decisions.find(d => d.uid === m.uid)?.decision !== 'KEEP')) throw Error('adoption held: completed native enrollment no longer reads back as KEEP');
      return { adopted: true, unchanged: true, home: area, warnings, native_actions: [] };
    }
    const { requireHomeRelease } = await import('./releases.mjs');
    const pin = previous ? readProjectPolicy(cwd, 'pin', env).config : inputs.bytes.pin ? parsePolicyBytes(inputs.bytes.pin, 'pin', inputs.sources.pin.path) : {};
    const compatible = requireHomeRelease(pin.release ?? null, previous, installationHome);
    const compatibleRelease = { config_home: 1, commit: compatible.commit, root: compatible.root };
    const defaults = previous?.defaults ?? { ...inputs.defaults, identity_root: owner.root,
      ...(inputs.parent ? { defaults_origin: { path: inputs.parent, base: path.dirname(inputs.parent), keys: inputs.origins } } : {}) };
    if (present(identityFile) && digest(readConfigJSON(identityFile)) !== digest(defaults)) throw Error('existing identity defaults differ; owner must resolve the conflict');
    // Validate and freeze everything before publishing a destination or link.
    const identityRecord = path.join(path.dirname(area), '.org');
    plainDirectory(path.dirname(area));
    const identityLock = path.join(path.dirname(area), '.config.lock'); fs.mkdirSync(identityLock); heldConfigLocks.push(identityLock);
    if (!present(path.join(identityRecord, 'events.jsonl'))) initOrg(identityRecord);
    if (present(identityFile) && digest(readConfigJSON(identityFile)) !== digest(defaults)) throw Error('identity defaults changed under the config lock');
    publishConfigBaseline({ file: identityFile, value: defaults, bytes: present(identityFile) ? readPlainFile(identityFile, null) : JSON.stringify(defaults, null, 2) + '\n', record: identityRecord, scope: 'identity', operation: `${operation}:identity`, cwd, env, who: scope.requester });
    let binding = previous ? { ...readConfigJSON(previous.file), compatible_release: compatibleRelease } : { schema: 'config-home-project/v1', identity: owner.name, project: selectedName, common: project.identity, checkout: project.canonical,
      record, worktrees: worktrees(project, boundary, inputs, env), sources: inputs.sources, published: [],
      adoption: { id: operation, scope_file: scopeFile, scope_sha256: digest(scope), authorization }, compatible_release: compatibleRelease };
    const file = path.join(area, 'project.json');
    if (!previous) {
      const staging = path.join(path.dirname(area), `.project-${operation}`);
      plainDirectory(staging);
      const staged = path.join(staging, 'project.json');
      if (present(staged) && digest(readConfigJSON(staged)) !== digest(binding)) throw Error('staged project publication differs from frozen adoption');
      if (!present(staged)) durableWrite(staged, binding);
      const stagedLock = path.join(staging, '.config.lock'); fs.mkdirSync(stagedLock); heldConfigLocks.push(stagedLock);
      fs.renameSync(staging, area);
      heldConfigLocks[heldConfigLocks.length - 1] = path.join(area, '.config.lock');
    } else {
      const configLock = path.join(area, '.config.lock'); fs.mkdirSync(configLock); heldConfigLocks.push(configLock);
      if (digest(previous.compatible_release) !== digest(compatibleRelease)) durableWrite(file, binding);
    }
    for (const [kind, source] of Object.entries(binding.sources)) {
      if (!source.present) continue;
      const target = path.join(area, POLICY_FILES[kind][0]);
      const bytes = readPlainFile(source.path, null);
      if (contentDigest(bytes) !== source.sha256) throw Error(`${source.path}: adoption source changed since frozen inventory`);
      const value = parsePolicyBytes(bytes, kind, source.path);
      publishConfigBaseline({ file: target, value, bytes, record, scope: 'project', operation: `${operation}:${kind}`, cwd, env, who: scope.requester });
      if (!binding.published.includes(kind)) { binding.published.push(kind); durableWrite(file, binding); }
      afterPublish?.(kind);
    }
    linkHome(project, area);
    const fresh = await observer.observe();
    const reread = adoptionScope({ inspection: inspect({ cwd, env }), observation: fresh, record, identity: owner.name,
      selections: scope.slots.map(s => ({ uid: s.uid, tab: s.slot.tab, panes: Object.fromEntries(s.members.map(m => [m.paneSlot, m.binding.pane])) })),
      caller, requester: scope.requester, expiresAt: scope.expiresAt, facts: readSessionFacts({ project: inspection.project, env }), now });
    if (digest({ ...reread, migration: scope.migration }) !== digest(scope)) throw Error('adoption scope changed before enrollment; retain partial evidence');
    const native = enrollObserved({ scope, authorization, adoptionId: operation, actor: writer(env).actor, afterIntent, afterKeep });
    for (const kind of Object.keys(binding.sources)) readProjectPolicy(cwd, kind, env);
    const enrolled = readStandardSlots(project.identity), plan = planSessions({ inspection, enrollment: enrolled, observation: fresh, facts, journal: readControllerJournal(project.identity) });
    if (scope.slots.flatMap(s => s.members).some(m => plan.decisions.find(d => d.uid === m.uid)?.decision !== 'KEEP')) throw Error('adoption read-back did not KEEP every selected native binding');
    const result = transact(record, events => ({ add: events.some(e => e.type === 'config.adopted' && e.operation === operation) ? [] : [{ type: 'config.adopted', operation, binding: file, scope: scopeFile,
      scope_sha256: digest(scope), authorization, native, sources: binding.sources, compatible_release: binding.compatible_release }] }), { actor: writer(env).actor });
    binding = { ...binding, adoption: { ...binding.adoption, completed: result.added[0]?.seq ?? auditEvents(record).find(e => e.type === 'config.adopted' && e.operation === operation).seq } };
    durableWrite(file, binding);
    return { adopted: true, unchanged: false, home: area, native, warnings: configDrift(homeProject(cwd, env)).map(d => d.warning), native_actions: [] };
  } finally { for (const lock of heldConfigLocks.reverse()) fs.rmdirSync(lock); if (ownedObserver) observer.close(); release(); }
}
export async function adoptCommand(argv, options = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { inspect: { type: 'boolean' }, json: { type: 'boolean' }, name: { type: 'string' }, routing: { type: 'string' }, scope: { type: 'string' }, decision: { type: 'string' }, expires: { type: 'string' } } });
  if (positionals.length !== 1) throw Error('usage: record adopt PROJECT [--inspect --expires DATE | --scope FILE --decision ID:SEQ] [--name NAME] [--routing FILE]');
  const warned = new Set();
  for (const d of configDrift(homeProject(options.cwd ?? process.cwd(), options.env ?? process.env))) { process.stderr.write(`${d.warning}\n`); warned.add(d.warning); }
  const match = values.decision?.match(/^([A-Z][A-Z0-9]*-[1-9]\d*):([1-9]\d*)$/u);
  if (values.decision && !match) throw Error('decision must be the human answer ID:SEQ');
  const result = await adopt({ ...options, project: positionals[0], name: values.name, routing: values.routing, inspectOnly: values.inspect, scopeFile: values.scope,
    decision: match ? { id: match[1], seq: Number(match[2]) } : undefined, expiresAt: values.expires });
  for (const warning of result.warnings ?? []) if (!warned.has(warning)) process.stderr.write(`${warning}\n`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}
