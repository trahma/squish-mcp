# Agent coordination via squish (autonomous worker mode)

> Drop this into your project's `AGENTS.md` (OpenCode) or `CLAUDE.md` (Claude Code),
> adapting the roles to your team. It turns each agent into an autonomous worker that
> actively pulls work off the [squish](https://github.com/trahma/squish-mcp) bus via
> `wait_for_message` — no SSE plugin required in this mode.

You are one of several AI agents collaborating through the **squish** message bus
(exposed as MCP tools). Your identity is fixed by your `AGENT_ID`. Operate as an
autonomous worker: actively wait for and process work until the user tells you to stop.

## On startup
1. `whoami` — confirm your identity and role.
2. `list_agents` — see who else is on the bus.
3. `list_tasks` — see outstanding work.
4. Enter the **worker loop** below.

## Worker loop — run continuously
Repeat until told to stop. Do **not** end your turn while in worker mode; keep
calling these tools so you stay active.

1. **Pick up tasks.** `list_tasks` (status `pending`). For a task that matches your
   role and whose dependencies are met, `claim_task`. If it returns `claimed:false`,
   someone else got it — move on. On a successful claim:
   - `update_task_status` → `in_progress`
   - do the work
   - `update_task_status` → `completed` with a `result` (or `failed` with `notes`).
     Completing a task unblocks tasks that depend on it.
2. **Handle direct coordination.** Call `wait_for_message` (`timeout_seconds: 60`).
   - Messages returned → handle each (do what it asks; reply with `send_message`,
     setting `metadata.in_reply_to` to the message id), then `mark_read` them.
   - `timed_out: true` → nothing arrived; just continue.
3. Go back to step 1.

`wait_for_message` blocks efficiently (up to the timeout) instead of busy-polling,
so this loop is cheap while idle and reacts immediately when work arrives.

## Conventions (the social contract — the bus enforces none of this)
- **Claim before working.** Never touch a task you haven't successfully claimed.
- **Always close out tasks** (`completed`/`failed` + `result`) so dependents unblock
  and others can see progress.
- **Stay in your lane.** Only do work matching your role; if something needs another
  role, create a task or `send_message` its owner instead of doing it yourself.
- **Direct vs broadcast.** `send_message` for "I need X from you"; `broadcast` only
  for things everyone must know (e.g., a shared interface changed).
- **Reply to questions** addressed to you; don't leave a teammate blocked.

## Stopping
When the user says to stop (or you're told to wrap up): finish the current task,
post a final status (`send_message`/`broadcast` or a task `result`), and stop
calling `wait_for_message`.

## Long-running sessions
A continuous loop accumulates context. If the session grows large, summarize what's
done and in-flight, then let the user restart you fresh — squish persists all bus
state (tasks, messages, read status), so a restarted agent can `list_tasks` /
`get_inbox` and pick up exactly where things stand.
```
