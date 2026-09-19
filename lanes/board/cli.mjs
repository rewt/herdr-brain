#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { boardOptionsFromArgs } from "./args.mjs";
import { runOnce } from "./board.mjs";

const args = process.argv.slice(2);
let options;
try {
  options = boardOptionsFromArgs(args);
} catch (error) {
  process.stderr.write(`lane board: ${error.message}\n`);
  process.exit(1);
}
const { repoRoot } = options;
const configPath = process.env.LANE_CONFIG ?? resolve(repoRoot, ".lane.json");
let config = {};
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch {
  // Every lane configuration key is optional.
}
if (args.includes("--once")) {
  try {
    await runOnce({ repoRoot, config });
  } catch (error) {
    process.stderr.write(`lane board: ${error.message}\n`);
    process.exit(1);
  }
} else {
  process.stderr.write("lane board: interactive mode is started through the board package\n");
  process.exit(1);
}
