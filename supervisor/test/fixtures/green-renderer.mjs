import { WITHHELD } from './rows.mjs';

export function duration(seconds) {
  if (!Number.isFinite(seconds)) return '?';
  seconds = Math.max(0, Math.floor(seconds));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m`;
}
const elapsed = (row, now) => row.startedAt === WITHHELD || row.endedAt === WITHHELD ? WITHHELD : row.startedAt ? duration(((row.endedAt ? Date.parse(row.endedAt) : now) - Date.parse(row.startedAt)) / 1000) : '?';
const cell = (value, width) => {
  const text = String(value ?? '');
  return (text.length > width ? text.slice(0, Math.max(0, width - 1)) + '~' : text).padEnd(width);
};
export function render(snapshot, { width = 120, height = Infinity, now = Date.now() } = {}) {
  width = Math.max(1, Math.floor(width));
  const clip = line => line.length <= width ? line : line.slice(0, Math.max(0, width - 1)) + '~';
  const slot = snapshot.slot;
  const memory = Number.isFinite(snapshot.memory) ? `${(snapshot.memory / 1024 ** 3).toFixed(1)} GiB` : 'unknown';
  const lines = [clip(`Promotion board | memory available ${memory} | Herdr ${snapshot.herdr}`),
    clip(`Slot ${slot.state}${slot.label ? `: ${slot.label}` : ''}${slot.project ? ` (${slot.project})` : ''} | held ${duration(slot.heldSeconds)} | queue ${slot.queueLength} | shared ${slot.sharedCount ?? 'unknown'}`)];
  const columns = [
    { title: 'ITEM / LANE', min: 12, max: 28, value: r => [r.item, r.lane].filter(Boolean).join(' ') || r.id },
    { title: 'PHASE', min: 12, max: 16, value: r => r.phase === 'stage' ? r.stage === null ? 'stage' : r.stage === WITHHELD ? `stage ${WITHHELD}` : `stage ${r.stage.n} of ${r.stage.m}` : r.phase },
    { title: 'ELAPSED', min: 7, max: 9, value: r => elapsed(r, now) },
    { title: 'SLOT', min: 11, max: 11, value: r => r.slot },
    { title: 'STATUS', min: 10, max: 28, value: r => r.status.text },
    { title: 'RESULT / MAIN', min: 13, max: 18, value: r => `${r.result.exit ?? '-'} ${r.result.main === WITHHELD ? WITHHELD : r.result.main?.slice(0, 12) ?? '-'}` },
    { title: 'WHERE', min: 12, max: 48, value: (r, width) => {
      if (r.where.pane !== WITHHELD) return r.where.pane;
      const log = r.where.log;
      return log.length > width ? '...' + log.slice(-(width - 3)) : log;
    } },
    { title: 'CLOCKS', min: 12, max: 60, value: r => Array.isArray(r.clocks) ? r.clocks.map(c => `${c.label} ${c.seconds === WITHHELD ? WITHHELD : duration(c.seconds)}${c.legacy === true ? ' legacy' : c.legacy === WITHHELD ? ` ${WITHHELD}` : ''}`).join('; ') : WITHHELD },
  ];
  const cost = cols => cols.reduce((n, c) => n + c.min, 0) + Math.max(0, cols.length - 1) * 2;
  while (columns.length > 1 && cost(columns) > width) columns.pop();
  for (const c of columns) c.width = c.min;
  let spare = width - cost(columns);
  while (spare > 0 && columns.some(c => c.width < c.max)) for (const c of columns) if (spare > 0 && c.width < c.max) { c.width++; spare--; }
  let project;
  for (const row of snapshot.rows) {
    if (row.project !== project) {
      project = row.project;
      lines.push('', clip(`[${project}]`), clip(columns.map(c => cell(c.title, c.width)).join('  ')));
    }
    lines.push(clip(columns.map(c => cell(c.value(row, c.width), c.width)).join('  ').trimEnd()));
  }
  if (!snapshot.rows.length) lines.push('No promotions in the selected window.');
  if (Number.isFinite(height) && lines.length > height) return [...lines.slice(0, Math.max(0, height - 1)), clip('More rows available with --once or --json')].join('\n');
  return lines.map(clip).join('\n');
}

// An injected output and EventEmitter make terminal cleanup testable without a live pane.
export async function live({ collect, output = process.stdout, signals = process, interval = 2000, noColor = 'NO_COLOR' in process.env, exit = () => {} }) {
  const ansi = output.isTTY && !noColor;
  let stopped = false, previous, timer, stop;
  const cancelled = new Promise(resolve => { stop = resolve; });
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const restore = () => {
    if (stopped) return;
    stopped = true; clearTimeout(timer);
    for (const name of names) signals.removeListener(name, onSignal);
    if (ansi) output.write('\x1b[?25h\x1b[?1049l');
    stop();
  };
  const onSignal = () => { restore(); exit(); };
  for (const name of names) signals.on(name, onSignal);
  if (ansi) output.write('\x1b[?1049h\x1b[?25l');
  try {
    while (!stopped) {
      const snapshot = await Promise.race([collect(), cancelled]);
      if (stopped) break;
      const frame = render(snapshot, { width: output.columns ?? 120, height: output.rows ?? Infinity });
      if (frame !== previous) { output.write(ansi ? `\x1b[H\x1b[2J${frame}` : frame + '\n'); previous = frame; }
      await Promise.race([new Promise(resolve => { timer = setTimeout(resolve, interval); }), cancelled]);
    }
  } finally { restore(); }
}
