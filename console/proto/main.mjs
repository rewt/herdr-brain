#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { initialState, key, mouse, rowDetail } from './controller.mjs';
import { frame, plain, palette } from './frame.mjs';
import { openItems, goals, tasks, sessions } from './model.mjs';
import { decoder, modes } from './input.mjs';
const { values: opt } = parseArgs({
  options: {
    print: { type: 'string' },
    screen: { type: 'string' },
    goal: { type: 'string' },
    task: { type: 'string' },
    scope: { type: 'string' },
    keys: { type: 'string' },
    help: { type: 'boolean' },
    'no-mouse': { type: 'boolean' },
  },
});
if (opt.help) {
  process.stdout.write(
    'Fixture console: node console/proto/main.mjs [--print 140x45] [--screen waiting|goal|task|session|peek|inbox|later|lanes|history] [--goal G-1] [--task ENG-1] [--scope all|harbor|orchard] [--keys Tab,j,Enter,b] [--no-mouse]\n',
  );
  process.exit(0);
}
let state = initialState();
if (opt.scope) {
  if (!['all', 'harbor', 'orchard'].includes(opt.scope))
    throw Error('Unknown fixture scope');
  state.scope = opt.scope;
}
if (opt.goal) {
  if (!goals.some((g) => g.id === opt.goal))
    throw Error('Unknown fixture goal');
  state.goal = opt.goal;
  state.cursor.goals = opt.goal;
}
if (opt.task) {
  if (!tasks.some((t) => t.id === opt.task))
    throw Error('Unknown fixture task');
  state.task = opt.task;
  state.cursor.tasks = opt.task;
}
const detail = {
  waiting: openItems[0],
  goal: goals[0],
  task: tasks[0],
  session: sessions[0],
};
if (opt.screen) {
  if (detail[opt.screen]) state = rowDetail(state, detail[opt.screen]);
  else if (opt.screen === 'peek')
    state = key(rowDetail(state, openItems[0]), '', { return: true });
  else if (['inbox', 'later', 'lanes', 'history'].includes(opt.screen)) {
    state.view = opt.screen;
    state.focus = ['inbox', 'later'].includes(opt.screen) ? 'open' : opt.screen;
  } else throw Error('Unknown screen');
}
const sendKeys = (w, h) => {
  for (const token of opt.keys?.split(',') ?? []) {
    const named = {
      Enter: { return: true },
      Tab: { tab: true },
      BackTab: { tab: true, shift: true },
      Esc: { escape: true },
      Up: { upArrow: true },
      Down: { downArrow: true },
      Left: { leftArrow: true },
      Right: { rightArrow: true },
      Home: { home: true },
      End: { end: true },
      PageDown: { pageDown: true },
      PageUp: { pageUp: true },
      Space: {},
    };
    state = key(
      state,
      token === 'Space' ? ' ' : named[token] ? '' : token,
      named[token] ?? {},
      frame(state, w, h),
    );
  }
};
if (opt.print) {
  const m = /^(\d+)x(\d+)$/.exec(opt.print);
  if (!m || +m[1] < 1 || +m[2] < 1) throw Error('--print expects WxH');
  const w = +m[1];
  const h = +m[2];
  sendKeys(w, h);
  process.stdout.write(plain(frame(state, w, h)));
  process.exit(0);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('Use an interactive terminal, or --print 100x40.\n');
  process.exit(1);
}
const [
  { default: React, useState, useEffect },
  { render, Box, Text, useStdin },
] = await Promise.all([import('react'), import('ink')]);
const h = React.createElement;
let instance;
let taken = false;
function cleanup() {
  if (taken) {
    taken = false;
    process.stdout.write(modes.off);
  }
}
function exit(code = 0) {
  instance?.unmount();
  cleanup();
  process.exit(code);
}
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => exit());
for (const signal of ['uncaughtException', 'unhandledRejection'])
  process.on(signal, (error) => {
    cleanup();
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(1);
  });
function App() {
  const [ui, setUI] = useState(state);
  const [size, setSize] = useState({
    w: process.stdout.columns || 80,
    h: (process.stdout.rows || 30) - 1,
  });
  const { stdin, setRawMode } = useStdin();
  useEffect(() => {
    const resize = () =>
      setSize({
        w: process.stdout.columns || 80,
        h: (process.stdout.rows || 30) - 1,
      });
    process.stdout.on('resize', resize);
    return () => process.stdout.off('resize', resize);
  }, []);
  useEffect(() => {
    setRawMode(true);
    const utf8 = new StringDecoder('utf8');
    let timer;
    const input = decoder((event) => {
      if (event.key?.ctrl && event.input === 'c') {
        exit();
        return;
      }
      setUI((s) => {
        if (
          event.key?.paste &&
          !['reply', 'search', 'screens'].includes(s.view)
        )
          return s;
        const f = frame(s, size.w, size.h);
        return event.mouse
          ? mouse(s, event.mouse, f)
          : key(s, event.input, event.key, f);
      });
    });
    const data = (chunk) => {
      clearTimeout(timer);
      input(typeof chunk === 'string' ? chunk : utf8.write(chunk));
      timer = setTimeout(() => input('', true), 35);
    };
    stdin.on('data', data);
    return () => {
      clearTimeout(timer);
      stdin.off('data', data);
      setRawMode(false);
    };
  }, [size.w, size.h, stdin, setRawMode]);
  useEffect(() => {
    if (ui.quit) exit();
  }, [ui.quit]);
  return h(
    Box,
    { flexDirection: 'column' },
    ...frame(ui, size.w, size.h).lines.map((line, i) =>
      h(
        Text,
        { key: i, wrap: 'truncate-end' },
        ...line.spans.map((s, n) =>
          h(
            Text,
            {
              key: n,
              color: process.env.NO_COLOR ? undefined : palette[s.fg],
              backgroundColor: process.env.NO_COLOR ? undefined : palette[s.bg],
              bold: s.bold,
            },
            s.text,
          ),
        ),
      ),
    ),
  );
}
taken = true;
process.stdout.write(opt['no-mouse'] ? '\x1b[?1049h\x1b[?25l' : modes.on);
instance = render(h(App), { exitOnCtrlC: false, patchConsole: false });
await instance.waitUntilExit();
cleanup();
