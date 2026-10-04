// Read-only detail documents. Receipts remain useful after a lane is retired.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readReport } from '../../lib/report.mjs';
import { sanitize } from '../lib/text.mjs';
import { shortTitle } from './minimal.mjs';
import { batchPipeline, runPipeline, pipelineDuration, PIPELINE_MARKS } from './pipelines.mjs';
import { noticeEntries } from './feed.mjs';

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
  function settlement(project, run, { foreignIsAbsent = false } = {}) {
    if (!project?.org || !/^R-\d+$/.test(run?.id ?? '')) return null;
    const raw = read(path.join(project.org, 'settle', `${run.id}.json`));
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved.common !== project.repoKey || saved.run !== run.id || saved.item !== run.item || saved.org !== project.org) {
      if (foreignIsAbsent) return null;
      throw Error('Settlement belongs to a different run or project');
    }
    return saved;
  }
  function dispatch(project, run, { foreignIsAbsent = false } = {}) {
    const raw = read(run?.meta?.dispatch_journal);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved.common !== project.repoKey || saved.run !== run.id || saved.item !== run.item || saved.org !== project.org) {
      if (foreignIsAbsent) return null;
      throw Error('Dispatch belongs to a different run or project');
    }
    return saved;
  }
  function lifecycle(project, run, status) {
    const settlements = new Map(), dispatches = new Map();
    for (const r of status?.runs?.filter(r => r.item === run?.item) ?? []) {
      const options = { foreignIsAbsent: r.id !== run.id };
      const saved = settlement(project, r, options), request = dispatch(project, r, options);
      if (saved) settlements.set(r.id, saved);
      if (request) dispatches.set(r.id, request);
    }
    return { settlements, dispatches };
  }
  const pipeline = (title, links) => section('pipeline', title, '', { pipeline: links });
  function pipelineEvidence(selected, extra = [], now = Date.now()) {
    return [section('link', selected?.label ?? 'Evidence', selected
      ? `${PIPELINE_MARKS[selected.status]} ${selected.status}\nElapsed: ${pipelineDuration(selected, now)}\n\n${selected.detail}` : 'Evidence unavailable.',
    selected ? { clock: { started: selected.started_at, finished: selected.finished_at, duration: selected.duration_s, complete: selected.status !== 'running' } } : {}), ...extra];
  }
  function liveCheckLog(project, batch, attempt, gate, current) {
    if (gate?.log) return gate.log;
    if (!batch?.receipt || current?.phase !== 'validating' || !attempt?.gate || finishedGate(attempt.gate)) return null;
    const directory = path.join(project.repoKey, 'lane-validation');
    let names;
    try { names = fsApi.readdirSync(directory); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    const logs = [];
    for (const name of names.filter(n => /^[a-f0-9]{64}\.lock$/.test(n))) {
      const owner = read(path.join(directory, name, 'owner.json'));
      if (!owner) continue;
      const argv = JSON.parse(owner).argv ?? [], index = argv.indexOf('promote-batch');
      if (index < 0 || argv[index + 1] !== batch.receipt) continue;
      const key = name.slice(0, -5);
      // One active writer per key. Ambiguous/orphan logs are never selected by
      // recency; wait for the final gate's explicit log path instead.
      logs.push(...names.filter(n => n.startsWith(`.${key}.`) && n.endsWith('.log')).map(n => path.join(directory, n)));
    }
    return logs.length === 1 ? logs[0] : null;
  }
  const finishedGate = gate => Boolean(gate && (gate.finished_at || gate.exit_code != null || gate.error));
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
    const links = descriptor.kind === 'run' ? runPipeline({ run, runs: status?.runs, ...lifecycle(project, run, status), train,
      candidates: status?.candidates, identity: project.repoKey }) : [];
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
    if (descriptor.kind === 'run') sections.unshift(pipeline('Run lifecycle', links));
    if (descriptor.kind === 'run') sections.push(section('promotion', 'Promotion', promotion ? [
      `Result: ${promotion.outcome} · ${promotion.reason ?? ''}`, `Commit: ${promotion.tip ?? 'not recorded'}`,
      `Integrated: ${promotion.integrated_at ?? 'not recorded'}`,
    ].join('\n\n') : 'No promotion result recorded.', promotion ? { open: { kind: 'result', job: promotion.id } } : {}),
    section('decisions', 'Decisions', decisions.length ? bullets(decisions) : 'No decisions recorded on this run.'), section('timing', 'Stage timing', timing, { code: true }));
    return { title: `${descriptor.kind === 'report' ? 'Report' : 'Run'} · ${descriptor.run ?? feed?.run ?? '?'} · ${run?.item ?? feed?.item ?? '?'}`, sections, asOf: now };
  }
  function runLinkDocument(descriptor, facts) {
    const { project, status, train = {} } = facts;
    const run = status?.runs?.find(r => r.id === descriptor.run), saved = settlement(project, run), request = dispatch(project, run);
    const linked = lifecycle(project, run, status);
    const links = runPipeline({ run, runs: status?.runs, ...linked, train, candidates: status?.candidates, identity: project.repoKey });
    const selected = links.find(l => l.id === `run:${descriptor.run}:${descriptor.stage}`);
    let sections;
    if (['dispatch', 'engineering'].includes(descriptor.stage)) sections = [
      section('brief', 'Brief', saved?.ask ?? read(request?.brief) ?? read(run?.brief_path) ?? 'Brief not recorded.'),
      section('dispatch', 'Dispatch receipt', request ? JSON.stringify(request, null, 2) : 'No dispatch receipt recorded.', { code: true }),
      section('report', 'Report', '', { open: { kind: 'report', run: descriptor.run } }),
    ];
    else if (descriptor.stage === 'review') sections = [reviewSection(saved), section('settlement', 'Settlement receipt', saved ? JSON.stringify(saved, null, 2) : 'No settlement recorded.', { code: true })];
    else if (descriptor.stage === 'candidate') {
      const candidate = status?.candidates?.find(c => c.id === (descriptor.candidate ?? selected?.open.candidate) && c.identity === project.repoKey);
      sections = [section('gate', 'Candidate gate', candidate ? [
        `${candidate.id} \u00b7 ${candidate.tag} \u00b7 ${candidate.commit}`,
        `Result: ${candidate.gate?.result ?? 'not recorded'} \u00b7 ${candidate.status ?? 'unknown'}`,
        candidate.gate?.detail ?? '', `Command: ${JSON.stringify(candidate.gate?.command ?? candidate.gate_command)}`,
      ].join('\n\n') : 'This landed commit is not in a recorded release candidate.'),
      section('log', 'Gate output \u00b7 tail', read(candidate?.gate?.log, { tail: true }) ?? 'Gate log not recorded.', { log: true }),
      section('receipt', 'Candidate receipt', candidate ? JSON.stringify(candidate, null, 2) : 'No candidate recorded.', { code: true })];
    } else {
      const promotion = train.results?.find(r => r.run === descriptor.run);
      sections = [section('promotion', 'Promotion receipt', promotion ? JSON.stringify(promotion, null, 2) : 'No promotion recorded.', { code: true }),
        section('settlement', 'Settlement', saved?.result?.reason ?? 'No settlement recorded.')];
    }
    return { title: `${selected?.label ?? descriptor.stage} \u00b7 ${descriptor.run}`, sections: pipelineEvidence(selected, sections, facts.now) };
  }
  function trainDocument(descriptor, { project, train = {}, journal = [], now = Date.now() }) {
    const result = descriptor.kind === 'result' ? train.results?.find(r => r.id === descriptor.job) : null;
    const batchId = descriptor.batch ?? result?.batch;
    const batch = train.batches?.find(b => b.id === batchId);
    const current = train.current?.id === batchId ? train.current : null;
    const attempt = batch?.attempts?.at(-1), gate = result?.gate ?? attempt?.gate;
    const jobs = batch?.jobs ?? current?.jobs ?? [], results = train.results?.filter(r => r.batch === batchId) ?? [];
    const notices = noticeEntries(journal);
    const deliveredResults = results.map(r => {
      const notice = notices.find(n => n.id === r.delivery_id || n.fields?.kind === 'promote-queue' && n.fields.id === r.id && n.fields.outcome === r.outcome);
      return notice ? { ...r, delivered: ['sent', 'handled'].includes(notice.delivery), delivery_id: notice.id } : r;
    });
    const links = batchPipeline({ batch, current, results: deliveredResults,
      interrupted: !current && train.interrupted?.some(b => b.id === batchId) && (!results.length || !results.every(r => ['promoted', 'refused'].includes(r.outcome))) });
    const complete = Boolean(gate && (gate.finished_at || gate.exit_code != null));
    const stopped = !complete && links.find(l => l.id === 'batch:ci')?.status !== 'running';
    const clock = seconds(gate?.duration_s ?? between(gate?.started_at ?? current?.checkStarted, complete || stopped ? gate?.finished_at : new Date(now).toISOString()));
    const receipt = batch?.receipt ?? result?.receipt ?? current?.receipt;
    const checkLog = liveCheckLog(project, batch, attempt, attempt?.gate ?? gate, current);
    const logs = [...new Set([checkLog, batch?.log ?? result?.log ?? current?.log].filter(Boolean))];
    const sections = [pipeline('Train batch', links), section('batch', 'Batch status', [
      `Lanes: ${jobs.map(j => j.topic).join(', ') || result?.topic || current?.lanes?.join(', ') || 'not recorded'}`,
      `Phase: ${current?.phase ?? batch?.phase ?? result?.outcome ?? 'unavailable'}`,
      `Check: ${gate?.command ?? current?.command ?? batch?.command ?? 'not recorded'}`,
      `Elapsed: ${clock}${complete ? ' · finished' : ''}`,
      ...results.map(r => `${r.topic ?? r.id}: ${r.outcome} · ${r.reason ?? ''}${r.tip ? `\nCommit: ${r.tip}` : ''}`),
      attempt?.error ? `Reason: ${attempt.error}` : '',
    ].filter(Boolean).join('\n'), { code: true, clock: { started: gate?.started_at ?? current?.checkStarted, duration: gate?.duration_s, finished: gate?.finished_at, complete, stopped },
      entries: jobs.map(j => entry(`lane:${j.id ?? j.topic}`, `${j.topic}${j.run ? ` · ${j.run}` : ''}`, j.run ? { kind: 'run', run: j.run } : { kind: 'lane', topic: j.topic, job: j.id, batch: batchId })) })];
    if (logs.length) sections.push(section('live-log', 'Live log · latest', read(logs[0], { tail: true })?.trimEnd().split('\n').slice(-8).join('\n') ?? 'Log unavailable.', { log: true }));
    for (const [i, file] of logs.entries()) sections.push(section(`log:${i}`, file === checkLog ? 'Check log \u00b7 tail' : 'Train log \u00b7 tail',
      read(file, { tail: true }) ?? 'Log unavailable.', { log: true }));
    if (!logs.length) sections.push(section('log', 'Log', 'No log recorded.'));
    const rawReceipt = read(receipt);
    const savedReceipt = rawReceipt && JSON.parse(rawReceipt);
    if (savedReceipt && (savedReceipt.identity !== project.repoKey || savedReceipt.id !== batchId)) throw Error('Train receipt belongs to a different batch or project');
    sections.push(section('receipt', 'Receipt', savedReceipt ? JSON.stringify(savedReceipt, null, 2) : 'No receipt recorded.', { code: true }));
    if (descriptor.kind === 'batch-link') {
      const selected = links.find(l => l.id === `batch:${descriptor.stage}`);
      const evidenceSections = [];
      if (descriptor.stage === 'ci') {
        // Include every attempted gate, including failed bisection groups. A
        // failure's messages can be earlier than the bounded latest tail.
        for (const [i, a] of (batch?.attempts ?? []).entries()) if (a.gate) {
          const file = a === attempt ? checkLog : a.gate.log, output = read(file, { tail: true });
          evidenceSections.push(section(`check:${i}`, `Check ${i + 1} \u00b7 ${a.gate.command ?? 'unknown'}`, [
            `Exit: ${a.gate.exit_code ?? 'not recorded'} \u00b7 ${a.phase} \u00b7 ${detailDuration(a.gate.duration_s)}`,
            a.error ?? a.gate.error ?? '',
          ].filter(Boolean).join('\n'), { code: true }));
          if (a.gate.exit_code != null && a.gate.exit_code !== 0) evidenceSections.push(section(`failures:${i}`, 'Failing tests and messages',
            failureOutput(file) ?? 'Failure output unavailable.', { log: true }));
          evidenceSections.push(section(`output:${i}`, 'Check output \u00b7 tail', output ?? 'Check output not yet recorded.', { log: true }));
        }
        if (!evidenceSections.length) evidenceSections.push(section('output', 'Check output \u00b7 tail', read(checkLog ?? logs[0], { tail: true }) ?? 'No check output recorded.', { log: true }));
      } else if (descriptor.stage === 'notify') evidenceSections.push(section('notices', 'Notice delivery', notices.filter(n => deliveredResults.some(r => r.delivery_id === n.id))
        .map(n => `${n.at} \u00b7 ${n.delivery}\n${n.message}`).join('\n\n') || 'No notice delivery recorded.', { code: true }));
      else if (descriptor.stage === 'queued') evidenceSections.push(section('jobs', 'Queued lanes', JSON.stringify(jobs, null, 2), { code: true }));
      else evidenceSections.push(...sections.filter(s => ['batch', 'log:0'].includes(s.id)));
      evidenceSections.push(sections.find(s => s.id === 'receipt'));
      return { title: `${selected?.label ?? descriptor.stage} \u00b7 ${batchId}`, sections: pipelineEvidence(selected, evidenceSections, now) };
    }
    return { title: `${descriptor.kind === 'result' ? 'Train result' : 'Train'} · ${result?.topic ?? batchId ?? 'unavailable'}`, sections };
  }
  function failureOutput(file) {
    const raw = read(file);
    if (!raw) return null;
    const lines = text(raw).split('\n'), output = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*(?:not ok\b|FAIL\b|\u2716|\u00d7|(?:error|Error|AssertionError):)/.test(lines[i])) continue;
      const start = i;
      // TAP diagnostic YAML retains expected/actual, stack and test messages.
      while (i + 1 < lines.length && !/^\s*(?:ok\b|not ok\b|# Subtest:)/.test(lines[i + 1])) {
        i++;
        if (/^\s*\.\.\.\s*$/.test(lines[i])) break;
      }
      output.push(lines.slice(start, i + 1).join('\n'));
    }
    return output.join('\n\n') || 'No structured failing test messages found; inspect the check output and receipt.';
  }
  return {
    document(descriptor, facts) {
      if (['run', 'report'].includes(descriptor.kind)) return runDocument(descriptor, facts);
      if (descriptor.kind === 'run-link') return runLinkDocument(descriptor, facts);
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
