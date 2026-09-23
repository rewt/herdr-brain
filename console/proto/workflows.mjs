// Live-console workflows represented with local fixtures, never live effects.
import { projects, runs, sessions } from './fixtures.mjs';

const operational = {
  harbor: { used: 8, cap: 30, loop: 'on', loopHealth: 'ok', stop: false, herdr: 'connected', stale: false,
    direction: 'Keep saved work readable. Finish recovery before expanding the file format.',
    alerts: ['Import recovery is waiting for a retry policy.'] },
  orchard: { used: 3, cap: 30, loop: 'off', loopHealth: 'down', stop: true, herdr: 'unavailable', stale: true,
    direction: 'Keep draft notes private until the export format is decided.',
    alerts: ['Herdr is unavailable; session information is last known.', 'New launches are paused by the project STOP marker.'] },
};
export function operationFor(s, project = s.scope) {
  const original = operational[project];
  return original ? { ...original, loop: s.workflow.loops[project] ?? original.loop,
    direction: s.workflow.instructions[project] ?? original.direction } : null;
}
export const operationRows = (s) => projects.filter((p) => s.scope === 'all' || p.name === s.scope)
  .map((p) => ({ project: p.name, ...operationFor(s, p.name) }));

export const recordedAnswers = [{
  key: 'answer:harbor:HUM-4', id: 'HUM-4', project: 'harbor', kind: 'history',
  title: 'Keep import validation local', at: '2026-09-19 13:10',
  answer: 'yes', answeredBy: 'executive-1310',
  summary: 'The executive kept validation local under the existing goal authority.',
  why: 'Local fixtures reproduce the failure without sending saved records elsewhere.',
}];

export function documentFor(row) {
  if (!row) return null;
  const session = row.name ? row : sessions.find((s) => s.name === row.data?.session);
  const run = runs.find((r) => session ? r.agent === session.name : r.item === (row.task ?? row.id));
  if (row.kind === 'waiting' && row.data?.screen)
    return { label: 'Captured screen', text: row.data.screen, path: null, markdown: false };
  if (row.kind === 'waiting') return {
    label: 'Decision memo', path: `/fixture/memos/${row.id}.md`, markdown: true,
    text: `# ${row.title}\n\n${row.data.digest.explain}\n\n## Recommendation\n\n${row.data.digest.why}\n\n## Options\n\n${row.data.digest.options.map((o) => `- ${o.key}. ${o.label}`).join('\n')}`,
  };
  if (row.kind === 'dispatch-decision') return null;
  if (row.name || row.kind === 'item') return {
    label: 'Task brief', path: run?.brief_path ?? `/fixture/briefs/${row.id}.md`, markdown: true,
    text: `# ${run?.title ?? row.title}\n\nPreserve saved work while making the recovery path reproducible.\n\n## Acceptance\n\n- Existing saved work stays readable.\n- Interrupted work can be retried without duplicating completed rows.\n\n## Evidence\n\nRun the fixture checks and leave a report with the observed result.`,
  };
  if (row.kind === 'read' || row.kind === 'history') return {
    label: row.answer ? 'Decision record' : 'Report', path: `/fixture/reports/${row.id}.md`, markdown: true,
    text: `# ${row.title}\n\n${row.data?.note ?? row.note ?? row.summary ?? row.text ?? 'No report text recorded.'}\n\n## Evidence\n\nThis is a synthetic document for the prototype.`,
  };
  return null;
}

export function contextFor(row) {
  const session = row.name ? row : sessions.find((s) => s.name === row.data?.session);
  const run = runs.find((r) => session ? r.agent === session.name : r.item === (row.task ?? row.id));
  return [
    ['record', row.key ?? row.id ?? row.name], ['project', row.project],
    ['task', row.task ?? run?.item ?? row.id], ['goal', row.goal ?? row.parent],
    ['run', run?.run], ['session', session?.name], ['state', row.status ?? session?.status],
    ['harness', run?.harness], ['model', run?.model], ['effort', run?.effort],
    ['workspace', run?.workspace], ['pane', session?.pane], ['brief', run?.brief_path],
    ['org', `/fixture/${row.project}/.org`], ['captured', row.data?.at ?? row.at],
  ].filter(([, value]) => value != null);
}
