import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { loadConfig } from "./config.js";
import { createAuthHook } from "./auth.js";
import { SessionDiscovery } from "./sessions/discovery.js";
import { TmuxManager } from "./tmux/manager.js";
import { TerminalBridge } from "./terminal/bridge.js";
import { registerStatusRoutes } from "./routes/status.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerAttachRoutes } from "./routes/attach.js";

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.auth.psk) {
    console.error(
      "ERROR: No PSK configured. Edit ~/.config/claude-relay/config.yaml and set auth.psk",
    );
    process.exit(1);
  }

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV !== "production"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  });

  const log = app.log;

  // Register WebSocket support
  await app.register(fastifyWebsocket);

  // Auth hook for all routes
  const authHook = createAuthHook(config);
  app.addHook("onRequest", authHook);

  // Initialize services
  const discovery = new SessionDiscovery(config, log);
  const tmuxManager = new TmuxManager(config, log);
  const bridge = new TerminalBridge(config, tmuxManager, log);

  // Register REST routes
  registerStatusRoutes(app, config, tmuxManager);
  registerSessionRoutes(app, discovery, tmuxManager);
  registerAttachRoutes(app, discovery, tmuxManager, bridge);

  // WebSocket terminal endpoint
  app.get<{
    Params: { sessionId: string };
    Querystring: { cols?: string; rows?: string };
  }>(
    "/terminal/:sessionId",
    { websocket: true },
    (socket: WebSocket, request) => {
      const { sessionId } = request.params;
      const cols = parseInt(request.query.cols ?? "", 10) || config.tmux.defaultCols;
      const rows = parseInt(request.query.rows ?? "", 10) || config.tmux.defaultRows;

      // Verify auth from query param or header (WS doesn't reliably send headers)
      const authParam =
        (request.query as Record<string, string>).token ??
        request.headers.authorization?.slice(7);
      if (!authParam || authParam !== config.auth.psk) {
        log.warn({ ip: request.ip }, "Unauthorized WS connection attempt");
        socket.close(4401, "Unauthorized");
        return;
      }

      // Find tmux session name
      const tmuxSession = `claude-${sessionId}`;

      // Attach
      bridge
        .attach(sessionId, tmuxSession, socket, cols, rows)
        .catch((err) => {
          log.error({ err, sessionId }, "Failed to attach terminal");
          socket.close(4500, "Failed to attach terminal");
        });
    },
  );

  // Startup
  await discovery.start();
  bridge.start();

  // Reconcile existing tmux sessions
  const existingIds = await tmuxManager.reconcile();
  for (const id of existingIds) {
    discovery.updateTmuxStatus(id, "detached");
  }

  // Start listening
  await app.listen({ port: config.port, host: config.host });
  log.info(
    {
      port: config.port,
      host: config.host,
      sessions: discovery.getSessions().length,
    },
    "Claude Relay daemon started",
  );

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "Shutting down...");
    bridge.stop();
    discovery.stop();
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error starting daemon:", err);
  process.exit(1);
});
