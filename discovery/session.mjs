// Keep the native PID stable across the ownership handoff. Before exec, this
// shell can only wait; EOF from a dead parent exits without starting an agent.
import { spawn } from 'node:child_process';
const gate = 'IFS= read -r monitor_gate <&3 && [ "$monitor_gate" = launch ] || exit 1\nexec 3<&-\nexec "$@"';
export function spawnNative(entry, binary, args, options) {
  const child = spawn('/bin/sh', ['-c', gate, 'monitor-native', binary, ...args], {
    ...options, stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
  });
  child.stdio[3].on('error', () => {}); // Native exit is reported by child.close.
  try {
    entry.attachChild(child.pid);
    child.stdio[3].end('launch\n');
  } catch (error) {
    child.stdio[3].destroy(); child.kill('SIGTERM'); throw error;
  }
  return child;
}
