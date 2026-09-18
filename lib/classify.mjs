// Decide what a result is without paying for it, when that is honest.
//
// When the parser found a dialog, it already holds the question and the
// options verbatim. A model adds nicer wording and nothing else, so the entry
// is built here and no call is made. Only a stopped session whose meaning is
// in prose needs reading by a model.

// Claude Code's own first-run nags. Dismissing one commits to nothing, so the
// least-commitment choice can be recommended without judgement.
const FIRST_RUN = [
  /teach auto mode about your environment/i,
  /would you like to (enable|turn on)/i,
  /tips? for getting started/i,
  /what's new in claude code/i,
];

// The option that clears a nag without agreeing to anything.
const DISMISS = /^(not now|no,? thanks|skip|maybe later|dismiss)$/i;
const NEVER = /^(don'?t show( this)? again|never)$/i;

export function isFirstRunNag(question) {
  return Boolean(question) && FIRST_RUN.some((re) => re.test(question));
}

// A digest-shaped object built from what the parser already knows. Returns
// null when the result needs a model to make sense of it.
export function classifyLocally(entry) {
  if (!entry.dialog?.options?.length) return null;

  const { question, options } = entry.dialog;
  const nag = isFirstRunNag(question);
  const dismiss = options.find((o) => DISMISS.test(o.label.trim()));
  const never = options.find((o) => NEVER.test(o.label.trim()));

  const what = entry.unsent
    ? `This session is sitting at a dialog, and your reply — "${entry.unsent.split('\n')[0]}" — is typed into its prompt box and has not been sent. Clearing the dialog is what lets it go through.`
    : 'This session is sitting at a dialog and cannot move until it is answered.';

  return {
    kind: 'obstacle',
    source: 'parser',
    what_happened: what,
    needs_you: true,
    question: entry.unsent
      ? `Clear this dialog so your reply can be delivered: ${question ?? 'a dialog'}`
      : question ?? 'A dialog is waiting for an answer',
    options: options.map((o) => ({
      key: o.key,
      label: o.label,
      // No invented consequences. The only one that is always true is stated.
      causes: nag && (o === dismiss || o === never)
        ? `Clears the dialog${entry.unsent ? ' and lets your typed reply send' : ''}.`
        : '',
    })),
    // Recommending is a judgement. Only make one for a nag that commits to
    // nothing; a permission prompt gets its options and no opinion.
    recommend: nag ? (dismiss?.key ?? null) : null,
    why: nag && dismiss ? 'It clears the way with no lasting commitment either direction.' : null,
    next_step: null,
  };
}
