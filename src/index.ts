import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { openDb, type DB } from "./db.js";
import { BusEvents, formatSseEvent, type BusEvent } from "./events.js";
import {
  AGENT_ID_HEADER,
  readAgentId,
  readAgentMetadata,
  upsertAgent,
} from "./identity.js";
import { logger } from "./logger.js";
import { buildMcpServer } from "./mcp.js";
import type { BusContext } from "./context.js";

const HEARTBEAT_MS = 25_000;

interface Session {
  transport: StreamableHTTPServerTransport;
  agentId: string;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/** JSON-RPC-shaped error so MCP clients surface it cleanly. */
function rpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code: -32_000, message },
    id: null,
  });
}

export function createHttpServer(ctx: BusContext) {
  const sessions = new Map<string, Session>();

  const handleMcp = async (req: IncomingMessage, res: ServerResponse) => {
    const agentId = readAgentId(req.headers);
    if (!agentId) {
      rpcError(res, 401, `Missing required ${AGENT_ID_HEADER} header.`);
      return;
    }
    upsertAgent(ctx.db, agentId, Date.now(), readAgentMetadata(req.headers));

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        rpcError(res, 404, "Unknown session ID.");
        return;
      }
      if (session.agentId !== agentId) {
        rpcError(res, 403, "Session belongs to a different agent.");
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    // No session ID: only an initialize request may open a new one.
    const body = req.method === "POST" ? await readBody(req) : undefined;
    if (req.method !== "POST" || !isInitializeRequest(body)) {
      rpcError(res, 400, "No valid session ID provided.");
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, agentId });
        logger.info({ agentId, sessionId: id }, "mcp session opened");
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        logger.info({ sessionId: transport.sessionId }, "mcp session closed");
      }
    };

    const server = buildMcpServer(ctx, agentId);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const handleEvents = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Header preferred; EventSource can't set headers, so accept ?agent_id too.
    const agentId =
      readAgentId(req.headers) ?? url.searchParams.get("agent_id")?.trim();
    if (!agentId) {
      rpcError(res, 401, `Missing ${AGENT_ID_HEADER} header or agent_id query.`);
      return;
    }
    upsertAgent(ctx.db, agentId, Date.now());

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable proxy buffering (nginx)
    });
    res.write(`retry: 3000\n\n`);

    const unsubscribe = ctx.events.subscribe((event: BusEvent) => {
      if (BusEvents.isRelevantTo(event, agentId)) {
        res.write(formatSseEvent(event.type, eventPayload(event)));
      }
    });

    const heartbeat = setInterval(() => {
      res.write(formatSseEvent("heartbeat", { ts: Date.now() }));
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    logger.info({ agentId }, "sse stream opened");
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      logger.info({ agentId }, "sse stream closed");
    });
  };

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = url.pathname;

    if (route === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (route === "/events" && req.method === "GET") {
      handleEvents(req, res);
      return;
    }
    if (route === "/mcp") {
      handleMcp(req, res).catch((err) => {
        logger.error({ err }, "mcp request failed");
        if (!res.headersSent) rpcError(res, 500, "Internal server error.");
      });
      return;
    }
    rpcError(res, 404, "Not found.");
  });
}

/** Strip internal targeting fields from message events before sending over SSE. */
function eventPayload(event: BusEvent): Record<string, unknown> {
  switch (event.type) {
    case "message":
      return {
        message_id: event.message_id,
        from: event.from,
        subject: event.subject,
        preview: event.preview,
      };
    case "task_created":
      return { task_id: event.task_id, title: event.title };
    case "task_claimed":
      return { task_id: event.task_id, assignee: event.assignee };
    case "task_completed":
      return {
        task_id: event.task_id,
        assignee: event.assignee,
        result_preview: event.result_preview,
      };
  }
}

function main(): void {
  const db: DB = openDb();
  const ctx: BusContext = { db, events: new BusEvents() };
  const server = createHttpServer(ctx);
  const port = Number(process.env.PORT ?? 4319);
  const host = process.env.HOST ?? "127.0.0.1";

  server.listen(port, host, () => {
    logger.info({ host, port }, "squish-mcp listening (POST /mcp, GET /events)");
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    server.close(() => {
      db.close(); // checkpoints WAL and releases the file cleanly
      logger.info("sqlite closed, bye");
      process.exit(0);
    });
    // Don't hang forever on lingering SSE connections.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
