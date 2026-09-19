const MAX_PANE_LINES = 200;
const MAX_PANE_BYTES = 16 * 1024;
const MAX_RAW_EXCERPT_CODE_POINTS = 500;
const MAX_CONCURRENT_PANE_READS = 4;
const SUPPORTED_AGENT_KINDS = new Set(["codex", "claude"]);

const ANSI_SEQUENCE = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/gu;
const TREE_MARKER = /^(\s{2,})[└├](?:\s+|$)/u;
const TOOL_SUMMARY_CLAUSE = String.raw`(?:Searched for|Read|Listed|Ran)\s+\d+\s+[\p{L}-]+(?:\s+[\p{L}-]+)?`;
const ELAPSED_TIME = String.raw`(?:\b\d+(?:[.,]\d+)?\s*(?:ms|s|m|h|secs?|seconds?|mins?|minutes?|hours?)\b|\b\d{1,2}:\d{2}(?::\d{2})?\b)`;
const ELAPSED_FIELD = String.raw`${ELAPSED_TIME}(?:\s+${ELAPSED_TIME})*`;
const COUNT_FIELD = String.raw`[\d,.]+\s+(?:tokens?|files?)`;
const WORD_FIELD = String.raw`(?:left|total|remaining)`;
const STATUS_FIELD = String.raw`(?:${ELAPSED_FIELD}|${COUNT_FIELD}|${WORD_FIELD})`;
const STATUS_SEPARATOR = String.raw`\s*[·•|]\s*`;
const SEPARATED_STATUS_FIELDS = String.raw`(?=[^\n]*${ELAPSED_TIME})${STATUS_FIELD}(?:${STATUS_SEPARATOR}${STATUS_FIELD})+`;
const BOUNDED_STATUS_FIELDS = String.raw`(?:${ELAPSED_FIELD}(?:\s+${WORD_FIELD})*|${SEPARATED_STATUS_FIELDS})`;
const SPINNER_STATUS_FIELDS = String.raw`${ELAPSED_FIELD}(?:${STATUS_SEPARATOR}${COUNT_FIELD})*`;
const PROGRESS_PREFIX = String.raw`(?:[✻✽✶✳·]\s+)?(?:Working|Worked|Thinking|Running)\b`;
const TIMED_STATUS_GROUP = String.raw`(?:\(${BOUNDED_STATUS_FIELDS}\)|\[${BOUNDED_STATUS_FIELDS}\])(?:\s+(?:${COUNT_FIELD}|${WORD_FIELD}))?`;
const TIMED_STATUS_ELLIPSIS = String.raw`(?:…|\.{3})\s*${BOUNDED_STATUS_FIELDS}`;
const TIMED_STATUS = String.raw`${PROGRESS_PREFIX}\s*(?:${TIMED_STATUS_GROUP}|${TIMED_STATUS_ELLIPSIS})`;
const APPROVAL_WORDS = String.raw`(?:Would you like to run|Do you want to (?:run|allow|approve)|Allow Codex to)\b`;
const COMMAND_INVOCATION = /^(?:(?:npm|npx|node|pnpm|yarn|bun|deno|git|rg|grep|sed|awk|find|ls|pwd|cd|cat|head|tail|printf|echo|cp|mv|rm|mkdir|touch|chmod|curl|wget|cargo|rustc|go|python3?|pytest|make|cmake|sh|bash|zsh)(?:\s|$)|[A-Z_][A-Z0-9_]*=|(?:\.{0,2}|~)\/\S+(?:\s.*)?$|(?:[\w.-]+\/)+[\w.-]+$|[\w.-]+\.[A-Za-z0-9]+$)/u;

function chromeRule(pattern, candidateFirstLine, example) {
  return Object.freeze({ pattern, candidateFirstLine, example });
}

export const CODEX_CHROME_RULES = Object.freeze({
  "horizontal-divider": chromeRule(/^(?:\s{2,})?[─━═╌╍┄┅┈┉-]{6,}\s*$/u, false, "────────────────"),
  "composer-frame": chromeRule(/^(?:\s{2,})*[╭╮╰╯┌┐└┘│┃─━═╌╍┄┅┈┉ ]*[╭╮╰╯┌┐└┘│┃─━═╌╍┄┅┈┉][╭╮╰╯┌┐└┘│┃─━═╌╍┄┅┈┉ ]*$/u, false, "╭────────╮"),
  "prompt-row": chromeRule(/^›(?:\s.*)?$/u, false, "› Ask Codex to do anything"),
  "result-marker": chromeRule(/^(\s{2,})(└|⎿|├)(?:\s+.*)?$/u, false, "  ⎿ output"),
  "tool-summary": chromeRule(new RegExp(`^\\s{2,}${TOOL_SUMMARY_CLAUSE}(?:,\\s+${TOOL_SUMMARY_CLAUSE})*\\s*$`, "iu"), false, "  Read 1 file"),
  "interrupt-status": chromeRule(/^(?:(?:•\s+)|\s{2,})?[^\n]*\besc(?:ape)? to interrupt\b(?:\s*[)\]])?\s*$/iu, true, "• Compacting context (1s • esc to interrupt)"),
  "timed-status": chromeRule(new RegExp(`^(?:•\\s+|\\s{2,})?${TIMED_STATUS}$`, "iu"), true, "• Working (1s)"),
  "question-shortcut-bar": chromeRule(/^\s{2,}\?[^\n]*(?:shortcut|submit|edit)[^\n]*$/iu, false, "  ? for shortcuts"),
  "escape-toggle-bar": chromeRule(/^\s{2,}(?:esc\b|ctrl-[a-z]\b)\s+to\s+(?:interrupt|toggle|submit|edit)\s*$/iu, false, "  esc to toggle"),
  "context-bar": chromeRule(/^\s{2,}context left(?:\s+[\d,.]+%?)?\s*$/iu, false, "  Context left 12%"),
  "percentage-context-bar": chromeRule(/^\s{2,}[\d,.]+%?\s+context left\s*$/iu, false, "  12% context left"),
  "token-usage-bar": chromeRule(/^\s{2,}tokens?\s+(?:are\s+)?used(?::\s*|\s+)[\d,.]+[km]?\s*$/iu, false, "  Tokens are used: 1,024"),
  "token-cost-bar": chromeRule(/^\s{2,}tokens?\s+cost(?::\s*|\s+)\$[\d,.]+\s*$/iu, false, "  Tokens cost $0.01"),
  "metered-token-bar": chromeRule(/^\s{2,}[\d,.]+[km]?\s+tokens?\s*(?:·\s*)?(?:\$[\d,.]+|cost(?:\s+\$?[\d,.]+)?|used)\s*$/iu, false, "  1,024 tokens · $0.01"),
  "approval-prompt": chromeRule(new RegExp(`^\\s*${APPROVAL_WORDS}[^\\n]*\\?\\s*$`, "iu"), false, "Would you like to run this command?"),
  "footer-row": chromeRule(/^\s{2,}\S+(?:\s+\S+)?\s+·\s+(?:\S+\/\S+\s+·\s+\S+|(?:[\d,.]+%?\s+)?context left)\s*$/iu, false, "  model high · example/repository · task"),
});

export const CLAUDE_CHROME_RULES = Object.freeze({
  "horizontal-divider": chromeRule(/^(?:\s{2,})?[─━═╌╍┄┅┈┉-]{6,}\s*$/u, false, "────────────────"),
  "composer-frame": chromeRule(/^(?:\s{2,})*[╭╮╰╯┌┐└┘│┃─━═╌╍┄┅┈┉ ]*[╭╮╰╯┌┐└┘│┃─━═╌╍┄┅┈┉][╭╮╰╯┌┐└┘│┃─━═╌╍┄┅┈┉ ]*$/u, false, "╭────────╮"),
  "prompt-row": chromeRule(/^(?:❯|›|>)(?:\s.*)?$/u, false, "❯ Ask another question"),
  "result-marker": chromeRule(/^(\s{2,})(└|⎿|├)(?:\s+.*)?$/u, false, "  ⎿ output"),
  "tool-summary": chromeRule(new RegExp(`^\\s{2,}${TOOL_SUMMARY_CLAUSE}(?:,\\s+${TOOL_SUMMARY_CLAUSE})*\\s*$`, "iu"), false, "  Read 1 file"),
  "interrupt-status": chromeRule(/^(?:(?:⏺|●)\s+|\s{2,})?[^\n]*\besc(?:ape)? to interrupt\b(?:\s*[)\]])?\s*$/iu, true, "⏺ Compacting context (1s • esc to interrupt)"),
  "timed-status": chromeRule(new RegExp(`^(?:(?:⏺|●)\\s+|\\s{2,})?${TIMED_STATUS}$`, "iu"), true, "⏺ Working (1s)"),
  "question-shortcut-bar": chromeRule(/^\s{2,}\?[^\n]*(?:shortcut|submit|edit)[^\n]*$/iu, false, "  ? for shortcuts"),
  "fast-mode-bar": chromeRule(/^\s{2,}⏵⏵\s+(?:accept edits|bypass permissions)\s+on(?:\s+\(shift\+tab to cycle\))?\s*$/iu, false, "  ⏵⏵ accept edits on"),
  "escape-toggle-bar": chromeRule(/^\s{2,}(?:esc\b|ctrl-[a-z]\b)\s+to\s+(?:interrupt|toggle|submit|edit)\s*$/iu, false, "  esc to toggle"),
  "spinner-row": chromeRule(new RegExp(`^\\s{2,}[✻✽✶✳·]\\s+\\p{L}+(?:\\s+\\p{L}+)*(?:…|\\.{3})(?:\\s+\\(${SPINNER_STATUS_FIELDS}\\))?\\s*$`, "u"), false, "  ✻ Thinking…"),
  "context-bar": chromeRule(/^\s{2,}context left(?:\s+[\d,.]+%?)?\s*$/iu, false, "  Context left 12%"),
  "percentage-context-bar": chromeRule(/^\s{2,}[\d,.]+%?\s+context left\s*$/iu, false, "  12% context left"),
  "token-usage-bar": chromeRule(/^\s{2,}tokens?\s+(?:are\s+)?used(?::\s*|\s+)[\d,.]+[km]?\s*$/iu, false, "  Tokens are used: 1,024"),
  "token-cost-bar": chromeRule(/^\s{2,}tokens?\s+cost(?::\s*|\s+)\$[\d,.]+\s*$/iu, false, "  Tokens cost $0.01"),
  "metered-token-bar": chromeRule(/^\s{2,}[\d,.]+[km]?\s+tokens?\s*(?:·\s*)?(?:\$[\d,.]+|cost(?:\s+\$?[\d,.]+)?|used)\s*$/iu, false, "  1,024 tokens · $0.01"),
  "approval-prompt": chromeRule(new RegExp(`^\\s{2,}${APPROVAL_WORDS}[^\\n]*\\?\\s*$`, "iu"), false, "  Would you like to run this command?"),
});

function isolatedResultMarker(lines, index, pattern) {
  const match = lines[index]?.match(pattern);
  if (match === null || match === undefined) return false;
  if (match[2] === "⎿") return true;
  const sameIndentTree = (line) => line?.match(TREE_MARKER)?.[1] === match[1];
  return !sameIndentTree(lines[index - 1]) && !sameIndentTree(lines[index + 1]);
}

export function matchingChromeRule(rules, line, lines, index, candidateFirstLine = false) {
  for (const [name, rule] of Object.entries(rules)) {
    if (candidateFirstLine && !rule.candidateFirstLine) continue;
    if (!rule.pattern.test(line)) continue;
    if (name === "result-marker" && !isolatedResultMarker(lines, index, rule.pattern)) continue;
    return name;
  }
  return null;
}

function cleanPaneText(text) {
  return `${text ?? ""}`
    .replaceAll(ANSI_SEQUENCE, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll(CONTROL_CHARACTER, "");
}

function trimBlock(lines) {
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
  return lines.join("\n").trimEnd();
}

function continuation(line) {
  return line.startsWith("  ") ? line.slice(2) : line;
}

function codexToolLabel(text) {
  return text.match(/^(?:Ran|Explored|Waited|Searched|Read|Listed|Viewed|Called|Edited|Added|Deleted|Updated|Applied|Opened|Found)\b/iu);
}

function claudeToolLabel(text) {
  return text.match(/^(?:Read|Write|Edit|Update|Bash|Glob|Grep|Search|Task|WebFetch|WebSearch|Skill|TodoWrite|AskUserQuestion|NotebookEdit|EnterPlanMode|ExitPlanMode|Save|Fetch|mcp__[^\s(]+)\b/iu);
}

function hasToolEvidence(lines, index, text, toolLabel, rules) {
  if (matchingChromeRule(rules, lines[index + 1], lines, index + 1) === "result-marker") return true;
  return toolLabel(text) && /^[^\s(\n]+\([^\n)]*\)\s*$/u.test(text);
}

function plausibleContinuation(line) {
  return line.trim() === "" || /^\s{2,}\S/u.test(line);
}

function pendingToolCommand(text, toolLabel) {
  const firstLine = text.split("\n", 1)[0].trimEnd();
  const match = toolLabel(firstLine);
  if (match === null) return false;
  const remainder = firstLine.slice(match[0].length).trim();
  return remainder === "" || COMMAND_INVOCATION.test(remainder);
}

function extractBlocks(lines, { start, toolLabel, rules }) {
  const blocks = [];
  let trailingPendingTool = false;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(start);
    if (match === null
        || matchingChromeRule(rules, lines[index], lines, index, true) !== null
        || matchingChromeRule(rules, match[1], [match[1]], 0, true) !== null
        || hasToolEvidence(lines, index, match[1], toolLabel, rules)) continue;
    const block = [match[1].trimEnd()];
    for (index += 1;
      index < lines.length
        && !start.test(lines[index])
        && matchingChromeRule(rules, lines[index], lines, index) === null
        && plausibleContinuation(lines[index]);
      index += 1) {
      block.push(continuation(lines[index]).trimEnd());
    }
    index -= 1;
    const text = trimBlock(block);
    if (pendingToolCommand(text, toolLabel)) {
      trailingPendingTool = true;
      continue;
    }
    if (/\p{L}|\p{N}/u.test(text)) {
      blocks.push(text);
      trailingPendingTool = false;
    }
  }
  return trailingPendingTool ? [] : blocks;
}

function rawExcerpt(text) {
  const normalized = cleanPaneText(text).trim();
  if (normalized === "") return null;
  const codePoints = [...normalized];
  const bounded = codePoints.length > MAX_RAW_EXCERPT_CODE_POINTS
    ? `…${codePoints.slice(-(MAX_RAW_EXCERPT_CODE_POINTS - 1)).join("")}`
    : normalized;
  return { text: bounded, source: "pane-output" };
}

export function extractAssistantPreview({ kind, text }) {
  const cleaned = cleanPaneText(text);
  const lines = cleaned.split("\n");
  let blocks = [];
  if (kind === "codex") {
    blocks = extractBlocks(lines, {
      start: /^•\s+(.+)$/u,
      toolLabel: codexToolLabel,
      rules: CODEX_CHROME_RULES,
    });
  } else if (kind === "claude") {
    blocks = extractBlocks(lines, {
      start: /^(?:⏺|●)\s+(.+)$/u,
      toolLabel: claudeToolLabel,
      rules: CLAUDE_CHROME_RULES,
    });
  }
  const assistantText = blocks.at(-1);
  if (assistantText !== undefined) {
    return {
      text: assistantText,
      source: "assistant-preview",
      available: true,
      rawExcerpt: null,
    };
  }
  return {
    text: null,
    source: "unavailable",
    available: false,
    rawExcerpt: rawExcerpt(cleaned),
  };
}

export function supportsMessagePreview(kind) {
  return SUPPORTED_AGENT_KINDS.has(kind);
}

function boundedUtf8Suffix(text, maximumBytes = MAX_PANE_BYTES) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maximumBytes) return { text, truncated: false };
  let start = bytes.length - maximumBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return { text: bytes.subarray(start).toString("utf8"), truncated: true };
}

function workspaceFor(session, snapshot) {
  return snapshot?.workspaces?.find(
    (workspace) => workspace.workspace_id === session.workspace || workspace.label === session.workspace,
  );
}

function agentFor(session, snapshot) {
  if (session.inventory_scoped === true) return session.inventory_agent ?? undefined;
  const workspace = workspaceFor(session, snapshot);
  const agent = snapshot?.agents?.find((candidate) => candidate.name === session.name);
  return workspace === undefined || agent?.workspace_id === workspace.workspace_id ? agent : undefined;
}

export function messageOccupantId(agent) {
  const session = agent?.agent_session;
  const terminal = typeof agent?.terminal_id === "string" && agent.terminal_id !== ""
    ? agent.terminal_id : null;
  if (typeof session?.agent === "string" && typeof session.kind === "string"
      && typeof session.source === "string" && typeof session.value === "string") {
    return JSON.stringify([session.agent, session.kind, session.source, session.value, terminal]);
  }
  if (typeof agent?.name === "string" && typeof agent?.agent === "string") {
    return JSON.stringify([agent.agent, agent.name, agent.pane_id, terminal]);
  }
  return null;
}

function currentAgentForPane(snapshot, paneId) {
  return snapshot?.agents?.find((agent) => agent.pane_id === paneId);
}

function unavailableRuntime({ kind, occupant, limitation }) {
  return {
    occupantId: occupant,
    messageText: null,
    messageSource: "unavailable",
    messageKind: kind,
    messageObservedAt: null,
    messageRevision: null,
    messageTruncated: false,
    messageStale: false,
    messageAvailable: false,
    messageRawExcerpt: null,
    messageLimitation: limitation,
  };
}

function readFailureLimitation(error, retained) {
  const message = `${error?.message ?? error}`;
  let limitation = "pane output read failed";
  if (/timed out/iu.test(message)) limitation = "pane output read timed out";
  else if (/(?:unsupported|method[_ -]?not[_ -]?found|unknown method|not implemented)/iu.test(message)) {
    limitation = "pane output read is unsupported";
  }
  return retained ? `${limitation}; retaining the previous preview` : limitation;
}

export async function refreshMessagePreviews({
  registry,
  snapshot,
  runtime,
  client,
  paneIds,
  now = new Date(),
  currentSnapshot = () => snapshot,
}) {
  const selected = paneIds === undefined ? undefined : new Set(paneIds);
  const targets = new Map();
  for (const session of registry) {
    const agent = agentFor(session, snapshot);
    if (!supportsMessagePreview(agent?.agent) || typeof agent.pane_id !== "string") continue;
    if (selected !== undefined && !selected.has(agent.pane_id)) continue;
    const occupant = messageOccupantId(agent);
    if (occupant === null) continue;
    targets.set(agent.pane_id, { kind: agent.agent, occupant });
  }

  const errors = [];
  let updated = 0;
  const entries = [...targets];
  let nextEntry = 0;
  const refreshNext = async () => {
    while (nextEntry < entries.length) {
      const entry = entries[nextEntry];
      nextEntry += 1;
      const [paneId, target] = entry;
      const previous = runtime.get(paneId);
      try {
        const read = await client.readPane(paneId, {
          lines: MAX_PANE_LINES,
          source: "recent_unwrapped",
        });
        if (read?.pane_id !== paneId || read.source !== "recent_unwrapped" || read.format !== "text") {
          throw new Error("unexpected Herdr pane read response");
        }
        const currentAgent = currentAgentForPane(currentSnapshot(), paneId);
        if (messageOccupantId(currentAgent) !== target.occupant) continue;
        const bounded = boundedUtf8Suffix(cleanPaneText(read.text));
        const preview = extractAssistantPreview({ kind: target.kind, text: bounded.text });
        const truncated = read.truncated === true || bounded.truncated;
        const latest = runtime.get(paneId);
        if (latest !== previous && latest?.occupantId !== undefined &&
            latest.occupantId !== target.occupant) continue;
        runtime.set(paneId, {
          ...(latest?.occupantId === target.occupant ? latest : previous ?? {}),
          occupantId: target.occupant,
          messageText: preview.text,
          messageSource: preview.source,
          messageKind: target.kind,
          messageObservedAt: now.toISOString(),
          messageRevision: Number.isInteger(read.revision) ? read.revision : null,
          messageTruncated: truncated,
          messageStale: false,
          messageAvailable: preview.available,
          messageRawExcerpt: preview.rawExcerpt,
          messageLimitation: truncated && !preview.available
            ? "pane output was truncated and contained no confidently bounded assistant message"
            : null,
        });
        updated += 1;
      } catch (error) {
        errors.push(`${paneId}: ${error.message}`);
        const currentAgent = currentAgentForPane(currentSnapshot(), paneId);
        if (messageOccupantId(currentAgent) !== target.occupant) continue;
        const latest = runtime.get(paneId);
        if (latest !== previous && latest?.occupantId !== undefined &&
            latest.occupantId !== target.occupant) continue;
        const retained = latest?.occupantId === target.occupant ? latest : previous;
        if (retained?.occupantId === target.occupant) {
          runtime.set(paneId, {
            ...retained,
            messageStale: true,
            messageLimitation: readFailureLimitation(error, true),
          });
        } else {
          runtime.set(paneId, unavailableRuntime({
            kind: target.kind,
            occupant: target.occupant,
            limitation: readFailureLimitation(error, false),
          }));
        }
        updated += 1;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(MAX_CONCURRENT_PANE_READS, entries.length) },
    () => refreshNext(),
  ));
  return { errors, updated };
}

export const MESSAGE_PREVIEW_LIMITS = {
  lines: MAX_PANE_LINES,
  bytes: MAX_PANE_BYTES,
  rawExcerptCodePoints: MAX_RAW_EXCERPT_CODE_POINTS,
  concurrentReads: MAX_CONCURRENT_PANE_READS,
};
