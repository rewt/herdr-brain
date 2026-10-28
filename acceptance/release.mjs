// Shared by live acceptance and the focused offline scratch-release witness.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createProductCheckout, productFiles, payloadEntry } from '../lib/product-files.mjs';

export function scratchReleaseCase({ root, candidate, source, candidateCommit, git, run, node }) {
  const write = (file, value) => fs.writeFileSync(file, value);
  const read = file => fs.readFileSync(file, 'utf8');
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
  const script = path.join(candidate, 'herdr/release.sh');
  const repo = path.join(root, 'release-source');
  createProductCheckout({ source, commit: candidateCommit, destination: repo, ownedRoot: root, git });
  assert.deepEqual(productFiles(repo).sort().map(file => [file, payloadEntry(repo, file)]), productFiles(candidate).sort().map(file => [file, payloadEntry(candidate, file)]));
  // The enclosing candidate already passed its full offline gate. These tagged
  // switch fixtures run a small gate rather than replaying that whole suite.
  const validationFile = path.join(repo, '.lane.validation.json');
  const validation = JSON.parse(read(validationFile));
  validation.release = 'node bin/org.mjs --help';
  write(validationFile, JSON.stringify(validation));
  git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.email', 'acceptance@example.invalid']); git(repo, ['config', 'user.name', 'Acceptance']);
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'Candidate snapshot']); git(repo, ['tag', 'candidate']);
  write(path.join(repo, 'acceptance-release-marker'), 'rollback fixture'); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'Second scratch release']); git(repo, ['tag', 'second']);
  const home = path.join(root, 'monitor-home'), bin = path.join(root, 'release-bin'); fs.mkdirSync(bin);
  fs.symlinkSync(path.join(candidate, 'bin/org.mjs'), path.join(bin, 'org'));
  // A legacy detached watcher has no dispatch journal. Its scratch nohup
  // adapter emits its own process receipt before exec; cleanup never scans PIDs.
  write(path.join(bin, 'nohup'), `#!/bin/sh\nprintf '%s\\n' "$$" >> ${quote(path.join(root, 'legacy-watcher-pids'))}\nexec /usr/bin/nohup "$@"\n`);
  fs.chmodSync(path.join(bin, 'nohup'), 0o755);
  fs.symlinkSync(path.join(candidate, 'lanes/lane.mjs'), path.join(bin, 'lane'));
  const userHome = path.join(root, 'release-user-home'); fs.mkdirSync(userHome);
  const native = run('which', ['true']).stdout.trim();
  const extra = { HOME: userHome, ZDOTDIR: userHome, CODEX_HOME: path.join(userHome, '.codex'), CLAUDE_CONFIG_DIR: path.join(userHome, '.claude'),
    ORG_ACTOR: 'acceptance-release-install', HERDR_MONITOR_CODEX: native, HERDR_MONITOR_CLAUDE: '-',
    HERDR_MONITOR_REPO: repo, HERDR_MONITOR_HOME: home, HERDR_MONITOR_BIN: bin, HERDR_MONITOR_PLIST: path.join(root, 'absent.plist'),
    HERDR_BIN_PATH: path.join(root, 'absent-herdr') };
  const release = (...a) => run('bash', [script, ...a], { extra });
  release('build', 'candidate'); release('build', 'second'); release('activate', 'candidate');
  node(path.join(bin, 'record'), ['--help']); node(path.join(bin, 'org'), ['--help']);
  release('activate', 'second'); release('activate', 'second'); release('rollback');
  assert.equal(fs.readlinkSync(path.join(home, 'current')), path.join(home, 'releases/candidate'));
  assert.ok(!fs.existsSync(path.join(userHome, '.zshenv')));
  return 'immutable scratch releases and launcher activation and rollback checked in an isolated home';
}
