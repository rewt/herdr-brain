// Isolate harness homes and name fakes for native PATH discovery in fixtures.
import fs from 'node:fs';
import path from 'node:path';

export function nativeEnvironment(root, binaries, front = []) {
  const tools = path.join(root, 'native-tools');
  fs.mkdirSync(tools, { recursive: true });
  for (const [kind, binary] of Object.entries({ node: process.execPath, ...binaries })) fs.symlinkSync(binary, path.join(tools, kind));
  fs.writeFileSync(path.join(tools, 'herdr'), '#!/bin/sh\necho "native fixture: Herdr is offline" >&2\nexit 1\n', { mode: 0o755 });
  return { PATH: [...front, tools, '/usr/bin', '/bin'].join(path.delimiter), HOME: root, CODEX_HOME: path.join(root, 'native-codex-home'), CLAUDE_CONFIG_DIR: path.join(root, 'native-claude-home') };
}
