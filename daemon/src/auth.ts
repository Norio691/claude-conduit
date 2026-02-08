import type { FastifyRequest, FastifyReply } from "fastify";
import type { RelayConfig } from "./config.js";
import { timingSafeEqual } from "node:crypto";

export function createAuthHook(config: RelayConfig) {
  const expectedToken = Buffer.from(config.auth.psk, "utf-8");

  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // Skip auth for status endpoint (used for health checks)
    if (request.url === "/api/status") return;

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "Missing or invalid Authorization header",
        action: "Include 'Authorization: Bearer <psk>' header",
      });
      return;
    }

    const token = Buffer.from(authHeader.slice(7), "utf-8");
    if (
      token.length !== expectedToken.length ||
      !timingSafeEqual(token, expectedToken)
    ) {
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
