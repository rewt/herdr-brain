import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { fixtureFleet } from '../../../test/helpers/offline-herdr.mjs';
import { healthyMemoryEnvironment } from '../../../test/helpers/promotion-memory-fixture.mjs';
import { queueFor, enqueue } from '../../promote.mjs';
import { readDeclared } from '../../../lanes/validation.mjs';
import { executionIdentity } from '../../execution-identity.mjs';
import { planDeclaredGate } from '../../declared-gates.mjs';

export const product = fileURLToPath(new URL('../../../', import.meta.url));
export const declaration = () => ({ schema: 'declared-gates/v1', fast: 'node baseline.mjs', promotion: 'node baseline.mjs', release: 'node baseline.mjs',
  timeout_seconds: { promotion: 90 }, gate: {}, promotion_tests: { command: ['node', 'planner.mjs'] },
  runners: { 'node-test': { command: ['node', '--test'], cwd: '.' }, tool: { command: ['node', 'runner.mjs'], cwd: '.' } } });
export function declaredFixture(t, { marked = true, declared = declaration() } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'declared-gates-')));
  const previous = process.cwd();
  t.after(() => { process.chdir(previous); fs.rmSync(root, { recursive: true, force: true }); });
  fixtureFleet(t, root);
  const owner = path.join(root, 'owner'), foreign = path.join(root, 'foreign'), repo = path.join(owner, 'project'), workspace = path.join(owner, 'worker');
  for (const at of [owner, foreign, repo]) fs.mkdirSync(at, { recursive: true });
  if (marked) for (const at of [owner, foreign]) fs.writeFileSync(path.join(at, '.identity-root'), '');
  const log = path.join(root, 'executed'), config = path.join(root, 'lane.json'); fs.writeFileSync(config, '{}');
  const env = { ...healthyMemoryEnvironment(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CHECK_LOG: log, LANE_CONFIG: config };
  for (const key of Object.keys(env)) if (/^(?:ORG_|LANE_VALIDATE|HERDR_(?:PANE|TAB|WORKSPACE)_ID|GIT_(?:DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*))/.test(key)) delete env[key];
  const run = (binary, args, cwd = repo, extra = {}) => spawnSync(binary, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  const good = result => { assert.equal(result.status, 0, result.stderr + result.stdout); return result.stdout.trim(); };
  const git = (args, cwd = repo) => good(run('git', args, cwd));
  const write = (name, content, at = repo) => { fs.mkdirSync(path.dirname(path.join(at, name)), { recursive: true }); fs.writeFileSync(path.join(at, name), content); };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Declared fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  write('.gitignore', '.lane/\nnode_modules/\ndist/\n.planner/\n.fixture/\n');
  write('.lane.validation.json', JSON.stringify(declared));
  write('baseline.mjs', "import fs from 'node:fs';fs.appendFileSync(process.env.CHECK_LOG,'baseline\\n');console.log('# tests 1\\n# pass 1\\n# fail 0');");
  write('runner.mjs', "import fs from 'node:fs';fs.appendFileSync(process.env.CHECK_LOG,JSON.stringify(process.argv.slice(2))+'\\n');");
  write('inventory.mjs', 'export const files=[];\n');
  write('planner.mjs', "import fs from 'node:fs';import {files} from './inventory.mjs';const input=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify({schema:'promotion-tests/v2',files:[...files,...input.required.filter(x=>typeof x==='string')],steps:input.required.filter(x=>typeof x!=='string').map(({runner,args})=>({runner,args,reason:'bound-required'}))}));");
  write('product.txt', 'base'); git(['add', '.']); git(['commit', '-qm', 'Canonical policy']);
  git(['worktree', 'add', '-qb', 'lane/topic', workspace]);
  write('product.txt', 'candidate', workspace); git(['add', '.'], workspace); git(['commit', '-qm', 'Candidate product'], workspace);
  process.chdir(repo);
  const commit = (at = repo) => { git(['add', '.'], at); git(['commit', '-qm', 'Fixture policy change'], at); };
  const base = () => git(['rev-parse', 'main']);
  const head = () => git(['rev-parse', 'HEAD'], workspace);
  const queue = () => queueFor(repo);
  const add = (options = {}) => enqueue(queue(), ['topic'], { laneCLI: path.join(product, 'lanes/lane.mjs'), org: null, ...options });
  const plan = (options = {}) => {
    const project = queue().project;
    return planDeclaredGate({ repo, common: project.identity, cwd: workspace, base: base(), candidate: head(), owner: readDeclared(repo, { env }),
      identity: executionIdentity(project), changed: ['product.txt'], env, ...options });
  };
  return { root, owner, foreign, repo, workspace, log, env, run, good, git, write, commit, base, head, queue, add, plan,
    lines: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [],
    lane: (args, cwd = workspace, extra = {}) => run(process.execPath, [path.join(product, 'lanes/lane.mjs'), ...args], cwd, extra),
    cli: (args, cwd = repo, extra = {}) => run(process.execPath, [path.join(product, 'promote/promote.mjs'), ...args], cwd, extra) };
}
