import fs from 'node:fs';
import path from 'node:path';
import { receiptOwnership, implicitParents, saveCreation } from './receipts.mjs';

export async function cleanupWorkspaces({ root, evidence, native }) {
  const state = JSON.parse(fs.readFileSync(path.join(root, 'ownership.json'), 'utf8'));
  const owned = { ...state, ...receiptOwnership(root, state) };
  const errors = [...owned.receiptErrors];
  let before, after;
  const inventory = async () => {
    const rows = (await native(['workspace', 'list'])).workspaces;
    if (!Array.isArray(rows)) throw new Error('native workspace list omitted its inventory');
    return rows;
  };
  try { before = await inventory(); }
  catch (error) { errors.push(`workspace inventory: ${error.message}`); }
  const intents = path.join(root, 'creation-intents.jsonl');
  if (before && fs.existsSync(intents)) for (const [index, line] of fs.readFileSync(intents, 'utf8').trim().split('\n').entries()) {
    if (!line) continue;
    try {
      const intent = JSON.parse(line);
      for (const workspace of implicitParents(intent, before)) {
        if (owned.workspaces.includes(workspace.workspace_id)) continue;
        saveCreation(root, intent.args, { workspace });
        owned.workspaces.push(workspace.workspace_id);
      }
    } catch (error) { errors.push(`creation intent line ${index + 1}: ${error.message}`); }
  }
  // A failed get is never evidence that a workspace has disappeared. Use the
  // raw native inventory, and still attempt every receipt if listing failed.
  for (const id of [...owned.workspaces].reverse()) {
    if (before && !before.some((row) => row.workspace_id === id)) continue;
    try { await native(['workspace', 'close', id]); }
    catch (error) { errors.push(`workspace ${id}: ${error.message}`); }
  }
  try { after = await inventory(); }
  catch (error) { errors.push(`workspace audit: ${error.message}`); }
  const inside = (value) => {
    if (!value) return false;
    return [root, ...(state.creationRoots ?? [])].some(base => {
      const relative = path.relative(base, path.resolve(value));
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    });
  };
  const remaining = (after ?? []).filter(row => owned.workspaces.includes(row.workspace_id) ||
    inside(row.worktree?.checkout_path ?? row.cwd));
  for (const row of remaining) errors.push(`workspace left: ${row.workspace_id} (${row.label ?? 'unlabelled'})`);
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'ownership.json'), JSON.stringify(owned, null, 2));
  fs.writeFileSync(path.join(evidence, 'cleanup-residue.json'), JSON.stringify({ workspaces: remaining, errors, before, after }, null, 2));
  return { owned, remaining, errors };
}
