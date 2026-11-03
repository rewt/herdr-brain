import {fixture, at, proof, bindSavedEvidence} from './soak-fixture.mjs';
import {digest} from '../../measurement/canary-soak.mjs';
import {canonical} from '../../messages/schema.mjs';
const json = value => JSON.stringify(value) + '\n';

// Same archive/effect shapes as developmentHistory and successorHistory. The
// second extension is a prospective reader control, never native authority.
export function successorFixture({next = true} = {}) {
  const f = fixture(), {trial, events} = f, p = trial.probation, scope = p.archive.scope;
  const repo = '/fixture/brain', org = '/fixture/record', directory = org + '/line', owner = {native: {name: 'supervisor-herdr', session: 'original-owner'}};
  const installed = root => ({repo, org, source: root, node: '/node20', phase: 'installed'});
  const recovery = {root: '/installed/previous', id: 'runtime', commit: '6'.repeat(40), protocol: 1};
  scope.repo = repo; scope.org = org;
  scope.candidate.release = {...scope.candidate.release, root: '/installed/original', commit: '3'.repeat(40), id: 'original', protocol: 1};
  scope.candidate.tree = '4'.repeat(40);
  const previous = scope.previous = {kind: 'development-recovery', release: recovery, source: {tree: '5'.repeat(40)},
    manifest_sha256: '6'.repeat(64), inventory_sha256: '7'.repeat(64), node: trial.candidate.node,
    original: {installation: json(installed(repo)), plist: 'development plist', cutover: {seq: 0, type: 'line-service.cutover', source: repo}},
    derived: {installation: json({...installed(recovery.root), runtime: recovery}), plist: 'sealed recovery plist'}};
  Object.assign(p.archive, {repo, org, owner, before: {installation: previous.original.installation, plist: previous.original.plist}});
  const save = (file, value) => {
    const bytes = typeof value === 'string' ? value : json(value), sha256 = digest(bytes), id = 'history-' + p.history.files.length;
    p.history.files.push({file, sha256, bytes, evidence: [id]}); trial.evidence[id] = {path: id, sha256}; f.verifiedEvidence.push(id);
    return {file, sha256};
  };
  const originalBytes = json(p.archive), originalRef = {file: directory + '/probation/trial-one.json', sha256: digest(originalBytes)};
  p.evidence = ['original']; trial.evidence.original = {path: 'original.json', sha256: originalRef.sha256}; f.verifiedEvidence.push('original');
  Object.assign(events[1], {repo, org, owner, scope: structuredClone(scope), archive: originalRef});
  events[0].at = at(-200); events[1].at = at(-199);
  events[0].text = `Brain probation authorized: ${digest(canonical(scope))}`;
  for (const e of events.slice(2)) {
    e.seq += 100;
    if (e.started_seq) e.started_seq += 100;
    if (e.claim_generation) e.claim_generation += 100;
    if (e.source?.seq) e.source.seq += 100;
    for (const r of Object.values(e.resources ?? {})) if (r.receipt?.seq) r.receipt.seq += 100;
  }
  for (const r of trial.runs) { r.startedSeq += 100; r.claimGeneration += 100; }
  trial.window.through_seq += 100;
  p.history = proof({files: []});
  let last = previous.original.cutover, savedBytes = previous.original.installation, plist = previous.original.plist, seq = 2, extension, extensionRef, anchor;
  const historyEvents = [], fences = {};
  const note = (id, text) => { const n = {seq: ++seq, at: at(-100 + seq), type: 'note.added', id: 'ENG-trial', by: owner.native.name, decision: true, text}; historyEvents.push(n); return n.seq; };
  function effect(id, target, rollback, legacy = false) {
    const after = legacy ? {...JSON.parse(previous.derived.installation), source: target.root, runtime: target} :
      rollback ? JSON.parse(anchor.installation) : {...JSON.parse(anchor.installation), source: target.root, runtime: target};
    const a = {schema: legacy ? 'brain-probation-switch/v1' : 'brain-probation-successor-effect/v1', id, trial: p.archive.id, repo, org, identity: trial.project, owner,
      previous_seq: last.seq, previous_source: JSON.parse(savedBytes).source, source: target.root, runtime: target,
      scope_sha256: digest(canonical(scope)), recovery_sha256: digest(canonical(previous)),
      before: {installation: savedBytes, plist}, after: {installation: json(after), plist: rollback ? anchor.plist : target.root + ' plist'},
      ...(!legacy ? {rollback, extension: extensionRef, successor_scope: extension} : {})};
    const ref = save(`${directory}/${legacy ? 'probation-switches' : 'probation-successor-effects'}/${id}.json`, a);
    const authority = note(id, `Brain probation ${legacy ? 'switch' : 'successor'} authorized: ${id} ${ref.sha256}`);
    if (!legacy && !historyEvents.some(e => e.type === 'line-service.probation-successor-authorized' && e.archive.file === extensionRef.file))
      historyEvents.push({seq: ++seq, at: at(-100 + seq), type: 'line-service.probation-successor-authorized', id, trial: p.archive.id, repo, org,
        project: trial.project, archive: extensionRef, candidate: extension.candidate, authority, native_caller: owner.native, plan_sha256: ref.sha256});
    const e = {seq: ++seq, at: at(-100 + seq), type: legacy ? 'line-service.probation-switched' : 'line-service.probation-successor-switched',
      id, trial: p.archive.id, repo, org, project: trial.project, archive: ref, authority, native_caller: owner.native,
      previous_seq: last.seq, previous_source: a.previous_source, source: target.root, runtime: target, ...(!legacy ? {rollback} : {})};
    historyEvents.push(e);
    const saved = legacy ? {...after, probation_bootstrap: {trial: p.archive.id, id, ...ref}} : rollback ? after :
      {...after, probation_successor: {trial: p.archive.id, id, ...ref, extension: extensionRef}};
    savedBytes = json(saved); plist = a.after.plist; last = e;
    if (!legacy) {
      fences[id] = json({schema: 'brain-probation-successor-fence/v1', trial: p.archive.id, id, archive: ref, extension: extensionRef});
      if (rollback) {
        save(`${directory}/probation-successor-clears/${id}.json`, {schema: 'brain-probation-successor-clear/v1', trial: p.archive.id, id,
          completion_seq: e.seq, archive: ref, fences: {...fences}});
        for (const k of Object.keys(fences)) delete fences[k];
      }
    }
  }
  function extend(id, candidate) {
    anchor = {installation: savedBytes, plist};
    extension = {schema: 'brain-probation-successor/v1', trial: p.archive.id, repo, org, identity: trial.project, owner,
      original: {seq: 2, archive: originalRef, scope_sha256: digest(canonical(scope)), recovery_sha256: digest(canonical(previous))}, candidate, node: previous.node};
    extensionRef = save(`${directory}/probation-successors/${id}.json`, extension);
  }
  effect('initial-entry', scope.candidate.release, false, true);
  effect('recovery-drill', recovery, false, true);
  effect('candidate-return', scope.candidate.release, false, true);
  effect('recovery-anchor', recovery, false, true);
  const earlier = {...structuredClone(scope.candidate), release: {root: '/installed/earlier-successor', commit: '8'.repeat(40), id: 'earlier', protocol: 1}};
  if (!next) { earlier.release.root = trial.candidate.root; earlier.release.commit = trial.candidate.commit; earlier.tree = trial.candidate.tree; }
  extend('earlier', earlier); effect('earlier-entry', earlier.release, false); effect('earlier-rollback', recovery, true);
  effect('earlier-return', earlier.release, false); effect('failed-window-recovery', recovery, true);
  const current = next ? {...structuredClone(scope.candidate), release: {root: trial.candidate.root, commit: trial.candidate.commit, id: 'current', protocol: 1}, tree: trial.candidate.tree} : earlier;
  if (next) extend('prospective-current', current);
  effect('current-entry', current.release, false);
  effect('current-drill', recovery, true);
  effect('current-return', current.release, false);
  for (const [id, bytes] of Object.entries(fences)) save(`${directory}/probation-switches/.successor-${id}`, bytes);
  p.history.installation = savedBytes; p.history.plist = plist;
  f.events = [...events.slice(0, 2), ...historyEvents, ...events.slice(2)]; trial.window.start_seq = Math.max(seq, trial.window.start_seq + 100);
  trial.recovery.tuple = {root: recovery.root, commit: recovery.commit, tree: previous.source.tree,
    manifestSha256: previous.manifest_sha256, inventorySha256: previous.inventory_sha256, node: previous.node};
  return bindSavedEvidence(f);
}
