// A real SDK client, entirely offline after npm ci, in a brand-new scratch project.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-mcp-demo-'));
const client = new Client({ name: 'record-scratch-demo', version: '0.1.0' });
const timer = setTimeout(() => { client.close().catch(() => {}); }, 30000);
const options = { timeout: 5000 };
const env = { HOME: root, TMPDIR: root, ORG_ACTOR: 'arch14-demo-agent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const transcript = [];
try {
  const git = spawnSync('git', ['init', '--initial-branch=main'], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5000 });
  assert.equal(git.status, 0, git.stderr);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(import.meta.dirname, 'server.mjs')], cwd: root, env, stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr.on('data', chunk => { diagnostics += chunk; });
  await client.connect(transport, options);
  async function call(name, input) {
    const result = await client.callTool({ name: `record_${name}`, ...(input === undefined ? {} : { arguments: input }) }, undefined, options);
    assert.ok(!result.isError, JSON.stringify(result));
    transcript.push({ tool: `record_${name}`, argumentsOmitted: input === undefined, output: result.content[0].text.split('\n')[0] });
    return result;
  }
  const tools = (await client.listTools({}, options)).tools.map(tool => tool.name);
  const resources = (await client.listResources({}, options)).resources.map(resource => resource.uri);
  assert.equal((await call('ready')).structuredContent.items.length, 0);
  await call('add', { title: 'Scratch outcome', goal: true });
  await call('add', { title: 'Deliver the scratch proof', parent: 'G-1', role: 'engineer' });
  await call('ask', { question: 'Use the scratch proof?', parent: 'G-1', category: 'design', recommend: 'yes', why: 'An offline demonstration.', wait: true });
  await call('answer', { id: 'HUM-1', answer: 'yes' });
  assert.equal((await call('ready')).structuredContent.items[0].id, 'ENG-1');
  await call('show', { id: 'ENG-1' });
  await call('start', { id: 'ENG-1', harness: 'sdk-demo', model: 'metadata-only' });
  const report = '---\nrun: R-1\noutcome: done\nheadline: The scratch proof is complete\nsummary: A real MCP client completed the workflow offline.\n---\n';
  await call('check', { report });
  await call('ingest', { report });
  const snapshot = await client.readResource({ uri: 'record://snapshot' }, options);
  assert.match(snapshot.contents[0].text, /A real MCP client completed the workflow offline/);
  assert.equal(diagnostics, '');
  assert.equal(fs.existsSync(path.join(root, '.config')), false);
  console.log(JSON.stringify({ client: '@modelcontextprotocol/sdk 1.31.0 Client + StdioClientTransport',
    project: root, tools, resources, transcript, snapshotVerified: true, scratchRemovedOnExit: true }, null, 2));
} finally {
  clearTimeout(timer);
  await client.close();
  fs.rmSync(root, { recursive: true, force: true });
}
