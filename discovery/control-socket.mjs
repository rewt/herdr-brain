// Resolve and probe only the coordinating launch's native Herdr capability.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const coordinatingRole = role => role === 'supervisor' || role === 'chat';

export const socketProbeArguments = socket => ['--input-type=module', '-e', `
import net from 'node:net';
const client = net.connect(process.argv[1]);
client.setTimeout(2000, () => { console.error('connection timed out'); client.destroy(); process.exitCode = 1; });
client.once('error', error => { console.error(error.code + ': ' + error.message); process.exitCode = 1; });
client.once('connect', () => client.destroy());
`, socket];

export function herdrControlSocket(env = process.env) {
  const requested = env.HERDR_SOCKET_PATH || path.join(env.HOME || os.homedir(), '.config/herdr/herdr.sock');
  try {
    const socket = fs.realpathSync(requested);
    if ([requested, socket].some(file => path.basename(file) === 'herdr-client.sock'))
      throw new Error('herdr-client.sock is not the control socket');
    const entry = fs.statSync(socket);
    if (!entry.isSocket()) throw new Error('not a Unix socket');
    if (entry.uid !== process.getuid?.()) throw new Error('socket is not owned by the current user');
    // The adapters are synchronous. A bounded child probe avoids blocking the
    // launcher's event loop on an asynchronous connection and sends no request.
    const probe = spawnSync(process.execPath, socketProbeArguments(socket), { env, encoding: 'utf8', timeout: 3000 });
    if (probe.error || probe.status !== 0) throw new Error((probe.stderr || probe.error?.message || `probe exited ${probe.status}`).trim());
    return socket;
  } catch (error) {
    throw new Error(`Herdr control socket ${requested} is unavailable: ${error.message}`);
  }
}
