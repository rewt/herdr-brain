import fs from 'node:fs';
import path from 'node:path';
import { copyProduct } from '../lib/product-files.mjs';
import { createLiveSessionTemp } from './temp.mjs';
import { sessionEnv, copiedSandbox } from './security.mjs';
import { HarnessLimit, Pending, commandFailure } from './limits.mjs';
import { assertLessonEntry } from './entry.mjs';

const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
export function nativeUiReady(kind, screen) {
  if (typeof screen !== 'string') return false;
  const text = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  // Branding alone also appears on failed startup. Require an input prompt or
  // the fresh-home interactive setup choices as well as the native branding.
  return kind === 'codex'
    ? /OpenAI Codex|Welcome to Codex/i.test(text) && (/^\s*›/m.test(text) || /\d+[.)]\s+Sign in with ChatGPT/i.test(text))
    : /Claude Code|Welcome to Claude/i.test(text) && (/^\s*❯/m.test(text) || /Choose the text style/i.test(text) && /Enter to confirm/i.test(text));
}

export async function lessonsEntryCase({ opt = {}, root, scratchRoots, discoveryRoots, candidate, evidence, run, node, initRepo, h, until, write, read }) {
  if (opt['skip-live']) throw new Pending('fresh lessons entry sessions explicitly skipped; release gate cannot pass');
  if (process.platform !== 'darwin') throw new HarnessLimit('fresh entry UI canary requires macOS sandbox-exec');
  // Only an explicitly supplied, dedicated profile enables Claude UI proof.
  // Never inherit CLAUDE_CONFIG_DIR or discover credentials in the user's home.
  const claudeProfile = opt['claude-profile'] ? fs.realpathSync(opt['claude-profile']) : undefined;
  if (claudeProfile && !fs.statSync(claudeProfile).isDirectory()) throw new Error('--claude-profile must be a dedicated profile directory');
  const claudeRuntime = path.join(root, 'claude-runtime');
  try {
    const binaries = {};
    for (const kind of ['codex', 'claude']) {
      const found = run('which', [kind], { extra: { PATH: process.env.PATH }, ok: false });
      if (found.status !== 0) throw new HarnessLimit(`native ${kind} unavailable for fresh entry`);
      let binary = fs.realpathSync(found.stdout.trim());
      const marker = path.join(path.dirname(binary), '.monitor-entry.json');
      if (fs.existsSync(marker)) binary = JSON.parse(read(marker))[kind === 'codex' ? 'native' : 'claudeNative'];
      if (!binary || !path.isAbsolute(binary)) throw new HarnessLimit(`native ${kind} install receipt unavailable`);
      binaries[kind] = fs.realpathSync(binary);
    }
    const scratch = createLiveSessionTemp(scratchRoots, discoveryRoots);
    const installation = path.join(scratch, 'product'), repo = path.join(scratch, 'project');
    copyProduct(candidate, installation);
    initRepo(repo);
    fs.mkdirSync(path.join(repo, 'area'), { recursive: true });
    const ledger = JSON.parse(read(path.join(root, 'ownership.json')));
    ledger.creationRoots = [...(ledger.creationRoots ?? []), scratch]; write(path.join(root, 'ownership.json'), JSON.stringify(ledger));
    fs.copyFileSync(path.join(import.meta.dirname, 'entry-session.mjs'), path.join(root, 'entry-session.mjs'));
    // The transport runs inside the kernel boundary; keep it beside its helper.
    for (const file of ['entry-native.mjs', 'entry.mjs']) fs.copyFileSync(path.join(import.meta.dirname, file), path.join(scratch, file));
    const record = args => node(path.join(installation, 'bin/org.mjs'), args, { cwd: repo, extra: { ORG_DIR: path.join(repo, '.org') } }).stdout.trim();
    record(['init']); const item = record(['add', 'Entry lesson evidence', '--role', 'engineer']).split('\n')[0];
    const lesson = `Entry lesson canary ${path.basename(scratch)}: preserve the amber notebook.`;
    const id = record(['lesson', 'add', lesson, '--path', 'area', '--evidence', item]).split('\n')[0];
    record(['lesson', 'activate', id]);
    write(path.join(evidence, 'lessons-planted.json'), JSON.stringify({ repo, id, lesson }, null, 2));
    for (const kind of ['codex', 'claude']) {
      const name = `lessons-${kind}`, temp = path.join(scratch, kind), bin = path.join(temp, 'bin');
      fs.mkdirSync(temp); const runtimeHome = path.join(temp, 'runtime'); fs.mkdirSync(runtimeHome);
      const claudeConfig = kind === 'claude' && claudeProfile ? claudeRuntime : path.join(temp, '.claude');
      if (kind === 'claude' && claudeProfile) fs.cpSync(claudeProfile, claudeConfig, {
        recursive: true,
        filter: source => {
          if (fs.lstatSync(source).isSymbolicLink()) throw new Error('--claude-profile must not contain symlinks');
          return true;
        },
      });
      const requiresUi = kind === 'codex' || !!claudeProfile;
      const receipt = path.join(temp, 'entry.json'), nativeDone = path.join(temp, 'native.done.json');
      const nativeSpec = path.join(temp, 'native.json'), transport = path.join(temp, 'native-bin', kind);
      write(nativeSpec, JSON.stringify({ kind, binary: binaries[kind], installation, receipt, nativeDone }));
      write(transport, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(scratch, 'entry-native.mjs'))} ${quote(nativeSpec)} "$@"\n`); fs.chmodSync(transport, 0o755);
      const env = { ...sessionEnv(process.env, { temp, runtimeHome, path: `${path.dirname(transport)}:${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, name }),
        HERDR_MONITOR_FLEET: path.join(scratch, 'f'), CLAUDE_CONFIG_DIR: claudeConfig,
        MONITOR_RUNTIME_DIR: path.join(temp, 'requests'), MONITOR_WORKTREE_ROOT: path.join(scratch, 'lanes'),
        TERM: 'xterm-256color', OPENAI_API_KEY: 'entry-ui-no-network' };
      node(path.join(installation, 'discovery/install.mjs'), ['--bin', bin, `--${kind}`, transport], { isolatedEnv: env });
      const sandbox = path.join(temp, 'ui.sb');
      const tools = [...new Set([fs.realpathSync(path.join(path.dirname(process.execPath), '..')), '/opt/homebrew',
        ...Object.values(binaries).map(binary => fs.realpathSync(path.join(path.dirname(binary), '..'))),
        ...(kind === 'claude' && claudeProfile ? [claudeRuntime] : [])])];
      write(sandbox, copiedSandbox(scratch, tools)
        + (kind === 'claude' && claudeProfile ? `(allow file-write* (subpath ${JSON.stringify(claudeRuntime)}))\n` : '')
        + '(allow file-write* (subpath "/dev"))\n(deny network*)\n');
      const stop = path.join(temp, 'stop');
      write(path.join(root, 'live-jobs', `${name}.json`), JSON.stringify({ repo: path.join(repo, 'area'), env, sandbox, entryBinary: path.join(bin, kind), stop }));
      const ws = h('workspace', 'create', '--cwd', repo, '--label', `acceptance-${name}`, '--no-focus');
      const pane = ws.root_pane.pane_id;
      const done = path.join(root, 'live-jobs', `${name}.done`);
      let nativePid;
      const assertRunning = (screen = '') => {
        for (const [file, label] of [[nativeDone, 'native.done.json'], [done, 'done.json']]) {
          if (!fs.existsSync(file)) continue;
          const completion = read(file);
          write(path.join(evidence, `${name}.${label}`), completion);
          throw commandFailure(`${kind} entry exited before interactive readiness: ${completion}\n${screen}`);
        }
        if (nativePid) {
          try { process.kill(nativePid, 0); }
          catch (error) {
            if (error.code !== 'ESRCH') throw error;
            throw commandFailure(`${kind} entry exited before interactive readiness: native child ${nativePid} is absent\n${screen}`);
          }
        }
      };
      let launched = false;
      try {
        await until(() => h('pane', 'get', pane).pane.foreground_cwd === repo, `${name} fresh shell cwd`);
        h('pane', 'run', pane, [process.execPath, path.join(root, 'entry-session.mjs'), root, name].map(quote).join(' '));
        launched = true;
        await until(() => fs.existsSync(receipt) || fs.existsSync(nativeDone) || fs.existsSync(done), `${name} native entry receipt`);
        if (!fs.existsSync(receipt) || requiresUi && (fs.existsSync(nativeDone) || fs.existsSync(done))) {
          const failureScreen = node(path.join(root, 'herdr.mjs'), ['pane', 'read', pane, '--source', 'recent-unwrapped', '--format', 'text', '--lines', '100']).stdout;
          write(path.join(evidence, `${name}.screen.txt`), failureScreen);
          assertRunning(failureScreen);
          throw commandFailure(`${kind} entry exited before native delivery: ${failureScreen}`);
        }
        const delivered = JSON.parse(read(receipt));
        write(path.join(evidence, `${name}.entry.json`), JSON.stringify(delivered, null, 2));
        assertLessonEntry(delivered, { kind, installation, lesson });
        nativePid = delivered.nativePid;
        if (!requiresUi) {
          // Receipt publication occurs only on the native child's spawn event.
          // Its subsequent unauthenticated exit does not invalidate delivery or
          // process start, and retained scrollback cannot claim UI readiness.
          const screen = node(path.join(root, 'herdr.mjs'), ['pane', 'read', pane, '--source', 'recent-unwrapped', '--format', 'text', '--lines', '100']).stdout;
          write(path.join(evidence, `${name}.screen.txt`), screen);
          continue;
        }
        // PTY scrollback survives exit. Check the native child itself around the
        // UI observation; waiting for adapter cleanup cannot prove UI liveness.
        let screen;
        await until(() => {
          assertRunning(screen);
          screen = node(path.join(root, 'herdr.mjs'), ['pane', 'read', pane, '--source', 'recent-unwrapped', '--format', 'text', '--lines', '100']).stdout;
          write(path.join(evidence, `${name}.screen.txt`), screen);
          assertRunning(screen);
          return nativeUiReady(kind, screen);
        }, `${name} fresh native UI`);
        assertRunning();
      } finally {
        try {
          if (launched) {
            write(stop, 'stop');
            await until(() => fs.existsSync(path.join(root, 'live-jobs', `${name}.done`)), `${name} native session stopped`);
            write(path.join(evidence, `${name}.done.json`), read(done));
            if (fs.existsSync(nativeDone)) write(path.join(evidence, `${name}.native.done.json`), read(nativeDone));
          }
        } finally { h('workspace', 'close', ws.workspace.workspace_id); }
      }
    }
    return claudeProfile
      ? `${id}: planted active area lesson delivered to fresh Codex and Claude native UIs with interactive readiness; explicit Claude profile; no inference or network`
      : `LIMITATION: Claude lesson delivery and native process start only; no credentialed Claude profile configured, interactive readiness unproven. ${id}: Codex lesson delivery and interactive readiness proven; no inference or network`;
  } finally {
    // Authentication copies are never retained evidence, including --keep and
    // setup/teardown failures. Signal cleanup also knows this fixed owned path.
    if (claudeProfile) fs.rmSync(claudeRuntime, { recursive: true, force: true });
  }
}
