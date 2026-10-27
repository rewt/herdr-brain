import fs from 'node:fs';
import path from 'node:path';

const owners = new WeakMap();
// Every mutation in a test context shares one caller snapshot and restore hook.
// Return that snapshot so composed fixtures retain the original home boundary.
export function setSessionEnvironment(t, env) {
  if (!owners.has(t)) {
    const before = {};
    owners.set(t, before);
    t.after(() => {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
  }
  const before = owners.get(t);
  for (const [key, value] of Object.entries(env)) {
    if (!Object.hasOwn(before, key)) before[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return before;
}

export function isolateSessionEnvironment(t, scratch) {
  // Product discovery can use process.env despite an explicit child environment.
  const env = { HOME: path.join(scratch, 'home'), HERDR_MONITOR_FLEET: path.join(scratch, 'fleet') };
  fs.mkdirSync(env.HOME);
  setSessionEnvironment(t, env);
  return env;
}
