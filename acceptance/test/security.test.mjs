import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { auditCopies, relocate, sessionEnv, permissionArgs, policyWitness, copiedSandbox } from '../security.mjs';

test('relocation requires the expected launcher and audits every transitive copied file before use', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-relocation-')));
  try {
    const copy = path.join(root, 'copy'); fs.mkdirSync(copy);
    const settings = { root, copy, live: '/Users/operator/project', home: '/Users/operator', scratchHome: path.join(root, 'home'), candidate: path.join(root, 'candidate') };
    const source = 'const TARGET = resolve(homedir(), ".local/share/herdr-monitor/current/contrib/settle-watch.mjs");\nconst ROOT="/Users/operator/project";';
    fs.writeFileSync(path.join(copy, 'launch.mjs'), relocate(source, { ...settings, launcher: true }));
    auditCopies(copy, settings);
    assert.throws(() => relocate(source.replace('resolve(homedir()', 'changed(homedir()'), { ...settings, launcher: true }), /did not match/);
    fs.writeFileSync(path.join(copy, 'new-callee.sh'), 'ORG_DIR=/Users/operator/.org\norg add wrong');
    assert.throws(() => auditCopies(copy, settings), /unrelocated live path/);
    fs.writeFileSync(path.join(copy, 'new-callee.sh'), 'ROOT=$HOME/production\nnode "$ROOT/current/code.mjs"');
    assert.throws(() => auditCopies(copy, settings), /home-relative path/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('kernel boundary denies dynamically computed external code reads and record writes', { skip: process.platform !== 'darwin' }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-kernel-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-external-')));
  try {
    const policy = path.join(root, 'copied.sb'), secret = path.join(outside, 'code.mjs');
    fs.writeFileSync(secret, 'process.exit(42)');
    fs.writeFileSync(policy, copiedSandbox(root, [fs.realpathSync(path.join(path.dirname(process.execPath), '..'))]));
    const script = `const fs=require('fs');for(const op of [()=>fs.readFileSync(${JSON.stringify(secret)}),()=>fs.writeFileSync(${JSON.stringify(path.join(outside, 'events.jsonl'))},'bad')]){let blocked=false;try{op()}catch(e){blocked=['EPERM','EACCES'].includes(e.code)}require('assert').ok(blocked)}fs.writeFileSync(${JSON.stringify(path.join(root, 'allowed'))},'scratch')`;
    const file = path.join(root, 'probe.cjs'); fs.writeFileSync(file, script);
    const result = spawnSync('/usr/bin/sandbox-exec', ['-f', policy, process.execPath, file], { cwd: root, encoding: 'utf8', env: { ...process.env, OPENSSL_CONF: '/dev/null' } });
    assert.equal(result.status, 0, JSON.stringify({ error: result.error?.message, signal: result.signal, stderr: result.stderr })); assert.ok(!fs.existsSync(path.join(outside, 'events.jsonl')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('missing ripgrep is named pending before executing any candidate code', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-prerequisite-')));
  try {
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'which'), '#!/bin/sh\n[ "$1" != rg ] || exit 1\nexec /usr/bin/which "$@"\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, [path.resolve('acceptance/run.mjs'), '--candidate', 'must-not-resolve', '--skip-live'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ACCEPTANCE_TMPDIR: root }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 1, result.stderr);
    const evidence = path.join(root, fs.readdirSync(root).find((s) => s.startsWith('herdr-acceptance-')), 'evidence');
    const summary = JSON.parse(fs.readFileSync(path.join(evidence, 'summary.json')));
    assert.equal(summary.results[0].status, 'PENDING'); assert.equal(summary.results[0].detail, 'missing prerequisite: rg');
    assert.ok(!summary.candidateCommit); assert.ok(!summary.results.some((r) => r.name === 'Candidate snapshot'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('record shim rejects a changed pin and symlink escape before invoking the CLI', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-record-')));
  try {
    fs.mkdirSync(path.join(root, 'org')); fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'));
    const call = (org, pin) => spawnSync(process.execPath, [path.resolve('acceptance/record-shim.mjs'), 'add', 'must not execute'],
      { env: { ...process.env, ACCEPTANCE_ROOT: root, ORG_DIR: org, ACCEPTANCE_PINNED_ORG: pin }, encoding: 'utf8' });
    const changed = call(path.join(root, 'org'), path.join(root, 'different'));
    assert.equal(changed.status, 97); assert.match(changed.stderr, /changed its pinned/);
    const escape = call(path.join(root, 'escape/org'), path.join(root, 'escape/org'));
    assert.equal(escape.status, 97); assert.match(escape.stderr, /outside scratch/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real session environment removes capability, identity and credential overrides', () => {
  const spec = { temp: '/scratch/session', runtimeHome: '/readonly/runtime', repo: '/scratch/project', installation: '/readonly/product', path: '/readonly/bin:/usr/bin', name: 'worker', toolRoots: ['/usr'] };
  const clean = sessionEnv({ HERDR_ENV: '1', HERDR_SOCKET: 'live', ACCEPTANCE_ROOT: 'ledger', OPENAI_API_KEY: 'secret', ORG_DIR: 'live', LANE_CONFIG: 'live', LANG: 'C' }, spec);
  assert.equal(clean.TMPDIR, spec.temp); assert.equal(clean.HOME, spec.temp);
  assert.ok(!Object.keys(clean).some((k) => /^(HERDR|ACCEPTANCE|OPENAI|LANE)/.test(k)));
  assert.ok(!('ORG_DIR' in clean));
  const profile = permissionArgs(spec).join(' ');
  assert.match(profile, /":root"="deny"/); assert.match(profile, /":slash_tmp"="deny"/);
  assert.match(profile, /network.enabled=false/); assert.ok(!profile.includes('ledger'));
});

test('policy attribution refuses repository exposure and unwitnessed self-reports', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-policy-')));
  try {
    const repo = path.join(root, 'project'), installation = path.join(root, 'installed');
    fs.mkdirSync(repo); fs.mkdirSync(installation);
    const excerpt = 'Work in your own lane; check, rebase, and promote by fast-forward.';
    fs.writeFileSync(path.join(root, 'AGENTS.md'), excerpt);
    const claimed = [{ source: path.join(root, 'AGENTS.md'), excerpt }];
    assert.throws(() => policyWitness([], claimed, { repo, installation }), /outside project/);
    assert.throws(() => policyWitness([], [{ source: 'record enter', excerpt }], { repo, installation }), /unwitnessed/);
    assert.throws(() => policyWitness([], [], { repo, installation }), /no product-provided/);
    const events = [{ item: { type: 'command_execution', exit_code: 0, command: 'record enter', aggregated_output: excerpt } }];
    assert.equal(policyWitness(events, [{ source: 'record enter', excerpt }], { repo, installation })[0].origin, 'installed CLI output');
    const forged = [{ item: { ...events[0].item, command: `record status; printf '${excerpt}'` } }];
    assert.throws(() => policyWitness(forged, [{ source: 'record enter', excerpt }], { repo, installation }), /unwitnessed/);
    const source = path.join(installation, 'discovery/policy.mjs');
    fs.mkdirSync(path.dirname(source)); fs.writeFileSync(source, 'export function entryPolicy() {}');
    assert.throws(() => policyWitness([], [{ source, excerpt }], { repo, installation }), /invalid product policy/);
    const entryReceipt = { source, policy: excerpt };
    assert.equal(policyWitness([], [{ source, excerpt }], { repo, installation, entryReceipt })[0].origin, 'installed adapter developer instructions');
    assert.throws(() => policyWitness([], [{ source, excerpt }], { repo, installation, entryReceipt: { ...entryReceipt, source: '/foreign/policy.mjs' } }), /invalid product policy/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
