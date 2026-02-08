import type { WebSocket } from "ws";
import type { FastifyBaseLogger } from "fastify";
import type { RelayConfig } from "../config.js";
import type { TmuxManager } from "../tmux/manager.js";

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
}

const BACKPRESSURE_THRESHOLD = 64 * 1024; // 64KB
const BATCH_INTERVAL_MS = 16; // ~60fps

export class TerminalBridge {
  private log: FastifyBaseLogger;
  private config: RelayConfig;
  private tmuxManager: TmuxManager;
  private terminals = new Map<string, ActiveTerminal>();
  private reapTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: RelayConfig, tmuxManager: TmuxManager, log: FastifyBaseLogger) {
    this.log = log.child({ module: "terminal" });
    this.config = config;
    this.tmuxManager = tmuxManager;
  }

  start(): void {
    // Reap orphaned pty processes every 60s
    this.reapTimer = setInterval(() => this.reapOrphans(), 60_000);
  }

  stop(): void {
    if (this.reapTimer) clearInterval(this.reapTimer);
    // Kill all active terminals
    for (const [id, terminal] of this.terminals) {
      this.cleanupTerminal(id, terminal);
    }
  }

  /** Check if a session has an active terminal. */
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
    // Refuse if already active
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
    };

    this.terminals.set(sessionId, terminal);
    this.tmuxManager.markAttached(sessionId);

    this.log.info(
      { sessionId, tmuxSession, pid: ptyProcess.pid, cols, rows },
      "Terminal attached",
    );

    // Output batching for backpressure control
    let outputBuffer: Buffer[] = [];
    let batchTimer: ReturnType<typeof setTimeout> | null = null;

    const flushOutput = (): void => {
      if (outputBuffer.length === 0) return;
      if (ws.readyState !== ws.OPEN) return;

      // Check backpressure
      if (ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
        // Retry on next tick
        batchTimer = setTimeout(flushOutput, BATCH_INTERVAL_MS);
        return;
      }

      const combined = Buffer.concat(outputBuffer);
      outputBuffer = [];
      ws.send(combined);
    };

    // PTY → WS (binary)
    ptyProcess.onData((data: string) => {
      outputBuffer.push(Buffer.from(data, "utf-8"));
      if (!batchTimer) {
        batchTimer = setTimeout(() => {
          batchTimer = null;
          flushOutput();
        }, BATCH_INTERVAL_MS);
      }
    });

    // PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      this.log.info(
        { sessionId, exitCode, signal },
        "PTY process exited",
      );
      if (batchTimer) clearTimeout(batchTimer);
      flushOutput(); // Flush remaining output
      this.terminals.delete(sessionId);
      this.tmuxManager.markDetached(sessionId);

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
          // Heartbeat: just acknowledge
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
      if (batchTimer) clearTimeout(batchTimer);
      this.cleanupTerminal(sessionId, terminal);
    });

    ws.on("error", (err) => {
      this.log.error({ err, sessionId }, "WebSocket error");
      if (batchTimer) clearTimeout(batchTimer);
      this.cleanupTerminal(sessionId, terminal);
    });

    // Heartbeat (ping/pong)
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      } else {
        clearInterval(heartbeatInterval);
      }
    }, this.config.rateLimit.wsHeartbeat * 1000);

    let missedPongs = 0;
    ws.on("pong", () => {
      missedPongs = 0;
    });

    const pongCheckInterval = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        clearInterval(pongCheckInterval);
        return;
      }
      missedPongs++;
      if (missedPongs >= this.config.rateLimit.wsMaxMissedPongs) {
        this.log.warn({ sessionId, missedPongs }, "Too many missed pongs, closing");
        clearInterval(pongCheckInterval);
        ws.terminate();
      }
    }, this.config.rateLimit.wsHeartbeat * 1000);

    // Clean up intervals on close
    ws.on("close", () => {
      clearInterval(heartbeatInterval);
      clearInterval(pongCheckInterval);
    });
  }

  private cleanupTerminal(sessionId: string, terminal: ActiveTerminal): void {
    // Only cleanup if this is still the active terminal for this session
    if (this.terminals.get(sessionId) !== terminal) return;

    this.terminals.delete(sessionId);
    this.tmuxManager.markDetached(sessionId);

    try {
      terminal.pty.kill();
      this.log.debug(
        { sessionId, pid: terminal.pty.pid },
        "PTY process killed",
      );
    } catch {
      // Already dead
    }

    // Escalate to SIGKILL after 5s if still alive
    const pid = terminal.pty.pid;
    setTimeout(() => {
      try {
        process.kill(pid, 0); // Check if alive
        process.kill(pid, "SIGKILL");
        this.log.warn({ sessionId, pid }, "Force-killed PTY process");
      } catch {
        // Already dead — good
      }
    }, 5000);
  }

  private reapOrphans(): void {
    for (const [sessionId, terminal] of this.terminals) {
      const ws = terminal.ws;
      if (
        ws.readyState === ws.CLOSED ||
        ws.readyState === ws.CLOSING
      ) {
        this.log.warn({ sessionId }, "Reaping orphaned terminal (WS dead)");
        this.cleanupTerminal(sessionId, terminal);
      }
    }
  }
}
