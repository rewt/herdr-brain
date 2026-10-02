// Console effects write through validating CLI commands.
import * as cli from '../lib/cli.mjs';
import { readQueue, brainAct } from '../lib/brain.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { catalog, createIdentityReader, folderPath, projectView, workspaceIdentity } from './model.mjs';
import { renderModern } from './frame.mjs';
import { checkoutName, checkoutOrder, composeModes, currentBlock, sessionGroups, sessionName } from './project.mjs';
import { needChoices, needActions, needEffect } from './needs.mjs';
import { moveRegion, moveWithin, pickerEntries } from './navigation.mjs';
import { observeTerminal } from './terminal.mjs';
import { controlTerminal, splitInput } from './control.mjs';
import { resolveRoute } from '../../lanes/routes.mjs';
import { settingsEditor, settingsReview } from './settings.mjs';
import { routeReview } from './routes.mjs';
import { FIELDS, housekeepingReview } from './housekeeping.mjs';
const exec = promisify(execFile);

async function gitSummary(cwd) {
  if (!cwd) return null;
  const { stdout } = await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', cwd, 'status', '--short', '--branch', '--untracked-files=normal'], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const [branch, ...changes] = stdout.trimEnd().split('\n');
  return { branch: branch?.replace(/^## /, ''), changes: changes.length };
}

export function createModernSession({ config, configFile, projectIndex = 0, deps = {}, onChange = () => {}, env = process.env }) {
  const d = { identity: createIdentityReader(), orgToday: cli.orgToday, orgStatus: cli.orgStatus, orgLog: cli.orgLog, herdrAgents: cli.herdrAgents, herdrList: cli.herdrList,
    herdrRead: cli.herdrRead, herdrGo: cli.herdrGo, orgAdd: cli.orgAdd, herdrStartChat: cli.herdrStartChat, herdrRename: cli.herdrRename, orgAnswer: cli.orgAnswer,
    orgDesks: cli.orgDesks, orgSettingsSet: cli.orgSettingsSet, orgHousekeeping: cli.orgHousekeeping, orgHousekeepingSet: cli.orgHousekeepingSet, orgRoutes: cli.orgRoutes, orgRouteSet: cli.orgRouteSet, orgPriorityChange: cli.orgPriorityChange,
    brainAct: args => brainAct(config.brain_bin, args), gitSummary, folderPath,
    observeTerminal: deps.herdrRead ? null : observeTerminal, controlTerminal: deps.herdrRead ? null : controlTerminal,
    brainQueue: () => readQueue(config.brain_bin, { configFile, env }), now: () => Date.now(), ...deps };
  const data = { workspaces: [], tabs: [], agents: [], panes: [], since: new Map(), today: null, status: null, events: [], desks: null, housekeeping: null, routes: null, brain: { rows: [], off: true } };
  const s = { projects: [], projectId: config.projects[projectIndex] ? config.projects[projectIndex].id ?? `configured:${config.projects[projectIndex].name}` : null,
    view: 'overview', detail: null, space: null, tab: null, pane: null, focus: 'scope', scroll: 0, outputScroll: 0,
    appearance: env.HERDR_CONSOLE_THEME === 'light' ? 'light' : 'dark',
    showCheckouts: env.HERDR_CONSOLE_SIDEBAR ? env.HERDR_CONSOLE_SIDEBAR === '1' : env.HERDR_ENV !== '1',
    picker: null, settingsEdit: null, housekeepingEdit: null, routeEdit: null, priorityEdit: null, regionFocus: {}, outputX: 0, screenScroll: 0,
    outputMode: 'mirror', interactive: false, terminalFrame: null, screenViewport: null, dimensions: { cols: 100, rows: 32 },
    history: [], future: [], opened: [], errors: {}, times: {}, cache: new Map(), text: '', output: null, outputError: null, outputAt: null, git: null, checkoutGit: {}, compose: null, rename: null, act: null, digits: '', digitTimer: null, chatKinds: config.chat_kinds ?? ['claude', 'codex'], message: '',
    frame: null, stopped: false, timer: null, outputTimer: null, pending: null, generation: 0, reading: false, loading: true };
  const project = () => s.projects.find(p => p.id === s.projectId) ?? null;
  const model = () => projectView(project(), data, d.identity, d.now());
  const route = () => ({ projectId: s.projectId, view: s.view, detail: s.detail, space: s.space, tab: s.tab, pane: s.pane, interactive: s.interactive, focus: s.focus, scroll: s.scroll, outputScroll: s.outputScroll, outputMode: s.outputMode, outputX: s.outputX, screenScroll: s.screenScroll, text: s.text });
  const routeKey = r => JSON.stringify([r.projectId, r.view, r.detail, r.view === 'output' ? [r.space, r.tab, r.pane] : null]);
  const changed = () => { if (!s.stopped) onChange(); };
  let observer = null, observerKey = null, observerRetryAt = 0, observerEpoch = 0, controlSize = null;
  // When each session last changed state, as seen by this console. A session
  // first seen has no known start for its current state.
  function noteStates(agents) {
    for (const a of agents) {
      const prior = data.since.get(a.pane);
      if (!prior || prior.status !== a.status) data.since.set(a.pane, { status: a.status, at: prior ? d.now() : null });
    }
  }
  function stopObserver() { observerEpoch++; observerKey = null; controlSize = null; observer?.stop(); observer = null; }
  // Interactive: the console holds Herdr's control stream for the pane, sized to
  // its own terminal area, so the session redraws to fit and takes typing.
  function ensureController() {
    if (s.view !== 'output' || !s.pane || s.stopped) return;
    if (s.errors.agents || s.errors.tabs || s.errors.workspaces || !model().sessions.some(a => a.pane === s.pane && a.tab === s.tab)) { stopObserver(); s.interactive = false; return; }
    const key = `control:${s.pane}`;
    if (key === observerKey || d.now() < observerRetryAt) return;
    const size = s.screenViewport ?? { cols: Math.max(20, s.dimensions.cols - 30), rows: Math.max(5, s.dimensions.rows - 12) };
    stopObserver(); observerKey = key; controlSize = `${size.cols}x${size.rows}`;
    const generation = s.generation, epoch = observerEpoch, live = () => !s.stopped && observerKey === key && generation === s.generation && epoch === observerEpoch;
    observer = d.controlTerminal({ pane: s.pane, cols: size.cols, rows: size.rows,
      onFrame(frame) { if (!live()) return; s.terminalFrame = frame; s.outputAt = d.now(); s.outputError = null; changed(); },
      onError(error) {
        if (!live()) return;
        s.outputError = `Cannot type into this session: ${error?.message ?? error}. Press i to retry, or o for the native terminal.`;
        s.interactive = false; observerRetryAt = d.now() + 2000; stopObserver(); changed(); readOutput();
      },
      onClose(reason) {
        if (!live()) return;
        s.message = `Herdr handed this terminal elsewhere (${reason}). Press i to type into it again.`;
        s.interactive = false; stopObserver(); changed(); readOutput();
      },
    });
  }
  function ensureObserver() {
    if (s.interactive && d.controlTerminal) return ensureController();
    if (!d.observeTerminal || s.outputMode !== 'mirror' || s.view !== 'output' || !s.pane || s.stopped) return;
    if (s.errors.agents || s.errors.tabs || s.errors.workspaces || !model().sessions.some(a => a.pane === s.pane && a.tab === s.tab)) { stopObserver(); return; }
    const key = s.pane;
    if (key === observerKey || d.now() < observerRetryAt) return;
    stopObserver(); observerKey = key;
    const generation = s.generation, epoch = observerEpoch;
    observer = d.observeTerminal({ pane: s.pane, followNativeSize: true,
      onFrame(frame) {
        if (s.stopped || observerKey !== key || generation !== s.generation || epoch !== observerEpoch) return;
        s.terminalFrame = frame; s.output = frame.lines.map(l => l.spans.map(s => s.text).join('')).join('\n');
        s.outputAt = d.now(); s.outputError = null; changed();
      },
      onError(error) {
        if (s.stopped || observerKey !== key || generation !== s.generation || epoch !== observerEpoch) return;
        s.outputError = `Live screen unavailable: ${error?.message ?? error}. Press r to retry, l for transcript, or o for the native terminal.`;
        observerRetryAt = d.now() + 5000; stopObserver(); changed();
      },
    });
  }
  function navigate(next) {
    const before = route(), after = { ...before, ...next };
    if (routeKey(before) === routeKey(after)) return;
    s.history.push(before); s.future = [];
    Object.assign(s, { interactive: false }, next, { scroll: 0, outputScroll: 0, outputX: 0, screenScroll: 0, message: '', compose: null, rename: null, act: null, settingsEdit: null, housekeepingEdit: null, routeEdit: null, priorityEdit: null, focus: next.focus ?? 'back' });
    s.output = null; s.outputError = null; s.outputAt = null; s.git = null; s.generation++;
    stopObserver(); s.terminalFrame = null; s.screenViewport = null; s.outputMode = 'mirror'; observerRetryAt = 0;
    changed();
  }
  async function restore(from, to) {
    if (!from.length) return;
    const prior = from.pop(), oldProject = s.projectId;
    to.push(route()); Object.assign(s, { interactive: false }, prior); s.output = null; s.outputError = null; s.outputAt = null; s.git = null; s.generation++;
    stopObserver(); s.terminalFrame = null; s.screenViewport = null; observerRetryAt = 0;
    if (oldProject !== s.projectId) { adoptProject(); await refresh(); }
    await readOutput(); changed();
  }
  function adoptProject() {
    const cached = s.cache.get(s.projectId);
    data.today = cached?.today ?? null; data.status = cached?.status ?? null; data.events = cached?.events ?? []; data.routes = cached?.routes ?? null; data.housekeeping = cached?.housekeeping ?? null; data.desks = cached?.desks ?? null;
    for (const key of ['today', 'status', 'events', 'routes', 'housekeeping', 'desks']) { delete s.errors[key]; s.times[key] = cached?.times?.[key] ?? null; }
  }
  async function readOutput() {
    // A transcript read in flight must not delay taking the terminal to type.
    if (s.view !== 'output' || !s.pane || (s.reading && !s.interactive) || s.stopped) return;
    const pane = s.pane, generation = s.generation;
    if (s.errors.agents || s.errors.workspaces || s.errors.tabs) { stopObserver(); s.outputError = 'Herdr is unavailable. Last output is retained; refresh to reconnect.'; changed(); return; }
    const m = model();
    if (!m.sessions.some(a => a.pane === pane && a.tab === s.tab)) { stopObserver(); s.outputError = 'This agent is no longer in this tab. Choose a current session.'; changed(); return; }
    if ((d.observeTerminal || (s.interactive && d.controlTerminal)) && s.outputMode === 'mirror') {
      ensureObserver(); return;
    }
    s.reading = true;
    try {
      const result = await d.herdrRead({ pane }, 400);
      if (generation !== s.generation || s.pane !== pane || s.stopped) return;
      if (result.ok) { s.output = result.text; s.outputAt = d.now(); s.outputError = null; }
      else s.outputError = result.error;
    } catch (e) { if (generation === s.generation) s.outputError = e.message; }
    finally { s.reading = false; changed(); }
  }
  async function refresh() {
    if (s.pending) return s.pending;
    const selected = s.projectId;
    s.pending = (async () => {
      const load = async (key, fn, assign) => { try { const value = await fn(); if (s.stopped) return; assign(value); delete s.errors[key]; s.times[key] = d.now(); } catch (e) { s.errors[key] = e.message; } };
      await Promise.all([
        load('workspaces', () => d.herdrList('workspace'), x => data.workspaces = x),
        load('tabs', () => d.herdrList('tab'), x => data.tabs = x),
        load('agents', async () => { const r = await d.herdrAgents(); if (!r.ok) throw Error(r.error); return r.agents; }, x => { data.agents = x; noteStates(x); }),
        load('panes', () => d.herdrList('pane'), x => data.panes = x),
        load('brain', async () => { const r = await d.brainQueue(); if (r.error) throw Error(r.error); return r; }, x => data.brain = x),
      ]);
      s.projects = catalog(config.projects, data.workspaces, d.identity, s.opened, data.agents);
      // A discovered project leaves the catalog when its last workspace closes.
      const vanished = Boolean(s.projectId && !project());
      if (vanished) {
        Object.assign(s, { projectId: null, view: 'overview', detail: null, space: null, tab: null, pane: null, focus: 'view:overview' });
        s.message = 'That project has no open workspace any more; showing the current one.';
      }
      if (!s.projectId) {
        const workspace = data.workspaces.find(w => w.workspace_id === env.HERDR_WORKSPACE_ID);
        const key = workspace ? workspaceIdentity(workspace, d.identity)?.key : null;
        s.projectId = s.projects.find(p => key && p.repoKey === key)?.id ?? s.projects[0]?.id ?? null;
      }
      if (vanished) adoptProject();
      const p = project();
      if (p) {
        const id = p.id, cached = s.cache.get(id) ?? { times: {} };
        try { const value = await d.orgRoutes(p); cached.routes = value; cached.times.routes = d.now();
          if (s.projectId === id) { data.routes = value; delete s.errors.routes; s.times.routes = cached.times.routes; }
        } catch (e) { if (s.projectId === id) s.errors.routes = e.message; }
        try { const value = await d.orgHousekeeping(p); cached.housekeeping = value; cached.times.housekeeping = d.now();
          if (s.projectId === id) { data.housekeeping = value; delete s.errors.housekeeping; s.times.housekeeping = cached.times.housekeeping; }
        } catch (e) { if (s.projectId === id) s.errors.housekeeping = e.message; }
        try { const value = await d.orgDesks(p); cached.desks = value; cached.times.desks = d.now();
          if (s.projectId === id) { data.desks = value; delete s.errors.desks; s.times.desks = cached.times.desks; }
        } catch (e) { if (s.projectId === id) s.errors.desks = e.message; }
        s.cache.set(id, cached);
      }
      if (p?.org && (selected === s.projectId || selected === null)) {
        const id = p.id, cached = s.cache.get(id) ?? { times: {} };
        await Promise.all(['today', 'status', 'events'].map(async key => {
          try { const value = await (key === 'today' ? d.orgToday(p) : key === 'status' ? d.orgStatus(p) : d.orgLog(p)); cached[key] = value; cached.times[key] = d.now();
            if (s.projectId === id) { data[key] = value; delete s.errors[key]; s.times[key] = cached.times[key]; }
          } catch (e) { if (s.projectId === id) s.errors[key] = e.message; }
        }));
        s.cache.set(id, cached);
      } else if (!p?.org) { data.today = null; data.status = null; data.events = []; delete s.errors.today; delete s.errors.status; delete s.errors.events; }
      s.loading = false;
    })().finally(() => { s.pending = null; changed(); });
    await s.pending;
    // A project switch during IO must not leave the new scope with the old data.
    if (selected !== s.projectId && selected !== null) return refresh();
    await readOutput();
    // Each checkout's branch and change count, for the project screen.
    const spaces = model().spaces, checked = s.projectId;
    await Promise.all(spaces.map(async w => {
      try { const git = await d.gitSummary(w.worktree?.checkout_path ?? w.cwd); if (checked === s.projectId) s.checkoutGit[w.workspace_id] = git; } catch { delete s.checkoutGit[w.workspace_id]; }
    }));
    changed();
    if (s.view === 'output') {
      const generation = s.generation, w = data.workspaces.find(w => w.workspace_id === s.space);
      try { const git = await d.gitSummary(w?.worktree?.checkout_path); if (generation === s.generation) s.git = git; } catch { if (generation === s.generation) s.git = null; }
      changed();
    }
  }
  async function activate(id) {
    // Editors own input and navigation, including mouse header clicks.
    if (s.settingsEdit) {
      if (s.settingsEdit.busy) return;
      if (id === 'settings-cancel') { s.settingsEdit = null; changed(); }
      else if (id === 'settings-save') return settingsEditKey('', { return: true });
      else if (id.startsWith('settings-field:') && !s.settingsEdit.confirm) { s.settingsEdit.field = Number(id.split(':')[1]); changed(); }
      return;
    }
    if (s.housekeepingEdit) {
      if (s.housekeepingEdit.busy) return;
      if (id === 'housekeeping-cancel') { s.housekeepingEdit = null; changed(); }
      else if (id === 'housekeeping-save') return housekeepingEditKey('', { return: true });
      else if (id.startsWith('housekeeping-field:') && !s.housekeepingEdit.confirm) { s.housekeepingEdit.field = Number(id.split(':')[1]); changed(); }
      return;
    }
    if (s.priorityEdit) {
      if (s.priorityEdit.busy) return;
      if (id === 'priority-cancel') { s.priorityEdit = null; changed(); }
      else if (id === 'priority-save') return priorityEditKey('', { return: true });
      else if (id.startsWith('priority-field:') && !s.priorityEdit.confirm) { s.priorityEdit.field = Number(id.slice(15)); changed(); }
      return;
    }
    if (s.routeEdit) {
      if (s.routeEdit.busy) return;
      if (id === 'route-cancel') { s.routeEdit = null; changed(); }
      else if (id === 'route-save') return routeEditKey('', { return: true });
      else if (id.startsWith('route-field:') && !s.routeEdit.confirm) { s.routeEdit.field = Number(id.slice(12)); changed(); }
      return;
    }
    const m = model();
    if (id === 'desks-edit' || id.startsWith('settings:')) {
      const [, kind, task, pool] = id.split(':').map(value => decodeURIComponent(value));
      const doc = id === 'desks-edit' ? m.desks : m.routes, source = id === 'desks-edit' ? 'desks' : 'routes';
      if (s.errors[source] || !doc?.editable) { s.message = 'Open a Git project and refresh before editing settings.'; changed(); return; }
      s.settingsEdit = settingsEditor(id === 'desks-edit' ? 'desks' : kind, doc, project(), { task, pool, harness: task });
      s.settingsEdit.initial = [...s.settingsEdit.values];
      s.scroll = 0; s.message = ''; changed(); return;
    }
    if (id === 'housekeeping-edit' || id === 'housekeeping-pause') {
      const doc = m.housekeeping;
      if (s.errors.housekeeping || !doc?.editable) { s.message = 'Refresh and inspect housekeeping before editing.'; changed(); return; }
      s.housekeepingEdit = { project: { ...project() }, revision: doc.revision, target: doc.target, original: doc.overrides,
        before: doc.config, values: FIELDS.map(key => Object.hasOwn(doc.overrides, key) ? String(doc.overrides[key]) : ''),
        field: 0, confirm: id === 'housekeeping-pause', busy: false };
      if (id === 'housekeeping-pause') s.housekeepingEdit.values[0] = 'false';
      s.scroll = 0; s.message = ''; changed(); return;
    }
    if (id === 'priority-add' || id.startsWith('priority:')) {
      if (!project()?.org || s.errors.status) { s.message = 'Open a project record and refresh before setting priorities.'; changed(); return; }
      const doc = m.priorities, p = doc.priorities.find(p => p.id === id.slice(9));
      if (id !== 'priority-add' && !p) return;
      s.priorityEdit = { id: p?.id, title: p?.title, project: { ...project() }, revision: doc.revision,
        order: doc.priorities.map(p => ({ id: p.id, title: p.title })),
        values: [p ? String(p.rank) : '', ''], field: 0, confirm: false, busy: false };
      s.message = ''; changed(); return;
    }
    if (id === 'home') return activate('view:overview');
    if (id === 'checkouts') { s.showCheckouts = !s.showCheckouts; s.focus = s.showCheckouts ? `space:${m.spaces[0]?.workspace_id}` : 'checkouts'; changed(); return; }
    if (id === 'scope') {
      if (s.picker) { s.focus = s.picker.returnFocus; s.picker = null; }
      else s.picker = { index: Math.max(0, s.projects.findIndex(p => p.id === s.projectId)), query: '', returnFocus: s.focus };
      changed(); return;
    }
    if (s.picker) { s.focus = s.picker.returnFocus; s.picker = null; }
    if (id === 'appearance') { s.appearance = s.appearance === 'dark' ? 'light' : 'dark'; changed(); return; }
    if (id === 'unavailable') { s.message = 'Read-only trial: use Herdr Monitor for actions; Herdr for new chats.'; changed(); return; }
    if (id.startsWith('link-item:')) return activate(`item:${id.slice(10).split('|')[0]}`);
    if (id.startsWith('link-space:')) return activate(`space:${id.slice(11).split('|')[0]}`);
    if (id === 'back') return restore(s.history, s.future);
    if (id === 'forward') return restore(s.future, s.history);
    if (id === 'refresh') { observerRetryAt = 0; return refresh(); }
    if (id === 'transcript' || id === 'mirror') {
      stopObserver(); s.outputMode = id === 'transcript' ? 'transcript' : 'mirror'; s.outputScroll = 0; s.outputX = 0; s.screenScroll = 0;
      s.output = null; s.terminalFrame = null; s.outputError = null; s.outputAt = null; s.generation++; observerRetryAt = 0;
      await readOutput(); changed(); return;
    }
    if (id === 'folder') { navigate({ view: 'folder', detail: null, text: '' }); return; }
    if (id === 'ideas') { navigate({ view: 'ideas', detail: null }); return; }
    if (id === 'open-folder') {
      try {
        const cwd = d.folderPath(s.text), repo = d.identity(cwd);
        const existing = s.projects.find(p => p.repoKey === repo?.key);
        if (!existing) s.opened.push({ id: `folder:${cwd}`, name: repo?.name ?? cwd, cwd, org: null });
        s.projects = catalog(config.projects, data.workspaces, d.identity, s.opened, data.agents);
        return activate(`project:${existing?.id ?? `folder:${cwd}`}`);
      } catch (e) { s.message = `Cannot open folder: ${e.message}`; changed(); return; }
    }
    if (id.startsWith('project:')) {
      const next = id.slice(8); if (!s.projects.some(p => p.id === next)) return;
      if (next === s.projectId) { changed(); return; }
      navigate({ projectId: next, view: 'overview', detail: null, space: null, tab: null, pane: null, focus: 'view:overview' }); adoptProject(); return refresh();
    }
    if (id.startsWith('view:')) { const view = id.slice(5); const first = { desks: 'desks-edit', housekeeping: 'housekeeping-edit', priorities: m.priorities?.priorities[0] ? `priority:${m.priorities.priorities[0].id}` : 'priority-add', control: m.needs[0] && `need:${m.needs[0].key}`, decided: m.decided[0] && `decision:${m.decided[0].key}`, asked: m.asked[0] && `asked:${m.asked[0].id}`, routes: Object.keys(m.routes?.config.routes ?? {}).sort()[0] && `route:${Object.keys(m.routes.config.routes).sort()[0]}`, goals: m.goals[0] && `item:${m.goals[0].id}`, tasks: m.tasks[0] && `item:${m.tasks[0].id}`, activity: m.activity[0] && `activity:${m.activity[0].seq}`, needs: m.needs[0] && `need:${m.needs[0].key}`, later: m.later[0] && `need:${m.later[0].key}`, parked: m.parked[0] && `need:${m.parked[0].key}`, resolved: m.resolved[0] && `need:${m.resolved[0].key}`, ended: m.ended[0] && `need:${m.ended[0].key}`, reports: m.reports[0] && `need:${m.reports[0].key}`, sessions: m.sessions[0] && `session:${m.sessions[0].pane}` }; navigate({ view, detail: null, focus: first[view] ?? id }); return; }
    if (id.startsWith('decision:')) {
      if (m.decided.some(n => n.key === id.slice(9))) navigate({ view: 'decision', detail: id.slice(9) });
      return;
    }
    if (id.startsWith('asked:')) {
      const question = id.slice(6), need = m.allNeeds.find(n => n.question === question);
      if (m.asked.some(q => q.id === question && q.reportQuestion)) { navigate({ view: 'asked-detail', detail: question }); return; }
      return activate(need ? `need:${need.key}` : `item:${question}`);
    }
    if (id.startsWith('route:')) {
      const name = id.slice(6), routes = m.routes;
      if (s.errors.routes || !routes?.editable || !Object.hasOwn(routes.config.routes ?? {}, name)) { s.message = 'Refresh project routes before editing.'; changed(); return; }
      const r = resolveRoute(routes.config, { route: name });
      s.routeEdit = { name, project: { ...project() }, revision: routes.revision, target: routes.target, field: 0, confirm: false, busy: false,
        config: routes.config, suggested: Boolean(routes.suggested),
        original: { kind: r.kind, model: r.model, effort: r.effort },
        values: [r.kind, r.model ?? '', r.effort ?? ''] };
      changed(); return;
    }
    if (id.startsWith('activity:')) {
      const event = m.activity.find(event => String(event.seq) === id.slice(9));
      if (event && m.itemsById.has(event.id)) navigate({ view: 'item', detail: event.id });
      return;
    }
    if (id.startsWith('item:')) { if (m.itemsById.has(id.slice(5))) navigate({ view: 'item', detail: id.slice(5) }); return; }
    if (id.startsWith('need:')) { if (m.allNeeds.some(r => r.key === id.slice(5))) navigate({ view: 'need', detail: id.slice(5) }); return; }
    if (id.startsWith('space:')) {
      const space = id.slice(6), w = m.spaces.find(w => w.workspace_id === space); if (!w) return;
      const tab = m.tabs.find(t => t.tab_id === w.active_tab_id) ?? m.tabs.find(t => t.workspace_id === space);
      return openTab(space, tab?.tab_id ?? null);
    }
    if (id.startsWith('tab:')) { const tab = m.tabs.find(t => t.tab_id === id.slice(4)); if (tab) return openTab(tab.workspace_id, tab.tab_id); return; }
    if (id.startsWith('session:')) {
      const row = m.sessions.find(a => a.pane === id.slice(8)); if (!row) return;
      navigate({ view: 'output', detail: null, space: row.space, tab: row.tab, pane: row.pane, interactive: Boolean(d.controlTerminal) }); await readOutput(); return refresh();
    }
    if (id === 'interact') {
      if (s.view !== 'output' || !s.pane || !d.controlTerminal) return;
      stopObserver(); s.interactive = true; s.outputMode = 'mirror'; s.terminalFrame = null; s.outputError = null; s.message = ''; s.generation++; observerRetryAt = 0;
      await readOutput(); changed(); return;
    }
    if (id.startsWith('rename:')) return startRename(id.slice(7));
    if (id.startsWith('choose:')) return choose(id.slice(7));
    if (id === 'compose-mode') { if (s.compose) { s.compose.mode = (s.compose.mode + 1) % composeModes(project(), s.chatKinds).length; changed(); } return; }
    if (id === 'compose') {
      if (!project()) return;
      if (s.view !== 'overview') navigate({ view: 'overview', detail: null, space: null, tab: null, pane: null });
      openCompose(); return;
    }
    if (id === 'go') {
      // Only the session on screen can be opened; a tab/pane kept from an
      // earlier visit is not a target the operator can see.
      if (s.view !== 'output') { s.message = 'Open a session first, then press o to go to it in Herdr.'; changed(); return; }
      if (s.errors.agents || s.errors.tabs || !s.tab) { s.message = 'Refresh Herdr before opening the native terminal.'; changed(); return; }
      // Re-read topology before transferring focus; no cached metadata authorizes
      // a write or selects a different agent by a reused display name. The
      // target is fixed at the keypress, so navigating during the checks cannot
      // redirect focus to a different pane.
      const tab = s.tab, pane = s.pane, generation = s.generation;
      try {
        const tabs = await d.herdrList('tab'); if (!tabs.some(t => t.tab_id === tab)) throw Error('The tab has closed. Refresh and choose another.');
        if (pane) { const a = await d.herdrAgents(); if (!a.ok || !a.agents.some(a => a.pane === pane && a.tab === tab)) throw Error('The session changed. Refresh and choose it again.'); }
        if (generation !== s.generation) return;
        const r = await d.herdrGo(pane ? { agent: pane } : { tab });
        s.message = r.ok ? 'Opened in Herdr. Return to this console tab to continue.' : r.error;
        changed(); return r.ok && env.HERDR_CONSOLE_POPUP === '1';
      } catch (e) { s.message = e.message; changed(); }
    }
  }
  // The prompt bar. A chat is a new Herdr tab with an agent in the chosen
  // checkout; a task is `org add` under the block. The bar always shows which,
  // and where, before Enter.
  function openCompose() {
    const main = checkoutOrder(model().spaces)[0];
    s.compose = { mode: 0, text: '', space: main?.workspace_id ?? null, confirm: false, busy: false };
    s.focus = 'compose'; s.message = ''; changed();
  }
  async function composeKey(input, k) {
    const c = s.compose, modes = composeModes(project(), s.chatKinds), mode = modes[c.mode];
    if (c.busy) return false;
    if (k.escape) { s.compose = null; s.focus = 'compose'; changed(); return false; }
    if (k.return) {
      if (mode.kind === 'task' && !c.text.trim()) s.message = 'Type the task first.';
      else if (mode.kind === 'chat' && !c.space) s.message = 'Open this project in Herdr first; a chat starts in one of its checkouts.';
      else return submitCompose();
      changed(); return false;
    }
    s.message = '';
    if (k.tab) c.mode = (c.mode + (k.shift ? -1 : 1) + modes.length) % modes.length;
    else if (k.upArrow || k.downArrow) {
      const spaces = checkoutOrder(model().spaces), index = spaces.findIndex(w => w.workspace_id === c.space);
      c.space = spaces[(index + (k.upArrow ? -1 : 1) + spaces.length) % spaces.length]?.workspace_id ?? c.space;
    } else if (k.backspace || k.delete) c.text = [...c.text].slice(0, -1).join('');
    else if (input && !k.ctrl && !k.meta) c.text += input.replace(/[\x00-\x1f\x7f]/g, '');
    changed(); return false;
  }
  async function submitCompose() {
    const c = s.compose, mode = composeModes(project(), s.chatKinds)[c.mode], p = project(), m = model(), text = c.text.trim();
    c.busy = true; changed();
    let done = null;
    try {
      if (mode.kind === 'task') {
        const block = currentBlock(m);
        const r = await d.orgAdd(p, { title: text, parent: block?.goal.id });
        if (!r.ok) throw Error(`Task not added: ${r.error}`);
        s.compose = null; done = `Added ${r.id}${block ? ` under ${block.goal.id}` : ''}.`;
        await refresh();
      } else {
        const w = m.spaces.find(w => w.workspace_id === c.space);
        if (!w) throw Error('That checkout is no longer open in Herdr.');
        const name = `chat-${d.now().toString(36)}`;
        const r = await d.herdrStartChat({ workspace: w.workspace_id, cwd: w.worktree?.checkout_path ?? p.cwd, kind: mode.agent, name, prompt: text });
        if (!r.ok && !r.pane) throw Error(`Chat not started: ${r.error}`);
        s.compose = null; done = r.ok ? `Started ${mode.agent} in ${checkoutName(w)} as ${name}.` : r.error;
        await refresh();
        if (model().sessions.some(a => a.pane === r.pane)) await activate(`session:${r.pane}`);
      }
    } catch (e) { s.message = e.message; }
    finally { if (s.compose) { s.compose.busy = false; s.compose.confirm = false; } if (done) s.message = done; changed(); }
    return false;
  }
  // Renaming a session sets its pane label; the name org runs know is unchanged.
  function startRename(pane) {
    const a = model().sessions.find(x => x.pane === pane); if (!a) return;
    s.rename = { pane, text: sessionName(a) }; s.focus = `session:${pane}`; s.message = ''; changed();
  }
  async function renameKey(input, k) {
    const r = s.rename;
    if (k.escape) { s.rename = null; changed(); return false; }
    if (k.return) {
      const result = await d.herdrRename(r.pane, r.text);
      s.rename = null; s.message = result.ok ? (r.text.trim() ? `Named “${r.text.trim()}”.` : 'Name cleared.') : `Not renamed: ${result.error}`;
      await refresh(); changed(); return false;
    }
    if (k.backspace || k.delete) r.text = [...r.text].slice(0, -1).join('');
    else if (input && !k.ctrl && !k.meta && !k.tab && !k.upArrow && !k.downArrow) r.text += input.replace(/[\x00-\x1f\x7f]/g, '');
    changed(); return false;
  }
  // A session's number opens it. Two digits when there are ten or more.
  function digit(input) {
    const order = sessionGroups(model()).order;
    clearTimeout(s.digitTimer); s.digits += input;
    const open = () => { const n = Number(s.digits); s.digits = ''; const a = order[n - 1]; if (a) return activate(`session:${a.pane}`); s.message = `No session ${n}.`; changed(); };
    if (Number(s.digits) * 10 > order.length || s.digits.length >= 2) return open();
    s.digitTimer = setTimeout(open, 600); s.digitTimer.unref?.();
    return false;
  }
  // Answering a Needs you item: a choice arms the answer line with what will
  // happen; Enter does it. A reply or a decline asks for its words first.
  const currentNeed = () => s.view === 'need' ? model().allNeeds.find(n => n.key === s.detail) : null;
  function choose(id) {
    const n = currentNeed(); if (!n) return;
    const m = model(), pane = n.data?.pane;
    if (id === 'open') {
      if (pane && m.sessions.some(a => a.pane === pane)) return activate(`session:${pane}`);
      if (n.go?.agent) return d.herdrGo({ agent: n.go.agent }).then(r => { s.message = r.ok ? 'Opened in Herdr.' : r.error; changed(); });
      s.message = 'That session is no longer open.'; changed(); return;
    }
    const choice = [...needChoices(n), ...needActions(n)].find(c => c.id === id); if (!choice) return;
    if (choice.needsText) { s.act = { choice, stage: 'text', text: '', says: '' }; changed(); return; }
    const effect = needEffect(n, choice);
    if (!effect?.args && effect?.type === 'brain') { s.message = 'Nothing to do for that.'; changed(); return; }
    s.act = { choice, stage: 'confirm', says: effect.says }; changed();
  }
  async function actKey(input, k) {
    const a = s.act;
    if (a.busy) return false;
    if (k.escape) { s.act = null; changed(); return false; }
    if (a.stage === 'text') {
      if (k.return) { if (!a.text.trim() && a.choice.id === 'reply') { s.message = 'Type the reply first.'; changed(); return false; } return performAct(); }
      if (k.backspace || k.delete) a.text = [...a.text].slice(0, -1).join('');
      else if (input && !k.ctrl && !k.meta && !k.tab && !k.upArrow && !k.downArrow) a.text += input.replace(/[\x00-\x1f\x7f]/g, '');
      changed(); return false;
    }
    if (k.return) return performAct();
    return false;
  }
  async function performAct() {
    const a = s.act, n = currentNeed(), p = project();
    if (!n) { s.act = null; s.message = 'This item has left the queue.'; changed(); return false; }
    const effect = needEffect(n, a.choice, a.text);
    if (!effect) { s.act = null; s.message = 'Nothing to do for that.'; changed(); return false; }
    a.busy = true; a.says = effect.says; changed();
    const r = effect.type === 'answer' ? await d.orgAnswer(p, { ...effect.request, headline: n.headline }) : await d.brainAct(effect.args);
    if (!r.ok) { a.busy = false; s.act = null; s.message = r.blocked ? 'The session is stuck at a prompt and refused it. Open the session (o) and answer there.' : `Not done: ${r.error}`; changed(); return false; }
    s.act = null;
    await refresh();
    await activate('back');
    s.message = `Done: ${effect.says}.`; changed();
    return false;
  }
  async function openTab(space, tab) {
    const agents = model().sessions.filter(a => a.tab === tab);
    // A split with several agents needs an explicit choice, never an arbitrary first agent.
    navigate({ view: 'output', detail: null, space, tab, pane: agents.length === 1 ? agents[0].pane : null, interactive: Boolean(d.controlTerminal && agents.length === 1) });
    await readOutput(); return refresh();
  }
  function frame(cols, rows) {
    s.dimensions = { cols, rows };
    s.frame = renderModern({ state: s, project: project(), model: model(), config, now: d.now() }, cols, rows);
    const v = s.screenViewport;
    if (s.interactive && observer?.resize && v && controlSize !== `${v.cols}x${v.rows}`) { controlSize = `${v.cols}x${v.rows}`; observer.resize(v.cols, v.rows); }
    return s.frame;
  }
  function move(amount) { moveWithin(s, amount); changed(); }
  async function priorityEditKey(input, k) {
    const e = s.priorityEdit;
    if (e.busy) return false;
    if (k.escape) { s.priorityEdit = null; changed(); return false; }
    if (k.return) {
      if (!e.values[0].trim() || !e.values[1].trim()) { s.message = 'An outcome or rank and a reason are required.'; changed(); return false; }
      const rank = Number(e.values[0]);
      if (e.id && (!Number.isInteger(rank) || rank < 1 || rank > e.order.length)) { s.message = `Rank must be from 1 to ${e.order.length}.`; changed(); return false; }
      if (!e.confirm) { e.confirm = true; s.scroll = 0; s.message = ''; changed(); return false; }
      e.busy = true; changed();
      let result;
      try { result = await d.orgPriorityChange(e.project, { id: e.id, title: e.values[0].trim(), rank, why: e.values[1].trim(), revision: e.revision }); }
      catch (error) { result = { ok: false, error: error.message }; }
      if (!result.ok) { e.busy = false; e.confirm = false; s.message = `Priority not saved: ${result.error}`; changed(); return false; }
      s.priorityEdit = null; await refresh(); s.message = 'Operator priorities saved with your reason.'; changed(); return false;
    }
    if (e.confirm) {
      const direction = k.pageDown || k.downArrow ? 1 : k.pageUp || k.upArrow ? -1 : 0;
      if (direction) {
        const step = k.pageDown || k.pageUp ? s.frame?.bodyHeight ?? 1 : 1;
        s.scroll = Math.max(0, Math.min(s.frame?.maxScroll ?? 0, s.scroll + direction * step));
      } else if (k.backspace) { e.confirm = false; s.scroll = 0; }
      changed(); return false;
    }
    if (k.tab || k.downArrow || k.upArrow) e.field = (e.field + 1) % 2;
    else if (k.ctrl && input === 'u') e.values[e.field] = '';
    else if (k.backspace || k.delete) e.values[e.field] = [...e.values[e.field]].slice(0, -1).join('');
    else if (!k.ctrl && !k.meta) e.values[e.field] += input.replace(/[\x00-\x1f\x7f]/g, '');
    changed(); return false;
  }
  async function routeEditKey(input, k) {
    const edit = s.routeEdit;
    if (edit.busy) return false;
    if (k.escape) { s.routeEdit = null; changed(); return false; }
    if (k.return) {
      const fields = ['kind', 'model', 'effort'];
      for (const [i, field] of fields.entries()) {
        const value = edit.values[i].trim();
        if (!value && (field === 'kind' || edit.original[field] !== undefined)) {
          s.message = field === 'kind' ? 'Kind is required.' : `Keep the existing ${field} or enter a replacement; removing overrides is not supported.`;
          changed(); return false;
        }
      }
      const { patch, writes } = routeReview(edit);
      if (!edit.confirm) { edit.confirm = true; s.message = ''; changed(); return false; }
      if (!writes) { s.routeEdit = null; s.message = 'No route changes; nothing written.'; changed(); return false; }
      // Only a suggested preset can be adopted without changing a field.
      if (!Object.keys(patch).length) patch.kind = edit.values[0].trim();
      edit.busy = true; changed();
      let result;
      try { result = await d.orgRouteSet(edit.project, { name: edit.name, ...patch, revision: edit.revision }); }
      catch (error) { result = { ok: false, error: error.message }; }
      if (!result.ok) { edit.busy = false; edit.confirm = false; s.message = `Route not saved: ${result.error}`; changed(); return false; }
      s.routeEdit = null; await refresh(); s.message = `Saved ${edit.name} in project .lane.json.`; changed(); return false;
    }
    if (edit.confirm) { if (k.backspace) edit.confirm = false; changed(); return false; }
    if (k.tab || k.downArrow || k.upArrow) edit.field = (edit.field + (k.shift || k.upArrow ? 2 : 1)) % 3;
    else if (k.ctrl && input === 'u') edit.values[edit.field] = '';
    else if (k.backspace || k.delete) edit.values[edit.field] = [...edit.values[edit.field]].slice(0, -1).join('');
    else if (!k.ctrl && !k.meta) edit.values[edit.field] += input.replace(/[\x00-\x1f\x7f]/g, '');
    changed(); return false;
  }
  async function settingsEditKey(input, k) {
    const edit = s.settingsEdit;
    if (edit.busy) return false;
    if (k.escape) { s.settingsEdit = null; s.scroll = 0; changed(); return false; }
    if (k.return) {
      let review;
      try { review = settingsReview(edit); } catch (error) { s.message = error.message; changed(); return false; }
      if (!edit.confirm) { edit.confirm = true; s.scroll = 0; s.message = ''; changed(); return false; }
      if (!review.writes) { s.settingsEdit = null; s.message = 'No settings changes; nothing written.'; changed(); return false; }
      edit.busy = true; changed();
      let result;
      try { result = await d.orgSettingsSet(edit.project, review, edit.revision); } catch (error) { result = { ok: false, error: error.message }; }
      if (!result.ok) { edit.busy = false; edit.confirm = false; s.scroll = 0; s.message = `Settings not saved: ${result.error}`; changed(); return false; }
      s.settingsEdit = null; await refresh(); s.message = 'Saved project settings in .lane.json.'; changed(); return false;
    }
    if (edit.confirm) {
      if (k.backspace) { edit.confirm = false; s.scroll = 0; }
      else if (k.downArrow || k.pageDown) s.scroll = Math.min(s.frame?.maxScroll ?? 0, s.scroll + (k.pageDown ? s.frame?.bodyHeight ?? 8 : 1));
      else if (k.upArrow || k.pageUp) s.scroll = Math.max(0, s.scroll - (k.pageUp ? s.frame?.bodyHeight ?? 8 : 1));
      changed(); return false;
    }
    if (k.tab || k.downArrow || k.upArrow) edit.field = (edit.field + (k.shift || k.upArrow ? edit.values.length - 1 : 1)) % edit.values.length;
    else if (k.ctrl && input === 'u') edit.values[edit.field] = '';
    else if (k.backspace || k.delete) edit.values[edit.field] = [...edit.values[edit.field]].slice(0, -1).join('');
    else if (!k.ctrl && !k.meta) edit.values[edit.field] += input.replace(/[\x00-\x1f\x7f]/g, '');
    changed(); return false;
  }
  async function housekeepingEditKey(input, k) {
    const edit = s.housekeepingEdit;
    if (edit.busy) return false;
    if (k.escape) { s.housekeepingEdit = null; changed(); return false; }
    if (k.return) {
      let review;
      try { review = housekeepingReview(edit); }
      catch (error) { s.message = error.message; changed(); return false; }
      if (!edit.confirm) { edit.confirm = true; s.scroll = 0; s.message = ''; changed(); return false; }
      if (!review.writes) { s.housekeepingEdit = null; s.message = 'No housekeeping changes; nothing written.'; changed(); return false; }
      edit.busy = true; changed();
      let result;
      try { result = await d.orgHousekeepingSet(edit.project, { patch: review.patch, unset: review.unset, revision: edit.revision }); }
      catch (error) { result = { ok: false, error: error.message }; }
      if (!result.ok) { edit.busy = false; edit.confirm = false; s.message = `Housekeeping not saved: ${result.error}`; changed(); return false; }
      s.housekeepingEdit = null; await refresh(); s.message = 'Saved housekeeping overrides in project .housekeeping.json.'; changed(); return false;
    }
    if (edit.confirm) {
      if (k.backspace) { edit.confirm = false; s.scroll = 0; }
      else if (k.downArrow || k.pageDown) s.scroll = Math.min(s.frame?.maxScroll ?? 0, s.scroll + (k.pageDown ? s.frame?.bodyHeight ?? 8 : 1));
      else if (k.upArrow || k.pageUp) s.scroll = Math.max(0, s.scroll - (k.pageUp ? s.frame?.bodyHeight ?? 8 : 1));
      changed(); return false;
    }
    if (k.tab || k.downArrow || k.upArrow) edit.field = (edit.field + (k.shift || k.upArrow ? FIELDS.length - 1 : 1)) % FIELDS.length;
    else if (k.ctrl && input === 'u') edit.values[edit.field] = '';
    else if (k.backspace || k.delete) edit.values[edit.field] = [...edit.values[edit.field]].slice(0, -1).join('');
    else if (!k.ctrl && !k.meta) edit.values[edit.field] += input.replace(/[\x00-\x1f\x7f]/g, '');
    changed(); return false;
  }
  async function key(input, k = {}) {
    if (s.settingsEdit) return settingsEditKey(input, k);
    if (s.housekeepingEdit) return housekeepingEditKey(input, k);
    if (s.priorityEdit) return priorityEditKey(input, k);
    if (s.routeEdit) return routeEditKey(input, k);
    if (s.picker) {
      const entries = pickerEntries(s);
      if (k.escape || (k.meta && k.leftArrow)) { s.focus = s.picker.returnFocus; s.picker = null; changed(); return false; }
      if (k.return) return activate(entries[s.picker.index]?.id ?? 'scope');
      if (k.downArrow || k.upArrow || k.tab) s.picker.index = (s.picker.index + (k.upArrow || k.shift ? -1 : 1) + entries.length) % entries.length;
      else if (k.backspace || k.delete) { s.picker.query = [...s.picker.query].slice(0, -1).join(''); s.picker.index = 0; }
      else if (input && !k.ctrl && !k.meta) { s.picker.query += input.replace(/[\x00-\x1f\x7f]/g, ''); s.picker.index = 0; }
      changed(); return false;
    }
    if (s.interactive) return false;
    if (k.ctrl && input === 'c') return true;
    if (s.compose) return composeKey(input, k);
    if (s.rename) return renameKey(input, k);
    if (s.act) return actKey(input, k);
    if (s.view === 'need' && !k.ctrl && !k.meta) {
      const n = currentNeed(), choices = needChoices(n), actions = needActions(n, { canOpen: true });
      const byKey = [...choices, ...actions].find(c => c.key === input);
      if (byKey) return activate(`choose:${byKey.id}`);
      // y takes the recommended choice when nothing is bound to y itself.
      if (input === 'y' && choices.some(c => c.recommended)) return activate(`choose:${choices.find(c => c.recommended).id}`);
    }
    if (s.view === 'overview' && /^[0-9]$/.test(input) && !k.ctrl && !k.meta) return digit(input);
    if (s.view === 'overview' && input === 'e' && s.focus?.startsWith('session:')) { startRename(s.focus.slice(8)); return false; }
    if (k.escape || (k.meta && k.leftArrow) || input === '\x1b[1;3D') return activate('back');
    if ((k.meta && k.rightArrow) || input === '\x1b[1;3C') return activate('forward');
    if (s.view === 'folder') {
      if (k.return) return activate('open-folder');
      if (k.backspace || k.delete) s.text = [...s.text].slice(0, -1).join('');
      else if (!k.ctrl && !k.meta && !k.tab && !k.upArrow && !k.downArrow) s.text += input.replace(/[\x00-\x1f\x7f]/g, '');
      changed(); return false;
    }
    if (input === 'q') return true;
    if (k.tab) { moveRegion(s, k.shift ? -1 : 1); changed(); return false; }
    if (k.return) return activate(s.focus);
    if (k.pageDown || k.pageUp) {
      if (s.view === 'output' && s.pane && d.observeTerminal && s.outputMode === 'mirror') await activate('transcript');
      const delta = (k.pageDown ? 1 : -1) * (s.frame?.bodyHeight ?? 10); if (s.view === 'output' && s.pane) s.outputScroll = Math.max(0, s.outputScroll - delta); else s.scroll = Math.max(0, Math.min(s.frame?.maxScroll ?? 0, s.scroll + delta)); changed(); return false;
    }
    if (s.view === 'output' && s.outputMode === 'mirror' && k.shift && (k.upArrow || k.downArrow)) {
      const limit = Math.max(0, (s.terminalFrame?.height ?? 0) - (s.screenViewport?.rows ?? 1));
      s.screenScroll = Math.min(limit, Math.max(0, s.screenScroll + (k.upArrow ? 3 : -3))); changed(); return false;
    }
    if (k.upArrow || input === 'k') { move(-1); return false; }
    if (k.downArrow || input === 'j') { move(1); return false; }
    if (k.leftArrow || k.rightArrow) {
      const direction = k.rightArrow ? 1 : -1;
      if (s.view === 'output' && s.outputMode === 'mirror' && k.shift) {
        const limit = Math.max(0, (s.terminalFrame?.width ?? 0) - (s.screenViewport?.cols ?? 1));
        s.outputX = Math.min(limit, Math.max(0, s.outputX + direction * 12)); changed(); return false;
      }
      if (s.view === 'output') {
        const tabs = model().tabs.filter(t => t.workspace_id === s.space), index = tabs.findIndex(t => t.tab_id === s.tab);
        const next = tabs[(index + direction + tabs.length) % tabs.length]; if (next) { await activate(`tab:${next.tab_id}`); s.focus = `tab:${next.tab_id}`; changed(); }
      } else {
        const views = ['overview', 'goals', 'tasks', 'activity', 'needs', 'control'], index = Math.max(0, views.indexOf(s.view));
        const next = views[(index + direction + views.length) % views.length]; await activate(`view:${next}`); s.focus = `view:${next}`; changed();
      }
      return false;
    }
    if (s.view === 'output' && (input === 'l' || input === 'v')) return activate(input === 'l' ? 'transcript' : 'mirror');
    if (s.view === 'output' && input === 'i') return activate('interact');
    const shortcut = { S: 'view:desks', H: 'view:housekeeping', P: 'view:priorities', c: 'view:control', u: 'view:routes', d: 'view:decided', f: 'view:asked', p: 'scope', h: 'view:overview', g: 'view:goals', t: 'view:tasks', a: 'view:activity', s: 'view:sessions', '!': 'view:needs', r: 'refresh', o: 'go', n: 'compose', b: 'back', '?': 'view:help', D: 'appearance', w: 'checkouts' }[input];
    if (shortcut) return activate(shortcut);
    return false;
  }
  async function mouse(event) {
    if (!event.press) return false;
    if (s.picker && ['back', 'forward'].includes(event.button)) return key('', { escape: true });
    if (s.picker && ['wheelDown', 'wheelUp'].includes(event.button)) return key('', { downArrow: event.button === 'wheelDown', upArrow: event.button === 'wheelUp' });
    if (event.button === 'back') return activate('back');
    if (event.button === 'forward') return activate('forward');
    if (s.interactive && (event.button === 'wheelDown' || event.button === 'wheelUp')) { observer?.scroll?.(event.button === 'wheelUp' ? 'up' : 'down', 3); return false; }
    if (event.button === 'wheelDown' || event.button === 'wheelUp') {
      if (s.view === 'output' && s.pane && d.observeTerminal && s.outputMode === 'mirror') await activate('transcript');
      const delta = event.button === 'wheelDown' ? 3 : -3;
      if (s.view === 'output' && s.pane) s.outputScroll = Math.max(0, s.outputScroll - delta);
      else s.scroll = Math.max(0, Math.min(s.frame?.maxScroll ?? 0, s.scroll + delta)); changed(); return false;
    }
    if (event.button !== 'left') return false;
    const target = s.frame?.hits?.[event.y]?.find(h => event.x >= h.from && event.x < h.to);
    if (s.picker) {
      if (target) return activate(target.id);
      s.focus = s.picker.returnFocus; s.picker = null; changed(); return false;
    }
    if (target) { s.focus = target.id; return activate(target.id); }
    return false;
  }
  // Raw terminal input while interactive: everything goes to the session except
  // mouse reports (the console's) and Ctrl+], which returns to the console.
  async function input(data) {
    if (!s.interactive) return false;
    const { back, bytes } = splitInput(data);
    if (bytes.length) observer?.input?.(bytes);
    if (back) await activate('back');
    return true;
  }
  return { frame, key, mouse, activate, refresh, input,
    async waitForOutput(timeout = 5000) {
      const until = Date.now() + timeout;
      while (d.observeTerminal && s.outputMode === 'mirror' && s.view === 'output' && s.pane && !s.terminalFrame && !s.outputError && !s.stopped && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    },
    async start() { s.timer = setInterval(() => refresh().catch(e => { s.message = e.message; changed(); }), config.refresh_seconds * 1000); s.outputTimer = setInterval(readOutput, 1500); return refresh(); },
    stop() { s.stopped = true; s.generation++; stopObserver(); clearInterval(s.timer); clearInterval(s.outputTimer); },
    get ui() { return s; }, set ui(value) { Object.assign(s, value); }, get project() { return project(); }, get model() { return model(); }, get data() { return data; },
  };
}
