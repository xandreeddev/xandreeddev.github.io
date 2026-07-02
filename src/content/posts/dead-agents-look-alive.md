---
title: 'Dead agents look alive by default'
description: 'Run forensics on a fleet: 25 budget-stops recorded as success, killed agents rendering as running, a watchdog shooting healthy parents — and the two-part fix: one unavoidable terminal path, and liveness as data instead of a clock.'
pubDate: 2026-09-22
tags: [agents, effect]
draft: true
series:
  name: 'Building a coding agent'
  order: 13
---

Three findings from a forensic pass over every run [efferent](https://github.com/xandreeddev/efferent), the coding agent I'm building on Effect, had ever recorded — in ascending order of embarrassment:

1. **Twenty-five runs that stopped early — budget drained, step cap hit — were recorded as plain `ok`.** The caveat existed, but only as prose inside the summary; the status column, the tree glyph, the gather result, and the exit code all said success.
2. **Agents that died abnormally never emitted their terminal event.** An interrupt, a crash, a watchdog kill — none of them fired `subagent_end`, so dead agents looked alive in every UI surface. A spinner, spinning forever, over a fiber that no longer existed.
3. **The stall watchdog — the mechanism built to catch dead agents — was killing live ones.** It measured a blind progress clock, so it shot a parent parked in a perfectly legitimate 300-second `wait_for_agents`, an agent midway through a four-minute bash run, and (the incident the [self-improvement post](/posts/self-improving-loop/) told from the gate's side) finished coordinators mid-verification, recording their completed, test-green work as stalled.

None of these is a crash. Every one is *bookkeeping* — code that was sure it knew what a run was doing, or how it ended, and was wrong. With a single agent you never notice this class of bug, because you're watching: the status is whatever your eyes say. But an [async fleet](/posts/async-fleet-orchestration/) is background fibers spawning background fibers, and "what is this agent doing right now, and how did it end?" stops being an observation and becomes a query against a concurrent system — answered by whatever your runtime bothered to write down.

That's the thesis this rework earned the hard way: **an agent's status is a claim about a concurrent system, and optimistic bookkeeping lies by default.** The fix has exactly two parts. Terminal truth — how a run ended — has to funnel through one path that no exit shape can skip. And liveness — what a run is doing *now* — has to be data the run itself stamps, never an inference from a clock.

## How `ok` happens

The pre-rework code wasn't careless; it was optimistic, which reads the same in a diff and lies the same in production.

Take finding one. The [errors post](/posts/errors-for-the-model/) walked, approvingly, the code that appends `[stopped early: the shared sub-agent token budget ran out — this result is partial]` to a stopped sub-agent's summary, so the parent model wouldn't build on unfinished work. That note was — is — the right craft. But it went into the *prose* while the status enum next to it stayed a binary, and a budget stop isn't an `error`, so it got filed as `ok`. Every consumer that filtered or rendered on the enum — the tree's ✓, the gather's status field, the headless exit code — repeated the lie, 25 times, while the truth sat inside a string only the parent model ever read.

Finding two is the same optimism, structural. The terminal sequence — record the return, wake the parent, emit the event — existed as three divergent copies (the ok path, the error path, and an exit finalizer) that disagreed about what to preserve and whether to emit at all. The finalizer hardcoded an empty error, so a watchdog kill *discarded finished work* — the single biggest failure bucket in the forensics — and skipped the terminal event entirely. And the fleet itself was forked with `Effect.forkDaemon(...).pipe(Effect.catchAll(() => Effect.void))` — exits literally discarded, fibers outliving teardown, which is how a process exit stranded database rows at `status = 'running'` forever.

Each bug is local, but the shape is one shape: **every optional step in a terminal sequence is a place the truth leaks out.** If the event *can* be skipped, some exit path skips it. If the status *can* be coarser than reality, some reality gets rounded to `ok`.

## One terminal path

The fix for terminal truth is a function with an unglamorous name and a strict contract. Every run — root turn or spawned node, success, failure, interrupt, stall, crash — now computes a `RunOutcome` and funnels through `finalizeRun`, which is idempotent, infallible, and ordered:

```ts title="packages/sdk-core/src/usecases/finalizeRun.ts"
export const finalizeRun = (args: { /* nodeId, store, bus, hooks, once, outcome */ }) =>
  Effect.gen(function* () {
    const already = yield* Ref.getAndSet(args.once, true)
    if (already) return // first caller wins; later callers no-op // [!code highlight]

    // 1. the durable record — terminal-once at the store
    yield* store.recordReturn(nodeId, { status, summary, stopReason, filesChanged })
      .pipe(Effect.catchAllCause(() => Effect.void))
    // 2. wake the parent — fulfil the latch, deliver the completion note
    yield* bus.complete(nodeId, { status, summary, filesChanged })
      .pipe(Effect.catchAllCause(() => Effect.void))
    // 3. the terminal EVENT — the one every UI surface keys on
    yield* hooks.onSubAgentEnd({ nodeId, outcome: status, reason: reason.kind, summary })
      .pipe(Effect.catchAllCause(() => Effect.void))
  })
```

Three properties carry the weight. **Idempotent:** the `once` Ref is check-and-set, so the normal completion path and the exit finalizer can both call it and exactly one wins. **Infallible:** every step is failure-guarded, because a terminal path that can throw is a terminal path that can be skipped. **Ordered:** the durable record lands *before* the parent wakes, so a parent that gathers the instant its child finishes reads the [persisted tree](/posts/persistent-context-tree/) and finds the truth already there.

And the store enforces terminal-once independently, because two writers racing to close the same run is not hypothetical (a crash-recovery sweeper exists, and it races the live run by design):

```ts title="packages/sdk-adapters/src/contextTreeStore/sqlite.ts"
// Terminal-once: only a `running` node is closed — a second record (a sweeper
// racing the live run, a double finalize) is a no-op, so the FIRST outcome
// written is the one that sticks.
sql`
  UPDATE context_nodes SET
    status = ${result.status},
    stop_reason = ${encodeStopReason(result.stopReason)},
    return_summary = ${result.summary},
    ended_at = ${Date.now()}
  WHERE id = ${id} AND status = 'running'
`
```

The vocabulary the path carries finally has room for reality. Status is `running | ok | partial | error | killed`, backed by a typed reason, both persisted with the node (a `stop_reason` column — sqlite migration 0010, postgres 0014):

```ts title="packages/sdk-core/src/entities/Outcome.ts"
export type StopReason =
  | { kind: 'completed' }
  | { kind: 'budget' }
  | { kind: 'step-cap' }
  | { kind: 'degenerate-loop' }
  | { kind: 'stall'; idleMs?: number }
  | { kind: 'interrupt'; by: 'human' | 'parent' | 'shutdown' | 'deadline' }
  | { kind: 'provider'; class: ProviderDefectClass; message?: string }
  | { kind: 'error'; error: string; message?: string }

/** The one status-mapping rule (the honesty table). */
export const outcomeStatus = (reason: StopReason, hasText: boolean): OutcomeStatus => {
  switch (reason.kind) {
    case 'completed':       return 'ok'
    case 'budget':
    case 'step-cap':
    case 'degenerate-loop': return 'partial' // a deliverable EXISTS — say it stopped early // [!code highlight]
    case 'stall':           return hasText ? 'partial' : 'killed'
    case 'interrupt':       return 'killed'
    case 'provider':
    case 'error':           return 'error'
  }
}
```

`partial` is the value the old binary had no slot for — *usable but incomplete* — and it's what those 25 budget and step-cap stops record now. `killed` is the other missing word: the run didn't fail, something ended it, and the reason says *who* — every interrupt API stamps `human`, `parent`, `shutdown`, or `deadline`, so the persisted record distinguishes "the user hit Esc" from "the process was torn down" without guessing.

Getting `killed(shutdown)` to actually persist forced the supervision fix: `bus.forkSupervised` replaces the exit-discarding `forkDaemon`, and `bus.shutdown()` — wired into every driver's teardown — interrupts *and awaits* the fleet, so each run's finalizer records its honest terminal return before the process exits. The acceptance check for the whole phase was pleasingly blunt: SIGINT a live fleet in `--mode json`, watch the process exit two seconds later with the node recording `killed` + `{"kind":"interrupt","by":"shutdown"}`, and count zero new rows stranded `running`.

The root turn got the same honesty. The loop always *knew* when it exhausted its step cap mid-thought — it set `stoppedAtMaxSteps` and every caller dropped it on the floor, shipping the mid-thought last sentence as the answer. A capped or breaker-stopped root now reports `partial` on `agent_end`, headless modes exit 1 when the run itself failed and print stderr caveats for partials, and the verification gate no longer files a fleet whose agents mostly died as "advisory success" — by the old rule, one forensic run with 13 of 13 agents dead would have gated clean.

## Liveness is data, not a clock

Terminal truth solves "how did it end". The uglier half is "what is it doing *right now*" — the question the old watchdog answered with a progress clock: no observable progress in N seconds, therefore dead. Finding three is what that inference is worth. A parent parked in a legitimate five-minute gather *makes no progress* by design. An agent inside a long bash run makes none either. The clock can't tell parked from hung, because "hung" isn't a fact about elapsed time — it's a fact about *state*, and nobody was recording the state.

So now every running agent carries one, on the [bus](/posts/async-fleet-orchestration/):

```ts title="packages/sdk-core/src/usecases/agentBus.ts"
export type RunState =
  | 'starting' | 'generating' | 'tool-running'
  | 'retrying' | 'awaiting-approval' | 'waiting-on-agents'

export interface RunHealth {
  readonly state: RunState
  readonly lastActivityAt: number // epoch ms of the last observable signal
  readonly detail?: string        // 'Bash' · '429 2/3 — next in 8s' · '3 agents'
}
```

The stamps come from places the loop already passes through: turn start flips `generating` (deliberately *before* the model call, so a hung call leaves `generating` as the last word), tool boundaries flip `tool-running` with the tool's name, the retry sink flips `retrying` with the backoff as detail, and `wait_for_agents` flips `waiting-on-agents` for the park. Changes ride the event stream as edge-triggered `agent_health` events — a state transition always emits, same-state activity re-emits only when the last emission is a 15-second bucket old. Never a heartbeat: the ledger sees transitions, not a per-token pulse.

The watchdog now reads health instead of the clock, and its kill condition shrank to the one state that has no other bound:

```ts title="packages/sdk-core/src/usecases/buildScopeRuntime.ts"
const h = yield* bus.healthOf(nodeId)
const killable = h === undefined || h.state === 'starting' || h.state === 'generating'
if (killable && now - h.lastActivityAt >= deadlineMs) {
  yield* Ref.set(stalledRef, true) // the finalizer records stall — and keeps produced work
  return yield* Effect.fail({ error: 'SubAgentStalled', message: `no progress for ${…}s` })
}
```

A zero-activity `generating` is a hung model call — the original silent-stall class, the one that used to leave a sub-agent sitting `running` with zero turns for twenty minutes while its parent gathered blind. Everything else is exempt *because it's bounded elsewhere*: tools by their own timeouts, retries by the retry cap, waits by the gather timeout, approvals by the human who owns the decision. The watchdog stopped being a deadline on work and became a deadline on *silence*.

One deletion made the gathers honest too. The bus used to keep finished runs in a bounded done-map; when a big fleet aged a finished child out of it, the gather synthesized the unknown id as `running` — a phantom the parent could wait on forever, spinning `wait_for_agents` to its step cap. The map is gone. The bus carries only live runs; terminal truth comes from the store, which never ages anything out — and the gather re-reads the tree *after* the park, because `recordReturn` precedes the parent's wake on the terminal path, so a just-finished child reports its real status instead of the pre-park snapshot's `running`. Each row a parent gets back now carries the child's health, so an orchestrator deciding whether to keep waiting sees `state: 'retrying: HTTP 429 2/3', idleSeconds: 4` — an agent weathering an overload — instead of a bare `running` it can only interpret with a timeout and a guess.

## The last mile: every surface, or it didn't happen

All of this is worthless if a surface still renders the old fiction, so the delivery half went after every place a status becomes pixels or bytes.

The TUI's fleet tree gives every running row a live suffix fed by the health events, escalating to an alert when the signal goes quiet:

```
▾ ⠹ port retry sink (sdk-core)     tool-running: Bash · 3f
  ⠸ audit adapters (adapters)      retrying: HTTP 429 2/3 — next in 8s
  ⠼ write migration (cli)          ⚠ idle 2m
  ◐ summarize findings             — stopped early: step cap
```

Ninety seconds of silence turns a row red before you've opened a single preview — a dying fleet is now *visually* dying. Terminal rendering keeps the same honesty: `◐ partial` with its reason (a budget stop never reads as a plain ✓ again), `✗ killed` with its provenance, and the terminal event clears the node's health entry so a finished agent can't show a stale suffix.

Attach got the same treatment, because an event-fed picture of a fleet is one dropped message away from wrong. The daemon's session snapshot now includes the live fleet — `bus.runningSubtreeOf(rootId)` plus each member's health — and the remote client reconciles its membership wholesale at boot and on every resync. A dropped terminal event or a daemon restart used to wedge the loader at "waiting for N agents"; now the next attach replaces belief with truth.

And the [headless modes](/posts/headless-agent-modes/) delivered the last lesson, found by the final live acceptance run: `agent_health` rides the bus's event sink, and only the TUI and daemon drivers had wired that sink — `--mode json` silently dropped the entire health stream. The fix is four lines (offer bus events onto the same queue as hook events), but the lesson is structural: the moment you add a second event channel, *every driver is a place the truth can leak*. A protocol only counts if every renderer speaks all of it.

## What it costs

**`partial` moves judgment to the consumer.** A binary needs no policy; four values do. Every consumer — the gate, the exit code, a script parsing `--mode json` — now decides what partial *means* for it, and the events keep the legacy `ok` boolean (schema-optional fields, so stale daemon/client pairs still decode), which means an old client quietly rounds the new vocabulary back down to the old binary. Honesty at the source doesn't force honesty at the sink.

**The honesty table contains a judgment call.** `stall` with produced text maps to `partial` — the bet is that a run which wrote something before hanging left a deliverable, not mid-thought noise. The caveat rides the summary either way, but the enum is choosing optimism at exactly the boundary this whole rework exists to police. I don't have forensics on that edge yet.

**Health is in-memory.** The health map lives on the bus, so a hard crash loses it; the reconcile-on-attach and a crash-recovery sweeper (30-second interval, two-minute grace — up to that much wrongness before a vanished fiber's node flips) are backstops, not proofs. And the sweeper walks *open* conversations: rows stranded before the rework still read `running` in old history until something revisits them.

**The watchdog's exemptions are promises, not proofs.** "`tool-running` is bounded by the tool's own timeout" is an assumption per state. Add a new `RunState` without its own bound and the silent-stall hole quietly reopens for exactly that state — nothing in the types enforces the covenant. It's written down in the doc comments, which is to say: it's written down.

## Status is a claim

The generalizable part isn't the schema, it's the stance. A fleet's status display is a set of claims about a concurrent system, and each claim is only as good as the mechanism that maintains it. "It ended `ok`" is trustworthy only if every exit shape passes through one door that stamps how it *actually* ended. "It's still working" is trustworthy only if the run itself is stamping what it's doing — because the alternative, inferring liveness from elapsed time, killed healthy parents and trusted dead children here, and will do the same in any system that tries it. Optimism is the default because the happy path writes itself first and the abnormal exits arrive later, one incident at a time, each skipping a step the happy path never knew was optional. The forensics were the price of learning that. One unavoidable terminal path and liveness-as-data were the refund.
