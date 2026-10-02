import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { liveSocket } from '../probe.mjs';
import { HarnessLimit } from '../limits.mjs';

test('socket premise uses the inherited endpoint and requires an actual host socket', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-socket-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const socket = path.join(root, 'custom.sock');
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(liveSocket({ HERDR_SOCKET_PATH: socket }), socket);
  const plain = path.join(root, 'plain'); fs.writeFileSync(plain, 'not a socket');
  assert.throws(() => liveSocket({ HERDR_SOCKET_PATH: plain }), (error) => error instanceof HarnessLimit && /not a socket/.test(error.message));
  assert.throws(() => liveSocket({ HERDR_SOCKET_PATH: path.join(root, 'missing') }), (error) => error instanceof HarnessLimit && /ENOENT/.test(error.message));
});
