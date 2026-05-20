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
 *   SQUISH_DEBUG         - set to "1" for verbose [squish] logging
 *
 * The same pattern translates to Claude Code via a wrapper script + a
 * SessionStart/Notification hook that long-polls `wait_for_message` — see README.
 */
import type { Plugin } from "@opencode-ai/plugin";

export const SquishPlugin: Plugin = async ({ client }) => {
  const agentId = process.env.AGENT_ID?.trim();
  const base = process.env.SQUISH_URL ?? "http://localhost:4319";
  const debug = process.env.SQUISH_DEBUG === "1";
  const log = (...args: unknown[]) => console.log("[squish]", ...args);
  const trace = (...args: unknown[]) => debug && log(...args);

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
  let pending: { from: string; preview: string } | undefined;

  const url = `${base}/events?agent_id=${encodeURIComponent(agentId)}`;
  const source = new EventSource(url);
  source.onopen = () => log(`connected to bus as "${agentId}" (${url})`);
  source.onerror = (err) =>
    console.warn(
      `[squish] SSE connection error for "${agentId}" at ${url} — is the bus running?`,
      err,
    );

  /** Prompt the (idle) session to go read its inbox. */
  const notify = (from: string, preview: string) => {
    if (!sessionID) {
      // We only learn sessionID from session events; until one fires we can't
      // target a prompt. Stash the latest and flush once we know the session.
      pending = { from, preview };
      trace(`message from ${from} queued (no sessionID yet)`);
      return;
    }
    if (!idle) {
      pending = { from, preview };
      trace(`message from ${from} queued (session busy)`);
      return;
    }
    pending = undefined;
    trace(`prompting session ${sessionID} about message from ${from}`);
    // NOTE: OpenCode's SDK uses { path, body } — NOT { sessionID, parts }.
    void client.session
      .prompt({
        path: { id: sessionID },
        body: {
          parts: [
            {
              type: "text",
              text: `📬 New message from ${from}: ${preview}\n\nUse get_inbox to retrieve the full message and reply if needed.`,
            },
          ],
        },
      })
      .catch((err) => console.warn("[squish] session.prompt failed:", err));
  };

  source.addEventListener("message", (e: MessageEvent) => {
    try {
      const { from, preview } = JSON.parse(e.data);
      trace(`SSE message event from ${from}`);
      notify(from, preview);
    } catch (err) {
      console.warn("[squish] failed to parse SSE message event:", err);
    }
  });

  return {
    event: async ({ event }) => {
      // Property names vary by OpenCode version; read defensively.
      const props = (event as { properties?: Record<string, unknown> })
        .properties;
      const sid = (props?.sessionID ?? props?.session_id) as string | undefined;

      if (event.type === "session.idle") {
        if (sid) sessionID = sid;
        idle = true;
        // A message may have arrived mid-turn or before we knew the session.
        if (pending) notify(pending.from, pending.preview);
      } else if (
        event.type === "message.updated" ||
        event.type === "message.part.updated"
      ) {
        if (sid) sessionID = sid;
        idle = false; // a turn is in progress; hold notifications
      } else if (event.type === "session.deleted") {
        source.close();
      }
    },
  };
};
