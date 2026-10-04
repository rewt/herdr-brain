// Minimal reads project facts; explicit row activation controls one live pane.
import fs from 'node:fs';
import React from 'react';
import { supervisorStatus } from '../../supervisor/status.mjs';
import { herdrAgents, herdrList, orgStatus } from '../lib/cli.mjs';
import { createSessionReader } from '../lib/sources.mjs';
import { catalog, createIdentityReader, workspaceIdentity } from './model.mjs';
import { minimalRows, minimalTree } from './minimal.mjs';
import { SessionView, inkFrame } from './minimal-view.mjs';
import { controlTerminal, splitInput } from './control.mjs';
import { createFeedReader, reportFeed } from './feed.mjs';

export function createMinimalSession({ config, projectIndex = 0, deps = {}, onChange = () => {}, env = process.env }) {
  const reader = createSessionReader(), feed = createFeedReader();
  const d = { herdrAgents, herdrList, orgStatus, controlTerminal, identity: createIdentityReader(), now: Date.now,
    journal: feed.journal, train: feed.train,
    runs: (project, agents, now) => supervisorStatus({ cwd: project.root ?? project.cwd, org: project.org, agents, now: new Date(now).toISOString() }),
    details(agent, run, project) {
      const lane = reader.laneSession({ repoRoot: project.root, name: agent.name, sessionId: agent.session });
      const transcript = /claude/i.test(agent.tool ?? '') ? reader.transcript({ configDirs: project.claude_config_dirs ?? [], cwd: agent.cwd, id: agent.session }) : null;
      let dispatch = null;
      if (run?.meta?.dispatch_journal) { try { dispatch = JSON.parse(fs.readFileSync(run.meta.dispatch_journal, 'utf8')); } catch {} }
      return { lane, transcript, dispatch };
    }, ...deps };
  const ui = { appearance: env.HERDR_CONSOLE_THEME === 'light' ? 'light' : 'dark', errors: {}, loading: true, stopped: false,
    view: 'table', focus: null, interactive: false, active: null, terminalFrame: null, outputError: null, message: '' };
  const data = { agents: [], workspaces: [], panes: [], tabs: [], status: null, runs: null, rawAgents: [], journal: [], train: {} };
  let project = null, pending = null, timer = null, controller = null, epoch = 0, lastView = null, controlSize = null;
  let facts = new Map();
  const own = a => Boolean(a && project?.repoKey && d.identity(a.cwd)?.key === project.repoKey && (a.tool || a.session));
  const target = a => own(a) ? { pane: a.pane, name: a.name, session: a.session, tab: a.tab, cwd: a.cwd } : null;
  const same = (a, b) => a?.pane === b?.pane && a?.name === b?.name && a?.session === b?.session && a?.tab === b?.tab && own(a);
  const model = () => {
    const sessions = minimalRows({ ...data, project, identity: d.identity, details: a => facts.get(a.pane), now: d.now() });
    const runs = (data.runs?.lanes ?? []).map(r => {
      const recorded = data.status?.runs?.find(run => run.id === r.run);
      const live = data.agents.find(a => a.pane === r.pane && a.name === r.agent &&
        (!recorded?.meta?.agent_session_id || recorded.meta.agent_session_id === a.session));
      return { ...r, target: target(live ?? data.agents.find(a => sessions.some(s => s.pane === a.pane && s.run === r.run))) };
    });
    const byRun = id => runs.find(r => r.run === id)?.target ?? target(data.agents.find(a => sessions.some(s => s.run === id && s.pane === a.pane)));
    const byJob = j => byRun(j.run) ?? runs.find(r => r.lane === j.topic)?.target;
    const train = { ...data.train, waiting: data.train.waiting?.map(j => ({ ...j, target: byJob(j) })),
      results: data.train.results?.map(j => ({ ...j, target: byJob(j) })) };
    if (train.current) {
      const members = train.current.lanes.map(topic => ({ topic, target: byJob({ topic }) }));
      train.current = { ...train.current, members: members.length > 1 ? members : [], target: members.length === 1 ? members[0].target : null };
    }
    return { sessions, runs, reports: reportFeed(data.status, data.journal).map(r => ({ ...r, target: byRun(r.run) })), train };
  };
  const changed = () => { if (!ui.stopped) onChange(); };
  function release() { epoch++; controller?.stop(); controller = null; controlSize = null; ui.interactive = false; }
  function back() { release(); Object.assign(ui, { view: 'table', active: null, terminalFrame: null, outputError: null }); changed(); return false; }
  function view(cols, rows) {
    if (ui.view === 'output') {
      const tree = React.createElement(SessionView, { state: ui, cols, rows, noColor: Boolean(env.NO_COLOR) });
      ui.screenViewport = { cols: Math.max(1, Math.min(cols, 400)), rows: Math.max(1, Math.min(160, rows - 2 - Number(Boolean(ui.outputError)))) };
      const size = `${ui.screenViewport.cols}x${ui.screenViewport.rows}`;
      if (controller && controlSize !== size) { controller.resize?.(ui.screenViewport.cols, ui.screenViewport.rows); controlSize = size; }
      return { tree, hits: [[{ id: 'back', from: 0, to: Math.min(13, cols) }]], controls: [{ id: 'back' }] };
    }
    const result = minimalTree({ project, ...model(), ...ui, selected: ui.focus, now: d.now() }, cols, rows, { noColor: Boolean(env.NO_COLOR) });
    lastView = result;
    return result;
  }
  async function activate(id) {
    if (id === 'back') return back();
    if (ui.view !== 'table') return false;
    const row = lastView?.groups.flat().find(r => r.id === id);
    if (!row) return false;
    ui.focus = id;
    if (d.allowSessionInput === false) return false;
    if (!row.target) { ui.message = 'No live session for this row'; changed(); return false; }
    const selected = row.target, generation = ++epoch;
    try {
      const fresh = await d.herdrAgents();
      if (ui.stopped || generation !== epoch || ui.focus !== id || ui.view !== 'table') return false;
      if (!fresh.ok || !fresh.agents.some(a => same(a, selected))) throw Error('Session changed · refresh and select it again');
      release(); const current = epoch;
      Object.assign(ui, { view: 'output', active: selected, pane: selected.pane, interactive: true, terminalFrame: null, outputError: null, message: '' });
      const size = { cols: Math.max(1, Math.min(lastView?.width ?? 80, 400)), rows: Math.max(1, Math.min((lastView?.rows ?? 24) - 2, 160)) };
      controlSize = `${size.cols}x${size.rows}`;
      const live = () => !ui.stopped && ui.view === 'output' && epoch === current;
      const next = d.controlTerminal({ pane: selected.pane, ...size,
        onFrame(frame) { if (live()) { ui.terminalFrame = frame; changed(); } },
        onError(error) { if (live()) { release(); ui.outputError = String(error); changed(); } },
        onClose(reason) { if (live()) { release(); ui.outputError = `Session released · ${reason}`; changed(); } },
      });
      if (live()) controller = next;
      else next?.stop();
      changed();
    } catch (error) {
      if (ui.view === 'output') { release(); ui.outputError = error.message; }
      else ui.message = error.message;
      changed();
    }
    return false;
  }
  async function refresh() {
    if (pending) return pending;
    pending = (async () => {
      const read = async (key, fn) => {
        try { const value = await fn(); if (ui.stopped) return; data[key] = value; delete ui.errors[key]; }
        catch (e) { if (!ui.stopped) ui.errors[key] = e.message; }
      };
      await Promise.all([
        read('agents', async () => {
          const r = await d.herdrAgents();
          if (!r.ok) throw Error(r.error);
          data.rawAgents = r.rawAgents ?? r.agents.map(a => ({ name: a.name, cwd: a.cwd, agent: a.tool, model: a.model,
            agent_status: a.status, pane_id: a.pane, workspace_id: a.workspace, agent_session: { value: a.session } }));
          return r.agents;
        }),
        ...['workspace', 'pane', 'tab'].map(resource => read(`${resource}s`, () => d.herdrList(resource))),
      ]);
      if (ui.stopped) return;
      const projects = catalog(config.projects, data.workspaces, d.identity, [], data.agents);
      const selected = config.projects[projectIndex];
      const current = data.workspaces.find(w => w.workspace_id === env.HERDR_WORKSPACE_ID);
      const currentKey = current && workspaceIdentity(current, d.identity)?.key;
      const selectedKey = selected && (selected.identity ?? d.identity(selected.cwd)?.key);
      const nextProject = selected ? projects.find(p => p.id === (selected.id ?? `configured:${selected.name}`) && p.repoKey === selectedKey)
        : projects.find(p => p.repoKey === currentKey) ?? projects[0] ?? null;
      if (project?.repoKey !== nextProject?.repoKey || project?.org !== nextProject?.org) {
        if (ui.view === 'output') back();
        data.status = null; data.runs = null; data.journal = []; data.train = {}; facts = new Map();
        for (const source of ['status', 'runs', 'journal', 'train']) delete ui.errors[source];
      }
      project = nextProject ?? null;
      await Promise.all([
        project?.org ? read('status', () => d.orgStatus(project)) : Promise.resolve().then(() => { data.status = null; delete ui.errors.status; }),
        project?.org && project?.git ? read('runs', () => d.runs(project, data.rawAgents, d.now())) : Promise.resolve().then(() => { data.runs = null; delete ui.errors.runs; }),
        read('journal', () => d.journal(project)),
        read('train', () => d.train(project)),
      ]);
      if (ui.stopped) return;
      const nextFacts = new Map();
      minimalRows({ ...data, project, identity: d.identity, now: d.now(), details(a, r) {
        const value = d.details(a, r, project);
        nextFacts.set(a.pane, value);
        return value;
      } });
      facts = nextFacts;
      if (ui.view === 'output' && (ui.errors.agents || !data.agents.some(a => same(a, ui.active)))) {
        release(); ui.outputError = 'Session changed or unavailable · Esc back';
      }
      const all = model();
      const ids = [...all.runs.map(r => `run:${r.run}`), ...all.reports.map(r => `report:${r.id ?? r.run}`)];
      if (!ui.focus) ui.focus = ids[0] ?? null;
      ui.loading = false;
      if (!ui.stopped) onChange();
    })().finally(() => { pending = null; });
    return pending;
  }
  return {
    refresh, activate,
    async start() { timer = setInterval(() => refresh().catch(e => { ui.errors.sessions = e.message; changed(); }), config.refresh_seconds * 1000); return refresh(); },
    stop() { ui.stopped = true; release(); clearInterval(timer); },
    async key(input, key = {}) {
      if (ui.view === 'output') {
        if (key.escape || input === '\x1b' || (key.ctrl && input === ']')) return back();
        if (key.ctrl && input === '\\') controller?.input(Buffer.from('\x1b'));
        return false;
      }
      if (input === 'q' || (input === 'c' && key.ctrl)) return true;
      if (key.escape) { epoch++; return false; }
      const entries = lastView?.groups.flat() ?? [];
      if (key.upArrow || key.downArrow || key.tab || input === 'j' || input === 'k') {
        const index = entries.findIndex(r => r.id === ui.focus), step = key.upArrow || input === 'k' || (key.tab && key.shift) ? -1 : 1;
        ui.focus = entries[Math.max(0, Math.min(entries.length - 1, index + step))]?.id ?? null;
        epoch++; ui.message = ''; changed();
      }
      if (key.return) return activate(ui.focus);
      return false;
    },
    async mouse(event) {
      if (event.button === 'back') return back();
      if (ui.view === 'output') {
        if (event.button === 'left' && event.y === 0 && event.x < 13) return back();
        if (event.button === 'wheelUp' || event.button === 'wheelDown') controller?.scroll?.(event.button === 'wheelUp' ? 'up' : 'down', 3);
        return false;
      }
      if (event.button === 'left') {
        const hit = lastView?.hits[event.y]?.find(h => event.x >= h.from && event.x < h.to);
        if (hit) return activate(hit.id);
      }
      return false;
    },
    async input(data) {
      if (ui.view !== 'output' || !ui.interactive) return false;
      const { back: returnKey, bytes } = splitInput(data);
      const text = bytes.toString('latin1');
      let forwarded = '', leave = returnKey;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '\x1c') { if (forwarded) controller?.input(Buffer.from(forwarded, 'latin1')); forwarded = ''; controller?.input(Buffer.from('\x1b')); }
        else if (text[i] === '\x1b') {
          // Preserve arrows/function keys; a bare or partial Esc always returns.
          const sequence = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1bO[ -~])/.exec(text.slice(i))?.[0];
          if (/^\x1b\[27(?:;[\d:]+)*u$|^\x1b\[27;\d+;27~$|^\x1b\[93;5(?::[12])?u$/.test(sequence ?? '')) { leave = true; break; }
          if (/^\x1b\[(?:28(?:;1)?|92;5(?::[12])?)u$/.test(sequence ?? '')) {
            if (forwarded) controller?.input(Buffer.from(forwarded, 'latin1'));
            forwarded = ''; controller?.input(Buffer.from('\x1b')); i += sequence.length - 1;
          }
          else if (sequence) { forwarded += sequence; i += sequence.length - 1; }
          else { leave = true; break; }
        } else forwarded += text[i];
      }
      if (forwarded) controller?.input(Buffer.from(forwarded, 'latin1'));
      if (leave) back();
      return true;
    },
    tree(cols, rows) { return view(cols, rows).tree; },
    frame(cols, rows) {
      const result = view(cols, rows);
      return inkFrame(result.tree, cols, rows, { hits: result.hits, controls: result.controls });
    },
    get ui() { return ui; }, set ui(value) { Object.assign(ui, value); },
    get project() { return project; }, get model() { return model(); },
  };
}
