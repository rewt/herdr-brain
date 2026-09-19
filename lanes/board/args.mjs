import { resolve } from "node:path";

function optionValue(args, name, requirement = "a value") {
  const index = args.indexOf(name);
  if (index >= 0 && (args[index + 1] === undefined || args[index + 1].startsWith("--"))) {
    throw new Error(`${name} requires ${requirement}`);
  }
  return index >= 0 ? args[index + 1] : undefined;
}

export function boardOptionsFromArgs(args, cwd = process.cwd()) {
  const repo = optionValue(args, "--repo", "a path");
  return {
    repoRoot: resolve(repo ?? cwd),
  };
}
