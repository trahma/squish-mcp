import { describe, it, expect, beforeEach } from "vitest";
import { createBus, connectAgent, call } from "./helpers.js";
import type { BusContext } from "../src/context.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("wait_for_message long-poll", () => {
  let ctx: BusContext;
  let alice: Client;
  let bob: Client;

  beforeEach(async () => {
    ctx = createBus();
    alice = await connectAgent(ctx, "alice");
    bob = await connectAgent(ctx, "bob");
  });

  it("returns immediately when unread messages already exist", async () => {
    await call(alice, "send_message", { to: "bob", body: "already here" });
    const start = Date.now();
    const result = await call(bob, "wait_for_message", { timeout_seconds: 30 });
    expect(Date.now() - start).toBeLessThan(200);
    expect(result.timed_out).toBe(false);
    expect(result.messages).toHaveLength(1);
  });

  it("wakes within ~50ms when a message arrives during the wait", async () => {
    const start = Date.now();
    const waiting = call(bob, "wait_for_message", { timeout_seconds: 30 });

    // Send shortly after the wait begins.
    setTimeout(() => {
      void call(alice, "send_message", { to: "bob", body: "wake up" });
    }, 30);

    const result = await waiting;
    const elapsed = Date.now() - start;
    expect(result.timed_out).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].body).toBe("wake up");
    expect(elapsed).toBeLessThan(500); // woke promptly, not after the 30s timeout
  });

  it("times out cleanly when no message arrives", async () => {
    const start = Date.now();
    const result = await call(bob, "wait_for_message", { timeout_seconds: 1 });
    const elapsed = Date.now() - start;
    expect(result.timed_out).toBe(true);
    expect(result.messages).toHaveLength(0);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2000);
  });

  it("wakes a waiter on broadcast too", async () => {
    const waiting = call(bob, "wait_for_message", { timeout_seconds: 30 });
    setTimeout(() => void call(alice, "broadcast", { body: "to everyone" }), 20);
    const result = await waiting;
    expect(result.timed_out).toBe(false);
    expect(result.messages[0].is_broadcast).toBe(true);
  });
});
