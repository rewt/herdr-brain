// Claude's native PreToolUse boundary for lanes created after session launch.
// Read grants never depend on this hook. It only rejects cross-lane file writes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { within } from './paths.mjs';

function resolveExisting(file) {
  try { return fs.realpathSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A missing leaf can be appended to a resolved parent. An existing but
    // dangling link cannot: dropping it would hide the actual write target.
    try { fs.lstatSync(file); throw new Error('Existing path cannot be resolved'); }
    catch (entryError) { if (entryError.code !== 'ENOENT') throw entryError; }
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(resolveExisting(parent), path.basename(file));
  }
}

export function laneFileAccess(event, workspace, worktrees) {
  if (!['Edit', 'Write', 'NotebookEdit'].includes(event.tool_name)) return null;
  const file = event.tool_input?.file_path ?? event.tool_input?.notebook_path;
  if (typeof file !== 'string' || !file) return 'Cannot determine the file write target.';
  try {
    const requested = path.resolve(event.cwd || workspace, file.replace(/^~(?=\/|$)/u, os.homedir()));
    const resolved = resolveExisting(requested);
    if ([requested, resolved].some(target => within(worktrees, target) && !within(workspace, target)))
      return 'Other lanes and the shared worktree root are read-only for this session.';
    return null;
  } catch {
    return 'Cannot safely resolve the file write target.';
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let reason;
  try { reason = laneFileAccess(JSON.parse(fs.readFileSync(0, 'utf8')), process.argv[2], process.argv[3]); }
  catch { reason = 'Cannot safely inspect the file write request.'; }
  if (reason) process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',
    permissionDecision:'deny', permissionDecisionReason:reason}}) + '\n');
}
