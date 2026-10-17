// The legacy protocol witnesses explicitly declare proving. Ordinary CLI runs
// must remain shared; no production environment switch selects exclusivity.
import { resourceStanza } from '../../resources.mjs';
export const provingResource = argv => ({ ...resourceStanza('fixture/proving', argv, 'EXCLUSIVE'), evidence: ['fixture proving witness'] });
export function provingRun(args) {
  const run = args.indexOf('run'), separator = args.indexOf('--', run);
  if (run < 0 || separator < 0 || args.slice(run, separator).includes('--resource')) return args;
  return [...args.slice(0, separator), '--resource', JSON.stringify(provingResource(args.slice(separator + 1))), ...args.slice(separator)];
}
