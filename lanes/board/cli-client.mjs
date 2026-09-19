import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_LANE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "lane.mjs");

export class LaneCliClient extends EventEmitter {
  constructor({
    lanePath = DEFAULT_LANE_PATH,
    repoRoot,
    env = process.env,
    spawnProcess = spawn,
    minBackoffMs = 250,
    maxBackoffMs = 5_000,
  }) {
    super();
    this.lanePath = lanePath;
    this.repoRoot = repoRoot;
    this.env = env;
    this.spawnProcess = spawnProcess;
    this.minBackoffMs = minBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.backoffMs = minBackoffMs;
    this.observer = undefined;
    this.reconnectTimer = undefined;
    this.actions = new Set();
    this.closed = false;
    this.generation = 0;
  }

  start() {
    if (this.closed || this.observer !== undefined) return;
    this.#observe(this.generation);
  }

  refresh() {
    if (this.closed) return;
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const previous = this.observer;
    this.observer = undefined;
    previous?.kill("SIGTERM");
    this.#observe(this.generation);
  }

  #observe(generation) {
    if (this.closed || generation !== this.generation) return;
    const child = this.spawnProcess(process.execPath, [
      this.lanePath,
      "board",
      "--watch",
      "--json",
      "--repo",
      this.repoRoot,
    ], {
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.observer = child;
    let stdout = "";
    let stderr = "";
    let reconnectScheduled = false;
    const scheduleReconnect = () => {
      if (reconnectScheduled || this.closed || generation !== this.generation) return;
      reconnectScheduled = true;
      if (this.observer === child) this.observer = undefined;
      this.emit("disconnected");
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.maxBackoffMs, Math.max(this.minBackoffMs, delay * 2));
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        this.#observe(generation);
      }, delay);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (this.closed || generation !== this.generation) return;
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (line === "") continue;
        try {
          const document = JSON.parse(line);
          if (document?.schema_version !== 1 || !Array.isArray(document.rows)) {
            throw new Error("expected schema_version 1 with rows");
          }
          this.backoffMs = this.minBackoffMs;
          this.emit("snapshot", document);
        } catch (error) {
          this.emit("clientError", new Error(`invalid JSON from lane board: ${error.message}`));
        }
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      const lines = stderr.split("\n");
      stderr = lines.pop();
      for (const line of lines.filter(Boolean)) this.emit("diagnostic", line);
    });
    child.on("error", (error) => {
      if (!this.closed && generation === this.generation) this.emit("clientError", error);
      scheduleReconnect();
    });
    child.on("close", (status, signal) => {
      if (stderr.trim() !== "" && !this.closed && generation === this.generation) {
        this.emit("diagnostic", stderr.trim());
      }
      if (!this.closed && generation === this.generation && status !== null) {
        this.emit("clientError", new Error(`lane board observer exited ${status}${signal ? ` (${signal})` : ""}`));
      }
      scheduleReconnect();
    });
  }

  focus(rowId) {
    return this.#action("focus", rowId);
  }

  done(rowId) {
    return this.#action("done", rowId);
  }

  #action(action, rowId) {
    if (this.closed) return Promise.reject(new Error("lane CLI client closed"));
    return new Promise((resolvePromise, rejectPromise) => {
      const child = this.spawnProcess(process.execPath, [
        this.lanePath,
        "board",
        action,
        rowId,
        "--repo",
        this.repoRoot,
      ], {
        env: this.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.actions.add(child);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        this.actions.delete(child);
        if (error !== undefined) rejectPromise(error);
        else resolvePromise(stdout.trim());
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      child.on("error", finish);
      child.on("close", (status, signal) => {
        if (status === 0) finish();
        else finish(new Error(stderr.trim() || `lane board ${action} exited ${status ?? signal ?? "unknown"}`));
      });
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const observer = this.observer;
    this.observer = undefined;
    observer?.kill("SIGTERM");
    for (const child of this.actions) child.kill("SIGTERM");
  }
}
