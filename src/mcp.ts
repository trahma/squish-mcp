import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BusContext } from "./context.js";
import { registerAllTools } from "./tools/index.js";

export const SERVER_NAME = "squish-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Build an MCP server instance bound to a single agent's identity. One server
 * per connection (the SDK's Server owns its transport), with the agent ID
 * captured in every tool handler so identity can't be spoofed per-call.
 */
export function buildMcpServer(ctx: BusContext, agentId: string): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Multi-agent message bus. Use whoami/list_agents to find peers, " +
        "send_message/broadcast/get_inbox/mark_read/wait_for_message to coordinate, " +
        "and create_task/list_tasks/claim_task/update_task_status for shared work.",
    },
  );
  registerAllTools(server, ctx, agentId);
  return server;
}
