import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BusContext } from "../context.js";
import { registerAgentTools } from "./agents.js";
import { registerMessageTools } from "./messages.js";
import { registerTaskTools } from "./tasks.js";

/**
 * Register every bus tool on a server instance, binding the calling agent's
 * identity into each handler. Identity is fixed for the lifetime of the
 * connection — it comes from the x-agent-id header, never from tool input.
 */
export function registerAllTools(
  server: McpServer,
  ctx: BusContext,
  agentId: string,
): void {
  registerAgentTools(server, ctx, agentId);
  registerMessageTools(server, ctx, agentId);
  registerTaskTools(server, ctx, agentId);
}
