import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import os from 'node:os';

export async function discovery({ root, evidence, candidate, opt, env, test, pending, initRepo, run, node, git, h, until, write, read }) {
  const model = opt['discovery-model'] ?? 'gpt-5.6-luna', effort = opt['discovery-effort'] ?? 'low';
  const usage = [];
  const live = async (repo, name, task) => {
    const binary = run('which', ['codex'], { extra: { PATH: process.env.PATH } }).stdout.trim();
    const runtimeHome = path.join(root, 'codex-runtime', name);
    fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
    const auth = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'auth.json');
    if (!fs.existsSync(auth)) pending('file-based Codex authentication unavailable for isolated discovery runtime');
    fs.copyFileSync(auth, path.join(runtimeHome, 'auth.json'));
    fs.chmodSync(path.join(runtimeHome, 'auth.json'), 0o600);
    fs.copyFileSync(path.join(import.meta.dirname, 'live-worker.mjs'), path.join(root, 'live-worker.mjs'));
    const scope = `You are doing a bounded acceptance task in a brand-new project. Work as an entering coding agent normally would, using whatever project policy and installed tools you discover. Another independent session may work here at the same time. Safety boundary: changes only in ${root}; never push, contact other sessions, or operate Herdr. Do not read other projects or private records. Do not invent operator preferences. In your final answer, name every policy/instruction source you actually read, the checkout/branch where you worked, any durable work/run/question IDs and validation/promotion evidence. If a required policy or discoverable entry point is absent, state that clearly; do not invent a product policy.\n\nTask: ${task}`;
    write(path.join(root, 'live-jobs', `${name}.json`), JSON.stringify({ repo, binary, runtimeHome, model, effort, path: env.PATH, prompt: scope }));
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
      return { events, answer: read(path.join(evidence, `${name}.txt`)), usage: totals };
    };
  };
  await test('Real discovery: concurrent lanes and promotion', async () => {
    if (opt['skip-live']) pending('real discovery explicitly skipped; release gate cannot pass');
    const ownership = path.join(root, 'ownership.json');
    if (!fs.existsSync(ownership)) pending('Herdr boundary unavailable');
    const repo = path.join(root, 'discovery-project'); initRepo(repo);
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
    assert.ok(fs.existsSync(path.join(repo, '.org/events.jsonl')), 'entering agents did not discover/populate a project record');
    const events = read(path.join(repo, '.org/events.jsonl')).split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(events.filter((e) => e.type === 'run.started').length >= 2, 'record must hold each concurrent agent’s run');
    assert.ok(workers.every((w) => /lane\//.test(w.answer)), 'each real agent must show its own discovered lane');
    assert.match(commands, /lane.*(?:check|promote)/, 'real agents must follow lane promotion process');
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
    const repo = path.join(root, 'routing-discovery-project'); initRepo(repo);
    const finish = await live(repo, 'discovery-routing', 'Prepare how future engineering and independent review sessions should select models and effort. Respect any discovered project policy; when preferences need the operator, leave a durable question with a concrete recommendation for the operator and stop.');
    await finish();
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
