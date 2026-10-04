// Portable operator-approved suggestion, with no machine paths, personas,
// memory profiles, approval bypasses or account assumptions.
export const ROUTE_PRESET = {
  schema: 1,
  authority: 'Herdr Monitor suggested routes (operator confirmation pending)',
  dispatch: { kind: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  routes: {
    engineer: { kind: 'codex', model: 'gpt-6.1-sol', effort: 'high', use: 'Default implementation' },
    'engineer-xhigh': { kind: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', use: 'Difficult implementation' },
    'engineer-max': { kind: 'codex', model: 'gpt-6.1-sol', effort: 'max', use: 'Correctness-critical implementation' },
    chore: { kind: 'codex', model: 'gpt-5.6-terra', effort: 'medium', use: 'Mechanical changes' },
    unblock: { kind: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', use: 'Bounded planning' },
    review: { kind: 'claude', model: 'opus', effort: 'high', use: 'Independent review' },
    'review-codex': { kind: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', use: 'Independent Codex review' },
    'review-max': { kind: 'claude', model: 'opus', effort: 'xhigh', use: 'Critical review' },
    monitor: { kind: 'codex', model: 'gpt-5.6-luna', effort: 'low', use: 'One-shot status' },
    settle: { kind: 'claude', model: 'sonnet', effort: 'medium', use: 'Report settlement' },
    'settle-opus': { kind: 'claude', model: 'opus', effort: 'high', use: 'Security settlement' },
    executive: { kind: 'claude', model: 'opus', effort: 'high', use: 'Operator steering' },
    writer: { kind: 'claude', model: 'sonnet', effort: 'medium', use: 'Prose' },
    triage: { kind: 'claude', model: 'sonnet', effort: 'low', use: 'Record hygiene' },
    research: { kind: 'claude', model: 'opus', effort: 'high', use: 'Bounded research' },
  },
  selection_policy: { primary_implementation_pool: 'codex', by_task_class: {
    implementation: 'engineer', difficult: 'engineer-xhigh', critical: 'engineer-max',
    chore: 'chore', planning: 'unblock', review: { claude: 'review', codex: 'review-codex' },
    status: 'monitor', settle: 'settle', executive: 'executive', writing: 'writer', research: 'research',
  } },
};
