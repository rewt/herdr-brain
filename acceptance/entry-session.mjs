// A fresh native UI in an owned PTY, without a task prompt or authentication.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadTimeout } from './deadline.mjs';
import { registerProducer, producersStopping } from './producers.mjs';
const [root, name] = process.argv.slice(2);
const producer = registerProducer(root, 'entry-session');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'live-jobs', `${name}.json`), 'utf8'));
const child = spawn('/usr/bin/sandbox-exec', ['-f', spec.sandbox, spec.entryBinary], {
  cwd: spec.repo, env: spec.env, stdio: 'inherit',
});
producer.child(child.pid);
let killTimer;
const stop = () => {
  child.kill('SIGTERM');
  killTimer ??= setTimeout(() => child.kill('SIGKILL'), loadTimeout(1000));
};
const timer = setTimeout(stop, loadTimeout(45_000));
const stopping = setInterval(() => {
  if (producersStopping(root) || fs.existsSync(spec.stop)) stop();
}, 50);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);
child.on('error', error => console.error(error.message));
child.on('close', (code, signal) => {
  clearTimeout(timer); clearInterval(stopping); clearTimeout(killTimer);
  producer.child(child.pid, false);
  fs.writeFileSync(path.join(root, 'live-jobs', `${name}.done`), JSON.stringify({ code, signal }));
  producer.release();
});
