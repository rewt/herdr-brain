import fs from 'node:fs';
import path from 'node:path';

export function removeCredentials(root) {
  const directory = path.join(root, 'codex-runtime');
  fs.rmSync(directory, { recursive: true, force: true });
  return fs.existsSync(directory) ? [directory] : [];
}

export function installSignalCleanup({ root, cleanup, summarize, onSignal = () => {} }) {
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    onSignal(signal);
    const errors = [];
    // Delete credentials first, before a slow or failed pane/process shutdown.
    try { removeCredentials(root); } catch (error) { errors.push(error.message); }
    try { await cleanup(signal); } catch (error) { errors.push(error.message); }
    try { removeCredentials(root); } catch (error) { errors.push(error.message); }
    const directory = path.join(root, 'codex-runtime');
    summarize({ signal, cleanupErrors: errors, credentialResidue: fs.existsSync(directory) ? [directory] : [] });
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}
