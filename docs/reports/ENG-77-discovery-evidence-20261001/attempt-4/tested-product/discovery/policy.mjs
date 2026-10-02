import { quote } from './runtime.mjs';
export function entryPolicy(context, root) {
  const monitor = `${quote(process.execPath)} ${quote(`${root}/discovery/client.mjs`)}`;
  const record = `ORG_DIR=${quote(context.org)} ${quote(process.execPath)} ${quote(`${root}/bin/org.mjs`)}`;
  return `Herdr Monitor installed project-entry policy (${root}/discovery/policy.mjs).
Project identity: ${context.identity}; canonical checkout: ${context.canonical}; shared record: ${context.org}.
You are a ${context.role}. Your checkout is ${context.workspace}, branch ${context.branch}.
Read this checkout's existing agent instructions and project files. Work on the actual user task.
${context.role === 'worker' ? `Before edits, run: ${monitor} start 'one-sentence actual task'. Read the returned brief; it gives your run ID and exact report path.
For a continuation of recorded work, inspect the record and use ${monitor} resume ITEM instead of adding another item. This creates a fresh run in your own lane.
Do all work in your own lane. Never start project housekeeping, dispatch other agents, push, delete lanes or change another checkout directly.
Use ${monitor} context to retrieve your binding. Git metadata is protected in the sandbox: use this session's bounded adapter commands for Git writes.
After work: write a report with run, outcome (done | blocked | needs_human | failed), summary, headline, blockers, proposals, learnings and artifacts front matter at the returned report path. Run ${record} check REPORT to validate it. Then ${monitor} commit 'subject'; ${monitor} check; ${monitor} promote; ${monitor} finish.
Promotion uses the lane CLI: clean canonical and worker worktrees, clean rebase, sandboxed green validation and local fast-forward. If main moves, retry only after inspecting. If there is a conflict, ${monitor} rebase; resolve conflicts in your checkout; ${monitor} continue; check and promote again. A failed rebase remains recoverable; abort is available.
If work cannot finish, report blocked or needs_human and ${monitor} commit 'report subject'; ${monitor} finish, without promotion. Never report success without actual validation.` : `You coordinate through the record, dispatch, watch and lanes. Only a supervisor in this canonical checkout may start ${quote(process.execPath)} ${quote(`${root}/housekeeping/housekeeping.mjs`)} --start. Workers never start the project loop.
Dispatch: ${quote(process.execPath)} ${quote(`${root}/dispatch/dispatch.mjs`)} ITEM --lane TOPIC --route ROUTE --brief FILE --report FILE (discovers this record, arms watch before prompting).
Watch validates/ingests reports; its entrypoint is ${root}/watch/watch.mjs. Promotion is ${root}/lanes/lane.mjs promote TOPIC; no push or merge commits.`}
Record CLI: ${record}. Status, show and today recover durable context. No record event-log writes outside that CLI.
Routing: ${context.suggestedRoutes ? 'The installed portable preset is suggested, not operator configuration.' : 'Existing project/parent route configuration is authoritative.'}
${context.routing ? `Question ${context.routing.question} in the record proposes Codex gpt-6.1-sol high for engineering and Claude opus high for independent review, with the full portable route preset. It is category other and must wait for the operator. Do not answer on their behalf and do not invent preferences. If the task is routing, inspect it with ${record} show ${context.routing.question}; leave the single question pending and report needs_human. After an actual operator answer, ${monitor} apply-routes writes the approved config into your lane; commit, check and promote it. A text answer must be complete route JSON; a no requires further human guidance.` : ''}
The task prompt carries work, not workflow setup. The installed adapter supplies this policy even in a project with no policy or configuration files.
`;
}
