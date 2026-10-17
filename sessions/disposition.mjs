// Explicit supervisor disposition only. No native input, launch or retry here.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPlainFile } from '../lib/files.mjs';
import { herdrSocketPath } from '../lanes/board/herdr-client.mjs';
import { canonicalProject } from './project.mjs';
import { parseUniqueJson } from './json.mjs';
import { checkAuthorization, enrolledWorkspace } from './authorization.mjs';
import { readStandardSlots } from './receipts.mjs';
import { readSessionFacts } from './observe.mjs';
import { herdrEdge, readAdapterReceipts, safeStandard } from './live.mjs';
import { digest, validStartDisposition } from './lifecycle-evidence.mjs';
import { acquireControllerLease, durableWrite, present, readControllerJournal, runtimePaths } from './runtime.mjs';

export function disposeStart({ cwd = process.cwd(), workspace, authorization, operationId, dispositionFile,
  role, actor, env = process.env, now = Date.now } = {}) {
  if (role !== 'supervisor' || !actor?.trim()) throw Error('explicit supervisor role and actor required');
  if (!workspace) throw Error('explicit workspace required');
  const project = canonicalProject(cwd), bound = enrolledWorkspace(project, workspace);
  if (fs.realpathSync(cwd) !== project.root) throw Error('dispose-start requires the canonical checkout');
  const check = () => {
    const auth = checkAuthorization({ file: authorization, project, workspace, action: { kind: 'start-standard-slot' }, env, now });
    if (auth.actor !== actor || herdrSocketPath(env) !== bound.server) throw Error('supervisor actor or physical endpoint changed');
    const facts = readSessionFacts({ project, env });
    if (facts.stopped || facts.closeHold || facts.errors.length) throw Error('STOP, close hold or unreadable facts; disposition refused');
  };
  check();
  const release = acquireControllerLease(project.common);
  try {
    const journal = readControllerJournal(project.common), op = journal.operations.find(op => op.id === operationId);
    if (!op || op.kind !== 'start-standard-slot' || op.state !== 'intent' || op.receipt) throw Error('exact unresolved start intent required');
    safeStandard(op);
    if (op.spec.viewer || !['chat', 'supervisor'].includes(op.spec.role)) throw Error('only native conversation starts can be disposed');
    const d = parseUniqueJson(readPlainFile(dispositionFile));
    if (!validStartDisposition(op, d) || d.common !== project.common || d.actor !== actor ||
        ['server', 'workspace', 'checkout'].some(k => d.target[k] !== bound[k])) throw Error('invalid or mismatched never-started evidence');
    const verify = () => {
      check();
      const age = now() - Date.parse(d.observedAt);
      if (age < 0 || age > 60000) throw Error('never-started evidence is stale');
      if (digest(parseUniqueJson(readPlainFile(dispositionFile))) !== digest(d)) throw Error('disposition evidence changed');
      for (const e of d.evidence) if (createHash('sha256').update(readPlainFile(e.file)).digest('hex') !== e.sha256)
        throw Error('disposition source hash changed');
      if (readAdapterReceipts(project.common).some(r => r.operationId === op.id) || journal.bindings.some(b => b.uid === op.uid) ||
          journal.operations.some(other => other.id !== op.id && other.state !== 'never-started' &&
            (other.uid === op.uid || other.target?.pane === op.target.pane)) ||
          present(path.join(project.common, 'sessions/contexts', `${op.id}.json`))) throw Error('launch evidence or competing operation exists; hold');
    };
    const herdr = herdrEdge(env);
    const observe = () => {
      verify();
      const workspaces = herdr(['workspace', 'list']).workspaces,
        tabs = herdr(['tab', 'list', '--workspace', bound.workspace]).tabs,
        panes = herdr(['pane', 'list', '--workspace', bound.workspace]).panes,
        agents = herdr(['agent', 'list']).agents;
      if (![workspaces, tabs, panes, agents].every(Array.isArray)) throw Error('incomplete disposition observation');
      const slots = readStandardSlots(project.common), t = d.target;
      const slot = slots.slots.filter(s => s.workspace === t.workspace && s.server === t.server && s.checkout === t.checkout &&
        s.tab === t.tab && s.standardSlot === op.spec.standardSlot && s.panes.length === 1 && s.panes[0].pane === t.pane);
      const ws = workspaces.filter(w => w.workspace_id === t.workspace), ts = tabs.filter(tab => tab.tab_id === t.tab),
        ps = panes.filter(p => p.tab_id === t.tab || p.pane_id === t.pane), p = ps[0];
      const name = `slot-${createHash('sha256').update(op.id).digest('hex').slice(0, 24)}`;
      if (slots.errors.length || slot.length !== 1 || ws.length !== 1 || ws[0].worktree?.repo_key !== project.common ||
          ws[0].worktree.checkout_path !== t.checkout || ts.length !== 1 || ts[0].workspace_id !== t.workspace || ps.length !== 1 ||
          !p || p.pane_id !== t.pane || p.tab_id !== t.tab || p.workspace_id !== t.workspace || p.terminal_id !== t.terminalId ||
          agents.some(a => a.pane_id === t.pane || a.terminal_id === t.terminalId || a.name === name)) throw Error('changed topology or agent present; hold');
      const first = herdr(['pane', 'get', t.pane]).pane,
        info = herdr(['pane', 'process-info', '--pane', t.pane]).process_info,
        last = herdr(['pane', 'get', t.pane]).pane;
      if (!first || !last || digest(first) !== digest(last) ||
          ['pane_id', 'tab_id', 'workspace_id', 'terminal_id'].some(k => last[k] !== p[k]) ||
          [p, last].some(p => p.agent || p.agent_session != null || p.agent_session_id != null || p.launch_pending || p.restore_error || p.foreground_cwd !== t.checkout) ||
          !Number.isSafeInteger(info?.shell_pid) || info.shell_pid < 1 || info.foreground_processes?.length !== 1 ||
          info.foreground_processes[0].pid !== info.shell_pid) throw Error('sole shell, session absence or launch state is uncertain; hold');
      return { workspaces, tabs, panes, agents, info };
    };
    const first = observe(), last = observe();
    if (digest(first) !== digest(last)) throw Error('disposition observation changed; hold');
    verify();
    op.state = 'never-started';
    op.disposition = { request: d, recordedAt: new Date(now()).toISOString(), observationDigest: digest(last) };
    durableWrite(runtimePaths(project.common).journal, journal);
    // Status is a disposable projection; the next plan/apply derives it anew.
    return { operationId: op.id, state: op.state, disposition: op.disposition };
  } finally { release(); }
}
