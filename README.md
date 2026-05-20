# squish-mcp

A multi-agent message bus exposed as an [MCP](https://modelcontextprotocol.io) server. Multiple AI coding agents (Claude Code, OpenCode, Cursor, Codex CLI, …) connect to one long-lived process and coordinate through **direct messages**, **broadcasts**, and a **shared task list** — with atomic operations, structured schemas, long-poll waits, and an SSE stream for plugins.

This replaces the brittle "agents write JSON files to a shared folder" pattern with a real bus: SQLite (WAL) for persistence, an in-process event emitter for wake-ups, and a clean set of typed tools.

## How it works

- **One shared process, HTTP transport.** All agents connect over Streamable HTTP to the same process so they share one DB and one event stream — not stdio-per-agent.
- **Identity is fixed per connection.** Each agent sets `x-agent-id` in its MCP server config. The server reads it from a header on every request. **Requests with no identity are rejected.** Agents can't claim another identity per-call — the sender of every message and the claimer of every task is the header value, never a tool argument.
- **SQLite with WAL.** `journal_mode=WAL`, `synchronous=NORMAL` — concurrent reads + serialized writes, no extra infrastructure. WAL status is logged at startup. Uses Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html), so there's **no native addon to compile** — install just works on any platform (requires **Node 24+**).
- **Long-poll, not WebSocket.** `wait_for_message` blocks (up to a timeout) and resolves the moment a message arrives, via an in-memory emitter keyed by agent ID.
- **SSE for plugins.** `GET /events?agent_id=X` streams events to non-MCP clients (the OpenCode plugin, watchers, dashboards) off the same emitter.
- All timestamps are unix epoch **milliseconds** (integers).

## Quick start

Requires **Node 24+** (for the built-in `node:sqlite` module).

```bash
npm install
npm run build
node dist/index.js          # listens on 127.0.0.1:4319 by default
```

Environment variables:

| Var                 | Default            | Purpose                          |
| ------------------- | ------------------ | -------------------------------- |
| `AGENT_BUS_DB_PATH` | `./agent-bus.db`   | SQLite file path                 |
| `PORT`              | `4319`             | HTTP port                        |
| `HOST`              | `127.0.0.1`        | Bind address                     |
| `LOG_LEVEL`         | `info`             | pino log level                   |

Endpoints: `POST /mcp` (MCP), `GET /events` (SSE), `GET /health`.

## The `x-agent-id` header (required)

Every request to `/mcp` **must** carry `x-agent-id: <your-agent-id>`. It is set once in your MCP client config and identifies you for the life of the connection. Without it the server returns `401`. Optionally pass `x-agent-metadata` as a JSON string (e.g. role/model) which `whoami` and `list_agents` return.

### Claude Code

```bash
claude mcp add --transport http squish http://localhost:4319/mcp \
  --header "x-agent-id: backend-1"
```

Give each agent a distinct ID (`backend-1`, `frontend-1`, `reviewer`, …).

### OpenCode

`opencode.json` (see [`examples/opencode.json`](examples/opencode.json)) — reference the identity from the environment so one config serves every agent:

```json
{
  "mcp": {
    "squish": {
      "type": "remote",
      "url": "http://localhost:4319/mcp",
      "enabled": true,
      "headers": {
        "x-agent-id": "{env:AGENT_ID}",
        "x-agent-metadata": "{env:AGENT_METADATA}"
      }
    }
  }
}
```

`{env:VAR}` is substituted from OpenCode's process environment (not from a `.env` file — those aren't auto-loaded). `x-agent-metadata` is optional JSON returned by `whoami`/`list_agents` (e.g. role); leave `AGENT_METADATA` unset to omit it.

### Setting `AGENT_ID`

`AGENT_ID` identifies the agent and must be **unique per running instance** — it is read in two places that must agree: the `x-agent-id` MCP header (above) and the companion plugin's SSE connection. Set it in the environment that launches OpenCode; do **not** commit a shared `.env` (it can only hold one id, and OpenCode/Node don't auto-load `.env` anyway). Pick whichever fits your workflow:

```bash
# 1. Inline at launch (simplest — one agent per terminal)
AGENT_ID=backend-1 opencode
AGENT_ID=frontend-1 AGENT_METADATA='{"role":"frontend"}' opencode

# 2. Per-role shell alias
alias oc-backend='AGENT_ID=backend-1 opencode'

# 3. direnv per worktree — gitignored .envrc, auto-exported into the shell:
#    echo 'export AGENT_ID=backend-1' > .envrc && direnv allow
```

If `AGENT_ID` is unset, the bus rejects every MCP call with `401`, and the plugin prints a warning and disables itself.

## Tools

### Identity & presence
- **`whoami`** — your agent ID + registration metadata; refreshes `last_seen`.
- **`list_agents`** `{ active_within_seconds=300 }` — agents seen recently.

### Direct messaging
- **`send_message`** `{ to, body, subject?, metadata? }` → `{ message_id, created_at }`.
- **`broadcast`** `{ body, subject?, metadata? }` → `{ message_id, recipients[], created_at }` — to all known agents except you.
- **`get_inbox`** `{ unread_only=true, limit=50, since? }` → `{ messages[] }`. Does **not** mark read.
- **`mark_read`** `{ message_ids[] }` → `{ marked }`. Read state is **per recipient** (broadcasts included).
- **`wait_for_message`** `{ timeout_seconds=30, unread_only=true }` → `{ messages[], timed_out }`. Returns immediately if unread messages exist; otherwise blocks until one arrives or the timeout elapses.

### Shared task list
- **`create_task`** `{ title, description?, depends_on?, metadata? }` → `{ task_id, created_at }`. IDs are ULID-style (sortable).
- **`list_tasks`** `{ status?, assignee?, include_completed=false }` → `{ tasks[] }`.
- **`claim_task`** `{ task_id }` → `{ claimed, task?, reason? }`. Atomic and race-safe — exactly one agent wins. `reason` ∈ `already_claimed | not_found | dependencies_pending`.
- **`update_task_status`** `{ task_id, status, notes?, result? }` — only the assignee may update; completing a task fires an event so dependents can be picked up.

Tool results are returned as JSON text (`content[0].text`), parseable by any MCP client.

## SSE events

`GET /events?agent_id=X` (or send the `x-agent-id` header — preferred, but `EventSource` can't set headers, so the query param is accepted). Standard SSE frames:

| Event            | Data                                                  |
| ---------------- | ----------------------------------------------------- |
| `message`        | `{ message_id, from, subject, preview }` (≤200 chars) |
| `task_created`   | `{ task_id, title }`                                  |
| `task_claimed`   | `{ task_id, assignee }`                               |
| `task_completed` | `{ task_id, assignee, result_preview }`               |
| `heartbeat`      | `{ ts }` every 25s                                    |

`message` events are filtered per subscriber: direct messages reach only the recipient; broadcasts reach everyone except the sender.

## OpenCode plugin

[`examples/opencode-plugin.ts`](examples/opencode-plugin.ts) is a ~50-line companion plugin: it connects an `EventSource` to `/events`, and when a `message` event arrives **while the session is idle**, it prompts the session to go read its inbox. It closes the stream on `session.deleted`. Drop it in `.opencode/plugin/` and set `AGENT_ID` to match your config.

**Claude Code equivalent:** the same idea translates to a wrapper script invoked by a hook. A `SessionStart` (or `Notification`) hook runs a small script that long-polls `wait_for_message`; when it returns messages, the script emits a notification / injects context telling the agent to call `get_inbox`. The bus side is identical — only the client-side glue differs.

## Manual smoke test

```bash
node dist/index.js &
npx @modelcontextprotocol/inspector
# Connect via Streamable HTTP to http://localhost:4319/mcp
# Add header x-agent-id: tester  → exercise every tool.
```

## Development

```bash
npm test         # vitest: messaging, tasks, long-poll, claim_task race
npm run typecheck
npm run dev      # node --watch on src/index.ts
```

## Scope

Out of scope by design: auth beyond `x-agent-id` (run on localhost or behind your own layer), TLS (terminate elsewhere), multi-host/clustering (single process; swap SQLite for Postgres + Redis pub/sub if you outgrow it), first-class message threading (use `metadata.in_reply_to`), and any UI.
