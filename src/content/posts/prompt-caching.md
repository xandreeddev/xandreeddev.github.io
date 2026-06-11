---
title: 'Prompt caching is a design property, not a billing detail'
description: 'An agent re-sends 95% of its prompt every turn. Whether you pay full price again is designed, not billed.'
pubDate: 2026-06-11
tags: [ai, agents]
draft: true
---

By turn thirty of a coding session, an agent is sending its provider a prompt north of a hundred thousand tokens — and roughly 95% of those bytes are identical to the bytes it sent last turn. **Prompt caching** is the provider-side feature that notices: instead of re-processing the unchanged part of your prompt at full input price, the provider serves it from a cache of its own internal state, and bills the cached portion at a fraction of the normal rate. On Anthropic, a cache read costs about a tenth of the full input price; OpenAI and Gemini discount cached tokens steeply too.

A tenth. On the bulk of every request an agent ever makes. That's not an optimization you sprinkle on at the end — it's the difference between an agent that's economically viable to run all day and one that isn't. And here's the part that took me longest to internalize while building [efferent](https://github.com/xandreeddev/agent): whether you actually *get* that discount is not something you configure. It's a property your whole architecture either has or doesn't. One function in the wrong place — a timestamp interpolated into the system prompt, a transcript "cleaned up" in place — and you silently pay full price forever, with no error message anywhere.

This post is the tour I wish I'd had: why agents specifically live or die by this, the one mental model that explains all three major providers, and then each provider in turn — slowest on Anthropic, because it's the only one where doing nothing means caching nothing.

## The agent shape of the problem

A chat application sends a prompt once and is done with it. An agent doesn't. The agent loop — the thing that makes it an agent — is *send the transcript, get tool calls back, run them, append the results, send the transcript again*:

```ts
let history = [systemPrompt, userMessage]

while (true) {
  const res = await model.generate(history) // sends EVERYTHING, every turn
  history = [...history, ...res.tail]       // grows by a small tail
  if (res.finishReason !== 'tool-calls') return res
}
```

Look at what the provider sees across one task. Turn one: system prompt, tool definitions, user message — say 10k tokens, all new. Turn two: all of that again, plus an assistant message and some tool results — 14k tokens, of which 10k are bytes the provider processed seconds ago. By turn twenty the request is 80k tokens and the genuinely new part is the last 2k. The *output* of each turn is small; the *input* is the entire accumulated past, re-shipped every single time.

[efferent](https://github.com/xandreeddev/agent)'s loop has exactly this shape: each turn maps the persisted message buffer to a prompt, calls the provider-agnostic `LanguageModel`, and appends the response parts as the new tail. Working sessions routinely sit between 50k and 200k tokens of context. Without caching, a forty-turn session bills the early turns' tokens forty times over. With caching, you pay full price for each token roughly once, the discounted rate thereafter — the cost curve goes from quadratic-ish in conversation length to something close to linear.

So the stakes are clear. The question is what the cache actually keys on, because every design decision in the rest of this post falls out of the answer.

## One mental model: the byte-stable prefix

All three providers cache the same way: on a **byte-stable prefix**. The cache key is derived from the exact rendered bytes of your request, in order, from the very first byte — tool definitions, then system prompt, then messages. A request hits the cache for the longest previously-seen prefix and pays full price only for what comes after it.

The brutal corollary: **one changed byte invalidates everything after it.** Not "the changed part" — everything downstream of the change. The cache doesn't diff; it matches prefixes.

```
turn 1:  [tools][system][user]                          ← all cold, cache written
turn 2:  [tools][system][user][asst][tools'][user]      ← prefix hit, tail cold
turn 3:  [tools][system][user][asst][tools'][user][…]   ← longer hit, smaller tail
         ────────────── warm ──────────────^── cold ──
```

That picture is the whole theory. Everything else is consequences:

- **Timestamps are poison.** `Current time: 14:32:07` at the top of a system prompt means byte ~20 differs on every request, so *nothing* ever hits. The most expensive line of code in agent-land is an innocent-looking `new Date()` in a prompt template.
- **The early prompt must be frozen.** Tool definitions render first; add, remove, or reorder one tool and the entire cache goes cold. Same for any conditional system-prompt section.
- **Dynamic context belongs at the end.** A message appended at turn twelve invalidates nothing before turn twelve. The tail is free real estate; the head is load-bearing.
- **History is sacred.** Rewriting a message from turn three — even to make it *smaller* — re-bills every token after turn three at full price.

The providers differ only in how you opt in and how you observe it. Which provider backs a given [efferent](https://github.com/xandreeddev/agent) turn is a runtime selection — the multi-provider router is a post of its own — but the router has one caching-relevant job that *is* this post's subject: shaping each outgoing request the way that provider's cache wants it. Three providers, three shapes.

## OpenAI: automatic, plus a routing hint

OpenAI is the low-ceremony end of the spectrum. Prompts past a modest size threshold are **prefix-cached automatically** — no parameter, no markers, no opt-in. Send the same prefix twice in close succession and the second request reports cached tokens in its usage block and bills them at a discount.

There's one knob worth turning anyway. OpenAI's cache is sharded across their fleet, and a request only hits cache entries on the machine it lands on. The `prompt_cache_key` parameter is a routing hint: requests carrying the same key get routed consistently, so they keep landing where their warm prefix lives. [efferent](https://github.com/xandreeddev/agent) pins it when the router builds the OpenAI client:

```ts title="packages/adapters/src/llm/providers.ts"
case 'openai':
  return OpenAiClient.make({ apiKey: key }).pipe(
    Effect.flatMap((client) =>
      OpenAiLanguageModel.make({
        model: sel.modelId,
        config: {
          prompt_cache_key: 'efferent', // [!code highlight]
          // …reasoning-effort config
        },
      }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, client)),
    ),
  )
```

A static key is the honest 90% version: every request from the agent routes together. The tighter move — threading the conversation id into the key so each session gets its own routing affinity — is on the roadmap and deliberately not built yet; for a single-user CLI the static key already keeps a session's requests landing together. The point of showing it at all: even the "automatic" provider rewards a client that thinks about where its prefixes live.

## Gemini: implicit, visible only in the receipts

Gemini calls its version **implicit context caching**, and it's the same deal as OpenAI ergonomically: stable prefixes are cached automatically, cached tokens are billed at a discount, and there is nothing to send. What's different is where you *see* it — Gemini reports a `cachedContentTokenCount` inside the response's usage metadata, and if you don't go looking for it you'll never know whether your prefix discipline is working.

[efferent](https://github.com/xandreeddev/agent) normalizes every provider's usage report into one shape, and the Gemini cache figure comes from exactly that field:

```ts title="packages/core/src/usecases/promptMapping.ts"
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens: number
}

export const extractUsage = (usage: RawUsage, content: ReadonlyArray<Part>): TokenUsage => {
  const um = googleUsageMetadata(content) // Gemini reports usage on the finish part
  const cacheReadTokens =
    usage.cachedInputTokens ?? um?.cachedContentTokenCount ?? 0 // [!code highlight]
  // …input/output/total resolved the same way — plus an Anthropic
  // correction that gets its own section below
  return { inputTokens, outputTokens, totalTokens, cacheReadTokens }
}
```

Gemini also offers an *explicit* caching API — you upload content as a named `cachedContent` resource and reference it by handle, paying storage instead of re-transmission. [efferent](https://github.com/xandreeddev/agent) doesn't use it, for an honest reason: the `@effect/ai-google` adapter always sends the full `contents` array and has no way to suppress the system prompt and tools in favor of a cache handle, so wiring it up would be theater. Implicit caching is real and live; the explicit tier waits until the library can express it. Knowing which optimizations you're *actually* getting beats pretending.

## Anthropic: nothing caches until you say so

Here's the one that bites people. **Anthropic caches nothing by default.** No markers in the request, no caching — every turn re-reads the entire conversation at full input price, forever, silently. The API is perfectly happy to let you do this. Most hand-rolled Anthropic clients I've read do exactly this, and their authors don't know, because the only symptom is a bill.

Opting in means attaching `cache_control: { type: 'ephemeral' }` to specific content blocks in the request. Each marked block is a **breakpoint**: a position where Anthropic will both *write* a cache entry for the prefix ending there and *look back* for an existing entry to read. "Ephemeral" names the default lifetime — an entry lives about five minutes, refreshed each time it's read, so an active session keeps itself warm. The economics make the opt-in design legible: cache reads cost ~0.1× the base input price, but cache *writes* cost a premium — about 25% over base for the five-minute tier. Caching is a bet that the same prefix comes back. Anthropic makes you place the bet explicitly.

You get at most **four breakpoints per request**, so placement is a real decision. The pattern for conversational agents — straight from Anthropic's own docs, implemented in [efferent](https://github.com/xandreeddev/agent) as a pure function the router applies to every Anthropic-bound request — uses three: the last system message, and the last two non-system messages.

### One anchor, two moving markers

```ts title="packages/adapters/src/llm/providers.ts"
export const withAnthropicCacheBreakpoints = (options: GenerateOptions): GenerateOptions => {
  const messages = Prompt.make(options.prompt).content
  if (messages.length === 0) return options

  // 1. the LAST system message — anchors the static prefix
  const stampIdx = new Set<number>()
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'system') { stampIdx.add(i); break }
  }

  // 2. the LAST TWO non-system messages — the moving frontier // [!code highlight]
  let tail = 0
  for (let i = messages.length - 1; i >= 0 && tail < 2; i--) {
    if (messages[i].role === 'system') continue
    stampIdx.add(i)
    tail++
  }
  // …stamping below
}
```

Why these three positions?

**The last system message** is the anchor. Anthropic renders requests in a fixed order — tools first, then system, then messages — and a breakpoint covers everything before it. So one marker on the final system block caches the entire static prefix: every tool definition plus the whole system prompt, the part of the request that is byte-identical for the lifetime of a session. One breakpoint, maximum coverage.

**The last two non-system messages** are the moving frontier, and this is the part that looks wrong until it clicks. The markers sit on *this turn's* newest messages — but this turn's newest messages have never been seen before, so what is there to read? The answer is that a breakpoint reads and writes at different points in time. This turn, the marker on the tail *writes* a cache entry for the whole prefix ending there. Next turn, the transcript has grown past it, and when Anthropic processes the new request it looks back from the new breakpoints for the longest previously-cached prefix — and finds the entry last turn's marker wrote. **The previous turn's breakpoint becomes this turn's cache hit; this turn's breakpoint becomes the next turn's.** The frontier advances one turn behind the conversation, and everything behind it stays warm.

Why *two* tail markers instead of one? Insurance for the lookback. A tool-heavy turn can append a long run of blocks — assistant message, a dozen tool results, a new user message — and Anthropic's backward search from a breakpoint scans a bounded window, not the whole transcript. Two markers keep a read point close to wherever the previous write landed even when the tail grows by more than one message. Three breakpoints spent, one left in the budget.

And the question that should be nagging you: the markers *move* every turn — doesn't moving them change the request bytes and break the very prefix-match the whole scheme depends on? It would, except Anthropic deliberately excludes `cache_control` placement from the content hash. Markers are metadata about the bytes, not part of them. The frontier slides forward each turn and never invalidates the prefixes behind it. The entire pattern is legal only because of that one carve-out.

### Stamp gently: explicit markers win

The second half of the function is about what it *doesn't* do:

```ts title="packages/adapters/src/llm/providers.ts"
const stamped = messages.map((msg, i) => {
  if (!stampIdx.has(i)) return msg
  const anthropic = msg.options['anthropic'] ?? {}
  if (anthropic.cacheControl !== undefined) return msg // an explicit marker wins // [!code highlight]
  return withOptions(msg, {
    anthropic: { ...anthropic, cacheControl: { type: 'ephemeral' } },
  })
})
return { ...options, prompt: Prompt.fromMessages(stamped) }
```

Two courtesies, both load-bearing. Provider options are *merged*, not replaced — a message already carrying other Anthropic metadata keeps it. And a message that already has an explicit `cacheControl` is left untouched, which matters because `ephemeral` isn't the only tier: you can pass `ttl: '1h'` for an hour-long entry at a higher write premium, and a caller who deliberately opted a long-lived prefix into that tier should not have the router silently downgrade it to five minutes. The colocated test pins all of this — the stamp positions, the untouched middle, the merge, and explicit-marker precedence:

```ts title="packages/adapters/src/llm/anthropicCache.test.ts"
it('stamps the last system message and the last two non-system messages', () => {
  const options = {
    prompt: Prompt.make([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: 'reading' },
      { role: 'user', content: 'now edit it' },
    ]),
  }
  const msgs = promptOf(withAnthropicCacheBreakpoints(options))
  expect(cacheControlOf(msgs[0])).toEqual({ type: 'ephemeral' }) // system anchor
  expect(cacheControlOf(msgs[1])).toBeUndefined() // old turn — never touched // [!code highlight]
  expect(cacheControlOf(msgs[2])).toEqual({ type: 'ephemeral' }) // tail -2
  expect(cacheControlOf(msgs[3])).toEqual({ type: 'ephemeral' }) // tail -1
})
```

One more placement decision, because the write premium cuts both ways: the router applies this function **only to the main agent loop**. [efferent](https://github.com/xandreeddev/agent)'s one-shot helper tiers — the utility model that writes session titles and compression digests, the grounding-only web-search calls — never stamp. Their prompts are sent once and never again; marking them would pay the +25% write premium on every request and read back exactly nothing. Caching a prompt that never recurs is strictly worse than not caching it. Opt-in means you can decline.

## The contract the rest of the system signs

Everything so far is request shaping. But the prefix-match invariant doesn't care about your request-shaping code — it cares about the bytes, and the bytes come from the whole system. Stamping breakpoints onto a transcript that some other subsystem rewrites is paying the write premium to cache garbage. The cache is a contract, and every component that touches history has to sign it. Three clauses.

**Clause one: history is append-only.** A persisted message is never edited. Not to fix a typo, not to redact, not to shrink. The tempting move when a transcript bloats is exactly the forbidden one:

```ts
// the obvious fix for a bloated transcript — and a cache poisoner:
history[3].content = summarize(history[3].content)
// one rewritten byte at position ~12,000 → everything after it re-bills cold

// the cache-safe shape: shrink content on the way IN, then never touch it
history.push(compress(res.tail))
```

**Clause two: compression happens at append time, or not at all.** [efferent](https://github.com/xandreeddev/agent)'s context-headroom machinery — a post of its own — exists precisely under this constraint. When a tool result comes back oversized (an 80k-character `cat`, a grep flood), it's compressed *the moment it enters the buffer*: the persisted record and every future prompt carry the compressed form from byte one, and nothing already sent to a provider is ever rewritten. The marker left behind names what was dropped and how the model can get it back, so compression is reversible on demand — but reversal produces a *new* tool call appended at the tail, never a mutation of the old bytes. Compress the future, never the past.

**Clause three: when history must actually shrink, shrink it as one deliberate prefix rebuild.** Eventually a session outgrows its context window and no amount of tail-compression saves you; the loaded history has to fold into a summary. That's a prefix change — there's no avoiding the cold miss. The discipline is to take the hit *once, on purpose, at a turn boundary*: [efferent](https://github.com/xandreeddev/agent)'s handoff writes a checkpoint (the original rows are kept, never modified — they feed the persistent context tree, a post of its own) and the next request goes out with a brand-new prefix — summary first, recent messages after. One cold request writes the new cache entries; every turn after that is warm again. The failure mode this clause forbids is *incremental* rewriting — trimming a little here, rewording a little there, each edit a fresh full-price re-read of everything downstream. Fold rarely, fold completely, and let the frontier rebuild.

None of these clauses live in the caching code. They live in the store, the loop, and the compression path — which is the point. You can't bolt this property on; the architecture has it or it doesn't.

## Watching it work: one number in the status bar

A property this silent needs instrumentation, because both failure modes — never caching, and quietly breaking the prefix — produce zero errors. [efferent](https://github.com/xandreeddev/agent)'s TUI keeps the answer permanently on screen: the status bar reads `model · gauge 12% 18k/1M · 86% cached · …`, where the cache figure is the share of the last turn's input served from the provider's cache. The computation is one line:

```ts title="packages/cli/src/tui-solid/presentation/statusBar.ts"
/**
 * The share of the last turn's context served from the provider's
 * cache (`42` = 42%) — the caching story in one number.
 */
export const cachePercent = (cacheRead: number, input: number): number | null =>
  input > 0 ? Math.round((Math.min(cacheRead, input) / input) * 100) : null // [!code highlight]
```

…but feeding it honestly requires un-warping one provider's accounting. Anthropic's `input_tokens` *excludes* cache reads and writes — on a fully cached turn it reports only the cold tail, and a naive gauge would claim a 150k-token conversation is using 2% of its context window. The raw cache figures ride in provider metadata, and `extractUsage` folds them back in:

```ts title="packages/core/src/usecases/promptMapping.ts"
// Anthropic's input_tokens EXCLUDES cache reads and writes. Without this
// fold, the context gauge reads ~0 on a fully cached turn.
const au = anthropicRawUsage(content)
if (au) {
  const cacheRead = au['cache_read_input_tokens'] ?? 0
  const cacheWrite = au['cache_creation_input_tokens'] ?? 0
  const fullInput = inputTokens + cacheRead + cacheWrite // [!code highlight]
  return {
    inputTokens: fullInput,
    outputTokens,
    totalTokens: fullInput + outputTokens,
    cacheReadTokens: cacheRead,
  }
}
```

What healthy looks like, live: turn one of a session reads 0% cached — nothing existed to read; that turn pays the writes. Turn two jumps high immediately — the first time I watched a Sonnet session, turn two read **93% cached** — and the number climbs asymptotically from there as the warm prefix grows relative to each turn's tail. Late in a long session, 95–98% is normal and correct.

What broken looks like is just as legible. A cache percentage that *craters* mid-session — 96%, 95%, 12% — means the prefix changed somewhere early: an edit to persisted history, a tool definition that shifted, a system prompt that picked up dynamic content. A number pinned at 0% on Anthropic means the breakpoints never went out at all. Either way you find out the turn it happens, from the status bar, instead of three weeks later from the invoice. If you build an agent and take one thing from this post, take the readout: you cannot keep a promise you can't see yourself breaking.

## What it costs

Honest ledger, because none of this is free.

**The ephemeral TTL is short.** Five minutes, refreshed on each read. An active session keeps itself warm indefinitely, but step away for coffee and the next turn pays cold-write prices on the whole transcript again. The 1-hour TTL exists for exactly this, at roughly double the write premium — which means it needs more subsequent reads to pay for itself, and for an interactive CLI session the five-minute tier usually wins. There's no free tier of patience.

**Writes cost more than not caching.** The +25% premium means stamping breakpoints on a prompt that never recurs is a guaranteed loss — the reason [efferent](https://github.com/xandreeddev/agent)'s one-shot helper calls deliberately don't stamp. And all three providers enforce a minimum cacheable prefix — on the order of a thousand to a few thousand tokens depending on model — below which markers are silently ignored. Small prompts don't cache, and shouldn't.

**The breakpoint budget is real.** Four per request, three spent on the conversational pattern. A feature that wants its own breakpoint — a per-document marker for a RAG prefix, say — is competing for one remaining slot, and preserving user-set markers (as the stamping function does) is also how you avoid blowing the budget by double-stamping.

**Caching constrains what you're allowed to want.** This is the deep cost. A frozen prefix means no timestamp in the system prompt, no per-request mode flags up top, no mid-session tool swaps, no "small cleanup" of old history — designs that are perfectly reasonable in a stateless API become cache poison in an agent. You end up routing every dynamic impulse to the tail of the prompt, which is sometimes awkward and always deliberate. The cache doesn't just discount your architecture; it disciplines it.

**Cross-provider means per-provider shaping, forever.** One provider needs markers stamped, one needs a routing key pinned, one needs nothing sent but its usage read from a different field — and one reports input tokens in a way that breaks your gauge unless you correct it. A multi-provider agent can't have a single caching story; it has a router that knows three. And the caches are per-model: the `/model` switch mid-session is a full cold rebuild, priced accordingly.

## The bill is a code review

Here's the reframe I'd put on a sticky note for anyone building an agent: your provider bill is reviewing your architecture whether you asked it to or not. Every property the cache demands — a frozen prefix, append-only history, compression that respects what was already sent, folds taken deliberately instead of edits taken casually — is a property a well-designed transcript store wants *anyway*. Append-only history is what makes sessions replayable and auditable. A stable system prompt is what makes behavior reproducible. Deliberate folds are what make context management explainable. The cache pays you a 10× discount for discipline you should already have, and quietly fines you for every shortcut, in a currency you can read off a status bar.

Most teams discover prompt caching as a line item — someone notices the bill and asks why it's so high, and the answer turns out to be a timestamp. Flip it. Treat the cache as a design constraint from day one, put the percentage where you can see it, and the billing detail takes care of itself. The discount was never the point. The architecture that earns it is.
