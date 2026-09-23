#!/usr/bin/env node
// A Herdr plugin entrypoint is a normal terminal command. The host owns its
// tab and supplies binary/socket/workspace context; no private Herdr UI imports.
// Keep the existing console config until a project-catalog migration is agreed.
if (!process.argv.includes('--modern')) process.argv.push('--modern');
await import('./app.mjs');
