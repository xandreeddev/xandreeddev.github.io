---
title: 'A blocking spawn is a missed parallelism'
description: 'Sub-agents that return a handle instead of a result: non-blocking spawn, an in-memory bus, and the one discipline that keeps a lockless fleet from corrupting itself.'
pubDate: 2026-08-05
tags: [agents, effect, ai]
series:
  name: 'Building a coding agent'
  order: 11
draft: true
---

Here is the line nearly every agent framework writes for delegation:

```ts
const result = await run_agent({ folder: 'packages/api', task: '…' })
// the parent is now frozen until the child finishes. one. at. a. time.
```

For a single sub-agent that's fine — you delegated *because* you wanted to wait for the answer. But the moment a turn wants to fan out — "audit these four packages," "investigate the bug while you draft the fix" — the blocking `await` turns a fleet into a queue. Three sub-agents that could run in parallel run in sequence, because the parent can only be inside one `await` at a time. You bought concurrency hardware and wrote a single-threaded program on top of it.

A [companion post](/posts/persistent-context-tree/) covered what a sub-agent leaves *behind* — a persisted, resumable node in a tree. This one is about what a spawn *returns*, and the answer that unlocks the fleet is: not a result. A handle.

## Spawn returns a ticket, not an answer

In [efferent](https://github.com/xandreeddev/efferent), the coding agent I'm building on Effect, `run_agent` doesn't block. It registers a background run and returns immediately:

```ts
run_agent({ folder: 'packages/api', task: '…' })
// → { nodeId: '…', name: 'audit api', status: 'running' }  — returns NOW
```

The sub-agent runs as a **daemon fiber** — forked off the parent's, supervised, but not awaited. The parent's turn keeps going: it can spawn three more, post a note to the others, or just finish its sentence. The tool's own description teaches the shape, because the description is the contract the model reads every turn:

> Spawning is **non-blocking**. `run_agent` returns immediately with `{ nodeId, name, status: "running" }` — the sub-agent works in the BACKGROUND. To get a result, call **`wait_for_agents`**; or keep working and each completion lands in your inbox at a turn boundary. Hold the `nodeId` — you pass it to `wait_for_agents`, `send_message`, or `seedFromNode`.

That `nodeId` is a claim ticket. The work is happening whether or not the parent is watching; the ticket is how it redeems the result later — by waiting on it, messaging it, or (the [tree post](/posts/persistent-context-tree/)'s subject) resuming or branching from it days later. "Fan out four investigations" is now four quick tool calls that each return a ticket, and four fibers running at once.

## The bus: a mailbox, a latch, and a blackboard

Background fibers need a way to talk and a way to be collected. That's one in-memory service — the **bus** — and its whole surface is small enough to read:

```ts title="packages/sdk-core/src/usecases/agentBus.ts"
export interface AgentBus {
  readonly markRunning: (nodeId: string, label: string, /* … */) => Effect.Effect<void>
  readonly complete: (nodeId: string, result: AgentResult) => Effect.Effect<void> // fulfils the latch

  // direct messages — an inbox per agent
  readonly post: (nodeId: string, msg: InboxMessage) => Effect.Effect<boolean>
  readonly drain: (nodeId: string) => Effect.Effect<ReadonlyArray<InboxMessage>> // take + clear

  // the blackboard — one shared scratchpad everybody posts to and reads
  readonly boardPost: (note: BoardNote) => Effect.Effect<void>
  readonly boardRead: () => Effect.Effect<ReadonlyArray<BoardNote>>

  // gather without blocking: race the watched agents' completions
  // against the waiter's OWN inbox, up to a timeout
  readonly awaitChange: (opts: {
    readonly waiterKey: string
    readonly watch: ReadonlyArray<string>
    readonly timeoutMs: number
  }) => Effect.Effect<BusChange> // [!code highlight]

  readonly interruptAll: () => Effect.Effect<void> // Esc kills the whole tree
}
```

Three communication shapes, each a different question. **`post`/`drain`** is a direct message — an inbox per agent, drained at a turn boundary (more on *why* a turn boundary in a moment). **`boardPost`/`boardRead`** is a shared blackboard: a sub-agent that discovers "the retry config actually lives in `core`, not here" posts it once and every sibling can read it, so parallel investigations don't each rediscover the same fact. And **`complete`** fulfils a latch — the bus's internal `Deferred`, the one-shot cell a waiter is parked on.

`awaitChange` is the centerpiece, and the highlight is why. `wait_for_agents` doesn't block the process; it *races* three things — any watched agent finishing, a message arriving in the waiter's own inbox, or a timeout — and returns on the first. So a parent waiting on its writers is still reachable: another agent can message it, a child can report progress, and it wakes for that too, not just for completion. Blocking, but cooperatively — the difference between a thread parked on a mutex and a fiber selecting on three channels.

## Messages arrive at turn boundaries, never mid-pairing

The subtle constraint is *when* a delivered message enters a running agent's context. A sub-agent is, at any instant, possibly mid-turn — it has emitted tool calls whose results haven't come back yet. Splice a new user message in *there* and you've put a message between a tool call and its result, which every provider rejects as a malformed transcript.

So the loop drains its inbox at exactly one place: the **turn boundary**, through the same hook that lets a turn reshape its own context before the next model call.

```ts
// in the loop, once per turn, BEFORE building the next prompt:
onTransformContext: (messages) =>
  Effect.gen(function* () {
    const inbox = yield* bus.drain(nodeId)          // take everything waiting
    return inbox.length === 0
      ? messages
      : [...messages, ...inbox.map(toUserMessage)]  // fold it in, cleanly paired
  }),
```

Delivery is therefore *eventually* prompt — a message posted while an agent is mid-turn waits until that turn closes, then folds in as the next user message. That latency is the price of never corrupting the transcript, and it's the right trade: a few seconds of delay versus a hard provider 400. The same boundary is where a budget-exhausted fleet stops its running agents — turn edges are the only safe seams in an agent loop, and once you have one, every "do this between turns" feature reuses it.

## The lock you don't have

Here's the part that surprised me to build. Folder-scoped sub-agents make *disjoint* folders safe to run at once — two agents editing different packages can't race. The obvious next move is a per-folder write lock so *same-folder* spawns serialize too. efferent had exactly that, a `Ref<Map<folder, Semaphore>>`, and then deleted it.

The lock couldn't see the overlap that actually bites: an agent writing `packages/sdk-core` and another writing `packages/sdk-core/auth` aren't in the same folder, so a per-folder lock waves them both through — and they corrupt each other anyway. Catching that means locking on ancestor/descendant ranges, which means holding several locks at once, which means a deadlock risk bought to defend a case the design already discourages. So the lock came out, and its job moved into the one place that *can* see intent: the prompt.

> **Read in parallel, write one at a time.** Read-only work — research, investigation, review — never conflicts; fan it out, several at once. WRITING conflicts: there is no lock, so two sub-agents writing at the same time race and corrupt each other. So run writers ONE AT A TIME — spawn a coder, `wait_for_agents` until it finishes, then spawn the next; order by dependency.

This is a real philosophical choice, and it's worth saying plainly: **correctness here rests on a prompted discipline, not an enforced invariant.** A model can ignore it and fire two overlapping writers. What makes that acceptable is the shape of the failure and the backstops around it — the work is sandboxed to a folder so the blast radius is bounded, every run is a persisted node you can inspect and roll back, and the [shared token budget](/posts/persistent-context-tree/) caps how much a runaway fan-out can spend. The pattern the prompt actually teaches is the one that's both safe and how a careful human would do it anyway: *investigate in parallel first, then implement sequentially.*

## Why a fiber makes this small

None of this needs a job queue or a worker pool, and that's the Effect dividend. A spawn is `Effect.forkDaemon` — a fiber that outlives the call but stays on the same supervised runtime. The completion latch is a `Deferred`, the one-shot cell `wait_for_agents` selects on. The shared spend pool is a `Ref` riding inside a `FiberRef`, so every agent in the tree drains the same budget without a parameter threaded through forty signatures (the [concurrency primitives](/posts/effect-semantics-layers-concurrency/) get their own post). And interruption is the quiet payoff: because every sub-agent is a fiber on one runtime, `interruptAll` — or a human's Esc — propagates through the whole tree, aborts the in-flight HTTP requests, runs every cleanup, and stops the billing. The fleet isn't a second system bolted beside the agent loop; it's the same loop, forked, talking to itself over a small bus.

## What it costs

**Non-blocking is harder to hold in your head.** A blocking `await` has one obvious failure mode: it's slow. An async fleet has subtler ones — a parent that forgets to `wait_for_agents` and finishes its turn while children are still running (the inbox catches their completions at the next boundary, but the *user* may see "done" before "done"), or two agents waiting on each other. The bus's timeout on `awaitChange` is the floor under the worst of it, but "what is everyone blocked on?" becomes a real question, which is why there's a `:tree` view to answer it.

**Turn-boundary delivery means messages aren't instant.** A note posted to a busy agent lands at its next turn edge, not the moment you send it. For coordination that's fine; for anything that *feels* like real-time it's a surprise you have to design around, not against.

**A lockless fleet is a bet on the prompt.** Everything above leans on the model honoring "write one at a time." It mostly does — but "mostly" is doing work in that sentence, and the honest version of this design is the one that pairs the prompt with the backstops (sandbox, persistence, budget) rather than pretending the discipline is an invariant. If your threat model can't tolerate a model occasionally racing two writers, you want the lock back — and the ancestor/descendant problem back with it.

## The shape that falls out

Stop returning the answer and start returning the ticket, and the rest reorganizes itself. Spawning becomes cheap, so fanning out becomes the default. Collection becomes an explicit, interruptible wait instead of a hidden one. Agents that can't block each other can still *talk* — an inbox for the direct word, a blackboard for the shared finding. And the thing you'd reach for a lock to enforce turns out to be better expressed as a habit the orchestrator already has: look before you touch, and touch one thing at a time. The blocking spawn was never simpler. It was just hiding the fleet you already had.
