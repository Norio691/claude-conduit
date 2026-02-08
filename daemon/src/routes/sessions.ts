import type { FastifyInstance } from "fastify";
import type { SessionDiscovery } from "../sessions/discovery.js";
import type { TmuxManager } from "../tmux/manager.js";
import { basename } from "node:path";

export function registerSessionRoutes(
  app: FastifyInstance,
  discovery: SessionDiscovery,
  tmuxManager: TmuxManager,
): void {
  // GET /api/sessions — list all sessions
  app.get("/api/sessions", async () => {
    const sessions = discovery.getSessions();

    // Update tmux status for each session
    const tmuxSessions = await tmuxManager.listClaudeSessions();
    const tmuxMap = new Map(
      tmuxSessions.map((s) => [s.sessionId, s.tmux]),
    );

    return sessions.map((s) => {
      const tmux = tmuxMap.get(s.id);
      const tmuxStatus = tmux
        ? tmux.attached
          ? "active"
          : "detached"
        : "none";

      // Update discovery's cached status
      discovery.updateTmuxStatus(s.id, tmuxStatus);

      return {
        id: s.id,
        projectPath: s.projectPath,
        projectName: s.projectPath ? basename(s.projectPath) : s.projectHash,
        lastMessagePreview: s.lastMessagePreview,
        lastMessageRole: s.lastMessageRole,
        timestamp: s.timestamp.toISOString(),
        cliVersion: s.cliVersion,
        tmuxStatus,
      };
    });
  });

  // GET /api/sessions/:id — session detail
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (request, reply) => {
      const session = discovery.getSession(request.params.id);
      if (!session) {
        reply.code(404).send({
          error: "NOT_FOUND",
          message: "Session not found",
          action: "Check the session ID and try again",
        });
        return;
      }

      const tmuxSessions = await tmuxManager.listClaudeSessions();
      const tmux = tmuxSessions.find((s) => s.sessionId === session.id);
      const tmuxStatus = tmux
        ? tmux.tmux.attached
          ? "active"
          : "detached"
        : "none";
      discovery.updateTmuxStatus(session.id, tmuxStatus);

      return {
        id: session.id,
        projectPath: session.projectPath,
        projectName: session.projectPath
          ? basename(session.projectPath)
          : session.projectHash,
        projectHash: session.projectHash,
        lastMessagePreview: session.lastMessagePreview,
        lastMessageRole: session.lastMessageRole,
        timestamp: session.timestamp.toISOString(),
        cliVersion: session.cliVersion,
        tmuxStatus,
        hasActiveConnection: tmuxManager.hasActiveConnection(session.id),
      };
    },
  );

  // GET /api/projects — sessions grouped by project
  app.get("/api/projects", async () => {
    const grouped = discovery.getSessionsByProject();
    const result: Array<{
      projectPath: string;
      projectName: string;
      sessionCount: number;
      latestTimestamp: string;
    }> = [];

    for (const [path, sessions] of grouped) {
      result.push({
        projectPath: path,
        projectName: basename(path) || path,
        sessionCount: sessions.length,
        latestTimestamp: sessions[0].timestamp.toISOString(),
      });
    }

    return result.sort(
      (a, b) =>
        new Date(b.latestTimestamp).getTime() -
        new Date(a.latestTimestamp).getTime(),
    );
  });
}
