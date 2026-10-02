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

export function saveCreationIntent(root, args, workspaces, cwd) {
  const at = args.indexOf('--path');
  const paths = [cwd, ...(at >= 0 ? [path.resolve(args[at + 1])] : [])];
  const intent = { args, before: workspaces.map(row => row.workspace_id), cwd, paths };
  appendSynced(path.join(root, 'creation-intents.jsonl'), intent);
  return intent;
}

// worktree create/open may implicitly open its main checkout too. Restrict
// this grant to a new opaque native ID at the exact, already-confined cwd.
export function implicitParents(intent, workspaces) {
  return workspaces.filter(row => !intent.before.includes(row.workspace_id) &&
    (intent.paths ?? [intent.cwd]).includes(path.resolve(row.worktree?.checkout_path ?? row.cwd ?? '/')));
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
