// Opt-in model-free probe. Bun preload exits before Claude's CLI entry point.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function nativeReadProbe({ binary, launch, context, entryBin, socket, root }) {
  const version = spawnSync(binary, ['--version'], { encoding:'utf8', timeout:5000 });
  if (version.status !== 0 || !version.stdout.startsWith('2.1.295 ')) throw new Error('read exclusion probe supports the installed Claude Code 2.1.295 build');
  const source = fs.readFileSync(binary, 'utf8');
  const moduleFor = symbol => {
    const match = source.match(new RegExp(`import\\{[^{}]*\\b${symbol}\\b[^{}]*\\}from"(/\\$bunfs/root/[^"\\n]+)"`));
    if (!match) throw new Error(`cannot find bundled ${symbol} module`);
    return match[1];
  };
  const input = path.join(root, 'native-read-probe.json');
  fs.writeFileSync(input, JSON.stringify({ flags:moduleFor('qPo'), sandbox:moduleFor('Ve'), decision:moduleFor('by'),
    runtime:moduleFor('Wmr'), settings:launch.args[launch.args.indexOf('--settings')+1], workspace:context.workspace,
    wrapper:path.join(entryBin,'herdr-read'), node:process.execPath, socket, version:version.stdout.trim() }));
  return spawnSync(binary, ['--version'], { cwd:context.workspace, env:{...launch.env, HOME:root,
    MONITOR_HERDR_READ_PROBE:input, BUN_OPTIONS:`--preload ${fileURLToPath(import.meta.url)}`}, encoding:'utf8', timeout:20000 });
}

if (process.env.MONITOR_HERDR_READ_PROBE) {
  try {
    const assert = (await import('node:assert/strict')).default;
    const input = JSON.parse(fs.readFileSync(process.env.MONITOR_HERDR_READ_PROBE,'utf8'));
    const flags = await import(input.flags), {Ve} = await import(input.sandbox);
    const {by: shouldSandbox} = await import(input.decision), {Wmr: wrap} = await import(input.runtime);
    // The same flag-settings loader used by --settings, including schema parsing
    // and native scope merging. No monkeypatches to the loader or decision.
    flags.qPo(input.settings);
    const settings = JSON.parse(fs.readFileSync(input.settings));
    assert.deepEqual(Ve.getExcludedCommands(),settings.sandbox.excludedCommands);
    assert.equal(Ve.isSandboxingEnabled(),true);
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    function run(command, expectedSandbox) {
      const sandboxed = shouldSandbox({command});
      assert.equal(sandboxed,expectedSandbox,command);
      const selected = sandboxed ? wrap({command,needsNetworkRestriction:true,...settings.sandbox.network,
        writeConfig:{allowOnly:[input.workspace,...settings.sandbox.filesystem.allowWrite],denyWithinAllow:settings.sandbox.filesystem.denyWrite}}) : command;
      return spawnSync('/bin/sh',['-c',selected],{cwd:input.workspace,encoding:'utf8',timeout:5000});
    }
    for(const argv of [['pane','read','w1:p1','--lines','10'],['pane','list'],['tab','list','--workspace','w1'],['pane','wait-output','w1:p1','--match','ready','--timeout','100']]) {
      const result=run(input.wrapper+' '+argv.map(quote).join(' '),false);
      assert.equal(result.status,0,result.stdout+result.stderr);
      assert.deepEqual(JSON.parse(result.stdout),argv);
    }
    for(const argv of [['pane','send-keys','w1:p1','x'],['agent','prompt','w1:p1','x'],['pane','read','w1:p1;id']]) {
      const result=run(input.wrapper+' '+argv.map(quote).join(' '),false);
      assert.equal(result.status,1,result.stdout+result.stderr);
      assert.match(result.stderr,/herdr-read:/);assert.equal(result.stdout,'');
    }
    assert.equal(shouldSandbox({command:`${quote(input.wrapper)} pane list; ${quote(input.node)} -e 'console.log(1)'`}),true);
    for(const operation of ['send-keys','send-text','run','close','focus'])
      assert.equal(shouldSandbox({command:`herdr pane ${operation} w1:p1 x`}),true);
    assert.equal(shouldSandbox({command:'herdr agent prompt w1:p1 x'}),true);
    const script=`const net=require('node:net'),assert=require('node:assert/strict');const c=net.connect(${JSON.stringify(input.socket)});c.once('error',e=>{assert.equal(e.code,'EPERM');console.log('direct socket EPERM')});c.once('connect',()=>{c.destroy();process.exit(1)});`;
    const denied=run([input.node,'-e',script].map(quote).join(' '),true);
    assert.equal(denied.status,0,denied.stdout+denied.stderr);assert.match(denied.stdout,/direct socket EPERM/);
    // The excluded executable and its interpreter/code cannot be rewritten via
    // the sandbox, even when they lie inside an otherwise writable checkout.
    for(const target of settings.sandbox.filesystem.denyWrite) {
      const directory=fs.statSync(target).isDirectory();
      const edit=`const fs=require('node:fs'),assert=require('node:assert/strict');assert.throws(()=>fs.writeFileSync(${JSON.stringify(directory ? path.join(target,'read-chat-write-probe') : target)},${directory ? "'denied'" : `fs.readFileSync(${JSON.stringify(target)})`}),e=>['EPERM','EACCES'].includes(e.code));`;
      const protectedEdit=run([input.node,'-e',edit].map(quote).join(' '),true);
      assert.equal(protectedEdit.status,0,protectedEdit.stdout+protectedEdit.stderr);
    }
    const head=spawnSync('git',['rev-parse','HEAD'],{cwd:input.workspace,encoding:'utf8'}).stdout.trim();
    const commit=run('git -c core.hooksPath=/dev/null commit --allow-empty -m read-chat-commit-probe',true);
    assert.notEqual(commit.status,0,commit.stdout+commit.stderr);
    assert.match(commit.stderr,/index\.lock.*(?:Operation not permitted|Permission denied)/);
    assert.equal(spawnSync('git',['rev-parse','HEAD'],{cwd:input.workspace,encoding:'utf8'}).stdout.trim(),head);
    console.log(input.version+': read wrappers reached fake socket; direct socket EPERM; mutations confined; config and Git writes denied; commit denied');
    process.exit(0);
  } catch(error) { console.error(error); process.exit(1); }
}
