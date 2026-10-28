import { quote } from '../lib/shell.mjs';
import { supervisorPolicy } from '../supervisor/protocol.mjs';
import { entryLessons } from './lessons.mjs';

export function entryPolicy(context, root) {
  const record = `ORG_DIR=${quote(context.org)} ${quote(process.execPath)} ${quote(`${root}/bin/org.mjs`)}`;
  const lane = `${quote(process.execPath)} ${quote(`${root}/lanes/lane.mjs`)}`;
  const policy = context.role === 'chat'
    ? `You are the operator's project chat. Coordinate through the record, dispatch, watch and lanes. Ordinary report/review/promotion follow-up belongs to the recorded owning worker, who self-lands finished source under the current operator waiver and hands immutable landed base/head and producer evidence through the report to the single existing record queue-review path. Consume owner verification receipts once; route actual unsafe/native/identity/ownership/reserved/failed exceptions to the project's ops supervisor. Only the canonical project supervisor starts housekeeping.`
    : context.role === 'supervisor' ? supervisorPolicy(context, root)
    : `Work in your assigned lane. Commit finished source and self-land OWN work immediately under the current operator waiver with ${lane} promote TOPIC --expected-head FULL_COMMIT; preserve native identity/claim, clean worktrees/rebase, source/CAS/fast-forward, STOP, HOLD and archives. A final report and review verdict are not pre-main gates. Hand immutable landed base/head and producer evidence through your report to the single existing record queue-review path; the line service creates/dispatches ONE independent async post-code diff/evidence review, cap1, zero reviewer suites. Never start a manual settle/lane review, add a second reviewer, wait for a verdict to land, or replace an existing/UNKNOWN attempt. Own at most one formal correction, then fix forward. Use the recorded live-verified worker agent as --to for settle and queued promotion notices; retain an existing bootstrap watcher and its saved recipient/runtime/claims. Ordinary notices return to you; route actual unsafe/native/identity/ownership/reserved/failed exceptions to your PROJECT SUPERVISOR at its recorded project-specific exception address. Run only the ask's focused changed checks once on the clean committed candidate through ${lane} check --cmd COMMAND, and record actual evidence; unrun is never PASS. Write/check the final report with exact authored/landed source, waiver executed:false/exit_code:null, verifier/evidence, review binding/status, recipients and signed landing/report clocks. Workers never run the release gate or start housekeeping.`;
  return `Project checkout: ${context.canonical}; shared record: ${context.org}.
Read applicable AGENTS.md and CLAUDE.md instructions before acting.
${policy}
Record CLI: ${record}. Status, show, today and lessons recover durable context. Write record events only through that CLI.
${entryLessons(context)}`;
}
