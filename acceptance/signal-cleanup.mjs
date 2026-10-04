import fs from 'node:fs';
import path from 'node:path';

export const credentialResidue = root => ['codex-runtime', 'claude-runtime']
  .map(name => path.join(root, name)).filter(directory => fs.existsSync(directory));

export function removeCredentials(root) {
  for (const name of ['codex-runtime', 'claude-runtime']) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  return credentialResidue(root);
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
    summarize({ signal, cleanupErrors: errors, credentialResidue: credentialResidue(root) });
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}
