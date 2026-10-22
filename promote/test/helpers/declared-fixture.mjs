import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixtureFleet } from '../../../test/helpers/offline-herdr.mjs';
import { healthyMemoryEnvironment } from '../../../test/helpers/promotion-memory-fixture.mjs';
import { commandAllowance } from '../../../test/helpers/command-allowance.mjs';
import { queueFor, enqueue } from '../../promote.mjs';
import { readDeclared } from '../../../lanes/validation.mjs';
import { executionIdentity } from '../../execution-identity.mjs';
import { planDeclaredGate, executeDeclaredGate } from '../../declared-gates.mjs';
import { bindRequirements } from '../../declared-selection.mjs';
import { waitForInboxIdle } from '../../../test/helpers/inbox.mjs';

export const product = fileURLToPath(new URL('../../../', import.meta.url));
export const declaration = () => ({ schema: 'declared-gates/v2', fast: 'node baseline.mjs', promotion: 'node baseline.mjs', release: 'node baseline.mjs',
  coverage: { fast: ['baseline'], promotion: ['baseline'], release: ['all'] }, receipt_reuse: 'declared-inputs',
  timeout_seconds: { promotion: 45 }, gate: {}, promotion_tests: { command: ['node', 'planner.mjs'] },
  gates: { tool: { command: 'node runner.mjs "whole.test.ts" --maxWorkers=1', cwd: '.', covers: ['whole.test.ts', 'recipe:fixture'] } } });
export const emptySelection = () => ({ schema: 'promotion-gates/v1', gates: [], deferred: [], unknown: [] });
export const reuseInputs = () => ({ paths: ['baseline.mjs', 'product.txt', '.fixture/input*'],
  environment: ['PATH', 'HOME', 'CHECK_LOG', 'DECLARED_INPUT'], toolchains: { runtime: 'node --version', runner: 'node --version' } });
export function declaredFixture(t, { marked = true, declared = declaration() } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'declared-v2-'))), previous = process.cwd();
  fixtureFleet(t, root);
  t.after(async () => { process.chdir(previous); await waitForInboxIdle(path.join(repo, '.git/supervisor/inbox.log')); fs.rmSync(root, { recursive: true, force: true }); });
  const owner = path.join(root, 'owner'), foreign = path.join(root, 'foreign'), repo = path.join(owner, 'project'), workspace = path.join(owner, 'worker');
  for (const at of [owner, foreign, repo]) fs.mkdirSync(at, { recursive: true });
  if (marked) for (const at of [owner, foreign]) fs.writeFileSync(path.join(at, '.identity-root'), '');
  const log = path.join(root, 'executed');
  const herdr = path.join(root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:{agent:'claude',agent_status:'idle',pane_id:'fixture'}}}));else if(a[0]==='pane'&&a[1]==='read')console.log('────────────────────\\n❯ \\n────────────────────');else console.log(JSON.stringify({result:{workspaces:[],agents:[]}}));`, { mode: 0o755 });
  const env = { ...healthyMemoryEnvironment(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CHECK_LOG: log,
    SUPERVISOR_INPUT_WAIT_SECONDS: '2', SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.001', SUPERVISOR_INPUT_POLL_SECONDS: '0.001' };
  for (const key of Object.keys(env)) if (/^(?:ORG_|LANE_|HERDR_(?:PANE|TAB|WORKSPACE)_ID|GIT_(?:DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*))/.test(key)) delete env[key];
  const run = (binary, args, cwd = repo, extra = {}) => spawnSync(binary, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', [commandAllowance]: 60000 });
  const good = result => { assert.equal(result.status, 0, result.stderr + result.stdout + (result.error?.message ?? '')); return result.stdout.trim(); };
  const git = (args, cwd = repo) => good(run('git', args, cwd));
  const write = (name, text, at = repo) => { const file = path.join(at, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Declared fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  write('.gitignore', '.lane/\nnode_modules/\ndist/\n.fixture/\n__pycache__/\n');
  write('.lane.validation.json', JSON.stringify(declared));
  write('baseline.mjs', "import fs from 'node:fs';fs.appendFileSync(process.env.CHECK_LOG,'baseline\\n');console.log('# tests 1\\n# pass 1\\n# fail 0');");
  write('runner.mjs', "import fs from 'node:fs';fs.appendFileSync(process.env.CHECK_LOG,JSON.stringify(process.argv.slice(2))+'\\n');");
  write('inventory.mjs', 'export const extra=[];\n');
  write('planner.mjs', "import fs from 'node:fs';import {extra} from './inventory.mjs';const input=JSON.parse(fs.readFileSync(0,'utf8'));const ids=[...new Set([...extra,...input.required.flatMap(x=>typeof x==='object'?[x.gate]:x==='whole.test.ts'||x==='recipe:fixture'?['tool']:[])])].filter(x=>x!=='promotion');console.log(JSON.stringify({schema:'promotion-gates/v1',gates:ids.map(id=>({id,reason:'canonical required work'})),deferred:[],unknown:[]}));");
  write('product.txt', 'base'); git(['add', '.']); git(['commit', '-qm', 'Canonical policy']);
  git(['worktree', 'add', '-qb', 'lane/topic', workspace]);
  write('product.txt', 'candidate', workspace); git(['add', '.'], workspace); git(['commit', '-qm', 'Candidate'], workspace);
  process.chdir(repo);
  const commit = (at = repo) => { git(['add', '.'], at); git(['commit', '-qm', 'Fixture change'], at); };
  const base = () => git(['rev-parse', 'main']), head = () => git(['rev-parse', 'HEAD'], workspace);
  const queue = () => queueFor(repo);
  const add = (options = {}, topic = 'topic') => enqueue(queue(), [topic], { laneCLI: path.join(product, 'lanes/lane.mjs'), org: null, herdr, to: 'fixture', attempts: 1, retry: 0, ...options });
  const plan = (options = {}) => {
    const project = queue().project, owner = readDeclared(repo, { env }), evidence = { commands: [] };
    const required = bindRequirements(options.required ?? [], owner.value);
    return { ...planDeclaredGate({ repo, common: project.identity, cwd: workspace, base: base(), candidate: head(), owner,
      identity: executionIdentity(project), changed: ['product.txt'], env, evidence, ...options, required }), evidence };
  };
  const execute = (execution = plan(), options = {}) => executeDeclaredGate({ spec: execution.spec, env, evidence: execution.evidence, ...options });
  const lines = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  return { root, owner, foreign, repo, workspace, log, env, run, good, git, write, commit, base, head, queue, add, plan, execute, lines,
    lane: (args, cwd = workspace, extra = {}) => run(process.execPath, [path.join(product, 'lanes/lane.mjs'), ...args], cwd, extra),
    cli: (args, cwd = repo, extra = {}) => run(process.execPath, [path.join(product, 'promote/promote.mjs'), ...args], cwd, extra) };
}
