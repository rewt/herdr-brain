// Opt-in model-free probe. Bun preload exits before Claude's CLI entry point.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function nativeScopedProbe({ binary, launch, context, entryBin, socket, root }) {
  const version = spawnSync(binary, ['--version'], { encoding:'utf8', timeout:5000 });
  if (version.status !== 0 || !/^2\.1\.(295|296) /u.test(version.stdout)) throw new Error('scoped exclusion probe supports the installed Claude Code 2.1.295/296 builds');
  const source = fs.readFileSync(binary, 'utf8');
  const moduleFor = symbol => {
    const matches = [...source.matchAll(/import\{([^{}]+)\}from"(\/\$bunfs\/root\/[^"\n]+)"/gu)]
      .filter(match => match[1].split(',').includes(symbol));
    const files = [...new Set(matches.map(match => match[2]))];
    if (files.length !== 1) throw new Error(`cannot uniquely find bundled ${symbol} module`);
    return files[0];
  };
  const symbols = version.stdout.startsWith('2.1.296 ') ? { flags:'tFs', sandbox:'qe', decision:'Cy', runtime:'$mr' } : { flags:'qPo', sandbox:'Ve', decision:'by', runtime:'Wmr' };
  const input = path.join(root, 'native-scoped-probe.json');
  fs.writeFileSync(input, JSON.stringify({ symbols, flags:moduleFor(symbols.flags), sandbox:moduleFor(symbols.sandbox), decision:moduleFor(symbols.decision),
    runtime:moduleFor(symbols.runtime), settings:launch.args[launch.args.indexOf('--settings')+1], workspace:context.workspace,
    wrapper:path.join(entryBin,'herdr-scoped'), product:fs.realpathSync(JSON.parse(fs.readFileSync(path.join(entryBin,'.monitor-entry.json'))).product),
    node:process.execPath, socket, version:version.stdout.trim() }));
  return spawnSync(binary, ['--version'], { cwd:context.workspace, env:{...launch.env, HOME:root,
    MONITOR_HERDR_SCOPED_PROBE:input, BUN_OPTIONS:`--preload ${fileURLToPath(import.meta.url)}`}, encoding:'utf8', timeout:20000 });
}

if (process.env.MONITOR_HERDR_SCOPED_PROBE) {
  try {
    const assert = (await import('node:assert/strict')).default;
    const input = JSON.parse(fs.readFileSync(process.env.MONITOR_HERDR_SCOPED_PROBE,'utf8'));
    const flags = await import(input.flags), sandbox = await import(input.sandbox);
    const Ve = sandbox[input.symbols.sandbox], shouldSandbox = (await import(input.decision))[input.symbols.decision];
    const wrap = (await import(input.runtime))[input.symbols.runtime];
    // The same flag-settings loader used by --settings, including schema parsing
    // and native scope merging. No monkeypatches to the loader or decision.
    flags[input.symbols.flags](input.settings);
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
    for(const argv of [['pane','read','agents:p1','--lines','10'],['pane','list'],['tab','list','--workspace','w1'],['pane','wait-output','agents:p1','--match','ready','--timeout','100']]) {
      const result=run(input.wrapper+' '+argv.map(quote).join(' '),false);
      assert.equal(result.status,0,result.stdout+result.stderr);

    }
    for(const argv of [['pane','send-keys','chats:p2','ctrl+c'],['pane','send-text','chats:p2','x'],['pane','run','chats:p2','true'],['pane','close','chats:p1'],['pane','close','chats:p3'],['pane','stop','agents:p1'],['preset','start','wallet','--pane','chats:p3'],['preset','start','unknown','--pane','chats:p2']]) {
      const result=run(input.wrapper+' '+argv.map(quote).join(' '),false);
      assert.equal(result.status,1,result.stdout+result.stderr);
      assert.match(result.stderr,/herdr-scoped:/);assert.equal(result.stdout,'');
    }
    for (const argv of [['pane','rename','chats:p2','native-probe'],['preset','start','wallet','--pane','chats:p2']]) {
      const result=run(input.wrapper+' '+argv.map(quote).join(' '),false);
      assert.equal(result.status,0,result.stdout+result.stderr);
    }
    assert.equal(shouldSandbox({command:`${quote(input.wrapper)} pane list`}),true);
    assert.equal(shouldSandbox({command:`${quote(input.wrapper)} pane list; ${quote(input.node)} -e 'console.log(1)'`}),true);
    for(const operation of ['send-keys','send-text','run','close','focus'])
      assert.equal(shouldSandbox({command:`herdr pane ${operation} w1:p1 x`}),true);
    assert.equal(shouldSandbox({command:'herdr agent prompt w1:p1 x'}),true);
    const script=`const net=require('node:net'),assert=require('node:assert/strict');const c=net.connect(${JSON.stringify(input.socket)});c.once('error',e=>{assert.equal(e.code,'EPERM');console.log('direct socket EPERM')});c.once('connect',()=>{c.destroy();process.exit(1)});`;
    const denied=run([input.node,'-e',script].map(quote).join(' '),true);
    assert.equal(denied.status,0,denied.stdout+denied.stderr);assert.match(denied.stdout,/direct socket EPERM/);
    // Protect the entire installed product, including the next launch's code.
    for(const target of [...settings.sandbox.filesystem.denyWrite,
      ...fs.readdirSync(path.join(path.dirname(input.wrapper),'.herdr-scoped')).map(file=>path.join(path.dirname(input.wrapper),'.herdr-scoped',file)),
      ...['discovery/native-sandbox.mjs','discovery/chat-herdr.mjs','discovery/adapters/claude.mjs'].map(file=>path.join(input.product,file))]) {
      const directory=fs.statSync(target).isDirectory();
      const edit=`const fs=require('node:fs'),assert=require('node:assert/strict');assert.throws(()=>fs.writeFileSync(${JSON.stringify(directory ? path.join(target,'scoped-chat-write-probe') : target)},${directory ? "'denied'" : `fs.readFileSync(${JSON.stringify(target)})`}),e=>['EPERM','EACCES'].includes(e.code));`;
      const protectedEdit=run([input.node,'-e',edit].map(quote).join(' '),true);
      assert.equal(protectedEdit.status,0,protectedEdit.stdout+protectedEdit.stderr);
    }
    const head=spawnSync('git',['rev-parse','HEAD'],{cwd:input.workspace,encoding:'utf8'}).stdout.trim();
    const commit=run('git -c core.hooksPath=/dev/null commit --allow-empty -m scoped-chat-commit-probe',true);
    assert.notEqual(commit.status,0,commit.stdout+commit.stderr);
    assert.match(commit.stderr,/index\.lock.*(?:Operation not permitted|Permission denied)/);
    assert.equal(spawnSync('git',['rev-parse','HEAD'],{cwd:input.workspace,encoding:'utf8'}).stdout.trim(),head);
    console.log(input.version+': scoped wrapper reached fake socket; own and foreign mutations refused; direct socket EPERM; binding writes denied; product launcher, config and Git writes denied; commit denied');
    process.exit(0);
  } catch(error) { console.error(error); process.exit(1); }
}
