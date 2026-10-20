// Child-only probes. The driver supplies a disposable cwd and an isolated HOME.
// Fixture metadata is ours; every tested state/receipt is emitted by ROOT code.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const [phase, root, name, directory] = process.argv.slice(2);
const repo = path.join(directory, 'project'), org = path.join(repo, '.org'), common = path.join(repo, '.git');
const at = '2026-10-19T12:00:00.000Z';
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const load = async file => {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) { console.error(`OLD lacks reader module ${file}`); process.exit(77); }
  return import(pathToFileURL(absolute).href);
};
function run(exe, args, cwd = repo, env = process.env) {
  const result = spawnSync(exe, args, { cwd, env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw Error(`${exe} ${args.join(' ')}: ${result.stderr || result.stdout || result.error?.message}`);
  return result.stdout.trim();
}
const cli = (file, args, cwd = repo) => run(process.execPath, [path.join(root, file), ...args], cwd, { ...process.env, ORG_DIR: org });
const git = (args, cwd = repo) => run('git', args, cwd);
const record = args => cli('bin/org.mjs', args);
const save = (value, files, scope) => fs.writeFileSync(path.join(directory, 'fixture.json'), JSON.stringify({ ...value, files, scope }));
const state = () => json(path.join(directory, 'fixture.json'));
const writeInput = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + '\n');
function initialize() {
  fs.mkdirSync(repo);
  git(['init', '-qb', 'main']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.org/\n.lane/\n');
  writeInput(path.join(repo, '.lane.json'), { prepare: [], routes: { engineer: { kind: 'codex' }, review: { kind: 'codex' } } });
  git(['add', '.']); git(['commit', '-qm', 'compatibility fixture']);
  record(['init']); record(['add', 'Compatibility fixture', '--role', 'engineer']);
}
function enableCloseout() {
  const file = path.join(repo, '.lane.json'), config = json(file);
  writeInput(file, { ...config, retirement: { ...config.retirement, closeout_queue: true } });
  git(['add', '.lane.json']); git(['commit', '-qm', 'Opt fixture into closeout']);
}
async function queue() {
  const writer = await load('promote/promote.mjs'), q = writer.queueFor(repo);
  const jobs = writer.enqueue(q, ['compat-topic'], { laneCLI: path.join(root, 'lanes/lane.mjs'),
    herdr: 'herdr', org, to: 'compat-supervisor', attempts: 1, retry: 0, validate: 'true', laneConfig: null });
  return { writer, q, job: jobs[0] };
}
function report(outcome = 'done') {
  record(['start', 'ENG-1', '--workspace', path.join(directory, 'lane'), '--meta', 'lane=compat-topic']);
  const file = path.join(directory, 'report.md');
  fs.writeFileSync(file, `---\nrun: R-1\noutcome: ${outcome}\nsummary: Compatibility fixture completed.\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
  record(['ingest', file]);
  return file;
}

const probes = {
  events: {
    async write() {
      git(['worktree', 'add', '-qb', 'lane/compat-topic', path.join(directory, 'lane')]);
      report(); record(['note', 'ENG-1', 'Compatibility note']);
      const closeout = await load('lib/closeout.mjs');
      enableCloseout();
      closeout.readyLane({ cwd: repo, org, topic: 'compat-topic', run: 'R-1', start: false });
      (await load('lib/closeout-consumer.mjs')).drainCloseout({ cwd: repo, org });
      const events = (await load('lib/store.mjs')).loadEvents(org).events;
      assert.equal(events.find(e => e.type === 'lane.ready').closeout_targets.length, 1);
      assert.equal(events.find(e => e.type === 'closeout.evaluated').completed, true);
      assert.deepEqual(closeout.readCloseoutEntries(common), []);
      save({}, [path.join(org, 'events.jsonl')], 'item/run/report/note plus real lane.ready source binding and closeout.evaluated completion after request pruning; OLD folds and views, no native session or lane retirement');
    },
    async read() {
      const status = JSON.parse(record(['status', '--json'])); assert.ok(JSON.stringify(status).includes('ENG-1'));
      assert.equal(JSON.parse(record(['show', 'R-1', '--json'])).report.outcome, 'done');
      assert.match(record(['snapshot']), /ENG-1/);
      const brief = cli('supervisor/supervisor.mjs', ['brief', '--repo', repo, '--org', org, '--json']);
      assert.ok(JSON.parse(brief));
      const lanes = JSON.parse(cli('supervisor/retire.mjs', ['status', '--repo', repo, '--org', org, '--json']));
      assert.equal(lanes.schema, 'lanes-status/v1');
      const events = (await load('lib/store.mjs')).loadEvents(org).events;
      assert.equal(events.find(e => e.type === 'lane.ready').closeout_targets.length, 1);
      assert.equal(events.find(e => e.type === 'closeout.evaluated').completed, true);
      console.log('OLD status/show/snapshot, retirement status and supervisor brief read NEW source bindings and pruning receipts without changing the recorded report');
    },
  },
  closeout: {
    async write() {
      const lane = path.join(directory, 'lane');
      git(['worktree', 'add', '-qb', 'lane/compat-topic', lane]);
      record(['start', 'ENG-1', '--workspace', lane]);
      enableCloseout();
      const writer = await load('lib/closeout.mjs');
      writer.readyLane({ cwd: repo, org, topic: 'compat-topic', run: 'R-1', start: false });
      const [entry] = writer.readCloseoutEntries(common);
      assert.ok(entry);
      save({ key: entry.key, head: entry.head }, [path.join(common, 'closeout/entries', `${entry.key}.json`), path.join(org, 'events.jsonl')],
        'real optional-ready publication and source binding; OLD queue reader only, no eligibility/effects, native occupants or ownership-transfer recovery');
    },
    async read() {
      const [entry] = (await load('lib/closeout.mjs')).readCloseoutEntries(common);
      assert.equal(entry.schema, 'closeout-entry/v1'); assert.equal(entry.key, state().key);
      assert.equal(entry.head, state().head); assert.equal(entry.run, 'R-1');
      assert.equal(entry.cwd, path.join(directory, 'lane')); assert.equal(entry.common, common);
      assert.equal(entry.branch, 'lane/compat-topic'); assert.equal(entry.source.type, 'lane.ready');
      assert.deepEqual(entry.panes, []);
      console.log('OLD queue reader accepted the NEW record-bound ready entry; retirement execution is not covered');
    },
  },
  'record-config': {
    async write() { save({}, [path.join(org, 'config.json')], 'record init defaults'); },
    async read() { assert.ok((await load('lib/store.mjs')).readConfig(org).budget); console.log('record config read'); },
  },
  fleet: {
    async write() {
      const joined = (await load('lib/fleet.mjs')).joinFleet({ cwd: repo, record: org, worktrees: path.join(directory, 'lanes'), layers: [], env: process.env });
      save({ project: joined.name }, [joined.file], 'one project joined using NEW joinFleet');
    },
    async read() { assert.equal((await load('lib/fleet.mjs')).readFleet(process.env).projects[state().project].identity, common); console.log('fleet identity read'); },
  },
  summary: {
    async write() {
      const writer = await load('lib/project-summary.mjs'), { fold } = await load('lib/state.mjs');
      const doc = writer.projectSummary({ project: { canonical: repo, identity: common }, state: fold([]), lanes: { counts: {}, rows: [] }, now: at });
      writer.writeProjectSummary(org, doc);
      save({}, [path.join(org, 'published/summary.json')], 'published summary and generation switch');
    },
    async read() {
      const result = (await load('lib/project-summary.mjs')).publishedSummaryStatus(org, { now: at, project: { canonical: repo, identity: common } });
      assert.equal(result.status, 'fresh');
      assert.match((await load('lib/render.mjs')).renderProjectSummary(json(path.join(org, 'published/summary.json'))), /Compatibility|project/iu);
      console.log('fresh project summary rendered');
    },
  },
  release: {
    async write() {
      const home = path.join(directory, 'installation'), bundle = path.join(home, 'releases/compat-release');
      (await load('lib/product-files.mjs')).copyProduct(root, bundle);
      const commit = 'a'.repeat(40), summary = path.join(directory, 'acceptance-summary.json');
      fs.writeFileSync(path.join(bundle, '.release-commit'), commit + '\n');
      // Synthetic fixture input, never a live acceptance run. The real manifest
      // writer retains and binds it; the real pin writer enforces READY admission.
      writeInput(summary, { ready: true, candidateCommit: commit, elapsedSeconds: 1,
        counts: { PASS: 1, FAIL: 0, PENDING: 0, SKIP: 0 } });
      cli('herdr/releases.mjs', ['manifest', bundle, summary]);
      const acceptance = json(path.join(bundle, '.release-manifest.json')).acceptance;
      assert.equal(acceptance.ready, true); assert.equal(acceptance.candidateCommit, commit);
      assert.equal(acceptance.summarySha256, createHash('sha256').update(fs.readFileSync(path.join(bundle, '.release-acceptance.json'))).digest('hex'));
      cli('herdr/releases.mjs', ['pin', home, repo, 'compat-release']);
      git(['add', '.herdr-release.json']); git(['commit', '-qm', 'accept fixture pin']);
      save({ bundle }, [path.join(bundle, '.release-manifest.json'), path.join(bundle, '.release-acceptance.json'), path.join(repo, '.herdr-release.json')],
        'real manifest writer with synthetic READY summary input and real non-null committed canonical pin; no live acceptance or legacy attestation coverage');
    },
    async read() {
      const reader = await load('lib/releases.mjs');
      assert.equal(reader.checkBundle(state().bundle, { verifyFiles: true }).protocol, 1);
      assert.equal(reader.projectPin(repo).release, 'compat-release');
      console.log('OLD manifest verifier and canonical committed pin reader');
    },
  },
  queue: {
    async write() { const { q, job } = await queue(); save({ job: job.id }, [q.file], 'pending queue request with NEW release binding'); },
    async read() {
      const reader = await load('promote/promote.mjs');
      assert.equal(reader.queueJobs(reader.queueFor(repo).load())[0].id, state().job);
      assert.match(cli('promote/promote.mjs', ['--status', '--repo', repo]), /compat-topic/);
      const refs = (await load('lib/retire-runtime.mjs')).readLiveReferences({ common, org });
      assert.equal(refs.errors.length, 0); assert.ok(refs.references.some(r => r.kind === 'pending promote'));
      console.log('OLD queue status and retirement keep-reference reader');
    },
  },
  train: {
    async write() {
      const { writer, q } = await queue();
      // Refuse before executing any native gate, in the disposable project.
      // STOP is an existing admission control, not a native-permission bypass.
      fs.mkdirSync(path.join(repo, '.lane/supervisor'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.lane/supervisor/STOP'), 'compat fixture\n');
      const loadQueue = q.load;
      // Interrupt the caller at its first post-train load, before notice
      // delivery can start an inbox worker. Queue/train bytes are real writes.
      const interruption = new Error('compat fixture stops before delivery');
      q.load = () => {
        if (fs.existsSync(path.join(q.directory, 'batches'))) throw interruption;
        return loadQueue();
      };
      try { await writer.drain(q); } catch (error) { if (error !== interruption) throw error; }
      const batches = path.join(q.directory, 'batches');
      const file = path.join(batches, fs.readdirSync(batches)[0], 'train.json');
      save({}, [file], 'terminal refused train only; integrated checkpoints and completion reconciliation are not exercised');
    },
    async read() {
      const metrics = (await load('promote/metrics.mjs')).collectMetrics({ project: repo, org });
      assert.equal(metrics.warnings.length, 0); assert.equal(metrics.batches.length, 1);
      console.log('OLD train metrics accepted the NEW refused receipt');
    },
  },
  dispatch: {
    async write() {
      // The real dispatcher journals before lane open. Refuse the physical
      // launch seam, leaving a genuine recoverable failed request on disk.
      const absent = path.join(directory, 'no-launch');
      fs.writeFileSync(absent, '#!/bin/sh\necho "fixture stops before lane launch" >&2\nexit 1\n', { mode: 0o755 });
      const brief = path.join(directory, 'ask.md'); fs.writeFileSync(brief, 'Compatibility fixture\n');
      const result = spawnSync(process.execPath, [path.join(root, 'dispatch/dispatch.mjs'), 'ENG-1', '--repo', repo, '--org', org,
        '--lane', 'compat-topic', '--route', 'engineer', '--brief', brief, '--lane-cli', absent, '--to', 'compat-supervisor'],
      { cwd: repo, env: process.env, encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, 1, result.stderr);
      const dir = path.join(org, 'dispatch'), file = fs.readdirSync(dir).find(f => f.endsWith('.json') && !f.endsWith('.routes.json'));
      assert.ok(file, result.stderr);
      save({ journal: path.join(dir, file) }, [path.join(dir, file)], 'failed open-stage request; no worker, watcher or model launched');
    },
    async read() {
      const doc = JSON.parse(cli('dispatch/dispatch.mjs', ['--status', state().journal, '--repo', repo, '--org', org]));
      assert.equal(doc.item, 'ENG-1'); assert.equal(doc.stage, 'open'); assert.ok(doc.release.root);
      console.log('OLD dispatch --status; retry/ownership handoff is outside this probe');
    },
  },
  settle: {
    async write() {
      git(['worktree', 'add', '-qb', 'lane/compat-topic', path.join(directory, 'lane')]); report('blocked');
      // A real blocked outcome finishes without creating a reviewer or running
      // a gate. The journal still contains the real report/release bindings.
      const result = spawnSync(process.execPath, [path.join(root, 'settle/settle.mjs'), 'R-1', '--repo', repo, '--org', org],
        { cwd: repo, env: process.env, encoding: 'utf8', timeout: 30000 });
      const file = path.join(org, 'settle/R-1.json'); assert.ok(fs.existsSync(file), result.stderr + result.stdout);
      save({}, [file], 'blocked settlement with report and release evidence; no review dispatch');
    },
    async read() { const doc = JSON.parse(cli('settle/settle.mjs', ['R-1', '--status', '--repo', repo, '--org', org])); assert.equal(doc.run, 'R-1'); assert.ok(doc.reportHash); console.log('OLD settle --status; retry is outside this probe'); },
  },
  timing: {
    async write() {
      const journal = path.join(directory, 'dispatch.json');
      (await load('lib/run-timing.mjs')).appendTiming(journal, { at, item: 'ENG-1', run: 'R-1', lane: 'compat-topic', kind: 'process_end', outcome: 'done' });
      save({ journal }, [journal + '.events.jsonl'], 'allowlisted process-end event');
    },
    async read() { assert.equal((await load('lib/run-timing.mjs')).readTiming(state().journal)[0].outcome, 'done'); console.log('run timing read'); },
  },
  validation: {
    async write() {
      const gate = (await load('lanes/validation.mjs')).validateTree({ cwd: repo, common, command: 'printf compatibility-validation', tier: 'fast' });
      assert.equal(gate.exit_code, 0);
      save({ key: gate.key }, [path.join(common, 'lane-validation', gate.key + '.json')], 'fast scratch command; OLD must reuse exact evidence without executing');
    },
    async read() {
      const gate = (await load('lanes/validation.mjs')).validateTree({ cwd: repo, common, command: 'printf compatibility-validation', tier: 'fast',
        onStart: () => { throw Error('OLD did not recognize NEW receipt; refusing to execute another gate'); } });
      assert.equal(gate.reused, true); assert.equal(gate.key, state().key); console.log('OLD reused NEW validation receipt');
    },
  },
  retirement: {
    async write() {
      const writer = await load('lib/retire-trigger.mjs');
      writer.requestRetirement({ org, source: 'compat fixture', eventSeq: 1 });
      writer.consumeRetirement({ org, retirement: () => ({ plan: () => ({ close: [], keep: [], diagnostics: [] }), apply: () => [] }) });
      save({}, [path.join(org, 'retirement/request.json'), path.join(org, 'retirement/handled.json')], 'coalesced request and acknowledged empty observation; no native effects');
    },
    async read() {
      const result = (await load('lib/retire-trigger.mjs')).consumeRetirement({ org,
        retirement: () => { throw Error('OLD tried to replay an acknowledged retirement observation'); } });
      assert.equal(result.handled, false); assert.equal(result.revision, 1); console.log('OLD preserved handled revision without replay');
    },
  },
  'lane-open': {
    async write() { (await load('lib/initial-shell.mjs')).recordLaneOpen(common, repo, git(['rev-parse', 'HEAD'])); save({}, fs.readdirSync(path.join(common, 'retirement/lane-opens')).map(f => path.join(common, 'retirement/lane-opens', f)), 'lane opening provenance'); },
    async read() { assert.equal((await load('lib/initial-shell.mjs')).initialShellHistory(common, repo, git(['rev-parse', 'HEAD']), 'main', git), 'fresh'); console.log('lane opening provenance read'); },
  },
  housekeeping: {
    async write() {
      const stateDir = path.join(directory, 'housekeeping-preview'), capture = path.join(directory, 'owner.json');
      const stub = path.join(directory, 'capture-herdr');
      fs.writeFileSync(stub, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.copyFileSync(${JSON.stringify(path.join(stateDir, 'lock/owner.json'))},${JSON.stringify(capture)});\nconsole.log(JSON.stringify({result:{workspaces:[],tabs:[],panes:[],agents:[]}}));\n`, { mode: 0o755 });
      // .mjs is required for the ESM physical seam on Node 20.
      fs.renameSync(stub, stub + '.mjs');
      cli('housekeeping/housekeeping.mjs', ['--once', '--dry-run', '--cwd', repo, '--org', org, '--state-dir', stateDir, '--herdr', stub + '.mjs']);
      assert.ok(fs.existsSync(capture));
      const key = createHash('sha256').update(common).digest('hex');
      const target = path.join(org, 'housekeeping', key, 'lock'); fs.mkdirSync(target, { recursive: true });
      fs.copyFileSync(capture, path.join(target, 'owner.json'));
      save({}, [capture], 'owner captured during NEW --once --dry-run; no schedule starts');
    },
    async read() {
      const snapshot = (await load('housekeeping/command.mjs')).housekeepingSnapshot({ cwd: repo, org });
      assert.equal(snapshot.warnings.length, 0); assert.equal(snapshot.process, 'stale lock'); assert.ok(snapshot.pid);
      console.log('OLD recognized stopped NEW housekeeping owner');
    },
  },
  'housekeeping-config': {
    async write() { (await load('housekeeping/command.mjs')).setHousekeeping({ enabled: false }, { cwd: repo, org }); save({}, [path.join(repo, '.housekeeping.json')], 'configuration written by NEW setHousekeeping'); },
    async read() { assert.equal((await load('housekeeping/command.mjs')).housekeepingSnapshot({ cwd: repo, org }).config.enabled, false); console.log('housekeeping config read'); },
  },
  log: {
    async write() {
      const scope = { identity: 'compat-fixture', commonDir: common, root: path.join(directory, 'logs') };
      const journal = new (await load('logs/journal.mjs')).LogJournal({ ...scope, clock: () => at });
      const event = (await load('logs/inputs.mjs')).sourceGap({ source: 'compat', reason: 'offline fixture' }, scope, at);
      await journal.appendRaw(event);
      const data = await journal.read();
      save({ logScope: scope, event: event.eventId }, data.segments.map(s => path.join(journal.directory, s.name)), 'source-gap event through NEW journal append');
    },
    async read() { const data = await new (await load('logs/journal.mjs')).LogJournal(state().logScope).read(); assert.equal(data.entries[0].eventId, state().event); console.log('OLD journal read'); },
  },
  occupancy: {
    async write() {
      const lock = path.join(directory, 'slot.lock'), writer = await load('test-slot/occupancy.mjs');
      const owner = writer.sharedOccupancy(lock, 'compat fixture', { reason: 'offline compatibility' });
      // Retain the emitted bytes for a reader subprocess after the writer exits.
      const capture = path.join(directory, 'occupancy.json'); fs.copyFileSync(owner.occupancyPath, capture);
      save({ lock, original: owner.occupancyPath }, [capture], 'shared presence; reader must preserve uncertain ownership');
    },
    async read() {
      const doc = json(state().files[0]);
      fs.copyFileSync(state().files[0], state().original);
      const rows = (await load('test-slot/occupancy.mjs')).readTestSlotOccupancy(state().lock,
        { kill: () => {}, startRecord: () => ({ start: doc.processStart, birth: doc.processBirth }) });
      assert.equal(rows.length, 1); assert.equal(rows[0].state, 'live'); console.log('OLD occupancy conservatively keeps observed owner');
    },
  },
  digest: {
    async write() {
      const stateDir = path.join(directory, 'brain'), writer = await load('brain/lib/signals.mjs');
      const pending = writer.recordDigest({ orgDir: org, stateDir });
      writer.recordDigest({ orgDir: org, stateDir, ack: pending.pass });
      const subdir = path.join(stateDir, 'distill', createHash('sha256').update(org).digest('hex'));
      save({ stateDir, pass: pending.pass }, ['pending.json', 'cursor.json'].map(f => path.join(subdir, f)), 'digest pass and acknowledged cursor');
    },
    async read() { const next = (await load('brain/lib/signals.mjs')).recordDigest({ orgDir: org, stateDir: state().stateDir }); assert.equal(next.from.seq, 1); console.log('OLD reads acknowledged distillation cursor'); },
  },
  'standard-slots': {
    async write() {
      (await load('sessions/receipts.mjs')).recordStandardSlot({ cwd: repo, action: 'adopt', uid: 'compat-slot', actor: 'fixture', why: 'offline fixture',
        slot: { server: 'compat', workspace: 'compat-w', checkout: repo, tab: 'compat-t', standardSlot: 'chat', panes: [{ pane: 'compat-p', paneSlot: 'primary' }] } });
      save({}, [path.join(common, 'sessions/standard-slots.json')], 'KEEP-only slot enrollment using synthetic native identity');
    },
    async read() { const data = (await load('sessions/receipts.mjs')).readStandardSlots(common); assert.deepEqual(data.errors, []); assert.equal(data.slots[0].uid, 'compat-slot'); console.log('OLD standard-slot KEEP history'); },
  },
  history: {
    async write() {
      const file = path.join(directory, 'history/gate.json');
      (await load('test-slot/limits.mjs')).recordHealthyGate({ common, tier: 'fast', command: 'true', duration_s: 1, longest_silence_s: 0, file });
      save({ file }, [file], 'healthy gate history entry');
    },
    async read() { assert.equal((await load('test-slot/limits.mjs')).healthyHistory(common, 'fast', 'true', state().file).length, 1); console.log('OLD gate watchdog history'); },
  },
  'lane-evidence': {
    async write() {
      const lane = path.join(directory, 'evidence-source');
      git(['worktree', 'add', '--detach', lane]);
      fs.writeFileSync(path.join(lane, 'untracked-evidence.txt'), 'preserve this fixture evidence\n');
      const archive = (await load('lib/lane-removal.mjs')).preserveLaneEvidence({ common, lane, topic: 'compat-topic', tip: git(['rev-parse', 'HEAD']), tracked: new Set(git(['ls-files']).split('\n')) });
      archive.verify();
      save({}, [archive.manifest], 'NEW real archive writer and its own verification; OLD standalone verification is unavailable');
    },
    async read() { console.error('OLD archive verification is a writing-invocation closure, with no standalone reader; archive bytes produced but old-reader compatibility not covered'); process.exitCode = 77; },
  },
  transport: {
    async write() {
      fs.writeFileSync(path.join(directory, 'FIXTURE'), 'brain.transport-fixture/v1\n', { mode: 0o600 });
      const writer = await load('messages/receiver.mjs');
      const sender = { identity: 'compat-fixture', projectRef: common, role: { name: 'supervisor', bindingRef: 'launch' } };
      const address = { identity: 'compat-fixture', projectRef: common, session: { uid: 'worker', incarnation: 'one' } };
      const recipient = writer.addressKey(address), receiver = new writer.Receiver({ root: directory });
      await receiver.initialize({ supervisor: sender, recipients: [{ address: sender, consumer: 'sender' }, { address, consumer: 'worker' }],
        senders: [{ receipt: 'launch', producer: 'sender', epoch: 'one', address: sender, recipients: [recipient], bodyRoots: [directory] }] });
      const event = { schema: 'brain.log/v1', eventId: 'compat-message', producer: { id: 'sender', epoch: 'one', sequence: 1 }, occurredAt: at,
        type: 'session.message.v1', level: 'info', identity: 'compat-fixture', project: { commonDir: common }, payload: { from: sender, to: [address],
          kind: 'request', refs: [], reply_to: null, priority: 'normal', reply_by: null, summary: 'Compatibility fixture', body_ref: null, decision_ref: null } };
      await receiver.accept(event, { sender: 'launch', recipient });
      const session = { root: directory, recipient, consumer: 'worker', cwd: directory, kind: 'claude', rendering: 'plain' };
      const output = JSON.parse(await (await load('messages/hook-pull.mjs')).hookOutput({ session_id: 'native-fixture', cwd: directory, hook_event_name: 'Stop' }, session));
      assert.equal(output.decision, 'block');
      save({ session }, [path.join(directory, 'transport.jsonl')], 'fixture receiver enrollment, acceptance and hook claim; no harness launched');
    },
    async read() {
      const receiver = new (await load('messages/receiver.mjs')).Receiver({ root: directory });
      const entries = receiver.state().entries;
      assert.equal(entries.length, 1); assert.equal(entries[0].receipts.at(-1).transport, 'hook-pull/v1');
      assert.deepEqual((await load('messages/hook-pull.mjs')).hookHandoff(state().session).claimedIds, ['compat-message']);
      console.log('OLD receiver fold and hook handoff read NEW claim without replay');
    },
  },
  'initial-shell': {
    async write() {
      const writer = await load('lib/initial-shell.mjs');
      const created = { type: 'worktree_created', workspace: { workspace_id: 'compat-w' }, tab: { tab_id: 'compat-t', workspace_id: 'compat-w' },
        root_pane: { pane_id: 'compat-p', workspace_id: 'compat-w', tab_id: 'compat-t', terminal_id: 'compat-terminal' } };
      const pane = { pane_id: 'compat-p', workspace_id: 'compat-w', tab_id: 'compat-t', terminal_id: 'compat-terminal', foreground_cwd: repo };
      const process_info = { shell_pid: 1, foreground_processes: [{ pid: 1 }], process_tree_complete: true,
        process_tree: [{ pid: 1, identity: 'synthetic-shell', command: '[zsh]' }] };
      assert.ok(writer.recordInitialShell({ common, cwd: repo, created, h: args => args[1] === 'get' ? { pane } : { process_info } }));
      save({}, [writer.initialShellFile(common, 'compat-t')], 'real receipt from synthetic creation/terminal/shell observations; no native creation');
    },
    async read() { assert.equal((await load('lib/initial-shell.mjs')).validInitialShell(json(state().files[0])), true); console.log('OLD initial-shell receipt validator'); },
  },
  'session-registry': {
    async write() {
      const writer = await load('lanes/board/registry.mjs'), file = writer.registryPathFor(repo);
      const id = writer.newSessionId();
      const receipt = writer.writeSessionRecord(file, { session_id: id, repo_id: common, root_id: common, repo, topic: 'compat-topic', name: 'compat-worker',
        workspace: 'compat-w', pane: 'compat-p', server: 'compat-server', lane: 'compat-topic', role: 'engineer', goal: 'fixture',
        report: path.join(directory, 'report.md'), created_at: at, deadline: null, done: false, brief: null });
      const done = writer.markSessionDone(file, id, { repoRoot: repo });
      save({ id }, [receipt, done], 'display-only session record and done sidecar; no native session launched');
    },
    async read() { const data = (await load('lanes/board/registry.mjs')).loadRegistry(repo); assert.deepEqual(data.errors, []); assert.equal(data.sessions[0].session_id, state().id); assert.equal(data.sessions[0].done, true); console.log('OLD session display metadata and done sidecar'); },
  },
};

try {
  if (!probes[name]) throw Error(`unknown compatibility probe ${name}`);
  if (phase === 'write') initialize();
  else if (phase !== 'read') throw Error('expected write or read');
  await probes[name][phase]();
} catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
