// Thin wrappers over the herdr CLI. Every call is read-only except none —
// this module never starts, prompts, keys or closes anything.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BIN = process.env.HERDR_BIN ?? 'herdr';

export class HerdrDown extends Error {}

// `herdr agent list` returns { id, result: { agents: [...] } }.
export async function agents() {
  try {
    const { stdout } = await run(BIN, ['agent', 'list'], { maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout).result.agents ?? [];
  } catch (err) {
    throw new HerdrDown(err.stderr?.trim() || err.message);
  }
}

// The session's screen. `recent-unwrapped` because the pane's width is not ours.
export async function read(name, lines = 250) {
  try {
    const { stdout } = await run(
      BIN,
      ['agent', 'read', name, '--source', 'recent-unwrapped', '--lines', String(lines), '--format', 'text'],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout;
  } catch (err) {
    // A session can vanish between the list and the read; that is not an error.
    return null;
  }
}

export function tabLabels() {
  try {
    const out = execFileSync(BIN, ['tab', 'list'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const tabs = JSON.parse(out).result?.tabs ?? [];
    return new Map(tabs.map((t) => [t.id ?? t.tab_id, t.label]));
  } catch {
    return new Map();
  }
}
