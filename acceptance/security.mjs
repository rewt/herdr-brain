import fs from 'node:fs';
import path from 'node:path';

export const within = (root, target) => {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export function copiedSandbox(root, toolRoots) {
  // Preserve macOS's system loader reads, while refusing project/user/release
  // code through every host data location. Only scratch and trusted tools are
  // exceptions. Sandboxing matches resolved paths, including symlink aliases.
  const forbidden = ['/Users', '/home', '/Volumes', '/private/tmp', '/private/var/folders'];
  const ancestors = new Set();
  for (const directory of [root, ...toolRoots]) {
    for (let current = path.dirname(directory); current !== path.dirname(current); current = path.dirname(current)) ancestors.add(current);
  }
  return '(version 1)\n(allow default)\n(deny file-write*)\n'
    + forbidden.map((dir) => `(deny file-read* (subpath ${JSON.stringify(dir)}))\n`).join('')
    + '(allow file-read-metadata)\n' // Node must lstat ancestors to resolve scratch scripts
    + [...ancestors].map((dir) => `(allow file-read-data (literal ${JSON.stringify(dir)}))\n`).join('') // Safe directory-FD traversal; no ancestor descendants granted
    + [root, ...toolRoots].map((dir) => `(allow file-read* (subpath ${JSON.stringify(dir)}))\n`).join('')
    + `(allow file-write* (literal "/dev/null"))\n(allow file-write* (subpath ${JSON.stringify(root)}))\n`;
}

export function relocate(text, { live, home, scratchHome, copy, candidate, root, launcher = false }) {
  if (launcher) {
    const target = 'resolve(homedir(), ".local/share/herdr-monitor/current/contrib/settle-watch.mjs")';
    if (!text.includes(target)) throw new Error('required launcher relocation did not match; refuse copied code');
    text = text.replaceAll(target, JSON.stringify(path.join(candidate, 'contrib/settle-watch.mjs')));
  }
  return text.replaceAll(path.dirname(live), path.dirname(copy))
    .replaceAll(path.join(home, '.herdr/worktrees/bch-cloak'), path.join(root, '.herdr/worktrees/bch-cloak'))
    .replaceAll('/private/tmp/apply-settle-cmds.', path.join(root, 'apply-settle-cmds.'))
    .replaceAll('${HOME}', scratchHome).replaceAll('$HOME', scratchHome)
    .replaceAll('homedir()', JSON.stringify(scratchHome))
    .replaceAll(home, scratchHome).replaceAll('~/', `${scratchHome}/`);
}

// Re-run before *every* execution, including transitive imports/shell callers.
// Unknown path spellings fail closed. The OS write boundary is independent of
// this textual check, so a dynamically derived ORG_DIR cannot write live state.
export function auditCopies(directory, { live, home }) {
  const forbidden = [live, path.join(path.dirname(live), '.org'), home,
    path.join(home, '.local/share/herdr-monitor'), '/Users/', '/home/'];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`copied file is a symlink: ${file}`);
    if (entry.isDirectory()) { auditCopies(file, { live, home }); continue; }
    const text = fs.readFileSync(file, 'utf8');
    const residue = forbidden.find((value) => text.includes(value));
    if (residue || /\$(?:\{HOME\}|HOME\b)|homedir\(\)|~\//.test(text)) {
      throw new Error(`unrelocated live path in ${file}: ${residue ?? 'home-relative path'}`);
    }
  }
}

export function sessionEnv(inherited, spec) {
  const env = {};
  // Explicit allowlist: no Herdr/socket/capability variables or inherited
  // credentials, shell startup, routing, record or approval overrides.
  for (const key of ['LANG', 'LC_ALL', 'TERM']) if (inherited[key]) env[key] = inherited[key];
  Object.assign(env, { HOME: spec.temp, TMPDIR: spec.temp, CODEX_HOME: spec.runtimeHome,
    PATH: spec.path, ORG_ACTOR: spec.name, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', OPENSSL_CONF: '/dev/null' });
  return env;
}

export function permissionArgs({ repo, temp, installation, toolRoots, entryBinary, gitCommon, worktreeRoot, probeGit }, { gitWrites = !entryBinary } = {}) {
  const gitAccess = gitWrites ? 'write' : 'read';
  const filesystem = { ':root': 'deny', ':minimal': 'read', ':slash_tmp': 'deny',
    ':tmpdir': 'write', ':workspace_roots': { '.': 'write', '.git': gitAccess }, [installation]: 'read' };
  for (const directory of toolRoots) filesystem[directory] = 'read';
  if (entryBinary) filesystem[repo] = 'read'; // lane cwd stays writable; shared record is readable
  // Every extra grant is inside the session's existing project/temp roots.
  for (const target of [gitCommon, worktreeRoot, probeGit].filter(Boolean)) {
    let ancestor = target;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    if (!(within(repo, ancestor) || within(temp, ancestor))) throw new Error(`Git permission escaped session roots: ${target}`);
    filesystem[target] = target === worktreeRoot ? 'write' : gitAccess;
  }
  const toml = (obj) => `{${Object.entries(obj).map(([k, v]) => `${JSON.stringify(k)}=${typeof v === 'object' ? toml(v) : JSON.stringify(v)}`).join(',')}}`;
  return ['-c', 'default_permissions="acceptance"', '-c', 'permissions.acceptance.extends=":workspace"',
    '-c', `permissions.acceptance.filesystem=${toml(filesystem)}`, '-c', 'permissions.acceptance.network.enabled=false'];
}

export function policyWitness(events, sources, { repo, installation, entryReceipt }) {
  const delivered = path.join(installation, 'discovery/policy.mjs');
  // Developer instructions are received directly, without a file-reading
  // command. The host transport captures the actual candidate adapter's full
  // delivery, so model paraphrases cannot replace (or invalidate) that receipt.
  if (entryReceipt?.source === delivered && typeof entryReceipt.policy === 'string'
      && entryReceipt.policy.includes(delivered) && fs.existsSync(delivered)) {
    return [{ source: delivered, excerpt: entryReceipt.policy, origin: 'installed adapter developer instructions' }];
  }
  const executions = events.filter((e) => e.item?.type === 'command_execution' && e.item.exit_code === 0).map((e) => e.item);
  const simple = (command) => {
    const shell = command.match(/^\S*\/(?:zsh|bash|sh) -c (['"])(.*)\1$/s);
    const inner = shell ? shell[2] : command;
    return /[;\n|&`<>]|\$\(/.test(inner) ? undefined : inner;
  };
  const productCall = (command) => /^(?:record|org|lane)\s/.test(simple(command) ?? '');
  const witnessed = [];
  for (const { source, excerpt } of sources) {
    if (typeof excerpt !== 'string' || excerpt.length < 20) throw new Error('policy source needs a substantive verbatim excerpt');
    if (/^(record|org|lane)\s/.test(source)) {
      if (!executions.some((e) => simple(e.command) === source && productCall(e.command) && e.aggregated_output?.includes(excerpt))) throw new Error(`unwitnessed product CLI policy: ${source}`);
      witnessed.push({ source, excerpt, origin: 'installed CLI output' });
      continue;
    }
    const file = path.isAbsolute(source) ? source : path.resolve(repo, source);
    if (!fs.existsSync(file) || !(within(repo, file) || within(installation, file))) throw new Error(`policy outside project/installed product: ${source}`);
    if (file === path.join(installation, 'AGENTS.md') || !fs.readFileSync(file, 'utf8').includes(excerpt)) throw new Error(`invalid product policy source: ${source}`);
    if (!executions.some((e) => /^(?:cat|sed|head|tail|rg)\s/.test(simple(e.command) ?? '') && e.aggregated_output?.includes(excerpt) && (e.command.includes(source) || e.command.includes(file)))) throw new Error(`policy read absent from transcript: ${source}`);
    // A project file created during the task must be supplied by a successful
    // product invocation, not invented by the model as evidence for itself.
    if (within(repo, file) && !executions.some((e) => productCall(e.command) && e.aggregated_output?.includes(path.basename(file)))) throw new Error(`project policy has no product delivery receipt: ${source}`);
    witnessed.push({ source: file, excerpt, origin: within(repo, file) ? 'product-delivered project file' : 'installed product file' });
  }
  if (!witnessed.length) throw new Error('no product-provided policy source was read; source attribution is required');
  return witnessed;
}
