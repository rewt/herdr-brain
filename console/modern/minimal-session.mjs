// Minimal reads project facts; explicit row activation controls one live pane.
import fs from 'node:fs';
import { supervisorStatus } from '../../supervisor/status.mjs';
import { herdrAgents, herdrList, herdrProjectChat, orgStatus } from '../lib/cli.mjs';
import { createSessionReader } from '../lib/sources.mjs';
import { catalog, createIdentityReader, workspaceIdentity } from './model.mjs';
import { minimalRows } from './minimal.mjs';
import { controlTerminal } from './control.mjs';
import { parseSessionInput } from './session-input.mjs';
import { createFeedReader, reportFeed } from './feed.mjs';
import { createDetailReader } from './details.mjs';
import { loadMinimalRenderer } from './minimal-renderer.mjs';

export function createMinimalSession({ config, projectIndex = 0, deps = {}, onChange = () => {}, env = process.env }) {
  const reader = createSessionReader(), feed = createFeedReader(), detail = createDetailReader();
  const d = { herdrAgents, herdrList, herdrProjectChat, orgStatus, controlTerminal, identity: createIdentityReader(), now: Date.now,
    journal: feed.journal, train: feed.train, document: detail.document,
    runs: (project, agents, now) => supervisorStatus({ cwd: project.root ?? project.cwd, org: project.org, agents, now: new Date(now).toISOString() }),
    details(agent, run, project) {
      const lane = reader.laneSession({ repoRoot: project.root, name: agent.name, sessionId: agent.session });
      const transcript = /claude/i.test(agent.tool ?? '') ? reader.transcript({ configDirs: project.claude_config_dirs ?? [], cwd: agent.cwd, id: agent.session }) : null;
      let dispatch = null;
      if (run?.meta?.dispatch_journal) { try { dispatch = JSON.parse(fs.readFileSync(run.meta.dispatch_journal, 'utf8')); } catch {} }
      return { lane, transcript, dispatch };
    }, ...deps };
  const ui = { appearance: env.HERDR_CONSOLE_THEME === 'light' ? 'light' : 'dark', errors: {}, loading: true, stopped: false,
    view: 'table', focus: null, panel: 0, selections: [], panelOffsets: [0, 0, 0],
    detail: null, document: null, detailScroll: 0, detailFocus: null, detailError: null,
    interactive: false, active: null, terminalFrame: null, outputError: null, message: '' };
  const data = { agents: [], workspaces: [], panes: [], tabs: [], status: null, runs: null, rawAgents: [], journal: [], train: {} };
  let project = null, pending = null, timer = null, controller = null, epoch = 0, lastView = null, lastDetail = null, controlSize = null;
  let viewport = { cols: 80, rows: 24 };
  let renderer;
  const prepare = async () => { renderer ??= await loadMinimalRenderer(); };
  const history = [];
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
      const occupant = live ?? data.agents.find(a => sessions.some(s => s.pane === a.pane && s.run === r.run));
      return { ...r, target: ['working', 'idle'].includes(occupant?.status) ? target(occupant) : null };
    });
    return { sessions: sessions.map(s => ({ ...s, target: target(data.agents.find(a => a.pane === s.pane)) })),
      runs, reports: reportFeed(data.status, data.journal), train: data.train };
  };
  const snapshot = () => ({ view: ui.view, focus: ui.focus, panel: ui.panel, selections: [...ui.selections], panelOffsets: [...ui.panelOffsets],
    detail: ui.detail, document: ui.document, detailScroll: ui.detailScroll, detailFocus: ui.detailFocus, detailError: ui.detailError });
  const detailFacts = () => ({ project, status: data.status, journal: data.journal, ...model(), now: d.now() });
  async function readDetail() {
    const descriptor = ui.detail, generation = epoch;
    try {
      const document = await d.document(descriptor, detailFacts());
      if (ui.stopped || ui.view !== 'detail' || ui.detail !== descriptor || generation !== epoch) return;
      ui.document = document;
      ui.detailError = ['status', 'journal', 'train'].filter(source => ui.errors[source]).map(source => `${source} unavailable · last known data`).join('; ') || null;
      if (document.list && !ui.detailFocus) ui.detailFocus = document.sections.flatMap(s => s.entries ?? [])[0]?.id;
      if (!ui.detailFocus && document.sections[0]?.pipeline) ui.detailFocus = document.sections[0].pipeline[0]?.id;
    }
    catch (e) { if (ui.stopped || ui.view !== 'detail' || ui.detail !== descriptor || generation !== epoch) return;
      ui.detailError = e.message; ui.document ??= { title: `${ui.detail.kind} · ${ui.detail.run ?? ui.detail.batch ?? ''}`,
      sections: [{ id: 'error', title: 'Source unavailable', content: e.message }] }; }
  }
  const changed = () => { if (!ui.stopped) onChange(); };
  function release() { epoch++; controller?.stop(); controller = null; controlSize = null; ui.interactive = false; }
  function back() { release(); Object.assign(ui, history.pop() ?? { view: 'table' }, { active: null, terminalFrame: null, outputError: null }); changed(); return false; }
  function view(cols, rows) {
    viewport = { cols, rows };
    if (ui.view === 'output') {
      const tree = renderer.sessionTree({ state: ui, cols, rows, noColor: Boolean(env.NO_COLOR) });
      ui.screenViewport = { cols: Math.max(1, Math.min(cols, 400)), rows: Math.max(1, Math.min(160, rows - 2 - Number(Boolean(ui.outputError)))) };
      const size = `${ui.screenViewport.cols}x${ui.screenViewport.rows}`;
      if (controller && controlSize !== size) { controller.resize?.(ui.screenViewport.cols, ui.screenViewport.rows); controlSize = size; }
      return { tree, hits: [[{ id: 'back', from: 0, to: Math.min(13, cols) }]], controls: [{ id: 'back' }] };
    }
    if (ui.view === 'detail') {
      const document = ui.document ?? { title: 'Opening…', sections: [{ id: 'reading', title: 'Reading details…', content: '' }] };
      lastDetail = renderer.detailTree({ ...document, title: document.title + (ui.detailError ? ' · source unavailable' : '') }, ui, cols, rows, { noColor: Boolean(env.NO_COLOR), now: d.now() });
      ui.detailScroll = lastDetail.scroll;
      return lastDetail;
    }
    const current = { project, ...model(), ...ui, selected: ui.focus, now: d.now() };
    const layout = renderer.minimalLayout(current, cols, rows);
    if (!ui.loading && !(ui.focus === 'context' && layout.contextText)) {
      const panel = layout.groups.findIndex(group => group.some(row => row.id === ui.focus));
      if (panel >= 0) ui.panel = panel;
      else {
        const group = layout.groups[ui.panel] ?? [];
        ui.focus = group[Math.min(ui.panelOffsets[ui.panel] ?? 0, group.length - 1)]?.id ?? layout.groups.flat()[0]?.id ?? null;
        ui.panel = Math.max(0, layout.groups.findIndex(group => group.some(row => row.id === ui.focus)));
      }
    }
    const result = renderer.minimalTree({ ...current, selected: ui.focus }, cols, rows, { noColor: Boolean(env.NO_COLOR) });
    lastView = result;
    ui.panelOffsets = result.offsets;
    return result;
  }
  async function activate(id) {
    if (id === 'back') return back();
    let open;
    if (ui.view === 'detail') open = lastDetail?.links.find(r => r.id === id)?.open;
    else if (ui.view === 'table') {
      open = id === 'context' ? { kind: 'context' } : lastView?.groups.flat().find(r => r.id === id)?.open;
      if (id?.startsWith('pipeline:')) open = lastView?.groups[0].find(r => r.pipeline?.id === id)?.pipeline.open;
      if (open) {
        ui.focus = lastView.groups[0].find(r => r.pipeline?.id === id)?.id ?? id;
        const panel = lastView.groups.findIndex(group => group.some(r => r.id === ui.focus));
        if (panel >= 0) { ui.panel = panel; ui.selections[panel] = ui.focus; }
      }
    }
    if (!open) return false;
    if (open.kind !== 'session') {
      if (ui.view === 'detail') ui.detailFocus = id;
      history.push(snapshot()); release();
      Object.assign(ui, { view: 'detail', detail: open, document: null, detailScroll: 0, detailFocus: null, detailError: null, message: '' });
      await readDetail(); changed(); return false;
    }
    if (d.allowSessionInput === false) return false;
    if (!open.target) { ui.message = 'Session unavailable'; changed(); return false; }
    const selected = open.target, generation = ++epoch;
    try {
      const fresh = await d.herdrAgents();
      if (ui.stopped || generation !== epoch) return false;
      if (!fresh.ok || !fresh.agents.some(a => same(a, selected))) throw Error('Session changed · refresh and select it again');
      history.push(snapshot()); release(); const current = epoch;
      Object.assign(ui, { view: 'output', active: selected, pane: selected.pane, interactive: true, terminalFrame: null, outputError: null, message: '' });
      const size = { cols: Math.max(1, Math.min(viewport.cols, 400)), rows: Math.max(1, Math.min(viewport.rows - 2, 160)) };
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
      await prepare();
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
        if (ui.view !== 'table') back();
        history.length = 0; Object.assign(ui, { view: 'table', focus: null, panel: 0, selections: [], panelOffsets: [0, 0, 0] });
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
      if (ui.view === 'detail') await readDetail();
      ui.loading = false;
      if (!ui.stopped) onChange();
    })().finally(() => { pending = null; });
    return pending;
  }
  return {
    prepare, refresh, activate,
    async start() { timer = setInterval(() => refresh().catch(e => { ui.errors.sessions = e.message; changed(); }), config.refresh_seconds * 1000); return refresh(); },
    stop() { ui.stopped = true; release(); clearInterval(timer); },
    async key(input, key = {}) {
      if (ui.view === 'output') {
        if (key.escape || input === '\x1b' || (key.ctrl && input === ']')) return back();
        if (key.ctrl && input === '\\') controller?.input(Buffer.from('\x1b'));
        return false;
      }
      if (input === 'q' || (input === 'c' && key.ctrl)) return true;
      if (key.escape) { if (ui.view === 'detail') return back(); epoch++; return false; }
      if (input === 'C' && !key.ctrl && !key.meta) {
        if (!project) return false;
        const selected = { ...project };
        let result;
        try { result = await d.herdrProjectChat(selected); }
        catch (error) { result = { ok: false, error: error.message }; }
        ui.message = result.ok ? `Opened ${selected.name} supervisor chat.${result.available === false ? ' Its agent is no longer running; inspect the retained tab.' : ''}` : `Chat did not open: ${result.error}`;
        changed(); return false;
      }
      if (ui.view === 'detail') {
        const l = lastDetail;
        if (!l) return false;
        if (key.tab) {
          const step = key.shift ? -1 : 1;
          const index = l.sections.findLastIndex(s => s.index <= ui.detailScroll || s.id === ui.detailFocus);
          const next = l.sections[(index + step + l.sections.length) % l.sections.length];
          ui.detailFocus = next.id === 'pipeline' ? l.links.find(link => link.section === 'pipeline')?.id ?? next.id : next.id; ui.detailScroll = next.index;
        } else if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || input === 'j' || input === 'k') {
          const step = key.upArrow || key.leftArrow || input === 'k' ? -1 : 1;
          const focused = l.links.find(line => line.id === ui.detailFocus), panel = focused?.section ?? ui.detailFocus;
          const links = l.links.filter(line => line.link && (ui.document.list || line.section === panel));
          if (links.length) {
            const index = links.findIndex(line => line.id === ui.detailFocus), next = links[Math.max(0, Math.min(links.length - 1, index + step))];
            ui.detailFocus = next.id;
            const at = next.index;
            if (at < ui.detailScroll || at >= ui.detailScroll + l.capacity) ui.detailScroll = at;
          } else { ui.detailFocus = null; ui.detailScroll += step; }
        } else if (key.pageUp || key.pageDown) { ui.detailFocus = null; ui.detailScroll += (key.pageUp ? -1 : 1) * l.capacity; }
        else if (key.return) return activate(ui.detailFocus);
        else return false;
        ui.detailScroll = Math.max(0, Math.min(Math.max(0, l.lines.length - l.capacity), ui.detailScroll));
        changed(); return false;
      }
      const groups = [...(lastView?.groups ?? []), ...(lastView?.contextText ? [[{ id: 'context' }]] : [])];
      if (input === 'p') {
        const row = lastView?.groups[0].find(r => r.id === ui.focus);
        if (row?.pipeline) return activate(row.pipeline.id);
      }
      if (key.tab) {
        ui.selections[ui.panel] = ui.focus;
        const panels = groups.map((group, i) => group.length ? i : -1).filter(i => i >= 0);
        const index = panels.indexOf(ui.panel), step = key.shift ? -1 : 1;
        ui.panel = panels[(index + step + panels.length) % panels.length] ?? 0;
        ui.focus = groups[ui.panel]?.find(r => r.id === ui.selections[ui.panel])?.id ?? groups[ui.panel]?.[0]?.id ?? null;
        epoch++; ui.message = ''; changed();
      } else if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || input === 'j' || input === 'k') {
        const entries = groups[ui.panel] ?? [], index = entries.findIndex(r => r.id === ui.focus);
        const step = (key.upArrow || key.pageUp || input === 'k' ? -1 : 1) * (key.pageUp || key.pageDown ? Math.max(1, lastView.visible[ui.panel]?.length ?? 1) : 1);
        ui.focus = entries[Math.max(0, Math.min(entries.length - 1, index + step))]?.id ?? null;
        ui.selections[ui.panel] = ui.focus;
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
      if (ui.view === 'detail') {
        if (event.button === 'wheelUp' || event.button === 'wheelDown') {
          ui.detailFocus = null; ui.detailScroll = Math.max(0, Math.min(Math.max(0, lastDetail.lines.length - lastDetail.capacity), ui.detailScroll + (event.button === 'wheelUp' ? -3 : 3))); changed();
        } else if (event.button === 'left') {
          const hit = lastDetail?.hits[event.y]?.find(h => event.x >= h.from && event.x < h.to);
          if (hit) return activate(hit.id);
        }
        return false;
      }
      if (event.button === 'wheelUp' || event.button === 'wheelDown') {
        return this.key('', { [event.button === 'wheelUp' ? 'upArrow' : 'downArrow']: true });
      }
      if (event.button === 'left') {
        const hit = lastView?.hits[event.y]?.find(h => event.x >= h.from && event.x < h.to);
        if (hit) return activate(hit.id);
      }
      return false;
    },
    async input(data) {
      if (ui.view !== 'output' || !ui.interactive) return false;
      const { back: leave, bytes } = parseSessionInput(data);
      if (leave) back();
      else if (bytes.length) controller?.input(bytes);
      return true;
    },
    tree(cols, rows) { return view(cols, rows).tree; },
    frame(cols, rows) {
      const result = view(cols, rows);
      return renderer.inkFrame(result.tree, cols, rows, { hits: result.hits, controls: result.controls });
    },
    get ui() { return ui; }, set ui(value) { Object.assign(ui, value); },
    get project() { return project; }, get model() { return model(); },
  };
}
