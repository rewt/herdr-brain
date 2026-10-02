import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Shared by the bounded runner and direct test-file execution. Fixtures may
// put their own fake before this refusal adapter, but never inherit live IDs.
export function offlineHerdr() {
  if (process.env.HERDR_TEST_OFFLINE_ROOT) return () => {};
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'org-offline-herdr-'));
  fs.writeFileSync(path.join(root, 'herdr'), '#!/bin/sh\necho "offline tests: provide a fake Herdr CLI" >&2\nexit 1\n', { mode: 0o755 });
  for (const name of Object.keys(process.env)) if (name.startsWith('HERDR_') && !name.startsWith('HERDR_TEST_')) delete process.env[name];
  process.env.HERDR_TEST_OFFLINE_ROOT = root;
  process.env.HERDR_SOCKET_PATH = path.join(root, 'absent.sock');
  process.env.PATH = `${root}:${process.env.PATH ?? ''}`;
  process.env.ORG_ACTOR = `offline-test-${process.pid}`;
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  process.once('exit', cleanup);
  return cleanup;
}
