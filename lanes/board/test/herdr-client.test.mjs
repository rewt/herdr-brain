import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";

import { HerdrClient } from "../herdr-client.mjs";

const NEGATIVE_CONTROL = process.env.LANE_TEST_NEGATIVE_CONTROL === "1";

function negativeControl(name) {
  if (NEGATIVE_CONTROL) assert.fail(`deliberately broken expectation: ${name}`);
}

function waitFor(predicate, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timed out waiting for condition"));
      }
    }, 5);
  });
}

class FakeSocket extends EventEmitter {
  constructor(server) {
    super();
    this.server = server;
    this.closed = false;
    queueMicrotask(() => this.emit("connect"));
  }

  setEncoding() {}

  setTimeout(ms, callback) {
    this.timeout = setTimeout(callback, ms);
  }

  write(chunk) {
    this.server(this, JSON.parse(chunk.trim()));
  }

  receive(message) {
    queueMicrotask(() => this.emit("data", `${JSON.stringify(message)}\n`));
  }

  receiveChunk(chunk) {
    queueMicrotask(() => this.emit("data", chunk));
  }

  end() {
    this.destroy();
  }

  destroy(error) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timeout);
    if (error !== undefined) queueMicrotask(() => this.emit("error", error));
    queueMicrotask(() => this.emit("close"));
  }
}

function fakeServer(handler) {
  return () => new FakeSocket(handler);
}

test("snapshot preserves request ids and returns protocol state", async () => {
  const requests = [];
  const connect = fakeServer((socket, request) => {
    requests.push(request);
    socket.receive({
      id: request.id,
      result: {
        type: "session_snapshot",
        snapshot: { protocol: 20, version: "test", agents: [], panes: [], workspaces: [] },
      },
    });
  });

  const client = new HerdrClient({ socketPath: "fake.sock", requestTimeoutMs: 500, connect });
  const snapshot = await client.snapshot();
  assert.equal(snapshot.protocol, 20);
  assert.equal(requests[0].method, "session.snapshot");
  assert.match(requests[0].id, /^lane-board:/);
  negativeControl("Herdr snapshot request");
});

test("pane reads use the bounded recent-unwrapped protocol shape", async () => {
  const requests = [];
  const connect = fakeServer((socket, request) => {
    requests.push(request);
    socket.receive({
      id: request.id,
      result: {
        type: "pane_read",
        read: {
          pane_id: "w1:p1",
          workspace_id: "w1",
          tab_id: "w1:t1",
          source: "recent_unwrapped",
          format: "text",
          text: "visible output",
          revision: 12,
          truncated: false,
        },
      },
    });
  });
  const client = new HerdrClient({ socketPath: "fake.sock", connect });
  try {
    const read = await client.readPane("w1:p1", { source: "recent_unwrapped", lines: 200 });
    assert.equal(read.text, "visible output");
    assert.deepEqual(requests[0], {
      id: requests[0].id,
      method: "pane.read",
      params: {
        pane_id: "w1:p1",
        source: "recent_unwrapped",
        lines: 200,
        format: "text",
        strip_ansi: true,
      },
    });
    negativeControl("bounded Herdr pane read");
  } finally {
    client.close();
  }
});

test("pane reads use a larger timeout than snapshot requests", async () => {
  const connect = fakeServer((socket, request) => {
    setTimeout(() => socket.receive({
      id: request.id,
      result: {
        type: "pane_read",
        read: {
          pane_id: "w1:p1",
          workspace_id: "w1",
          tab_id: "w1:t1",
          source: "recent_unwrapped",
          format: "text",
          text: "delayed visible output",
          revision: 12,
          truncated: false,
        },
      },
    }), 30);
  });
  const client = new HerdrClient({
    socketPath: "fake.sock",
    requestTimeoutMs: 10,
    paneReadTimeoutMs: 100,
    connect,
  });
  try {
    assert.equal((await client.readPane("w1:p1")).text, "delayed visible output");
    negativeControl("dedicated pane read timeout");
  } finally {
    client.close();
  }
});

test("subscriptions emit events and reconnect with bounded backoff", async () => {
  const requests = [];
  let connection = 0;
  const connect = fakeServer((socket, request) => {
    requests.push(request);
    connection += 1;
    socket.receive({ id: request.id, result: { type: "subscription_started" } });
    socket.receive({
      event: "pane.agent_status_changed",
      data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: connection === 1 ? "working" : "done" },
    });
    if (connection === 1) setTimeout(() => socket.destroy(), 5);
  });

  const client = new HerdrClient({ socketPath: "fake.sock", minBackoffMs: 5, maxBackoffMs: 20, connect });
  const statuses = [];
  client.on("event", (event) => statuses.push(event.data.agent_status));
  try {
    client.subscribe([{ type: "pane.agent_status_changed", pane_id: "w1:p1" }]);
    await waitFor(() => statuses.includes("done"));
    assert.deepEqual(statuses.slice(0, 2), ["working", "done"]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, "events.subscribe");
    assert.notEqual(requests[0].id, requests[1].id);
    assert.deepEqual(requests[0].params.subscriptions, [
      { type: "pane.agent_status_changed", pane_id: "w1:p1" },
    ]);
    negativeControl("Herdr subscription reconnect");
  } finally {
    client.close();
  }
});

test("a subscription handshake is observable before streamed events", async () => {
  const connect = fakeServer((socket, request) => {
    socket.receive({ id: request.id, result: { type: "subscription_started" } });
  });
  const client = new HerdrClient({ socketPath: "fake.sock", connect });
  try {
    const ready = once(client, "ready");
    client.subscribe([{ type: "pane.scroll_changed", pane_id: "w1:p1" }]);
    await ready;
    negativeControl("Herdr subscription handshake");
  } finally {
    client.close();
  }
});

test("request responses may be split across data chunks", async () => {
  const connect = fakeServer((socket, request) => {
    const response = `${JSON.stringify({
      id: request.id,
      result: {
        type: "session_snapshot",
        snapshot: { protocol: 20, version: "test", agents: [], panes: [], workspaces: [] },
      },
    })}\n`;
    for (const chunk of [response.slice(0, 3), response.slice(3, 17), response.slice(17)]) {
      socket.receiveChunk(chunk);
    }
  });
  const client = new HerdrClient({ socketPath: "fake.sock", connect });
  try {
    assert.equal((await client.snapshot()).protocol, 20);
    negativeControl("chunked Herdr response");
  } finally {
    client.close();
  }
});

test("subscriptions parse two messages delivered in one chunk", async () => {
  const connect = fakeServer((socket, request) => {
    socket.receiveChunk(
      `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n` +
      `${JSON.stringify({
        event: "pane.agent_status_changed",
        data: { pane_id: "w1:p1", agent_status: "done" },
      })}\n`,
    );
  });
  const client = new HerdrClient({ socketPath: "fake.sock", connect });
  try {
    const event = once(client, "event");
    client.subscribe([{ type: "pane.agent_status_changed", pane_id: "w1:p1" }]);
    assert.equal((await event)[0].data.agent_status, "done");
    negativeControl("batched Herdr messages");
  } finally {
    client.close();
  }
});

test("requests reject after the configured timeout", async () => {
  const client = new HerdrClient({
    socketPath: "fake.sock",
    requestTimeoutMs: 20,
    connect: fakeServer(() => {}),
  });
  try {
    await assert.rejects(client.snapshot(), /Herdr request timed out: session\.snapshot/);
    negativeControl("Herdr request timeout");
  } finally {
    client.close();
  }
});

test("requests reject Herdr error response bodies", async () => {
  const connect = fakeServer((socket, request) => {
    socket.receive({
      id: request.id,
      error: { code: "invalid_request", message: "bad snapshot" },
    });
  });
  const client = new HerdrClient({ socketPath: "fake.sock", connect });
  try {
    await assert.rejects(client.snapshot(), /Herdr invalid_request: bad snapshot/);
    negativeControl("Herdr error response");
  } finally {
    client.close();
  }
});

test("close rejects a request before its reply arrives", async () => {
  let requestSeen;
  const seen = new Promise((resolve) => { requestSeen = resolve; });
  const client = new HerdrClient({
    socketPath: "fake.sock",
    requestTimeoutMs: 500,
    connect: fakeServer(() => requestSeen()),
  });
  const request = client.snapshot();
  await seen;
  client.close();
  await assert.rejects(request, /Herdr client closed/);
  negativeControl("close before Herdr reply");
});

test("subscribe after close does not open another socket", async () => {
  let connections = 0;
  const client = new HerdrClient({
    socketPath: "fake.sock",
    connect: () => {
      connections += 1;
      return new FakeSocket(() => {});
    },
  });
  try {
    client.close();
    client.subscribe([{ type: "pane.agent_status_changed", pane_id: "w1:p1" }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(connections, 0);
    negativeControl("permanent Herdr client close");
  } finally {
    client.close();
  }
});
