# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repository.

## What this is

`squish-mcp` is a **multi-agent message bus** exposed as an MCP server. One
long-lived process holds a SQLite DB and an in-process event emitter; multiple
AI coding agents connect over Streamable HTTP and coordinate through direct
messages, broadcasts, and a shared task list. See `README.md` for the
user-facing tool reference and config snippets.

## Commands

```bash
npm install
npm run build       # tsc → dist/
npm test            # vitest run (the source of truth — run before claiming done)
npm run test:watch  # vitest watch
npm run typecheck   # tsc --noEmit (strict mode; keep it clean)
npm run dev         # node --watch on src/index.ts
node dist/index.js  # run the built server (PORT=4319, HOST=127.0.0.1 by default)
```

There is no linter/formatter configured. Match the existing style.

## Architecture (and the rules that hold it together)

Request flow: `index.ts` (HTTP) → per-agent `McpServer` (`mcp.ts`) → tool
handlers (`tools/*`) → `db.ts` (SQLite) + `events.ts` (emitter).

These are load-bearing decisions — **flag before deviating**:

- **One shared process, HTTP transport.** Not stdio-per-agent. Agents share one
  DB and one event stream. Don't add per-agent process spawning.
- **Identity is fixed per connection.** The caller is the `x-agent-id` request
  header, read in `identity.ts` and bound into every tool handler closure in
  `mcp.ts`/`tools/index.ts`. **Never** take the sender/claimer identity from a
  tool argument — that would let agents impersonate each other. Requests without
  the header are rejected (401); a session whose header later changes is
  rejected (403).
- **SQLite + WAL.** `openDb()` sets `journal_mode=WAL`, `synchronous=NORMAL`.
  `better-sqlite3` is **synchronous** — no `await` on DB calls. This is also why
  the concurrency guarantees work: writes serialize naturally.
- **Race-safety lives in SQL, not JS.** `claim_task` is a single guarded
  `UPDATE ... WHERE status='pending' AND <deps completed>` and checks
  `changes()`. Don't replace it with read-then-write logic.
- **Long-poll, not WebSocket.** `wait_for_message` checks the DB, then awaits
  `BusEvents.waitForMessage(agentId, timeout)`, then re-queries. The emitter is
  keyed by agent ID; DB writes trigger the wake via `events.publish(..., recipients)`.
- **SSE is a separate concern.** `GET /events` subscribes to the same emitter and
  filters per subscriber (`BusEvents.isRelevantTo`). It is for non-MCP clients
  (plugins/dashboards), not for MCP traffic.
- **Timestamps are unix epoch milliseconds (integers)** everywhere.

## Conventions

- **ESM + NodeNext.** Relative imports use explicit `.js` extensions (compiled
  output), even though the source is `.ts`. Keep this — it's required, not a typo.
- **Tools** are registered in `src/tools/{agents,messages,tasks}.ts`, each with a
  Zod `inputSchema` and a tight, model-facing `description`. Results go back as
  JSON text via `jsonResult(...)` (`tools/_shared.ts`) — no `outputSchema`, for
  broad client compatibility.
- **Row vs. domain types** (`types.ts`): `*Row` mirrors SQLite columns (JSON as
  string, nulls as `| null`); `rowToMessage`/`rowToTask` produce the public
  shapes (parsed metadata, `is_broadcast`, etc.). Convert at the boundary.
- **Read state is per-recipient.** Direct messages use `messages.read_at`;
  broadcasts use the `message_reads` table. `queryInbox` unifies both — reuse it
  rather than writing new inbox SQL.
- **Logging** is `pino` via `src/logger.ts`. Use it, not `console.log`.

## Testing

- Tests pair real MCP `Client`s with real per-agent servers over
  `InMemoryTransport`, sharing one in-memory DB (`test/helpers.ts`:
  `createBus`, `connectAgent`, `call`). This exercises Zod validation and result
  serialization, not just raw SQL — prefer it for new tool tests.
- `connectAgent` upserts the agent (mirroring the HTTP identity middleware) so
  `list_agents`/`broadcast` see it.
- When adding a tool, add a test in the matching `test/*.test.ts`. Keep the
  acceptance behaviors green: per-recipient read state, broadcast exclusion,
  prompt long-poll wake, clean timeout, and the 50-way `claim_task` race.

## Gotchas

- Don't `await` `better-sqlite3` calls — they're synchronous.
- `:memory:` DBs can't exercise WAL; the WAL assertion is via the real-file path.
- New SSE event types must be added to `BusEvent` (`events.ts`), the
  `eventPayload` switch (`index.ts`), and `isRelevantTo` if they need targeting.
- Env vars: `AGENT_BUS_DB_PATH`, `PORT`, `HOST`, `LOG_LEVEL`.
- Scope guardrails (don't build without asking): auth beyond `x-agent-id`, TLS,
  multi-host/clustering, first-class threading (use `metadata.in_reply_to`), a UI.
- Ask before adding any runtime dependency. Current set: `@modelcontextprotocol/sdk`,
  `better-sqlite3`, `zod`, `pino`.
