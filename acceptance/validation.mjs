// Intersect the product's fixed validation profile with the gate's boundary.
// A second sandbox cannot be installed inside macOS Seatbelt; compose once.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { permissionFilesystem, permissionArgs, within } from './security.mjs';
import { checkedDirectory } from '../discovery/paths.mjs';

// The product emits inline TOML tables containing only quoted strings/tables.
// Parse that small wire format without evaluating code or accepting other TOML.
function table(text) {
  let offset = 0;
  const whitespace = () => { while (/\s/u.test(text[offset] ?? '') && offset < text.length) offset++; };
  const take = (char) => { whitespace(); assert.equal(text[offset++], char, 'acceptance_product_boundary: unsupported validation profile'); };
  const string = () => {
    whitespace(); const match = text.slice(offset).match(/^"(?:[^"\\]|\\.)*"/u);
    assert.ok(match, 'acceptance_product_boundary: unsupported validation profile');
    offset += match[0].length; return JSON.parse(match[0]);
  };
  const value = () => {
    whitespace(); if (text[offset] !== '{') return string();
    take('{'); const result = Object.create(null); whitespace();
    while (text[offset] !== '}') {
      const key = string(); take('=');
      assert.ok(!Object.hasOwn(result, key), 'acceptance_product_boundary: duplicate validation permission');
      result[key] = value(); whitespace();
      if (text[offset] === '}') break;
      take(',');
    }
    take('}'); return result;
  };
  const result = value(); whitespace(); assert.equal(offset, text.length, 'acceptance_product_boundary: trailing validation profile');
  return result;
}

function immutable(file, directoryPrefix, mode, contents, parentRoot = fs.realpathSync('/tmp')) {
  const directory = path.dirname(file), parent = fs.lstatSync(directory), entry = fs.lstatSync(file);
  assert.ok(path.dirname(directory) === parentRoot && path.basename(directory).startsWith(directoryPrefix)
    && parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o777) === 0o700
    && entry.isFile() && entry.uid === process.getuid() && (entry.mode & 0o777) === mode
    && fs.realpathSync(file) === file && (!contents || fs.readFileSync(file, 'utf8') === contents),
  'acceptance_product_boundary: redirected validation lifetime resource');
}

export function validationTransport(spec, args, cwd = process.cwd(), { env = process.env } = {}) {
  const separator = args.indexOf('--');
  assert.ok(args[0] === 'sandbox' && separator > 0, 'acceptance_product_boundary: sandbox transport requires a command separator');
  const options = [], configs = [];
  let profile;
  for (let i = 1; i < separator; i++) {
    if (['-P', '--permission-profile'].includes(args[i])) { profile = args[++i]; continue; }
    if (args[i] === '-c') { configs.push(args[i + 1]); options.push(args[i], args[++i]); continue; }
    options.push(args[i]);
  }
  const prefix = `permissions.${profile}.filesystem=`;
  const declared = configs.filter((option) => option.startsWith(prefix));
  assert.equal(declared.length, 1, 'acceptance_product_boundary: validation requires one explicit filesystem profile');
  const product = table(declared[0].slice(prefix.length));
  assert.equal(product[':root'], 'read', 'acceptance_product_boundary: validation must keep external writes denied');
  assert.deepEqual({ ...product[':workspace_roots'] }, { '.': 'write', '.git': 'read' }, 'acceptance_product_boundary: validation must protect Git');
  const filesystem = permissionFilesystem(spec, { gitWrites: false, validation: true });
  const isRunTemp = file => withinExisting(spec.temp, file) && /^r-[A-Za-z0-9]{6}$/.test(path.basename(file))
    && ['TMPDIR', 'TMP', 'TEMP'].every(key => env[key] === file);
  const privateTemp = file => {
    const directory = checkedDirectory(file), info = fs.statSync(directory);
    assert.ok(info.uid === process.getuid() && (info.mode & 0o777) === 0o700,
      'acceptance_product_boundary: private validation temp required');
    return directory;
  };
  const command = args.slice(separator + 1);
  const lifetime = command[1] === '--enter';
  let lifetimeDirectory;
  if (lifetime) {
    const [owner, , allowed, denied] = command;
    assert.ok(path.basename(owner) === 'owner' && [allowed, denied].every(file => /^probe-[a-f0-9-]+$/u.test(path.basename(file)))
      && allowed !== denied && path.dirname(allowed) === path.dirname(denied) && product[denied] === 'none',
    'acceptance_product_boundary: invalid validation lifetime protocol');
    immutable(owner, 'monitor-owner-', 0o755);
    lifetimeDirectory = path.dirname(allowed);
    const parentRoot = path.dirname(lifetimeDirectory);
    if (parentRoot !== fs.realpathSync('/tmp')) {
      assert.ok(isRunTemp(parentRoot), 'acceptance_product_boundary: redirected validation lifetime resource');
      privateTemp(parentRoot);
    }
    for (const file of [allowed, denied]) immutable(file, 'monitor-lifetime-', 0o400, 'probe', parentRoot);
  }
  assert.ok(within(spec.repo, cwd) || within(spec.temp, cwd), 'acceptance_product_boundary: validation checkout escaped its project/session');
  filesystem[cwd] = 'write';
  const gitPaths = [path.join(cwd, '.git'), spec.gitCommon, spec.probeGit].filter(Boolean);
  const protectedPaths = Object.entries(product).filter(([file, access]) => !file.startsWith(':') && ['read', 'none'].includes(access)).map(([file]) => file);
  for (const [file, access] of Object.entries(product)) {
    if (file.startsWith(':')) { assert.ok([':root', ':workspace_roots'].includes(file), 'acceptance_product_boundary: unknown validation permission'); continue; }
    assert.ok(path.isAbsolute(file) && ['read', 'none', 'write'].includes(access), 'acceptance_product_boundary: unsupported validation permission');
    if (access === 'none') filesystem[file] = 'none';
    else if (access === 'read') {
      // Do not turn a product's root-readable profile into a foreign read grant.
      if (withinExisting(spec.repo, file) || withinExisting(spec.temp, file)) filesystem[file] = 'read';
    } else {
      const runTemp = isRunTemp(file);
      assert.ok(withinExisting(cwd, file) || runTemp, 'acceptance_product_boundary: validation added external writes');
      const directory = checkedDirectory(file);
      if (runTemp) privateTemp(file);
      assert.ok(!gitPaths.some((git) => withinExisting(directory, git) || (fs.existsSync(git) && within(git, directory)))
        && !protectedPaths.some(protectedPath =>
          // Validated inert lifetime probes remain read-only via their own
          // nested grant; no other protected descendant can be covered.
          !(runTemp && lifetime && protectedPath === command[3]) && withinExisting(directory, protectedPath)),
      'acceptance_product_boundary: validation write exception overlaps protected state');
      // Preserve the parent's exact private per-run temp, or the legacy
      // in-checkout grant beneath read-only .lane,
      // while refusing redirected grants or grants covering protected state.
      filesystem[directory] = 'write';
    }
  }
  if (lifetime) {
    const allowed = command[2], denied = command[3];
    if (isRunTemp(path.dirname(lifetimeDirectory))) filesystem[lifetimeDirectory] = 'read';
    filesystem[allowed] = 'read'; filesystem[denied] = 'none';
  }
  return { args: ['sandbox', ...options, '--permission-profile', 'acceptance', ...permissionArgs(spec, { filesystem }), '--', ...command], lifetime };
}

function withinExisting(root, file) {
  let ancestor = file;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor); if (parent === ancestor) return false; ancestor = parent;
  }
  return within(root, ancestor);
}
