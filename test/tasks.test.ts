import { describe, it, expect, beforeEach } from "vitest";
import { createBus, connectAgent, call } from "./helpers.js";
import type { BusContext } from "../src/context.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("shared task list", () => {
  let ctx: BusContext;
  let alice: Client;
  let bob: Client;

  beforeEach(async () => {
    ctx = createBus();
    alice = await connectAgent(ctx, "alice");
    bob = await connectAgent(ctx, "bob");
  });

  it("creates, lists, claims, and completes a task", async () => {
    const created = await call(alice, "create_task", {
      title: "Build API",
      description: "REST endpoints",
    });
    expect(created.task_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const pending = await call(bob, "list_tasks", { status: "pending" });
    expect(pending.tasks).toHaveLength(1);

    const claim = await call(bob, "claim_task", { task_id: created.task_id });
    expect(claim.claimed).toBe(true);
    expect(claim.task.assignee).toBe("bob");
    expect(claim.task.status).toBe("claimed");

    const progress = await call(bob, "update_task_status", {
      task_id: created.task_id,
      status: "in_progress",
      notes: "started",
    });
    expect(progress.updated).toBe(true);
    expect(progress.task.metadata.notes).toBe("started");

    const done = await call(bob, "update_task_status", {
      task_id: created.task_id,
      status: "completed",
      result: "shipped",
    });
    expect(done.task.status).toBe("completed");
    expect(done.task.result).toBe("shipped");
  });

  it("hides completed tasks unless asked", async () => {
    const t = await call(alice, "create_task", { title: "temp" });
    await call(alice, "claim_task", { task_id: t.task_id });
    await call(alice, "update_task_status", {
      task_id: t.task_id,
      status: "completed",
    });

    expect((await call(bob, "list_tasks", {})).tasks).toHaveLength(0);
    expect(
      (await call(bob, "list_tasks", { include_completed: true })).tasks,
    ).toHaveLength(1);
    expect(
      (await call(bob, "list_tasks", { status: "completed" })).tasks,
    ).toHaveLength(1);
  });

  it("rejects claiming a task with unmet dependencies", async () => {
    const dep = await call(alice, "create_task", { title: "dependency" });
    const blocked = await call(alice, "create_task", {
      title: "needs dep",
      depends_on: [dep.task_id],
    });

    const fail = await call(bob, "claim_task", { task_id: blocked.task_id });
    expect(fail.claimed).toBe(false);
    expect(fail.reason).toBe("dependencies_pending");

    // Complete the dependency, then the claim succeeds.
    await call(alice, "claim_task", { task_id: dep.task_id });
    await call(alice, "update_task_status", {
      task_id: dep.task_id,
      status: "completed",
    });

    const ok = await call(bob, "claim_task", { task_id: blocked.task_id });
    expect(ok.claimed).toBe(true);
  });

  it("reports not_found and already_claimed reasons", async () => {
    expect((await call(bob, "claim_task", { task_id: "NOPE" })).reason).toBe(
      "not_found",
    );

    const t = await call(alice, "create_task", { title: "one" });
    await call(alice, "claim_task", { task_id: t.task_id });
    const second = await call(bob, "claim_task", { task_id: t.task_id });
    expect(second.claimed).toBe(false);
    expect(second.reason).toBe("already_claimed");
  });

  it("only the assignee may update a task", async () => {
    const t = await call(alice, "create_task", { title: "mine" });
    await call(alice, "claim_task", { task_id: t.task_id });

    const rejected = await call(bob, "update_task_status", {
      task_id: t.task_id,
      status: "in_progress",
    });
    expect(rejected.updated).toBe(false);
    expect(rejected.reason).toBe("not_assignee");
  });
});
