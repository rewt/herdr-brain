// One console session: data for the current project, the UI state, and the effects
// keys ask for. No Ink here; the app renders session.frame() and forwards keys.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cli from './cli.mjs';
import { initialState, promptText, reduce } from './controller.mjs';
import { heights, renderFrame } from './frame.mjs';
import { buildRows, flatRows, hhmm, keepSelection, orderKeys, orderSections } from './model.mjs';
import { createSessionReader, stopFileExists } from './sources.mjs';

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${Math.round(m / 60)}h`;
}

export function createSession({ config, projectIndex = 0, deps = {}, onChange = () => {} }) {
  const d = {
    orgToday: cli.orgToday,
    orgAnswer: cli.orgAnswer,
    herdrAgents: cli.herdrAgents,
    herdrFocus: cli.herdrFocus,
    viewer: () => cli.viewerFor(),
    openBlocking: cli.openBlocking,
    openDetached: cli.openDetached,
    suspend: async (fn) => fn(),
    now: () => new Date(),
    ...deps,
  };
  const reader = createSessionReader();
  const s = {
    index: projectIndex,
    ui: initialState(),
    today: null,
    todayAt: null,
    todayError: null,
    herdr: null,
    notes: null,
    sections: [],
    order: null,
    docs: new Map(),
    inflight: null,
    again: false,
    watcher: null,
    timer: null,
    size: { cols: 100, rows: 30 },
    lastReaderMax: 0,
  };
  const project = () => config.projects[s.index];

  function readSessions(now) {
    const p = project();
    if (!p.ledger_dir) return null;
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const date = s.today?.project?.day?.date ?? start.toLocaleDateString('sv');
    return reader.notes({ ledgerDir: p.ledger_dir, date, configDirs: p.claude_config_dirs, cwd: p.cwd ?? '/', sinceMs: start.getTime() });
  }

  function rebuild({ reorder = false } = {}) {
    const previousKeys = flatRows(s.sections).map((r) => r.key);
    const built = buildRows({ today: s.today, herdr: s.herdr, sessions: s.notes, cwd: project().cwd });
    s.sections = reorder ? built : orderSections(built, s.order);
    s.order = orderKeys(s.sections);
    s.ui = { ...s.ui, selectedKey: keepSelection(s.ui.selectedKey, previousKeys, flatRows(s.sections)) };
  }

  async function load({ reorder }) {
    const now = d.now();
    const [today, herdr] = await Promise.all([
      d.orgToday(project()).then((doc) => ({ doc }), (error) => ({ error })),
      d.herdrAgents(),
    ]);
    if (today.doc) {
      s.today = today.doc;
      s.todayAt = now;
      s.todayError = null;
    } else {
      s.todayError = today.error.message;
    }
    s.herdr = herdr;
    s.notes = readSessions(now);
    rebuild({ reorder });
  }

  // Coalesces overlapping refreshes: one runs, and one more follows if asked meanwhile.
  async function refresh({ reorder = false } = {}) {
    if (s.inflight) {
      s.again = true;
      return s.inflight;
    }
    s.inflight = (async () => {
      try {
        do {
          s.again = false;
          await load({ reorder });
          reorder = false;
        } while (s.again);
      } finally {
        s.inflight = null;
      }
      onChange();
    })();
    return s.inflight;
  }

  function selectedRow() {
    return flatRows(s.sections).find((r) => r.key === s.ui.selectedKey) ?? null;
  }

  function document(row) {
    if (!row) return null;
    if (row.doc.missing) return { status: 'missing', message: row.doc.missing };
    if (row.doc.text) return { status: 'ok', text: row.doc.text };
    const file = row.doc.path;
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return { status: 'missing', message: `file not found: ${file}` };
    }
    const cached = s.docs.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.doc;
    let doc;
    try {
      doc = { status: 'ok', text: fs.readFileSync(file, 'utf8'), path: file };
    } catch (error) {
      doc = { status: 'missing', message: `cannot read ${file}: ${error.code ?? error.message}` };
    }
    s.docs.set(file, { mtimeMs: st.mtimeMs, doc });
    return doc;
  }

  function header(now) {
    const p = project();
    const h = { project: p.name, clock: hhmm(now.toISOString()) };
    if (!p.ledger_dir) h.sessions = 'no session ledger configured';
    else if (s.notes?.error) h.sessions = s.notes.error;
    else if (s.notes) h.sessions = `${s.notes.count}${p.session_cap ? `/${p.session_cap}` : ''} sessions today`;
    h.stop = stopFileExists(p.ledger_dir);
    h.alerts = s.today?.attention?.length ?? 0;
    if (s.herdr && !s.herdr.ok) h.herdr = 'Herdr unavailable';
    if (!s.today && s.todayError) h.age = `org unreadable: ${s.todayError}`;
    else if (!s.today) h.age = 'loading…';
    else if (s.todayError) h.age = `org data ${ago(now - s.todayAt)} old (${s.todayError})`;
    else if (now - s.todayAt > 3 * config.refresh_seconds * 1000) h.age = `org data ${ago(now - s.todayAt)} old`;
    return h;
  }

  function view(cols, rows) {
    const now = d.now();
    const row = selectedRow();
    return {
      header: header(now),
      sections: s.sections,
      selected: row,
      focus: s.ui.focus,
      tab: s.ui.tab,
      expanded: s.ui.expanded,
      readerScroll: s.ui.readerScroll,
      listOffset: s.ui.listOffset,
      help: s.ui.help,
      document: s.ui.tab === 1 ? document(row) : null,
      project: { org: project().org },
      message: s.ui.message,
      messageStyle: s.ui.messageStyle,
      prompt: promptText(s.ui),
      projectCount: config.projects.length,
      rows, cols,
    };
  }

  function frame(cols, rows) {
    s.size = { cols, rows };
    const out = renderFrame(view(cols, rows), cols, rows);
    s.ui = { ...s.ui, listOffset: out.listOffset, readerScroll: Math.min(s.ui.readerScroll, out.readerMax) };
    s.lastReaderMax = out.readerMax;
    return out;
  }

  const say = (message, messageStyle = 'status') => {
    s.ui = { ...s.ui, message, messageStyle };
    onChange();
  };

  async function perform(effect) {
    const p = project();
    switch (effect.type) {
      case 'reload':
        await refresh({ reorder: true });
        say('Reloaded.');
        return;
      case 'project':
        s.index = (s.index + 1) % config.projects.length;
        s.today = null;
        s.todayError = null;
        s.sections = [];
        s.order = null;
        s.ui = { ...initialState(), message: `Project: ${project().name}` };
        restartWatch();
        onChange();
        await refresh({ reorder: true });
        return;
      case 'answer': {
        const r = await d.orgAnswer(p, effect);
        if (!r.ok) {
          say(`Not recorded: ${r.error}`, 'error');
          return;
        }
        await refresh();
        say(`Recorded ${effect.answer} for “${effect.headline}”. The next executive pass acts on it.`, 'ok');
        return;
      }
      case 'focus': {
        if (!s.herdr?.ok) {
          say(`Cannot go to the agent: Herdr unavailable${s.herdr?.error ? ` (${s.herdr.error})` : ''}.`, 'error');
          return;
        }
        if (!s.herdr.agents.some((a) => a.name === effect.agent)) {
          say(`That agent is gone (${effect.agent}); nothing to focus.`, 'error');
          return;
        }
        const r = await d.herdrFocus(effect.agent);
        say(r.ok ? `Focused ${effect.agent}.` : `Herdr refused to focus ${effect.agent}: ${r.error}`, r.ok ? 'ok' : 'error');
        return;
      }
      case 'open': {
        let file = effect.path;
        if (file && !fs.existsSync(file)) {
          say(`file not found: ${file}`, 'error');
          return;
        }
        if (!file) {
          file = path.join(os.tmpdir(), `herdr-console-${effect.row.replace(/[^\w-]+/g, '-')}.md`);
          fs.writeFileSync(file, effect.text);
        }
        const viewer = d.viewer();
        const r = viewer.blocking
          ? await d.suspend(() => d.openBlocking(viewer, file))
          : await d.openDetached(viewer, file);
        say(r.ok ? `Opened in ${viewer.label}: ${file}` : `Could not open ${file}: ${r.error}`, r.ok ? 'status' : 'error');
        return;
      }
      default:
        return;
    }
  }

  // Returns true when the console should quit.
  async function key(input, k = {}) {
    const rows = flatRows(s.sections);
    const h = heights(Math.max(1, s.size.rows), s.ui.expanded);
    const { state, effects } = reduce(s.ui, input, k, {
      rows,
      listPage: Math.max(1, h.list - 2),
      readerPage: Math.max(1, h.reader - 1),
      readerMax: s.lastReaderMax,
      projectCount: config.projects.length,
    });
    s.ui = state;
    onChange();
    let quit = false;
    for (const effect of effects) {
      if (effect.type === 'quit') quit = true;
      else await perform(effect);
    }
    return quit;
  }

  function restartWatch() {
    s.watcher?.close();
    s.watcher = null;
    let debounce = null;
    try {
      s.watcher = fs.watch(path.join(project().org, 'events.jsonl'), () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => refresh(), 250);
      });
      s.watcher.on('error', () => {});
    } catch {
      // The interval below still refreshes.
    }
  }

  function start() {
    restartWatch();
    s.timer = setInterval(() => refresh(), config.refresh_seconds * 1000);
    return refresh({ reorder: true });
  }

  function stop() {
    s.watcher?.close();
    clearInterval(s.timer);
  }

  return {
    start, stop, refresh, key, frame, perform,
    get ui() { return s.ui; },
    set ui(value) { s.ui = value; },
    get sections() { return s.sections; },
    get project() { return project(); },
  };
}
