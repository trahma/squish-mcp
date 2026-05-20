import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BusContext } from "../context.js";
import { preview } from "../events.js";
import { ulid } from "../ulid.js";
import { parseJson, rowToTask, type TaskRow } from "../types.js";
import { jsonResult } from "./_shared.js";

const UPDATABLE_STATUS = z.enum([
  "in_progress",
  "blocked",
  "completed",
  "failed",
]);

export function registerTaskTools(
  server: McpServer,
  ctx: BusContext,
  agentId: string,
): void {
  const getTask = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?");

  server.registerTool(
    "create_task",
    {
      title: "Create a task",
      description:
        "Add a task to the shared list for any agent to claim. Optionally declare " +
        "dependencies (task IDs) that must complete before this task can be claimed. " +
        "Returns the new task ID.",
      inputSchema: {
        title: z.string().min(1).describe("Short task title."),
        description: z
          .string()
          .optional()
          .describe("Longer description / acceptance criteria."),
        depends_on: z
          .array(z.string())
          .optional()
          .describe("Task IDs that must be completed before this can be claimed."),
        metadata: z.record(z.unknown()).optional().describe("Optional metadata."),
      },
    },
    ({ title, description, depends_on, metadata }) => {
      const now = Date.now();
      const taskId = ulid(now);
      ctx.db
        .prepare(
          `INSERT INTO tasks
             (id, title, description, status, assignee, depends_on, metadata, result, created_at, updated_at)
           VALUES (@id, @title, @description, 'pending', NULL, @depends_on, @metadata, NULL, @now, @now)`,
        )
        .run({
          id: taskId,
          title,
          description: description ?? null,
          depends_on: depends_on ? JSON.stringify(depends_on) : null,
          metadata: metadata ? JSON.stringify(metadata) : null,
          now,
        });

      ctx.events.publish({ type: "task_created", task_id: taskId, title });
      return jsonResult({ task_id: taskId, created_at: now });
    },
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "Query the shared task list. Filter by status or assignee. Completed tasks " +
        "are hidden unless include_completed is true or you filter on status='completed'.",
      inputSchema: {
        status: z
          .enum([
            "pending",
            "claimed",
            "in_progress",
            "blocked",
            "completed",
            "failed",
          ])
          .optional()
          .describe("Only return tasks in this status."),
        assignee: z
          .string()
          .optional()
          .describe("Only return tasks claimed by this agent ID."),
        include_completed: z
          .boolean()
          .default(false)
          .describe("Include completed tasks (ignored if status is set)."),
      },
    },
    ({ status, assignee, include_completed }) => {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (status) {
        clauses.push("status = @status");
        params.status = status;
      } else if (!include_completed) {
        clauses.push("status != 'completed'");
      }
      if (assignee) {
        clauses.push("assignee = @assignee");
        params.assignee = assignee;
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = ctx.db
        .prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC`)
        .all(params) as TaskRow[];
      return jsonResult({ tasks: rows.map(rowToTask) });
    },
  );

  server.registerTool(
    "claim_task",
    {
      title: "Claim a task",
      description:
        "Atomically claim a pending task so no other agent can take it. Fails if " +
        "the task is already claimed, doesn't exist, or has unmet dependencies. " +
        "On success the task is assigned to you in 'claimed' state.",
      inputSchema: {
        task_id: z.string().min(1).describe("ID of the task to claim."),
      },
    },
    ({ task_id }) => {
      const now = Date.now();
      // Race-safe: the UPDATE only fires if the row is still pending AND every
      // dependency is completed. changes() tells us if we won.
      const info = ctx.db
        .prepare(
          `UPDATE tasks
              SET status = 'claimed', assignee = @agent, updated_at = @now
            WHERE id = @id
              AND status = 'pending'
              AND NOT EXISTS (
                    SELECT 1 FROM json_each(COALESCE(tasks.depends_on, '[]')) dep
                     WHERE NOT EXISTS (
                       SELECT 1 FROM tasks t2
                        WHERE t2.id = dep.value AND t2.status = 'completed'
                     )
                  )`,
        )
        .run({ id: task_id, agent: agentId, now });

      if (info.changes === 1) {
        const task = rowToTask(getTask.get(task_id) as TaskRow);
        ctx.events.publish({
          type: "task_claimed",
          task_id,
          assignee: agentId,
        });
        return jsonResult({ claimed: true, task });
      }

      // Didn't win — explain why.
      const row = getTask.get(task_id) as TaskRow | undefined;
      if (!row) return jsonResult({ claimed: false, reason: "not_found" });
      if (row.status !== "pending")
        return jsonResult({ claimed: false, reason: "already_claimed" });
      return jsonResult({ claimed: false, reason: "dependencies_pending" });
    },
  );

  server.registerTool(
    "update_task_status",
    {
      title: "Update task status",
      description:
        "Move a task you've claimed through its lifecycle (in_progress, blocked, " +
        "completed, failed). Only the assignee may update it. Attach optional notes " +
        "and a result. Completing a task unblocks tasks that depend on it.",
      inputSchema: {
        task_id: z.string().min(1).describe("ID of the task to update."),
        status: UPDATABLE_STATUS.describe("New status."),
        notes: z
          .string()
          .optional()
          .describe("Optional progress notes (stored in task metadata)."),
        result: z
          .string()
          .optional()
          .describe("Optional result/output, typically set on completion."),
      },
    },
    ({ task_id, status, notes, result }) => {
      const update = ctx.db.transaction(() => {
        const row = getTask.get(task_id) as TaskRow | undefined;
        if (!row) return { updated: false, reason: "not_found" as const };
        if (row.assignee !== agentId)
          return { updated: false, reason: "not_assignee" as const };

        const metadata = parseJson(row.metadata) ?? {};
        if (notes !== undefined) metadata.notes = notes;

        ctx.db
          .prepare(
            `UPDATE tasks
                SET status = @status,
                    result = @result,
                    metadata = @metadata,
                    updated_at = @now
              WHERE id = @id`,
          )
          .run({
            id: task_id,
            status,
            result: result ?? row.result,
            metadata: JSON.stringify(metadata),
            now: Date.now(),
          });

        return {
          updated: true as const,
          task: rowToTask(getTask.get(task_id) as TaskRow),
        };
      });

      const outcome = update();
      if (outcome.updated && outcome.task && status === "completed") {
        ctx.events.publish({
          type: "task_completed",
          task_id,
          assignee: agentId,
          result_preview: outcome.task.result
            ? preview(outcome.task.result)
            : null,
        });
      }
      return jsonResult(outcome);
    },
  );
}
