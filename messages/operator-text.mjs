// Presentation is data, never routing or decision authority. No body reads.
import { UserError } from '../lib/store.mjs';
import { sanitizeTerminal } from '../lib/sanitize.mjs';

const technical = /\b(?:ENG|ARCH|HUM|G|R|L|RC)-?\d+\b|\b(?:event|seq|pid|sid|bootstrap)\s*\d+\b|\b(?=[a-f\d]*\d)[a-f\d]{7,64}\b|\b[a-f\d]{32,64}\b|\bw[\w]+:p\d+\b|\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b|\b(?:record-only|conditionally source-closed|receipt|source (?:head|entry|root|closed|inventory)|CAS|TAP|HEAD|sha256|fast-forward)\b|(?:^|\s)\/[\w/.~-]+|\b[\w.-]+\.(?:mjs|jsonl?|md|sh)\b/iu;
const singleLine = (value, limit) => typeof value === 'string' && value.trim() && [...value].length <= limit && !/[\p{Cc}\u2028\u2029]/u.test(value);
const fail = text => { throw new UserError(`operator wording: ${text}`); };
export function validateOperatorText(summary, text) {
  if (text === undefined) return; // Legacy envelopes remain exact, accepted data.
  if (!text || typeof text !== 'object' || Array.isArray(text) ||
      Object.keys(text).some(k => !['happened', 'action', 'details'].includes(k)) ||
      !singleLine(summary, 240) || !singleLine(text.happened, 1000) || !singleLine(text.action, 500) ||
      typeof text.details !== 'string' || text.details.length > 4096 || /[\p{Cc}\u2028\u2029]/u.test(text.details))
    fail('provide one-line --summary, --happened and --action; --details is an optional single line');
  if ([summary, text.happened, text.action].some(value => technical.test(value)))
    fail('put technical identifiers and shorthand in --details, and author the main text in plain words');
}
const line = value => sanitizeTerminal(value).replace(/\s+/gu, ' ').trim();

export function operatorWording(envelope, { decisionNeeded = false } = {}) {
  const p = envelope.payload, authored = p.operator_text;
  let usable = authored !== undefined;
  try { validateOperatorText(p.summary, authored); } catch { usable = false; }
  const details = [];
  if (usable && authored.details) details.push(authored.details);
  if (!usable) {
    details.push(`Original message: ${p.summary}`);
    if (authored !== undefined) details.push(`Original wording fields: ${JSON.stringify(authored)}`);
  } else if (decisionNeeded) details.push(`Authored action: ${authored.action}`);
  details.push(`message=${envelope.eventId}`);
  for (const ref of p.refs) details.push([ref.orgRef, ref.item, ref.run].filter(Boolean).join(':'));
  if (p.body_ref) details.push(`body=${p.body_ref.path} (not opened)`);
  if (envelope.correlationId) details.push(`thread=${envelope.correlationId}`);
  if (p.reply_to) details.push(`reply=${p.reply_to}`);
  return { headline: usable ? p.summary : 'An update is available.',
    happened: usable ? authored.happened : 'The original summary is included in the details.',
    action: decisionNeeded ? 'Your decision is needed.' : usable ? authored.action : 'Check the details to see whether you need to act.',
    details: details.map(line).join('; ') };
}
