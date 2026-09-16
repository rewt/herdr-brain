#!/usr/bin/env node
// Herdr Brain console: the Ink entry point. Everything it shows comes from
// lib/session.mjs (data and keys) and lib/frame.mjs (lines); this file only draws
// those lines and forwards keys.
//
//   node console/app.mjs [--project NAME] [--config FILE]
//   node console/app.mjs --print 100x30 [--select N] [--tab 1|2|3]   one frame as plain text
import { parseArgs } from 'node:util';
import { ConfigError, configPath, loadConfig } from './lib/config.mjs';
import { createSession } from './lib/session.mjs';

const { values: opt } = parseArgs({
  options: {
    project: { type: 'string' },
    config: { type: 'string' },
    print: { type: 'string' },
    select: { type: 'string' },
    tab: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (opt.help) {
  process.stdout.write('usage: org console [--project NAME]   (node console/app.mjs [--project NAME] [--config FILE] [--print COLSxROWS])\n');
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

// Style names from lib/frame.mjs to Ink <Text> props. Color is never the only signal:
// every state is written as text, and NO_COLOR drops color and inverse entirely.
function styleProps(style) {
  const color = {
    header: { bold: true, color: 'cyan' },
    section: { bold: true },
    selected: { bold: true, inverse: true },
    title: {},
    titleFocus: { bold: true, color: 'yellow' },
    strong: { bold: true },
    heading: { bold: true },
    subheading: { bold: true },
    code: { color: 'green' },
    meta: { dimColor: true },
    dim: { dimColor: true },
    rule: { dimColor: true },
    quote: { italic: true },
    warn: { bold: true, color: 'yellow' },
    error: { bold: true, color: 'red' },
    ok: { color: 'green' },
    prompt: { bold: true, color: 'magenta' },
  }[style] ?? {};
  if (!NO_COLOR) return color;
  const { color: _c, inverse: _i, ...rest } = color;
  return rest;
}

if (opt.print) {
  const m = /^(\d+)x(\d+)$/.exec(opt.print);
  if (!m) {
    process.stderr.write('org console: --print expects COLSxROWS, e.g. 100x30\n');
    process.exit(1);
  }
  const session = createSession({ config, projectIndex });
  await session.refresh({ reorder: true });
  session.frame(Number(m[1]), Number(m[2]));
  for (let i = 0; i < Number(opt.select ?? 0); i++) await session.key('j', {});
  if (opt.tab) await session.key(opt.tab, {});
  const { lines } = session.frame(Number(m[1]), Number(m[2]));
  process.stdout.write(lines.map((l) => l.text.trimEnd()).join('\n') + '\n');
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('org console: needs an interactive terminal (try --print 100x30 for a snapshot)\n');
  process.exit(1);
}

const [{ default: React, useEffect, useState }, { Box, Text, render, useApp, useInput }] = await Promise.all([import('react'), import('ink')]);
const h = React.createElement;

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
let instance = null;
let remount = null;
let suspending = false;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });

// Suspends Ink for an editor in this terminal, then restores the screen and keys.
async function suspend(fn) {
  suspending = true;
  instance?.unmount();
  await instance?.waitUntilExit().catch(() => {});
  process.stdout.write(ALT_OFF);
  let result;
  try {
    result = fn();
  } finally {
    process.stdout.write(ALT_ON);
    suspending = false;
    remount();
  }
  return result;
}

const session = createSession({ config, projectIndex, deps: { suspend }, onChange: notify });

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
  useInput((input, key) => {
    session.key(input, key).then((quit) => {
      if (quit) exit();
    }, (error) => {
      session.ui = { ...session.ui, message: `error: ${error.message}`, messageStyle: 'error' };
      notify();
    });
  });
  // One line short of the terminal, so Ink never has to clear the whole screen; the
  // minimum-size check still applies to the terminal itself.
  const { lines } = session.frame(dims.cols, Math.max(1, dims.rows - 1), { termRows: dims.rows });
  return h(Box, { flexDirection: 'column' },
    ...lines.map((line, i) => h(Text, { key: i, wrap: 'truncate-end', ...styleProps(line.style) }, line.text || ' ')));
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
  process.stdout.write(ALT_OFF);
  process.exit(code);
}

for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => finish(0));
process.on('exit', () => process.stdout.write(ALT_OFF));

process.stdout.write(ALT_ON);
remount();
session.start().catch((error) => {
  session.ui = { ...session.ui, message: `error: ${error.message}`, messageStyle: 'error' };
  notify();
});
