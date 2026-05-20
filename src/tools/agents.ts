import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BusContext } from "../context.js";
import { getAgent, upsertAgent } from "../identity.js";
import { parseJson, type AgentRow } from "../types.js";
import { jsonResult } from "./_shared.js";

export function registerAgentTools(
  server: McpServer,
  ctx: BusContext,
  agentId: string,
): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Return your own agent ID and registration metadata, as seen by the bus. " +
        "Identity is fixed by the x-agent-id header in your MCP config; you cannot change it. " +
        "Also refreshes your last_seen timestamp.",
      inputSchema: {},
    },
    () => {
      const now = Date.now();
      upsertAgent(ctx.db, agentId, now);
      const row = getAgent(ctx.db, agentId) as AgentRow;
      return jsonResult({
        agent_id: row.id,
        registered_at: row.registered_at,
        last_seen: row.last_seen,
        metadata: parseJson(row.metadata),
      });
    },
  );

  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description:
        "List other agents currently connected to the bus. Returns agents whose " +
        "last_seen falls within active_within_seconds (default 300). Use this to " +
        "discover who you can message or hand work to.",
      inputSchema: {
        active_within_seconds: z
          .number()
          .int()
          .positive()
          .max(86_400)
          .default(300)
          .describe("Only include agents seen within this many seconds."),
      },
    },
    ({ active_within_seconds }) => {
      const cutoff = Date.now() - active_within_seconds * 1000;
      const rows = ctx.db
        .prepare(
          "SELECT * FROM agents WHERE last_seen >= ? ORDER BY last_seen DESC",
        )
        .all(cutoff) as AgentRow[];
      return jsonResult({
        agents: rows.map((r) => ({
          id: r.id,
          last_seen: r.last_seen,
          registered_at: r.registered_at,
          metadata: parseJson(r.metadata),
        })),
      });
    },
  );
}
