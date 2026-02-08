import type { FastifyInstance } from "fastify";
import type { SessionDiscovery } from "../sessions/discovery.js";
import type { TmuxManager } from "../tmux/manager.js";
import { SessionConflictError } from "../tmux/manager.js";
import type { TerminalBridge } from "../terminal/bridge.js";

// Rate limit: track last attach time per session
const lastAttachTime = new Map<string, number>();

export function registerAttachRoutes(
  app: FastifyInstance,
  discovery: SessionDiscovery,
  tmuxManager: TmuxManager,
  bridge: TerminalBridge,
): void {
  // POST /api/sessions/:id/attach — create/attach tmux session
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/attach",
    async (request, reply) => {
      const sessionId = request.params.id;

      // Verify session exists
      const session = discovery.getSession(sessionId);
      if (!session) {
        reply.code(404).send({
          error: "NOT_FOUND",
          message: "Session not found",
          action: "Check the session ID and try again",
        });
        return;
      }

      // Rate limit: 1 attach per session per 5 seconds
      const now = Date.now();
      const lastAttach = lastAttachTime.get(sessionId);
      if (lastAttach && now - lastAttach < 5000) {
        reply.code(429).send({
          error: "RATE_LIMITED",
          message: "Too many attach attempts. Wait a few seconds.",
          action: "Wait 5 seconds before retrying",
        });
        return;
      }
      lastAttachTime.set(sessionId, now);

      try {
        const result = await tmuxManager.attach(sessionId);
        discovery.updateTmuxStatus(
          sessionId,
          result.existed ? "detached" : "none",
        );

        return {
          wsUrl: `/terminal/${sessionId}`,
          tmuxSession: result.tmuxSession,
          existed: result.existed,
        };
      } catch (err) {
        if (err instanceof SessionConflictError) {
          reply.code(409).send({
            error: err.code,
            message: err.message,
            action: err.message,
          });
          return;
        }
        throw err;
      }
    },
  );
}
