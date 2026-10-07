// The loop as an always-on service: a macOS LaunchAgent that runs
// `brain watch`, restarts it if it dies, and starts it at login. No model calls.
// The console shows its health from the watcher's heartbeat and starts or
// stops it through these functions.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, loadSeen } from './queue.mjs';

export const LABEL = 'com.rewt.herdr-brain';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const BRAIN = fileURLToPath(new URL('../bin/brain.mjs', import.meta.url));
const LOG = path.join(HOME, 'watch.log');
export const PIDFILE = path.join(HOME, 'watch.pid');
const domain = () => `gui/${process.getuid()}`;

// What the watcher needs on PATH: node, herdr, claude, and ~/bin for `ai`.
function searchPath() {
  const home = os.homedir();
  return [
    path.dirname(process.execPath), path.join(home, '.local', 'bin'), path.join(home, 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ].filter((p, i, all) => all.indexOf(p) === i).join(':');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plist() {
  const args = [process.execPath, BRAIN, 'watch'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${esc(path.dirname(path.dirname(BRAIN)))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(searchPath())}</string>
    <key>HOME</key><string>${esc(os.homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${esc(LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
</dict>
</plist>
`;
}

export function loaded() {
  return spawnSync('launchctl', ['print', `${domain()}/${LABEL}`], { stdio: 'ignore' }).status === 0;
}

export function install() {
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  const want = plist();
  const have = fs.existsSync(PLIST) ? fs.readFileSync(PLIST, 'utf8') : null;
  if (have !== want) fs.writeFileSync(PLIST, want);
  return { plist: PLIST, changed: have !== want };
}

export function start() {
  const { changed } = install();
  if (loaded() && changed) execFileSync('launchctl', ['bootout', `${domain()}/${LABEL}`], { stdio: 'ignore' });
  if (!loaded()) execFileSync('launchctl', ['bootstrap', domain(), PLIST], { stdio: 'ignore' });
  else execFileSync('launchctl', ['kickstart', `${domain()}/${LABEL}`], { stdio: 'ignore' });
  return status();
}

export function stop() {
  if (loaded()) execFileSync('launchctl', ['bootout', `${domain()}/${LABEL}`], { stdio: 'ignore' });
  return status();
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// { service, running, pid, tick, age, every, log }: `service` is whether the
// LaunchAgent is loaded; `running` whether a watcher (from anywhere) is alive.
export function status() {
  const seen = loadSeen();
  let pid = null;
  try { pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim()) || null; } catch { pid = null; }
  const tick = seen.tick ?? null;
  return {
    service: loaded(),
    installed: fs.existsSync(PLIST),
    running: alive(pid),
    pid: alive(pid) ? pid : null,
    tick,
    age: tick ? Math.round((Date.now() - Date.parse(tick)) / 1000) : null,
    every: seen.every ?? null,
    digest: seen.digest ?? null,
    log: LOG,
  };
}

// One watcher at a time: two would capture every stop twice and pay twice.
export function claim() {
  fs.mkdirSync(HOME, { recursive: true });
  try {
    const other = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
    if (other && other !== process.pid && alive(other)) return other;
  } catch { /* no pidfile */ }
  fs.writeFileSync(PIDFILE, String(process.pid));
  process.on('exit', () => {
    try { if (fs.readFileSync(PIDFILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PIDFILE); } catch { /* gone */ }
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
  return null;
}
