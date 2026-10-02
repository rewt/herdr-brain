// The adapter has one authority boundary: every record operation invokes the CLI.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));

export function createCli({ cwd, env, timeout = 15000 }) {
  const shutdown = new AbortController();
  const pending = new Set();
  async function run(argv, signal) {
    const job = execute(process.execPath, [BIN, ...argv], {
      cwd, env, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
      signal: signal ? AbortSignal.any([shutdown.signal, signal]) : shutdown.signal,
    });
    pending.add(job);
    try {
      return await job;
    } catch (error) {
      const uncertain = error.killed || error.code === 'ABORT_ERR' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      throw new Error([
        error.stderr?.trim(), error.stdout?.trim(),
        uncertain ? 'CLI interrupted; the operation may have committed. Inspect the record before retrying.' : error.message,
      ].filter(Boolean).join('\n'));
    } finally {
      pending.delete(job);
    }
  }
  return {
    run,
    async report(command, { file, report, run: runId }, signal) {
      if ((file === undefined) === (report === undefined)) throw new Error('Provide exactly one of file or report.');
      let scratch;
      try {
        if (report !== undefined) {
          scratch = await mkdtemp(path.join(os.tmpdir(), 'record-mcp-report-'));
          file = path.join(scratch, 'report.md');
          await writeFile(file, report, { mode: 0o600 });
        }
        return await run([command, ...(runId === undefined ? [] : [`--run=${runId}`]), '--', file], signal);
      } finally {
        if (scratch) await rm(scratch, { recursive: true, force: true });
      }
    },
    async close() {
      shutdown.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
