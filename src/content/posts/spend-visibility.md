---
title: 'Make the meter visible: token spend is a UI concern'
description: 'Token spend measured per call, attributed per role and agent, persisted with the work, shown where decisions happen.'
pubDate: 2026-07-15
tags: [agents, ux, ai]
draft: true
---

There's a reason the taxi meter faces the passenger. Not because riders can do much about the fare mid-ride — they mostly can't — but because a visible meter changes the relationship. You learn what a crosstown trip costs. You stop suspecting the driver. Over time you make better calls about when to take a cab at all. A meter you can't see produces exactly two passenger states: anxiety or denial.

Coding agents have this problem, and they have it worse than taxis ever did. An agent spends money invisibly, in someone else's units, through features that are deliberately *multiplicative*: one prompt can fan out into parallel sub-agents, retry a malformed turn, and fire half a dozen helper calls — compression digests, approval judgments, session titles — that nobody typed. The link between "I sent a message" and "I was billed" is severed by design, because severing it is what makes agents powerful. Most agent UIs respond by hiding the meter entirely, and their users split into the two passenger states: the anxious ones with a billing dashboard open in a second tab, and the deniers who don't look until the invoice does it for them. Both are UX failures. Both are the product's fault, not the user's.

The position of this post is that **spend is a first-class UI concern**, and that treating it as one decomposes into four commitments:

- **measured** once per LLM call, at the response boundary
- **persisted** with the work itself, not in a side table
- **attributed** twice — per model *role* and per *agent*
- **shown** where decisions are made, not on a billing page

Every receipt below is from [efferent](https://github.com/xandreeddev/efferent), a coding agent I'm building in the open — sub-agents, helper tiers, multi-provider, all the multipliers — which makes it a decent stress test for the claim. But the claim is general: an agent that hides its spend feels expensive and untrustworthy; one that shows it teaches its user to drive it well.

One unit definition before the code, because everything is denominated in it. A **token** is the provider's metering unit — roughly four characters of English text. You pay for every token you send (**input**: the conversation so far, the system prompt, the tool results) and every token the model generates (**output**), at different rates, with a discount when input was served from the provider's **prompt cache** — a byte-identical prefix the provider has already processed and can replay cheaply. Hold onto those three numbers — input, output, cache reads — they're the whole vocabulary.

## Measure once, at the response boundary

Here's the under-appreciated fact this entire post leans on: **every LLM response already contains the receipt.** Each call returns a usage block alongside the text —

```ts
const res = await llm.generate({ messages })
res.text   // 'I fixed the test by…'
res.usage  // { inputTokens: 18432, outputTokens: 211, cachedInputTokens: 15890 }
```

— and in most codebases that object's lifetime is one log line, if that. Spend visibility doesn't begin with building a metering system. It begins with refusing to drop a number you were already handed.

The actual work is uglier than "read the field", because providers don't agree on what the fields *mean*. Some put usage on the response object; some streaming adapters emit it in a trailing `finish` part — sometimes two of them, only one carrying data. Google reports under `usageMetadata` with its own key names. And Anthropic has a semantic difference that will silently wreck your accounting: its `input_tokens` *excludes* cache reads and cache writes, while Gemini and OpenAI *include* cached tokens in their prompt counts. [efferent](https://github.com/xandreeddev/efferent) quarantines all of this in one normalizer:

```ts title="packages/core/src/usecases/promptMapping.ts"
/** Token usage from a response's `usage` + the stream's finish-part metadata. */
export const extractUsage = (usage: unknown, content: ReadonlyArray<unknown>): TokenUsage => {
  const u = (usage ?? {}) as ProviderUsage
  // Streaming adapters can emit several `finish` parts; take the one with data.
  const finish = pickFinishPart(content)
  const inputTokens = u.inputTokens ?? finish?.usage?.inputTokens ?? googleMeta(finish)?.promptTokenCount ?? 0
  // …same fallback ladder for outputTokens / totalTokens / cacheReadTokens
  // Anthropic reports `input_tokens` EXCLUDING cache reads and writes — both
  // ride only in the raw usage on the finish part's provider metadata.
  // Without this fold the context gauge reads ~0 on a fully-cached turn.
  const au = anthropicMeta(finish)?.usage
  if (au != null) {
    const fullInput = inputTokens + (au['cache_read_input_tokens'] ?? 0) + (au['cache_creation_input_tokens'] ?? 0) // [!code highlight]
    return { inputTokens: fullInput, outputTokens, totalTokens: fullInput + outputTokens, cacheReadTokens: au['cache_read_input_tokens'] ?? 0 }
  }
  return { inputTokens, outputTokens, totalTokens, cacheReadTokens }
}
```

The highlighted line is the one that earns its comment: skip the fold and a fully-cached Anthropic turn — the *best-behaved* turn, the one where caching is doing exactly its job — shows up as nearly free context, and your gauge celebrates precisely when it should be warning. Normalization isn't bookkeeping pedantry; it's the difference between a meter and a random-number display.

Just as important as *how* is *where*: once, at the single point where responses are decoded. The agent loop calls `extractUsage` immediately after each model reply resolves, in the same breath that turns the response into messages. There is no second metering site to drift from the first.

## Persist the spend with the work

Now the design decision I'd defend hardest: the usage doesn't go to a stats table, a metrics service, or an in-memory counter. It goes **onto the assistant message itself** — embedded in the message's provider-metadata blob, under the agent's own key, and persisted to the conversation store with everything else:

```ts title="packages/core/src/usecases/promptMapping.ts"
const EFFERENT_USAGE_KEY = 'efferent'

/** Embed the API-reported turn usage into the turn's assistant message, so it
 *  persists with the conversation and can be recovered on resume. */
export const attachUsageToAssistant = (messages: Array<AgentMessage>, usage: TokenUsage): void => {
  const first = messages[0]
  if (first !== undefined && first.role === 'assistant') {
    first.providerOptions = { ...first.providerOptions, [EFFERENT_USAGE_KEY]: usage } // [!code highlight]
  }
}
```

And the call site in the loop, right where the turn's messages are appended:

```ts title="packages/core/src/usecases/agentLoop.ts"
const tail = responseToAgentMessages(content)   // assistant + tool messages
const usage = extractUsage(res.usage, content)
attachUsageToAssistant(tail, usage)             // the receipt rides with the turn // [!code highlight]
messages = [...messages, ...tail]
```

Why this and not a proper ledger table? Because a conversation store is already the system's source of truth for *what happened*, and spend is part of what happened. A parallel table needs its own writes, its own migrations, its own "which conversation was this again" joins — and it desynchronizes the first time anything appends a message without remembering to also log spend. Attached to the message, the receipt is **provenance**: it survives export, it survives a database move, and it can never describe a turn other than the one it's stapled to.

The payoff arrives the moment you close the terminal. Resume a session tomorrow and a stats-table design starts blind — or worse, starts at zero, cheerfully claiming your 200-message history costs nothing to continue. [efferent](https://github.com/xandreeddev/efferent) instead replays the receipts:

```ts title="packages/core/src/usecases/promptMapping.ts"
/** Scan a persisted conversation for embedded turn usage. */
export const recoverConversationStats = (messages: ReadonlyArray<AgentMessage>) => {
  let cumulativeOutput = 0, cumulativeTotal = 0, turns = 0
  let lastUsage: TokenUsage | undefined
  for (const msg of messages) {
    const usage = assistantUsage(msg)   // reads the embedded blob back
    if (usage !== undefined) {
      cumulativeOutput += usage.outputTokens
      cumulativeTotal += usage.totalTokens
      turns++
      lastUsage = usage // the most recent turn's input/cache → the gauge // [!code highlight]
    }
  }
  return { lastUsage, cumulativeOutput, cumulativeTotal, turns }
}
```

One pass over history and the meter is exactly where it was: the last turn's input tokens become the context gauge, the cumulative totals become the session odometer. No second storage system, nothing to reconcile — the conversation *is* the ledger.

And when there's nothing to replay — histories recorded before usage annotation existed — the honest move is an estimate that *admits* it's one:

```ts title="packages/cli/src/tui-solid/actions/session.ts"
// History without persisted usage: a 0/1M gauge would claim a resumed
// session costs nothing on its next turn. Estimate at ~4 chars/token and
// mark it — the gauge shows `~` until the first real provider count.
const estimate =
  lastUsage === undefined && history.length > 0
    ? Math.round(JSON.stringify(history).length / 4) // [!code highlight]
    : undefined
```

The `~` prefix renders in the UI until the next provider reply replaces the guess with a count. A precise-looking wrong number is worse than an approximate honest one — that rule comes back later, because it's half the tradeoff section.

## Attribute by role: helper calls are real spend

Modern agents don't run one model; they run a *cast*. In [efferent](https://github.com/xandreeddev/efferent), all agentic work runs on **main**, latency-sensitive helper calls run on **fast**, and background utility work runs on **cheap** — which concrete model fills each role is runtime selection and a post of its own. This post owns the other half of that design: their accounting. Because the moment a feature can quietly call a model, you have spend with no user action attached, and the lazy path — letting it hide inside the feature that made it — is how an agent's bill stops being explainable.

The ledger is almost embarrassingly small. That's the point — attribution is a data shape, not a subsystem:

```ts title="packages/cli/src/tui-solid/presentation/sidePane.ts"
/** Billed tokens (input + output) accumulated per model role this session. */
export interface RoleSpend {
  readonly main: number   // all agentic work — the root loop AND sub-agents
  readonly fast: number   // latency-sensitive helpers: digests, approval judgments
  readonly cheap: number  // background utility: session titles
}

export const accumulateRoleSpend = (s: SessionStats, role: keyof RoleSpend, billed: number): SessionStats => ({
  ...s,
  byRole: { ...s.byRole, [role]: s.byRole[role] + billed }, // [!code highlight]
})
```

What keeps the ledger honest is that helper spend is **an event like any other**. When the loop compresses an oversized tool result and a fast-tier model writes a digest of the clipped middle, that call's usage doesn't get swallowed by the compression feature — it's emitted into the same event stream that carries tool calls and assistant turns:

```ts title="packages/cli/src/events.ts"
| {
    /** A helper-tier call ran inside the loop (e.g. a headroom middle-summary). */
    readonly type: 'helper_usage' // [!code highlight]
    readonly role: 'fast' | 'cheap'
    readonly usage: TokenUsage
  }
```

The other helpers report through the same bookkeeping at their own call sites. The fast-tier judge that pre-screens bash approvals — its verdict logic is a post of its own — settles up the moment it rules:

```ts title="packages/cli/src/tui-solid/approval.ts"
const outcome = yield* judgeApproval(req, permitted)
if (outcome.usage !== undefined) {
  const billed = outcome.usage.inputTokens + outcome.usage.outputTokens
  store.setStats((s) => accumulateRoleSpend(s, 'fast', billed)) // [!code highlight]
}
```

And the cheap tier that names a session after its first exchange does the same, with a comment that doubles as the section's thesis: *the cheap tier's spend is real spend — count it.*

The result renders as one line in the activity pane: `Σ main 64k · fast 1k · cheap 160`. Read the small numbers, because they're the argument. That `cheap 160` is a session title you'd never have noticed paying for — and now you don't have to *trust* that titles are nearly free, you can *see* it. The line only appears once a non-main role has actually spent; a ledger of zeros teaches nothing, so it earns its pixels first.

## Attribute by agent: spend as provenance

The second axis of attribution is *which agent*. [efferent](https://github.com/xandreeddev/efferent)'s `run_agent` tool spawns folder-scoped **sub-agents** — child loops sandboxed to a directory, fanning out in parallel — and every spawn persists as a node in a branching context tree you can browse, resume, and fork. The tree's mechanics are a post of their own; what matters here is one field on the node schema:

```ts title="packages/core/src/entities/AgentContext.ts"
/** Cumulative token usage for a node's run. */
export const ContextUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
})

export const AgentContextNode = Schema.Struct({
  id: ContextNodeId,
  parentId: Schema.NullOr(ContextNodeId),
  folder: Schema.String,            // writes/bash confined here
  status: ContextNodeStatus,        // running | ok | error
  returnSummary: Schema.optional(Schema.String),
  filesChanged: Schema.Array(Schema.String),
  usage: Schema.optional(ContextUsage), // [!code highlight]
  // …
})
```

Usage is part of the node's permanent record, next to what it did (`returnSummary`) and what it touched (`filesChanged`). It accumulates live, in the hooks wrapped around each child loop — note which fields add up and which get replaced:

```ts title="packages/core/src/usecases/buildScopeRuntime.ts"
onAssistantMessage: (event) => {
  const u = event.usage
  const track = u !== undefined
    ? Ref.update(usageRef, (acc) => ({
        inputTokens: u.inputTokens,                       // latest context size — a gauge
        outputTokens: acc.outputTokens + u.outputTokens,  // total generated — an odometer
        cacheReadTokens: u.cacheReadTokens,
      })).pipe(Effect.zipRight(drainPool(pool, u))) // every call also drains the shared budget // [!code highlight]
    : Effect.void
  // …then forward the event to the parent's stream, stamped with this node's id
}
```

That gauge/odometer split inside one struct is worth naming, because it's the same split every spend surface in this post repeats: *input tokens* describe a current state (how big is this agent's context right now), while *output tokens* describe consumption over time. Sum them and you get what the provider actually bills.

The payoff is the `:tree` view. Every finished node renders its title, status, files changed — and its bill, `38k tok`, input plus output, right on the row. When a turn felt expensive, you no longer wonder; you open the tree and see *which subtree ate it*. The agent that burned 200k tokens grinding on a flaky test is right there, glowing, next to its three siblings that finished for 12k each. Spend stops being a session-level mystery and becomes provenance: this cost, attached to this work, forever.

One attribution subtlety deserves its sentence, because getting it wrong corrupts both displays. Sub-agent spend lands on **main** in the role ledger — delegation changes the *context*, not the *brain*; the child runs the same main-role model — but it stays **off the conversation gauge**, because the child's tokens never entered the parent's context window. The ledger answers "what did this session cost?"; the gauge answers "how full is *this* context?" — different questions, and an agent UI that conflates them will lie on one of the two.

## Show it where decisions happen

All of that is plumbing. The product decision is *placement*, and the rule is: spend belongs in the pixels adjacent to the next decision, not in a dashboard you check next week. A billing page is an autopsy. A status bar is a co-pilot.

Here's [efferent](https://github.com/xandreeddev/efferent)'s layout — activity header top-right, status bar along the bottom:

```
 ┌─ Fix the failing foo test ──────────────┐  ┌─ activity ───────────┐
 │ ❯ fix the failing test in src/foo.ts    │  │ ctx ░░ 2% 18k/1M     │
 │                                         │  │ 1.2k out · 3 turns   │
 │ ● I'll read the test first.             │  │ Σ main 17k · fast 1k │
 │ …                                       │  │ …                    │
 └─────────────────────────────────────────┘  └──────────────────────┘
  gemini-3.5-flash · fast gemini-3.1-flash-lite ░░ 2% 18k/1M · 86% cached · sqlite · ~/proj
```

Three numbers, and each one exists to change a specific behavior.

### The context gauge: when to fold

`ctx ░░ 2% 18k/1M` is the last turn's input tokens over the model's context window. It answers "how much room is left?" — and it escalates, on one scale shared by every surface that draws it:

```ts title="packages/cli/src/tui-solid/presentation/statusBar.ts"
/** How loudly the context gauge should speak. One scale for every surface:
 *  under 70% it's bookkeeping; from 70% a fold is worth planning; from 90%
 *  the next turns may degrade — `:handoff` now. */
export type GaugeSeverity = 'ok' | 'warn' | 'critical'

export const gaugeSeverity = (used: number, total: number): GaugeSeverity => {
  const pct = contextPercent(used, total)
  if (pct === undefined) return 'ok'
  return pct >= 90 ? 'critical' : pct >= 70 ? 'warn' : 'ok' // [!code highlight]
}
```

At `warn` the bar changes color; at `critical` it grows words — `:handoff to fold` — naming the action that fixes it: fold the loaded history into a summary checkpoint and continue light. (The fold machinery, including the auto-trigger near the window's edge, is a post of its own.) The behavioral shift this produces is real: users stop being *surprised* by degraded late-session turns and start folding *before* quality drops, because the gauge made "context is a budget" something you watch rather than something you learn about from a bad answer.

### The role ledger: when to delegate

`Σ main 17k · fast 1k` is the session's economics by who billed it. Watch it across a week of sessions and it quietly answers staffing questions: is the fast tier earning its keep, or is the judge burning more than the modals it saves? Did that fan-out of four sub-agents cost less than doing the work in the main context would have — including the handoff the main context would have needed halfway through? Combined with per-node numbers in `:tree`, "should I spawn an agent or just do it here?" stops being vibes and becomes a comparison between numbers you've actually seen before.

### The cache percentage: whether the prefix is paying rent

`86% cached` is the share of the last turn's input served from the provider's prompt cache:

```ts title="packages/cli/src/tui-solid/presentation/statusBar.ts"
/** The share of the last turn's context served from the provider's cache —
 *  the caching story in one number. Undefined until a turn reports real usage. */
export const cachePercent = (cacheRead: number, input: number): number | undefined =>
  input > 0 ? Math.round((Math.min(cacheRead, input) / input) * 100) : undefined // [!code highlight]
```

Cache reads are billed at a fraction of full input price, so on long sessions this single number *is* the difference between a reasonable bill and a painful one. How the cache stays warm — byte-stable prefixes, never rewriting history — is a post of its own; the visibility point is simpler: a number you can see is a number you notice *regressing*. When `86% cached` drops to `0%` after a change to prompt assembly, you've caught a cost regression at the status bar, the same turn it happened — not at the end of the month, aggregated into noise.

## Budgets close the loop

Visibility tells you; budgets stop you. The two are complements, not substitutes — a meter can't prevent a runaway fan-out at 2 a.m., and a hard cap with no meter just fails mysteriously. In [efferent](https://github.com/xandreeddev/efferent), all sub-agents spawned within one top-level turn drain a shared token pool (1M by default), and the same `drainPool` you saw in the node-tracking hook is what depletes it — measurement and enforcement consume *one* number, extracted once:

```ts title="packages/core/src/usecases/tokenBudget.ts"
/** Tokens a single LLM call costs the pool: what the provider bills. */
export const usageCost = (u: ContextUsage): number => u.inputTokens + u.outputTokens

/** The model-facing failure for a spawn attempted on a drained pool. */
export const budgetExhaustedFailure = {
  error: 'BudgetExhausted',
  message: 'the sub-agent token budget for this turn is exhausted — do the remaining work yourself instead of spawning.', // [!code highlight]
} as const
```

Note who the error message addresses: the *model*. A drained pool doesn't kill the turn; it returns a value the model reads and reacts to, so it finishes the remaining work itself instead of spawning. Even enforcement is a kind of display — just pointed at the other intelligence in the loop. The pool's mechanics — how it rides the spawn tree, why it's shared rather than sliced — are a post of their own.

## What the meter doesn't tell you

Honest limits, because a post selling visibility shouldn't hide its own blind spots.

**Tokens, not dollars.** Everything above is denominated in tokens, and that's deliberate — there isn't a price table anywhere in the repo. Provider price tables drift monthly; input and output are priced differently; cache reads are discounted by provider-specific factors; and subscription OAuth (a post of its own) has no marginal dollar price at all — a "cost" display for a flat-rate plan would be fiction. A wrong dollar figure is worse than a right token count. But the cost is real: a newcomer can't convert tokens to money without leaving the app, and a single billed sum (`input + output`) flattens the very asymmetries — output costing several times input, cache reads costing a fraction — that the per-field data could expose. Tokens are the honest unit; they are not the *complete* unit.

**Normalization is a treadmill.** `extractUsage` is the most provider-soaked function in the codebase, and it will be wrong for some provider that doesn't exist yet — new adapters mean new field names, new finish-part quirks, new cache semantics. Quarantining the mess in one function makes the breakage cheap to fix, not impossible.

**The gauge is a last-known-good, not a live sensor.** It shows the input count from the most recent provider reply. Paste a novel into the composer, or let a tool dump 40k tokens of build log into the buffer, and the gauge is stale until the next response reports. The resume estimate is cruder still — characters over four — which is exactly why it wears the `~`. The meter never claims more precision than it has, but you have to read the claim.

**The persisted ledger is partial.** Receipts ride on root-loop assistant messages; helper and sub-agent spend lives in events and tree nodes. So a resumed session's role ledger collapses to `main` — the totals are right, the attribution is coarser than it was live. Fixable by persisting role tags with the usage blob; not yet done.

**And the Goodhart trap.** Make a number visible and people optimize it. The session that matters is not the one that spent the fewest tokens; it's the one that shipped the fix. A 40k-token session that lands the change is cheaper than three 15k-token sessions that don't — and a meter, watched too literally, teaches the wrong lesson. The real denominator is outcome per session, and no status bar renders that yet.

## The number was already there

Strip this post to its skeleton and notice what's missing: there's no metering subsystem. No instrumentation framework, no analytics pipeline, no schema for a spend service. There's a 50-line normalizer, a key in a metadata blob, a three-field interface, one fold over history, and a handful of format strings. Every number was already in the provider's response; the entire feature is *refusing to drop it*, and then carrying it to where someone is deciding something.

That's why "we'll add cost tracking later" is the wrong frame. Later is when the habits are formed — when your users have already learned either to fear the agent or to ignore what it costs, and when your own intuitions about whether sub-agents pay for themselves are already guesses. The meter isn't a reporting feature; it's the feedback loop that teaches a person to drive the tool — when to fold, when to delegate, whether the cache is earning — and feedback loops only teach if they run while the hands are on the wheel.

An agent asks for a lot of trust: it spends your money, in units you don't think in, on work you didn't itemize. The cheapest trust you will ever buy is showing the meter. If a tool hides it, it's fair to ask who the hiding serves — because it isn't the passenger.
