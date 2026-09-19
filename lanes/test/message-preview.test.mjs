import assert from "node:assert/strict";
import test from "node:test";

const NEGATIVE_CONTROL = process.env.LANE_TEST_NEGATIVE_CONTROL === "1";

function negativeControl(name) {
  if (NEGATIVE_CONTROL) assert.fail(`deliberately broken expectation: ${name}`);
}

async function previewApi() {
  return import("../board/message-preview.mjs");
}

const CODEX_RESPONSE = [
  "\u001b[32m• The parser now keeps the useful answer.\u001b[0m",
  "  It preserves wrapped lines and Unicode: café ✓.",
  "",
  "  A second paragraph remains part of the message.",
  "",
  "────────────────────────────────────────",
  "",
  "› Ask Codex to do anything",
  "",
  "  model-name high · example/repository · task",
].join("\n");

const CLAUDE_RESPONSE = [
  "❯ Explain the change",
  "",
  "⏺ Read(src/example.js)",
  "  ⎿  tool output only",
  "",
  "✻ Thinking…",
  "",
  "⏺ The change is complete and keeps the public boundary.",
  "  Wrapped detail remains attached, including naïve Unicode ✓.",
  "",
  "  The final paragraph is still substantive.",
  "",
  "────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────",
  "  ? for shortcuts",
].join("\n");

const ROUND_THREE_ANSWER_FIXTURES = [
  ["updated path", ["Updated the parser in board/message-preview.mjs"]],
  ["colon list", ["Added two tests:", "- parser case", "- adapter case"]],
  ["found cause", ["Found the cause: the boundary rule"]],
  ["two-word answer", ["Added it."]],
  ["read prose", ["Read the config and it sets worktree_root"]],
  ["search path", ["Search found three call sites in board/board.mjs"]],
  ["running duration", ["Running the full suite takes about 2 minutes."]],
  ["working duration", ["Working on the 30s timeout is the next step."]],
  ["worked clock", ["Worked through the 12:30 backlog entry and closed it."]],
  ["thinking duration", ["Thinking about caching saves 200 ms per read."]],
];

const REVIEW_PROSE_FIXTURES = [
  ...[
    "Working on the timeout... 30s is the current budget.",
    "Working through the queue while the timeout is reviewed.",
    "Working carefully through the remaining parser cases.",
    "Compacting context safely preserves the latest answer.",
    "Consolidating context now keeps the useful details.",
    "Worked through the queue... 12:30 is the final slot.",
    "Thinking about caching… the measured saving is 200 ms per read.",
    "Thinking about caching... 200 ms is saved per read.",
    "Running the full suite... 2 minutes is the current estimate.",
    "Searched for 5 patterns, read 2 files, listed 2 directories, and then summarized the result.",
    "Searched for 2 patterns, read 3 files before explaining the result.",
    "Ran 4 shell commands, listed 2 directories, and documented what changed.",
  ].map((answer) => ({ kinds: ["codex", "claude"], answer })),
  ...[
    "Added it.",
    "Updated the parser in board/message-preview.mjs.",
    "Applied the narrow boundary correction.",
    "Opened the file and verified the result.",
    "Read the config and confirmed the setting.",
    "Found the cause: the boundary rule.",
    "Ran into a compatibility issue.",
  ].map((answer) => ({ kinds: ["codex"], answer })),
  ...[
    "Read the guide and confirmed the behavior.",
    "Search found three relevant call sites.",
    "Save points remain available for recovery.",
    "Edit history shows the narrow correction.",
    "Bash output is summarized below.",
  ].map((answer) => ({ kinds: ["claude"], answer })),
  ...[
    "Would you like to run through the design together?",
    "Do you want to run the suite after this change?",
    "Do you want to allow callers to retry safely?",
    "Do you want to approve the documented workflow?",
    "Allow Codex to explain the result before proceeding.",
  ].map((answer) => ({ kinds: ["codex", "claude"], answer })),
];

const STATUS_FORMS = [
  "Working (1m 23s • esc to interrupt)",
  "Working (2m 04s • esc to interrupt)",
  "✻ Working… esc to interrupt",
  "Compacting context (1m 42s • esc to interrupt)",
  "Consolidating context… 48s · esc to interrupt",
  "Working (2m 04s)",
  "Worked [48s]",
  "Thinking… 30s",
  "Thinking... 12s",
  "Thinking... 30s left",
  "Running (45s)",
  "Working... 2m 04s · 1,024 tokens",
  "Thinking [12s | 3 files]",
  "Worked [48s] total",
  "Running (45s) remaining",
  "✻ Thinking... 30s · 1,024 tokens",
];

const KEYED_NEAR_MISS_TWINS = Object.freeze({
  codex: Object.freeze({
    "prompt-row": "› This quoted prompt glyph belongs to ordinary prose.",
    "result-marker": "⎿output names the result glyph in ordinary prose.",
    "question-shortcut-bar": "? for context is an ordinary question.",
  }),
  claude: Object.freeze({
    "prompt-row": "❯ This quoted prompt glyph belongs to ordinary prose.",
    "result-marker": "⎿output names the result glyph in ordinary prose.",
    "question-shortcut-bar": "? for context is an ordinary question.",
    "fast-mode-bar": "⏵⏵ describes the fast-mode glyph in ordinary prose.",
    "spinner-row": "✻ Thinking about the design remains ordinary prose.",
  }),
});

const ARBITRARY_TAIL_RULES = Object.freeze({
  codex: Object.freeze(["prompt-row", "result-marker", "question-shortcut-bar"]),
  claude: Object.freeze(["prompt-row", "result-marker", "question-shortcut-bar"]),
});

const CLAUDE_EXPANDED_CHROME_ROWS = [
  ["accept-edits mode", "⏵⏵ accept edits on"],
  ["accept-edits hint", "⏵⏵ accept edits on (shift+tab to cycle)"],
  ["bypass-permissions hint", "⏵⏵ bypass permissions on (shift+tab to cycle)"],
  ["two-word spinner", "✻ Compacting conversation…"],
  ["spinner timer", "✻ Thinking deeply… (30s)"],
  ["spinner timer and tokens", "✻ Working carefully... (2m 04s · 1,024 tokens)"],
];

const CLAUDE_EXPANDED_PROSE_NEAR_MISSES = [
  "⏵⏵ accept edits off remains ordinary prose.",
  "⏵⏵ bypass permissions are described here.",
  "✻ Compacting conversation… while the summary is written.",
  "✻ Thinking deeply… (the 30s timeout remains prose).",
];

function answerFixture(kind, lines) {
  const marker = kind === "codex" ? "•" : "⏺";
  return [
    `${marker} Superseded response.`,
    "",
    `${marker} ${lines[0]}`,
    ...lines.slice(1).map((line) => `  ${line}`),
  ].join("\n");
}

function tailTwin(example) {
  return `${example} followed by ordinary words.`;
}

function tailWidenedPattern(pattern) {
  return new RegExp(
    `${pattern.source.slice(0, -1)}(?:\\s+.*)?$`,
    pattern.flags.replaceAll("g", "").replaceAll("y", ""),
  );
}

function candidateTailFixture(kind, twin) {
  const marker = kind === "codex" ? "•" : "⏺";
  const renderedTwin = /^(?:•|⏺|●)\s+/u.test(twin) ? twin : `${marker} ${twin}`;
  return `${marker} Superseded response.\n\n${renderedTwin}`;
}

function candidateTailText(twin) {
  return twin.replace(/^(?:•|⏺|●)\s+/u, "").trimStart();
}

function continuationTailFixture(kind, twin) {
  const marker = kind === "codex" ? "•" : "⏺";
  const renderedTwin = twin.startsWith("  ") ? twin : `  ${twin}`;
  return `${marker} Current response.\n\n${renderedTwin}`;
}

function continuationTailText(twin) {
  return twin.startsWith("  ") ? twin.slice(2) : twin;
}

function statusTwin(status) {
  return `${status} is reproduced here as an ordinary prose example.`;
}

function chromeFixture(kind, example) {
  const marker = kind === "codex" ? "•" : "⏺";
  return /^(?:•|⏺|●)\s+/u.test(example)
    ? `${marker} Earlier response.\n\n${example}`
    : `${marker} Current response.\n\n${example}`;
}

for (const [name, lines] of ROUND_THREE_ANSWER_FIXTURES) {
  test(`cumulative answer corpus preserves ${name} in both adapters`, async () => {
    const { extractAssistantPreview } = await previewApi();
    for (const kind of ["codex", "claude"]) {
      assert.equal(
        extractAssistantPreview({ kind, text: answerFixture(kind, lines) }).text,
        lines.join("\n"),
        kind,
      );
    }
    negativeControl(`cumulative answer corpus: ${name}`);
  });
}

test("review prose corpus preserves every prior paired answer", async () => {
  const { extractAssistantPreview } = await previewApi();
  for (const { kinds, answer } of REVIEW_PROSE_FIXTURES) {
    for (const kind of kinds) {
      assert.equal(
        extractAssistantPreview({ kind, text: answerFixture(kind, [answer]) }).text,
        answer,
        `${kind}: ${answer}`,
      );
    }
  }
  negativeControl("review prose corpus");
});

test("adapter chrome tables define every rule and scope both status forms to candidate text", async () => {
  const {
    CODEX_CHROME_RULES,
    CLAUDE_CHROME_RULES,
    extractAssistantPreview,
  } = await previewApi();
  for (const [kind, rules] of [
    ["codex", CODEX_CHROME_RULES],
    ["claude", CLAUDE_CHROME_RULES],
  ]) {
    assert.ok(rules !== null && typeof rules === "object", `${kind}: chrome table`);
    assert.deepEqual(
      Object.entries(rules)
        .filter(([, rule]) => rule.candidateFirstLine)
        .map(([name]) => name),
      ["interrupt-status", "timed-status"],
      `${kind}: candidate-first-line scope`,
    );
    for (const [name, rule] of Object.entries(rules)) {
      assert.deepEqual(
        Object.keys(rule).sort(),
        ["candidateFirstLine", "example", "pattern"],
        `${kind}: ${name} fields`,
      );
      assert.ok(rule.pattern instanceof RegExp, `${kind}: ${name} pattern`);
      assert.ok(rule.pattern.source.startsWith("^"), `${kind}: ${name} start anchor`);
      assert.ok(rule.pattern.source.endsWith("$"), `${kind}: ${name} end anchor`);
      assert.equal(typeof rule.candidateFirstLine, "boolean", `${kind}: ${name} scope flag`);
      assert.equal(typeof rule.example, "string", `${kind}: ${name} example`);
      assert.ok(rule.example.length > 0, `${kind}: ${name} nonempty example`);
      assert.equal(rule.pattern.test(rule.example), true, `${kind}: ${name} example matches`);

      const chrome = extractAssistantPreview({ kind, text: chromeFixture(kind, rule.example) });
      const expectedChrome = /^(?:•|⏺|●)\s+/u.test(rule.example)
        ? "Earlier response."
        : "Current response.";
      assert.equal(chrome.text, expectedChrome, `${kind}: ${name} chrome`);
    }
  }
  negativeControl("adapter chrome table shape and scope");
});

test("bounded chrome rules mechanically generate body-first tail twins and mutation witnesses", async () => {
  const { CODEX_CHROME_RULES, CLAUDE_CHROME_RULES, extractAssistantPreview } = await previewApi();
  for (const [kind, rules] of [
    ["codex", CODEX_CHROME_RULES],
    ["claude", CLAUDE_CHROME_RULES],
  ]) {
    const arbitraryTailRules = new Set(ARBITRARY_TAIL_RULES[kind]);
    for (const [name, rule] of Object.entries(rules)) {
      if (arbitraryTailRules.has(name)) continue;
      const twin = tailTwin(rule.example);
      assert.ok(twin.startsWith(rule.example), `${kind}: ${name} body-first twin`);
      assert.equal(rule.pattern.test(twin), false, `${kind}: ${name} bounded tail`);
      assert.equal(
        tailWidenedPattern(rule.pattern).test(twin),
        true,
        `${kind}: ${name} tail mutation witness`,
      );
      assert.equal(
        extractAssistantPreview({ kind, text: candidateTailFixture(kind, twin) }).text,
        candidateTailText(twin),
        `${kind}: ${name} candidate tail twin`,
      );
      assert.equal(
        extractAssistantPreview({ kind, text: continuationTailFixture(kind, twin) }).text,
        `Current response.\n\n${continuationTailText(twin)}`,
        `${kind}: ${name} continuation tail twin`,
      );
    }
  }
  negativeControl("bounded chrome tail twins and mutations");
});

test("keyed chrome rules pair their leading glyphs with indented near misses", async () => {
  const { CODEX_CHROME_RULES, CLAUDE_CHROME_RULES, extractAssistantPreview } = await previewApi();
  for (const [kind, rules] of [
    ["codex", CODEX_CHROME_RULES],
    ["claude", CLAUDE_CHROME_RULES],
  ]) {
    const marker = kind === "codex" ? "•" : "⏺";
    const twins = KEYED_NEAR_MISS_TWINS[kind];
    assert.deepEqual(
      Object.keys(twins),
      kind === "codex"
        ? ["prompt-row", "result-marker", "question-shortcut-bar"]
        : ["prompt-row", "result-marker", "question-shortcut-bar", "fast-mode-bar", "spinner-row"],
      `${kind}: keyed near-miss coverage`,
    );
    for (const name of ARBITRARY_TAIL_RULES[kind]) {
      assert.ok(Object.hasOwn(twins, name), `${kind}: ${name} arbitrary-tail near miss`);
      assert.equal(
        rules[name].pattern.test(`${rules[name].example} arbitrary tail`),
        true,
        `${kind}: ${name} accepts an arbitrary tail`,
      );
    }
    for (const [name, twin] of Object.entries(twins)) {
      assert.ok(Object.hasOwn(rules, name), `${kind}: ${name} exists`);
      assert.equal(
        extractAssistantPreview({
          kind,
          text: `${marker} Current response.\n\n  ${twin}`,
        }).text,
        `Current response.\n\n${twin}`,
        `${kind}: ${name} keyed near miss`,
      );
    }
  }
  negativeControl("keyed chrome near-miss twins");
});

test("Claude expanded fast-mode and spinner rows stay chrome without consuming prose near misses", async () => {
  const { extractAssistantPreview } = await previewApi();
  for (const [name, row] of CLAUDE_EXPANDED_CHROME_ROWS) {
    assert.equal(extractAssistantPreview({
      kind: "claude",
      text: `⏺ Current response.\n\n  ${row}`,
    }).text, "Current response.", `${name}: continuation`);
    assert.equal(extractAssistantPreview({
      kind: "claude",
      text: `⏺ Current response.\n  Detail remains.\n  ${row}`,
    }).text, "Current response.\nDetail remains.", `${name}: inner row`);
  }
  for (const row of CLAUDE_EXPANDED_PROSE_NEAR_MISSES) {
    assert.equal(extractAssistantPreview({
      kind: "claude",
      text: `⏺ Current response.\n\n  ${row}`,
    }).text, `Current response.\n\n${row}`, `prose continuation: ${row}`);
    assert.equal(extractAssistantPreview({
      kind: "claude",
      text: `⏺ Current response.\n  Detail remains.\n  ${row}`,
    }).text, `Current response.\nDetail remains.\n${row}`, `prose inner row: ${row}`);
  }
  negativeControl("Claude expanded fast-mode and spinner rows");
});

test("chrome matcher skips flag-false rules for candidate first lines", async () => {
  const {
    CODEX_CHROME_RULES,
    CLAUDE_CHROME_RULES,
    matchingChromeRule,
  } = await previewApi();
  assert.equal(typeof matchingChromeRule, "function");
  for (const [marker, baseRules] of [
    ["•", CODEX_CHROME_RULES],
    ["⏺", CLAUDE_CHROME_RULES],
  ]) {
    let consultations = 0;
    const summaryPattern = new RegExp(
      `^(?:${marker}\\s+|\\s{2,})Summary: 3 files(?: were checked in ordinary prose\\.)?$`,
      "u",
    );
    const testPattern = summaryPattern.test.bind(summaryPattern);
    summaryPattern.test = (value) => {
      consultations += 1;
      return testPattern(value);
    };
    const summaryRule = {
      pattern: summaryPattern,
      candidateFirstLine: false,
      example: `${marker} Summary: 3 files`,
    };
    const rules = { ...baseRules, "summary-row": summaryRule };
    const candidate = `${marker} Summary: 3 files were checked in ordinary prose.`;
    assert.equal(matchingChromeRule(rules, candidate, [candidate], 0, true), null);
    const captured = "Summary: 3 files were checked in ordinary prose.";
    assert.equal(matchingChromeRule(rules, captured, [captured], 0, true), null);
    assert.equal(consultations, 0, `${marker}: flag-false first-line rule was consulted`);

    const continuation = "  Summary: 3 files";
    assert.equal(
      matchingChromeRule(rules, continuation, [continuation], 0),
      "summary-row",
    );
    assert.equal(consultations, 1, `${marker}: continuation rule was not consulted`);
  }
  negativeControl("candidate first-line matcher scope");
});

test("mid-sentence duration groups remain prose in candidate and continuation positions", async () => {
  const { extractAssistantPreview } = await previewApi();
  const answers = [
    "Running the full suite (about 2 minutes) confirmed the fix.",
    "Working through the parser (it took 30s) fixed the leak.",
    "Worked through the backlog [took 12 minutes] and closed it.",
    "Thinking through the cache (after 200 ms) clarified the result.",
    "Running the comparison [about 45s] revealed the cause.",
    "Worked on the documentation (for 2 minutes) before committing.",
    "Working with timers [after 30s] still preserves prose.",
    "Thinking about caching... 200 ms per read · 3 files were touched.",
    "Running the comparison… 2 minutes later | every row matched.",
    "Worked through the logs... 30s elapsed • then the answer was clear.",
    "Running... it finished after 45s",
    "Working... the first one timed out after 30s",
    "Worked (from 09:00 to 12:30)",
    "Worked [from 09:00 to 12:30]",
    "Running (see the 30s timeout)",
  ];
  for (const kind of ["codex", "claude"]) {
    const marker = kind === "codex" ? "•" : "⏺";
    for (const answer of answers) {
      assert.equal(
        extractAssistantPreview({ kind, text: answerFixture(kind, [answer]) }).text,
        answer,
        `${kind}: candidate: ${answer}`,
      );
      assert.equal(
        extractAssistantPreview({
          kind,
          text: `${marker} Current response.\n\n  ${answer}`,
        }).text,
        `Current response.\n\n${answer}`,
        `${kind}: continuation: ${answer}`,
      );
    }
  }
  negativeControl("mid-sentence duration prose positions");
});

test("Codex prompt glyph and colon-bearing context prose remain continuations", async () => {
  const { extractAssistantPreview } = await previewApi();
  assert.equal(extractAssistantPreview({
    kind: "codex",
    text: "• Follow this menu path:\n  › File › Settings opens the relevant panel.",
  }).text, "Follow this menu path:\n› File › Settings opens the relevant panel.");
  for (const [kind, marker] of [["codex", "•"], ["claude", "⏺"]]) {
    assert.equal(extractAssistantPreview({
      kind,
      text: `${marker} The quoted status remains explanatory.\n  Context left: 40% is what the display reported.`,
    }).text, "The quoted status remains explanatory.\nContext left: 40% is what the display reported.", kind);
  }
  negativeControl("prompt and context continuation prose");
});

test("trailing status fields stay paired with ordinary progress prose", async () => {
  const { extractAssistantPreview } = await previewApi();
  for (const status of [
    "Working... 2m 04s · 1,024 tokens",
    "Thinking [12s | 3 files]",
    "Worked [48s] total",
    "Running (45s) remaining",
  ]) {
    for (const kind of ["codex", "claude"]) {
      const marker = kind === "codex" ? "•" : "⏺";
      assert.equal(extractAssistantPreview({
        kind,
        text: `${marker} Current response.\n\n  ${status}`,
      }).text, "Current response.", `${kind}: ${status} continuation`);
      const answer = statusTwin(status);
      assert.equal(
        extractAssistantPreview({ kind, text: answerFixture(kind, [answer]) }).text,
        answer,
        `${kind}: ${status} twin`,
      );
      assert.equal(
        extractAssistantPreview({
          kind,
          text: `${marker} Current response.\n\n  ${answer}`,
        }).text,
        `Current response.\n\n${answer}`,
        `${kind}: ${status} continuation twin`,
      );
    }
  }
  negativeControl("paired trailing status fields");
});

test("every rendered status form and prose twin is classified in all three placements", async () => {
  const { extractAssistantPreview } = await previewApi();
  for (const [kind, marker] of [
    ["codex", "•"],
    ["claude", "⏺"],
    ["claude", "●"],
  ]) {
    for (const status of STATUS_FORMS) {
      assert.equal(
        extractAssistantPreview({
          kind,
          text: `${marker} Earlier response.\n\n${marker} ${status}`,
        }).text,
        "Earlier response.",
        `${kind}/${marker}: candidate status: ${status}`,
      );
      assert.equal(
        extractAssistantPreview({ kind, text: `${marker} ${status}` }).available,
        false,
        `${kind}/${marker}: lone status: ${status}`,
      );
      assert.equal(
        extractAssistantPreview({
          kind,
          text: `${marker} Current response.\n\n  ${status}`,
        }).text,
        "Current response.",
        `${kind}/${marker}: continuation status: ${status}`,
      );

      const twin = statusTwin(status);
      assert.equal(
        extractAssistantPreview({
          kind,
          text: `${marker} Superseded response.\n\n${marker} ${twin}`,
        }).text,
        twin,
        `${kind}/${marker}: candidate twin: ${status}`,
      );
      assert.equal(
        extractAssistantPreview({ kind, text: `${marker} ${twin}` }).text,
        twin,
        `${kind}/${marker}: lone twin: ${status}`,
      );
      assert.equal(
        extractAssistantPreview({
          kind,
          text: `${marker} Current response.\n\n  ${twin}`,
        }).text,
        `Current response.\n\n${twin}`,
        `${kind}/${marker}: continuation twin: ${status}`,
      );
    }
  }
  negativeControl("status forms and prose twins in every placement");
});

test("Codex approval rows allow any indentation while Claude approval rows require it", async () => {
  const { CODEX_CHROME_RULES, CLAUDE_CHROME_RULES, extractAssistantPreview } = await previewApi();
  const prompts = [
    "Would you like to run the following command?",
    "Do you want to run this command?",
    "Do you want to allow this action?",
    "Do you want to approve this command?",
    "Allow Codex to run this command?",
  ];
  for (const prompt of prompts) {
    assert.equal(CODEX_CHROME_RULES["approval-prompt"].pattern.test(prompt), true);
    assert.equal(CODEX_CHROME_RULES["approval-prompt"].pattern.test(`  ${prompt}`), true);
    assert.equal(CLAUDE_CHROME_RULES["approval-prompt"].pattern.test(prompt), false);
    assert.equal(CLAUDE_CHROME_RULES["approval-prompt"].pattern.test(`  ${prompt}`), true);
    assert.equal(extractAssistantPreview({
      kind: "codex",
      text: `• Current response.\n\n${prompt}`,
    }).text, "Current response.", `codex unindented: ${prompt}`);
    assert.equal(extractAssistantPreview({
      kind: "codex",
      text: `• Current response.\n\n  ${prompt}`,
    }).text, "Current response.", `codex indented: ${prompt}`);
    assert.equal(extractAssistantPreview({
      kind: "claude",
      text: `⏺ Current response.\n\n  ${prompt}`,
    }).text, "Current response.", `claude indented: ${prompt}`);
  }
  negativeControl("adapter approval-row asymmetry");
});

test("approval chrome requires a trailing question mark on the same rendered row", async () => {
  const { extractAssistantPreview } = await previewApi();
  for (const [kind, marker] of [["codex", "•"], ["claude", "⏺"]]) {
    for (const opening of [
      "Would you like to run the following command",
      "Do you want to allow this action",
    ]) {
      assert.equal(extractAssistantPreview({
        kind,
        text: `${marker} Current response.\n\n  ${opening}?`,
      }).text, "Current response.", `${kind}: single-row approval: ${opening}`);
      assert.equal(extractAssistantPreview({
        kind,
        text: `${marker} Current response.\n\n  ${opening}\n  after reviewing its effects?`,
      }).text, [
        "Current response.",
        "",
        opening,
        "after reviewing its effects?",
      ].join("\n"), `${kind}: wrapped approval prose: ${opening}`);
    }
  }
  negativeControl("single-row and wrapped approval pairing");
});

test("Codex preview extracts the last multiline assistant block before footer chrome", async () => {
  const { extractAssistantPreview } = await previewApi();
  const preview = extractAssistantPreview({ kind: "codex", text: CODEX_RESPONSE });
  assert.deepEqual(preview, {
    text: [
      "The parser now keeps the useful answer.",
      "It preserves wrapped lines and Unicode: café ✓.",
      "",
      "A second paragraph remains part of the message.",
    ].join("\n"),
    source: "assistant-preview",
    available: true,
    rawExcerpt: null,
  });
  negativeControl("Codex substantive preview");
});

test("Claude preview ignores echoed prompts and tools and preserves the final response", async () => {
  const { extractAssistantPreview } = await previewApi();
  const preview = extractAssistantPreview({ kind: "claude", text: CLAUDE_RESPONSE });
  assert.deepEqual(preview, {
    text: [
      "The change is complete and keeps the public boundary.",
      "Wrapped detail remains attached, including naïve Unicode ✓.",
      "",
      "The final paragraph is still substantive.",
    ].join("\n"),
    source: "assistant-preview",
    available: true,
    rawExcerpt: null,
  });
  negativeControl("Claude substantive preview");
});

test("status candidates and trailing terminal chrome never become assistant messages", async () => {
  const { extractAssistantPreview } = await previewApi();
  const cases = [
    ["codex", [
      "• The earlier answer remains visible.",
      "  Its second line remains attached.",
      "",
      "• Working (1m 23s • esc to interrupt)",
    ].join("\n"), "The earlier answer remains visible.\nIts second line remains attached."],
    ["codex", "• Useful answer.\n  ? for shortcuts", "Useful answer."],
    ["claude", "⏺ Useful answer.\n  12% context left", "Useful answer."],
    ["claude", "⏺ Useful answer.\n  1,024 tokens · $0.01", "Useful answer."],
    ["codex", [
      "• Useful answer.",
      "  Would you like to run the following command?",
      "  1. Yes, proceed",
      "  2. No, and tell Codex what to do differently",
    ].join("\n"), "Useful answer."],
    ["claude", [
      "⏺ Useful answer.",
      "  Do you want to allow this action?",
      "  1. Yes, proceed",
      "  2. No",
    ].join("\n"), "Useful answer."],
    ["claude", [
      "⏺ Useful answer.",
      "╭────────────────────────────╮",
      "│ ❯ Type another request     │",
      "╰────────────────────────────╯",
    ].join("\n"), "Useful answer."],
  ];
  for (const [kind, text, expected] of cases) {
    const preview = extractAssistantPreview({ kind, text });
    assert.equal(preview.text, expected, `${kind}: ${JSON.stringify(text)}`);
    assert.equal(preview.source, "assistant-preview");
  }
  for (const [kind, text] of [
    ["codex", "• Working (2m 04s • esc to interrupt)"],
    ["claude", "⏺ ✻ Working… esc to interrupt"],
  ]) {
    assert.equal(extractAssistantPreview({ kind, text }).available, false);
  }
  negativeControl("status and trailing chrome rejection");
});

test("interrupt affordances are status chrome while ordinary progress-verb prose remains substantive", async () => {
  const { extractAssistantPreview } = await previewApi();
  for (const [kind, text] of [
    ["codex", [
      "• The earlier answer remains current.",
      "",
      "• Compacting context (1m 42s • esc to interrupt)",
    ].join("\n")],
    ["claude", [
      "⏺ The earlier answer remains current.",
      "",
      "⏺ Consolidating context… 48s · esc to interrupt",
    ].join("\n")],
  ]) {
    assert.equal(
      extractAssistantPreview({ kind, text }).text,
      "The earlier answer remains current.",
      `${kind}: interrupt affordance`,
    );
  }
  for (const [kind, marker] of [["codex", "•"], ["claude", "⏺"]]) {
    const text = [
      `${marker} The earlier answer is obsolete.`,
      "",
      `${marker} Working with aliases (not progress chrome).`,
    ].join("\n");
    assert.equal(
      extractAssistantPreview({ kind, text }).text,
      "Working with aliases (not progress chrome).",
      `${kind}: ordinary progress-verb prose`,
    );
  }
  negativeControl("general interrupt chrome and progress-verb prose");
});

test("cumulative status corpus rejects only trailing rendered duration forms", async () => {
  const { extractAssistantPreview } = await previewApi();
  for (const kind of ["codex", "claude"]) {
    const marker = kind === "codex" ? "•" : "⏺";
    for (const status of STATUS_FORMS) {
      assert.equal(extractAssistantPreview({
        kind,
        text: `${marker} Earlier response.\n\n  ${status}`,
      }).text, "Earlier response.", `${kind}: ${status}`);
    }
  }
  negativeControl("cumulative trailing status forms");
});

test("ordinary answer verbs need corroborating evidence before they count as tool calls", async () => {
  const { extractAssistantPreview } = await previewApi();
  for (const word of ["Added", "Updated", "Applied", "Opened", "Read", "Found"]) {
    const preview = extractAssistantPreview({
      kind: "codex",
      text: `• Previous response.\n\n• ${word} safeguards around the public boundary.`,
    });
    assert.equal(preview.text, `${word} safeguards around the public boundary.`);
  }
  for (const word of ["Read", "Search", "Save", "Edit"]) {
    const preview = extractAssistantPreview({
      kind: "claude",
      text: `⏺ Previous response.\n\n⏺ ${word} results are now summarized clearly.`,
    });
    assert.equal(preview.text, `${word} results are now summarized clearly.`);
  }
  assert.equal(extractAssistantPreview({
    kind: "codex",
    text: "• Earlier response.\n\n• Ran npm test\n  └ All tests passed",
  }).text, "Earlier response.");
  assert.equal(extractAssistantPreview({
    kind: "claude",
    text: "⏺ Earlier response.\n\n⏺ Read(src/example.mjs)\n  ⎿ 42 lines",
  }).text, "Earlier response.");
  negativeControl("corroborated tool classification");
});

test("Claude result markers independently identify tool blocks and bound answer text", async () => {
  const { extractAssistantPreview } = await previewApi();
  assert.equal(extractAssistantPreview({
    kind: "claude",
    text: [
      "⏺ Earlier substantive response.",
      "",
      "⏺ Inspect repository state",
      "  ⎿ git status --short",
    ].join("\n"),
  }).text, "Earlier substantive response.");
  assert.equal(extractAssistantPreview({
    kind: "claude",
    text: [
      "⏺ A bounded answer remains useful.",
      "",
      "  ⎿ late tool output",
    ].join("\n"),
  }).text, "A bounded answer remains useful.");
  negativeControl("Claude result-marker tool evidence and boundary");
});

test("pending tool labels stay unavailable while prose remains substantive", async () => {
  const { extractAssistantPreview } = await previewApi();
  for (const label of [
    "Ran", "Explored", "Waited", "Searched", "Read", "Listed", "Viewed", "Called",
    "Edited", "Added", "Deleted", "Updated", "Applied", "Opened", "Found",
  ]) {
    const text = `• ${label}`;
    const preview = extractAssistantPreview({ kind: "codex", text });
    assert.equal(preview.available, false, JSON.stringify(text));
    assert.equal(preview.source, "unavailable", JSON.stringify(text));
  }
  for (const label of [
    "Read", "Write", "Edit", "Update", "Bash", "Glob", "Grep", "Search", "Task",
    "WebFetch", "WebSearch", "Skill", "TodoWrite", "AskUserQuestion", "NotebookEdit",
    "EnterPlanMode", "ExitPlanMode", "Save", "Fetch",
  ]) {
    const text = `⏺ ${label}`;
    const preview = extractAssistantPreview({ kind: "claude", text });
    assert.equal(preview.available, false, JSON.stringify(text));
    assert.equal(preview.source, "unavailable", JSON.stringify(text));
  }
  assert.equal(extractAssistantPreview({
    kind: "codex",
    text: "• Ran\n  git status --short",
  }).available, false);
  assert.equal(extractAssistantPreview({
    kind: "codex",
    text: "• Earlier response.\n\n• Ran into a compatibility issue.",
  }).text, "Ran into a compatibility issue.");
  negativeControl("pending tool labels distinguish prose");
});

test("a trailing partially rendered command does not resurrect an older answer", async () => {
  const { extractAssistantPreview } = await previewApi();
  for (const [kind, marker, tool] of [
    ["codex", "•", "Ran"],
    ["claude", "⏺", "Bash"],
  ]) {
    for (const pending of [`${tool}\n  git status --short`, `${tool} npm test`]) {
      const preview = extractAssistantPreview({
        kind,
        text: `${marker} Superseded response.\n\n${marker} ${pending}`,
      });
      assert.equal(preview.available, false, `${kind}: ${pending}`);
      assert.equal(preview.text, null, `${kind}: ${pending}`);
    }
  }
  negativeControl("pending command suppresses superseded fallback");
});

test("count-clause in-flight tool summaries end answer blocks in both adapters", async () => {
  const { extractAssistantPreview } = await previewApi();
  for (const toolSummary of [
    "Searched for 5 patterns, read 2 files, listed 2 directories, ran 55 shell commands",
    "Searched for 2 patterns, read 3 files",
    "Ran 4 shell commands, listed 2 directories, read 3 files",
  ]) {
    for (const [kind, marker] of [["codex", "•"], ["claude", "⏺"]]) {
      assert.equal(extractAssistantPreview({
        kind,
        text: `${marker} The answer is complete.\n\n  ${toolSummary}`,
      }).text, "The answer is complete.", `${kind}: ${toolSummary}`);
    }
  }
  negativeControl("bounded live in-flight tool summary");
});

test("indented quotes and bullets remain inside the assistant response", async () => {
  const { extractAssistantPreview } = await previewApi();
  assert.equal(extractAssistantPreview({
    kind: "codex",
    text: [
      "• The answer includes a nested list:",
      "  • first item",
      "  • second item",
      "",
      "› Ask Codex to do anything",
    ].join("\n"),
  }).text, "The answer includes a nested list:\n• first item\n• second item");
  assert.equal(extractAssistantPreview({
    kind: "claude",
    text: [
      "⏺ The answer quotes the important line:",
      "  > preserve this quoted text",
      "  and this explanation.",
      "",
      "❯ ",
    ].join("\n"),
  }).text, "The answer quotes the important line:\n> preserve this quoted text\nand this explanation.");
  negativeControl("indented response markers");
});

test("directory trees and tables remain content while pure composer frames stay boundaries", async () => {
  const { extractAssistantPreview } = await previewApi();
  assert.equal(extractAssistantPreview({
    kind: "codex",
    text: [
      "• The files are:",
      "  ├── src",
      "  │   └── index.mjs",
      "  └── test",
    ].join("\n"),
  }).text, [
    "The files are:",
    "├── src",
    "│   └── index.mjs",
    "└── test",
  ].join("\n"));
  assert.equal(extractAssistantPreview({
    kind: "claude",
    text: [
      "⏺ Results:",
      "  │ Name │ State │",
      "  │ parser │ pass │",
    ].join("\n"),
  }).text, "Results:\n│ Name │ State │\n│ parser │ pass │");
  assert.equal(extractAssistantPreview({
    kind: "claude",
    text: [
      "⏺ Useful answer.",
      "╭────────────────────────────╮",
      "│ ❯ Type another request     │",
      "╰────────────────────────────╯",
    ].join("\n"),
  }).text, "Useful answer.");
  assert.equal(extractAssistantPreview({
    kind: "codex",
    text: "• First paragraph.\n  \n  Second paragraph.",
  }).text, "First paragraph.\n\nSecond paragraph.");
  negativeControl("frame content and composer boundaries");
});

test("runs of bare hand-drawn tree markers remain answer content", async () => {
  const { extractAssistantPreview } = await previewApi();
  for (const [kind, marker] of [["codex", "•"], ["claude", "⏺"]]) {
    assert.equal(extractAssistantPreview({
      kind,
      text: [
        `${marker} The tree is:`,
        "  ├ root",
        "  └ child",
      ].join("\n"),
    }).text, "The tree is:\n├ root\n└ child", kind);
  }
  negativeControl("bare hand-drawn tree run");
});

test("tool-only, footer-only, and unknown formats stay unavailable with labeled raw output", async () => {
  const { extractAssistantPreview, refreshMessagePreviews } = await previewApi();
  for (const [kind, text] of [
    ["codex", "• Ran npm test\n  └ 2 tests passed\n\n› Ask Codex to do anything\nmodel-name high · example"],
    ["claude", "⏺ Bash(npm test)\n  ⎿ 2 tests passed\n\n❯ \n? for shortcuts"],
    ["codex", "────────────────────────\n› Ask Codex to do anything\nmodel-name high · example"],
    ["claude", "────────────────────────\n❯ \n? for shortcuts"],
    ["codex", "shell$ printf 'done'\ndone"],
  ]) {
    const preview = extractAssistantPreview({ kind, text });
    assert.equal(preview.text, null);
    assert.equal(preview.source, "unavailable");
    assert.equal(preview.available, false);
    assert.equal(preview.rawExcerpt?.source, "pane-output");
    assert.ok(preview.rawExcerpt?.text.length > 0);
  }
  let unsupportedReads = 0;
  const unsupportedRuntime = new Map();
  await refreshMessagePreviews({
    registry: [{ name: "preview-agent", workspace: "workspace-1" }],
    snapshot: {
      agents: [{
        agent: "other-agent",
        name: "preview-agent",
        pane_id: "pane-1",
        workspace_id: "workspace-1",
      }],
      workspaces: [{ workspace_id: "workspace-1", label: "workspace-1" }],
    },
    runtime: unsupportedRuntime,
    client: { async readPane() { unsupportedReads += 1; } },
  });
  assert.equal(unsupportedReads, 0);
  assert.equal(unsupportedRuntime.size, 0);
  negativeControl("unavailable raw pane fallback");
});

test("bounded reads expose truncation and keep stale previews on read errors", async () => {
  const { refreshMessagePreviews } = await previewApi();
  const session = { name: "preview-agent", workspace: "workspace-1" };
  const agent = {
    agent: "codex",
    agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: "session-1" },
    name: "preview-agent",
    pane_id: "pane-1",
    workspace_id: "workspace-1",
  };
  const snapshot = {
    agents: [agent],
    workspaces: [{ workspace_id: "workspace-1", label: "workspace-1" }],
  };
  const runtime = new Map();
  const calls = [];
  const client = {
    async readPane(paneId, options) {
      calls.push({ paneId, options });
      return {
        pane_id: paneId,
        workspace_id: "workspace-1",
        tab_id: "tab-1",
        source: "recent_unwrapped",
        format: "text",
        text: "• Ran a tool\n  └ output only\n› prompt",
        revision: 41,
        truncated: true,
      };
    },
  };
  const first = await refreshMessagePreviews({
    registry: [session], snapshot, runtime, client, now: new Date("2026-09-10T12:00:00Z"),
  });
  assert.deepEqual(calls, [{ paneId: "pane-1", options: { lines: 200, source: "recent_unwrapped" } }]);
  assert.deepEqual(first.errors, []);
  assert.equal(runtime.get("pane-1").messageSource, "unavailable");
  assert.equal(runtime.get("pane-1").messageTruncated, true);
  assert.match(runtime.get("pane-1").messageLimitation, /truncated.*no confidently bounded assistant message/iu);

  client.readPane = async () => ({
    pane_id: "pane-1",
    workspace_id: "workspace-1",
    tab_id: "tab-1",
    source: "recent_unwrapped",
    format: "text",
    text: `${"x".repeat(17_000)}\n• A bounded answer remains visible.`,
    revision: 42,
    truncated: false,
  });
  await refreshMessagePreviews({
    registry: [session], snapshot, runtime, client, now: new Date("2026-09-10T12:00:00.500Z"),
  });
  assert.equal(runtime.get("pane-1").messageText, "A bounded answer remains visible.");
  assert.equal(runtime.get("pane-1").messageTruncated, true);

  runtime.set("pane-1", {
    ...runtime.get("pane-1"),
    messageText: "Earlier useful answer",
    messageSource: "assistant-preview",
    messageAvailable: true,
    messageObservedAt: "2026-09-10T12:00:00.000Z",
  });
  client.readPane = async () => { throw new Error("read unavailable"); };
  const second = await refreshMessagePreviews({
    registry: [session], snapshot, runtime, client, now: new Date("2026-09-10T12:00:01Z"),
  });
  assert.match(second.errors[0], /pane-1: read unavailable/);
  assert.equal(runtime.get("pane-1").messageText, "Earlier useful answer");
  assert.equal(runtime.get("pane-1").messageStale, true);
  negativeControl("truncated and stale read metadata");
});

test("pane reads are concurrency bounded and limitations distinguish timeout from unsupported reads", async () => {
  const { refreshMessagePreviews } = await previewApi();
  const registry = [];
  const agents = [];
  for (let index = 0; index < 9; index += 1) {
    registry.push({ name: `preview-agent-${index}`, workspace: "workspace-1" });
    agents.push({
      agent: "codex",
      agent_session: {
        agent: "codex", kind: "id", source: "herdr:codex", value: `session-${index}`,
      },
      name: `preview-agent-${index}`,
      pane_id: `pane-${index}`,
      workspace_id: "workspace-1",
    });
  }
  const snapshot = {
    agents,
    workspaces: [{ workspace_id: "workspace-1", label: "workspace-1" }],
  };
  const runtime = new Map();
  let active = 0;
  let maximumActive = 0;
  await refreshMessagePreviews({
    registry,
    snapshot,
    runtime,
    client: {
      async readPane(paneId) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return {
          pane_id: paneId,
          source: "recent_unwrapped",
          format: "text",
          text: "• A bounded concurrent answer.",
          revision: 1,
          truncated: false,
        };
      },
    },
  });
  assert.equal(maximumActive, 4);
  assert.equal(runtime.size, 9);

  const failureRuntime = new Map();
  await refreshMessagePreviews({
    registry: registry.slice(0, 2),
    snapshot,
    runtime: failureRuntime,
    client: {
      async readPane(paneId) {
        if (paneId === "pane-0") throw new Error("Herdr request timed out: pane.read");
        throw new Error("Herdr method_not_found: pane.read is unsupported");
      },
    },
  });
  assert.match(failureRuntime.get("pane-0").messageLimitation, /timed out/iu);
  assert.match(failureRuntime.get("pane-1").messageLimitation, /unsupported/iu);
  assert.notEqual(
    failureRuntime.get("pane-0").messageLimitation,
    failureRuntime.get("pane-1").messageLimitation,
  );
  negativeControl("bounded pane read concurrency and limitations");
});

test("fallback occupant identity survives output revisions for stale retention", async () => {
  const { refreshMessagePreviews } = await previewApi();
  const session = { name: "preview-agent", workspace: "workspace-1" };
  const agent = {
    agent: "codex",
    name: "preview-agent",
    pane_id: "pane-1",
    revision: 1,
    workspace_id: "workspace-1",
  };
  const snapshot = {
    agents: [agent],
    workspaces: [{ workspace_id: "workspace-1", label: "workspace-1" }],
  };
  const runtime = new Map();
  await refreshMessagePreviews({
    registry: [session],
    snapshot,
    runtime,
    client: { async readPane() {
      return {
        pane_id: "pane-1",
        source: "recent_unwrapped",
        format: "text",
        text: "• Earlier useful answer.",
        revision: 1,
        truncated: false,
      };
    } },
  });
  agent.revision = 2;
  await refreshMessagePreviews({
    registry: [session],
    snapshot,
    runtime,
    client: { async readPane() { throw new Error("read unavailable"); } },
  });
  assert.equal(runtime.get("pane-1").messageText, "Earlier useful answer.");
  assert.equal(runtime.get("pane-1").messageStale, true);
  negativeControl("revision-independent fallback occupant identity");
});

test("a late pane read is discarded after the agent occupant changes", async () => {
  const { refreshMessagePreviews } = await previewApi();
  let finishRead;
  const readPending = new Promise((resolve) => { finishRead = resolve; });
  const session = { name: "preview-agent", workspace: "workspace-1" };
  const agent = {
    agent: "codex",
    agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: "old-session" },
    name: "preview-agent",
    pane_id: "pane-1",
    workspace_id: "workspace-1",
  };
  const snapshot = {
    agents: [agent],
    workspaces: [{ workspace_id: "workspace-1", label: "workspace-1" }],
  };
  const runtime = new Map();
  const reading = refreshMessagePreviews({
    registry: [session],
    snapshot,
    runtime,
    client: { readPane: () => readPending },
  });
  agent.agent_session = { agent: "codex", kind: "id", source: "herdr:codex", value: "replacement-session" };
  finishRead({
    pane_id: "pane-1",
    workspace_id: "workspace-1",
    tab_id: "tab-1",
    source: "recent_unwrapped",
    format: "text",
    text: "• This belongs to the previous occupant.",
    revision: 42,
    truncated: false,
  });
  const result = await reading;
  assert.deepEqual(result.errors, []);
  assert.equal(runtime.has("pane-1"), false);
  negativeControl("replaced pane occupant discard");
});

test("a late pane read is discarded when only the terminal identity changes", async () => {
  const { refreshMessagePreviews } = await previewApi();
  let finishRead;
  const readPending = new Promise((resolve) => { finishRead = resolve; });
  const session = { name: "preview-agent", workspace: "workspace-1" };
  const agent = {
    agent: "codex",
    agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: "shared-session" },
    name: "preview-agent",
    pane_id: "pane-1",
    terminal_id: "old-terminal",
    workspace_id: "workspace-1",
  };
  const snapshot = {
    agents: [agent],
    workspaces: [{ workspace_id: "workspace-1", label: "workspace-1" }],
  };
  const runtime = new Map();
  const reading = refreshMessagePreviews({
    registry: [session], snapshot, runtime,
    client: { readPane: () => readPending },
  });
  agent.terminal_id = "new-terminal";
  finishRead({
    pane_id: "pane-1", source: "recent_unwrapped", format: "text",
    text: "• Old terminal answer.", revision: 42, truncated: false,
  });
  const result = await reading;
  assert.deepEqual(result.errors, []);
  assert.equal(runtime.has("pane-1"), false);
  negativeControl("late pane read cannot cross terminal replacement");
});

test("a same-occupant match is not lost to a pending pane preview writeback", async () => {
  const { messageOccupantId, refreshMessagePreviews } = await previewApi();
  const agent = {
    agent: "codex", name: "preview-agent", pane_id: "pane-1", workspace_id: "workspace-1",
    terminal_id: "same-terminal",
    agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: "same-session" },
  };
  const snapshot = {
    agents: [agent],
    workspaces: [{ workspace_id: "workspace-1", label: "workspace-1" }],
  };
  const oldMatchAt = "2026-09-13T12:00:00.000Z";
  const latestMatchAt = "2026-09-13T12:00:01.000Z";
  const runtime = new Map([["pane-1", {
    occupantId: messageOccupantId(agent), tripwire: "OLD", observedAt: oldMatchAt,
  }]]);
  let finishRead;
  const readPending = new Promise((resolvePromise) => { finishRead = resolvePromise; });
  const reading = refreshMessagePreviews({
    registry: [{ name: agent.name, workspace: agent.workspace_id }],
    snapshot, runtime, client: { readPane: () => readPending },
  });
  runtime.set("pane-1", { ...runtime.get("pane-1"), tripwire: "LATEST", observedAt: latestMatchAt });
  finishRead({
    pane_id: "pane-1", source: "recent_unwrapped", format: "text",
    text: "• New preview\n", revision: 2, truncated: false,
  });
  const result = await reading;
  assert.equal(result.updated, 1);
  assert.equal(runtime.get("pane-1").messageText, "New preview");
  assert.equal(runtime.get("pane-1").tripwire, "LATEST");
  assert.equal(runtime.get("pane-1").observedAt, latestMatchAt);
  negativeControl("same-occupant match survives direct preview writeback");
});

test("a failed pane read retains a newer same-occupant match", async () => {
  const { messageOccupantId, refreshMessagePreviews } = await previewApi();
  const agent = {
    agent: "codex", name: "preview-agent", pane_id: "pane-1", workspace_id: "workspace-1",
    terminal_id: "same-terminal",
    agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value: "same-session" },
  };
  const snapshot = {
    agents: [agent],
    workspaces: [{ workspace_id: "workspace-1", label: "workspace-1" }],
  };
  const runtime = new Map([["pane-1", {
    occupantId: messageOccupantId(agent),
    messageText: "Previous answer", messageSource: "assistant-preview", messageAvailable: true,
    tripwire: "OLD", observedAt: "2026-09-13T12:00:00.000Z",
  }]]);
  let failRead;
  const readPending = new Promise((resolvePromise, rejectPromise) => { failRead = rejectPromise; });
  const reading = refreshMessagePreviews({
    registry: [{ name: agent.name, workspace: agent.workspace_id }],
    snapshot, runtime, client: { readPane: () => readPending },
  });
  const latestMatchAt = "2026-09-13T12:00:01.000Z";
  runtime.set("pane-1", { ...runtime.get("pane-1"), tripwire: "LATEST", observedAt: latestMatchAt });
  failRead(new Error("fixture read failed"));
  const result = await reading;
  assert.equal(result.updated, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(runtime.get("pane-1").messageText, "Previous answer");
  assert.equal(runtime.get("pane-1").messageStale, true);
  assert.equal(runtime.get("pane-1").tripwire, "LATEST");
  assert.equal(runtime.get("pane-1").observedAt, latestMatchAt);
  negativeControl("same-occupant match survives failed preview writeback");
});
