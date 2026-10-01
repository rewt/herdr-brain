#!/usr/bin/env node
// The items pane on its own: a narrow live view of an organization's items, made
// to sit beside a supervisor chat in the same Herdr tab (items/feed.mjs). It
// paints rows straight onto the terminal (items/paint.mjs); Ink only reads the
// keyboard and mouse here and renders nothing.
//
//   node console/items.mjs [--project NAME] [--config FILE]
//   node console/items.mjs --print 60x40 [--keys KEYS]    one frame as plain text
//
// HERDR_FEED_WATCH names the chat's pane or agent when it is not in this tab;
// HERDR_FEED_SINCE widens the activity window (default 36h).
import { parseArgs } from 'node:util';
import path from 'node:path';
import { ConfigError, configPath, loadConfig } from './lib/config.mjs';
import { lineText } from './lib/frame.mjs';
import { MOUSE_OFF, MOUSE_ON, parseMouse } from './lib/mouse.mjs';
import { createFeedSession } from './items/feed.mjs';
import { createPainter } from './items/paint.mjs';
import { ITEMS_PALETTES } from './items/palette.mjs';

let opt;
try {
  ({ values: opt } = parseArgs({ options: { project: { type: 'string' }, config: { type: 'string' }, print: { type: 'string' }, keys: { type: 'string' }, help: { type: 'boolean', short: 'h' } } }));
} catch (error) {
  process.stderr.write(`items: ${error.message}\nTry --help.\n`);
  process.exit(1);
}
if (opt.help) {
  process.stdout.write('usage: node console/items.mjs [--project NAME] [--config FILE] [--print COLSxROWS [--keys KEYS]]\n');
  process.exit(0);
}

let config;
try {
  config = loadConfig(path.resolve(opt.config ?? configPath()));
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`items: ${error.message}\n`);
  process.exit(1);
}
const projectIndex = opt.project ? config.projects.findIndex((p) => p.name === opt.project) : 0;
if (projectIndex < 0) {
  process.stderr.write(`items: no project named "${opt.project}" (configured: ${config.projects.map((p) => p.name).join(', ')})\n`);
  process.exit(1);
}

if (opt.print) {
  const m = /^(\d+)x(\d+)$/.exec(opt.print);
  if (!m) {
    process.stderr.write('items: --print expects COLSxROWS, e.g. 60x40\n');
    process.exit(1);
  }
  // A snapshot only reads: it never focuses a session or sends to the chat.
  const deps = { herdrGo: async () => ({ ok: false, error: '--print does not open Herdr terminals' }), herdrPrompt: async () => ({ ok: false, error: '--print does not send to sessions' }) };
  const session = createFeedSession({ config, projectIndex, deps });
  await session.refresh();
  const [cols, rows] = [Number(m[1]), Number(m[2])];
  session.frame(cols, rows);
  // --keys: characters sent one by one; "\n" is Enter and "\e" is Escape.
  for (const k of (opt.keys ?? '').replace(/\\n/g, '\n').replace(/\\e/g, '\x1b')) {
    await session.key(k === '\n' || k === '\x1b' ? '' : k, { return: k === '\n', escape: k === '\x1b' });
    session.frame(cols, rows);
  }
  process.stdout.write(session.frame(cols, rows).lines.map((l) => lineText(l).trimEnd()).join('\n') + '\n');
  session.stop();
  process.exit(0);
}

const NO_COLOR = Boolean(process.env.NO_COLOR);
const [{ default: React, useEffect }, { render, useApp, useInput }] = await Promise.all([import('react'), import('ink')]);
const listeners = new Set();
const session = createFeedSession({ config, projectIndex, onChange: () => listeners.forEach((fn) => fn()) });
const palette = () => ITEMS_PALETTES[session.ui.appearance];
const painter = createPainter({ write: (text) => process.stdout.write(text), color: (token) => (NO_COLOR ? undefined : palette()[token]) });
const size = () => ({ cols: process.stdout.columns || 60, rows: process.stdout.rows || 24 });
const background = () => (NO_COLOR ? '' : `\x1b[48;2;${palette().bg.slice(1).match(/../g).map((x) => parseInt(x, 16)).join(';')}m`);

let taken = false;
function takeTerminal() {
  taken = true;
  process.stdout.write(`\x1b[?1049h${background()}\x1b[2J\x1b[H\x1b[0m${MOUSE_ON}\x1b[?7l\x1b[?25l`);
  painter.invalidate();
}
function giveBackTerminal() {
  if (!taken) return;
  taken = false;
  process.stdout.write(`${MOUSE_OFF}\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l`);
}

function Items() {
  const { exit } = useApp();
  useEffect(() => {
    let pending = null, appearance = session.ui.appearance;
    const draw = () => {
      pending = null;
      if (!taken) return;
      // A theme change repaints the whole background.
      if (session.ui.appearance !== appearance) { appearance = session.ui.appearance; painter.invalidate(); process.stdout.write(`${background()}\x1b[2J\x1b[0m`); }
      const { cols, rows } = size();
      painter.paint(session.frame(cols, rows).lines);
    };
    const schedule = () => { pending ??= setTimeout(draw, 16); };
    const resize = () => { painter.invalidate(); process.stdout.write(`${background()}\x1b[2J\x1b[0m`); schedule(); };
    listeners.add(schedule);
    process.stdout.on('resize', resize);
    // The clock and the idle time move without new data.
    const clock = setInterval(schedule, 1000);
    draw();
    return () => { listeners.delete(schedule); process.stdout.off('resize', resize); clearInterval(clock); clearTimeout(pending); };
  }, []);
  useInput((input, key) => {
    const event = parseMouse(input);
    const done = event ? session.mouse(event) : session.key(input, key);
    done.then((quit) => { if (quit) exit(); }, (error) => { session.ui = { message: `error: ${error.message}` }; listeners.forEach((fn) => fn()); });
  });
  return null;
}

function finish(code) {
  session.stop();
  giveBackTerminal();
  process.exit(code);
}
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, () => finish(0));
process.on('exit', giveBackTerminal);
// A crash must not leave the terminal reporting mouse movements into the shell.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (error) => {
    try { session.stop(); } catch {}
    giveBackTerminal();
    process.stderr.write(`items crashed: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}

takeTerminal();
render(React.createElement(Items), { exitOnCtrlC: false, patchConsole: false }).waitUntilExit().then(() => finish(0), () => finish(1));
session.start().catch((error) => { session.ui = { message: `error: ${error.message}` }; listeners.forEach((fn) => fn()); });
