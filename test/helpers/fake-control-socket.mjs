import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// A separate process can answer synchronous launcher probes while the test's
// event loop is blocked. It never speaks Herdr's protocol or touches live panes.
export function fakeControlSocket(t, root, name = 'herdr.sock') {
  const socket = path.join(root, name);
  const child = spawn(process.execPath, ['-e', `
const net = require('node:net');
const server = net.createServer(client => { client.on('error', () => {}); client.destroy(); });
server.listen(process.argv[1]);
`, socket], { stdio: 'ignore' });
  t.after(() => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve); child.kill('SIGTERM');
  }));
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(socket) && Date.now() < deadline)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  if (!fs.existsSync(socket)) throw new Error('fake control socket did not start');
  return socket;
}
