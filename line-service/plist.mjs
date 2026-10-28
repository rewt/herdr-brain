import path from 'node:path';
import {runtimeRoot as sourceRoot} from './runtime.mjs';

const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
export function launchPlist({ label, repo, org, to, herdr, socket, directory, interval = 30, node = process.execPath, searchPath = process.env.PATH, source = sourceRoot, environment }) {
  if (!Number.isSafeInteger(interval) || interval < 1) throw Error('interval must be positive integer seconds');
  const args = [node, path.join(source, 'line-service/line-service.mjs'), '--once', '--repo', repo, '--org', org, '--to', to, '--herdr', herdr];
  // Only transport/executable locations. Never copy a caller's pane/SID/claims.
  const env = environment ?? { PATH: `${path.dirname(node)}:${path.dirname(herdr)}:${searchPath ?? '/usr/bin:/bin'}`, HERDR_SOCKET_PATH: socket };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>\n<key>WorkingDirectory</key><string>${xml(repo)}</string>\n<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>\n<key>StartInterval</key><integer>${interval}</integer>\n<key>RunAtLoad</key><true/>\n<key>StandardOutPath</key><string>${xml(path.join(directory, 'launchd.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(directory, 'launchd.error.log'))}</string>\n</dict></plist>\n`;
}

