// Minimal has read effects only: no full-console actions, queues or model calls.
import fs from 'node:fs';
import { herdrAgents, herdrList, orgStatus } from '../lib/cli.mjs';
import { createSessionReader } from '../lib/sources.mjs';
import { catalog, createIdentityReader, workspaceIdentity } from './model.mjs';
import { minimalRows, minimalFrame } from './minimal.mjs';

export function createMinimalSession({ config, projectIndex = 0, deps = {}, onChange = () => {}, env = process.env }) {
  const reader = createSessionReader();
  const d = { herdrAgents, herdrList, orgStatus, identity: createIdentityReader(), now: Date.now,
    details(agent, run, project) {
      const lane = reader.laneSession({ repoRoot: project.root, name: agent.name, sessionId: agent.session });
      const transcript = /claude/i.test(agent.tool ?? '') ? reader.transcript({ configDirs: project.claude_config_dirs ?? [], cwd: agent.cwd, id: agent.session }) : null;
      let dispatch = null;
      if (run?.meta?.dispatch_journal) { try { dispatch = JSON.parse(fs.readFileSync(run.meta.dispatch_journal, 'utf8')); } catch {} }
      return { lane, transcript, dispatch };
    }, ...deps };
  const ui = { appearance: env.HERDR_CONSOLE_THEME === 'light' ? 'light' : 'dark', errors: {}, loading: true, stopped: false };
  const data = { agents: [], workspaces: [], panes: [], tabs: [], status: null };
  let project = null, pending = null, timer = null;
  let facts = new Map();
  const model = () => ({ sessions: minimalRows({ ...data, project, identity: d.identity, details: a => facts.get(a.pane), now: d.now() }) });
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
      project = projects.find(p => selected ? p.name === selected.name : p.repoKey === currentKey) ?? projects[0] ?? null;
      if (project?.org) await read('status', () => d.orgStatus(project));
      else { data.status = null; delete ui.errors.status; }
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
