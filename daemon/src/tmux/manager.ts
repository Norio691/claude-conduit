import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";
import type { RelayConfig } from "../config.js";
import type { TmuxSession } from "./types.js";
import { SessionLock } from "./lock.js";

const exec = promisify(execFile);

export class TmuxManager {
  private log: FastifyBaseLogger;
  private config: RelayConfig;
  private lock = new SessionLock();
  private activeAttachments = new Set<string>(); // session IDs with active WS

  constructor(config: RelayConfig, log: FastifyBaseLogger) {
    this.log = log.child({ module: "tmux" });
    this.config = config;
  }

  /** Mark a session as having an active WS terminal connection. */
  markAttached(sessionId: string): void {
    this.activeAttachments.add(sessionId);
  }

  /** Mark a session as no longer having a WS terminal connection. */
  markDetached(sessionId: string): void {
    this.activeAttachments.delete(sessionId);
  }

  /** Check if a session has an active WS terminal connection. */
  hasActiveConnection(sessionId: string): boolean {
    return this.activeAttachments.has(sessionId);
  }

  /**
   * Attach to (or create) a tmux session for a Claude session.
   * Returns tmux session name. Serialized per session ID.
   */
  async attach(sessionId: string): Promise<{
    tmuxSession: string;
    existed: boolean;
  }> {
    return this.lock.acquire(sessionId, async () => {
      // Check 1: Already has an active WS connection
      if (this.activeAttachments.has(sessionId)) {
        throw new SessionConflictError(
          "SESSION_ATTACHED",
          "Already connected from another device",
        );
      }

      // Check 2: Is a Claude process already running with this session?
      const claudeRunning = await this.isClaudeRunning(sessionId);
      if (claudeRunning) {
        throw new SessionConflictError(
          "SESSION_CONFLICT",
          "Close Claude on your Mac first, or pick a different session",
        );
      }

      // Check 3: Max sessions
      const activeSessions = await this.listSessions();
      const claudeSessions = activeSessions.filter((s) =>
        s.name.startsWith("claude-"),
      );
      if (claudeSessions.length >= this.config.claude.maxSessions) {
        // Check if this session already has a tmux session (don't count it against limit)
        const tmuxName = this.tmuxName(sessionId);
        const existing = claudeSessions.find((s) => s.name === tmuxName);
        if (!existing) {
          throw new SessionConflictError(
            "MAX_SESSIONS",
            `Maximum ${this.config.claude.maxSessions} concurrent sessions reached. Detach or close a session first.`,
          );
        }
      }

      // Check 4: Existing tmux session — reattach
      const tmuxName = this.tmuxName(sessionId);
      const exists = await this.hasSession(tmuxName);
      if (exists) {
        this.log.info({ sessionId, tmuxName }, "Reattaching to existing tmux session");
        return { tmuxSession: tmuxName, existed: true };
      }

      // Create new tmux session
      await this.createSession(sessionId);
      this.log.info({ sessionId, tmuxName }, "Created new tmux session");
      return { tmuxSession: tmuxName, existed: false };
    });
  }

  /** List all tmux sessions. */
  async listSessions(): Promise<TmuxSession[]> {
    try {
      const { stdout } = await exec("tmux", [
        "list-sessions",
        "-F",
        "#{session_name}:#{session_attached}:#{session_created}",
      ]);

      return stdout
        .trim()
        .split("\n")
        .filter((l) => l.length > 0)
        .map((line) => {
          const [name, attached, created] = line.split(":");
          return {
            name,
            attached: attached === "1",
            created: new Date(parseInt(created, 10) * 1000),
          };
        });
    } catch {
      // tmux not running = no sessions
      return [];
    }
  }

  /** Get Claude-specific tmux sessions. */
  async listClaudeSessions(): Promise<
    Array<{ sessionId: string; tmux: TmuxSession }>
  > {
    const all = await this.listSessions();
    return all
      .filter((s) => s.name.startsWith("claude-"))
      .map((s) => ({
        sessionId: s.name.slice("claude-".length),
        tmux: s,
      }));
  }

  /** Kill a tmux session. */
  async killSession(tmuxName: string): Promise<void> {
    try {
      await exec("tmux", ["kill-session", "-t", tmuxName]);
      this.log.info({ tmuxName }, "Killed tmux session");
    } catch {
      // Session already dead
    }
  }

  /** Reconcile on daemon startup: discover existing tmux sessions. */
  async reconcile(): Promise<string[]> {
    const claudeSessions = await this.listClaudeSessions();
    const ids = claudeSessions.map((s) => s.sessionId);
    if (ids.length > 0) {
      this.log.info(
        { sessions: ids },
        "Reconciled existing tmux sessions on startup",
      );
    }
    return ids;
  }

  private tmuxName(sessionId: string): string {
    return `claude-${sessionId}`;
  }

  private async hasSession(tmuxName: string): Promise<boolean> {
    try {
      await exec("tmux", ["has-session", "-t", tmuxName]);
      return true;
    } catch {
      return false;
    }
  }

  private async createSession(sessionId: string): Promise<void> {
    const tmuxName = this.tmuxName(sessionId);
    const claudeCmd = `${this.config.claude.binary} --resume ${sessionId}`;

    await exec("tmux", [
      "new-session",
      "-d",
      "-s",
      tmuxName,
      "-x",
      String(this.config.tmux.defaultCols),
      "-y",
      String(this.config.tmux.defaultRows),
      claudeCmd,
    ]);
  }

  private async isClaudeRunning(sessionId: string): Promise<boolean> {
    try {
      // Check for claude process with this session ID
      const { stdout } = await exec("pgrep", [
        "-f",
        `claude.*--resume.*${sessionId}`,
      ]);
      return stdout.trim().length > 0;
    } catch {
      // pgrep exits 1 when no match
      return false;
    }
  }
}

export class SessionConflictError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "SessionConflictError";
  }
}
