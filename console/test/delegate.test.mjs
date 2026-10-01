import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDelegations, decisionPath, delegateBrief, forwardMessage, parseDecision } from '../modern/delegate.mjs';
import { createFeedSession } from '../modern/feed.mjs';
import { lineText } from '../lib/frame.mjs';

const entry = { key: 'R-7', id: 'ARCH-1', run: 'R-7', source: 'report', title: 'Plan', decisions: [{ n: 1, question: 'Adopt?', recommend: 'yes' }, { n: 2, question: 'Split?', recommend: 'no' }] };

test('the brief carries the questions, the evidence, the rules and the answer form', () => {
  const b = delegateBrief({ project: { name: 'Alpha', org: '/org' }, entry, item: { title: 'Plan', created: { why: 'Because.' } }, file: '/s/decisions/R-7.json', orgBin: '/bin/org.mjs', reportPath: '/r.md', blocks: ['ENG-2'] });
  for (const re of [/delegated a decision/, /ARCH-1 \(from run R-7\): Plan/, /Read it first/, /1\. Adopt\?\n   The author recommends: yes\./, /Waiting on it: ENG-2/, /Escalate instead of answering when the decision spends or moves money/, /write exactly one JSON object to \/s\/decisions\/R-7\.json/, /"answers": \{"1": "<your answer>", "2": "<your answer>"\}/]) assert.match(b, re);
});

test('a decision is checked before anything uses it', () => {
  assert.equal(parseDecision('nope', entry).ok, false);
  assert.match(parseDecision('{"item":"ARCH-2","answers":{}}', entry).error, /not ARCH-1/);
  assert.match(parseDecision('{"item":"ARCH-1","answers":{"1":"yes"}}', entry).error, /unanswered/);
  const ok = parseDecision('```json\n{"item":"ARCH-1","escalate":false,"answers":{"1":"yes","2":"no"},"confidence":"high","why":"src/a.mjs:10"}\n```', entry);
  assert.deepEqual([ok.ok, ok.escalate, ok.answers['2']], [true, false, 'no']);
  assert.equal(parseDecision('{"item":"ARCH-1","escalate":true,"escalate_reason":"spends sats","answers":{}}', entry).escalate, true);
  assert.equal(forwardMessage(entry, ok, 'decide-arch-1', '/f.json'), "Delegated decision for R-7 (ARCH-1), decided on the operator's authority by decide-arch-1 (confidence high): 1 yes; 2 no. Reasoning: /f.json. Record it as the operator's answer and proceed.");
});

test('approve once: a decider starts, decides, and its answer reaches the supervisor; escalations come back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deleg-'));
  try {
    const now = Date.parse('2026-09-30T21:00:00Z'), at = m => new Date(now - m * 60e3).toISOString();
    const status = { items: [
      { id: 'ARCH-1', kind: 'work', role: 'architect', title: 'Plan', status: 'needs_human', created: { at: at(60) }, runs: ['R-7'], notes: [], blocks: ['ENG-2'] },
      { id: 'HUM-3', kind: 'work', role: 'human', title: 'Spend 1M sats?', status: 'open', created: { at: at(30), run: 'R-7' }, runs: [], notes: [], meta: {} },
    ], runs: [{ id: 'R-7', item: 'ARCH-1', started: { at: at(90) }, report: { outcome: 'needs_human' }, report_path: '/r.md', meta: {} }] };
    const events = [{ seq: 1, at: at(50), type: 'report.ingested', run: 'R-7', item: 'ARCH-1', report: { outcome: 'needs_human', headline: 'Planned.' } }];
    const started = [], sent = [], files = new Map();
    let agents = [{ name: 'supervisor', pane: 'w:p1', status: 'idle' }];
    const session = createFeedSession({ config: { projects: [{ name: 'Alpha', cwd: '/repo', org: '/x/.org' }] }, env: { HERDR_FEED_WATCH: 'w:p1', HERDR_BRAIN_STATE: dir },
      deps: { now: () => now, orgStatus: async () => status, orgLog: async () => events, chatIndex: { data: { mentions: {} }, update: () => false },
        herdrAgents: async () => ({ ok: true, agents }), herdrList: async () => [], herdrVisible: async () => ({ ok: true, text: '' }),
        readFile: async f => { if (files.has(f)) return files.get(f); throw Error('missing'); },
        herdrPrompt: async (a, t) => { sent.push([a, t]); return { ok: true }; },
        startDecider: async r => { started.push(r); agents = [...agents, { name: r.name, pane: 'w:p9', status: 'working' }]; return { ok: true }; } } });
    await session.refresh();
    // A in the list delegates every open decision, after one Enter.
    await session.key('A', {}); assert.match(session.frame(60, 60).lines.map(lineText).join('\n'), /DELEGATE · 2[\s\S]*Enter starts deciders/); assert.deepEqual(started, []);
    await session.key('', { return: true });
    assert.equal(started.length, 2); assert.match(started[0].brief, /ARCH-1|HUM-3/); assert.ok(started.every(r => r.name.startsWith('decide-')));
    let text = session.frame(60, 60).lines.map(lineText).join('\n'); assert.match(text, /DELEGATED · 2/); assert.match(text, /deciding · decide-/);
    // The deciders answer: one decides, one escalates the spend.
    const d = session.ui.delegations, arch = d.find(x => x.id === 'ARCH-1'), hum = d.find(x => x.id === 'HUM-3');
    files.set(arch.file, JSON.stringify({ item: 'ARCH-1', escalate: false, answers: { 1: 'proceed with plan B' }, confidence: 'high', why: 'a.mjs:3' }));
    files.set(hum.file, JSON.stringify({ item: 'HUM-3', escalate: true, escalate_reason: 'it spends 1M sats', answers: { 1: 'yes' } }));
    await session.refresh();
    assert.equal(sent.length, 1); assert.match(sent[0][1], /^Delegated decision for R-7 \(ARCH-1\), decided on the operator's authority by decide-arch-1-\d{4} \(confidence high\): proceed with plan B\./);
    assert.equal(session.ui.delegations.find(x => x.id === 'ARCH-1').status, 'forwarded');
    assert.equal(session.ui.delegations.find(x => x.id === 'HUM-3').status, 'escalated');
    text = session.frame(60, 60).lines.map(lineText).join('\n'); assert.match(text, /escalated to you: it spends 1M sats/); assert.match(text, /sent to the supervisor/);
    // The escalated item comes back with the decider's answer filled in.
    await session.ui; const f = session.frame(60, 60), y = f.hits.findIndex(h => h.some(x => x.id === 'item:HUM-3~d'));
    await session.mouse({ x: 2, y, button: 'left', press: true });
    text = session.frame(60, 60).lines.map(lineText).join('\n'); assert.match(text, /escalated this to you: it spends 1M sats/); assert.match(text, /→ yes/);
    // The queue survives a restart.
    assert.equal(createDelegations({ dir }).list.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
