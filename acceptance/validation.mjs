// Intersect the product's fixed validation profile with the gate's boundary.
// A second sandbox cannot be installed inside macOS Seatbelt; compose once.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { permissionFilesystem, permissionArgs, within } from './security.mjs';

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

function immutable(file, directoryPrefix, mode, contents) {
  const directory = path.dirname(file), parent = fs.lstatSync(directory), entry = fs.lstatSync(file);
  assert.ok(path.dirname(directory) === fs.realpathSync('/tmp') && path.basename(directory).startsWith(directoryPrefix)
    && parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o777) === 0o700
    && entry.isFile() && entry.uid === process.getuid() && (entry.mode & 0o777) === mode
    && fs.realpathSync(file) === file && (!contents || fs.readFileSync(file, 'utf8') === contents),
  'acceptance_product_boundary: redirected validation lifetime resource');
}

export function validationTransport(spec, args, cwd = process.cwd()) {
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
  assert.ok(within(spec.repo, cwd) || within(spec.temp, cwd), 'acceptance_product_boundary: validation checkout escaped its project/session');
  filesystem[cwd] = 'write';
  for (const [file, access] of Object.entries(product)) {
    if (file.startsWith(':')) { assert.ok([':root', ':workspace_roots'].includes(file), 'acceptance_product_boundary: unknown validation permission'); continue; }
    assert.ok(path.isAbsolute(file) && ['read', 'none', 'write'].includes(access), 'acceptance_product_boundary: unsupported validation permission');
    if (access === 'none') filesystem[file] = 'none';
    else if (access === 'read') {
      // Do not turn a product's root-readable profile into a foreign read grant.
      if (withinExisting(spec.repo, file) || withinExisting(spec.temp, file)) filesystem[file] = 'read';
    } else assert.ok(withinExisting(cwd, file), 'acceptance_product_boundary: validation added external writes');
  }
  const command = args.slice(separator + 1);
  const lifetime = command[1] === '--enter';
  if (lifetime) {
    const [owner, , allowed, denied] = command;
    assert.ok(path.basename(owner) === 'owner' && [allowed, denied].every((file) => /^probe-[a-f0-9-]+$/u.test(path.basename(file)))
      && allowed !== denied && path.dirname(allowed) === path.dirname(denied) && product[denied] === 'none',
    'acceptance_product_boundary: invalid validation lifetime protocol');
    immutable(owner, 'monitor-owner-', 0o755);
    for (const file of [allowed, denied]) immutable(file, 'monitor-lifetime-', 0o400, 'probe');
    // Two inert private probes identify the kernel policy. Only one is readable;
    // their parent, other owners, harness files and account state stay denied.
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
