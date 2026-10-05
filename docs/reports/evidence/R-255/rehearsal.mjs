import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runProjectGateSync } from '/Users/rewt/development/rewt/.worktrees/herdr-brain/lane-gate-profile/promote/gate-profile.mjs';

const repo = '/private/tmp/eng208-bch-rehearsal-R255';
const monitor = '/Users/rewt/development/rewt/.worktrees/herdr-brain/lane-gate-profile';
const env = { ...process.env, HERDR_MONITOR_FLEET: path.join(repo, '.git/offline-fleet'), CARGO_NET_OFFLINE: 'true', COREPACK_ENABLE_NETWORK: '0' };
for (const key of Object.keys(env)) if (/^(ORG_|LANE_|HERDR_(?:AGENT|PANE|TAB|WORKSPACE)|MONITOR_TEST_SLOT_|BCH_CLOAK_TEST_SLOT_TOKEN)/.test(key)) delete env[key];
const git = args => {
  const r = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) throw Error(r.stderr); return r.stdout.trim();
};
const filters = ['@bch-cloak/protocol-runtime...', '@bch-cloak/reference-wallet...', '@bch-cloak/chain-io...', '@bch-cloak/wizardconnect-client...', '@bch-cloak/reference-aggregator...', '@bch-cloak/reference-cli...'];
const gate = { node_version_file: '.nvmrc', env: { BCH_CLOAK_TEST_SLOT_WAIT_SECONDS: '7200', CARGO_NET_OFFLINE: 'true', COREPACK_ENABLE_NETWORK: '0' },
  wait_seconds: 7200, external_lock: path.join(repo, '.git/legacy-promote.flock'), refuse_processes: ['scripts/lane/lane\\.mjs [p]romote(?:\\s|$)'],
  prepare: [{ run: `pnpm install --offline --ignore-scripts --frozen-lockfile --store-dir ${repo}/.pnpm-store ${filters.map(f => `--filter ${f}`).join(' ')}`, unless: 'node_modules' },
    { run: 'pnpm --filter @bch-cloak/reference-wallet --filter @bch-cloak/wizardconnect-client build' }] };
fs.writeFileSync(path.join(repo, '.lane.validation.json'), JSON.stringify({ promotion: 'pnpm validate:all-safe' }, null, 2) + '\n');
fs.writeFileSync(path.join(repo, '.promote.json'), JSON.stringify({ gate }, null, 2) + '\n');
git(['config', 'user.name', 'Herdr gate rehearsal']); git(['config', 'user.email', 'offline@example.invalid']);
git(['add', '.lane.validation.json', '.promote.json']); git(['commit', '-qm', 'Declare existing project gate for scratch rehearsal']);
const lane = path.join(repo, '.git/proof-lane'); git(['worktree', 'add', '-qb', 'lane/gate-profile-proof', lane]);
fs.writeFileSync(path.join(lane, 'eng208-train-proof.txt'), 'Scratch-only proof of the existing project gate.\n');
for (const args of [['add', 'eng208-train-proof.txt'], ['commit', '-qm', 'Scratch gate-profile proof']]) {
  const r = spawnSync('git', ['-C', lane, ...args], { env, encoding: 'utf8' }); if (r.status !== 0) throw Error(r.stderr);
}
const head = git(['rev-parse', 'lane/gate-profile-proof']);
const directory = path.join(repo, '.git/promote/batches/eng208-proof'); fs.mkdirSync(directory, { recursive: true });
const receipt = path.join(directory, 'train.json');
fs.writeFileSync(receipt, JSON.stringify({ schema: 'promotion-train/v1', id: 'eng208-proof', identity: path.join(repo, '.git'),
  jobs: [{ id: 'proof', topic: 'gate-profile-proof', expectedHead: head }] }, null, 2) + '\n');
const log = path.join(directory, 'train.log'), fd = fs.openSync(log, 'w');
console.log(JSON.stringify({ source: git(['rev-parse', 'HEAD~1']), repo, receipt, log, expected_head: head, profile: gate }, null, 2));
const result = runProjectGateSync({ canonical: repo, receipt, argv: [path.join(monitor, 'lanes/lane.mjs'), 'promote-batch', receipt], cwd: repo, env, stdio: ['ignore', fd, fd] });
fs.closeSync(fd);
console.log(JSON.stringify({ exit: result.status, signal: result.signal, error: result.error?.message, main: git(['rev-parse', 'main']), receipt }));
process.exitCode = result.status ?? 1;
