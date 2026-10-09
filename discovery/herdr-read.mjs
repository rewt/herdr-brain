// The installed launcher supplies a pinned executable before the user's argv.
// No shell, PATH lookup, environment-selected executable or general forwarding.
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

export function readArguments(args) {
  const pane = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}:p[1-9][0-9]{0,9}$/u;
  const workspace = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
  const number = /^[1-9][0-9]{0,8}$/u;
  const text = /^[A-Za-z0-9 .,!?_:@/+=-]{1,256}$/u;
  const regex = /^[A-Za-z0-9 .,_:@/+=^$*+?()[\]{}|!-]{1,256}$/u;
  const fail = () => { throw new Error('only pane read, pane list, tab list and pane wait-output with validated arguments are allowed'); };
  if (args.some(arg => typeof arg !== 'string' || /[\r\n\0]/u.test(arg))) return fail();
  const [group, operation, ...rest] = args;
  if ((group === 'pane' || group === 'tab') && operation === 'list') {
    if (rest.length === 0) return [group, 'list'];
    if (rest.length === 2 && rest[0] === '--workspace' && workspace.test(rest[1])) return [group, 'list', ...rest];
    return fail();
  }
  if (group !== 'pane' || !['read', 'wait-output'].includes(operation) || !pane.test(rest[0] ?? '')) return fail();
  const id = rest.shift(), options = new Map();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i], value = rest[i + 1];
    if (options.has(flag) || typeof value !== 'string' || value.startsWith('-')) return fail();
    const patterns = operation === 'read' ? { '--lines': number } :
      { '--lines': number, '--timeout': number, '--match': text, '--regex': regex, '--source': /^(visible|recent|recent-unwrapped)$/u };
    if (!patterns[flag]?.test(value)) return fail();
    options.set(flag, value);
  }
  if (operation === 'wait-output' && Number(options.has('--match')) + Number(options.has('--regex')) !== 1) return fail();
  // Reconstruct the argv in a fixed order; input can never become a global flag.
  return ['pane', operation, id, ...['--lines', '--match', '--regex', '--source', '--timeout'].flatMap(flag => options.has(flag) ? [flag, options.get(flag)] : [])];
}

// Both read and scoped launchers use this unbuffered path without a deadline.
export function executeRead(binary, argv, { env = process.env, label = 'herdr-read' } = {}) {
  const child = spawn(binary, argv, { env, stdio: 'inherit', shell: false });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(`${label}: ${error.message}`); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

// Comparing the module path avoids running this branch when tests import it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const binary = process.argv[2];
    if (!binary?.startsWith('/')) throw new Error('installed Herdr binary is unavailable');
    const argv = readArguments(process.argv.slice(3));
    executeRead(binary, argv);
  } catch (error) { console.error(`herdr-read: ${error.message}`); process.exitCode = 1; }
}
