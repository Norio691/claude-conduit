import type { WebSocket } from "ws";
import type { FastifyBaseLogger } from "fastify";
import type { RelayConfig } from "../config.js";

// node-pty uses CommonJS — need dynamic import
let ptyModule: typeof import("node-pty") | null = null;
async function loadPty(): Promise<typeof import("node-pty")> {
  if (!ptyModule) {
    ptyModule = await import("node-pty");
  }
  return ptyModule;
}

interface ActiveTerminal {
  pty: import("node-pty").IPty;
  sessionId: string;
  ws: WebSocket;
  createdAt: Date;
  cleanedUp: boolean;
}

const BACKPRESSURE_THRESHOLD = 64 * 1024; // 64KB
const OUTPUT_BUFFER_MAX = 1024 * 1024; // 1MB cap
const BATCH_INTERVAL_MS = 16; // ~60fps

export class TerminalBridge {
  private log: FastifyBaseLogger;
  private config: RelayConfig;
  private terminals = new Map<string, ActiveTerminal>();
  private reapTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: RelayConfig, log: FastifyBaseLogger) {
    this.log = log.child({ module: "terminal" });
    this.config = config;
  }

  start(): void {
    this.reapTimer = setInterval(() => this.reapOrphans(), 60_000);
  }

  stop(): void {
    if (this.reapTimer) clearInterval(this.reapTimer);
    for (const [id, terminal] of this.terminals) {
      this.cleanupTerminal(id, terminal);
    }
  }

  /** Check if a session has an active terminal — single source of truth. */
  hasActiveTerminal(sessionId: string): boolean {
    return this.terminals.has(sessionId);
  }

  /**
   * Attach a WebSocket to a tmux session via node-pty.
   * The PTY runs `tmux attach-session -t <name>`.
   */
  async attach(
    sessionId: string,
    tmuxSession: string,
    ws: WebSocket,
    cols: number,
    rows: number,
  ): Promise<void> {
    if (this.terminals.has(sessionId)) {
      ws.close(4409, "Session already has an active terminal connection");
      return;
    }

    const pty = await loadPty();

    const ptyProcess = pty.spawn("tmux", ["attach-session", "-t", tmuxSession], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.HOME ?? "/",
      env: process.env as Record<string, string>,
    });

    const terminal: ActiveTerminal = {
      pty: ptyProcess,
      sessionId,
      ws,
      createdAt: new Date(),
      cleanedUp: false,
    };

    this.terminals.set(sessionId, terminal);

    this.log.info(
      { sessionId, tmuxSession, pid: ptyProcess.pid, cols, rows },
      "Terminal attached",
    );

    // Output batching for backpressure control
    let outputBuffer: Buffer[] = [];
    let outputBufferSize = 0;
    let batchTimer: ReturnType<typeof setTimeout> | null = null;

    const clearBatchTimer = (): void => {
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
    };

    const flushOutput = (): void => {
      batchTimer = null;
      if (outputBuffer.length === 0) return;
      if (ws.readyState !== ws.OPEN) return;

      // Check backpressure — retry later if buffer full
      if (ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
        batchTimer = setTimeout(flushOutput, BATCH_INTERVAL_MS);
        return;
      }

      const combined = Buffer.concat(outputBuffer);
      outputBuffer = [];
      outputBufferSize = 0;
      ws.send(combined);
    };

    // PTY → WS (binary)
    ptyProcess.onData((data: string) => {
      const buf = Buffer.from(data, "utf-8");

      // Cap output buffer to prevent unbounded growth
      if (outputBufferSize + buf.length > OUTPUT_BUFFER_MAX) {
        // Drop oldest data
        outputBuffer = [];
        outputBufferSize = 0;
      }

      outputBuffer.push(buf);
      outputBufferSize += buf.length;

      if (!batchTimer) {
        batchTimer = setTimeout(flushOutput, BATCH_INTERVAL_MS);
      }
    });

    // PTY exit — cleanup including SIGKILL escalation
    ptyProcess.onExit(({ exitCode, signal }) => {
      this.log.info({ sessionId, exitCode, signal }, "PTY process exited");
      clearBatchTimer();
      flushOutput();
      this.cleanupTerminal(sessionId, terminal);

      if (ws.readyState === ws.OPEN) {
        ws.close(1000, "Terminal session ended");
      }
    });

    // WS → PTY
    ws.on("message", (data: Buffer | string, isBinary: boolean) => {
      if (typeof data === "string" || !isBinary) {
        // Text frame = control message
        try {
          const msg = JSON.parse(
            typeof data === "string" ? data : data.toString("utf-8"),
          ) as { type: string; cols?: number; rows?: number };

          if (msg.type === "resize" && msg.cols && msg.rows) {
            ptyProcess.resize(msg.cols, msg.rows);
            this.log.debug(
              { sessionId, cols: msg.cols, rows: msg.rows },
              "Terminal resized",
            );
          }
        } catch {
          // Malformed control message — ignore
        }
      } else {
        // Binary frame = terminal input
        ptyProcess.write(data.toString("utf-8"));
      }
    });

    // WS close / error → cleanup PTY
    ws.on("close", () => {
      this.log.info({ sessionId }, "WebSocket closed, cleaning up PTY");
      clearBatchTimer();
      this.cleanupTerminal(sessionId, terminal);
    });

    ws.on("error", (err) => {
      this.log.error({ err, sessionId }, "WebSocket error");
      clearBatchTimer();
      this.cleanupTerminal(sessionId, terminal);
    });

    // Heartbeat: send ping, increment missed counter.
    // Reset on pong. Disconnect if too many missed.
    let missedPongs = 0;
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        clearInterval(heartbeatInterval);
        return;
      }
      missedPongs++;
      if (missedPongs > this.config.rateLimit.wsMaxMissedPongs) {
        this.log.warn({ sessionId, missedPongs }, "Too many missed pongs, closing");
        clearInterval(heartbeatInterval);
        ws.terminate();
        return;
      }
      ws.ping();
    }, this.config.rateLimit.wsHeartbeat * 1000);

    ws.on("pong", () => {
      missedPongs = 0;
    });

    ws.on("close", () => {
      clearInterval(heartbeatInterval);
    });
  }

  private cleanupTerminal(sessionId: string, terminal: ActiveTerminal): void {
    // Idempotent — only clean up once
    if (terminal.cleanedUp) return;
    if (this.terminals.get(sessionId) !== terminal) return;

    terminal.cleanedUp = true;
    this.terminals.delete(sessionId);

    const pid = terminal.pty.pid;
    try {
      terminal.pty.kill();
      this.log.debug({ sessionId, pid }, "PTY process killed (SIGTERM)");
    } catch {
      // Already dead
    }

    // Escalate to SIGKILL after 5s if still alive
    setTimeout(() => {
      try {
        process.kill(pid, 0); // Check if alive
        process.kill(pid, "SIGKILL");
        this.log.warn({ sessionId, pid }, "Force-killed PTY process (SIGKILL)");
      } catch {
        // Already dead — good
      }
    }, 5000);
  }

  private reapOrphans(): void {
    for (const [sessionId, terminal] of this.terminals) {
      const ws = terminal.ws;
      if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) {
        this.log.warn({ sessionId }, "Reaping orphaned terminal (WS dead)");
        this.cleanupTerminal(sessionId, terminal);
      }
    }
  }
}
