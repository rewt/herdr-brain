import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd(), out = path.join(root, 'docs/reports/evidence/ENG-102-R120');
const scratch = path.join(root, '.lane/phase4-r120-evidence');
const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) throw new Error('Use before or after.');
fs.mkdirSync(scratch, { recursive: true });
const env = { ...process.env, ORG_ACTOR: 'phase4-r120-evidence', HERDR_ENV: '1', HERDR_BIN_PATH: path.join(scratch, 'herdr') };
delete env.LANE_CONFIG;
fs.writeFileSync(env.HERDR_BIN_PATH, `#!${process.execPath}\nconsole.log(JSON.stringify({result:{agents:[],workspaces:[],tabs:[],panes:[]}}));\n`, { mode: 0o755 });
const fixtureFile = path.join(scratch, 'fixture-path');
let fixture;
if (fs.existsSync(fixtureFile)) fixture = fs.readFileSync(fixtureFile, 'utf8');
else {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-eng102-r120-'));
  const git = args => execFileSync('git', args, { cwd: fixture, timeout: 10000, stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.test']);
  fs.writeFileSync(path.join(fixture, 'README.md'), 'Independent project\n'); git(['add', '.']); git(['commit', '-qm', 'Independent project']);
  const org = args => execFileSync(process.execPath, [path.join(root, 'bin/org.mjs'), ...args], {
    cwd: fixture, env: { ...env, ORG_DIR: path.join(fixture, '.org') }, timeout: 10000, stdio: 'pipe',
  });
  org(['init']);
  org(['routes', 'defaults', '--value=' + JSON.stringify({ kind: 'codex', model: 'gpt-6.1-sol', effort: 'high', args: ['--launch-option', 'value with spaces'] })]);
  org(['routes', 'arguments', '--value=' + JSON.stringify({ codex: ['--always-option', 'value with spaces'] })]);
  fs.writeFileSync(fixtureFile, fixture);
}
for (const [name, cwd, org] of [['record', root, '/Users/rewt/development/rewt/.org'], ['fixture', fixture, path.join(fixture, '.org')]]) {
  const config = path.join(scratch, `${name}.json`);
  fs.writeFileSync(config, JSON.stringify({ projects: [{ name: name === 'record' ? 'herdr-brain' : 'Independent project', cwd, org }] }));
  const screens = {
    'route-add-review': 'ukkkkk\\nnew-inherited-route\\tcodex\\n',
    'arguments-review': 'uk\\ncodex\\n',
  };
  for (const [screen, keys] of Object.entries(screens)) for (const size of ['80x30', '100x40', '140x48']) {
    const printed = execFileSync(process.execPath, [path.join(root, 'console/app.mjs'), '--modern', '--config', config, '--print', size, '--keys', keys], {
      cwd, env: { ...env, ORG_DIR: org }, encoding: 'utf8', timeout: 20000,
    });
    fs.writeFileSync(path.join(out, `${phase}-${name}-${screen}-${size}.txt`), printed);
  }
}
