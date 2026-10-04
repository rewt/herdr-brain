// Fresh-account rehearsal runs as that logged-in user, never by replacing HOME.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function freshAccount({ platform = process.platform, user = os.userInfo(), env = process.env, exists = fs.existsSync } = {}) {
  if (platform !== 'darwin') throw new Error('--fresh-account currently requires macOS');
  if (user.uid < 501 || !user.homedir.startsWith('/Users/') || env.HOME !== user.homedir) throw new Error('log in to the fresh macOS account and run there; changing HOME or running as root is not an account rehearsal');
  for (const relative of ['.herdr-monitor', '.local/share/herdr-monitor']) {
    if (exists(path.join(user.homedir, relative))) throw new Error(`fresh account already has Monitor state at ${relative}; use a new account`);
  }
  return { home: user.homedir, username: user.username, uid: user.uid, platform };
}
