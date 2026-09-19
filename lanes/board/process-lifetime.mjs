import { writeSync } from "node:fs";

const BOARD_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export const BOARD_TERMINAL_RESET = "\u001B[0m\u001B[?25h";

function resetBoardTerminal() {
  try {
    writeSync(process.stdout.fd, BOARD_TERMINAL_RESET);
  } catch {
    // The signal must still be re-raised when stdout has already closed.
  }
}

export function installBoardSignalHandlers(getClient) {
  let handling = false;
  const handlers = new Map();
  const dispose = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
  const terminate = (signal) => {
    if (handling) return;
    handling = true;
    try {
      getClient()?.close();
    } catch {
      // Terminal restoration and the original signal remain mandatory.
    }
    resetBoardTerminal();
    dispose();
    process.kill(process.pid, signal);
  };
  for (const signal of BOARD_SIGNALS) {
    const handler = () => terminate(signal);
    handlers.set(signal, handler);
    process.prependListener(signal, handler);
  }
  return dispose;
}
