#!/usr/bin/env node
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

import { boardOptionsFromArgs } from "./args.mjs";
import { LaneCliClient } from "./cli-client.mjs";
import { installBoardSignalHandlers } from "./process-lifetime.mjs";
import {
  footerLine,
  interactiveMessage,
  stateFromBoardDocument,
  tableLineEntries,
} from "./view.mjs";

const h = React.createElement;
let activeClient;

installBoardSignalHandlers(() => activeClient);

function BoardApp({ repoRoot }) {
  const { exit } = useApp();
  const clientRef = useRef();
  const mountedRef = useRef(false);
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState("starting lane CLI observer…");
  const [state, setState] = useState({
    rows: [],
    stats: { load: 0, freeMemory: "-", workers: {} },
    connection: "connecting",
    coverage: {},
    errors: [],
  });

  useEffect(() => {
    mountedRef.current = true;
    const client = new LaneCliClient({ repoRoot });
    activeClient = client;
    clientRef.current = client;
    const onSnapshot = (document) => {
      if (!mountedRef.current) return;
      const next = stateFromBoardDocument(document);
      setState(next);
      setSelected((current) => Math.min(current, Math.max(0, next.rows.length - 1)));
      setMessage("");
    };
    const onDiagnostic = (diagnostic) => {
      if (mountedRef.current) setMessage(diagnostic);
    };
    const onClientError = (error) => {
      if (mountedRef.current) setMessage(`lane CLI: ${error.message}`);
    };
    const onDisconnected = () => {
      if (mountedRef.current) setMessage("lane CLI stream disconnected; reconnecting…");
    };
    client.on("snapshot", onSnapshot);
    client.on("diagnostic", onDiagnostic);
    client.on("clientError", onClientError);
    client.on("disconnected", onDisconnected);
    client.start();
    return () => {
      mountedRef.current = false;
      client.close();
      if (activeClient === client) activeClient = undefined;
    };
  }, [repoRoot]);

  const runAction = async (action) => {
    const row = state.rows[selected];
    if (row === undefined) return;
    setMessage(`${action === "focus" ? "focusing" : "marking done"}: ${row.name}`);
    try {
      const result = await clientRef.current[action](row.sessionId);
      if (mountedRef.current) setMessage(result);
    } catch (error) {
      if (mountedRef.current) setMessage(error.message);
    }
  };

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      mountedRef.current = false;
      clientRef.current?.close();
      activeClient = undefined;
      exit();
    } else if (input === "r") {
      setMessage("refreshing lane CLI observer…");
      clientRef.current?.refresh();
    } else if (key.downArrow || input === "j") {
      setSelected((current) => Math.min(current + 1, Math.max(0, state.rows.length - 1)));
    } else if (key.upArrow || input === "k") {
      setSelected((current) => Math.max(0, current - 1));
    } else if (key.return || input === "a") {
      void runAction("focus");
    } else if (input === "d") {
      void runAction("done");
    }
  });

  const lines = tableLineEntries(state.rows, { width: process.stdout.columns ?? 160 });
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true, color: "cyan" }, "lane board · ", state.connection),
    ...lines.map((line, index) => {
      const active = line.rowIndex === selected;
      const gateIndex = line.gateColor === undefined ? -1 : line.gateStart;
      const content = gateIndex < 0
        ? line.text
        : [
          line.text.slice(0, gateIndex),
          h(Text, { key: "gate", color: line.gateColor }, line.gateText),
          line.text.slice(gateIndex + line.gateText.length),
        ];
      return h(
        Text,
        { key: `${index}:${line.text}`, color: active ? "yellow" : undefined },
        active ? "> " : "  ",
        content,
      );
    }),
    h(Text, { dimColor: true }, footerLine(state.stats)),
    h(Text, null, interactiveMessage(state, message)),
  );
}

if (!process.stdin.isTTY) {
  process.stderr.write("lane board: interactive mode requires a TTY; use `lane board --once`\n");
  process.exit(1);
}

const args = process.argv.slice(2);
let options;
try {
  options = boardOptionsFromArgs(args);
} catch (error) {
  process.stderr.write(`lane board: ${error.message}\n`);
  process.exit(1);
}

render(h(BoardApp, { repoRoot: options.repoRoot }));
