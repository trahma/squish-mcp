import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "../src/db.js";
import { BusEvents } from "../src/events.js";
import { upsertAgent } from "../src/identity.js";
import { buildMcpServer } from "../src/mcp.js";
import type { BusContext } from "../src/context.js";

/** Fresh in-memory bus (DB + event emitter) for a test. */
export function createBus(): BusContext {
  return { db: openDb({ path: ":memory:", quiet: true }), events: new BusEvents() };
}

/**
 * Connect a simulated agent to the bus over an in-memory MCP transport — the
 * same buildMcpServer path the HTTP server uses, with identity bound to
 * `agentId`. We upsert the agent first, mirroring the HTTP identity middleware.
 */
export async function connectAgent(
  ctx: BusContext,
  agentId: string,
): Promise<Client> {
  upsertAgent(ctx.db, agentId, Date.now());
  const server = buildMcpServer(ctx, agentId);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `test-${agentId}`, version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

/** Call a tool and parse its JSON text result. */
export async function call<T = any>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const text = res.content?.[0]?.text;
  if (text === undefined) throw new Error(`tool ${name} returned no text`);
  return JSON.parse(text) as T;
}
