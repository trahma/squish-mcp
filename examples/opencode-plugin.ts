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

  // Unconditional load marker: if you never see this line, the plugin file
  // itself isn't being loaded (wrong location, wrong export, or a parse error).
  log(`plugin loaded (AGENT_ID=${agentId ?? "unset"})`);

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
  let lastActivityAt = 0; // ms timestamp of the last in-turn event
  let pending: { from: string; preview: string } | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  // Treat the session as idle if no turn activity has happened recently. Using
  // a timestamp (not a boolean) is robust against OpenCode firing trailing
  // delta events *after* session.idle, which would otherwise wedge a boolean
  // flag in the "busy" state with no further session.idle to clear it.
  const BUSY_WINDOW_MS = 1500;
  const isIdle = () => Date.now() - lastActivityAt > BUSY_WINDOW_MS;

  /** Prompt the (idle) session to go read its inbox; queue + retry if busy. */
  const notify = (from: string, preview: string) => {
    if (!sessionID) {
      // We only learn sessionID from session events; until one fires we can't
      // target a prompt. Stash the latest and flush once we know the session.
      pending = { from, preview };
      trace(`message from ${from} queued (no sessionID yet)`);
      return;
    }
    if (!isIdle()) {
      pending = { from, preview };
      trace(`message from ${from} queued (session busy)`);
      // Don't rely on a future session.idle to flush — retry after the window.
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        if (pending) notify(pending.from, pending.preview);
      }, BUSY_WINDOW_MS + 250);
      return;
    }
    pending = undefined;
    clearTimeout(flushTimer);
    log(`prompting session ${sessionID} about message from ${from}`);
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

  // Consume the SSE stream with fetch rather than EventSource: EventSource is
  // not a reliable global in every OpenCode/Bun runtime (a missing global would
  // throw here and silently kill the plugin). fetch + a ReadableStream reader
  // works everywhere and surfaces HTTP status / connection errors. Reconnects
  // with a short backoff until the session is deleted.
  const url = `${base}/events?agent_id=${encodeURIComponent(agentId)}`;
  const abort = new AbortController();

  const handleFrame = (frame: string) => {
    let type = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
    }
    if (type === "heartbeat") {
      trace("heartbeat (stream is live)"); // arrives every ~25s
      return;
    }
    if (type !== "message" || !data) return;
    let payload: { from?: string; preview?: string };
    try {
      payload = JSON.parse(data);
    } catch (err) {
      console.warn("[squish] failed to parse SSE data:", err, data);
      return;
    }
    // Unconditional (not trace): a delivered message is the key signal we want
    // visible even without SQUISH_DEBUG.
    log(`message received from ${payload.from}`);
    notify(payload.from ?? "unknown", payload.preview ?? "");
  };

  void (async () => {
    while (!abort.signal.aborted) {
      try {
        const res = await fetch(url, {
          headers: { accept: "text/event-stream" },
          signal: abort.signal,
        });
        if (!res.ok || !res.body) {
          console.warn(`[squish] SSE got HTTP ${res.status} from ${url}`);
        } else {
          log(`connected to bus as "${agentId}" (${url})`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let i: number;
            while ((i = buffer.indexOf("\n\n")) !== -1) {
              handleFrame(buffer.slice(0, i));
              buffer = buffer.slice(i + 2);
            }
          }
        }
      } catch (err) {
        if (!abort.signal.aborted)
          console.warn(
            `[squish] SSE connection error at ${url} — is the bus running?`,
            err,
          );
      }
      if (abort.signal.aborted) break;
      await new Promise((r) => setTimeout(r, 3000)); // backoff, then reconnect
    }
    trace("SSE loop stopped");
  })();

  return {
    event: async ({ event }) => {
      // Property names/locations vary by OpenCode version, so search a few
      // likely spots and (under SQUISH_DEBUG) dump the shape when we miss.
      const ev = event as {
        type: string;
        properties?: Record<string, any>;
        sessionID?: string;
        session_id?: string;
      };
      const p = ev.properties;
      const sid =
        p?.sessionID ??
        p?.session_id ??
        p?.info?.sessionID ??
        p?.info?.id ??
        ev.sessionID ??
        ev.session_id;

      trace(`event ${ev.type}${sid ? ` (session ${sid})` : ""}`);
      if (
        !sid &&
        (ev.type.startsWith("session.") || ev.type.startsWith("message."))
      ) {
        trace(`  ↳ no session id found; properties=${JSON.stringify(p)}`);
      }

      if (sid) sessionID = sid;

      if (event.type === "session.idle") {
        lastActivityAt = 0; // turn finished → immediately considered idle
        // A message may have arrived mid-turn or before we knew the session.
        if (pending) notify(pending.from, pending.preview);
      } else if (
        event.type === "message.updated" ||
        event.type === "message.part.updated"
      ) {
        lastActivityAt = Date.now(); // a turn is in progress; hold notifications
      } else if (event.type === "session.deleted") {
        abort.abort();
        clearTimeout(flushTimer);
      }
    },
  };
};
