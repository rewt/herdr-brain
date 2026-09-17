// Words for the session columns: who runs a session (WHO), for how long (UP) and
// what it is doing (DOING). Pure; no dependencies.
import { firstLine, firstSentence, oneLine, stripCodes } from './text.mjs';

// Model IDs to words. An ID not listed here is shown as it is.
export const MODEL_NAMES = {
  'claude-opus-5': { tool: 'Claude', model: 'Opus 5' },
  'claude-fable-5-1': { tool: 'Claude', model: 'Fable 5.1' },
  'claude-sonnet-5': { tool: 'Claude', model: 'Sonnet 5' },
  'claude-haiku-4-5': { tool: 'Claude', model: 'Haiku 4.5' },
  'claude-haiku-4-5-20251001': { tool: 'Claude', model: 'Haiku 4.5' },
  'claude-opus-4-8': { tool: 'Claude', model: 'Opus 4.8' },
  'claude-opus-4-7': { tool: 'Claude', model: 'Opus 4.7' },
  'claude-sonnet-4-5': { tool: 'Claude', model: 'Sonnet 4.5' },
  'gpt-6-astra': { tool: 'Codex', model: 'Astra' },
  'gpt-6-sol': { tool: 'Codex', model: 'Sol' },
  // Aliases a harness accepts; the transcript names the exact model when there is one.
  opus: { tool: 'Claude', model: 'Opus', alias: true },
  sonnet: { tool: 'Claude', model: 'Sonnet', alias: true },
  haiku: { tool: 'Claude', model: 'Haiku', alias: true },
  fable: { tool: 'Claude', model: 'Fable', alias: true },
};

const TOOL_NAMES = { 'claude-code': 'Claude', claude: 'Claude', codex: 'Codex' };

export function toolWord(name) {
  if (!name) return null;
  const key = String(name).toLowerCase();
  return TOOL_NAMES[key] ?? `${key[0].toUpperCase()}${key.slice(1)}`;
}

export function modelWords(id) {
  if (!id) return null;
  const known = MODEL_NAMES[id];
  return known ? { tool: known.tool, model: known.model } : { tool: null, model: String(id) };
}

// harness/model/effort: the org run's; agentTool: Herdr's `agent`; transcriptModel:
// the model of the session transcript's last assistant entry.
export function whoFor({ harness = null, model = null, effort = null, agentTool = null, transcriptModel = null } = {}) {
  const id = model && !(MODEL_NAMES[model]?.alias && transcriptModel) ? model : transcriptModel ?? model;
  const words = modelWords(id);
  const tool = toolWord(harness) ?? toolWord(agentTool) ?? words?.tool ?? 'unknown tool';
  const name = words?.model ?? null;
  const text = `${tool}${name ? ` ${name}` : ' · unknown'}${effort ? ` · ${effort}` : ''}`;
  return { tool, model: name, effort: effort ?? null, text };
}

export function upText(since, nowMs) {
  const start = since ? Date.parse(since) : NaN;
  if (Number.isNaN(start)) return 'unknown';
  const minutes = Math.max(0, Math.floor((nowMs - start) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function tenWords(text) {
  const words = oneLine(text).split(' ').filter(Boolean);
  return words.length > 10 ? `${words.slice(0, 10).join(' ')}…` : words.join(' ');
}

// A description worth showing: codes stripped, and at least two words left.
function usable(text, prefixes) {
  const t = stripCodes(text ?? '', prefixes);
  return t.split(' ').filter(Boolean).length >= 2 ? t : null;
}

// The first sentence of a brief that is not a heading.
function briefSentence(brief, prefixes) {
  const body = String(brief ?? '').split('\n').filter((l) => !/^\s{0,3}#/.test(l)).join('\n');
  const line = firstLine(body);
  return line ? usable(firstSentence(stripCodes(line, prefixes)), prefixes) : null;
}

// title: Herdr's terminal title; agentName: the Herdr agent name (a title that only
// repeats it says nothing); brief: the run's brief text, or a function that reads it
// (called only when the title says nothing); itemTitle: the org item's title.
export function doingText({ title = null, agentName = null, brief = null, itemTitle = null, prefixes } = {}) {
  const fromTitle = title && oneLine(title) !== agentName ? usable(title, prefixes) : null;
  const text = fromTitle ?? briefSentence(typeof brief === 'function' ? brief() : brief, prefixes) ?? usable(itemTitle, prefixes) ?? null;
  return text ? tenWords(text) : 'no description';
}
