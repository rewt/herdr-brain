import { EventEmitter } from "node:events";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export function herdrSocketPath() {
  return process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");
}

export class HerdrClient extends EventEmitter {
  constructor({
    socketPath = herdrSocketPath(),
    requestTimeoutMs = 2_000,
    paneReadTimeoutMs = 2_000,
    minBackoffMs = 250,
    maxBackoffMs = 5_000,
    connect = (path) => net.createConnection(path),
  } = {}) {
    super();
    this.socketPath = socketPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.paneReadTimeoutMs = paneReadTimeoutMs;
    this.minBackoffMs = minBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.connect = connect;
    this.nextId = 1;
    this.backoffMs = minBackoffMs;
    this.subscriptions = [];
    this.subscriptionSocket = undefined;
    this.reconnectTimer = undefined;
    this.closed = false;
    this.destroyed = false;
    this.generation = 0;
    this.pendingRequests = new Set();
  }

  id() {
    const id = `lane-board:${process.pid}:${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.destroyed) return Promise.reject(new Error("Herdr client closed"));
    const id = this.id();
    return new Promise((resolve, reject) => {
      const socket = this.connect(this.socketPath);
      let buffer = "";
      let settled = false;
      let timer;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingRequests.delete(finish);
        socket.destroy();
        if (error !== undefined) reject(error);
        else resolve(result);
      };
      this.pendingRequests.add(finish);
      timer = setTimeout(
        () => finish(new Error(`Herdr request timed out: ${method}`)),
        timeoutMs,
      );
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line === "") continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch (error) {
            finish(new Error(`Invalid JSON from Herdr: ${error.message}`));
            return;
          }
          if (message.id !== id) continue;
          if (message.error !== undefined) {
            finish(new Error(`Herdr ${message.error.code}: ${message.error.message}`));
          } else {
            finish(undefined, message.result);
          }
          return;
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("end", () => finish(new Error(`Herdr closed before replying to ${method}`)));
      socket.on("close", () => finish(new Error(`Herdr closed before replying to ${method}`)));
    });
  }

  async ping() {
    const result = await this.request("ping");
    if (result?.type !== "pong") throw new Error("Unexpected Herdr ping response");
    return result;
  }

  async snapshot() {
    const result = await this.request("session.snapshot");
    if (result?.type !== "session_snapshot") {
      throw new Error("Unexpected Herdr snapshot response");
    }
    return result.snapshot;
  }

  async readPane(paneId, { source = "recent_unwrapped", lines = 200 } = {}) {
    const result = await this.request("pane.read", {
      pane_id: paneId,
      source,
      lines,
      format: "text",
      strip_ansi: true,
    }, { timeoutMs: this.paneReadTimeoutMs });
    if (result?.type !== "pane_read" || result.read === undefined) {
      throw new Error("Unexpected Herdr pane read response");
    }
    return result.read;
  }

  subscribe(subscriptions) {
    if (this.destroyed) return;
    this.closed = false;
    this.subscriptions = [...subscriptions];
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    this.subscriptionSocket?.destroy();
    if (this.subscriptions.length > 0) this.#connectSubscription(this.generation);
  }

  #connectSubscription(generation) {
    if (this.destroyed || this.closed || generation !== this.generation) return;
    const id = this.id();
    const socket = this.connect(this.socketPath);
    this.subscriptionSocket = socket;
    let buffer = "";
    let ready = false;
    let scheduled = false;
    const reconnect = () => {
      if (scheduled || this.destroyed || this.closed || generation !== this.generation) return;
      scheduled = true;
      if (this.subscriptionSocket === socket) this.subscriptionSocket = undefined;
      this.emit("disconnected");
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.maxBackoffMs, Math.max(this.minBackoffMs, delay * 2));
      this.reconnectTimer = setTimeout(() => this.#connectSubscription(generation), delay);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({
        id,
        method: "events.subscribe",
        params: { subscriptions: this.subscriptions },
      })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line === "") continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          this.emit("connectionError", error);
          socket.destroy();
          return;
        }
        if (message.id === id) {
          if (message.error !== undefined) {
            this.emit("connectionError", new Error(`Herdr ${message.error.code}: ${message.error.message}`));
            socket.destroy();
          } else if (message.result?.type === "subscription_started") {
            ready = true;
            this.backoffMs = this.minBackoffMs;
            this.emit("ready");
          }
        } else if (message.event !== undefined && message.data !== undefined) {
          this.emit("event", message);
        }
      }
    });
    socket.on("error", (error) => {
      this.emit("connectionError", error);
      reconnect();
    });
    socket.on("close", reconnect);
    socket.on("end", reconnect);
    socket.setTimeout(this.requestTimeoutMs, () => {
      if (!ready) socket.destroy(new Error("Herdr subscription handshake timed out"));
    });
  }

  close() {
    this.destroyed = true;
    this.closed = true;
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.subscriptionSocket?.destroy();
    this.subscriptionSocket = undefined;
    for (const finish of [...this.pendingRequests]) {
      finish(new Error("Herdr client closed"));
    }
  }
}
