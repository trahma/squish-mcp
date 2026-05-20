import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BusContext } from "../context.js";
import { inTransaction } from "../db.js";
import { preview } from "../events.js";
import {
  rowToMessage,
  type Message,
  type MessageRow,
} from "../types.js";
import { jsonResult } from "./_shared.js";

interface InboxQuery {
  unreadOnly: boolean;
  limit?: number;
  since?: number | null;
}

/**
 * Unified inbox view across direct messages and broadcasts.
 *  - direct: messages.to_agent = me, read state via messages.read_at
 *  - broadcast: messages.to_agent IS NULL and from != me, read state via
 *    message_reads (per-recipient)
 * read_at on each returned Message reflects the effective per-recipient state.
 */
export function queryInbox(
  ctx: BusContext,
  agentId: string,
  { unreadOnly, limit, since = null }: InboxQuery,
): Message[] {
  const rows = ctx.db
    .prepare(
      `SELECT m.*,
              CASE WHEN m.to_agent IS NULL THEN mr.read_at ELSE m.read_at END
                AS effective_read_at
         FROM messages m
         LEFT JOIN message_reads mr
           ON mr.message_id = m.id AND mr.agent_id = @agent
        WHERE (m.to_agent = @agent
               OR (m.to_agent IS NULL AND m.from_agent != @agent))
          AND (@since IS NULL OR m.created_at >= @since)
          AND (@unread_only = 0
               OR (CASE WHEN m.to_agent IS NULL THEN mr.read_at ELSE m.read_at END) IS NULL)
        ORDER BY m.id ASC
        LIMIT @limit`,
    )
    .all({
      agent: agentId,
      since,
      unread_only: unreadOnly ? 1 : 0,
      limit: limit ?? 200,
    }) as unknown as Array<MessageRow & { effective_read_at: number | null }>;

  return rows.map((row) =>
    rowToMessage({ ...row, read_at: row.effective_read_at }),
  );
}

export function registerMessageTools(
  server: McpServer,
  ctx: BusContext,
  agentId: string,
): void {
  server.registerTool(
    "send_message",
    {
      title: "Send a direct message",
      description:
        "Send a direct message to one agent (by its agent ID). The recipient " +
        "retrieves it via get_inbox or wait_for_message. Returns the message ID.",
      inputSchema: {
        to: z.string().min(1).describe("Recipient agent ID."),
        body: z.string().min(1).describe("Message body."),
        subject: z.string().optional().describe("Optional short subject line."),
        metadata: z
          .record(z.unknown())
          .optional()
          .describe(
            "Optional structured metadata, e.g. { in_reply_to: 42 } for threading.",
          ),
      },
    },
    ({ to, body, subject, metadata }) => {
      const now = Date.now();
      const info = ctx.db
        .prepare(
          `INSERT INTO messages (from_agent, to_agent, subject, body, metadata, created_at)
           VALUES (@from, @to, @subject, @body, @metadata, @now)`,
        )
        .run({
          from: agentId,
          to,
          subject: subject ?? null,
          body,
          metadata: metadata ? JSON.stringify(metadata) : null,
          now,
        });

      const messageId = Number(info.lastInsertRowid);
      ctx.events.publish(
        {
          type: "message",
          to,
          from: agentId,
          message_id: messageId,
          subject: subject ?? null,
          preview: preview(body),
        },
        [to],
      );
      return jsonResult({ message_id: messageId, created_at: now });
    },
  );

  server.registerTool(
    "broadcast",
    {
      title: "Broadcast a message",
      description:
        "Send a message to every other known agent (you are excluded). Stored " +
        "as a single broadcast that each recipient reads and acknowledges " +
        "independently. Returns the recipient list at send time.",
      inputSchema: {
        body: z.string().min(1).describe("Message body."),
        subject: z.string().optional().describe("Optional short subject line."),
        metadata: z.record(z.unknown()).optional().describe("Optional metadata."),
      },
    },
    ({ body, subject, metadata }) => {
      const now = Date.now();
      const recipients = (
        ctx.db
          .prepare("SELECT id FROM agents WHERE id != ?")
          .all(agentId) as Array<{ id: string }>
      ).map((r) => r.id);

      const info = ctx.db
        .prepare(
          `INSERT INTO messages (from_agent, to_agent, subject, body, metadata, created_at)
           VALUES (@from, NULL, @subject, @body, @metadata, @now)`,
        )
        .run({
          from: agentId,
          subject: subject ?? null,
          body,
          metadata: metadata ? JSON.stringify(metadata) : null,
          now,
        });

      const messageId = Number(info.lastInsertRowid);
      ctx.events.publish(
        {
          type: "message",
          to: null,
          from: agentId,
          message_id: messageId,
          subject: subject ?? null,
          preview: preview(body),
        },
        recipients,
      );
      return jsonResult({
        message_id: messageId,
        recipients,
        created_at: now,
      });
    },
  );

  server.registerTool(
    "get_inbox",
    {
      title: "Get inbox",
      description:
        "Retrieve messages addressed to you (direct messages and broadcasts). " +
        "Does NOT mark anything as read — call mark_read explicitly. Defaults to " +
        "unread only, newest-bounded by `since` if provided.",
      inputSchema: {
        unread_only: z
          .boolean()
          .default(true)
          .describe("Only return messages you haven't marked read."),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .default(50)
          .describe("Max messages to return (<= 200)."),
        since: z
          .number()
          .int()
          .optional()
          .describe("Only messages created at/after this epoch-ms timestamp."),
      },
    },
    ({ unread_only, limit, since }) => {
      const messages = queryInbox(ctx, agentId, {
        unreadOnly: unread_only,
        limit,
        since: since ?? null,
      });
      return jsonResult({ messages });
    },
  );

  server.registerTool(
    "mark_read",
    {
      title: "Mark messages read",
      description:
        "Acknowledge messages by ID. Read state is per-recipient: marking a " +
        "broadcast read affects only you. Returns how many were newly marked.",
      inputSchema: {
        message_ids: z
          .array(z.number().int().positive())
          .min(1)
          .describe("IDs of messages to mark read."),
      },
    },
    ({ message_ids }) => {
      const now = Date.now();
      const markDirect = ctx.db.prepare(
        `UPDATE messages SET read_at = @now
          WHERE id = @id AND to_agent = @agent AND read_at IS NULL`,
      );
      // Only record a broadcast read if it's a real broadcast not sent by us.
      const markBroadcast = ctx.db.prepare(
        `INSERT OR IGNORE INTO message_reads (message_id, agent_id, read_at)
         SELECT @id, @agent, @now
           FROM messages
          WHERE id = @id AND to_agent IS NULL AND from_agent != @agent`,
      );

      const marked = inTransaction(ctx.db, () => {
        let count = 0;
        for (const id of message_ids) {
          count += Number(markDirect.run({ id, agent: agentId, now }).changes);
          count += Number(markBroadcast.run({ id, agent: agentId, now }).changes);
        }
        return count;
      });

      return jsonResult({ marked });
    },
  );

  server.registerTool(
    "wait_for_message",
    {
      title: "Wait for a message",
      description:
        "Long-poll for new messages: returns immediately if you have unread " +
        "messages, otherwise blocks until one arrives or the timeout elapses. " +
        "Use this to idle efficiently instead of polling get_inbox in a loop. " +
        "Does NOT mark messages read.",
      inputSchema: {
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .max(120)
          .default(30)
          .describe("Max seconds to block (<= 120)."),
        unread_only: z
          .boolean()
          .default(true)
          .describe("Whether to consider only unread messages."),
      },
    },
    async ({ timeout_seconds, unread_only }) => {
      const read = () =>
        queryInbox(ctx, agentId, { unreadOnly: unread_only, limit: 200 });

      let messages = read();
      if (messages.length === 0) {
        await ctx.events.waitForMessage(agentId, timeout_seconds * 1000);
        messages = read();
      }
      return jsonResult({ messages, timed_out: messages.length === 0 });
    },
  );
}
