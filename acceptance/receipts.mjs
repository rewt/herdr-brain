import fs from 'node:fs';
import path from 'node:path';

export function creationTargets(result = {}) {
  const opened = result.open_result ?? result;
  const workspace = opened.workspace?.workspace_id ?? opened.worktree?.open_workspace_id;
  return {
    workspaces: workspace ? [workspace] : [],
    panes: opened.root_pane?.pane_id ? [opened.root_pane.pane_id] : [],
    tabs: opened.tab?.tab_id ? [opened.tab.tab_id] : [],
  };
}

function appendSynced(file, value) {
  const fd = fs.openSync(file, 'a');
  try { fs.writeSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

export function saveCreationIntent(root, args, workspaces, cwd, recoveryLabel = false) {
  const at = args.indexOf('--path');
  const canonical = value => {
    const destination = path.resolve(value);
    let ancestor = destination;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    return path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, destination));
  };
  const paths = [...(cwd ? [canonical(cwd)] : []), ...(at >= 0 ? [canonical(args[at + 1])] : [])];
  const labelAt = args.indexOf('--label');
  const intent = { args, before: workspaces.map(row => row.workspace_id), cwd, paths,
    ...(labelAt >= 0 ? { label: args[labelAt + 1], recoveryLabel } : {}) };
  appendSynced(path.join(root, 'creation-intents.jsonl'), intent);
  return intent;
}

// Native workspace metadata can lag creation. A unique generated label is a
// recovery token; caller-supplied labels require an exact native path proof.
// Never substitute a label for contradictory path metadata or a baseline ID.
export async function recoverCreations(intent, workspaces, native) {
  if (!Array.isArray(intent.before) || !Array.isArray(intent.paths ?? [intent.cwd])) throw new Error('invalid creation intent');
  const paths = intent.paths ?? [intent.cwd];
  const found = [];
  for (const row of workspaces) {
    if (!row.workspace_id || intent.before.includes(row.workspace_id)) continue;
    const cwd = row.worktree?.checkout_path ?? row.cwd;
    if (cwd) {
      if (paths.includes(path.resolve(cwd))) found.push(row);
      continue;
    }
    if (intent.recoveryLabel && row.label === intent.label) { found.push(row); continue; }
    // This also recovers an implicit main checkout whose default label differs
    // from the requested linked-worktree label. Reads grant no pane capability.
    try {
      const panes = (await native(['pane', 'list', '--workspace', row.workspace_id])).panes;
      if (!Array.isArray(panes)) continue;
      for (const item of panes) {
        const pane = (await native(['pane', 'get', item.pane_id])).pane;
        if (pane?.pane_id === item.pane_id && pane.workspace_id === row.workspace_id &&
            pane.foreground_cwd && paths.includes(path.resolve(pane.foreground_cwd))) {
          found.push(row); break;
        }
      }
    } catch { /* unavailable path proof never grants closure authority */ }
  }
  return found;
}

// Append/fsync before any fallible follow-up read or ownership lock. Cleanup
// replays these opaque native receipts even if the adapter died before folding.
export function saveCreation(root, args, result) {
  const targets = creationTargets(result);
  appendSynced(path.join(root, 'creations.jsonl'), { args, targets });
  return targets;
}

export function receiptOwnership(root, state) {
  const file = path.join(root, 'creations.jsonl');
  const targets = { workspaces: [...state.workspaces], panes: [...state.panes], tabs: [...state.tabs] };
  const errors = [];
  if (fs.existsSync(file)) for (const [index, line] of fs.readFileSync(file, 'utf8').trim().split('\n').entries()) {
    if (!line) continue;
    try {
      const receipt = JSON.parse(line);
      for (const key of Object.keys(targets)) {
        if (!Array.isArray(receipt.targets?.[key]) || receipt.targets[key].some(id => typeof id !== 'string' || !id)) throw new Error('invalid target IDs');
      }
      for (const key of Object.keys(targets)) targets[key].push(...receipt.targets[key]);
    } catch (error) { errors.push(`creation receipt line ${index + 1}: ${error.message}`); }
  }
  return { ...Object.fromEntries(Object.entries(targets).map(([key, ids]) => [key, [...new Set(ids)]])), receiptErrors: errors };
}
