/**
 * squish-mcp companion plugin for OpenCode.
 *
 * Bridges the bus's SSE stream into the running session: when another agent
 * sends this agent a message, the plugin nudges the session (only while idle)
 * to go read its inbox. Drop this in `.opencode/plugin/squish.ts`.
 *
 * Env:
 *   AGENT_ID        - this agent's bus identity (must match opencode.json header)
 *   SQUISH_URL      - base URL of the bus (default http://localhost:4319)
 *
 * The same pattern translates to Claude Code via a wrapper script + a
 * SessionStart/Notification hook that long-polls `wait_for_message` — see README.
 */
import type { Plugin } from "@opencode-ai/plugin";

export const SquishPlugin: Plugin = async ({ client }) => {
  const agentId = process.env.AGENT_ID;
  const base = process.env.SQUISH_URL ?? "http://localhost:4319";
  if (!agentId) return {}; // not configured for this agent; do nothing

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
