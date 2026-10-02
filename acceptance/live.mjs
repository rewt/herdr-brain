import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import os from 'node:os';
import { permissionArgs, sessionEnv, policyWitness } from './security.mjs';

export async function discovery({ root, discoveryRoots, evidence, candidate, opt, env, test, pending, initRepo, run, node, git, h, until, write, read }) {
  const model = opt['discovery-model'] ?? 'gpt-5.6-luna', effort = opt['discovery-effort'] ?? 'low';
  const usage = [];
  const installation = path.join(root, 'installed-product');
  fs.cpSync(candidate, installation, { recursive: true, filter: (file) => !['AGENTS.md', 'README.md', 'docs', 'test', 'tests', 'kit', 'acceptance', 'node_modules', '.git'].includes(path.basename(file)) });
  const bin = path.join(installation, 'entrypoints'); fs.mkdirSync(bin);
  for (const [name, target] of [['record', 'bin/org.mjs'], ['org', 'bin/org.mjs'], ['lane', 'lanes/lane.mjs']]) {
    if (!fs.existsSync(path.join(installation, target))) continue;
    write(path.join(bin, name), `#!/bin/sh\nexec '${process.execPath}' '${path.join(installation, target)}' "$@"\n`); fs.chmodSync(path.join(bin, name), 0o755);
  }
  write(path.join(evidence, 'discovery-installation.json'), JSON.stringify({ installation, entrypoints: fs.readdirSync(bin), excluded: ['AGENTS.md', 'README.md', 'docs', 'test', 'tests', 'kit', 'acceptance', 'node_modules', '.git'], source: candidate }, null, 2));
  const freshProject = (label) => {
    const parent = fs.realpathSync(fs.mkdtempSync('/private/tmp/herdr-discovery-')); discoveryRoots.push(parent);
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

  const live = async (repo, name, task) => {
    const binary = fs.realpathSync(run('which', ['codex'], { extra: { PATH: process.env.PATH } }).stdout.trim());
    const temp = fs.realpathSync(fs.mkdtempSync('/private/tmp/herdr-session-')); discoveryRoots.push(temp);
    const runtimeHome = path.join(root, 'codex-runtime', name);
    fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
    const auth = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'auth.json');
    if (!fs.existsSync(auth)) pending('file-based Codex authentication unavailable for isolated discovery runtime');
    fs.copyFileSync(auth, path.join(runtimeHome, 'auth.json'));
    fs.chmodSync(path.join(runtimeHome, 'auth.json'), 0o600);
    fs.copyFileSync(path.join(import.meta.dirname, 'live-worker.mjs'), path.join(root, 'live-worker.mjs'));
    const scope = `You are doing a bounded acceptance task in a brand-new project. Work as an entering coding agent normally would, using whatever project policy and installed tools you discover. Another independent session may work here at the same time. Safety boundary: changes only in this project (${repo}) and your temporary directory (${temp}); never push, contact other sessions, or operate Herdr. Do not read other projects or private records. Do not invent operator preferences. In your final JSON, list every policy source actually received or read, including its path or exact installed CLI invocation and a verbatim excerpt of the policy. Leave policy_sources empty if none exists. Name your checkout/branch and durable work/run/question IDs (empty strings when absent), and describe validation/promotion evidence in result. If a required policy or discoverable entry point is absent, state that clearly; do not invent a product policy.\n\nTask: ${task}`;
    const spec = { repo, binary, runtimeHome, model, effort, name, temp, installation, schema,
      toolRoots: [path.dirname(binary), fs.realpathSync(path.join(path.dirname(process.execPath), '..')), '/opt/homebrew', fs.realpathSync(path.join(path.dirname(fs.realpathSync(binary)), '..'))],
      path: `${bin}:${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, prompt: scope };
    // Fail before inference if the native sandbox cannot prove its boundaries.
    const probe = path.join(temp, 'probe.mjs');
    write(path.join(root, 'protected-read-canary'), 'not project policy');
    write(probe, `import fs from 'node:fs';import net from 'node:net';import assert from 'node:assert/strict';
      const blocked=[];for(const [label,fn] of [
        ['parent-list',()=>fs.readdirSync(${JSON.stringify(path.dirname(repo))})],
        ['candidate-policy',()=>fs.readFileSync(${JSON.stringify(path.join(candidate, 'AGENTS.md'))})],
        ['harness-read',()=>fs.readFileSync(${JSON.stringify(path.join(root, 'protected-read-canary'))})],
        ['harness-write',()=>fs.writeFileSync(${JSON.stringify(path.join(root, 'forbidden-write-canary'))},'bad')]
      ]){let denied=false;try{fn()}catch(e){denied=['EPERM','EACCES'].includes(e.code)}assert.ok(denied,label+' must be denied');blocked.push(label)}
      fs.writeFileSync(${JSON.stringify(path.join(temp, 'allowed'))},'temporary');fs.writeFileSync(${JSON.stringify(path.join(repo, 'probe-allowed'))},'project');fs.unlinkSync(${JSON.stringify(path.join(repo, 'probe-allowed'))});
      const socket=net.createConnection(${JSON.stringify(path.join(os.homedir(), '.config/herdr/herdr.sock'))});
      await new Promise((resolve,reject)=>{const t=setTimeout(()=>{socket.destroy();reject(Error('socket probe timed out'))},2000);socket.once('connect',()=>{clearTimeout(t);socket.destroy();reject(Error('direct live Herdr socket allowed'))});socket.once('error',e=>{clearTimeout(t);if(['EPERM','EACCES'].includes(e.code))resolve();else reject(e)})});
      assert.ok(!Object.keys(process.env).some(k=>/^(HERDR|ACCEPTANCE)/.test(k)));console.log(JSON.stringify({blocked:[...blocked,'live-herdr-socket'],writable:[${JSON.stringify(repo)},${JSON.stringify(temp)}]}));`);
    const clean = sessionEnv(process.env, spec);
    const checked = run(binary, ['sandbox', '-C', repo, '-P', 'acceptance', ...permissionArgs(spec), '--', process.execPath, probe],
      { cwd: repo, isolatedEnv: clean, ok: false });
    write(path.join(evidence, `${name}.boundary.json`), JSON.stringify({ status: checked.status, stdout: checked.stdout, stderr: checked.stderr, writableRoots: [repo, temp], environmentKeys: Object.keys(clean) }, null, 2));
    fs.unlinkSync(probe);
    assert.equal(checked.status, 0, `native discovery boundary probe failed: ${checked.stderr || checked.stdout}`);
    write(path.join(root, 'live-jobs', `${name}.json`), JSON.stringify(spec));
    // Machine installation is permitted; project configuration is not. Run
    // the candidate's installer when shipped rather than bypassing its adapter.
    const installer = path.join(installation, 'discovery/install.mjs');
    if (fs.existsSync(installer)) {
      fs.copyFileSync(path.join(import.meta.dirname, 'native-transport.mjs'), path.join(root, 'native-transport.mjs'));
      const native = path.join(root, `native-${name}`), entryBin = path.join(installation, `entry-${name}`);
      write(native, `#!/bin/sh\nexec '${process.execPath}' '${path.join(root, 'native-transport.mjs')}' '${root}' '${name}' "$@"\n`);
      fs.chmodSync(native, 0o755);
      run(process.execPath, [installer, '--bin', entryBin, '--codex', native], { isolatedEnv: clean });
      spec.entryBinary = path.join(entryBin, 'codex');
      spec.path = `${entryBin}:${spec.path}`;
      write(path.join(root, 'live-jobs', `${name}.json`), JSON.stringify(spec));
    }
    write(path.join(evidence, `${name}.prompt.txt`), scope);
    const ws = h('workspace', 'create', '--cwd', repo, '--label', `acceptance-${name}`, '--no-focus');
    h('pane', 'run', ws.root_pane.pane_id, [process.execPath, path.join(root, 'live-worker.mjs'), root, name].map((s) => "'" + s.replaceAll("'", "'\\''") + "'").join(' '));
    return async () => {
      await until(() => fs.existsSync(path.join(root, 'live-jobs', `${name}.done`)), `${name} real session finishes`, 200_000);
      const done = JSON.parse(read(path.join(root, 'live-jobs', `${name}.done`)));
      const events = read(path.join(evidence, `${name}.jsonl`)).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      const turns = events.filter((e) => e.type === 'turn.completed').map((e) => e.usage);
      const totals = turns.reduce((a, u) => { for (const k of Object.keys(u ?? {})) a[k] = (a[k] ?? 0) + u[k]; return a; }, {});
      usage.push({ name, model, effort, ...done, usage: totals, completeTurns: turns.length });
      write(path.join(evidence, 'discovery-usage.json'), JSON.stringify(usage, null, 2));
      assert.equal(done.code, 0, `real session failed: ${read(path.join(evidence, `${name}.stderr`)).slice(-1500)}`);
      assert.ok(turns.length, 'real session must report measured token usage');
      const answer = JSON.parse(read(path.join(evidence, `${name}.txt`)));
      let sources, attributionError;
      const entryFile = path.join(evidence, `${name}.entry.json`);
      const entryReceipt = fs.existsSync(entryFile) ? JSON.parse(read(entryFile)) : undefined;
      try { sources = policyWitness(events, answer.policy_sources, { repo, installation, entryReceipt }); } catch (error) { attributionError = error.message; }
      write(path.join(evidence, `${name}.sources.json`), JSON.stringify({ sources: sources ?? [], claimedSources: answer.policy_sources, error: attributionError, answer }, null, 2));
      return { events, answer, sources, attributionError, usage: totals };
    };
  };
  await test('Real discovery: concurrent lanes and promotion', async () => {
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
    run(process.execPath, ['--test'], { cwd: repo });
    return 'two real sessions discovered policy, recorded work, used separate lanes and completed green fast-forwards';
  });
  await test('Real discovery: routing question waits and answer applies', async () => {
    if (opt['skip-live']) pending('real discovery explicitly skipped; release gate cannot pass');
    if (!fs.existsSync(path.join(root, 'ownership.json'))) pending('Herdr boundary unavailable');
    const repo = freshProject('project');
    const finish = await live(repo, 'discovery-routing', 'Prepare how future engineering and independent review sessions should select models and effort. Respect any discovered project policy; when preferences need the operator, leave a durable question with a concrete recommendation for the operator and stop.');
    const worker = await finish();
    assert.ok(worker.sources?.length, worker.attributionError);
    assert.ok(fs.existsSync(path.join(repo, '.org/events.jsonl')), 'agent did not discover the record for its routing question');
    const status = JSON.parse(node(path.join(candidate, 'bin/org.mjs'), ['status', '--json'], { cwd: repo }).stdout);
    const questions = status.items.filter((i) => i.role === 'human' && !i.closed && !i.meta?.answer);
    assert.equal(questions.length, 1, 'routing decision must wait for human approval');
    const question = questions[0];
    const config = JSON.parse(read(path.join(repo, '.org/config.json')));
    assert.equal(config.approvals.categories[question.meta.category] ?? config.approvals.default, 'ask');
    const context = node(path.join(candidate, 'bin/org.mjs'), ['show', question.id], { cwd: repo }).stdout;
    write(path.join(evidence, 'routing-question.txt'), context);
    assert.match(context, /gpt-6\.1-sol/); assert.match(context, /opus/i);
    node(path.join(candidate, 'bin/org.mjs'), ['answer', question.id, 'yes', '--note', 'Scripted acceptance operator approves the proposed defaults'], { cwd: repo, extra: { ORG_ACTOR: 'human' } });
    const apply = await live(repo, 'discovery-routing-apply', `The operator answered yes to ${question.id}. Continue the recorded work and apply the approved configuration, then validate it.`);
    await apply();
    const routes = JSON.parse(read(path.join(repo, '.lane.json'))).routes;
    assert.equal(routes.engineer.model, 'gpt-6.1-sol'); assert.equal(routes.engineer.effort, 'high'); assert.match(routes.review.model, /opus/i);
    return `${question.id}: category=${question.meta.category}, waited for a human, scripted yes applied by real agent`;
  });
  return usage;
}
