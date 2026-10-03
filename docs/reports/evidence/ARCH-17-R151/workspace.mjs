// ARCH-17 scratch prototype, not product code. Resolves a directory to a workspace
// project, its area and effective guardrails; counts lane leases with pid liveness.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const expand = (p) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
const within = (root, file) => { const r = path.relative(root, file); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export const FRAMEWORK = {
  guardrails: {
    lanes: { max_workers: 4, max_reviews: 1, max_promotions: 1 },
    settle: { max_sessions_per_day: 30 },
    load: { max_per_cpu: 1 },
    memory: { max_swap_used_mb: 0, min_free_percent: 25 },
    test_slot: { tiers: ['promotion', 'release'], when_held: 'wait' },
    approvals: { reserved: ['security', 'funds-and-chain', 'publish', 'delete-data', 'licensing', 'priorities'] },
    tmp: { max_path: 60 },
  },
};

// Stricter-wins merge. A project value that would widen is dropped and reported.
const STRICT = {
  'lanes.max_workers': 'min', 'lanes.max_reviews': 'min', 'lanes.max_promotions': 'min',
  'settle.max_sessions_per_day': 'min', 'load.max_per_cpu': 'min',
  'memory.max_swap_used_mb': 'min', 'memory.min_free_percent': 'max', 'tmp.max_path': 'min',
  'test_slot.tiers': 'union', 'approvals.reserved': 'union', 'test_slot.when_held': 'refuse-or-wait',
};
export function narrow(base, override, source) {
  const out = structuredClone(base), ignored = [];
  for (const [group, values] of Object.entries(override ?? {})) for (const [key, value] of Object.entries(values)) {
    const rule = STRICT[`${group}.${key}`], current = out[group]?.[key];
    if (!rule) { ignored.push({ key: `${group}.${key}`, value, source, why: 'unknown guardrail' }); continue; }
    let next = current;
    if (rule === 'min') next = Math.min(current, value);
    if (rule === 'max') next = Math.max(current, value);
    if (rule === 'union') next = [...new Set([...current, ...value])];
    if (rule === 'refuse-or-wait') next = current === 'refuse' || value === 'refuse' ? 'refuse' : 'wait';
    const honored = rule === 'min' ? value <= current : rule === 'max' ? value >= current : rule === 'union' ? true : value === 'refuse' || current === 'wait';
    if (!honored) ignored.push({ key: `${group}.${key}`, value, kept: next, source, why: 'would widen' });
    out[group][key] = next;
  }
  return { guardrails: out, ignored };
}

export function loadWorkspace(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const home = path.dirname(file);
  return { file, home, raw, roots: (raw.roots ?? []).map(expand), projects: raw.projects ?? {} };
}

// A project is a Git common directory; its key is a readable name plus an identity hash.
export function resolveProject(ws, cwd) {
  let checkout, identity;
  try {
    checkout = fs.realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
    identity = fs.realpathSync(git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  } catch { return { inside: ws.roots.some((r) => within(r, fs.realpathSync(cwd))), project: null, why: 'not a Git project' }; }
  const canonical = path.dirname(identity); // non-bare repos; the product uses gitProject()
  const inside = ws.roots.some((r) => within(r, canonical));
  const entry = Object.entries(ws.projects).find(([, p]) => p.identity === identity);
  if (!inside && !entry) return { inside, project: null, why: 'outside every root; the operator joins it by entering it' };
  const name = entry?.[0] ?? `${path.basename(canonical)}-${createHash('sha256').update(identity).digest('hex').slice(0, 6)}`;
  const area = path.join(ws.home, 'p', name);
  const p = entry?.[1] ?? {};
  return {
    inside, joined: Boolean(entry), name, identity, canonical,
    area,
    record: p.record ? expand(p.record) : path.join(area, 'record'),
    worktrees: p.worktrees ? expand(p.worktrees) : path.join(area, 'worktrees'),
    legacy: p.legacy ?? [],
  };
}

export function runTemp(ws, project, run, budget) {
  const natural = path.join(project.area, 'tmp', run);
  const short = path.join(ws.home, 't', createHash('sha256').update(`${project.identity}\0${run}`).digest('hex').slice(0, 8));
  const chosen = natural.length <= budget ? natural : short;
  return { natural, chosen, length: chosen.length, socket_room: 104 - chosen.length - 1 };
}

export function effective(ws, project, projectGuardrails) {
  const w = narrow(FRAMEWORK.guardrails, ws.raw.guardrails, ws.file);
  const p = narrow(w.guardrails, projectGuardrails, `${project.canonical}/.lane.json`);
  return { guardrails: p.guardrails, ignored: [...w.ignored.filter((i) => i.why !== 'would widen'), ...p.ignored] };
}

// Counted leases with pid + start-time liveness (the test slot's rule, generalized).
const started = (pid) => { try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return null; } };
export function lease(ws, kind, cap, holder) {
  const dir = path.join(ws.home, 'leases', kind);
  fs.mkdirSync(dir, { recursive: true });
  const lockDir = path.join(dir, '.lock');
  for (let i = 0; ; i++) { try { fs.mkdirSync(lockDir); break; } catch (e) { if (e.code !== 'EEXIST' || i > 200) throw e; } }
  try {
    const live = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).filter((f) => {
      const l = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (started(l.pid) === l.start) return true;
      fs.rmSync(path.join(dir, f)); return false;
    });
    if (live.length >= cap) return { granted: false, held: live.length, cap };
    const file = path.join(dir, `${holder.project}-${holder.run}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...holder, pid: holder.pid, start: started(holder.pid) }));
    return { granted: true, held: live.length + 1, cap, file };
  } finally { fs.rmdirSync(lockDir); }
}
