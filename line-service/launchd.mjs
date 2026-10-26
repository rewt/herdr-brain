#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir, writeFileAtomic } from '../lib/store.mjs';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { sourceRoot, serviceDirectory } from './line-service.mjs';

const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
export function launchPlist({ label, repo, org, to, herdr, socket, directory, interval = 30, node = process.execPath, searchPath = process.env.PATH }) {
  if (!Number.isSafeInteger(interval) || interval < 1) throw Error('interval must be positive integer seconds');
  const args = [node, path.join(sourceRoot, 'line-service/line-service.mjs'), '--once', '--repo', repo, '--org', org, '--to', to, '--herdr', herdr];
  // Only transport/executable locations. Never copy a caller's pane/SID/claims.
  const env = { PATH: `${path.dirname(node)}:${path.dirname(herdr)}:${searchPath ?? '/usr/bin:/bin'}`, HERDR_SOCKET_PATH: socket };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>\n<key>WorkingDirectory</key><string>${xml(repo)}</string>\n<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>\n<key>StartInterval</key><integer>${interval}</integer>\n<key>RunAtLoad</key><true/>\n<key>StandardOutPath</key><string>${xml(path.join(directory, 'launchd.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(directory, 'launchd.error.log'))}</string>\n</dict></plist>\n`;
}

export function main(argv = process.argv.slice(2), { command = spawnSync } = {}) {
  const { positionals, values: v } = parseArgs({ args: argv, allowPositionals: true,
    usage: 'launchd.mjs install|restart|status|stop|revert --repo CANONICAL [--org RECORD --to SUPERVISOR --herdr ABS_PATH --socket ABS_PATH --interval 30 --commit SHA]', options: {
      repo: { type: 'string' }, org: { type: 'string' }, to: { type: 'string' }, herdr: { type: 'string' }, socket: { type: 'string' },
      interval: { type: 'string' }, commit: { type: 'string', multiple: true },
    } });
  const action = positionals[0];
  if (positionals.length !== 1 || !['install', 'restart', 'status', 'stop', 'revert'].includes(action) || !v.repo) throw Error('name install|restart|status|stop|revert and --repo CANONICAL');
  const project = gitProject(v.repo), repo = project.canonical;
  if (project.checkout !== repo) throw Error('service control requires the canonical project checkout');
  const discovered = findOrgDir({ cwd: repo, env: { ...process.env, ORG_DIR: '' } });
  const org = fs.realpathSync(v.org ?? discovered);
  if (!discovered || fs.realpathSync(discovered) !== org) throw Error('record differs from canonical project record');
  const directory = serviceDirectory(org, project.identity), label = `dev.herdr.line.${path.basename(directory)}`;
  const target = `gui/${process.getuid()}/${label}`, file = path.join(directory, 'service.plist'), stopped = path.join(directory, 'STOP');
  const call = (exe, args) => {
    const r = command(exe, args, { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw Error((r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim());
    return r.stdout?.trim() ?? '';
  };
  fs.mkdirSync(directory, { recursive: true });
  const audit = value => {
    const fd = fs.openSync(path.join(directory, 'controls.jsonl'), 'a', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ at: new Date().toISOString(), action, target, ...value }) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  };
  const inspect = () => {
    const r = command('/bin/launchctl', ['print', target], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (!r.error && r.status === 0) return { loaded: true, native: r.stdout?.trim() };
    if (!r.error && /could not find service/i.test(r.stderr ?? '')) return { loaded: false, native: r.stderr.trim() };
    throw Error((r.stderr || r.stdout || r.error?.message || `launchctl print exit ${r.status}`).trim());
  };
  if (action === 'status') return { target, directory, stopped: fs.existsSync(stopped), ...inspect() };
  if (action === 'install' || action === 'restart') {
    if (process.platform !== 'darwin') throw Error('launchd control requires macOS');
    if (process.version !== 'v20.19.4') throw Error('use the project-pinned Node 20.19.4');
    if (gitProject(sourceRoot).checkout !== gitProject(sourceRoot).canonical) throw Error('launch from canonical development source');
    if (fs.existsSync(path.join(repo, '.lane/supervisor/STOP')) || fs.existsSync(path.join(repo, '.lane/supervisor/HOLD'))) throw Error('project STOP/HOLD prevents launch');
  }
  if (action === 'restart') {
    const receipt = readInstallation();
    if (!receipt || receipt.repo !== repo || receipt.org !== org || receipt.target !== target || receipt.file !== file || fs.realpathSync(receipt.source) !== fs.realpathSync(sourceRoot)) throw Error('saved installation binding differs; retain and inspect it');
    if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw Error('saved plist is redirected');
    if (!fs.existsSync(stopped)) throw Error('restart requires this service own STOP; use status/stop first');
    if (inspect().loaded) throw Error('service remains loaded; retain STOP and finish its supported stop before restart');
    const archive = path.join(directory, 'stops', `${randomUUID()}.STOP`);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    audit({ phase: 'starting', stop_archive: archive, installation: path.join(directory, 'installation.json') });
    fs.renameSync(stopped, archive);
    try { call('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, file]); }
    catch (e) {
      writeFileAtomic(stopped, `Restart refused or uncertain: ${e.message}\n`, 0o600);
      audit({ phase: 'uncertain-or-refused', error: e.message, stop_archive: archive }); throw e;
    }
    audit({ phase: 'restarted', stop_archive: archive });
    return { target, restarted: true, directory, stop_archive: archive, installation_preserved: true };
  }
  if (action === 'install') {
    if (!v.to || !v.herdr || !path.isAbsolute(v.herdr) || !v.socket || !path.isAbsolute(v.socket)) throw Error('install needs --to, absolute --herdr and actual --socket');
    if (fs.existsSync(file)) throw Error('service already configured; inspect status/stop and its saved installation before replacement');
    const plist = launchPlist({ label, repo, org, to: v.to, herdr: v.herdr, socket: v.socket, directory, interval: Number(v.interval ?? 30) });
    writeFileAtomic(file, plist, 0o600);
    const receipt = { at: new Date().toISOString(), target, repo, org, source: sourceRoot, node: process.execPath, file, phase: 'starting' };
    const receiptFile = path.join(directory, 'installation.json');
    writeFileAtomic(receiptFile, JSON.stringify(receipt) + '\n', 0o600);
    try { call('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, file]); receipt.phase = 'installed'; }
    catch (e) { receipt.phase = 'uncertain-or-refused'; receipt.error = e.message; throw e; }
    finally { writeFileAtomic(receiptFile, JSON.stringify(receipt) + '\n', 0o600); }
    return receipt;
  }
  // A durable local stop protects subsequent invocations even if bootout refuses.
  if (!fs.existsSync(stopped)) fs.writeFileSync(stopped, `Stopped ${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o600 });
  audit({ phase: 'stopping' });
  try { if (inspect().loaded) call('/bin/launchctl', ['bootout', target]); audit({ phase: 'stopped' }); }
  catch (e) { audit({ phase: 'uncertain-or-refused', error: e.message }); throw e; }
  if (action === 'revert') {
    const commits = v.commit;
    if (!commits?.length || commits.some(c => !/^[a-f0-9]{40}$/.test(c))) throw Error('revert requires the exact hotfix --commit SHA list, newest first');
    const source = gitProject(sourceRoot);
    if (project.identity !== source.identity) throw Error('only the source project owner reverts shared source; this project remains stopped');
    const git = args => {
      const r = command('git', ['-C', source.canonical, ...args], { encoding: 'utf8' });
      if (r.error || r.status !== 0) throw Error(r.stderr || r.error?.message || 'revert Git guard refused');
      return r.stdout.trim();
    };
    if (git(['status', '--porcelain=v1'])) throw Error('source checkout must be clean for a recoverable revert');
    for (const commit of commits) {
      git(['merge-base', '--is-ancestor', commit, 'HEAD']);
      const changed = git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).split('\n');
      if (!changed.length || changed.some(f => !f.startsWith('line-service/') && !['lib/product-files.mjs', 'lib/store.mjs', 'test/line-service.test.mjs', 'test/line-service-review.test.mjs', 'test/line-service-queue.test.mjs', 'test/line-service-backlog.test.mjs', 'settle/settle.mjs', 'supervisor/supervisor.mjs', 'supervisor/PROTOCOL.md', 'supervisor/prompt-supervisor.mjs', 'supervisor/notice-lock.mjs', 'supervisor/line-notice-aggregate.mjs', 'lanes/lane.mjs', 'bin/org.mjs', 'dispatch/dispatch.mjs', 'dispatch/unlanded-cap.mjs', 'AGENTS.md'].includes(f))) throw Error('revert commit contains files outside this hotfix; inspect exact source scope');
    }
    return { target, stopped: true, revert: git(['revert', '--no-edit', ...commits]) };
  }
  return { target, stopped: true, directory };
  function readInstallation() {
    try { return JSON.parse(fs.readFileSync(path.join(directory, 'installation.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
}
if (isMain(import.meta.url)) try { process.stdout.write(JSON.stringify(main()) + '\n'); }
catch (e) { process.stderr.write(`line-service: ${e.message}\n`); process.exitCode = 1; }
