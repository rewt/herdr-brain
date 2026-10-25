import fs from 'node:fs';
import path from 'node:path';
import { receiptOwnership, recoverCreations, saveCreation } from './receipts.mjs';
import { stopAndAwaitProducers } from './producers.mjs';
import { stopFixtureInbox } from '../test/helpers/inbox.mjs';

export async function cleanupWorkspaces({ root, evidence, native, producerTimeoutMs }) {
  fs.mkdirSync(evidence, { recursive: true });
  // No inventory, ledger or receipt snapshot is valid while a producer can
  // still create or finish journaling a native call. Wait for actual drain;
  // malformed receipts and native ownership refusals remain real errors.
  try { await stopAndAwaitProducers(root, { timeoutMs: producerTimeoutMs }); }
  catch (error) {
    const result = { remaining: [], errors: [`producer drain: ${error.message}`] };
    fs.writeFileSync(path.join(evidence, 'cleanup-residue.json'), JSON.stringify(result, null, 2));
    return result;
  }
  fs.writeFileSync(path.join(evidence, 'producers-drained.json'), JSON.stringify({ at: Date.now() }));
  const state = JSON.parse(fs.readFileSync(path.join(root, 'ownership.json'), 'utf8'));
  const owned = { ...state, ...receiptOwnership(root, state) };
  const errors = [...owned.receiptErrors], intents = [], attempted = new Set();
  let before, reconciled, after;
  const inventory = async () => {
    const rows = (await native(['workspace', 'list'])).workspaces;
    if (!Array.isArray(rows)) throw new Error('native workspace list omitted its inventory');
    return rows;
  };
  const file = path.join(root, 'creation-intents.jsonl');
  if (fs.existsSync(file)) for (const [index, line] of fs.readFileSync(file, 'utf8').trim().split('\n').entries()) {
    if (!line) continue;
    try { intents.push(JSON.parse(line)); }
    catch (error) { errors.push(`creation intent line ${index + 1}: ${error.message}`); }
  }
  const reconcile = async rows => {
    // Replay again after closing, including any receipt completed during drain.
    const latest = receiptOwnership(root, JSON.parse(fs.readFileSync(path.join(root, 'ownership.json'), 'utf8')));
    for (const key of ['workspaces', 'panes', 'tabs']) owned[key] = [...new Set([...owned[key], ...latest[key]])];
    errors.push(...latest.receiptErrors);
    if (!rows) return;
    for (const intent of intents) {
      try {
        for (const workspace of await recoverCreations(intent, rows, native)) {
          if (owned.workspaces.includes(workspace.workspace_id)) continue;
          saveCreation(root, intent.args, { workspace });
          owned.workspaces.push(workspace.workspace_id);
        }
      } catch (error) { errors.push(`creation recovery: ${error.message}`); }
    }
  };
  const close = async rows => {
    // A failed get/list never proves disappearance. If listing failed, still
    // attempt every receipt, and keep failures visible in the final audit.
    for (const id of [...owned.workspaces].reverse()) {
      if (attempted.has(id) || (rows && !rows.some(row => row.workspace_id === id))) continue;
      attempted.add(id);
      try { await native(['workspace', 'close', id]); }
      catch (error) { errors.push(`workspace ${id}: ${error.message}`); }
    }
  };
  try { before = await inventory(); } catch (error) { errors.push(`workspace inventory: ${error.message}`); }
  await reconcile(before); await close(before);
  try { reconciled = await inventory(); } catch (error) { errors.push(`workspace reconciliation: ${error.message}`); }
  await reconcile(reconciled); await close(reconciled);
  try { after = await inventory(); } catch (error) { errors.push(`workspace audit: ${error.message}`); }
  const inside = value => {
    if (!value) return false;
    return [root, ...(state.creationRoots ?? [])].some(base => {
      const relative = path.relative(base, path.resolve(value));
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    });
  };
  const remaining = (after ?? []).filter(row => owned.workspaces.includes(row.workspace_id) ||
    inside(row.worktree?.checkout_path ?? row.cwd) ||
    (!row.worktree?.checkout_path && !row.cwd && intents.some(intent =>
      intent.label && row.label === intent.label && !intent.before.includes(row.workspace_id))));
  for (const row of remaining) errors.push(`workspace left: ${row.workspace_id} (${row.label ?? 'unlabelled'})`);
  const uniqueErrors = [...new Set(errors)];
  fs.writeFileSync(path.join(evidence, 'ownership.json'), JSON.stringify(owned, null, 2));
  fs.writeFileSync(path.join(evidence, 'cleanup-residue.json'), JSON.stringify({ workspaces: remaining, errors: uniqueErrors, before, reconciled, after }, null, 2));
  return { owned, remaining, errors: uniqueErrors };
}

// Run after all notice senders have drained. Only receipt paths confined to
// this owned scratch tree are candidates; the shared helper freshly verifies
// argv, process birth, group and transport children before every signal.
export async function cleanupInboxes({ root, candidate, evidence, stop = stopFixtureInbox }) {
  const receipts = [], errors = [];
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.name === 'inbox.log.owner.lock') {
        try {
          const owner = JSON.parse(fs.readFileSync(path.join(file, 'owner.json'), 'utf8'));
          receipts.push({ ...owner, file: file.slice(0, -'.owner.lock'.length) });
        } catch (error) { errors.push(`inbox receipt ${file}: ${error.message}`); }
      } else if (!['node_modules', '.git', 'objects'].includes(entry.name)) scan(file);
      // Git-only projects store their inbox in .git/supervisor too.
      else if (entry.name === '.git') {
        const supervisor = path.join(file, 'supervisor');
        if (fs.existsSync(supervisor) && fs.lstatSync(supervisor).isDirectory()) scan(supervisor);
      }
    }
  }
  scan(root);
  for (const receipt of receipts) {
    try { await stop(receipt.file, { script: path.join(candidate, 'supervisor/prompt-supervisor.mjs') }); receipt.stopped = true; }
    catch (error) { receipt.error = error.message; errors.push(error.message); }
  }
  fs.writeFileSync(path.join(evidence, 'inbox-cleanup.json'), JSON.stringify(receipts, null, 2));
  if (errors.length) throw new Error(`owned inbox cleanup: ${errors.join('; ')}`);
  return receipts;
}
