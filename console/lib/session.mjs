// One console session: data for the current project, the UI state, and the effects
// keys and clicks ask for. No Ink here; the app renders session.frame() and forwards
// keys and mouse events.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cli from './cli.mjs';
import { readQueue } from './brain.mjs';
import { initialState, promptParts, reduce, reduceMouse } from './controller.mjs';
import { RAIL_COLS, hitAt, renderFrame } from './frame.mjs';
import {
  boardKeys, boardRows, buildBoard, hhmm, keepSelection, orderBoard, scopeItems, visibleBoard,
} from './model.mjs';
import { createRepoResolver } from './repos.mjs';
import { createSessionReader, ledgerFile, parseLedger, stopFileExists } from './sources.mjs';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${Math.round(m / 60)}h`;
}

const EMPTY = { waiting: [], groups: [], history: [], prefixes: undefined };

export function createSession({ config, projectIndex = 0, deps = {}, onChange = () => {}, env = process.env }) {
  const d = {
    orgToday: cli.orgToday,
    orgAnswer: cli.orgAnswer,
    herdrAgents: cli.herdrAgents,
    herdrTabs: cli.herdrTabs,
    brainQueue: config?.brain_bin ? () => readQueue(config.brain_bin) : null,
    herdrGo: cli.herdrGo,
    viewer: () => cli.viewerFor(),
    openBlocking: cli.openBlocking,
    openDetached: cli.openDetached,
    suspend: async (fn) => fn(),
    now: () => new Date(),
    repoOf: createRepoResolver(),
    reader: createSessionReader(),
    ...deps,
  };
  const noColor = Boolean(env.NO_COLOR);
  const s = {
    index: projectIndex,
    ui: initialState(),
    today: null,
    brain: { rows: [], off: true },
    todayAt: null,
    todayError: null,
    herdr: null,
    tabs: [],
    seen: new Map(), // agent name → when Herdr last listed it
    ledger: null,
    board: EMPTY,
    keys: null,
    listKeys: [],
    historyKeys: [],
    docs: new Map(),
    inflight: null,
    again: false,
    watcher: null,
    timer: null,
    size: { cols: 100, rows: 30 },
    last: { hits: [], popupMax: 0, bodyHeight: 10 },
    tempDirs: new Set(), // text documents handed to a viewer that returns at once
  };
  const project = () => config.projects[s.index];
  const configDirs = () => [...new Set(config.projects.flatMap((p) => p.claude_config_dirs ?? []))];

  function readLedger(now) {
    const p = project();
    if (!p.ledger_dir) return null;
    const date = s.today?.project?.day?.date ?? now.toLocaleDateString('sv');
    try {
      return { count: parseLedger(fs.readFileSync(ledgerFile(p.ledger_dir, date), 'utf8')).length, error: null };
    } catch (error) {
      return error.code === 'ENOENT' ? { count: 0, error: null } : { count: 0, error: `ledger unreadable: ${error.code ?? error.message}` };
    }
  }

  // A lookup by name reads transcripts written since the run started, else since local midnight.
  function transcriptOf(agent, run = null) {
    if (agent.tool && agent.tool !== 'claude') return null;
    if (!agent.session && !agent.name) return null;
    const started = run?.started ? Date.parse(run.started) : NaN;
    const midnight = Date.parse(s.today?.project?.day?.start ?? '') || new Date().setHours(0, 0, 0, 0);
    const sinceMs = Number.isNaN(started) ? midnight : started;
    try {
      return d.reader.transcript({ configDirs: configDirs(), cwd: agent.cwd, id: agent.session, name: agent.session ? null : agent.name, sinceMs });
    } catch {
      return null;
    }
  }

  function readText(file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    const cached = s.docs.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.text;
    let text = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      text = null;
    }
    s.docs.set(file, { mtimeMs: st.mtimeMs, text });
    return text;
  }

  const visible = () => visibleBoard(s.board, s.ui.scope);
  const rowsOf = (view) => boardRows(view === 'history' ? s.board : visible(), view);

  // Selection follows identity; a row that left the view gives way to its nearest neighbour.
  function keepCursor() {
    const list = rowsOf('list');
    const history = rowsOf('history');
    s.ui = {
      ...s.ui,
      selectedKey: keepSelection(s.ui.selectedKey, s.listKeys, list),
      historyKey: keepSelection(s.ui.historyKey, s.historyKeys, history),
    };
    s.listKeys = list.map((r) => r.key);
    s.historyKeys = history.map((r) => r.key);
  }

  function rebuild({ reorder = false } = {}) {
    const built = buildBoard({
      today: s.today,
      brain: s.brain,
      herdr: s.herdr,
      tabs: s.tabs,
      transcriptOf,
      repoOf: d.repoOf,
      briefOf: readText,
      nowMs: d.now().getTime(),
      seen: s.seen,
      fallbackCwd: project().cwd,
    });
    s.board = reorder || !s.keys ? built : orderBoard(built, s.keys);
    s.keys = boardKeys(s.board);
    keepCursor();
  }

  async function load({ reorder }) {
    const now = d.now();
    const [today, herdr, tabs, brain] = await Promise.all([
      d.orgToday(project()).then((doc) => ({ doc }), (error) => ({ error })),
      d.herdrAgents(),
      d.herdrTabs(),
      d.brainQueue ? d.brainQueue() : Promise.resolve({ rows: [], off: true }),
    ]);
    if (today.doc) {
      s.today = today.doc;
      s.todayAt = now;
      s.todayError = null;
    } else {
      s.todayError = today.error.message;
    }
    s.herdr = herdr;
    s.tabs = tabs ?? [];
    s.brain = brain ?? { rows: [], off: true };
    if (herdr.ok) for (const a of herdr.agents) if (a.name) s.seen.set(a.name, now.getTime());
    s.ledger = readLedger(now);
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

  function findRow(key) {
    if (!key) return null;
    return boardRows(s.board, 'list').find((r) => r.key === key) ?? s.board.history.find((r) => r.key === key) ?? null;
  }

  function document(file, text) {
    if (text) return { status: 'ok', text };
    if (!file) return null;
    const body = readText(file);
    return body === null ? { status: 'missing', message: fs.existsSync(file) ? `cannot read ${file}` : `file not found: ${file}` } : { status: 'ok', text: body };
  }

  function rowDocument(row) {
    if (!row) return null;
    if (row.doc.missing) return { status: 'missing', message: row.doc.missing };
    return document(row.doc.path, row.doc.text);
  }

  function header(now) {
    const p = project();
    const h = { project: p.name, clock: hhmm(now.toISOString()), waiting: s.board.waiting.length };
    if (!p.ledger_dir) h.sessionsNote = 'no session ledger';
    else if (s.ledger?.error) h.sessionsNote = s.ledger.error;
    else if (s.ledger) h.sessions = `${s.ledger.count}${p.session_cap ? `/${p.session_cap}` : ''}`;
    h.stop = stopFileExists(p.ledger_dir);
    h.alerts = s.today?.attention?.length ?? 0;
    if (s.herdr && !s.herdr.ok) h.herdr = 'Herdr unavailable';
    if (!s.today && s.todayError) h.stale = `org unreadable: ${s.todayError}`;
    else if (!s.today) h.stale = 'loading…';
    else if (s.todayError) h.stale = `org data ${ago(now - s.todayAt)} old (${s.todayError})`;
    else if (now - s.todayAt > 3 * config.refresh_seconds * 1000) h.stale = `org data ${ago(now - s.todayAt)} old`;
    const scope = s.ui.scope;
    if (scope.repo) h.scope = s.board.groups.find((g) => g.key === scope.repo)?.name ?? 'a repository';
    if (scope.view !== 'all') h.scope = `${h.scope ? `${h.scope}, ` : ''}${scope.view === 'needs' ? 'needs you' : 'working'}`;
    return h;
  }

  function view() {
    const now = d.now();
    const ui = s.ui;
    const popupRow = ui.popup?.key ? findRow(ui.popup.key) : null;
    const shownRepo = ui.scope.repo ? s.board.groups.find((g) => g.key === ui.scope.repo) : null;
    return {
      glyphs: noColor ? 'plain' : config.glyphs ?? 'nerd',
      version: VERSION,
      header: header(now),
      board: visible(),
      scopeItems: scopeItems(s.board),
      state: ui,
      prompt: promptParts(ui),
      selectedRow: findRow(ui.view === 'history' ? ui.historyKey : ui.selectedKey),
      popupRow,
      popupDoc: ui.popup?.kind === 'summary' && ui.popup.tab === 1 ? rowDocument(popupRow) : null,
      project: { org: project().org },
      launch: { where: shownRepo && ui.scope.view === 'all' ? shownRepo.name : null },
    };
  }

  function frame(cols, rows, options) {
    s.size = { cols, rows };
    const out = renderFrame(view(), cols, rows, options);
    const popup = s.ui.popup?.kind === 'summary' ? { ...s.ui.popup, scroll: Math.min(s.ui.popup.scroll, out.popupMax) } : s.ui.popup;
    s.ui = { ...s.ui, listOffset: out.listOffset, popup };
    s.last = { hits: out.hits, popupMax: out.popupMax, bodyHeight: Math.max(1, rows - 5) };
    return out;
  }

  const say = (message, messageStyle = 'status') => {
    s.ui = { ...s.ui, message, messageStyle };
    onChange();
  };

  async function open(file, text, label) {
    if (file && !fs.existsSync(file)) {
      say(`file not found: ${file}`, 'error');
      return;
    }
    const viewer = d.viewer();
    let dir = null;
    if (!file) {
      // A private folder and a new file: nothing else can own or redirect the name.
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-console-'));
      file = path.join(dir, `${label.replace(/[^\w-]+/g, '-')}.md`);
      fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
    }
    let r;
    try {
      r = viewer.blocking
        ? await d.suspend(() => d.openBlocking(viewer, file))
        : await d.openDetached(viewer, file);
    } finally {
      // A detached viewer may still be loading the file; it goes when the console stops.
      if (dir && viewer.blocking) fs.rmSync(dir, { recursive: true, force: true });
      else if (dir) s.tempDirs.add(dir);
    }
    say(r.ok ? `Opened in ${viewer.label}: ${file}` : `Could not open ${file}: ${r.error}`, r.ok ? 'status' : 'error');
  }

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
        s.board = EMPTY;
        s.keys = null;
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
      case 'go': {
        const row = findRow(effect.key);
        if (!row) {
          say('That session is no longer listed; nothing to go to.', 'error');
          return;
        }
        if (!s.herdr?.ok) {
          say(`Cannot go to ${row.session}: Herdr unavailable${s.herdr?.error ? ` (${s.herdr.error})` : ''}.`, 'error');
          return;
        }
        if (!row.go) {
          say(`${row.session} is gone; there is no Herdr tab to go to.`, 'error');
          return;
        }
        const r = await d.herdrGo(row.go);
        say(r.ok ? `Went to ${row.session} in Herdr.` : `Herdr refused to go to ${row.session}: ${r.error}`, r.ok ? 'ok' : 'error');
        return;
      }
      case 'open': {
        const row = findRow(effect.key);
        if (!row) {
          say('That row is no longer listed.', 'warn');
          return;
        }
        if (row.kind === 'session' && effect.tab === 0) {
          const note = row.transcript?.note;
          if (!note) {
            say('No message to open for this session.', 'warn');
            return;
          }
          await open(null, note.text, `${row.session}-message`);
          return;
        }
        if (row.doc.missing) {
          say(`No document to open: ${row.doc.missing}.`, 'warn');
          return;
        }
        await open(row.doc.path ?? null, row.doc.text ?? null, row.key);
        return;
      }
      default:
        return;
    }
  }

  function ctx() {
    const rows = rowsOf(s.ui.view);
    const hits = s.last.hits;
    return {
      rows,
      historyRows: rowsOf('history'),
      scopeItems: scopeItems(s.board),
      listPage: Math.max(1, s.last.bodyHeight - 2),
      popupPage: Math.max(1, s.last.bodyHeight - 6),
      popupMax: s.last.popupMax,
      projectCount: config.projects.length,
      menuX: s.size.cols >= RAIL_COLS ? 27 : 4,
      lineOf: (key) => {
        const y = hits.findIndex((line) => line.some((h) => h.target?.type === 'row' && h.target.key === key));
        return y < 0 ? 2 : y;
      },
      hitAt: (x, y) => hitAt(hits, x, y),
    };
  }

  async function apply({ state, effects }) {
    s.ui = state;
    keepCursor();
    onChange();
    let quit = false;
    for (const effect of effects) {
      if (effect.type === 'quit') quit = true;
      else await perform(effect);
    }
    return quit;
  }

  // Each returns true when the console should quit.
  const key = (input, k = {}) => apply(reduce(s.ui, input, k, ctx()));
  const mouse = (event) => apply(reduceMouse(s.ui, event, ctx()));

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
    for (const dir of s.tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    s.tempDirs.clear();
  }

  return {
    start, stop, refresh, key, mouse, frame, perform,
    get ui() { return s.ui; },
    set ui(value) { s.ui = value; },
    get board() { return s.board; },
    get project() { return project(); },
    rows: (view = s.ui.view) => rowsOf(view),
  };
}
