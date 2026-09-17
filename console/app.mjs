#!/usr/bin/env node
// Herdr Brain console: the Ink entry point. Everything it shows comes from
// lib/session.mjs (data, keys and clicks) and lib/frame.mjs (lines of coloured
// spans); this file only draws those spans, forwards keys and mouse reports, and
// keeps the terminal's modes (alternate screen, mouse reporting) balanced.
//
//   node console/app.mjs [--project NAME] [--config FILE]
//   node console/app.mjs --print 140x40 [--select N] [--keys KEYS]   one frame as plain text
import { parseArgs } from 'node:util';
import { ConfigError, configPath, loadConfig } from './lib/config.mjs';
import { lineText } from './lib/frame.mjs';
import { MOUSE_OFF, MOUSE_ON, parseMouse } from './lib/mouse.mjs';
import { VERSION, createSession } from './lib/session.mjs';
import { PALETTE } from './lib/theme.mjs';

const { values: opt } = parseArgs({
  options: {
    project: { type: 'string' },
    config: { type: 'string' },
    print: { type: 'string' },
    select: { type: 'string' },
    keys: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean' },
  },
});

if (opt.help) {
  process.stdout.write(`Herdr Brain console ${VERSION}
usage: org console [--project NAME]
       node console/app.mjs [--project NAME] [--config FILE] [--print COLSxROWS [--select N] [--keys KEYS]]
`);
  process.exit(0);
}
if (opt.version) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

let config;
try {
  config = loadConfig(opt.config ?? configPath());
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`org console: ${error.message}\n`);
  process.exit(1);
}

let projectIndex = 0;
if (opt.project) {
  projectIndex = config.projects.findIndex((p) => p.name === opt.project);
  if (projectIndex < 0) {
    process.stderr.write(`org console: no project named "${opt.project}" (configured: ${config.projects.map((p) => p.name).join(', ')})\n`);
    process.exit(1);
  }
}

const NO_COLOR = Boolean(process.env.NO_COLOR);

if (opt.print) {
  const m = /^(\d+)x(\d+)$/.exec(opt.print);
  if (!m) {
    process.stderr.write('org console: --print expects COLSxROWS, e.g. 140x40\n');
    process.exit(1);
  }
  const session = createSession({ config, projectIndex });
  await session.refresh({ reorder: true });
  const [cols, rows] = [Number(m[1]), Number(m[2])];
  session.frame(cols, rows);
  for (let i = 0; i < Number(opt.select ?? 0); i++) await session.key('j', {});
  // --keys: characters sent one by one; "\n" is Enter and "\e" is Escape.
  for (const k of (opt.keys ?? '').replace(/\\n/g, '\n').replace(/\\e/g, '\x1b')) {
    await session.key(k === '\n' || k === '\x1b' ? '' : k, { return: k === '\n', escape: k === '\x1b' });
    session.frame(cols, rows);
  }
  const { lines } = session.frame(cols, rows);
  process.stdout.write(lines.map((l) => lineText(l).trimEnd()).join('\n') + '\n');
  session.stop();
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('org console: needs an interactive terminal (try --print 140x40 for a snapshot)\n');
  process.exit(1);
}

const [{ default: React, useEffect, useState }, { Box, Text, render, useApp, useInput }] = await Promise.all([import('react'), import('ink')]);
const h = React.createElement;

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const BLACK = '\x1b[48;2;0;0;0m';
let instance = null;
let remount = null;
let suspending = false;
let terminalTaken = false;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });

// The terminal's modes, taken and given back as a pair. Giving back is safe to repeat.
function takeTerminal() {
  terminalTaken = true;
  process.stdout.write(`${ALT_ON}${NO_COLOR ? '' : `${BLACK}\x1b[2J`}\x1b[H\x1b[0m${MOUSE_ON}`);
}

function giveBackTerminal() {
  if (!terminalTaken) return;
  terminalTaken = false;
  process.stdout.write(`${MOUSE_OFF}\x1b[0m${ALT_OFF}`);
}

// Ink draws one row short of the terminal; this paints that last row black too.
function paintLastRow() {
  if (NO_COLOR || !terminalTaken || suspending) return;
  const { rows } = size();
  process.stdout.write(`\x1b7\x1b[${rows};1H${BLACK}\x1b[2K\x1b[0m\x1b8`);
}

// Suspends Ink for an editor in this terminal, then restores the screen, mouse and keys.
async function suspend(fn) {
  suspending = true;
  instance?.unmount();
  await instance?.waitUntilExit().catch(() => {});
  giveBackTerminal();
  let result;
  try {
    result = fn();
  } finally {
    takeTerminal();
    suspending = false;
    remount();
  }
  return result;
}

const session = createSession({ config, projectIndex, deps: { suspend }, onChange: notify });

function color(token) {
  return NO_COLOR ? undefined : PALETTE[token];
}

function Line({ spans }) {
  return h(Text, { wrap: 'truncate-end' }, ...spans.map((s, j) => h(Text, {
    key: j,
    color: color(s.fg),
    backgroundColor: color(s.bg),
    bold: s.bold || undefined,
  }, s.text)));
}

function Console() {
  const { exit } = useApp();
  const [, setTick] = useState(0);
  const [dims, setDims] = useState(size());
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const resize = () => setDims(size());
    listeners.add(bump);
    process.stdout.on('resize', resize);
    const clock = setInterval(bump, 30000);
    return () => {
      listeners.delete(bump);
      process.stdout.off('resize', resize);
      clearInterval(clock);
    };
  }, []);
  useEffect(() => {
    const t = setTimeout(paintLastRow, 20);
    return () => clearTimeout(t);
  });
  useInput((input, key) => {
    const event = parseMouse(input);
    const done = event ? session.mouse(event) : session.key(input, key);
    done.then((quit) => {
      if (quit) exit();
    }, (error) => {
      session.ui = { ...session.ui, message: `error: ${error.message}`, messageStyle: 'error' };
      notify();
    });
  });
  // One line short of the terminal, so Ink never has to clear the whole screen; the
  // minimum-size check still applies to the terminal itself.
  const { lines } = session.frame(dims.cols, Math.max(1, dims.rows - 1), { termRows: dims.rows });
  return h(Box, { flexDirection: 'column' }, ...lines.map((line, i) => h(Line, { key: i, spans: line.spans })));
}

// Ink exits on q and on Ctrl-C; an unmount for an editor is not an exit.
remount = () => {
  instance = render(h(Console), { exitOnCtrlC: true, patchConsole: false });
  instance.waitUntilExit().then(() => {
    if (!suspending) finish(0);
  }, () => finish(1));
};

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
    giveBackTerminal();
    process.stderr.write(`org console crashed: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}

takeTerminal();
remount();
session.start().catch((error) => {
  session.ui = { ...session.ui, message: `error: ${error.message}`, messageStyle: 'error' };
  notify();
});
