#!/usr/bin/env node
import path from 'node:path';
import { isMain } from '../lib/cli-help.mjs';
import { discoverProject, brainSource } from './brain.mjs';
import { scriptSource } from './source.mjs';
import { validateDocument, errorDocument } from './rows.mjs';
import { availableMemory, paneState, readSlot, rowSlot } from './facts.mjs';
import { render, live } from './render.mjs';

export function parseOptions(argv) {
  const options = { projects: [], sources: [], roots: [], interval: 2000, once: false, json: false };
  let project = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--once' || arg === '--json') { options[arg.slice(2)] = true; continue; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!['--project', '--source', '--log-root', '--interval'].includes(arg) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('invalid-options');
    const value = argv[++i];
    if (arg === '--project') { project = path.resolve(value); options.projects.push(project); }
    if (arg === '--log-root') options.roots.push(path.resolve(value));
    if (arg === '--source') {
      const match = /^([a-z0-9._-]{1,40})=(.+)$/.exec(value);
      if (!match || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw Error('invalid-source');
      options.sources.push({ name: match[1], script: path.resolve(project, match[2]), project });
    }
    if (arg === '--interval') {
      if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0 || Number(value) > 3600) throw Error('invalid-interval');
      options.interval = Math.max(1, Number(value) * 1000);
    }
  }
  if (!options.projects.length) options.projects.push(process.cwd());
  return options;
}
export function createBoard(options, { memory = availableMemory, panes = paneState, slot = readSlot, brain = brainSource, discover = discoverProject } = {}) {
  const projects = [], failures = [];
  for (const cwd of options.projects) {
    try {
      const p = discover(cwd);
      if (!projects.some(existing => existing.identity === p.identity)) projects.push(p);
    } catch { failures.push(errorDocument(path.basename(cwd), 'source-read')); }
  }
  const scripts = options.sources.map(source => scriptSource(source));
  return async () => {
    const [memoryBytes, paneInfo, documents] = await Promise.all([
      memory(), panes(), Promise.all([...projects.map(p => brain(p)), ...scripts.map(s => s.read())]),
    ]);
    const slotInfo = slot({ projects });
    const roots = [...options.roots, ...projects.map(p => p.identity)];
    const rows = [...documents.filter(Boolean), ...failures].flatMap(doc => validateDocument(doc, { project: doc.project, roots, panes: paneInfo.panes }).rows)
      .map(row => { const { worktree, ...display } = row; return { ...display, slot: rowSlot(worktree, slotInfo) }; });
    const rank = phase => ['admission', 'stage', 'reconcile', 'unknown', 'withheld'].includes(phase) ? 0 : phase === 'queued' ? 1 : 2;
    rows.sort((a, b) => a.project.localeCompare(b.project) || rank(a.phase) - rank(b.phase) ||
      (rank(a.phase) === 2 ? (Date.parse(b.endedAt) || 0) - (Date.parse(a.endedAt) || 0) : 0));
    const { holderWorktree, queueWorktrees, ...slotDisplay } = slotInfo;
    return { schema: 'promotion-board/v1', memory: memoryBytes, herdr: paneInfo.state, slot: slotDisplay, rows };
  };
}
export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write('Usage: node board/board.mjs [--project PATH] [--source NAME=SCRIPT] [--log-root PATH] [--interval S] [--once | --json]\nRepeat project/source/log-root. A source belongs to the preceding project (default cwd). Read-only; Ctrl-C closes the view.\n');
    return;
  }
  const collect = createBoard(options);
  if (options.json) process.stdout.write(JSON.stringify(await collect(), null, 2) + '\n');
  else if (options.once || !process.stdout.isTTY) process.stdout.write(render(await collect(), { width: process.stdout.columns ?? (Number(process.env.COLUMNS) || 120) }) + '\n');
  else await live({ collect, interval: options.interval });
}
if (isMain(import.meta.url)) main().catch(() => { process.stderr.write('board: read failed (use --help for options)\n'); process.exitCode = 1; });
