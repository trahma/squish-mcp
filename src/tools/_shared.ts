import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Wrap a JSON-serializable value as an MCP tool result. We return the payload
 * as text (universally parseable by clients) rather than declaring an
 * outputSchema, keeping the tools compatible with every MCP client.
 */
export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
