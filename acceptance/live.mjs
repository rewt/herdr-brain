import { cases } from './cases.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import os from 'node:os';
import { permissionArgs, sessionEnv, policyWitness } from './security.mjs';
import { boundaryScript, liveSocket } from './probe.mjs';
import { HarnessLimit, isHarnessBoundary, isProductBoundary, commandFailure } from './limits.mjs';
import { createVerification } from './verify.mjs';
import { createOwnedTempRoot } from './temp.mjs';
import { copyNativeTransport } from './transport.mjs';

export async function discovery({ root, scratchRoots, discoveryRoots, evidence, candidate, opt, env, test, pending, initRepo, run, node, git: trustedGit, h, until, write, read }) {
  const model = opt['discovery-model'] ?? 'gpt-5.6-luna', effort = opt['discovery-effort'] ?? 'low';
  const usage = [];
  const verifiers = new Map();
  const git = (repo, args) => verifiers.has(repo) ? verifiers.get(repo).git(args) : trustedGit(repo, args);
  const installation = path.join(root, 'installed-product');
  fs.cpSync(candidate, installation, { recursive: true, filter: (file) => !['AGENTS.md', 'README.md', 'docs', 'test', 'tests', 'kit', 'acceptance', 'node_modules', '.git'].includes(path.basename(file)) });
  const bin = path.join(installation, 'entrypoints'); fs.mkdirSync(bin);
  for (const [name, target] of [['record', 'bin/org.mjs'], ['org', 'bin/org.mjs'], ['lane', 'lanes/lane.mjs']]) {
    if (!fs.existsSync(path.join(installation, target))) continue;
    write(path.join(bin, name), `#!/bin/sh\nexec '${process.execPath}' '${path.join(installation, target)}' "$@"\n`); fs.chmodSync(path.join(bin, name), 0o755);
  }
  write(path.join(evidence, 'discovery-installation.json'), JSON.stringify({ installation, entrypoints: fs.readdirSync(bin), excluded: ['AGENTS.md', 'README.md', 'docs', 'test', 'tests', 'kit', 'acceptance', 'node_modules', '.git'], source: candidate }, null, 2));
  const freshProject = (label) => {
    const parent = createOwnedTempRoot('/private/tmp/herdr-discovery-', scratchRoots, discoveryRoots);
    const repo = path.join(parent, label); initRepo(repo);
    assert.deepEqual(fs.readdirSync(parent), [label], 'no candidate, evidence or capability siblings');
    const ownership = path.join(root, 'ownership.json'); const ledger = JSON.parse(read(ownership));
    ledger.creationRoots = [...(ledger.creationRoots ?? []), repo]; write(ownership, JSON.stringify(ledger));
    return repo;
  };
  const schema = path.join(root, 'discovery-answer-schema.json');
  write(schema, JSON.stringify({ type: 'object', additionalProperties: false, required: ['policy_sources', 'checkout', 'branch', 'work_id', 'run_id', 'question_id', 'result'], properties: {
    policy_sources: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['source', 'excerpt'], properties: { source: { type: 'string' }, excerpt: { type: 'string' } } } },
    ...Object.fromEntries(['checkout', 'branch', 'work_id', 'run_id', 'question_id', 'result'].map((name) => [name, { type: 'string' }])),
  } }));
  fs.copyFileSync(path.join(import.meta.dirname, 'security.mjs'), path.join(root, 'security.mjs'));
  const nativeTransport = copyNativeTransport(root);

  const live = async (repo, name, task) => {
    const binary = fs.realpathSync(run('which', ['codex'], { extra: { PATH: process.env.PATH } }).stdout.trim());
    const temp = createOwnedTempRoot('/private/tmp/herdr-session-', scratchRoots, discoveryRoots);
    const runtimeHome = path.join(root, 'codex-runtime', name);
    fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
    const auth = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'auth.json');
    if (!fs.existsSync(auth)) throw new HarnessLimit('file-based Codex authentication unavailable for isolated discovery runtime');
    fs.copyFileSync(auth, path.join(runtimeHome, 'auth.json'));
    fs.chmodSync(path.join(runtimeHome, 'auth.json'), 0o600);
    fs.copyFileSync(path.join(import.meta.dirname, 'live-worker.mjs'), path.join(root, 'live-worker.mjs'));
    const scope = `You are doing a bounded acceptance task in a brand-new project. Work as an entering coding agent normally would, using whatever project policy and installed tools you discover. Another independent session may work here at the same time. Safety boundary: changes only in this project (${repo}) and your temporary directory (${temp}); never push, contact other sessions, or operate Herdr. Do not read other projects or private records. Do not invent operator preferences. In your final JSON, list every policy source actually received or read, including its path or exact installed CLI invocation and a verbatim excerpt of the policy. Leave policy_sources empty if none exists. Name your checkout/branch and durable work/run/question IDs (empty strings when absent), and describe validation/promotion evidence in result. If a required policy or discoverable entry point is absent, state that clearly; do not invent a product policy.\n\nTask: ${task}`;
    const gitProbe = path.join(temp, 'git-probe'); initRepo(gitProbe);
    write(path.join(gitProbe, 'proof.txt'), 'before sandbox'); git(gitProbe, ['add', '.']); git(gitProbe, ['commit', '-qm', 'Seed Git capability proof']);
    const spec = { repo, binary, gitBinary: fs.realpathSync(run('which', ['git'], { extra: { PATH: process.env.PATH } }).stdout.trim()), runtimeHome, model, effort, name, temp, installation, schema,
      gitCommon: git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      worktreeRoot: path.join(temp, 'entry-worktrees'), probeGit: path.join(gitProbe, '.git'),
      toolRoots: [path.dirname(binary), fs.realpathSync(path.join(path.dirname(process.execPath), '..')), '/opt/homebrew', fs.realpathSync(path.join(path.dirname(fs.realpathSync(binary)), '..'))],
      path: `${bin}:${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, prompt: scope };
    // Fail before inference if the native sandbox cannot prove its boundaries.
    const probe = path.join(temp, 'probe.mjs');
    write(path.join(root, 'protected-read-canary'), 'not project policy');
    const socket = liveSocket(process.env);
    write(probe, boundaryScript({ repo, temp, candidate, root, socket, gitProbe }));
    const clean = sessionEnv(process.env, spec);
    const checked = run(binary, ['sandbox', '-C', repo, '-P', 'acceptance', ...permissionArgs(spec), '--', process.execPath, probe],
      { cwd: repo, isolatedEnv: clean, ok: false });
    write(path.join(evidence, `${name}.boundary.json`), JSON.stringify({ status: checked.status, stdout: checked.stdout, stderr: checked.stderr, socket, hostIsSocket: true, writableRoots: [repo, temp], gitCommon: spec.gitCommon, worktreeRoot: spec.worktreeRoot, environmentKeys: Object.keys(clean) }, null, 2));
    fs.unlinkSync(probe);
    if (checked.status !== 0) throw new HarnessLimit(`native Git/isolation capability probe failed: ${(checked.stderr || checked.stdout).slice(-1600)}`);
    write(path.join(root, 'live-jobs', `${name}.json`), JSON.stringify(spec));
    // Machine installation is permitted; project configuration is not. Run
    // the candidate's installer when shipped rather than bypassing its adapter.
    const installer = path.join(installation, 'discovery/install.mjs');
    if (fs.existsSync(installer)) {
      const native = path.join(root, `native-${name}`), entryBin = path.join(installation, `entry-${name}`);
      write(native, `#!/bin/sh\nexec '${process.execPath}' '${nativeTransport}' '${root}' '${name}' "$@"\n`);
      fs.chmodSync(native, 0o755);
      run(process.execPath, [installer, '--bin', entryBin, '--codex', native], { isolatedEnv: clean });
      spec.entryBinary = path.join(entryBin, 'monitor-codex');
      if (!fs.existsSync(spec.entryBinary)) throw new Error('candidate installer did not expose its documented monitor-codex entry');
      spec.path = `${entryBin}:${spec.path}`;
      write(path.join(root, 'live-jobs', `${name}.json`), JSON.stringify(spec));
    }
    write(path.join(evidence, `${name}.prompt.txt`), scope);
    if (!verifiers.has(repo)) verifiers.set(repo, createVerification(spec, { root, scratchRoots, discoveryRoots, run }));
    const ws = h('workspace', 'create', '--cwd', repo, '--label', `acceptance-${name}`, '--no-focus');
    await until(() => h('pane', 'get', ws.root_pane.pane_id).pane.foreground_cwd === repo, `${name} shell cwd`);
    h('pane', 'run', ws.root_pane.pane_id, [process.execPath, path.join(root, 'live-worker.mjs'), root, name].map((s) => "'" + s.replaceAll("'", "'\\''") + "'").join(' '));
    return async () => {
      await until(() => fs.existsSync(path.join(root, 'live-jobs', `${name}.done`)), `${name} real session finishes`, 200_000);
      const done = JSON.parse(read(path.join(root, 'live-jobs', `${name}.done`)));
      const events = read(path.join(evidence, `${name}.jsonl`)).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      const turns = events.filter((e) => e.type === 'turn.completed').map((e) => e.usage);
      const totals = turns.reduce((a, u) => { for (const k of Object.keys(u ?? {})) a[k] = (a[k] ?? 0) + u[k]; return a; }, {});
      usage.push({ name, model, effort, ...done, usage: totals, completeTurns: turns.length });
      write(path.join(evidence, 'discovery-usage.json'), JSON.stringify(usage, null, 2));
      const sessionError = read(path.join(evidence, `${name}.stderr`)).slice(-2000);
      if (isProductBoundary(sessionError)) throw commandFailure(sessionError);
      if (isHarnessBoundary(sessionError) || done.signal) throw new HarnessLimit(`real session harness limit: ${sessionError || done.signal}`);
      assert.equal(done.code, 0, `real session failed: ${sessionError}`);
      if (!turns.length) throw new HarnessLimit('real session produced no measured model turn');
      const answer = JSON.parse(read(path.join(evidence, `${name}.txt`)));
      let sources, attributionError;
      const entryFile = path.join(evidence, `${name}.entry.json`);
      const entryReceipt = fs.existsSync(entryFile) ? JSON.parse(read(entryFile)) : undefined;
      try { sources = policyWitness(events, answer.policy_sources, { repo, installation, entryReceipt }); } catch (error) { attributionError = error.message; }
      write(path.join(evidence, `${name}.sources.json`), JSON.stringify({ sources: sources ?? [], claimedSources: answer.policy_sources, error: attributionError, answer }, null, 2));
      return { events, answer, sources, attributionError, usage: totals };
    };
  };
  await test(cases.discovery, async () => {
    if (opt['skip-live']) pending('real discovery explicitly skipped; release gate cannot pass');
    const ownership = path.join(root, 'ownership.json');
    if (!fs.existsSync(ownership)) pending('Herdr boundary unavailable');
    const repo = freshProject('project');
    write(path.join(repo, 'greetings.mjs'), "export const greetings = { en: 'Hello' };\n");
    write(path.join(repo, 'test/greetings.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';import {greetings} from '../greetings.mjs';test('English stays',()=>assert.equal(greetings.en,'Hello'));\n");
    git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'Seed overlapping discovery task']);
    const before = git(repo, ['rev-parse', 'main']);
    // Create both real sessions before awaiting either; prompts name tasks and
    // safety boundaries, never lanes, routes, record setup or promotion commands.
    const a = await live(repo, 'discovery-french', 'Add French Bonjour to greetings.mjs, test it, and finish the change for integration.');
    const b = await live(repo, 'discovery-german', 'Add German Hallo to greetings.mjs, test it, and finish the change for integration.');
    const settled = await Promise.allSettled([a(), b()]);
    for (const result of settled) if (result.status === 'rejected') throw result.reason;
    const workers = settled.map((r) => r.value);
    write(path.join(evidence, 'discovery-git.txt'), [git(repo, ['status', '--porcelain']), git(repo, ['worktree', 'list', '--porcelain']), git(repo, ['log', '--all', '--format=%h %s'])].join('\n'));
    const commands = workers.flatMap((w) => w.events.filter((e) => e.item?.type === 'command_execution').map((e) => e.item.command)).join('\n');
    write(path.join(evidence, 'discovery-commands.txt'), commands);
    for (const worker of workers) assert.ok(worker.sources?.length, worker.attributionError);
    assert.match(workers.flatMap((w) => w.sources.map((s) => s.excerpt)).join('\n'), /(?:fast.forward|rebase|promot)/i, 'product policy must teach promotion');
    assert.ok(fs.existsSync(path.join(repo, '.org/events.jsonl')), 'entering agents did not discover/populate a project record');
    const events = read(path.join(repo, '.org/events.jsonl')).split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(events.filter((e) => e.type === 'run.started').length >= 2, 'record must hold each concurrent agent’s run');
    assert.ok(workers.every((w) => w.answer.branch.startsWith('lane/')), 'each real agent must show its own discovered lane');
    assert.notEqual(workers[0].answer.checkout, workers[1].answer.checkout, 'workers need distinct checkouts');
    assert.ok(workers.every((w) => w.answer.checkout !== repo), 'workers must not edit the main checkout');
    assert.match(commands, /(?:lane|client).*check/, 'real agents must request lane validation');
    assert.match(commands, /(?:lane|client).*promote/, 'real agents must request lane promotion');
    assert.equal(git(repo, ['rev-list', '--merges', 'main']), '');
    assert.equal(git(repo, ['status', '--porcelain']), '', 'main checkout must remain clean');
    assert.notEqual(git(repo, ['rev-parse', 'main']), before, 'work must reach main through promotion');
    const greetings = read(path.join(repo, 'greetings.mjs')); assert.match(greetings, /Bonjour/); assert.match(greetings, /Hallo/);
    const verified = verifiers.get(repo).execute(process.execPath, ['--test']);
    write(path.join(evidence, 'discovery-verification.json'), JSON.stringify({ sandbox: 'native acceptance, read-only project/Git, network off', status: verified.status, stdout: verified.stdout, stderr: verified.stderr, temp: verifiers.get(repo).temp }, null, 2));
    return 'two real sessions discovered policy, recorded work, used separate lanes and completed green fast-forwards';
  });
  await test(cases.routingQuestion, async () => {
    if (opt['skip-live']) pending('real discovery explicitly skipped; release gate cannot pass');
    if (!fs.existsSync(path.join(root, 'ownership.json'))) pending('Herdr boundary unavailable');
    const repo = freshProject('project');
    // An ordinary tiny application with a real check, not workflow config.
    // Without a project test the installed parent correctly cannot validate
    // approved routes, making this acceptance fixture impossible to finish.
    write(path.join(repo, 'greetings.mjs'), "export const greetings = { en: 'Hello' };\n");
    write(path.join(repo, 'test/greetings.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';import {greetings} from '../greetings.mjs';test('English stays',()=>assert.equal(greetings.en,'Hello'));\n");
    git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'Seed unrelated routing project with a real test']);
    const finish = await live(repo, 'discovery-routing', 'Prepare how future engineering and independent review sessions should select models and effort. Respect any discovered project policy; when preferences need the operator, leave a durable question with a concrete recommendation for the operator and stop.');
    const worker = await finish();
    assert.ok(worker.sources?.length, worker.attributionError);
    assert.ok(fs.existsSync(path.join(repo, '.org/events.jsonl')), 'agent did not discover the record for its routing question');
    const record = verifiers.get(repo).record;
    const status = JSON.parse(record(['status', '--json']));
    const questions = status.items.filter((i) => i.role === 'human' && !i.closed && !i.meta?.answer);
    assert.equal(questions.length, 1, 'routing decision must wait for human approval');
    const question = questions[0];
    const config = JSON.parse(read(path.join(repo, '.org/config.json')));
    assert.equal(config.approvals.categories[question.meta.category] ?? config.approvals.default, 'ask');
    const context = record(['show', question.id]);
    write(path.join(evidence, 'routing-question.txt'), context);
    assert.match(context, /gpt-6\.1-sol/); assert.match(context, /opus/i);
    record(['answer', question.id, 'yes', '--note', 'Scripted acceptance operator approves the proposed defaults'], { ORG_ACTOR: 'human' });
    const apply = await live(repo, 'discovery-routing-apply', `The operator answered yes to ${question.id}. Continue the recorded work and apply the approved configuration, then validate it.`);
    await apply();
    const routes = JSON.parse(read(path.join(repo, '.lane.json'))).routes;
    assert.equal(routes.engineer.model, 'gpt-6.1-sol'); assert.equal(routes.engineer.effort, 'high'); assert.match(routes.review.model, /opus/i);
    return `${question.id}: category=${question.meta.category}, waited for a human, scripted yes applied by real agent`;
  });
  return usage;
}
