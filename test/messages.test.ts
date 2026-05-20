import { describe, it, expect, beforeEach } from "vitest";
import { createBus, connectAgent, call } from "./helpers.js";
import type { BusContext } from "../src/context.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("direct messaging", () => {
  let ctx: BusContext;
  let alice: Client;
  let bob: Client;

  beforeEach(async () => {
    ctx = createBus();
    alice = await connectAgent(ctx, "alice");
    bob = await connectAgent(ctx, "bob");
  });

  it("delivers a direct message to the recipient only", async () => {
    const sent = await call(alice, "send_message", {
      to: "bob",
      subject: "hi",
      body: "ping",
    });
    expect(sent.message_id).toBeGreaterThan(0);

    const bobInbox = await call(bob, "get_inbox", {});
    expect(bobInbox.messages).toHaveLength(1);
    expect(bobInbox.messages[0]).toMatchObject({
      from: "alice",
      to: "bob",
      subject: "hi",
      body: "ping",
      is_broadcast: false,
      read_at: null,
    });

    // Sender does not see their own outbound message in their inbox.
    const aliceInbox = await call(alice, "get_inbox", {});
    expect(aliceInbox.messages).toHaveLength(0);
  });

  it("tracks read state per recipient", async () => {
    const sent = await call(alice, "send_message", { to: "bob", body: "x" });

    const marked = await call(bob, "mark_read", {
      message_ids: [sent.message_id],
    });
    expect(marked.marked).toBe(1);

    // Unread query is now empty for bob; full query still shows it as read.
    expect((await call(bob, "get_inbox", { unread_only: true })).messages).toHaveLength(0);
    const all = await call(bob, "get_inbox", { unread_only: false });
    expect(all.messages).toHaveLength(1);
    expect(all.messages[0].read_at).toBeGreaterThan(0);

    // Re-marking an already-read message is a no-op.
    expect((await call(bob, "mark_read", { message_ids: [sent.message_id] })).marked).toBe(0);
  });

  it("broadcast reaches every other agent but not the sender", async () => {
    const carol = await connectAgent(ctx, "carol");

    const result = await call(alice, "broadcast", { body: "standup in 5" });
    expect(result.recipients.sort()).toEqual(["bob", "carol"]);

    for (const agent of [bob, carol]) {
      const inbox = await call(agent, "get_inbox", {});
      expect(inbox.messages).toHaveLength(1);
      expect(inbox.messages[0]).toMatchObject({
        from: "alice",
        to: null,
        is_broadcast: true,
      });
    }

    // Sender is excluded.
    expect((await call(alice, "get_inbox", {})).messages).toHaveLength(0);
  });

  it("broadcast read state is independent per recipient", async () => {
    const carol = await connectAgent(ctx, "carol");
    const bc = await call(alice, "broadcast", { body: "hello all" });

    await call(bob, "mark_read", { message_ids: [bc.message_id] });

    // Bob marked it read; carol still has it unread.
    expect((await call(bob, "get_inbox", { unread_only: true })).messages).toHaveLength(0);
    expect((await call(carol, "get_inbox", { unread_only: true })).messages).toHaveLength(1);
  });

  it("supports since filtering", async () => {
    const first = await call(alice, "send_message", { to: "bob", body: "1" });
    await new Promise((r) => setTimeout(r, 5));
    const cutoff = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    await call(alice, "send_message", { to: "bob", body: "2" });

    const recent = await call(bob, "get_inbox", { unread_only: false, since: cutoff });
    expect(recent.messages).toHaveLength(1);
    expect(recent.messages[0].body).toBe("2");
    expect(first.message_id).toBeGreaterThan(0);
  });
});
