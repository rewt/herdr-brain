import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { parseEvent } from './schema.mjs';
import { nativeSender, makeEnvelope, prepareEnvelope, recordMessages, pushReserved, operatorDigest } from './operator-inbox.mjs';
import { renderOperatorDigest } from '../lib/render.mjs';
import { UserError, loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';

export async function messagesCommand(argv, { openOrg, mutate, out }) {
  const { values: opt, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    file: { type: 'string' }, id: { type: 'string' }, kind: { type: 'string' }, summary: { type: 'string' },
    happened: { type: 'string' }, action: { type: 'string' }, details: { type: 'string' },
    run: { type: 'string' }, item: { type: 'string' }, question: { type: 'string' }, correlation: { type: 'string' },
    'reply-to': { type: 'string' }, limit: { type: 'string' }, after: { type: 'string' }, json: { type: 'boolean' },
  } });
  const [action] = positionals;
  if (positionals.length !== 1 || !['send', 'digest', 'push'].includes(action))
    throw new UserError('usage: record messages send --id ID --summary HEADLINE --happened TEXT --action TEXT [--details TEXT --kind KIND --run R-n --item ID --question HUM-n --correlation ID --reply-to ID] | send --file ENVELOPE | digest [--limit 5 --after SEQ --json] | push --id ID');
  const allowed = action === 'digest' ? ['limit', 'after', 'json'] : action === 'push' ? ['id', 'json']
    : opt.file ? ['file', 'json'] : ['id', 'kind', 'summary', 'happened', 'action', 'details', 'run', 'item', 'question', 'correlation', 'reply-to', 'json'];
  if (Object.keys(opt).some(key => !allowed.includes(key))) throw new UserError('options do not match messages action');
  const ctx = openOrg({ readOnly: action === 'digest' });
  if (action === 'digest') {
    const result = operatorDigest(ctx.events, fs.realpathSync(ctx.dir), { limit: Number(opt.limit ?? 5), ...(opt.after === undefined ? {} : { after: Number(opt.after) }) });
    out(opt.json ? JSON.stringify(result) + '\n' : renderOperatorDigest(result));
    return 0;
  }
  if (action === 'push' && !opt.id || action === 'send' && !opt.file && (!opt.id || !opt.summary)) throw new UserError('send requires --id and --summary (or --file); push requires --id');
  if (action === 'send' && ['happened', 'action', 'details'].some(k => opt[k] !== undefined) && (!opt.happened || !opt.action))
    throw new UserError('plain operator wording requires both --happened and --action; put identifiers in --details');
  const supplied = opt.file ? parseEvent(fs.readFileSync(opt.file, 'utf8')) : null;
  let envelope;
  if (action === 'send') {
    const saved = mutate(ctx, (state, events) => {
      const binding = nativeSender(ctx.dir);
      const event = supplied ?? makeEnvelope({ ...opt, replyTo: opt['reply-to'] }, binding, events, ctx.now);
      return prepareEnvelope(event, binding, state, events);
    });
    envelope = saved.result;
  } else {
    envelope = recordMessages(ctx.events).find(e => e.envelope.eventId === opt.id)?.envelope;
    if (!envelope) throw new UserError('unknown recorded message id');
  }
  // Re-read source/question/native binding at the distinct transport boundary.
  let push;
  try {
    const binding = nativeSender(ctx.dir), { events } = loadEvents(ctx.dir);
    push = await pushReserved(envelope, binding, fold(events));
  } catch (error) { push = { state: 'held', error: error.message }; }
  out(JSON.stringify({ id: envelope.eventId, recorded: true, push }) + '\n');
  return push.error ? 1 : 0;
}
