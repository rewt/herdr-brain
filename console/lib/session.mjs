// One console session: data for the current project, the UI state, and the effects
// keys and clicks ask for. No Ink here; the app renders session.frame() and forwards
// keys and mouse events.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cli from './cli.mjs';
import { brainAct, brainArgs, explainQuestion, loopStatus, loopWords, readQueue, setLoop, startWorkUp } from './brain.mjs';
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

const EMPTY = { waiting: [], otherWaiting: [], groups: [], history: [], prefixes: undefined };

export function createSession({ config, configFile = null, projectIndex = 0, deps = {}, onChange = () => {}, env = process.env }) {
  const d = {
    orgToday: cli.orgToday,
    orgAnswer: cli.orgAnswer,
    herdrAgents: cli.herdrAgents,
    herdrTabs: cli.herdrTabs,
    brainQueue: config?.brain_bin ? () => readQueue(config.brain_bin, { configFile, env }) : null,
    brainAct: (args) => brainAct(config?.brain_bin, args),
    loopStatus: config?.brain_bin ? () => loopStatus(config.brain_bin) : async () => null,
    setLoop: (on) => setLoop(config?.brain_bin, on),
    herdrGo: cli.herdrGo,
    herdrRead: cli.herdrRead,
    herdrPrompt: cli.herdrPrompt,
    dispatch: config?.brain_bin ? (project, row) => startWorkUp(config.brain_bin, project, row) : null,
    orgNote: cli.orgNote,
    explain: config?.brain_bin && config.explain !== false ? (project, id) => explainQuestion(config.brain_bin, project.org, id, { orgBin: cli.ORG_BIN }) : null,
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
  // Summoned as a Herdr popup: no pane of its own, and closing it (Esc, q, or
  // going to a session) hands the screen back to the pane underneath.
  const popupMode = env.HERDR_CONSOLE_POPUP === '1' || (!env.HERDR_PANE_ID && Boolean(env.HERDR_ACTIVE_PANE_ID));
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
    peek: null, // { key, target, text, error, gone, at } while a peek is open
    peekTimer: null,
    explanations: new Map(), // org question id → its reading in plain words (brain explain)
    explaining: null,
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

  function laneSessionOf(agent, repo) {
    try {
      return d.reader.laneSession({ repoRoot: repo.root, name: agent.name, sessionId: agent.session });
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

  const visible = () => visibleBoard(s.board, s.ui.scope, s.ui.unfolded ?? []);
  const rowsOf = (view) => boardRows(view === 'history' ? s.board : visible(), view);

  // Selection follows identity; a row that left the view gives way to its nearest neighbour.
  function keepCursor() {
    followPeek();
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
      laneSessionOf,
      nowMs: d.now().getTime(),
      seen: s.seen,
      fallbackCwd: project().cwd,
      explanations: s.explanations,
      explaining: s.explaining,
      projectName: project().name,
      projectNames: config.projects.map((p) => p.name),
    });
    s.board = reorder || !s.keys ? built : orderBoard(built, s.keys);
    s.keys = boardKeys(s.board);
    keepCursor();
  }

  async function load({ reorder }) {
    const now = d.now();
    const [today, herdr, tabs, brain, loop] = await Promise.all([
      d.orgToday(project()).then((doc) => ({ doc }), (error) => ({ error })),
      d.herdrAgents(),
      d.herdrTabs(),
      d.brainQueue ? d.brainQueue() : Promise.resolve({ rows: [], off: true }),
      d.loopStatus().catch(() => null),
    ]);
    s.loop = loop;
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
    wantExplanations();
  }

  // Questions on screen that nobody has read in plain words get one reading
  // each, one at a time, in the background. brain caches them, so a restart
  // costs nothing; parked questions are read only once their fold is opened.
  function wantExplanations() {
    if (!d.explain || s.explaining) return;
    const next = visible().waiting.find((r) => r.kind === 'question' && !s.explanations.has(r.question));
    if (!next) return;
    const id = next.question;
    const index = s.index;
    s.explaining = id;
    rebuild();
    onChange();
    d.explain(project(), id).then((r) => r, (error) => ({ ok: false, error: error.message })).then((r) => {
      s.explaining = null;
      if (s.index !== index) return;
      // A failed reading is remembered as failed, so it is not retried every tick.
      s.explanations.set(id, r?.ok ? r : { failed: true, error: r?.error });
      rebuild();
      onChange();
      wantExplanations();
    });
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

  // ---- the peek ------------------------------------------------------------

  // Who a row's screen belongs to: its Herdr agent by name, else its pane.
  function peekTarget(row) {
    if (!row) return null;
    if (row.go?.agent || row.go?.pane) return { agent: row.go.agent ?? null, pane: row.go.pane ?? null };
    return null;
  }

  // Once a result is answered it leaves Waiting on you, but its session is
  // still there: the peek moves to that session's row instead of going blank,
  // so the operator sees the session take the answer.
  function followPeek() {
    const p = s.ui.popup;
    if (p?.kind !== 'peek' || findRow(p.key) || !s.peek?.target?.agent) return;
    const same = boardRows(s.board, 'list').find((r) => r.kind === 'session' && r.go?.agent === s.peek.target.agent);
    if (same) {
      s.ui = { ...s.ui, popup: { ...p, key: same.key }, selectedKey: same.key };
      s.peek = { ...s.peek, key: same.key };
    }
  }

  async function readPeek() {
    const p = s.ui.popup;
    if (p?.kind !== 'peek' || !s.peek || s.peek.key !== p.key) return;
    const row = findRow(p.key);
    const target = peekTarget(row) ?? s.peek.target;
    if (!target) {
      // A result whose session is gone: its last captured screen is all there is.
      s.peek = { ...s.peek, text: row?.data?.screen ?? row?.data?.said ?? '', gone: true, error: null };
      onChange();
      return;
    }
    const r = await d.herdrRead(target);
    if (s.ui.popup?.kind !== 'peek' || s.peek?.key !== p.key) return;
    s.peek = r.ok
      ? { ...s.peek, target, text: r.text, error: null, gone: false, at: d.now().getTime() }
      : { ...s.peek, target, error: r.error, text: s.peek.text ?? (row?.data?.screen ?? null), gone: s.peek.text == null && Boolean(row?.data?.screen) };
    onChange();
  }

  // Starts reading when a peek opens and stops when it closes. The screen is
  // re-read every 1.5 s while it is open, so it shows the session live.
  function syncPeek() {
    const want = s.ui.popup?.kind === 'peek' ? s.ui.popup.key : null;
    if (want && s.peek?.key !== want) {
      clearInterval(s.peekTimer);
      s.peek = { key: want, target: peekTarget(findRow(want)), text: null, error: null, gone: false, at: null };
      readPeek();
      s.peekTimer = setInterval(readPeek, 1500);
      s.peekTimer.unref?.();
    } else if (!want && s.peek) {
      clearInterval(s.peekTimer);
      s.peekTimer = null;
      s.peek = null;
    }
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
    const h = { project: p.name, clock: hhmm(now.toISOString()), waiting: s.board.waitingCount ?? s.board.waiting.length };
    if (!p.ledger_dir) h.sessionsNote = 'no session ledger';
    else if (s.ledger?.error) h.sessionsNote = s.ledger.error;
    else if (s.ledger) h.sessions = `${s.ledger.count}${p.session_cap ? `/${p.session_cap}` : ''}`;
    h.stop = stopFileExists(p.ledger_dir);
    h.alerts = s.today?.attention?.length ?? 0;
    h.loop = loopWords(s.loop);
    if (s.herdr && !s.herdr.ok) h.herdr = 'Herdr unavailable';
    if (!s.today && s.todayError) h.stale = `record unreadable: ${s.todayError}`;
    else if (!s.today) h.stale = 'loading…';
    else if (s.todayError) h.stale = `record data ${ago(now - s.todayAt)} old (${s.todayError})`;
    else if (now - s.todayAt > 3 * config.refresh_seconds * 1000) h.stale = `record data ${ago(now - s.todayAt)} old`;
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
      scopeItems: scopeItems(s.board, config.projects),
      state: ui,
      prompt: promptParts(ui),
      selectedRow: findRow(ui.view === 'history' ? ui.historyKey : ui.selectedKey),
      popupRow,
      popupDoc: ui.popup?.kind === 'summary' && ui.popup.tab === 1 ? rowDocument(popupRow) : null,
      peek: ui.popup?.kind === 'peek' ? s.peek : null,
      project: { org: project().org },
      launch: { where: shownRepo && ui.scope.view === 'all' ? shownRepo.name : null },
    };
  }

  function frame(cols, rows, options) {
    s.size = { cols, rows };
    const out = renderFrame(view(), cols, rows, options);
    const pp = s.ui.popup;
    const popup = pp?.kind === 'summary' ? { ...pp, scroll: Math.min(pp.scroll, out.popupMax) }
      : pp?.kind === 'peek' ? { ...pp, scroll: out.popupScroll ?? pp.scroll } : pp;
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
      case 'project': {
        const wanted = effect.name ? config.projects.findIndex((p) => p.name === effect.name) : -1;
        if (effect.name && wanted < 0) { say(`No project named ${effect.name}.`, 'error'); return; }
        if (wanted === s.index) return;
        const keptScope = wanted >= 0 ? s.ui.scope : null;
        s.index = wanted >= 0 ? wanted : (s.index + 1) % config.projects.length;
        s.today = null;
        s.todayError = null;
        s.board = EMPTY;
        s.keys = null;
        s.ui = { ...initialState(), ...(keptScope ? { scope: keptScope } : {}), message: `Project: ${project().name}` };
        restartWatch();
        onChange();
        await refresh({ reorder: true });
        return;
      }
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
      case 'act':
        return act(effect);
      case 'loop': {
        const r = await d.setLoop(effect.on);
        if (!r.ok) {
          say(`The loop did not ${effect.on ? 'start' : 'stop'}: ${r.error}`, 'error');
          return;
        }
        s.loop = r.status ?? s.loop;
        await refresh();
        say(effect.on ? 'The loop is on: stopped sessions reach Waiting on you again.' : 'The loop is off. Nothing new reaches Waiting on you until you turn it on (L).', 'ok');
        return;
      }
      case 'instruct': {
        const goal = s.today?.project?.top_goal?.id;
        if (!goal) {
          say('This project has no top goal to record an instruction on.', 'error');
          return;
        }
        const stamp = `${d.now().toLocaleDateString('sv')} ${hhmm(d.now().toISOString())}`;
        const r = await d.orgNote(p, goal, `OPERATOR DIRECTION ${stamp}: ${effect.text}`, { decision: true });
        if (!r?.ok) {
          say(`Not recorded: ${r?.error ?? 'record note failed'}`, 'error');
          return;
        }
        await refresh();
        say(`Recorded on the project's top goal (${goal}), where its sessions read direction first. The next session to start acts on it.`, 'ok');
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
        if (r.ok && popupMode) return { quit: true };
        say(r.ok ? `Went to ${row.session}. Back here: Ctrl+Alt+B, or Ctrl+B then \`.` : `Herdr refused to go to ${row.session}: ${r.error}`, r.ok ? 'ok' : 'error');
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

  // Verbs on a row: what a session left behind goes through the brain CLI, so
  // the queue records it; a plain session gets the operator's words directly.
  async function act(effect) {
    const row = findRow(effect.key);
    if (!row) {
      say('That row is no longer listed; nothing was done.', 'warn');
      return;
    }
    if (effect.verb === 'dispatch') {
      if (!d.dispatch) {
        say('Starting a session from here is not set up (no brain_bin configured).', 'error');
        return;
      }
      say(`Starting a session to work out “${row.headline}”…`);
      const r = await d.dispatch(project(), row);
      // The question stays in org, with a note saying who is working it out.
      if (r.ok && row.question) await d.orgNote?.(project(), row.question, `The operator sent this to be worked out by session ${r.name}.`);
      say(r.ok ? `Started ${r.name} to work it out. It shows in the list below; when it stops, its choices come back here.` : `Not started: ${r.error}`, r.ok ? 'ok' : 'error');
      await refresh();
      return;
    }
    if (row.kind === 'session') {
      if (effect.verb !== 'send') return;
      const r = await d.herdrPrompt(row.go?.agent, effect.text);
      say(r.ok ? `Sent to ${row.session}.` : r.blocked ? `${row.session} is stuck at a prompt and refused the message; answer the prompt first.` : `Not sent: ${r.error}`, r.ok ? 'ok' : 'error');
      return;
    }
    if (row.kind === 'question') {
      const option = row.options?.find((o) => o.key === String(effect.option));
      if (effect.verb !== 'pick' || row.via !== 'answer' || !option) return;
      const r = await d.orgAnswer(project(), { question: row.question, answer: option.label, note: null, overrule: false, headline: row.headline });
      if (!r.ok) {
        say(`Not recorded: ${r.error}`, 'error');
        return;
      }
      await refresh();
      say(`Recorded “${option.label}”. The next pass acts on it.`, 'ok');
      return;
    }
    if (row.kind !== 'result') return;
    const args = brainArgs(effect.verb, row, { key: effect.option, text: effect.text });
    if (!args) {
      say('Nothing to do for that.', 'warn');
      return;
    }
    const r = await d.brainAct(args);
    if (!r.ok) {
      say(r.blocked ? `${row.session} is stuck at a prompt and refused the message. Answer the prompt first: Enter to peek at it.` : `Not done: ${r.error}`, 'error');
      return;
    }
    await refresh();
    const option = row.options?.find((o) => o.key === String(effect.option));
    const done = {
      pick: row.via === 'key' ? `Pressed ${effect.option} (“${option?.label ?? ''}”) in ${row.session}.` : `Sent “${option?.label ?? ''}” to ${row.session}.`,
      send: `Sent to ${row.session}.`,
      later: 'Saved for later. It is under the “saved for later” line.',
      drop: ['finished', 'report'].includes(row.category) ? 'Cleared.' : 'Dropped. It will not come back.',
    };
    say(done[effect.verb] ?? 'Done.', 'ok');
  }

  function ctx() {
    const rows = rowsOf(s.ui.view);
    const hits = s.last.hits;
    return {
      rows,
      historyRows: rowsOf('history'),
      scopeItems: scopeItems(s.board, config.projects),
      listPage: Math.max(1, s.last.bodyHeight - 2),
      popupPage: Math.max(1, s.last.bodyHeight - 6),
      popupMax: s.last.popupMax,
      projectCount: config.projects.length,
      projectName: project().name,
      loopOn: Boolean(s.loop?.service || s.loop?.running),
      popupMode,
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
    syncPeek();
    wantExplanations();
    onChange();
    let quit = false;
    for (const effect of effects) {
      if (effect.type === 'quit') quit = true;
      else if ((await perform(effect))?.quit) quit = true;
    }
    syncPeek();
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
    clearInterval(s.peekTimer);
    for (const dir of s.tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    s.tempDirs.clear();
  }

  return {
    start, stop, refresh, key, mouse, frame, perform,
    get ui() { return s.ui; },
    get peek() { return s.peek; },
    popupMode,
    set ui(value) { s.ui = value; },
    get board() { return s.board; },
    get project() { return project(); },
    rows: (view = s.ui.view) => rowsOf(view),
  };
}
