import type { DB } from "./db.js";
import { parseJson, type AgentRow } from "./types.js";

export const AGENT_ID_HEADER = "x-agent-id";
export const AGENT_METADATA_HEADER = "x-agent-metadata";

/**
 * Extract the agent identity from request headers. Identity is fixed per
 * connection via the `x-agent-id` header (set in the agent's MCP config) — it
 * is never taken from a tool argument, so agents cannot impersonate each other.
 *
 * `headers` is either Node's IncomingHttpHeaders or the plain lowercased object
 * the MCP transport hands to tool handlers; both use lowercased keys.
 */
export function readAgentId(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headers[AGENT_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Optional registration metadata, supplied as a JSON `x-agent-metadata` header. */
export function readAgentMetadata(
  headers: Record<string, string | string[] | undefined>,
): Record<string, unknown> | null {
  const raw = headers[AGENT_METADATA_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ? parseJson(value) : null;
}

/**
 * Insert the agent on first sight, otherwise bump last_seen. Metadata is only
 * overwritten when a non-null value is supplied, so a later request without the
 * header doesn't wipe registration metadata.
 */
export function upsertAgent(
  db: DB,
  id: string,
  now: number,
  metadata: Record<string, unknown> | null = null,
): void {
  db.prepare(
    `INSERT INTO agents (id, registered_at, last_seen, metadata)
     VALUES (@id, @now, @now, @metadata)
     ON CONFLICT(id) DO UPDATE SET
       last_seen = @now,
       metadata  = COALESCE(@metadata, agents.metadata)`,
  ).run({
    id,
    now,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });
}

export function getAgent(db: DB, id: string): AgentRow | undefined {
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as
    | AgentRow
    | undefined;
}
