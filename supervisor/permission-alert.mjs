#!/usr/bin/env node
// Detached, argv-only delivery of an already-fsynced cap/debounce intent.
// This process has no connection to the native permission decision streams.
try {
  const { operatorAlert } = await import('../brain/lib/steward.mjs');
  const { payload, config } = JSON.parse(process.argv[2]);
  await operatorAlert(payload, config);
} catch { process.exitCode = 1; }
