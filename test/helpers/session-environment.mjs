import fs from 'node:fs';
import path from 'node:path';

const owners = new WeakSet();
export function isolateSessionEnvironment(t, scratch) {
  // canonicalProject and receipt helpers can use process.env even when the
  // fixture passes an explicit child environment. Isolate both discovery paths.
  // Restore once per test: Node runs after hooks in registration order, and a
  // test with several fixtures must never restore a deleted intermediate home.
  if (!owners.has(t)) {
    owners.add(t);
    const before = { HOME: process.env.HOME, HERDR_MONITOR_FLEET: process.env.HERDR_MONITOR_FLEET };
    t.after(() => {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
  }
  const env = { HOME: path.join(scratch, 'home'), HERDR_MONITOR_FLEET: path.join(scratch, 'fleet') };
  fs.mkdirSync(env.HOME);
  Object.assign(process.env, env);
  return env;
}
