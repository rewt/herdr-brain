// Transparent host transport for an actual product-installed entry adapter.
// This captures delivery of developer policy; it never authors that policy.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { within, permissionArgs } from './security.mjs';
const [root, name, ...args] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(path.join(root, 'live-jobs', `${name}.json`), 'utf8'));
assert.ok(within(spec.repo, process.cwd()) || within(spec.temp, process.cwd()), 'acceptance_product_boundary: product entry checkout escaped its project/session');
assert.ok(!Object.keys(process.env).some((k) => /^(HERDR|ACCEPTANCE)/.test(k)), 'acceptance_product_boundary: product entry leaked capabilities');
for (let i = 0; i < args.length; i++) {
  assert.ok(!/^(?:--dangerously|--yolo|--sandbox|--full-auto)/.test(args[i]), 'acceptance_product_boundary: product entry cannot bypass the gate profile');
  const equals = args[i].match(/^(?:--cd|--add-dir)=(.*)$/);
  const short = args[i].match(/^-C(.+)$/);
  if (!equals && !short && !['-C', '--cd', '--add-dir'].includes(args[i])) continue;
  const target = equals?.[1] ?? short?.[1] ?? args[++i];
  assert.ok(within(spec.repo, target) || within(spec.temp, target), 'acceptance_product_boundary: product entry added a foreign root');
}
const instruction = args.find((s) => s.startsWith('developer_instructions='));
if (instruction) {
  const policy = JSON.parse(instruction.slice('developer_instructions='.length));
  const source = path.join(spec.installation, 'discovery/policy.mjs');
  assert.ok(policy.includes(source), 'acceptance_product_boundary: product policy must name its installed source');
  fs.writeFileSync(path.join(root, 'evidence', `${name}.entry.json`), JSON.stringify({ source, policy, args, cwd: process.cwd() }, null, 2));
}
// Validation launches supplied by the product must retain this gate's read and
// write boundary too, rather than restoring a root-readable native profile.
let nativeArgs = [...args, ...permissionArgs(spec)];
if (args[0] === 'sandbox') {
  const separator = args.indexOf('--');
  assert.ok(separator > 0, 'acceptance_product_boundary: sandbox transport requires a command separator');
  const options = args.slice(1, separator).filter((arg, index, list) =>
    !['-P', '--permission-profile'].includes(arg) && !['-P', '--permission-profile'].includes(list[index - 1]));
  nativeArgs = ['sandbox', ...options, '--permission-profile', 'acceptance', ...permissionArgs(spec, { gitWrites: false }), '--', ...args.slice(separator + 1)];
}
const child = spawn(spec.binary, nativeArgs, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('close', (code) => { process.exitCode = code ?? 1; });
