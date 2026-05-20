import { describe, it, expect } from "vitest";
import { createBus, connectAgent, call } from "./helpers.js";

describe("claim_task race safety", () => {
  it("exactly one of 50 concurrent claims on the same task wins", async () => {
    const ctx = createBus();
    const creator = await connectAgent(ctx, "creator");
    const { task_id } = await call(creator, "create_task", {
      title: "contended task",
    });

    // 50 distinct agents all try to claim the same pending task at once.
    const claimers = await Promise.all(
      Array.from({ length: 50 }, (_, i) => connectAgent(ctx, `worker-${i}`)),
    );
    const results = await Promise.all(
      claimers.map((c) => call(c, "claim_task", { task_id })),
    );

    const winners = results.filter((r) => r.claimed === true);
    const losers = results.filter((r) => r.claimed === false);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(49);
    expect(losers.every((r) => r.reason === "already_claimed")).toBe(true);

    // The DB agrees: the task is claimed by exactly one of the workers.
    const listed = await call(creator, "list_tasks", { status: "claimed" });
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0].assignee).toBe(winners[0].task.assignee);
  });
});
