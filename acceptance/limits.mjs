export class HarnessLimit extends Error {
  constructor(message) { super(message); this.name = 'HarnessLimit'; }
}

export const isHarnessBoundary = (text) => /acceptance_boundary|native-transport boundary:|sandbox_apply: Operation not permitted|fs sandbox helper failed/.test(text);
