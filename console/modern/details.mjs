// Read-only detail documents. Receipts remain useful after a lane is retired.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readReport } from '../../lib/report.mjs';
import { sanitize } from '../lib/text.mjs';
import { shortTitle } from './minimal.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const text = value => sanitize(value, { keepNewlines: true });
export const detailDuration = value => Number.isFinite(value) ? value < 60 ? `${Math.floor(Math.max(0, value))}s`
  : value < 3600 ? `${Math.floor(value / 60)}m ${Math.floor(value % 60)}s` : `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m` : 'not recorded';
const seconds = detailDuration;
const between = (start, end) => {
  const a = Date.parse(start), b = Date.parse(end);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 1000 : null;
};
const section = (id, title, content, extra = {}) => ({ id, title, content: text(content), ...extra });
const entry = (id, label, open) => ({ id, label: text(label), open });
const bullets = values => (values ?? []).map(v => `- ${typeof v === 'string' ? text(v) : text(v.text ?? v.title ?? JSON.stringify(v))}`).join('\n');

export function createDetailReader({ fsApi = fs } = {}) {
  const cache = new Map();
  function read(file, { tail = false } = {}) {
    if (!file) return null;
    let st;
    try { st = fsApi.statSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    const key = `${file}:${tail}`, signature = `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;
    if (cache.get(key)?.signature === signature) return cache.get(key).value;
    let value;
    if (tail) {
      const size = Math.min(st.size, 65536), bytes = Buffer.alloc(size), fd = fsApi.openSync(file, 'r');
      try { value = bytes.subarray(0, fsApi.readSync(fd, bytes, 0, size, st.size - size)).toString('utf8'); }
      finally { fsApi.closeSync(fd); }
      if (st.size > size) value = value.slice(value.indexOf('\n') + 1);
      value = text(value).split('\n').slice(-200).join('\n');
    } else value = fsApi.readFileSync(file, 'utf8');
    cache.set(key, { signature, value });
    return value;
  }
  function settlement(project, run) {
    if (!project?.org || !/^R-\d+$/.test(run?.id ?? '')) return null;
    const raw = read(path.join(project.org, 'settle', `${run.id}.json`));
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved.common !== project.repoKey || saved.run !== run.id || saved.item !== run.item || saved.org !== project.org)
      throw Error('Settlement belongs to a different run or project');
    return saved;
  }
  function reportSource(project, run, saved) {
    if (!run) return { content: 'No report recorded.' };
    const file = run.report?.file ? path.resolve(project.org, run.report.file) : run.report_path;
    const raw = read(file) ?? saved?.reportText;
    if (!raw) return { content: run.report?.summary ?? 'No report recorded.' };
    if (run.report?.sha256 && hash(raw) !== run.report.sha256) throw Error('Report bytes differ from the recorded report');
    const parsed = readReport(raw);
    if (parsed.errors.length || parsed.report.run !== run.id) throw Error('Report does not match this run');
    const r = parsed.report;
    return { content: [r.summary, r.blockers?.length ? `### Blockers\n${bullets(r.blockers)}` : '', parsed.body,
      r.artifacts?.length ? `### Artifacts\n${bullets(r.artifacts)}` : ''].filter(Boolean).join('\n\n'),
      decisions: r.extra?.decisions ?? [], provisional: !run.report };
  }
  function reviewSection(saved) {
    const review = saved?.review;
    if (!review) return section('review', 'Review', 'No review recorded.');
    const raw = review.text ?? read(review.path);
    if (raw && review.sha256 && hash(raw) !== review.sha256) throw Error('Review bytes differ from the settlement receipt');
    const findings = raw?.split(/^## Findings[^\n]*\n/m)[1]?.split(/^## |<!-- lane-review-complete -->/m)[0]?.trim();
    return section('review', `Review · ${review.verdict ?? 'unknown'}`, [
      `Verdict: ${review.verdict ?? 'unknown'} · Round ${saved.round ?? '?'} · ${review.route ?? saved.reviewRoute ?? '?'}`,
      `Reviewed commit: ${saved.head ?? saved.result?.reviewed_commit ?? '?'}`,
      findings ?? saved.result?.findings ?? 'Findings not recorded.',
    ].join('\n\n'));
  }
  function runDocument(descriptor, facts) {
    const { project, status, reports = [], train = {}, now = Date.now() } = facts;
    const run = status?.runs?.find(r => r.id === descriptor.run), feed = reports.find(r => r.id === descriptor.report || r.run === descriptor.run);
    const item = status?.items?.find(i => i.id === (run?.item ?? feed?.item));
    const saved = settlement(project, run), report = reportSource(project, run, saved);
    const promotion = run && train.results?.find(r => r.run === run.id || (!r.run && saved?.finalHead && r.topic === saved.lane && r.source_head === saved.finalHead));
    const decision = run?.notes?.findLast(n => n.decision && /^Settle:/.test(n.text));
    const gate = promotion?.gate;
    const timing = [
      `Engineering: ${seconds(between(run?.started?.at, run?.report?.at ?? run?.abandoned?.at))}`,
      `Report → settle decision: ${seconds(between(run?.report?.at, decision?.at))}`,
      `Review: ${seconds(saved?.review?.duration_s ?? between(saved?.review?.started_at, saved?.review?.finished_at))}`,
      `Queue wait: ${seconds(between(promotion?.queued, gate?.started_at))}`,
      `CI: ${seconds(gate?.duration_s ?? between(gate?.started_at, gate?.finished_at))}`,
      `Integration: ${seconds(between(gate?.finished_at, promotion?.integrated_at))}`,
      `Report → main: ${seconds(promotion?.report_to_main_s ?? between(run?.report?.at, promotion?.integrated_at))}`,
    ].join('\n');
    const decisions = [...(run?.notes ?? []).filter(n => n.decision).map(n => `${n.at} · ${n.by}\n${n.text}`), ...(report.decisions ?? [])];
    const sections = [section('overview', descriptor.kind === 'report' ? 'Report status' : 'Run status', [
      `${run?.item ?? feed?.item ?? '?'} · ${shortTitle(item?.title ?? 'Item unavailable').split(/\s+\(/)[0]}`,
      `Outcome: ${run?.report?.outcome ?? feed?.outcome ?? (run?.abandoned ? 'abandoned' : 'No report')} · Check: ${feed?.check ?? 'unknown'}`,
      `Review: ${saved?.review?.verdict ?? 'not recorded'}${promotion ? ` · Promotion: ${promotion.outcome}` : ''}`,
      promotion?.tip ? `Commit: ${promotion.tip}` : '',
      report.provisional ? 'Report awaiting ingestion.' : '',
      saved?.result?.reason ?? saved?.error ?? '',
    ].filter(Boolean).join('\n\n'), { entries: item ? [entry('item', `Open ${item.id}`, { kind: 'item', item: item.id })] : [] }),
    section('report', 'Report', report.content, descriptor.kind === 'run' ? { open: { kind: 'report', run: descriptor.run } } : {}),
    reviewSection(saved)];
    if (descriptor.kind === 'run') sections.push(section('promotion', 'Promotion', promotion ? [
      `Result: ${promotion.outcome} · ${promotion.reason ?? ''}`, `Commit: ${promotion.tip ?? 'not recorded'}`,
      `Integrated: ${promotion.integrated_at ?? 'not recorded'}`,
    ].join('\n\n') : 'No promotion result recorded.', promotion ? { open: { kind: 'result', job: promotion.id } } : {}),
    section('decisions', 'Decisions', decisions.length ? bullets(decisions) : 'No decisions recorded on this run.'), section('timing', 'Stage timing', timing, { code: true }));
    return { title: `${descriptor.kind === 'report' ? 'Report' : 'Run'} · ${descriptor.run ?? feed?.run ?? '?'} · ${run?.item ?? feed?.item ?? '?'}`, sections, asOf: now };
  }
  function trainDocument(descriptor, { project, train = {}, now = Date.now() }) {
    const result = descriptor.kind === 'result' ? train.results?.find(r => r.id === descriptor.job) : null;
    const batchId = descriptor.batch ?? result?.batch;
    const batch = train.batches?.find(b => b.id === batchId);
    const current = train.current?.id === batchId ? train.current : null;
    const attempt = batch?.attempts?.at(-1), gate = result?.gate ?? attempt?.gate;
    const jobs = batch?.jobs ?? current?.jobs ?? [], results = result ? [result] : train.results?.filter(r => r.batch === batchId) ?? [];
    const complete = Boolean(gate && (gate.finished_at || gate.exit_code != null));
    const clock = seconds(gate?.duration_s ?? between(gate?.started_at ?? current?.checkStarted, complete ? gate.finished_at : new Date(now).toISOString()));
    const receipt = batch?.receipt ?? result?.receipt ?? current?.receipt;
    const logs = [...new Set([gate?.log, batch?.log ?? result?.log ?? current?.log].filter(Boolean))];
    const sections = [section('batch', 'Batch status', [
      `Lanes: ${jobs.map(j => j.topic).join(', ') || result?.topic || current?.lanes?.join(', ') || 'not recorded'}`,
      `Phase: ${current?.phase ?? batch?.phase ?? result?.outcome ?? 'unavailable'}`,
      `Check: ${gate?.command ?? current?.command ?? batch?.command ?? 'not recorded'}`,
      `Elapsed: ${clock}${complete ? ' · finished' : ''}`,
      ...results.map(r => `${r.topic ?? r.id}: ${r.outcome} · ${r.reason ?? ''}${r.tip ? `\nCommit: ${r.tip}` : ''}`),
      attempt?.error ? `Reason: ${attempt.error}` : '',
    ].filter(Boolean).join('\n'), { code: true, clock: { started: gate?.started_at ?? current?.checkStarted, duration: gate?.duration_s, finished: gate?.finished_at, complete },
      entries: jobs.map(j => entry(`lane:${j.id ?? j.topic}`, `${j.topic}${j.run ? ` · ${j.run}` : ''}`, j.run ? { kind: 'run', run: j.run } : { kind: 'lane', topic: j.topic, job: j.id, batch: batchId })) })];
    if (logs.length) sections.push(section('live-log', 'Live log · latest', read(logs[0], { tail: true })?.trimEnd().split('\n').slice(-8).join('\n') ?? 'Log unavailable.', { log: true }));
    for (const [i, file] of logs.entries()) sections.push(section(`log:${i}`, i === 0 && gate?.log ? 'Check log · tail' : 'Train log · tail',
      read(file, { tail: true }) ?? 'Log unavailable.', { log: true }));
    if (!logs.length) sections.push(section('log', 'Log', 'No log recorded.'));
    const rawReceipt = read(receipt);
    const savedReceipt = rawReceipt && JSON.parse(rawReceipt);
    if (savedReceipt && (savedReceipt.identity !== project.repoKey || savedReceipt.id !== batchId)) throw Error('Train receipt belongs to a different batch or project');
    sections.push(section('receipt', 'Receipt', savedReceipt ? JSON.stringify(savedReceipt, null, 2) : 'No receipt recorded.', { code: true }));
    return { title: `${descriptor.kind === 'result' ? 'Train result' : 'Train'} · ${result?.topic ?? batchId ?? 'unavailable'}`, sections };
  }
  return {
    document(descriptor, facts) {
      if (['run', 'report'].includes(descriptor.kind)) return runDocument(descriptor, facts);
      if (descriptor.kind === 'item') {
        const item = facts.status?.items?.find(i => i.id === descriptor.item);
        return { title: `${descriptor.item} · ${item?.title ?? 'Item unavailable'}`, sections: [
          section('item', 'Item', `Status: ${item?.status ?? item?.closed?.as ?? 'unknown'}\n\n${bullets(item?.accept)}`),
          section('runs', 'Runs', '', { entries: (item?.runs ?? []).map(run => entry(run, run, { kind: 'run', run })) }),
          section('decisions', 'Decisions', bullets(item?.notes?.filter(n => n.decision)) || 'No decisions recorded.'),
        ] };
      }
      if (['waiting', 'context', 'idle'].includes(descriptor.kind)) {
        const context = descriptor.kind === 'context';
        const jobs = context ? facts.sessions.filter(s => ['supervisor', 'chat'].includes(s.stage)) : facts.train.waiting ?? [];
        return { title: context ? 'Context sessions' : 'Train queue', list: true, sections: [section('queue', context ? 'Sessions' : 'Waiting', jobs.length ? '' : 'No batch running or lanes waiting.', {
          entries: jobs.map(j => entry(j.id ?? j.pane ?? j.topic, context ? `${j.name} · ${j.stage} · ${j.provider}` : j.topic,
            context ? { kind: 'session', target: j.target } : { kind: 'queued', job: j.id, topic: j.topic })),
        })] };
      }
      if (descriptor.kind === 'queued') {
        const job = facts.train.waiting?.find(j => j.id === descriptor.job && j.topic === descriptor.topic)
          ?? facts.train.current?.jobs?.find(j => j.id === descriptor.job);
        const result = facts.train.results?.find(r => r.id === descriptor.job);
        if (result) return trainDocument({ kind: 'result', job: result.id }, facts);
        if (facts.train.current?.jobs?.some(j => j.id === descriptor.job)) return trainDocument({ kind: 'batch', batch: facts.train.current.id }, facts);
        return { title: `Queued lane · ${descriptor.topic}`, sections: [section('job', 'Queue entry', job ? JSON.stringify(job, null, 2) : 'Queue entry is no longer waiting.', { code: true })] };
      }
      if (descriptor.kind === 'lane') {
        const batch = facts.train.batches?.find(b => b.id === descriptor.batch);
        const job = [...(batch?.jobs ?? []), ...(batch?.attempts?.at(-1)?.jobs ?? [])].findLast(j => j.id === descriptor.job && j.topic === descriptor.topic);
        const runs = facts.status?.runs?.filter(r => r.meta?.lane === descriptor.topic) ?? [];
        return { title: `Lane · ${descriptor.topic}`, sections: [section('lane', 'Lane receipt', job ? JSON.stringify(job, null, 2) : 'Lane receipt unavailable.', { code: true }),
          section('runs', 'Recorded runs', '', { entries: runs.map(r => entry(r.id, `${r.id} · ${r.item}`, { kind: 'run', run: r.id })) })] };
      }
      return trainDocument(descriptor, facts);
    },
  };
}
