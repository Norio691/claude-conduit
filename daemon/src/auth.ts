import type { FastifyRequest, FastifyReply } from "fastify";
import type { RelayConfig } from "./config.js";
import { timingSafeEqual, randomBytes } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validate that a string is a UUID v4 format. */
export function isValidSessionId(id: string): boolean {
  return UUID_RE.test(id);
}

/** Timing-safe PSK comparison. */
export function verifyPsk(psk: string, expected: string): boolean {
  const a = Buffer.from(psk, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Short-lived attach tokens.
 * POST /attach generates a token; WS /terminal validates it.
 * Prevents bypassing conflict checks by connecting directly to WS.
 */
export class AttachTokens {
  private tokens = new Map<string, { sessionId: string; expires: number }>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Prune expired tokens every 30s
    this.cleanupTimer = setInterval(() => this.prune(), 30_000);
  }

  /** Generate a single-use token for a session (60s TTL). */
  generate(sessionId: string): string {
    const token = randomBytes(24).toString("base64url");
    this.tokens.set(token, {
      sessionId,
      expires: Date.now() + 60_000,
    });
    return token;
  }

  /** Validate and consume a token. Returns session ID or null. */
  consume(token: string): string | null {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    this.tokens.delete(token);
    if (Date.now() > entry.expires) return null;
    return entry.sessionId;
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, entry] of this.tokens) {
      if (now > entry.expires) {
        this.tokens.delete(token);
      }
    }
  }
}

export function createAuthHook(config: RelayConfig) {
  const expectedPsk = config.auth.psk;

  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // Skip auth for status endpoint and WS upgrade (WS has its own auth)
    if (request.url === "/api/status") return;
    if (request.url.startsWith("/terminal/")) return;

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "Missing or invalid Authorization header",
        action: "Include 'Authorization: Bearer <psk>' header",
      });
      return;
    }

    const token = authHeader.slice(7);
    if (!verifyPsk(token, expectedPsk)) {
      request.log.warn(
        { ip: request.ip },
        "Failed authentication attempt",
      );
      reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "Invalid pre-shared key",
        action: "Check your relay key in the app settings",
      });
      return;
    }
  };
}
