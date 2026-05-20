/**
 * Shared row types and the JSON-serializable shapes returned by tools.
 *
 * "Row" types mirror the SQLite columns exactly (metadata as a JSON string,
 * nullable columns as `| null`). The public Message/Task types are what tools
 * hand back to agents (metadata parsed, broadcast flagged, etc.).
 */

export interface MessageRow {
  id: number;
  from_agent: string;
  to_agent: string | null;
  subject: string | null;
  body: string;
  metadata: string | null;
  created_at: number;
  read_at: number | null;
}

export interface Message {
  message_id: number;
  from: string;
  to: string | null; // null = broadcast
  subject: string | null;
  body: string;
  metadata: Record<string, unknown> | null;
  created_at: number;
  read_at: number | null;
  is_broadcast: boolean;
}

export type TaskStatus =
  | "pending"
  | "claimed"
  | "in_progress"
  | "blocked"
  | "completed"
  | "failed";

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee: string | null;
  depends_on: string | null; // JSON array
  metadata: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
}

export interface Task {
  task_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee: string | null;
  depends_on: string[];
  metadata: Record<string, unknown> | null;
  result: string | null;
  created_at: number;
  updated_at: number;
}

export interface AgentRow {
  id: string;
  registered_at: number;
  last_seen: number;
  metadata: string | null;
}

/** Parse a JSON column, returning null on empty/invalid input. */
export function parseJson(value: string | null): Record<string, unknown> | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function rowToMessage(row: MessageRow): Message {
  return {
    message_id: row.id,
    from: row.from_agent,
    to: row.to_agent,
    subject: row.subject,
    body: row.body,
    metadata: parseJson(row.metadata),
    created_at: row.created_at,
    read_at: row.read_at,
    is_broadcast: row.to_agent === null,
  };
}

export function rowToTask(row: TaskRow): Task {
  return {
    task_id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    assignee: row.assignee,
    depends_on: row.depends_on ? (JSON.parse(row.depends_on) as string[]) : [],
    metadata: parseJson(row.metadata),
    result: row.result,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
