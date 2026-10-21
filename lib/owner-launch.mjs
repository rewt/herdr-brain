// Literal argv composition at the existing owner launch seam; no shell eval.
export function literalLaunch(command, args, prefix) {
  if (prefix === undefined) return { command, args };
  if (!Array.isArray(prefix) || !prefix.length || prefix.some(word => typeof word !== 'string' || !word.length || /\0/u.test(word))) throw Error('identity launch must be nonempty literal argv words');
  return { command: prefix[0], args: [...prefix.slice(1), command, ...args] };
}
