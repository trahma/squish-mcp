import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { rowToMessage, type MessageRow } from "../src/types.js";

describe("db schema", () => {
  it("creates all tables on a fresh database", () => {
    const db = openDb({ path: ":memory:", quiet: true });
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toContain("agents");
    expect(tables).toContain("messages");
    expect(tables).toContain("message_reads");
    expect(tables).toContain("tasks");
    db.close();
  });

  it("inserts and queries a single message round-trip", () => {
    const db = openDb({ path: ":memory:", quiet: true });
    const now = Date.now();

    const info = db
      .prepare(
        `INSERT INTO messages (from_agent, to_agent, subject, body, metadata, created_at)
         VALUES (@from, @to, @subject, @body, @metadata, @created_at)`,
      )
      .run({
        from: "backend-1",
        to: "frontend-1",
        subject: "hello",
        body: "the API is ready",
        metadata: JSON.stringify({ in_reply_to: 7 }),
        created_at: now,
      });

    expect(info.changes).toBe(1);
    const id = Number(info.lastInsertRowid);
    expect(id).toBeGreaterThan(0);

    const row = db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(id) as MessageRow;

    const msg = rowToMessage(row);
    expect(msg).toMatchObject({
      message_id: id,
      from: "backend-1",
      to: "frontend-1",
      subject: "hello",
      body: "the API is ready",
      created_at: now,
      read_at: null,
      is_broadcast: false,
    });
    expect(msg.metadata).toEqual({ in_reply_to: 7 });
    db.close();
  });
});
