// Permit only lane's generated private source/verify pair, never an arbitrary
// pane command or cleanup target. The acceptance TMPDIR keeps both in scratch.
import fs from 'node:fs';
import path from 'node:path';

export function scratchProductHomes(root, home = path.join(root, 'home')) {
  return { HOME: home, ZDOTDIR: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local/state'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), BRAIN_STATE: path.join(home, '.local/state/herdr-brain'),
    HERDR_MONITOR_FLEET: path.join(root, 'f'), HERDR_MONITOR_HOME: path.join(home, '.local/share/herdr-monitor'),
    HERDR_MONITOR_BIN: path.join(home, '.local/bin'), HERDR_MONITOR_ENTRY_BIN: path.join(home, 'entry/bin'),
    HERDR_MONITOR_PLIST: path.join(home, 'Library/LaunchAgents/herdr-monitor.plist'),
    HERDR_ORG_CONSOLE_CONFIG: path.join(home, '.config/herdr-org/console.json') };
}

// The reusable settle fixture deliberately scrubs machine variables. Restore
// scratch homes at its execution boundary rather than changing test helpers.
export function scratchFixtureCommand(execute) {
  return (file, args, options) => {
    const home = options.env.HOME, root = path.dirname(home);
    const env = { ...options.env, ...scratchProductHomes(root, home) };
    assertScratchHomes(env, [root]);
    return execute(file, args, { ...options, env });
  };
}

// In-process product modules use os.homedir()/process.env too. Return a restore
// function so the caller's operator environment survives success and failure.
export function enterScratchHomes(env, roots, options = {}) {
  assertScratchHomes(env, roots, options);
  const keys = Object.keys(scratchProductHomes('/unused'));
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = env[key];
  return () => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } };
}

function resolved(file) {
  try { return fs.realpathSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(resolved(parent), path.basename(file));
  }
}
const contains = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };

// Call with the product's fleetPath result at the runner/installed-entry
// boundary. Explicit fleet selection also makes the copied PTY check exact.
export function assertScratchHomes(env, roots, { realHome, fleetFile = env.HERDR_MONITOR_FLEET && path.join(env.HERDR_MONITOR_FLEET, 'fleet.json') } = {}) {
  if (!env.HERDR_MONITOR_FLEET || !fleetFile) throw new Error('acceptance requires an explicit scratch fleet');
  const owned = roots.map(resolved), operator = realHome && resolved(realHome);
  const paths = { ...Object.fromEntries(Object.keys(scratchProductHomes('/unused')).map(key => [key, env[key]])), fleetPath: fleetFile };
  for (const [key, file] of Object.entries(paths)) {
    if (!file || !path.isAbsolute(file)) throw new Error(`acceptance requires an absolute scratch ${key}`);
    const target = resolved(file);
    if (operator && contains(operator, target)) throw new Error(`acceptance refuses ${key} under the real home`);
    if (!owned.some(root => contains(root, target))) throw new Error(`acceptance refuses ${key} outside scratch roots`);
  }
  return env;
}

const token = String.raw`'(?:[^']|'\\'')*'`;
const decode = value => value.slice(1, -1).replaceAll("'\\''", "'");
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function isLaneEnvironmentCommand(command, root) {
  try {
    const match = new RegExp(`^ \\. (${token}) 2>/dev/null; command rm -f -- (${token}) (${token})$`, 'u').exec(command);
    if (!match) return false;
    const [file, removed, verifier] = match.slice(1).map(decode);
    const directory = path.dirname(file);
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(directory));
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative) ||
        !path.basename(directory).startsWith('herdr-lane-env-') || file !== removed ||
        file !== path.join(directory, 'prepare.sh') || verifier !== path.join(directory, 'verify.sh') ||
        fs.lstatSync(directory).isSymbolicLink() || (fs.statSync(directory).mode & 0o777) !== 0o700) return false;
    for (const entry of [file, verifier]) {
      const stat = fs.lstatSync(entry);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) return false;
    }
    const source = fs.readFileSync(file, 'utf8');
    const exports = new RegExp(`^set \\+x\nexport ((${token})(?: ${token})*) \\|\\| return\ncommand /bin/sh (${token})\n$`, 'u').exec(source);
    if (!exports || decode(exports[3]) !== verifier) return false;
    const pairs = [...exports[1].matchAll(new RegExp(token, 'gu'))].map(item => decode(item[0]));
    if (pairs.some(pair => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(pair) || pair.includes('\0'))) return false;
    const effective = new Map(pairs.map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
    const proof = fs.readFileSync(verifier, 'utf8');
    const nonce = /'lane-env-[a-f0-9]{48}'\n$/u.exec(proof)?.[0].trim();
    if (!nonce) return false;
    const checks = [...effective].map(([key, value]) => `[ "\${${key}+x}" = x ] && [ "$${key}" = ${quote(value)} ]`).join(' && ');
    return proof === `${checks} && printf '\\n%s\\n' ${nonce}\n`;
  } catch { return false; }
}

// Only the slot protocol crosses environment scrubbing. A nested detached queue
// must retain both host paths and the live holder token, just like the gate.
export function testSlotEnvironment(env) {
  const keys = ['MONITOR_TEST_SLOT_PATH', 'MONITOR_TEST_SLOT_COMPAT_PATH', 'MONITOR_TEST_SLOT_TOKEN',
    'MONITOR_TEST_SLOT_WAIT_SECONDS', 'MONITOR_TEST_SLOT_TIMEOUT_RETRIED',
    'BCH_CLOAK_TEST_SLOT_TOKEN', 'BCH_CLOAK_TEST_SLOT_WAIT_SECONDS'];
  return Object.fromEntries(keys.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}
