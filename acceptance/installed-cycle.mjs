// Runs as a separate, scratch-only process. Imports only the installed payload.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const config = JSON.parse(fs.readFileSync(process.argv[2]));
const { root, bundle, repo, org, home, commit, mode, forbidden } = config;
const evidence = path.join(root, 'evidence');
const write = (name, value) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2) + '\n');
const stages = [];
let previousStage=performance.now(),previousAt=new Date().toISOString();
const stage = (name, detail) => { const end=performance.now(),at=new Date().toISOString();
  stages.push({name,started_at:previousAt,at,duration_ms:end-previousStage,...detail});previousStage=end;previousAt=at;write('stages.json', stages); };
const module = relative => import(pathToFileURL(path.join(bundle, relative)).href);
// Positive kernel probes: neither in-process nor child fallback can read the
// development checkout or real user configuration. These precede product calls.
for (const file of forbidden) {
  assert.throws(() => fs.readFileSync(file), error => ['EPERM', 'EACCES'].includes(error.code), file);
  const child = spawnSync(process.execPath, ['-e', 'require("fs").readFileSync(process.argv[1])', file], { encoding: 'utf8' });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /EPERM|EACCES/);
}
const childEnvironment = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify({fleet:process.env.HERDR_MONITOR_FLEET,preload:process.env.NODE_OPTIONS,userHome:require("os").userInfo().homedir}))'], { encoding: 'utf8' });
assert.equal(childEnvironment.status, 0, childEnvironment.stderr);
const childHomes = JSON.parse(childEnvironment.stdout);
assert.equal(childHomes.fleet, process.env.HERDR_MONITOR_FLEET);
assert.equal(childHomes.userHome, process.env.HOME);
assert.match(childHomes.preload, /installed-observations\.mjs/);
assert.equal(fs.existsSync(config.development), false);
const { fleetPath } = await module('lib/fleet.mjs');
assert.ok(fleetPath().startsWith(root + path.sep));
stage('isolation', { forbidden, development: config.development, fleet: fleetPath(), childFleet: process.env.HERDR_MONITOR_FLEET, node: process.version });
if(mode==='canary') {
  const {productFiles,payloadEntry}=await module('lib/product-files.mjs');
  const files=Object.fromEntries(productFiles(bundle).sort().map(file=>[file,payloadEntry(bundle,file)]));
  assert.deepEqual(files,config.candidate.files);
  assert.equal(createHash('sha256').update(JSON.stringify(files)).digest('hex'),config.candidate.inventorySha256);
  const manifest=JSON.parse(fs.readFileSync(path.join(bundle,'.release-manifest.json')));
  assert.equal(manifest.commit,config.candidate.commit);
  write('candidate-equivalence.json',{original:config.candidate,fixtureManifest:manifest,identicalRuntime:true,fixtureOnly:true,ready:false});
  stage('S0',{tuple:config.candidate,identicalRuntime:true,fixtureOnly:true,wrongCommitRefused:true,wrongManifestRefused:true,driftRefused:true});
}
const env = { ...process.env, ORG_DIR: org, ORG_ACTOR: 'line-service' };
const run = (exe, args, options = {}) => {
  const result = spawnSync(exe, args, { cwd: repo, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  fs.appendFileSync(path.join(evidence, 'commands.jsonl'), JSON.stringify({ exe, args, cwd: options.cwd ?? repo, status: result.status,
    stdout: result.stdout, stderr: result.stderr, error: result.error?.message }) + '\n');
  return result;
};
const checked = (exe, args, options) => { const r = run(exe, args, options); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout.trim(); };
const git = (args, cwd = repo) => checked('git', ['-C', cwd, ...args]);
const record = args => checked(process.execPath, [path.join(bundle, 'bin/org.mjs'), ...args]);
const { initOrg, loadRecord, transact } = await module('lib/store.mjs');
let { createLineService, serviceDirectory } = await module('line-service/line-service.mjs');
const {readPassJournal} = await module('line-service/pass-journal.mjs');
const { gitProject } = await module('lib/project.mjs');
const { ownerAlive } = await module('lib/process-owner.mjs');
const project = gitProject(repo);
initOrg(org);
const base = git(['rev-parse', 'HEAD']);
const directory = serviceDirectory(org, project.identity);
fs.mkdirSync(directory, { recursive: true });
// An offline service binding, not a launchd installation or release attestation.
const initialSource=['current','canary'].includes(mode)?config.development:bundle;
fs.writeFileSync(path.join(directory, 'installation.json'), JSON.stringify({ at: '2026-10-30T00:00:00Z', repo, org, source: initialSource, node: process.execPath,
  phase:'installed',file: path.join(directory, 'service.plist'), target: `gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}` })+'\n');
const boundary = { id: 'installed-scenario', project: project.identity, repo, org, source: initialSource, main: 'main', canonical_head: base };
transact(org, () => ({ add: ['line-service.cutover', 'line-service.phase0'].map(type => ({ type, ...boundary })) }));
let controls,controlOptions,loaded=false;
if(mode==='current'||mode==='canary') {
  const agent={name:'scratch-supervisor',cwd:repo,pane_id:'control-pane',workspace_id:'control-workspace',terminal_id:'control-terminal',agent_session:{value:'control-session'}};
  const command=(exe,args,options)=>{
    if(exe==='/usr/bin/plutil')return run(exe,args,options);
    assert.equal(exe,'/bin/launchctl');
    let result;
    if(args[0]==='print')result=loaded?{status:0,stdout:'scripted loaded job'}:{status:113,stderr:'Could not find service in domain'};
    else if(args[0]==='bootstrap'){loaded=true;result={status:0,stdout:''};}
    else if(args[0]==='bootout'){loaded=false;result={status:0,stdout:''};}
    else throw Error('unexpected launchctl effect');
    fs.appendFileSync(path.join(evidence,'scripted-controls.jsonl'),JSON.stringify({args,result})+'\n');return result;
  };
  controlOptions={cwd:repo,home,env:{...env,HERDR_ENV:'1',HERDR_PANE_ID:agent.pane_id,HERDR_WORKSPACE_ID:agent.workspace_id,CODEX_THREAD_ID:agent.agent_session.value},
    call:()=>JSON.stringify({result:{agent}}),command};
  const {main,launchPlist}=await module('line-service/launchd.mjs');controls=main;
  fs.writeFileSync(path.join(directory,'service.plist'),launchPlist({label:`dev.herdr.line.${path.basename(directory)}`,repo,org,to:agent.name,
    herdr:path.join(root,'bin/herdr'),socket:path.join(root,'absent.sock'),directory,node:process.execPath,source:initialSource,searchPath:env.PATH}));
  fs.writeFileSync(path.join(directory,'STOP'),'Scratch maintenance\n');
  const args=['migrate','--repo',repo,'--org',org,'--id','scratch-migration'];
  const plan=controls([...args,'--dry-run'],controlOptions);
  controls([...args,'--expected-plan',plan.archive.sha256],controlOptions);
  controls(['restart','--repo',repo,'--org',org],controlOptions);
  stage('initial-migration',{plan,installation:JSON.parse(fs.readFileSync(path.join(directory,'installation.json')))});
}
const state = () => loadRecord(org).state;
const item = record(['add', 'Complete the installed scratch cycle', '--role', 'engineer']).match(/ENG-\d+/)[0];
let successorItem;
if(mode==='canary'&&!config.sharedOnly) {
  successorItem=record(['add','Complete the ordinary successor','--role','engineer']).match(/ENG-\d+/)[0];
  record(['block',successorItem,'--by',item]);
}
if(config.sharedOnly)record(['set',item,'meta.queue_selected=false']);
const journals = () => (fs.existsSync(path.join(org,'dispatch'))?fs.readdirSync(path.join(org, 'dispatch')):[]).filter(n => n.endsWith('.json') && !n.endsWith('.routes.json'))
  .map(n => ({ file: path.join(org, 'dispatch', n), ...JSON.parse(fs.readFileSync(path.join(org, 'dispatch', n))) }));
// Join dispatch in the original call so each stage is observed before moving
// on. All other product commands execute unchanged; native/model IO is scripted.
const command = (exe, args, options) => run(exe, args[0]?.endsWith('/dispatch/dispatch.mjs')
  ? [...args.filter(a => a !== '--detach'), '--watch-cli', path.join(root, args[0].startsWith(config.successor??'\0')?'bin/watch-successor':'bin/watch')] : args, options);
const service = maxStarts => createLineService({ repo, org, to: 'scratch-supervisor', runtimeHome: home,
  env: { ...env, HERDR_BRAIN_ROOT: config.development }, maxStarts, haltAfter: 100, command });
if(mode==='canary'&&!config.sharedOnly) {
  for(const file of [path.join(directory,'STOP'),path.join(repo,'.lane/supervisor/STOP'),path.join(repo,'.lane/supervisor/HOLD')]) {
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'Fixture-owned selection hold\n');
    assert.match(service(1).pass().held,/STOP\/HOLD/);
    assert.equal(state().runs.size,0);fs.unlinkSync(file);
  }
  stage('S4-selection',{guards:['service STOP','project STOP','project HOLD'],runs:0});
}
service(config.sharedOnly?0:1).pass();
const auditRows = () => readPassJournal(path.join(directory,'passes.jsonl'));
const audit = () => {let tail='';for(const row of auditRows())tail=(tail+JSON.stringify(row)+'\n').slice(-65536);return tail;};
if (mode === 'broken') {
  assert.match(audit(), /HERDR_BRAIN_ROOT|source root|source override|EPERM|EACCES/);
  assert.equal(state().items.get(item).runs.length, 0);
  stage('historical-dispatch', { commit, expected: 'source override refused before run creation', runs: 0, audit: audit() });
  process.exit(0);
}
const producer = journals().find(j => j.item === item);
if(!config.sharedOnly) {
  assert.ok(producer, audit()); assert.equal(producer.stage, 'complete', JSON.stringify(producer));
  assert.equal(producer.release.root, bundle); assert.equal(producer.release.commit, commit);
  assert.equal(producer.sourceSelection, null);
  stage('dispatch', { item, run: producer.run, attempt: producer.token, bundle, workspace: producer.worker.cwd, journal: producer.file });
}
const until = async (predicate, label) => {
  const deadline = Date.now() + 120_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, label + '\n' + audit()); await new Promise(resolve => setTimeout(resolve, 100)); }
};
const idle = job => {
  const file = path.join(root, 'native.json'), native = JSON.parse(fs.readFileSync(file));
  native.workspaces[job.worker.workspaceId].agent.agent_status = 'idle'; fs.writeFileSync(file, JSON.stringify(native));
};
const report = (job, artifacts, extra = '', proposals = []) => {
  const r = state().runs.get(job.run), file = r.report_path;
  // Use the record's supported JSON front matter for nested proposal payloads.
  // Its small YAML subset does not parse inline JSON object arrays as YAML.
  const data={run:job.run,outcome:'done',summary:'Scripted installed work completed.',headline:'The scratch work completed',
    blockers:[],proposals,learnings:[],artifacts,...(extra?{verdict:extra.match(/^verdict: (\w+)\n$/)[1]}:{})};
  fs.writeFileSync(file, `---\n${JSON.stringify(data)}\n---\n`);
  record(['check', file]); idle(job); return file;
};
if(mode==='canary') {
  const {runCanary}=await import('./installed-canary.mjs');
  await runCanary({config,write,stage,module,env,run,checked,git,record,state,journals,service,audit,auditRows,
    project,directory,producer,item,successorItem,base,until,idle,report,controls,controlOptions,ownerAlive});
  process.exit(0);
}
if (mode === 'fixed') {
  // The historical witness stops at real installed dispatch; it must not be
  // described as current lifecycle coverage.
  record(['abandon', producer.run, '--note', 'Historical dispatch witness complete']);
  await until(() => !ownerAlive(producer.watcher), 'historical watcher');
  stage('historical-dispatch', { commit, expected: 'installed dispatch created', runs: 1 });
  process.exit(0);
}
const lane = producer.worker.cwd;
fs.writeFileSync(path.join(lane, 'answer.txt'), 'Installed consumer change\n');
git(['add', 'answer.txt'], lane); git(['commit', '-qm', 'Scripted installed change'], lane);
const head = git(['rev-parse', 'HEAD'], lane);
const workerEnv = { ...env, HERDR_ENV: '1', HERDR_PANE_ID: producer.worker.pane, HERDR_WORKSPACE_ID: producer.worker.workspaceId,
  HERDR_TAB_ID: producer.worker.tabId, CODEX_THREAD_ID: producer.worker.agentSessionId, ORG_ACTOR: producer.worker.agentName };
checked(process.execPath, [path.join(bundle, 'lanes/lane.mjs'), 'promote', producer.lane, '--expected-head-from-worktree'], { cwd: lane, env: workerEnv });
assert.equal(git(['rev-parse', 'main']), head);
stage('land', { base, head });
// The producer is still working and its watcher/callback is live. Exercise the
// existing maintenance path before publishing that producer's report.
const captured=()=>Object.fromEntries(fs.readdirSync(path.join(org,'dispatch')).filter(name=>name.endsWith('.json')).sort().map(name=>{
  const bytes=fs.readFileSync(path.join(org,'dispatch',name));
  return [name,createHash('sha256').update(bytes).digest('hex')];
}));
const jobsBefore=captured();
assert.equal(ownerAlive(producer.watcher),true);
const originalInstallation=fs.readFileSync(path.join(directory,'installation.json'),'utf8');
const originalPlist=fs.readFileSync(path.join(directory,'service.plist'),'utf8');
const {main:nextControls}=await import(pathToFileURL(path.join(config.successor,'line-service/launchd.mjs')).href);
controls(['stop','--repo',repo,'--org',org],controlOptions);
checked(process.execPath,[path.join(bundle,'herdr/releases.mjs'),'pin',home,repo,'successor']);
git(['add','.herdr-release.json']);git(['commit','-qm','Select scratch successor']);
const forward=['upgrade','--repo',repo,'--org',org,'--id','scratch-forward','--from-root',bundle,'--target-root',config.successor];
const forwardPlan=nextControls([...forward,'--dry-run'],controlOptions);
const forwardReceipt=nextControls([...forward,'--expected-plan',forwardPlan.archive.sha256],controlOptions);
nextControls(['restart','--repo',repo,'--org',org],controlOptions);
({createLineService}=await import(pathToFileURL(path.join(config.successor,'line-service/line-service.mjs')).href));
const advance=git(['rev-parse','HEAD']);
fs.appendFileSync(path.join(repo,'seed.txt'),'Main moved while the installed controller stayed pinned\n');
git(['add','seed.txt']);git(['commit','-qm','Move scratch development main']);
assert.notEqual(git(['rev-parse','HEAD']),advance);
record(['amend-accept',item,'--accept','Current acceptance survives both installed roots','--why','Scratch newer record event']);
// Native landing evidence has already queued the producer's one original
// review. The successor's next start is that review: it is the successor-root
// child, started before the producer report. The scratch pin and main commits
// also queue canonical reviews; the fixture takes whatever the line selects.
const dispatchedBefore=new Set(journals().map(job=>job.file));
service(1).pass();
const started=journals().filter(job=>!dispatchedBefore.has(job.file));
assert.equal(started.length,1,audit());
const forwardJob=started[0],review=state().items.get(forwardJob.item);
assert.equal(review.meta.review_source_run,producer.run,JSON.stringify(review.meta));
assert.equal(forwardJob.stage,'complete');assert.equal(forwardJob.release.root,config.successor);
const jobsForward=captured();
for(const [name,digest] of Object.entries(jobsBefore))assert.equal(jobsForward[name],digest);
assert.equal(ownerAlive(producer.watcher),true);
const selected=checked(process.execPath,[path.join(config.successor,'herdr/releases.mjs'),'exec',home,'bin/org.mjs','show',item,'--json']);
assert.deepEqual(JSON.parse(selected).accept,['Current acceptance survives both installed roots']);
assert.ok((()=>{for(const event of auditRows())if(event.action==='pass-start'&&path.resolve(event.source)===config.successor&&event.source_head===commit)return true;return false;})());
assert.ok(fs.readFileSync(path.join(evidence,'executables.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse)
  .some(entry=>entry.entry===path.join(config.successor,'bin/org.mjs')&&entry.node===process.execPath));
stage('forward-and-main-movement',{forwardPlan,forwardReceipt,main:git(['rev-parse','HEAD']),jobs:jobsForward,watcher:producer.watcher,newChild:forwardJob,producerFolderPresent:fs.existsSync(lane),
  installation:JSON.parse(fs.readFileSync(path.join(directory,'installation.json')))});
nextControls(['stop','--repo',repo,'--org',org],controlOptions);
checked(process.execPath,[path.join(config.successor,'herdr/releases.mjs'),'pin',home,repo,'scenario']);
git(['add','.herdr-release.json']);git(['commit','-qm','Select previous scratch root']);
const rollback=['upgrade','--repo',repo,'--org',org,'--id','scratch-rollback','--from-root',config.successor,'--target-root',bundle,'--rollback'];
const rollbackPlan=nextControls([...rollback,'--dry-run'],controlOptions);
const rollbackReceipt=nextControls([...rollback,'--expected-plan',rollbackPlan.archive.sha256],controlOptions);
assert.equal(fs.readFileSync(path.join(directory,'installation.json'),'utf8'),originalInstallation);
assert.equal(fs.readFileSync(path.join(directory,'service.plist'),'utf8'),originalPlist);
controls(['restart','--repo',repo,'--org',org],controlOptions);
({createLineService}=await module('line-service/line-service.mjs'));
assert.deepEqual(captured(),jobsForward);assert.equal(ownerAlive(producer.watcher),true);assert.equal(ownerAlive(forwardJob.watcher),true);
assert.equal(producer.release.root,bundle);
stage('rollback-with-captured-work',{rollbackPlan,rollbackReceipt,jobs:captured(),watcherAlive:true,originalInstallationRestored:true,originalPlistRestored:true});
// Both captured children finish under the restored previous root: the producer
// first, then its successor-root review. Ingestion must not queue a second review.
report(producer, [`source: ${head}; base: ${base}`]);
// Real watcher publishes availability; the finite line ingests and retires.
await until(() => state().runs.get(producer.run).report || loadRecord(org).events.some(e => e.type === 'report.available' && e.run === producer.run), 'producer availability');
service(0).pass();
await until(() => !fs.existsSync(lane), 'producer folder removal');
stage('producer-cleanup', { folderRemoved: !fs.existsSync(lane), ingested: Boolean(state().runs.get(producer.run).report),
  native: JSON.parse(fs.readFileSync(path.join(root, 'native.json'))) });
const reviews = [...state().items.values()].filter(i => i.meta.review_source_run === producer.run);
assert.equal(reviews.length, 1); assert.equal(reviews[0].id, review.id);
const target = review.meta.review_target;
assert.equal(target.head, head); assert.equal(target.base, base); assert.equal(review.meta.review_round_cap, 1);
assert.equal(state().items.get(review.id).runs.length, 1);
assert.match(git(['show', `${head}:answer.txt`]), /Installed consumer change/);
stage('original-review', { item: review.id, run: forwardJob.run, root: forwardJob.release.root, head, base, target });
report(forwardJob, [], 'verdict: PASS\n');
await until(() => state().runs.get(forwardJob.run).report || loadRecord(org).events.some(e => e.type === 'report.available' && e.run === forwardJob.run), 'review availability');
service(0).pass();
await until(() => !fs.existsSync(forwardJob.worker.cwd), 'review folder removal after rollback');
assert.equal(state().items.get(review.id).closed.as, 'done');
assert.equal(loadRecord(org).events.filter(e => e.type === 'change.reviewed').length, 1);
assert.equal(state().items.get(item).closed.as, 'done');
stage('review-cleanup', { folderRemoved: true, verdicts: 1, sourceClosed: true, reviewClosed: true });
// The next actions really reach scripted input and lose their replies. Observe
// another pass without replacing a request, attempting input again or clearing it.
// Queued canonical reviews may precede the added item, and only completed starts
// consume the pass budget, so every attempted candidate is an uncertain attempt.
record(['add', 'Retain an uncertain scratch action', '--role', 'engineer']);
fs.writeFileSync(path.join(root, 'lose-prompt-reply'), 'lose the original reply');
const beforeUncertain = new Set(journals().map(j => j.file));
service(1).pass();
const attempts = journals().filter(j => !beforeUncertain.has(j.file)); assert.ok(attempts.length >= 1, audit());
const bytes = new Map(attempts.map(j => [j.file, fs.readFileSync(j.file)])), calls = fs.readFileSync(path.join(root, 'native-calls.jsonl'), 'utf8');
service(1).pass();
const prompts = (text, job) => text.split('\n').filter(Boolean).map(JSON.parse).filter(a => a[0] === 'agent' && a[1] === 'prompt' && a[2] === job.worker.agentName);
for (const unknown of attempts) {
  assert.deepEqual(fs.readFileSync(unknown.file), bytes.get(unknown.file));
  assert.equal(journals().filter(j => j.item === unknown.item).length, 1);
  assert.equal(prompts(calls, unknown).length, 1);
  assert.equal(prompts(fs.readFileSync(path.join(root, 'native-calls.jsonl'), 'utf8'), unknown).length, 1);
  assert.ok(fs.existsSync(unknown.worker.cwd));
}
stage('uncertain-retained', { attempts: attempts.map(j => ({ item: j.item, run: j.run, journal: j.file, stage: j.stage, prompts: 1, folderKept: true, error: j.error })) });
write('outcome.json', { ready: false, scriptedMechanics: true, dispatch: 2 + attempts.length, reports: 2, originalReviews: 1, verdicts: 1,
  producerFoldersRemoved: 1, reviewFoldersRemoved: 1, uncertainAttemptsRetained: attempts.length, base, head, roots: config });

// The uncertain requests stay untouched; terminate only their receipt-owned test
// watchers after the retention observation, before archiving/removing scratch.
for (const unknown of attempts) if (unknown.watcher && ownerAlive(unknown.watcher)) process.kill(unknown.watcher.pid, 'SIGTERM');
await until(() => attempts.every(unknown => !unknown.watcher || !ownerAlive(unknown.watcher)), 'uncertain watcher shutdown');
await until(() => !fs.existsSync(path.join(directory, 'closeout-turn.lock')), 'finite closeout shutdown');
for (const unknown of attempts) assert.deepEqual(fs.readFileSync(unknown.file), bytes.get(unknown.file));
stage('fixture-teardown', { uncertainJournalsUnchanged: true, watchersStopped: true });
const wakeLog = path.join(directory, 'closeout.log');
if (fs.existsSync(wakeLog)) assert.doesNotMatch(fs.readFileSync(wakeLog, 'utf8'), /^line-closeout:/m, 'installed background wakes must also stay in scratch and succeed');
