// Opt-in live reader. It never dispatches, invokes a model, or writes org/config.
import * as cli from '../lib/cli.mjs';
import { readQueue } from '../lib/brain.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { catalog, createIdentityReader, folderPath, projectView, workspaceIdentity } from './model.mjs';
import { renderModern } from './frame.mjs';
import { moveRegion, moveWithin, pickerEntries } from './navigation.mjs';
import { observeTerminal } from './terminal.mjs';
const exec = promisify(execFile);

async function gitSummary(cwd) {
  if (!cwd) return null;
  const { stdout } = await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', cwd, 'status', '--short', '--branch', '--untracked-files=normal'], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const [branch, ...changes] = stdout.trimEnd().split('\n');
  return { branch: branch?.replace(/^## /, ''), changes: changes.length };
}

export function createModernSession({ config, configFile, projectIndex = 0, deps = {}, onChange = () => {}, env = process.env }) {
  const d = { identity: createIdentityReader(), orgToday: cli.orgToday, orgStatus: cli.orgStatus, herdrAgents: cli.herdrAgents, herdrList: cli.herdrList,
    herdrRead: cli.herdrRead, herdrGo: cli.herdrGo, gitSummary, folderPath,
    observeTerminal: deps.herdrRead ? null : observeTerminal,
    brainQueue: () => readQueue(config.brain_bin, { configFile, env }), now: () => Date.now(), ...deps };
  const data = { workspaces: [], tabs: [], agents: [], today: null, status: null, brain: { rows: [], off: true } };
  const s = { projects: [], projectId: config.projects[projectIndex] ? config.projects[projectIndex].id ?? `configured:${config.projects[projectIndex].name}` : null,
    view: 'overview', detail: null, space: null, tab: null, pane: null, focus: 'scope', scroll: 0, outputScroll: 0,
    appearance: env.HERDR_CONSOLE_THEME === 'dark' ? 'dark' : 'light',
    showCheckouts: env.HERDR_CONSOLE_SIDEBAR ? env.HERDR_CONSOLE_SIDEBAR === '1' : env.HERDR_ENV !== '1',
    picker: null, regionFocus: {}, outputX: 0, screenScroll: 0,
    outputMode: 'mirror', terminalFrame: null, screenViewport: null, dimensions: { cols: 100, rows: 32 },
    history: [], future: [], opened: [], errors: {}, times: {}, cache: new Map(), text: '', output: null, outputError: null, outputAt: null, git: null, message: '',
    frame: null, stopped: false, timer: null, outputTimer: null, pending: null, generation: 0, reading: false, loading: true };
  const project = () => s.projects.find(p => p.id === s.projectId) ?? null;
  const model = () => projectView(project(), data, d.identity);
  const route = () => ({ projectId: s.projectId, view: s.view, detail: s.detail, space: s.space, tab: s.tab, pane: s.pane, focus: s.focus, scroll: s.scroll, outputScroll: s.outputScroll, outputMode: s.outputMode, outputX: s.outputX, screenScroll: s.screenScroll, text: s.text });
  const routeKey = r => JSON.stringify([r.projectId, r.view, r.detail, r.view === 'output' ? [r.space, r.tab, r.pane] : null]);
  const changed = () => { if (!s.stopped) onChange(); };
  let observer = null, observerKey = null, observerRetryAt = 0, observerEpoch = 0;
  function stopObserver() { observerEpoch++; observerKey = null; observer?.stop(); observer = null; }
  function ensureObserver() {
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
    Object.assign(s, next, { scroll: 0, outputScroll: 0, outputX: 0, screenScroll: 0, message: '', focus: next.focus ?? 'back' });
    s.output = null; s.outputError = null; s.outputAt = null; s.git = null; s.generation++;
    stopObserver(); s.terminalFrame = null; s.screenViewport = null; s.outputMode = 'mirror'; observerRetryAt = 0;
    changed();
  }
  async function restore(from, to) {
    if (!from.length) return;
    const prior = from.pop(), oldProject = s.projectId;
    to.push(route()); Object.assign(s, prior); s.output = null; s.outputError = null; s.outputAt = null; s.git = null; s.generation++;
    stopObserver(); s.terminalFrame = null; s.screenViewport = null; observerRetryAt = 0;
    if (oldProject !== s.projectId) { adoptProject(); await refresh(); }
    await readOutput(); changed();
  }
  function adoptProject() {
    const cached = s.cache.get(s.projectId);
    data.today = cached?.today ?? null; data.status = cached?.status ?? null;
    for (const key of ['today', 'status']) { delete s.errors[key]; s.times[key] = cached?.times?.[key] ?? null; }
  }
  async function readOutput() {
    if (s.view !== 'output' || !s.pane || s.reading || s.stopped) return;
    const pane = s.pane, generation = s.generation;
    if (s.errors.agents || s.errors.workspaces || s.errors.tabs) { stopObserver(); s.outputError = 'Herdr is unavailable. Last output is retained; refresh to reconnect.'; changed(); return; }
    const m = model();
    if (!m.sessions.some(a => a.pane === pane && a.tab === s.tab)) { stopObserver(); s.outputError = 'This agent is no longer in this tab. Choose a current session.'; changed(); return; }
    if (d.observeTerminal && s.outputMode === 'mirror') {
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
        load('agents', async () => { const r = await d.herdrAgents(); if (!r.ok) throw Error(r.error); return r.agents; }, x => data.agents = x),
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
      if (p?.org && (selected === s.projectId || selected === null)) {
        const id = p.id, cached = s.cache.get(id) ?? { times: {} };
        await Promise.all(['today', 'status'].map(async key => {
          try { const value = await (key === 'today' ? d.orgToday(p) : d.orgStatus(p)); cached[key] = value; cached.times[key] = d.now();
            if (s.projectId === id) { data[key] = value; delete s.errors[key]; s.times[key] = cached.times[key]; }
          } catch (e) { if (s.projectId === id) s.errors[key] = e.message; }
        }));
        s.cache.set(id, cached);
      } else if (!p?.org) { data.today = null; data.status = null; delete s.errors.today; delete s.errors.status; }
      s.loading = false;
    })().finally(() => { s.pending = null; changed(); });
    await s.pending;
    // A project switch during IO must not leave the new scope with the old data.
    if (selected !== s.projectId && selected !== null) return refresh();
    await readOutput();
    if (s.view === 'output') {
      const generation = s.generation, w = data.workspaces.find(w => w.workspace_id === s.space);
      try { const git = await d.gitSummary(w?.worktree?.checkout_path); if (generation === s.generation) s.git = git; } catch { if (generation === s.generation) s.git = null; }
      changed();
    }
  }
  async function activate(id) {
    const m = model();
    if (id === 'home') return activate('view:overview');
    if (id === 'checkouts') { s.showCheckouts = !s.showCheckouts; s.focus = s.showCheckouts ? `space:${m.spaces[0]?.workspace_id}` : 'checkouts'; changed(); return; }
    if (id === 'scope') {
      if (s.picker) { s.focus = s.picker.returnFocus; s.picker = null; }
      else s.picker = { index: Math.max(0, s.projects.findIndex(p => p.id === s.projectId)), query: '', returnFocus: s.focus };
      changed(); return;
    }
    if (s.picker) { s.focus = s.picker.returnFocus; s.picker = null; }
    if (id === 'appearance') { s.appearance = s.appearance === 'dark' ? 'light' : 'dark'; changed(); return; }
    if (id === 'unavailable') { s.message = 'Read-only trial: use the existing org console for actions; Herdr for new chats.'; changed(); return; }
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
    if (id.startsWith('view:')) { const view = id.slice(5); const first = { goals: m.goals[0] && `item:${m.goals[0].id}`, tasks: m.tasks[0] && `item:${m.tasks[0].id}`, needs: m.needs[0] && `need:${m.needs[0].key}`, later: m.later[0] && `need:${m.later[0].key}`, parked: m.parked[0] && `need:${m.parked[0].key}`, sessions: m.sessions[0] && `session:${m.sessions[0].pane}` }; navigate({ view, detail: null, focus: first[view] ?? id }); return; }
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
      navigate({ view: 'output', detail: null, space: row.space, tab: row.tab, pane: row.pane }); await readOutput(); return refresh();
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
  async function openTab(space, tab) {
    const agents = model().sessions.filter(a => a.tab === tab);
    // A split with several agents needs an explicit choice, never an arbitrary first agent.
    navigate({ view: 'output', detail: null, space, tab, pane: agents.length === 1 ? agents[0].pane : null });
    await readOutput(); return refresh();
  }
  function frame(cols, rows) {
    s.dimensions = { cols, rows };
    s.frame = renderModern({ state: s, project: project(), model: model(), config, now: d.now() }, cols, rows);
    return s.frame;
  }
  function move(amount) { moveWithin(s, amount); changed(); }
  async function key(input, k = {}) {
    if (s.picker) {
      const entries = pickerEntries(s);
      if (k.escape || (k.meta && k.leftArrow)) { s.focus = s.picker.returnFocus; s.picker = null; changed(); return false; }
      if (k.return) return activate(entries[s.picker.index]?.id ?? 'scope');
      if (k.downArrow || k.upArrow || k.tab) s.picker.index = (s.picker.index + (k.upArrow || k.shift ? -1 : 1) + entries.length) % entries.length;
      else if (k.backspace || k.delete) { s.picker.query = [...s.picker.query].slice(0, -1).join(''); s.picker.index = 0; }
      else if (input && !k.ctrl && !k.meta) { s.picker.query += input.replace(/[\x00-\x1f\x7f]/g, ''); s.picker.index = 0; }
      changed(); return false;
    }
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
        const views = ['overview', 'goals', 'tasks', 'needs'], index = Math.max(0, views.indexOf(s.view));
        const next = views[(index + direction + views.length) % views.length]; await activate(`view:${next}`); s.focus = `view:${next}`; changed();
      }
      return false;
    }
    if (s.view === 'output' && (input === 'l' || input === 'v')) return activate(input === 'l' ? 'transcript' : 'mirror');
    const shortcut = { p: 'scope', h: 'view:overview', g: 'view:goals', t: 'view:tasks', s: 'view:sessions', '!': 'view:needs', r: 'refresh', o: 'go', b: 'back', '?': 'view:help', D: 'appearance', w: 'checkouts' }[input];
    if (shortcut) return activate(shortcut);
    return false;
  }
  async function mouse(event) {
    if (!event.press) return false;
    if (s.picker && ['back', 'forward'].includes(event.button)) return key('', { escape: true });
    if (s.picker && ['wheelDown', 'wheelUp'].includes(event.button)) return key('', { downArrow: event.button === 'wheelDown', upArrow: event.button === 'wheelUp' });
    if (event.button === 'back') return activate('back');
    if (event.button === 'forward') return activate('forward');
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
  return { frame, key, mouse, activate, refresh,
    async waitForOutput(timeout = 5000) {
      const until = Date.now() + timeout;
      while (d.observeTerminal && s.outputMode === 'mirror' && s.view === 'output' && s.pane && !s.terminalFrame && !s.outputError && !s.stopped && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    },
    async start() { s.timer = setInterval(() => refresh().catch(e => { s.message = e.message; changed(); }), config.refresh_seconds * 1000); s.outputTimer = setInterval(readOutput, 1500); return refresh(); },
    stop() { s.stopped = true; s.generation++; stopObserver(); clearInterval(s.timer); clearInterval(s.outputTimer); },
    get ui() { return s; }, set ui(value) { Object.assign(s, value); }, get project() { return project(); }, get model() { return model(); }, get data() { return data; },
  };
}
