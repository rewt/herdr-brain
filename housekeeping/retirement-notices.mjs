// Housekeeping observations and delivery receipts, never record status.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from '../lib/store.mjs';
import { enqueueSupervisor } from '../supervisor/prompt-supervisor.mjs';

export function noticeIdleRetirement({ status, snapshot, stateDir, cwd, org, herdr,
  to = process.env.MONITOR_SUPERVISOR_AGENT || 'supervisor-herdr', dryRun = false, log = () => {},
  enqueue = enqueueSupervisor } = {}) {
  if (!stateDir) return;
  const file = path.join(stateDir, 'retirement-notices.json');
  const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const next = {}, now = Date.parse(status.generatedAt);
  const save = value => {
    fs.mkdirSync(stateDir, { recursive: true });
    writeFileAtomic(file, JSON.stringify(value) + '\n');
  };
  // A tab row already contains every pane's occupant and recommendation. Send
  // one notice for that row, coalescing its duplicate pane projections.
  for (const row of status.rows.filter(r => r.type === 'tab' && r.class === 'IDLE-NONTERMINAL')) {
    const agents = (snapshot.agents ?? []).filter(a => a.tab_id === row.tab);
    const key = createHash('sha256').update(JSON.stringify([snapshot.common, row.workspace, row.tab,
      row.run, row.reason, row.nextActor, row.recommendation,
      agents.map(a => [a.pane_id, a.terminal_id, a.agent_session, a.state_change_seq])])).digest('hex');
    const receipt = prior[key] ?? { firstSeenAt: status.generatedAt };
    next[key] = receipt;
    if (receipt.sent || now - Date.parse(receipt.firstSeenAt) <= 86400000) continue;
    const command = row.recommendation;
    const id = `housekeeping-retirement:${key}:${Date.parse(receipt.firstSeenAt)}`;
    if (dryRun) { log({ action: 'would-notice', tab: row.tab, run: row.run, command }); continue; }
    if (!command && !receipt.held) {
      next[key] = { ...receipt, held: true };
      // Remember before logging/delivery, so an enqueue failure cannot repeat
      // the held log on every tick. A failed enqueue remains retryable.
      save({ ...prior, ...next });
      log({ action: 'retirement-notice-held', tab: row.tab, why: 'exact release identity unavailable' });
    }
    const action = command ? `Confirm disposition before running (fill pane-release placeholders; lane close archive-tags unmerged work): ${command}` :
      'Release held: exact release identity unavailable (recorded pane, native session, terminal and HEAD, or canonical lane-close root). Supervisor must resolve the missing identity for this lane before releasing it.';
    const message = `Housekeeping: IDLE-NONTERMINAL tab ${row.tab}, run ${row.run}, lane ${row.lane ?? row.worktree}, identity ${snapshot.common}, unchanged for more than 24 h. Next actor: ${row.nextActor}. ${action}`;
    const queued = enqueue(to, message, { id, cwd, org, herdr });
    // Enqueue has a deterministic ID: a crash before this save reuses the same
    // durable inbox entry instead of producing another supervisor notice.
    next[key] = { ...next[key], sent: queued.id };
    log({ action: 'retirement-notice', tab: row.tab, run: row.run, notice: queued.id, command });
  }
  if (!dryRun) save(next);
}
