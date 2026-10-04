// Minimal has read effects only: no full-console actions, queues or model calls.
import fs from 'node:fs';
import { herdrAgents, herdrList, orgStatus } from '../lib/cli.mjs';
import { createSessionReader } from '../lib/sources.mjs';
import { catalog, createIdentityReader, workspaceIdentity } from './model.mjs';
import { minimalRows, minimalFrame } from './minimal.mjs';
import { createFeedReader, reportFeed } from './feed.mjs';

export function createMinimalSession({ config, projectIndex = 0, deps = {}, onChange = () => {}, env = process.env }) {
  const reader = createSessionReader();
  const feed = createFeedReader();
  const d = { herdrAgents, herdrList, orgStatus, identity: createIdentityReader(), now: Date.now,
    journal: feed.journal, train: feed.train,
    details(agent, run, project) {
      const lane = reader.laneSession({ repoRoot: project.root, name: agent.name, sessionId: agent.session });
      const transcript = /claude/i.test(agent.tool ?? '') ? reader.transcript({ configDirs: project.claude_config_dirs ?? [], cwd: agent.cwd, id: agent.session }) : null;
      let dispatch = null;
      if (run?.meta?.dispatch_journal) { try { dispatch = JSON.parse(fs.readFileSync(run.meta.dispatch_journal, 'utf8')); } catch {} }
      return { lane, transcript, dispatch };
    }, ...deps };
  const ui = { appearance: env.HERDR_CONSOLE_THEME === 'light' ? 'light' : 'dark', errors: {}, loading: true, stopped: false };
  const data = { agents: [], workspaces: [], panes: [], tabs: [], status: null, journal: [], train: {} };
  let project = null, pending = null, timer = null;
  let facts = new Map();
  const model = () => ({ sessions: minimalRows({ ...data, project, identity: d.identity, details: a => facts.get(a.pane), now: d.now() }),
    reports: reportFeed(data.status, data.journal), train: data.train });
  async function refresh() {
    if (pending) return pending;
    pending = (async () => {
      const read = async (key, fn) => {
        try { const value = await fn(); if (ui.stopped) return; data[key] = value; delete ui.errors[key]; }
        catch (e) { if (!ui.stopped) ui.errors[key] = e.message; }
      };
      await Promise.all([
        read('agents', async () => { const r = await d.herdrAgents(); if (!r.ok) throw Error(r.error); return r.agents; }),
        ...['workspace', 'pane', 'tab'].map(resource => read(`${resource}s`, () => d.herdrList(resource))),
      ]);
      if (ui.stopped) return;
      const projects = catalog(config.projects, data.workspaces, d.identity, [], data.agents);
      const selected = config.projects[projectIndex];
      const current = data.workspaces.find(w => w.workspace_id === env.HERDR_WORKSPACE_ID);
      const currentKey = current && workspaceIdentity(current, d.identity)?.key;
      const selectedKey = selected && (selected.identity ?? d.identity(selected.cwd)?.key);
      const nextProject = selected ? projects.find(p => p.id === selected.id && p.repoKey === selectedKey)
        ?? projects.find(p => p.repoKey === selectedKey && p.cwd === selected.cwd && p.org === selected.org)
        : projects.find(p => p.repoKey === currentKey) ?? projects[0] ?? null;
      if (project?.repoKey !== nextProject?.repoKey || project?.org !== nextProject?.org) {
        data.status = null; data.journal = []; data.train = {}; facts = new Map();
        for (const source of ['status', 'journal', 'train']) delete ui.errors[source];
      }
      project = nextProject ?? null;
      await Promise.all([
        project?.org ? read('status', () => d.orgStatus(project)) : Promise.resolve().then(() => { data.status = null; delete ui.errors.status; }),
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
      ui.loading = false;
      if (!ui.stopped) onChange();
    })().finally(() => { pending = null; });
    return pending;
  }
  return {
    refresh,
    async start() { timer = setInterval(() => refresh().catch(e => { ui.errors.sessions = e.message; if (!ui.stopped) onChange(); }), config.refresh_seconds * 1000); return refresh(); },
    stop() { ui.stopped = true; clearInterval(timer); },
    async key(input, key = {}) { return input === 'q' || (input === 'c' && Boolean(key.ctrl)); },
    async mouse() { return false; },
    frame(cols, rows) { return minimalFrame({ project, ...model(), ...ui, now: d.now() }, cols, rows); },
    get ui() { return ui; }, set ui(value) { Object.assign(ui, value); },
    get project() { return project; }, get model() { return model(); },
  };
}
