/**
 * squish-mcp companion plugin for OpenCode.
 *
 * Bridges the bus's SSE stream into the running session: when another agent
 * sends this agent a message, the plugin nudges the session (only while idle)
 * to go read its inbox. Drop this in `.opencode/plugin/squish.ts`.
 *
 * Env:
 *   AGENT_ID  (required) - this agent's bus identity; must match the x-agent-id
 *                          header in opencode.json. If unset, the plugin warns
 *                          and disables itself (and the bus rejects MCP calls).
 *   SQUISH_URL           - base URL of the bus (default http://localhost:4319)
 *
 * The same pattern translates to Claude Code via a wrapper script + a
 * SessionStart/Notification hook that long-polls `wait_for_message` — see README.
 */
import type { Plugin } from "@opencode-ai/plugin";

export const SquishPlugin: Plugin = async ({ client }) => {
  const agentId = process.env.AGENT_ID?.trim();
  const base = process.env.SQUISH_URL ?? "http://localhost:4319";

  if (!agentId) {
    // Loud, actionable warning rather than silently doing nothing — a missing
    // AGENT_ID is the #1 setup mistake, and it also breaks the MCP server
    // itself (the bus rejects requests without an x-agent-id header).
    console.warn(
      [
        "",
        "⚠️  squish-mcp: AGENT_ID is not set.",
        "    This agent will NOT coordinate via squish:",
        "      • no message notifications (SSE bridge disabled), and",
        "      • the MCP server will reject every tool call (missing x-agent-id header).",
        "",
        "    Fix: export a unique AGENT_ID into the environment that launched OpenCode,",
        "    e.g.  AGENT_ID=backend-1 opencode   (or set it via direnv / a launcher).",
        "    It must match the x-agent-id header in your opencode.json MCP config.",
        "",
      ].join("\n"),
    );
    return {}; // nothing to wire up without an identity
  }

  let sessionID: string | undefined;
  let idle = true;
  const source = new EventSource(`${base}/events?agent_id=${agentId}`);

  source.addEventListener("message", (e: MessageEvent) => {
    if (!sessionID || !idle) return; // only interrupt an idle session
    const { from, preview } = JSON.parse(e.data);
    void client.session.prompt({
      sessionID,
      parts: [
        {
          type: "text",
          text: `📬 New message from ${from}: ${preview}\n\nUse get_inbox to retrieve the full message.`,
        },
      ],
    });
  });

  return {
    event: async ({ event }) => {
      // Track the active session and its idle state to gate interruptions.
      if (event.type === "session.idle") {
        sessionID = event.properties.sessionID;
        idle = true;
      } else if (event.type === "message.updated") {
        idle = false; // a turn is in progress; hold notifications
      } else if (event.type === "session.deleted") {
        source.close();
      }
    },
  };
};
