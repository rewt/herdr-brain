// How a Needs you item is answered from the modern console. What a session
// left behind goes through the Brain CLI (brainArgs), so its queue records the
// answer; an org question is answered with `org answer`. Same effects as the
// classic console, laid out as choices on the item's own page.
import { brainArgs } from '../lib/brain.mjs';

// The choices an item offers, each with the key that picks it.
export function needChoices(n) {
  if (!n) return [];
  const has = a => n.actions?.includes(a);
  if (n.kind === 'question' && n.via !== 'answer') {
    return [
      ...(has('approve') ? [{ id: 'approve', key: 'y', label: 'Approve', causes: n.data?.on_yes ?? null, recommended: /^y/i.test(n.data?.recommend ?? '') }] : []),
      ...(has('decline') ? [{ id: 'decline', key: 'n', label: 'Decline, with a reason', causes: n.data?.on_no ?? null, recommended: /^n/i.test(n.data?.recommend ?? ''), needsText: 'Reason' }] : []),
    ];
  }
  return (n.options ?? []).slice(0, 9).map(o => ({ id: `pick:${o.key}`, key: String(o.key), label: o.label, causes: o.causes ?? o.text ?? null, recommended: String(o.key) === String(n.recommendKey), option: o }));
}

// Everything else an item allows, besides choosing.
export function needActions(n, { canOpen = false } = {}) {
  if (!n) return [];
  const has = a => n.actions?.includes(a), report = ['finished', 'report'].includes(n.category);
  return [
    ...(has('reply') || has('draft') ? [{ id: 'reply', key: 'r', label: 'Reply in your words', needsText: 'Reply' }] : []),
    ...(canOpen ? [{ id: 'open', key: 'o', label: 'Open the session' }] : []),
    ...(has('later') ? [{ id: 'later', key: 'l', label: 'Save for later' }] : []),
    ...(has('drop') ? [{ id: 'drop', key: 'x', label: report ? 'Clear, I have read it' : 'Drop it' }] : []),
  ];
}

// What doing it means: the effect, and one sentence saying so before it runs.
export function needEffect(n, choice, text = '') {
  const session = n.data?.tab_label ?? n.session ?? 'the session';
  if (choice.id === 'approve') return { type: 'answer', request: { question: n.question, answer: 'yes' }, says: `Record “yes” for ${n.handle ?? n.question}` };
  if (choice.id === 'decline') return { type: 'answer', request: { question: n.question, answer: 'no', note: text.trim() || null }, says: `Record “no” for ${n.handle ?? n.question}` };
  if (choice.id.startsWith('pick:') && n.kind === 'question') return { type: 'answer', request: { question: n.question, answer: choice.label }, says: `Record “${choice.label}” for ${n.handle ?? n.question}` };
  if (choice.id.startsWith('pick:')) {
    const args = brainArgs('pick', n, { key: choice.key });
    return args && { type: 'brain', args, says: n.via === 'key' ? `Press ${choice.key} (“${choice.label}”) in ${session}` : `Send “${choice.label}” to ${session}` };
  }
  if (choice.id === 'reply') { const args = brainArgs('send', n, { text }); return args && { type: 'brain', args, says: `Send your reply to ${session}` }; }
  if (choice.id === 'later') return { type: 'brain', args: brainArgs('later', n), says: 'Save it for later' };
  if (choice.id === 'drop') return { type: 'brain', args: brainArgs('drop', n), says: choice.label === 'Drop it' ? 'Drop it for good; it will not come back' : 'Clear it from the queue' };
  return null;
}
