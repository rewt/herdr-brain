#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir, writeFileAtomic,loadEvents } from '../lib/store.mjs';
import { serviceCutoff,installedContext } from './cutoff.mjs';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { sourceRoot, serviceDirectory } from './line-service.mjs';
import {serviceSource} from './runtime.mjs';
import {migrateRuntime} from './migrate-runtime.mjs';
import {nativeSender} from '../messages/operator-inbox.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {acquireLock} from '../lanes/promotion-lock.mjs';

import {launchPlist} from './plist.mjs';
export {launchPlist} from './plist.mjs';

export function main(argv = process.argv.slice(2), { command = spawnSync,call:nativeCall,home,cwd=process.cwd(),env=process.env } = {}) {
  const { positionals, values: v } = parseArgs({ args: argv, allowPositionals: true,
    usage: 'launchd.mjs install|migrate|restart|status|stop|revert --repo CANONICAL [--org RECORD --id MIGRATION --dry-run --expected-plan SHA256 --to SUPERVISOR --herdr ABS_PATH --socket ABS_PATH --interval 30 --commit SHA]', options: {
      repo: { type: 'string' }, org: { type: 'string' }, to: { type: 'string' }, herdr: { type: 'string' }, socket: { type: 'string' },
      interval: { type: 'string' }, commit: { type: 'string', multiple: true },
      id:{type:'string'},'dry-run':{type:'boolean'},
      'expected-plan':{type:'string'},
    } });
  const action = positionals[0];
  if (positionals.length !== 1 || !['install','migrate', 'restart', 'status', 'stop', 'revert'].includes(action) || !v.repo) throw Error('name install|migrate|restart|status|stop|revert and --repo CANONICAL');
  if(action!=='migrate'&&(v.id||v['dry-run']||v['expected-plan']))throw Error('--id/--dry-run/--expected-plan apply only to migrate');
  if(action==='migrate'){
    if(v.to||v.herdr||v.socket||v.interval||v.commit)throw Error('migration preserves saved bindings; no install/revert options');
    return migrateRuntime({repo:v.repo,org:v.org??findOrgDir({cwd:v.repo,env:{...env,ORG_DIR:''}}),id:v.id,dryRun:v['dry-run'],expectedPlan:v['expected-plan'],command,call:nativeCall,home,cwd,env});
  }
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
  fs.mkdirSync(directory, { recursive: true });
  const releaseControl=noticeLock(path.join(directory,'control.lock'),{recover:false});
  let releasePass,releasePromotion;
  try{
    if(action==='install'||action==='restart'){
      releasePass=noticeLock(path.join(directory,'pass.lock'),{recover:false});
      releasePromotion=acquireLock(path.join(project.identity,'lane-promote.lock'));
    }
    return control();
  }finally{releasePromotion?.();releasePass?.();releaseControl();}
  function control(){
  const bind=()=>{
    const b=nativeSender(org,{cwd,env,...(nativeCall?{call:nativeCall}:{})});
    if(b.project.checkout!==repo||b.project.identity!==project.identity)throw Error('service launch requires actual own canonical native supervisor');
    return {name:b.native.name,pane:b.native.pane_id,workspace:b.native.workspace_id,terminal:b.native.terminal_id,session:b.native.agent_session.value};
  };
  let owner;
  if (action === 'install' || action === 'restart') {
    if (process.platform !== 'darwin') throw Error('launchd control requires macOS');
    if (process.version !== 'v20.19.4') throw Error('use the project-pinned Node 20.19.4');
    owner=bind();serviceSource(repo,{home});
    if (fs.existsSync(path.join(repo, '.lane/supervisor/STOP')) || fs.existsSync(path.join(repo, '.lane/supervisor/HOLD'))) throw Error('project STOP/HOLD prevents launch');
    const record=loadEvents(org);if(record.tornTail)throw Error('incomplete record prevents launch');
    serviceCutoff(record.events,{repo,org,identity:project.identity});
  }
  if (action === 'restart') {
    const receipt = installedContext(repo,org).installation;
    if (!receipt || receipt.repo !== repo || receipt.org !== org || receipt.target !== target || receipt.file !== file || fs.realpathSync(receipt.source) !== fs.realpathSync(sourceRoot)) throw Error('saved installation binding differs; retain and inspect it');
    if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw Error('saved plist is redirected');
    if (!fs.existsSync(stopped)) throw Error('restart requires this service own STOP; use status/stop first');
    if (inspect().loaded) throw Error('service remains loaded; retain STOP and finish its supported stop before restart');
    if(JSON.stringify(bind())!==JSON.stringify(owner))throw Error('native service owner changed before restart');
    serviceSource(repo,{home});
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
      if (!changed.length || changed.some(f => !f.startsWith('line-service/') && !['lib/product-files.mjs', 'lib/store.mjs', 'test/line-service.test.mjs', 'test/line-service-review.test.mjs', 'test/line-service-queue.test.mjs', 'test/line-service-backlog.test.mjs', 'test/line-service-producer.test.mjs', 'settle/settle.mjs', 'supervisor/supervisor.mjs', 'supervisor/PROTOCOL.md', 'supervisor/prompt-supervisor.mjs', 'supervisor/notice-lock.mjs', 'supervisor/line-notice-aggregate.mjs', 'lanes/lane.mjs', 'bin/org.mjs', 'dispatch/dispatch.mjs', 'dispatch/unlanded-cap.mjs', 'AGENTS.md'].includes(f))) throw Error('revert commit contains files outside this hotfix; inspect exact source scope');
    }
    return { target, stopped: true, revert: git(['revert', '--no-edit', ...commits]) };
  }
  return { target, stopped: true, directory };
  }

}
if (isMain(import.meta.url)) try { process.stdout.write(JSON.stringify(main()) + '\n'); }
catch (e) { process.stderr.write(`line-service: ${e.message}\n`); process.exitCode = 1; }
