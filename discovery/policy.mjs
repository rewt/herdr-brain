import { quote } from '../lib/shell.mjs';
import { supervisorPolicy } from '../supervisor/protocol.mjs';
import { entryLessons } from './lessons.mjs';

export function entryPolicy(context, root) {
  const record = `ORG_DIR=${quote(context.org)} ${quote(process.execPath)} ${quote(`${root}/bin/org.mjs`)}`;
  const policy = context.role === 'chat'
    ? `You are the operator's project chat. Coordinate through the record, dispatch, watch and lanes. Route routine notices to the project's ops supervisor. Only the canonical project supervisor starts housekeeping.`
    : context.role === 'supervisor' ? supervisorPolicy(context, root)
    : `Work in your assigned lane. Workers use the project's fast validation and never run the release gate. Only the canonical supervisor starts housekeeping. Commit the work, write and check the report, and follow the project's promotion instructions.`;
  return `Project checkout: ${context.canonical}; shared record: ${context.org}.
Read applicable AGENTS.md and CLAUDE.md instructions before acting.
${policy}
Record CLI: ${record}. Status, show, today and lessons recover durable context. Write record events only through that CLI.
${entryLessons(context)}`;
}
