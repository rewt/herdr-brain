// Opt-in, model-free macOS probe of Claude Code 2.1.292's bundled runtime.
// Its private module names are discovered from the binary, never hardcoded.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeSandboxLaunch } from './native-sandbox.mjs';

if (process.env.MONITOR_CLAUDE_SOCKET_PROBE) {
  // BUN_OPTIONS runs this before Claude's CLI entry point. Exit here on every
  // path: no session, authentication, telemetry or model request is started.
  try {
    const input = JSON.parse(fs.readFileSync(process.env.MONITOR_CLAUDE_SOCKET_PROBE, 'utf8'));
    const { Nir: wrap } = await import(input.runtimeModule);
    const { rTe: shellTemp, kSr: limit } = await import(input.tempModule);
    const tmpdir = shellTemp();
    const settings = JSON.parse(fs.readFileSync(input.settings, 'utf8'));
    const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const checks = `
const net = require('node:net'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const result = {tmpdir: process.env.TMPDIR, checks: []};
async function roundtrip(directory, name) {
  fs.mkdirSync(directory, {recursive:true});
  const socket = path.join(directory, 'eng228-' + process.pid + '.sock');
  const server = net.createServer(client => client.end('ok'));
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(socket,resolve)});
  const data = await new Promise((resolve,reject) => {let data='';const client=net.connect(socket);client.on('error',reject);client.on('data',b=>data+=b);client.on('end',()=>resolve(data))});
  assert.equal(data,'ok');
  await new Promise(resolve => server.close(resolve));
  result.checks.push(name + ': bind/connect OK');
}
async function denied(socket, bind, name) {
  const error = await new Promise(resolve => {
    const handle = bind ? net.createServer() : net.connect(socket);
    handle.once('error', resolve);
    if(bind) handle.listen(socket,()=>{handle.close();resolve({code:'ALLOWED'})});
    else handle.once('connect',()=>{handle.destroy();resolve({code:'ALLOWED'})});
  });
  assert.equal(error.code,'EPERM',name + ': ' + error.code);
  result.checks.push(name + ': EPERM');
}
(async()=>{
  await roundtrip(process.env.TMPDIR,'shell TMPDIR');
  await roundtrip(${JSON.stringify(input.runTemp)},'run temp');
  for (const [name, directory] of ${JSON.stringify(input.denied)}) await denied(path.join(directory,'bind-socket'),true,name);
  for (const [name, socket] of ${JSON.stringify(input.deniedConnections)}) await denied(socket,false,name);
  await denied(${JSON.stringify(input.herdrSocket)},false,'Herdr control connect');
  await denied(${JSON.stringify(input.herdrAlias)},false,'Herdr symlink connect');
  const tcp = net.createServer();
  const tcpError = await new Promise(resolve => {tcp.once('error',resolve);tcp.listen(0,'127.0.0.1',()=>{tcp.close();resolve({code:'ALLOWED'})})});
  assert.equal(tcpError.code,'EPERM');result.checks.push('localhost TCP bind: EPERM');
  const pty = require('node:child_process').spawnSync('/usr/bin/python3',['-c','import os; a,b=os.openpty(); os.close(a); os.close(b)'],{encoding:'utf8'});
  assert.notEqual(pty.status,0);assert.match(pty.stderr,/Operation not permitted/);result.checks.push('PTY with default settings: EPERM');
  console.log(JSON.stringify(result));
})().catch(e=>{console.error(e);process.exitCode=1});`;
    const command = `export TMPDIR=${shellQuote(tmpdir)}; ${shellQuote(input.node)} -e ${shellQuote(checks)}`;
    const wrapped = wrap({ command, needsNetworkRestriction: true,
      ...settings.sandbox.network, allowPty: false,
      writeConfig: { allowOnly: [input.workspace, ...settings.sandbox.filesystem.allowWrite, tmpdir], denyWithinAllow: settings.sandbox.filesystem.denyWrite } });
    const result = spawnSync('/bin/sh', ['-c', wrapped], { cwd: input.workspace, encoding: 'utf8', timeout: 15000 });
    console.log(JSON.stringify({ version: input.version, limit, runTemp: input.runTemp, socketGrants: settings.sandbox.network.allowUnixSockets }));
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  } catch (error) { console.error(error); process.exit(1); }
} else {
  if (process.platform !== 'darwin') throw new Error('this scoped native socket probe requires macOS');
  const binary = path.resolve(process.argv[2] ?? '');
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (version.status !== 0 || !version.stdout.startsWith('2.1.292 ')) throw new Error('supply the native Claude Code 2.1.292 binary');
  const source = fs.readFileSync(binary).toString('utf8');
  const moduleFor = symbol => {
    const match = source.match(new RegExp(`import\\{[^{}]*\\b${symbol}\\b[^{}]*\\}from"(/\\$bunfs/root/[^"\\n]+)"`));
    if (!match) throw new Error(`cannot find the bundled ${symbol} module`);
    return match[1];
  };
  const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'c228-'));
  const servers = [];
  let launch;
  try {
    const own = { workspace: path.join(root, 'own'), org: path.join(root, 'record'), tempRoot: path.join(root, 'run-temp'), worktrees: path.join(root, 'lanes') };
    const peer = { checkout: path.join(root, 'peer'), record: path.join(root, 'peer-record'), temp: path.join(root, 'peer-temp'), worktrees: path.join(root, 'peer-lanes') };
    const sibling = path.join(own.tempRoot, 'r-sibling'), config = path.join(root, 'config');
    for (const directory of [...Object.values(own), ...Object.values(peer), sibling, config]) fs.mkdirSync(directory, { recursive: true });
    launch = nativeSandboxLaunch({ kind: 'claude', binary, args: ['--setting-sources', ''], context: { ...own, canonical: own.workspace, projects: [peer] }, env: { ...process.env, CLAUDE_CONFIG_DIR: config } });
    const herdrSocket = path.join(os.homedir(), '.config/herdr/herdr.sock');
    if (!fs.statSync(herdrSocket).isSocket()) throw new Error('Herdr control socket is unavailable for the denied-connect probe');
    const herdrAlias = path.join(launch.env.TMPDIR, 'herdr.sock'); fs.symlinkSync(herdrSocket, herdrAlias);
    const deniedConnections = [];
    for (const [name, directory] of [['sibling run connect', sibling], ['peer temp connect', peer.temp]]) {
      const socket = path.join(directory, 'socket'), server = net.createServer(client => client.destroy());
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
      servers.push(server); deniedConnections.push([name, socket]);
    }
    const input = path.join(root, 'probe.json');
    fs.writeFileSync(input, JSON.stringify({ runtimeModule: moduleFor('Nir'), tempModule: moduleFor('rTe'), node: process.execPath,
      version: version.stdout.trim(), settings: launch.args[launch.args.indexOf('--settings') + 1], runTemp: launch.env.TMPDIR,
      workspace: own.workspace, herdrSocket, herdrAlias, deniedConnections,
      denied: [['sibling run bind', sibling], ['sibling prefix bind', launch.env.TMPDIR + '-other'], ...Object.entries(peer).map(([name, directory]) => [`peer ${name} bind`, directory])] }));
    fs.mkdirSync(launch.env.TMPDIR + '-other');
    const result = spawnSync(binary, ['--version'], { env: { ...launch.env, MONITOR_CLAUDE_SOCKET_PROBE: input, BUN_OPTIONS: `--preload ${fileURLToPath(import.meta.url)}` }, encoding: 'utf8', timeout: 20000 });
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 1;
  } finally {
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    launch?.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}
