import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SESSION_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|legacy-[0-9a-f]{64})$/iu;
const LEGACY_REQUIRED_STRINGS = ["name", "workspace", "lane", "role", "report"];
const NEW_REQUIRED_STRINGS = [
  "session_id", "repo_id", "root_id", "repo", "topic", "name", "workspace", "pane",
  "server", "lane", "role", "goal", "report", "created_at",
];

export function registryPathFor(repoRoot, config = {}) {
  const configured = config.registry ?? ".lane/sessions.json";
  return isAbsolute(configured) ? resolve(configured) : resolve(repoRoot, configured);
}

export function registryDirectoryFor(registryPath) {
  return `${registryPath}.d`;
}

export function newSessionId() {
  return randomUUID();
}

function parseJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateCommon(session, label) {
  for (const key of LEGACY_REQUIRED_STRINGS) {
    if (typeof session?.[key] !== "string" || session[key] === "") {
      throw new Error(`${label} needs a non-empty ${key}`);
    }
  }
  if (session.tripwires !== undefined && !Array.isArray(session.tripwires)) {
    throw new Error(`${label} tripwires must be an array`);
  }
  if ((session.deadline !== null && typeof session.deadline !== "string") || typeof session.done !== "boolean") {
    throw new Error(`${label} needs deadline (string or null) and done (boolean)`);
  }
  if ((session.tripwires ?? []).some((pattern) => typeof pattern !== "string" || pattern === "")) {
    throw new Error(`${label} tripwires must contain non-empty strings`);
  }
  for (const key of ["agent_session_id", "terminal_id"]) {
    if (session[key] !== undefined && (typeof session[key] !== "string" || session[key] === "")) {
      throw new Error(`${label} ${key} must be a non-empty string when present`);
    }
  }
}

function validateNew(session, label) {
  validateCommon(session, label);
  for (const key of NEW_REQUIRED_STRINGS) {
    if (typeof session?.[key] !== "string" || session[key] === "") {
      throw new Error(`${label} needs a non-empty ${key}`);
    }
  }
  if (!SESSION_ID.test(session.session_id)) throw new Error(`${label} has an invalid session_id`);
  if (session.brief !== null && (typeof session.brief !== "string" || session.brief === "")) {
    throw new Error(`${label} needs brief (non-empty string or null)`);
  }
}

function repositoryKey(repoRoot) {
  try {
    const common = execFileSync(
      "git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return realpathSync(common);
  } catch {
    return resolve(repoRoot);
  }
}

function legacySessionId(repoRoot, session) {
  return `legacy-${createHash("sha256")
    .update(`${repositoryKey(repoRoot)}\0${session.workspace}\0${session.name}`)
    .digest("hex")}`;
}

function recordFileName(sessionId) {
  if (!SESSION_ID.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
  return `${sessionId}.json`;
}

function within(path, boundary) {
  const offset = relative(boundary, path);
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

function futureRealPath(path) {
  const suffix = [];
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`session registry has no resolvable ancestor: ${path}`);
    suffix.unshift(ancestor.slice(parent.length + 1));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

function assertAutomationPath(repoRoot, registryPath) {
  const root = realpathSync(repoRoot);
  const directory = registryDirectoryFor(registryPath);
  for (const target of [registryPath, directory]) {
    const offset = relative(root, resolve(target));
    let cursor = root;
    for (const part of offset.split(sep).filter(Boolean)) {
      cursor = join(cursor, part);
      if (!existsSync(cursor)) break;
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`registry path uses a symlink: ${cursor}`);
    }
    if (!within(futureRealPath(target), root)) {
      throw new Error("automated session metadata requires a repository-local registry");
    }
  }
  const registryRelative = relative(root, registryPath);
  const directoryRelative = relative(root, directory);
  const tracked = execFileSync("git", ["-C", root, "ls-files", "--", registryRelative, `${directoryRelative}/`], {
    encoding: "utf8",
  }).trim();
  if (tracked !== "") throw new Error("session registry is tracked; completion metadata was not written");
  for (const target of [registryPath, directory, join(directory, ".write-probe")]) {
    const ignored = spawnSync(
      "git", ["-C", root, "check-ignore", "--quiet", "--no-index", "--", relative(root, target)],
      { stdio: "ignore" },
    ).status === 0;
    if (!ignored) throw new Error("session registry must be gitignored; completion metadata was not written");
  }
}

function atomicJson(path, value, { immutable = false } = {}) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    if (immutable) {
      linkSync(temporary, path);
      unlinkSync(temporary);
    } else {
      renameSync(temporary, path);
    }
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function writeSessionRecord(registryPath, session) {
  validateNew(session, "lane board session record");
  const directory = registryDirectoryFor(registryPath);
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, recordFileName(session.session_id));
  atomicJson(path, session, { immutable: true });
  return path;
}

function loadRegistryPath(registryPath, repoRoot) {
  const sessions = [];
  const errors = [];
  const ids = new Set();
  if (existsSync(registryPath)) {
    let legacy;
    try {
      legacy = parseJson(registryPath);
      if (!Array.isArray(legacy)) throw new Error(`lane board registry must be a JSON array: ${registryPath}`);
    } catch (error) {
      if (error.message.startsWith("lane board registry must be")) throw error;
      throw new Error(`cannot read lane board registry ${registryPath}: ${error.message}`);
    }
    for (const [index, raw] of legacy.entries()) {
      try {
        validateCommon(raw, `lane board registry entry ${index}`);
        const session = { ...raw, session_id: raw.session_id ?? legacySessionId(repoRoot, raw) };
        if (!SESSION_ID.test(session.session_id)) throw new Error(`lane board registry entry ${index} has an invalid session_id`);
        if (ids.has(session.session_id)) throw new Error(`lane board registry entry ${index} duplicates session_id ${session.session_id}`);
        ids.add(session.session_id);
        sessions.push(session);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }

  const directory = registryDirectoryFor(registryPath);
  const names = existsSync(directory) ? readdirSync(directory).sort() : [];
  for (const name of names.filter((entry) => entry.endsWith(".json") && !entry.endsWith(".done.json"))) {
    const path = resolve(directory, name);
    try {
      const session = parseJson(path);
      validateNew(session, `lane board session record ${name}`);
      if (name !== recordFileName(session.session_id)) throw new Error(`lane board session record ${name} has mismatched session_id`);
      if (ids.has(session.session_id)) throw new Error(`lane board session record ${name} duplicates session_id ${session.session_id}`);
      ids.add(session.session_id);
      sessions.push(session);
    } catch (error) {
      errors.push(error.message.startsWith("lane board") ? error.message : `cannot read lane board session record ${name}: ${error.message}`);
    }
  }

  const completed = new Set();
  for (const name of names.filter((entry) => entry.endsWith(".done.json"))) {
    try {
      const marker = parseJson(resolve(directory, name));
      const sessionId = name.slice(0, -".done.json".length);
      if (!SESSION_ID.test(sessionId) || marker?.session_id !== sessionId || marker.done !== true) {
        throw new Error(`lane board completion marker ${name} is invalid`);
      }
      completed.add(sessionId);
    } catch (error) {
      errors.push(error.message.startsWith("lane board") ? error.message : `cannot read lane board completion marker ${name}: ${error.message}`);
    }
  }
  for (const session of sessions) {
    if (completed.has(session.session_id)) session.done = true;
  }
  return {
    path: registryPath,
    sessions,
    errors,
    exists: existsSync(registryPath) || existsSync(directory),
  };
}

export function loadRegistry(repoRoot, config = {}) {
  const path = registryPathFor(repoRoot, config);
  return loadRegistryPath(path, repoRoot);
}

export function markSessionDone(registryPath, identifier, options = {}) {
  const repoRoot = options.repoRoot ?? dirname(dirname(registryPath));
  const loaded = loadRegistryPath(registryPath, repoRoot);
  const matches = loaded.sessions.filter((session) =>
    session.session_id === identifier || (!SESSION_ID.test(identifier) && session.name === identifier));
  if (matches.length !== 1) throw new Error(`session not found in registry: ${identifier}`);
  const sessionId = matches[0].session_id;
  if (options.repoRoot !== undefined) assertAutomationPath(options.repoRoot, registryPath);
  const directory = registryDirectoryFor(registryPath);
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `${sessionId}.done.json`);
  try {
    atomicJson(path, { session_id: sessionId, done: true, completed_at: new Date().toISOString() });
  } catch (error) {
    try {
      const existing = parseJson(path);
      if (existing?.session_id === sessionId && existing.done === true) return path;
    } catch {}
    throw error;
  }
  return path;
}

export function markTopicSessionsDone(registryPath, { repoRoot, repoId, topic }) {
  if (!existsSync(registryPath) && !existsSync(registryDirectoryFor(registryPath))) {
    return { marked: 0, errors: [] };
  }
  const loaded = loadRegistryPath(registryPath, repoRoot);
  const matches = loaded.sessions.filter((session) => {
    if (session.repo_id !== undefined && session.repo_id !== repoId) return false;
    return session.topic === topic || session.lane === topic || session.lane === `lane/${topic}`;
  });
  for (const session of matches) markSessionDone(registryPath, session.session_id, { repoRoot });
  return { marked: matches.length, errors: loaded.errors };
}
