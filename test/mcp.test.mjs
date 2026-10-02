// Keep core tests runnable without installing the optional MCP module.
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../mcp/package.json', import.meta.url));
let installed = false;
try { require.resolve('@modelcontextprotocol/sdk/server/mcp.js'); installed = true; }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
if (installed) await import('../mcp/test/server.test.mjs');
else test('MCP stdio integration (install with npm --prefix mcp ci)', { skip: 'optional MCP dependencies not installed' }, () => {});
