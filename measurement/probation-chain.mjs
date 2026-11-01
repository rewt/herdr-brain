// Saved append-only history only. This reader grants no runtime authority.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonical} from '../messages/schema.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);
const json = value => JSON.stringify(value) + '\n';
const valid = id => /^[-a-zA-Z0-9_]{1,80}$/.test(id ?? '');
const require = (ok, why) => { if (!ok) throw Error(why); };

export function probationChain({events, original, authority, history, verified, references, from, startSeq}) {
  const scope = original.scope, p = scope.previous, repo = original.repo, org = original.org, identity = original.project;
  require(p?.kind === 'development-recovery' && p.original?.cutover && p.derived?.installation, 'sealed recovery history missing');
  const files = new Map(), used = new Set();
  for (const f of history.files ?? []) {
    require(typeof f.file === 'string' && !files.has(f.file) && typeof f.bytes === 'string' && hash(f.bytes) === f.sha256 &&
      f.evidence?.length && f.evidence.every(id => verified.has(id) && references?.[id]?.sha256 === f.sha256), 'history archive missing, duplicate or changed');
    files.set(f.file, f);
  }
  const read = ref => {
    const f = files.get(ref?.file);
    require(f && f.sha256 === ref.sha256, 'history archive reference changed or absent');
    used.add(ref.file); return JSON.parse(f.bytes);
  };
  const note = (event, prefix, owner, sha) => {
    const n = events.find(e => e.seq === event.authority);
    require(n?.type === 'note.added' && n.decision === true && n.id === events.find(e => e.seq === original.authority)?.id &&
      n.by === original.owner?.native?.name && owner?.native?.name === n.by && same(owner.native, event.native_caller) &&
      n.seq < event.seq && n.text === `${prefix}: ${event.id} ${sha}`, 'history effect authority changed');
  };
  let savedBytes = p.original.installation, saved = JSON.parse(savedBytes), plist = p.original.plist, last = p.original.cutover;
  let pending = null, installed = null, anchor = null;
  const ids = new Set(), extensions = new Map(), roots = new Set(), fences = new Map();
  const rows = events.filter(e => ['line-service.probation-switched', 'line-service.probation-successor-authorized',
    'line-service.probation-successor-switched'].includes(e.type) && e.project === identity && e.org === org);
  for (const e of rows) {
    require(e.trial === original.id && e.repo === repo && valid(e.id) && e.seq > authority.seq && e.seq <= startSeq &&
      Number.isFinite(Date.parse(e.at)) && Date.parse(e.at) <= Date.parse(from), 'history trial, order or pre-window binding changed');
    const a = read(e.archive);
    if (e.type === 'line-service.probation-successor-authorized') {
      require(!extensions.has(e.archive.file) && !roots.has(a.candidate?.release?.root) && !pending && !installed &&
        saved.source === p.release.root && fences.size === 0 && e.seq > last.seq &&
        a.schema === 'brain-probation-successor/v1' && a.trial === original.id && a.repo === repo && a.org === org && a.identity === identity &&
        a.original?.seq === authority.seq && same(a.original.archive, authority.archive) &&
        a.original.scope_sha256 === hash(canonical(scope)) && a.original.recovery_sha256 === hash(canonical(p)) &&
        same(a.candidate, e.candidate) && same(a.node, p.node), 'successor original authority/recovery changed');
      note(e, 'Brain probation successor authorized', a.owner, e.plan_sha256);
      require(![scope.candidate.release.root,p.release.root].includes(a.candidate?.release?.root), 'successor candidate repeats original/recovery');
      if(anchor) require(savedBytes === anchor.installation && plist === anchor.plist, 'successor recovery anchor changed');
      else { require(last.type === 'line-service.probation-switched', 'successor lacks legacy recovery anchor'); anchor = {installation: savedBytes, plist}; }
      pending = {event: e, scope: a, first: true};
      extensions.set(e.archive.file,pending); roots.add(a.candidate.release.root);
      continue;
    }
    const previousSource = last === p.original.cutover && path.isAbsolute(saved.source) && path.resolve(saved.source) === repo ? repo : saved.source;
    require(!ids.has(e.id) && e.previous_seq === last.seq && e.seq > last.seq && a.id === e.id && a.trial === original.id &&
      a.repo === repo && a.org === org && a.identity === identity && a.previous_seq === last.seq &&
      e.previous_source === previousSource && a.previous_source === previousSource && a.source === e.source &&
      a.scope_sha256 === hash(canonical(scope)) && a.recovery_sha256 === hash(canonical(p)) &&
      a.before?.installation === savedBytes && a.before?.plist === plist, 'disconnected or changed effect history');
    ids.add(e.id);
    let target, after;
    if (e.type === 'line-service.probation-switched') {
      require(!extensions.size && a.schema === 'brain-probation-switch/v1', 'legacy switch after successor');
      target = e.source === scope.candidate.release.root ? scope.candidate.release : e.source === p.release.root ? p.release : null;
      after = {...JSON.parse(p.derived.installation), source: target?.root, runtime: target};
      note(e, 'Brain probation switch authorized', a.owner, e.archive.sha256);
    } else {
      const extension = extensions.get(a.extension?.file);
      require(extension && a.schema === 'brain-probation-successor-effect/v1' && same(a.extension, extension.event.archive) &&
        same(a.successor_scope, extension.scope) && a.rollback === e.rollback && typeof e.rollback === 'boolean', 'successor scope/effect changed');
      if (extension.first) {
        require(pending === extension && !e.rollback && fences.size === 0 && e.seq === extension.event.seq+1, 'successor lacks completed recovery anchor');
        require(e.id === extension.event.id && e.authority === extension.event.authority &&
          e.archive.sha256 === extension.event.plan_sha256, 'successor entry authority differs');
        extension.first = false; pending = null;
      }
      require(e.rollback ? installed === extension : !installed && fences.size === 0 && !pending, 'successor installed extension/cleared recovery differs');
      target = e.rollback ? p.release : extension.scope.candidate.release;
      require(saved.source === (e.rollback ? extension.scope.candidate.release.root : p.release.root), 'successor direction changed');
      after = e.rollback ? JSON.parse(anchor.installation) : {...JSON.parse(anchor.installation), source: target.root, runtime: target};
      note(e, 'Brain probation successor authorized', a.owner, e.archive.sha256);
      fences.set(e.id, json({schema: 'brain-probation-successor-fence/v1', trial: a.trial, id: a.id, archive: e.archive, extension: a.extension}));
      installed = e.rollback ? null : extension;
    }
    require(target && e.source !== saved.source && same(e.runtime, target) && same(a.runtime, target) &&
      a.after?.installation === json(after) && typeof a.after.plist === 'string' && a.after.plist.length > 0, 'effect target/installation changed');
    saved = e.type === 'line-service.probation-switched' ? {...after, probation_bootstrap: {trial: original.id, id: e.id, ...e.archive}} :
      e.rollback ? after : {...after, probation_successor: {trial: original.id, id: e.id, ...e.archive, extension: a.extension}};
    savedBytes = json(saved); plist = a.after.plist; last = e;
    if (e.type === 'line-service.probation-successor-switched' && e.rollback) {
      require(plist === anchor.plist, 'recovery plist changed');
      const ref = history.files.find(f => f.file === path.join(path.dirname(e.archive.file), '..', 'probation-successor-clears', e.id + '.json'));
      const clear = read(ref);
      require(same(clear, {schema: 'brain-probation-successor-clear/v1', trial: original.id, id: e.id,
        completion_seq: e.seq, archive: e.archive, fences: Object.fromEntries(fences)}), 'rollback clear receipt changed');
      fences.clear();
    }
  }
  require(rows.length && !pending && history.installation === savedBytes && history.plist === plist, 'final history state absent or changed');
  for (const [id, bytes] of fences) {
    const file = path.join(path.dirname(authority.archive.file), '..', 'probation-switches', '.successor-' + id), f = files.get(file);
    require(f && f.bytes === bytes, 'incomplete/UNKNOWN compatibility fence'); used.add(file);
  }
  require(files.size === used.size, 'uncompleted/refused/UNKNOWN history intent retained');
  return {candidate: installed && saved.source === installed.scope.candidate.release.root ? installed.scope.candidate :
    saved.source === scope.candidate.release.root ? scope.candidate : null, lastSeq: last.seq,
    recovery: {root: p.release.root, commit: p.release.commit, tree: p.source.tree, manifestSha256: p.manifest_sha256,
      inventorySha256: p.inventory_sha256, node: p.node}};
}
