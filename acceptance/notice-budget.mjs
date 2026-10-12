// Case 07 proves promotion notices reach the supervisor PTY at production
// cadence, so its wait is derived from the inbox owner's defaults in
// supervisor/prompt-supervisor.mjs instead of the runner's generic limit.
// Before each prompt the owner confirms a quiet composer for
// SUPERVISOR_INPUT_CONFIRM_SECONDS; while the agent is busy it re-checks every
// SUPERVISOR_INPUT_POLL_SECONDS. The stand-in reports working after each
// prompt, so every notice can cost one poll plus one confirmation.
export const noticeCadence = Object.freeze({ pollSeconds: 10, confirmSeconds: 3 });
const marginSeconds = 15;

// Three notices: 3 x (10 + 3) + 15 = 54 s, rounded up to a whole minute.
// waitUntil still scales the result for measured load.
export function noticeDeliveryBudgetMs(count, { pollSeconds, confirmSeconds } = noticeCadence) {
  return Math.ceil((count * (pollSeconds + confirmSeconds) + marginSeconds) / 60) * 60_000;
}
