#!/bin/sh
# console-pane.sh [project]: open a Herdr tab labelled "console" running `org console`
# in the project's workspace, without taking focus. The project comes from the console
# configuration (~/.config/herdr-org/console.json, or $HERDR_ORG_CONSOLE_CONFIG); its
# workspace is the one whose canonical checkout is the project's cwd. If that workspace
# already has a console tab, nothing is opened.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
exec node --input-type=module - "$here/../bin/org.mjs" "$@" <<'EOF'
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [bin, wanted] = process.argv.slice(2);
const orgBin = path.resolve(bin);
const die = (msg) => { process.stderr.write(`console-pane: ${msg}\n`); process.exit(1); };

const configFile = process.env.HERDR_ORG_CONSOLE_CONFIG || path.join(os.homedir(), '.config', 'herdr-org', 'console.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
} catch (error) {
  die(`cannot read ${configFile} (${error.code ?? error.message}); run org console once to create it`);
}
const projects = config.projects ?? [];
const project = wanted ? projects.find((p) => p.name === wanted) : projects[0];
if (!project) die(wanted ? `no project named "${wanted}" (configured: ${projects.map((p) => p.name).join(', ')})` : `${configFile} lists no projects`);
if (!project.cwd) die(`project ${project.name} has no cwd in ${configFile}`);
const cwd = path.resolve(project.cwd.replace(/^~(?=$|\/)/, os.homedir()));

function herdr(...args) {
  const r = spawnSync('herdr', args, { encoding: 'utf8' });
  if (r.error) die(`herdr ${args[0]} ${args[1]}: ${r.error.message}`);
  if (r.status !== 0) die(`herdr ${args[0]} ${args[1]} failed: ${(r.stderr || r.stdout).trim()}`);
  try {
    return JSON.parse(r.stdout).result ?? {};
  } catch {
    return {};
  }
}

const workspace = (herdr('workspace', 'list').workspaces ?? []).find((w) =>
  w.worktree && !w.worktree.is_linked_worktree && path.resolve(w.worktree.checkout_path) === cwd);
if (!workspace) die(`no Herdr workspace has ${cwd} as its checkout (project ${project.name})`);
const ws = workspace.workspace_id;

const existing = (herdr('tab', 'list', '--workspace', ws).tabs ?? []).find((t) => t.label === 'console');
if (existing) {
  process.stdout.write(`workspace ${ws} already has a console tab (${existing.tab_id}); nothing opened\n`);
  process.exit(0);
}

const created = herdr('tab', 'create', '--workspace', ws, '--cwd', cwd, '--label', 'console', '--no-focus');
const pane = created.root_pane?.pane_id;
if (!pane) die('herdr opened the tab but returned no pane id');
// A new tab's shell needs a moment to reach its prompt.
const wait = Number(process.env.CONSOLE_PANE_WAIT ?? 2000);
if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
herdr('pane', 'run', pane, `${q(process.execPath)} ${q(orgBin)} console --project ${q(project.name)}`);
process.stdout.write(`console tab ${created.tab?.tab_id ?? '?'} opened in workspace ${ws} (pane ${pane})\n`);
EOF
