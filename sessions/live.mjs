// The live action seam. All Herdr CLI calls go through herdr-edge; launch argv
// and shell readiness stay with supervisor/chats. No retries, timers or loops.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { herdrSocketPath } from '../lanes/board/herdr-client.mjs';
import { invokeHerdr } from '../supervisor/herdr-edge.mjs';
import { openStandardSession, openStandardViewer } from '../supervisor/chats.mjs';
import { entryPolicy } from '../discovery/policy.mjs';
import { coldStart, renderColdStart } from '../supervisor/context.mjs';
import { findOrgDir } from '../lib/store.mjs';
import { readPlainFile } from '../lib/files.mjs';
import { quote } from '../lib/shell.mjs';
import { transferSessionInbox } from '../messages/session-transfer.mjs';
import { parseUniqueJson } from './json.mjs';
import { durableWrite, readControllerJournal } from './runtime.mjs';
import { agentBinding } from './observe.mjs';
import { checkAuthorization } from './authorization.mjs';
import { safeProjectPath } from './project.mjs';
import { digest, equalBinding, validBinding, verifyHandoff, validCloseReceipt, validMaterializationReceipt, validInboxReceipt } from './lifecycle-evidence.mjs';

const product = fileURLToPath(new URL('../', import.meta.url));
const receiptFile = common => path.join(common, 'sessions/adapter-receipts.json');
const fail = reason => { throw Error(reason); };
export function herdrEdge(env = process.env) {
  return (args, options = {}) => {
    const stdout = invokeHerdr(env.HERDR_BIN_PATH || 'herdr', args, { env, ...options });
    if (args[0] === 'pane' && args[1] === 'read' && args.includes('text')) return { text: stdout };
    // invokeHerdr has already rejected errors and nonzero exit status.
    if (args[0] === 'pane' && args[1] === 'run' && !stdout.trim()) return {};
    const body = JSON.parse(stdout);
    if (body.ok === false || !body.result) throw Error('invalid Herdr result; inspect before retry');
    return body.result;
  };
}
export function readAdapterReceipts(common) {
  let saved;
  try { saved = parseUniqueJson(readPlainFile(receiptFile(common))); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  if (saved.schema !== 'session-adapter-receipts/v1' || saved.common !== common || !Array.isArray(saved.receipts) ||
      Object.keys(saved).some(k => !['schema', 'common', 'receipts'].includes(k))) throw Error('invalid adapter receipts');
  const journal = readControllerJournal(common), keys = new Set();
  for (const r of saved.receipts) {
    const op = journal.operations.find(o => o.id === r.operationId), key = `${r.operationId}:${r.kind ?? 'start'}`;
    if (!op || keys.has(key)) throw Error('unknown or duplicate adapter receipt');
    keys.add(key);
    const valid = r.kind === 'close' ? validCloseReceipt(op, r) : ['respawn', 'resume', 'native-restore'].includes(r.kind)
      ? validMaterializationReceipt(op, r) : r.kind === 'inbox' ? validInboxReceipt(op, r, op.receipt?.incarnations.map(i => i.id) ?? [])
      : op.kind === 'start-standard-slot' && r.uid === op.uid && r.generation === op.generation && r.specDigest === op.specDigest &&
        validBinding(r.binding, op.spec.viewer ? 'LogViewer' : 'Session') && ['server', 'workspace', 'tab', 'pane', 'checkout'].every(k => r.binding[k] === op.target[k]);
    if (!valid) throw Error('invalid adapter operation evidence');
  }
  return saved.receipts;
}
function saveReceipt(common, receipt) {
  const receipts = readAdapterReceipts(common);
  if (receipts.some(r => r.operationId === receipt.operationId && r.kind === receipt.kind)) throw Error('adapter receipt already exists; never repeat action');
  receipts.push(receipt);
  durableWrite(receiptFile(common), { schema: 'session-adapter-receipts/v1', common, receipts });
  return receipt;
}
export function safeStandard(op) {
  const specs = op.participants?.map(p => p.spec) ?? [op.spec];
  if (!specs.length || specs.some(s => !s || s.intent?.kind === 'work-item' ||
      !['chat', 'supervisor', 'logs'].includes(s.role) || !s.standardSlot || s.role === 'reviewer' ||
      (s.role === 'logs' && s.viewer !== 'brain-structured-events'))) throw Error('controller actions are restricted to supported standard slots; workers and triage are observation-only');
  if (specs.length !== 1) throw Error('multi-pane activation awaits the triage stage; keep the whole layout');
}
function workspace(o, project, b) {
  const rows = o.workspaces.filter(w => w.workspace_id === b.workspace);
  if (!o.complete || o.errors?.length || o.server !== b.server || rows.length !== 1 ||
      rows[0].worktree?.repo_key !== project.common || rows[0].worktree.checkout_path !== b.checkout) fail('exact workspace observation changed');
}
function layout(o, project, bindings, { absent = false, empty = false, quiet = false } = {}) {
  const b = bindings[0]; workspace(o, project, b);
  const tabs = o.tabs.filter(t => t.tab_id === b.tab), panes = o.panes.filter(p => p.tab_id === b.tab || bindings.some(b => b.pane === p.pane_id));
  if (absent) {
    if (tabs.length || panes.length || o.agents.some(a => a.tab_id === b.tab || bindings.some(b =>
      b.pane === a.pane_id || b.terminalId === a.terminal_id || b.nativeSessionId && b.nativeSessionId === (a.agent_session?.value ?? a.agent_session_id)))) fail('closed tab absence is uncertain');
    return;
  }
  if (tabs.length !== 1 || tabs[0].workspace_id !== b.workspace || panes.length !== bindings.length ||
      panes.some(p => p.workspace_id !== b.workspace || !bindings.some(b => b.pane === p.pane_id))) fail('multi-owner tab or changed exact layout');
  for (const b of bindings) {
    const pane = panes.find(p => p.pane_id === b.pane), agents = o.agents.filter(a => a.pane_id === b.pane);
    if (pane.terminal_id !== b.terminalId) fail('terminal identity changed');
    if (empty) {
      if (!pane.emptyConfirmed || agents.length || pane.agent || pane.agent_session?.value || pane.launch_pending || pane.restore_error) fail('pane is not confirmed empty');
    } else if (b.nativeSessionId) {
      if (agents.length !== 1 || !equalBinding(agentBinding(agents[0], o.server, b.tab), b) ||
          !(quiet ? ['idle', 'done'] : ['working', 'idle', 'done']).includes(agents[0].agent_status ?? agents[0].status)) fail('exact native occupant changed or is not ready');
    } else if (agents.length || !(o.viewers ?? []).some(v => equalBinding(v.binding, b))) fail('viewer identity changed');
  }
}
function materializeContext(project, spec, env, handoff) {
  if (spec.permissions.profileRef !== 'identity-default' || spec.memory.claudeMem?.mode === 'required') fail('native profile or required memory enforcement unavailable; hold');
  const org = findOrgDir({ cwd: project.root, env });
  if (!org) fail('project record required');
  const chunks = [entryPolicy({ canonical: project.root, org, role: spec.role }, product), spec.personality.instructions];
  if (spec.memory.claudeMem?.mode === 'optional') chunks.push('Optional claudeMem adapter disabled: native readiness was not verified.');
  for (const c of spec.context) {
    if (c.source === 'identity-instructions') continue; // Native harness owns identity instructions.
    if (c.source === 'supervisor-protocol') { chunks.push(readPlainFile(path.join(product, 'supervisor/PROTOCOL.md'))); continue; }
    if (c.source === 'project-cold-start') {
      chunks.push(renderColdStart(coldStart({ cwd: project.root, org, env,
        memory: { total: null, available: null, swap_used: null, warning: 'Host memory was not sampled during session materialization.' } }), { limit: c.limit ?? 6 })); continue;
    }
    if (['latest-chat-handoff', 'latest-supervisor-handoff'].includes(c.source) && handoff) continue;
    if (c.source === 'file' || c.source === 'product-file') {
      // inspect has validated containment; revalidate immediately before reading.
      const root = path.resolve(c.source === 'file' ? project.root : product);
      const target = safeProjectPath(root, c.path);
      try { chunks.push(readPlainFile(fs.realpathSync(target))); }
      catch (error) { if (c.required || error.code !== 'ENOENT') throw error; chunks.push(`Optional context missing: ${c.source}/${c.path}`); }
      continue;
    }
    if (c.required) fail(`context materializer unavailable for ${c.source}`);
  }
  if (handoff) {
    verifyHandoff(handoff);
    const markdown = readPlainFile(handoff.file);
    if (createHash('sha256').update(markdown).digest('hex') !== handoff.sha256) fail('handoff changed during materialization');
    chunks.push(`Verified handoff ${handoff.digest}\n${markdown}`);
  }
  const instructions = chunks.join('\n\n');
  if (Buffer.byteLength(instructions) > 256 * 1024) fail('materialized context exceeds 256 KiB; hold');
  return instructions;
}
export function createLiveActions({ project, workspace: workspaceRef, authorization, observe, permit: gate, env = process.env, herdr = herdrEdge(env),
  opener = openStandardSession, launchOptions = {}, inbox } = {}) {
  if (typeof gate !== 'function') throw Error('live adapters require the apply authorization gate');
  const permit = op => {
    const saved = readControllerJournal(project.common).operations.find(candidate => candidate.id === op.id);
    const supplied = structuredClone(op);
    delete supplied.target?.terminalId; // Private shell observation, not durable target identity.
    if (!saved || digest(saved) !== digest(supplied)) fail('adapter requires the exact durable journal intent');
    const action = op.kind === 'start-standard-slot' ? { kind: op.kind } : { kind: 'lifecycle', stage:
      ({ 'close-intent': 'close', 'respawn-intent': 'respawn', 'resume-intent': 'resume', 'inbox-intent': 'transfer' })[op.state] };
    const r = checkAuthorization({ file: authorization, project, workspace: workspaceRef, action, env });
    if (['server', 'workspace', 'checkout'].some(k => op.target[k] !== r.workspace[k])) fail('adapter target is outside authorization');
    return gate(op);
  };
  const before = async op => { safeStandard(op); await permit(op); return observe(); };
  const record = receipt => saveReceipt(project.common, receipt);
  const launch = (op, p, create, resume, shellTarget) => {
    const spec = p?.spec ?? op.spec, target = shellTarget ?? p?.binding ?? op.target;
    const instructions = spec.viewer ? null : materializeContext(project, spec, env, op.contextLoss ? op.request.handoff : null);
    if (spec.viewer) {
      if (create || resume) fail('viewer reconstruction needs its complete logs layout; hold');
      // Existing model-free viewer, one foreground render. No service or loop.
      const command = [process.execPath, path.join(product, 'logs/logs.mjs'), 'view', '--common-dir', project.common].map(quote).join(' ');
      return openStandardViewer({ ...launchOptions, target, command, herdr, beforeMutation: receipt => physicalPermit(op, receipt, create) });
    }
    const made = opener({ ...launchOptions, target, role: spec.role, record: findOrgDir({ cwd: project.root, env }), launch: spec.resolvedRoute,
      name: resume ? target.agentName : `slot-${createHash('sha256').update(op.id).digest('hex').slice(0, 24)}`,
      instructions, common: project.common, operationId: op.id,
      beforeMutation: receipt => physicalPermit(op, receipt, create), resume: resume ? target.nativeSessionId : undefined, create, env, herdr });
    return { ...made, instructionsSha256: createHash('sha256').update(instructions).digest('hex') };
  };
  function physicalObservation(op) {
    const server = herdrSocketPath(env);
    if (server !== op.target.server) fail('physical Herdr endpoint differs from operation');
    const workspaces = herdr(['workspace', 'list']).workspaces;
    const tabs = herdr(['tab', 'list', '--workspace', op.target.workspace]).tabs;
    const panes = herdr(['pane', 'list', '--workspace', op.target.workspace]).panes;
    const agents = herdr(['agent', 'list']).agents;
    if (![workspaces, tabs, panes, agents].every(Array.isArray)) fail('incomplete physical observation');
    for (const a of agents.filter(a => a.workspace_id === op.target.workspace)) {
      const fresh = herdr(['agent', 'get', a.name]).agent;
      if (!equalBinding(agentBinding(a, server, a.tab_id), agentBinding(fresh ?? {}, server, fresh?.tab_id))) fail('physical agent identity changed');
    }
    return { server, complete: true, workspaces, tabs, panes, agents, errors: [] };
  }
  function physicalPermit(op, receipt, create) {
    // Synchronous: no await separates these reads from the launch owner's input.
    permit(op);
    const o = physicalObservation(op);
    if (!receipt && create) { layout(o, project, op.participants.map(p => p.binding), { absent: true }); permit(op); return; }
    const b = { ...op.target, ...receipt, server: op.target.server, checkout: op.target.checkout };
    workspace(o, project, b);
    const pane = o.panes.find(p => p.pane_id === b.pane), process = herdr(['pane', 'process-info', '--pane', b.pane]).process_info;
    if (!pane || pane.tab_id !== b.tab || pane.workspace_id !== b.workspace || pane.terminal_id !== b.terminalId ||
        pane.foreground_cwd !== b.checkout || pane.agent || pane.launch_pending || pane.restore_error || pane.agent_session?.value ||
        o.agents.some(a => a.pane_id === b.pane || op.mode === 'resume' && (a.agent_session?.value ?? a.agent_session_id) === op.request.nativeSessionId) ||
        !Number.isSafeInteger(process?.shell_pid) || process.shell_pid < 1 || process.foreground_processes?.length !== 1 ||
        process.foreground_processes[0].pid !== process.shell_pid) fail('physical launch target changed or is not a sole shell');
    permit(op);
  }
  function saveContext(op, uid, generation, specDigest, route, binding, instructionsSha256) {
    if (!binding.nativeSessionId) return;
    durableWrite(path.join(project.common, 'sessions/contexts', `${op.id}.json`), { schema: 'session-native-context/v1',
      uid, generation, specDigest, nativeSessionId: binding.nativeSessionId, route, instructionsSha256 });
  }
  function launchedBinding(o, result, spec, target) {
    workspace(o, project, target);
    const panes = o.panes.filter(p => p.pane_id === result.pane), pane = panes[0];
    if (panes.length !== 1 || pane.workspace_id !== target.workspace || pane.tab_id !== result.tab || !pane.terminal_id) fail('launched pane identity uncertain');
    const agents = o.agents.filter(a => a.pane_id === result.pane);
    let b;
    if (spec.viewer) {
      if (agents.length || pane.terminal_id !== target.terminalId) fail('viewer pane changed');
      b = { server: o.server, workspace: target.workspace, checkout: target.checkout, tab: result.tab, pane: result.pane, terminalId: pane.terminal_id };
    } else {
      if (agents.length !== 1 || agents[0].name !== result.name || agents[0].agent !== spec.resolvedRoute.kind) fail('launched agent identity uncertain');
      b = agentBinding(agents[0], o.server, result.tab);
    }
    if (!validBinding(b, spec.viewer ? 'LogViewer' : 'Session') || b.checkout !== target.checkout) fail('incomplete launched binding');
    if (!spec.viewer) layout(o, project, [b]);
    return b;
  }
  return {
    async start(op) {
      const o = await before(op), pane = o.panes.find(p => p.pane_id === op.target.pane);
      const target = { ...op.target, terminalId: pane?.terminal_id };
      // logs may share the adopted tab; start only the proven empty viewer pane.
      if (op.spec.viewer) {
        workspace(o, project, target);
        if (!pane?.emptyConfirmed || o.agents.some(a => a.pane_id === target.pane)) fail('viewer target not empty');
      } else layout(o, project, [target], { empty: true });
      const made = launch({ ...op, target }, null, false, false), after = await observe();
      const binding = launchedBinding(after, made, op.spec, target);
      saveContext(op, op.uid, op.generation, op.specDigest, op.spec.resolvedRoute, binding, made.instructionsSha256);
      return record({ operationId: op.id, uid: op.uid, generation: op.generation, specDigest: op.specDigest, binding });
    },
    async close(op) {
      const o = await before(op), bindings = op.participants.map(p => p.binding);
      verifyHandoff(op.request.handoff); layout(o, project, bindings, { quiet: true });
      await permit(op); // authorization/STOP/hold rechecked at the physical edge.
      layout(physicalObservation(op), project, bindings, { quiet: true });
      permit(op);
      herdr(['tab', 'close', op.target.tab]);
      layout(await observe(), project, bindings, { absent: true });
      return record({ operationId: op.id, kind: 'close', uid: op.uid, target: op.target, bindings });
    },
    async respawn(op) {
      const o = await before(op), p = op.participants[0];
      verifyHandoff(op.request.handoff); layout(o, project, op.participants.map(p => p.binding), { absent: true });
      const made = launch(op, p, true, false), after = await observe();
      layout(after, project, op.participants.map(p => p.binding), { absent: true });
      const binding = launchedBinding(after, made, p.spec, p.binding);
      saveContext(op, p.uid, p.generation, p.specDigest, p.spec.resolvedRoute, binding, made.instructionsSha256);
      const receipt = materialization(op, p, binding, 'respawn');
      if (!validMaterializationReceipt(op, receipt)) fail('respawn is not a new exact incarnation');
      return record(receipt);
    },
    async resume(op) {
      const o = await before(op), p = op.participants[0];
      const losses = (o.losses ?? []).filter(l => equalBinding(l.binding, p.binding));
      if (losses.length !== 1 || losses[0].state !== 'confirmed-exit' || losses[0].processConfirmedGone !== true ||
          losses[0].restore?.state !== 'none' || !losses[0].backoffReady || losses[0].refused || losses[0].failures >= 2 ||
          op.request.nativeSessionId !== p.binding.nativeSessionId || !op.request.contextVerified) fail('confirmed exit or restore/context ownership changed');
      // The old process is gone, but the empty shell may have a new terminal.
      const pane = o.panes.find(x => x.pane_id === p.binding.pane);
      layout(o, project, [{ ...p.binding, terminalId: pane?.terminal_id, agentName: undefined, nativeSessionId: undefined }], { empty: true });
      const source = readControllerJournal(project.common).operations.find(source =>
        equalBinding(source.receipt?.binding, p.binding) || source.receipt?.incarnations?.some(i => equalBinding(i.binding, p.binding)));
      if (!source || op.request.contextRef !== path.join(project.common, 'sessions/contexts', `${source.id}.json`)) fail('known native context source is not the recorded launch owner');
      const context = parseUniqueJson(readPlainFile(op.request.contextRef));
      if (context.schema !== 'session-native-context/v1' || digest(context) !== op.contextHash || context.uid !== p.uid ||
          context.generation !== p.generation || context.specDigest !== p.specDigest || context.nativeSessionId !== p.binding.nativeSessionId ||
          digest(context.route) !== digest(p.spec.resolvedRoute) || !/^[a-f0-9]{64}$/u.test(context.instructionsSha256 ?? '')) fail('known native context receipt changed');
      const made = launch(op, p, false, true, { ...p.binding, terminalId: pane.terminal_id }), binding = launchedBinding(await observe(), made, p.spec, p.binding);
      saveContext(op, p.uid, p.generation, p.specDigest, p.spec.resolvedRoute, binding, made.instructionsSha256);
      const receipt = materialization(op, p, binding, 'resume');
      if (!validMaterializationReceipt(op, receipt)) fail('resume native reference or new process binding changed');
      return record(receipt);
    },
    async transfer(op) {
      await before(op);
      const incarnations = readControllerJournal(project.common).incarnations.filter(i => i.operationId === op.id);
      if (incarnations.length !== op.participants.length || !inbox?.root || !inbox.recipient) fail('stage-8 role inbox enrollment required');
      const next = incarnations[0].binding, previous = op.participants[0].binding;
      layout(await observe(), project, [next]);
      await transferSessionInbox({ ...inbox, common: project.common, uid: op.uid, role: op.participants[0].spec.role, operationId: op.id, previous, next,
        messageIds: op.request.pendingInboxIds, cursor: op.request.handoff.inboxCursor });
      layout(await observe(), project, [next]);
      return record({ operationId: op.id, kind: 'inbox', uid: op.uid, messageIds: op.request.pendingInboxIds,
        cursor: op.request.handoff.inboxCursor, incarnationIds: incarnations.map(i => i.id) });
    }
  };
}
function materialization(op, p, binding, kind) {
  return { operationId: op.id, kind, uid: op.uid, contextHash: op.contextHash, incarnations: [{ id: randomUUID(), uid: p.uid,
    generation: p.generation, specDigest: p.specDigest, previous: p.incarnation, binding, contextHash: op.contextHash,
    contextVerified: true, route: p.spec.resolvedRoute }] };
}
