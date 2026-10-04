#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createCli } from './cli.mjs';

const USAGE = `Usage: node mcp/server.mjs [--cwd PROJECT] [--org RECORD_DIR] [--actor NAME]
Foreground MCP server over stdio. Defaults to the invoking project, CLI record
discovery and ORG_ACTOR (or record-mcp). No daemon or harness configuration writes.
Install once: npm --prefix mcp ci
`;

const text = z.string().min(1);
const optionalText = text.optional();
const strings = z.array(text).optional();
const pairs = z.record(text, z.union([z.string(), z.number(), z.boolean()])).optional();
const flags = (input, mapping) => Object.entries(mapping).flatMap(([key, option]) => {
  const value = input[key];
  if (value === undefined || value === false) return [];
  if (value === true) return [`--${option}`];
  if (Array.isArray(value)) return value.map(v => `--${option}=${v}`);
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `--${option}=${k}=${v}`);
  return [`--${option}=${value}`];
});

async function main() {
  const { values } = parseArgs({ options: {
    cwd: { type: 'string' }, org: { type: 'string' }, actor: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { process.stderr.write(USAGE); return; }
  const cwd = path.resolve(values.cwd ?? process.cwd());
  const env = { ...process.env, ORG_ACTOR: values.actor ?? (process.env.ORG_ACTOR?.trim() || 'record-mcp') };
  if (!env.ORG_ACTOR.trim()) throw new Error('--actor must name the caller');
  if (values.org !== undefined) env.ORG_DIR = path.resolve(cwd, values.org);
  const cli = createCli({ cwd, env });
  const server = new McpServer({ name: 'herdr-record', version: '0.1.0' }, {
    instructions: 'Read record://snapshot for context and record_lessons for active lessons (optionally filtered by project-relative path or exact module). Use record_ready to find work, record_show for details, and record_start to record a run and receive its brief. Finish with record_check then record_ingest using Markdown report text or a local file. Question policy and validation belong to the record CLI; asking with wait keeps the question pending. Answers are attributed to the configured caller; answer only when authorized. The server does not launch workers or models. Interrupted writes may have committed; inspect before retrying.',
  });
  function tool(name, description, shape, readOnly, callback, idempotent = readOnly) {
    server.registerTool(name, {
      description, inputSchema: z.object(shape).strict(),
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: idempotent, openWorldHint: false },
    }, async (input, extra) => {
      try {
        const result = await callback(input, extra.signal);
        return { content: [
          { type: 'text', text: result.stdout || '(no output)' },
          ...(result.stderr ? [{ type: 'text', text: `CLI diagnostics:\n${result.stderr}` }] : []),
        ], ...(result.data ? { structuredContent: result.data } : {}) };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
  }
  tool('record_ready', 'Ready work derived by record status, in CLI order; excludes goals and operator questions. Optional exact role filter. Budgets and alignment are advisory.',
    { role: optionalText }, true, async ({ role }, signal) => {
      const result = await cli.run(['status', '--json'], signal);
      const status = JSON.parse(result.stdout);
      const data = { org: status.org, events: status.events, as_of: status.as_of,
        items: status.items.filter(i => i.kind === 'work' && i.status === 'ready' && i.role !== 'human' && (role === undefined || i.role === role)) };
      return { ...result, stdout: JSON.stringify(data, null, 2), data };
    });
  tool('record_show', 'Show an item or run, including history and reports; json returns the CLI JSON view.',
    { id: text, json: z.boolean().optional() }, true,
    (input, signal) => cli.run(['show', ...flags(input, { json: 'json' }), '--', input.id], signal));
  tool('record_lessons', 'Read active lessons by default, with optional project-relative path, exact module, scope and lifecycle state filters. Text is bounded; json returns every match and its evidence.',
    { path: optionalText, module: optionalText, scope: z.enum(['project', 'fleet', 'framework']).optional(),
      state: z.enum(['proposed', 'active', 'retired', 'superseded', 'all']).optional(), json: z.boolean().optional() }, true,
    (input, signal) => cli.run(['lessons', ...flags(input, { path: 'path', module: 'module', scope: 'scope', state: 'state', json: 'json' })], signal));
  tool('record_add', 'Add work or a goal through the CLI. IDs, parents, blockers and metadata are validated there.',
    { title: text, goal: z.boolean().optional(), role: optionalText, capability: optionalText, parent: optionalText,
      blocked_by: strings, accept: strings, priority: z.number().finite().optional(), budget: pairs, meta: pairs }, false,
    (input, signal) => cli.run(['add', ...flags(input, { goal: 'goal', role: 'role', capability: 'capability', parent: 'parent',
      blocked_by: 'blocked-by', accept: 'accept', priority: 'priority', budget: 'budget', meta: 'meta' }), '--', input.title], signal));
  tool('record_ask', 'Ask a categorized question with a recommendation and rationale. CLI approval policy applies; wait always leaves it for the operator.',
    { question: text, parent: text, category: text, recommend: text, why: text, wait: z.boolean().optional(),
      on_yes: optionalText, on_no: optionalText, memo: optionalText, blocks: strings, priority: z.number().finite().optional() }, false,
    (input, signal) => cli.run(['ask', ...flags(input, { parent: 'parent', category: 'category', recommend: 'recommend', why: 'why',
      wait: 'wait', on_yes: 'on-yes', on_no: 'on-no', memo: 'memo', blocks: 'blocks', priority: 'priority' }), '--', input.question], signal));
  tool('record_answer', 'Record an authorized answer as the configured caller. No keeps dependents blocked. overrule must change an existing answer.',
    { id: text, answer: text, note: optionalText, overrule: z.boolean().optional() }, false,
    (input, signal) => cli.run(['answer', ...flags(input, { note: 'note', overrule: 'overrule' }), '--', input.id, input.answer], signal));
  tool('record_start', 'Record a run, create its brief/report paths and return the full brief. Does not start a worker or model. Route and harness metadata stay opaque.',
    { id: text, route: optionalText, route_config: optionalText, harness: optionalText, model: optionalText, effort: optionalText,
      workspace: optionalText, report: optionalText, escalation: z.boolean().optional(), serves: z.string().optional(), meta: pairs }, false,
    async (input, signal) => {
      const result = await cli.run(['start', ...flags(input, { route: 'route', route_config: 'route-config', harness: 'harness', model: 'model',
        effort: 'effort', workspace: 'workspace', report: 'report', escalation: 'escalation', serves: 'serves', meta: 'meta' }), '--', input.id], signal);
      const runId = result.stdout.match(/^(R-\d+) started /)?.[1];
      if (!runId) throw new Error(`Run may have started; inspect before retrying. Unexpected CLI output:\n${result.stdout}\n${result.stderr}`);
      let brief;
      try { brief = await cli.run(['brief', '--', runId], signal); }
      catch (error) { throw new Error(`${runId} started, but its brief could not be read. Inspect before retrying.\n${error.message}`); }
      return { stdout: `${result.stdout}\n${brief.stdout}`, stderr: result.stderr + brief.stderr };
    });
  const reportShape = { file: optionalText, report: text.describe('Full Markdown report with YAML front matter; provide this or file, exclusively.').optional() };
  tool('record_check', 'Validate a Markdown report without recording it. Provide exactly one of report text or a file path relative to the project.',
    reportShape, true, (input, signal) => cli.report('check', input, signal));
  tool('record_ingest', 'Record a report and its proposals through the CLI. Identical reports are idempotent; a different report for the same run is refused. Provide exactly one of report text or file.',
    { ...reportShape, run: optionalText }, false, (input, signal) => cli.report('ingest', input, signal), true);
  server.registerResource('snapshot', 'record://snapshot', {
    description: 'Current record snapshot as Markdown for a fresh agent; rebuilt through the CLI on every read.', mimeType: 'text/markdown',
  }, async (uri, extra) => {
    const result = await cli.run(['snapshot'], extra.signal);
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: result.stdout }] };
  });
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    await cli.close();
    await server.close();
  }
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  process.stdin.once('end', close);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const receive = transport.onmessage;
  // Normalize valid name-only ready calls before the SDK validates against the
  // advertised strict object schema, preserving its optional role filter.
  transport.onmessage = (message, extra) => {
    if (message.method === 'tools/call' && ['record_ready', 'record_lessons'].includes(message.params?.name) && message.params.arguments === undefined) {
      message = { ...message, params: { ...message.params, arguments: {} } };
    }
    receive(message, extra);
  };
}

main().catch(error => { process.stderr.write(`record MCP: ${error.message}\n`); process.exitCode = 1; });
