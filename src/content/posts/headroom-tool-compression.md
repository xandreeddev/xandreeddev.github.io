---
title: 'The only safe moment to compress a tool output is before it becomes history'
description: 'Cache-safe tool-output compression for agents: clip once at append time, behind a marker the model can reverse.'
pubDate: 2026-07-01
tags: [agents, effect, ai]
draft: true
---

Ask a coding agent to find every caller of a function in a monorepo and it does the obvious thing: it runs grep. The grep returns 80,000 characters. A build log is worse — a failing CI run can dump hundreds of thousands. None of that is pathological; it's Tuesday.

The trap isn't the one-time cost of reading it. The trap is that an agent's conversation is an **append-only array of messages**, and the whole array is re-sent to the model on every turn:

```ts
// turn 5: the model calls grep; the tool returns 80k characters
messages.push({ role: 'tool', content: grepOutput })

// turns 6..30: every prompt is the entire array, serialized
const prompt = [system, ...messages] // the 80k rides along, every single time
```

At the usual rough exchange rate of ~4 characters per token, that one grep is ~20,000 tokens — a tenth of a 200k context window, billed as input again on every turn that follows. Twenty more turns means that single tool call costs roughly twenty times what it looks like it costs.

This post is about cache-safe tool-output compression: clipping an agent's oversized tool results under two non-negotiable constraints — don't break the provider's prompt cache, and don't break the model's ability to get the data back. I didn't invent the approach. I took the core idea — and the name — from [chopratejas/headroom](https://github.com/chopratejas/headroom), a Python proxy whose *dependency* doesn't port to a TypeScript/Bun agent but whose *ideas* do. What follows is the version I rebuilt around those ideas inside [efferent](https://github.com/xandreeddev/efferent), the coding agent I'm building on Effect — where the module still carries the **headroom** name in tribute — with receipts.

## Three obvious fixes, three ways to lose

Before the design, the failure modes it's built against. Everyone's first three ideas are these:

**Truncate.** Cut the string at N characters and move on. The problem is *where* long outputs keep their information: a build log **ends** in its conclusion — the exit code, `199 pass / 1 fail`, the last stack frame. A head-only cut preserves four hundred lines of `compiling module_217.ts … ok` and erases the one line that said why the build failed. You kept the noise and deleted the signal.

**Summarize in place, later.** Let the conversation grow; when it gets fat, walk back through history and replace old tool outputs with summaries. This is the intuitive one, and it has a brutal hidden cost: it **rewrites history**, and history is what the provider's prompt cache is keyed on.

That deserves its one paragraph. Every major provider caches the prompt **prefix**: if the first N bytes of your request exactly match a previous request, those bytes are served from cache at a steep discount instead of being re-processed at full price. The operative word is *exactly* — the prefix must be **byte-stable**. Edit message 12 of a 40-message conversation and every byte from message 12 onward misses the cache; the next request re-bills the bulk of the conversation at the full input rate. The per-provider mechanics (and where [efferent](https://github.com/xandreeddev/efferent) stamps its cache breakpoints) are a post of its own; the only fact headroom needs is this: **a conversation prefix, once sent, is either byte-stable or expensive.** Retroactive summarization converts a token-saving idea into a cache-invalidation machine.

**Raise the budget.** Use a bigger window, or just tolerate the bloat. But the re-billing arithmetic doesn't care how big the window is — you pay for the dead weight on every turn until the session ends. And a window that fills faster is a session that ends sooner: the dead weight drags you toward whatever ceiling forces a context reset, while the model gets measurably worse at finding the needle as the haystack grows.

So: can't cut the tail, can't rewrite the past, can't afford to do nothing. The constraint set looks overdetermined until you notice the one place it isn't.

## Append time is the only safe time

There is exactly one moment in a tool output's life when it is *not yet history*: the gap between the tool handler returning and the string entering the message buffer. Compress there — once — and every constraint falls into line at the same time:

- The **persisted record** carries the compressed form from byte one. There is no fat version on disk to migrate away from.
- Every **future prompt** carries the compressed form from byte one. The prefix never changes after the fact, so the cache never notices anything happened — there is nothing to notice.
- The cost is paid **once**, at the moment the data is freshest, instead of deferred to a cleanup pass that has to guess what mattered.

That ordering insight is the entire architecture. Everything else in this post is mechanics hanging off of it. Here is where it lives in [efferent](https://github.com/xandreeddev/efferent)'s agent loop — the model has just responded, possibly with tool results attached:

```ts title="packages/core/src/usecases/agentLoop.ts"
const rawTail = responseToAgentMessages(res.content)
// Headroom: oversized tool results are compressed HERE — the only moment
// they enter the buffer — so the persisted history and every future
// prompt prefix carry the clipped form from byte one. Caches stay warm;
// nothing already sent is ever rewritten.
const compressed = yield* compressToolResults( // [!code highlight]
  rawTail,
  input.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS, // 16_000 ≈ 4k tokens
)
messages = [...messages, ...compressed.messages] // append-only from here on
newTail.push(...compressed.messages)             // …and this is what gets persisted
```

`compressToolResults` walks the new tail's tool-result messages, looks one level deep into each result object (tool outputs are flat structs — `{ content }`, `{ stdout, stderr }`, `{ diff }`), and clips any string over the budget. Everything under budget passes through untouched, by reference. The budget is configurable (`Settings.toolResultMaxTokens`, multiplied by 4 into characters; `0` disables the whole mechanism) and defaults to 16,000 characters — about 4k tokens per string.

One detail in the loop is easy to miss and worth the emphasis: the loop's **hooks fire with the raw response, before compression**. The hooks are what drive the TUI, so the human watching the session sees the full 80k characters scroll by in the rail, while the model's next prompt — and the database — get the clipped form. Two consumers, two budgets. A human scans cheaply; a model pays per token, forever. The test suite pins this down: the hook observer receives the full-length string, the persisted tail contains the marker.

## The clip: structure lives at the head, conclusions at the tail

The fallback compressor — what runs when the output has no recognizable shape — is a planned head+tail clip. Planning and rendering are split so a summary (next section's subject) can be woven in between, and the plan itself is a pure function:

```ts title="packages/core/src/usecases/headroom.ts"
/** Default per-string budget for a tool result (~4k tokens). */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 16_000

/** A planned clip: what stays, what goes. `null` = the text fits. */
export interface ClipPlan {
  readonly head: string
  readonly tail: string
  readonly dropped: string
}

export const planClip = (text: string, maxChars: number): ClipPlan | null => {
  if (maxChars <= 0 || text.length <= maxChars) return null
  const headLen = Math.floor(maxChars * 0.75)   // [!code highlight]
  const tailLen = Math.floor(maxChars * 0.125)
  return {
    head: text.slice(0, headLen),
    tail: text.slice(text.length - tailLen),
    dropped: text.slice(headLen, text.length - tailLen),
  }
}
```

The 75/12.5 split is not numerology; it's a bet on where information lives in machine output. Openings carry **structure**: the command banner, headers, function signatures, the first error. Endings carry **conclusions**: exit codes, the final summary line, the last thing printed before the process died. The middle of a long output is statistically where the repetition lives. The remaining eighth of the budget pays for the marker.

`planClip` has the kind of contract property-based testing was made for — `head + dropped + tail` must reconstruct the input exactly, at every length, every budget, even when a slice boundary lands mid-surrogate-pair — and a fast-check suite hammers exactly that identity, but property testing this codebase is a post of its own.

### The marker is a contract, not an apology

Here is what actually replaces the dropped middle:

```ts title="packages/core/src/usecases/headroom.ts"
export const renderClip = (plan: ClipPlan, toolName: string, summary: string | null) => {
  const dropped = `~${estimateTokens(plan.dropped.length)} tokens`
  const digest = summary ? ` Summary of the omitted part: ${summary.trim()}` : ''
  return (
    `${plan.head}\n` +
    `[…headroom: ${dropped} of this ${toolName} output omitted.${digest}` +
    ` To retrieve it, re-run the tool narrower — read_file with offset/limit,` + // [!code highlight]
    ` a more specific grep, or bash piped through head/tail.]\n` +
    `${plan.tail}`
  )
}
```

So an 80k-character bash output, clipped against the default budget, carries this where its middle used to be:

```
[…headroom: ~16500 tokens of this Bash output omitted. To retrieve it,
re-run the tool narrower — read_file with offset/limit, a more specific
grep, or bash piped through head/tail.]
```

Read that as a message to the model, because that's what it is. It names what's missing, in the model's own currency (tokens, not characters). And then it does the load-bearing thing: it states, concretely, **how to get the data back**. `read_file` takes `offset` and `limit` parameters — page in exactly the lines you need. Grep accepts a narrower pattern or a subdirectory. Bash output pipes through `head` and `tail`. Every dropped byte is still sitting in the workspace, one cheaper, more targeted tool call away.

That's the difference between a hole and a pointer. A bare `[truncated]` is an apology — it tells the model that data existed and is now gone, and the model's only move is to hope it didn't matter. The headroom marker is a **contract**: the data was elided *from the transcript*, not from the world, and here is the retrieval path. This isn't speculative — watching live sessions, the model treats it exactly that way: it hits a marker, decides the missing region matters, and greps its way to the buried line instead of trusting the hole. Compression the model can undo on demand stops being lossy in any sense that matters; it's lazy loading.

## When the output has a shape, keep the shape

A blind head+tail clip is the *fallback*, not the strategy. Real tool outputs are rarely shapeless — and for the two shapes that dominate an agent's life, a structure-aware pass beats the blind clip so thoroughly that it runs first:

```ts title="packages/core/src/usecases/headroom.ts"
// One string path: try a structure-aware plan first, fall back to the
// blind head+tail clip. Both end in the same reversible marker.
const compressString = (text: string, toolName: string) =>
  Effect.gen(function* () {
    if (text.length <= maxChars) return text
    const content = planContentCompression(text, toolName, maxChars) // [!code highlight]
    if (content !== null) {
      const summary = content.omitted.length > 0 ? yield* summarize(content.omitted) : null
      return renderContent(content, summary)
    }
    const plan = planClip(text, maxChars)
    return renderClip(plan, toolName, yield* summarize(plan.dropped))
  })
```

Routing is deliberately conservative, and source-hinted. Search shape is accepted from **any** tool, because `path:42:` lines are unmistakable. Log shape is trusted **only** for bash output — a fetched web page or a file that happens to contain the word "error" must not get log treatment:

```ts title="packages/core/src/usecases/headroomContent.ts"
export const planContentCompression = (text: string, toolName: string, maxChars: number) =>
  planSearchCompression(text, maxChars) ??
  (toolName === 'Bash' ? planLogCompression(text, maxChars) : null) // [!code highlight]
```

### Grep floods: the map matters more than the matches

Run a blind clip over a grep that matched 2,000 lines across 50 files and you keep a few hundred matches from the first files — and silently erase every other file from the record. But think about what the model actually *does* with a grep flood: it's building a map. The next decision is "which of these files do I open," and for that decision, *which files matched and how many times* is worth more than the verbatim text of match #1,400.

So the search planner inverts the blind clip's priorities. Every file stays visible; the bulk goes:

```ts title="packages/core/src/usecases/headroomContent.ts"
/** `path:NN:` match lines and `path-NN-` context lines (grep -C). */
const SEARCH_LINE = /^(.{1,260}?)[:-](\d+)[:-]/
const SEARCH_MAX_PER_FILE = 5

export const planSearchCompression = (text: string, maxChars: number): ContentPlan | null => {
  // Detect: ≥20 lines parse as `path:NN:` AND they're ≥75% of non-empty
  // lines — and the path must look like one ("12:34:56" timestamps don't).
  // …
  // Greedy under the budget: every file gets a header + its first 5 matches.
  for (const [file, group] of byFile) {
    const picked = group.slice(0, SEARCH_MAX_PER_FILE)
    const header = group.length > picked.length
      ? `${file} (${group.length} matches, showing ${picked.length})` // [!code highlight]
      : `${file} (${group.length} matches)`
    // …append header + picked lines until ~90% of the budget
  }
  return {
    kind: 'search',
    kept,
    omitted: '', // omitted matches are homogeneous — nothing a digest could add
    summary: `${total - shown} of ${total} matched lines omitted ` +
      `(${byFile.size} files, ${shownFiles} shown, first 5 matches each)`,
    hint: 're-run the search narrower — a more specific pattern, a subdirectory, or fewer context lines',
  }
}
```

The detection thresholds are the quiet part doing loud work. At least 20 parseable match lines, making up at least 75% of the non-empty lines, each with a path-looking prefix — anything less declines and falls through to the blind clip. A planner that misfires on prose would be worse than no planner; these only ever *improve* on the fallback, never gamble against it.

The result reads like a table of contents with exact bookkeeping, capped off by the same reversible-marker contract, rendered from the plan's `summary` and `hint`:

```
src/billing/invoice.ts (38 matches, showing 5)
  14:  const total = applyDiscount(subtotal, rate)
  …
[…headroom: 1810 of 2000 matched lines omitted (50 files, 38 shown, first
5 matches each). To retrieve, re-run the search narrower — a more specific
pattern, a subdirectory, or fewer context lines.]
```

Exact counts, on purpose. "38 matches, showing 5" tells the model precisely how hot each file is; "1810 of 2000 omitted" tells it precisely how much it hasn't seen. Compression that lies about its own magnitude trains the model to distrust the transcript.

### Build logs: keep every error, dedup every warning

The other dominant shape is the build/test log, and its information profile is the inverse of grep's: almost everything is filler, and the signal is *sparse and positional* — errors with their stack traces, warnings, the runner's summary lines, and the head and tail of the run. The log planner classifies every line and then selects under the budget in priority order:

```ts title="packages/core/src/usecases/headroomContent.ts"
const ERROR_RE = /\b(error|fail(ed|ure|ing)?|fatal|exception|panic(ked)?|traceback|assert…)\b|✗|✖/i
/** Continuation lines of a stack/trace block. */
const TRACE_RE = /^\s+(at\s+\S|File "|\d+ \||[~^]+\s*$)|^\s*Caused by:|^\s{4,}\S/

export const planLogCompression = (text: string, maxChars: number): ContentPlan | null => {
  // Classify every line: error / warning / test-runner summary. No error
  // signal and fewer than two summary lines? Decline — not log-shaped.
  // …
  // Select under the budget, in priority order: head+tail always, then
  // summaries, then error blocks IN FULL, then deduped warnings.
  for (const start of errorStarts) {
    const block = [start - 1, start] // one line of leading context
    for (let i = start + 1; TRACE_RE.test(lines[i]); i++) block.push(i) // [!code highlight]
    if (!tryAdd(block)) break
  }
  // …re-emit everything selected in ORIGINAL order; each gap becomes an
  // inline `  […N lines omitted…]`, repeated warnings collapse to `(×N)`
}
```

The highlighted loop is a small state machine that absorbs trace continuations — `at fn (file:42:11)` frames, Python's `File "…"` lines, `Caused by:` chains, deeply indented context — so an error never gets separated from its stack. That's the failure the blind clip can't avoid: a clip boundary that lands mid-traceback hands the model an error with no cause, which reliably sends it off re-running the build to see what it was just shown half of.

Two more moves earn their keep. Identical warnings dedup to one occurrence annotated `(×247)` — the count *is* the information; 247 verbatim copies are not. And the selected lines re-emit in their original order with inline gap markers, so the log still reads as a timeline rather than a pile of extracted quotes. Run it over a real 1,200-line build log and what survives is precisely what a human debugging the run would have scrolled to: the banner, the one failing test with its full trace, the deduped deprecation warning, `199 pass / 1 fail`, the exit line.

## A digest of the part you didn't see

The marker tells the model how much it's missing and how to retrieve it. When the dropped middle is large, headroom goes one step further and tells it *what* it's missing — by paying a much cheaper model to read the discard pile.

[efferent](https://github.com/xandreeddev/efferent) runs all agentic work on one main model, but keeps a **fast** role — a cheap, low-latency model slot — for one-shot helper calls inside a running turn (the multi-provider routing underneath is a post of its own). Headroom is that tier's flagship customer:

```ts title="packages/core/src/usecases/headroom.ts"
/** Dropped middles smaller than this aren't worth a fast-model summary. */
const SUMMARY_MIN_DROPPED_CHARS = 4_000
/** Cap on what we FEED the summarizer (a 2M-char log needn't be read whole). */
const SUMMARY_INPUT_MAX_CHARS = 24_000

const SUMMARIZE_PROMPT =
  'Condense the following omitted middle section of a tool output into at most 120 words. ' +
  'Dense and factual: preserve identifiers, file paths, numbers, error messages. ' + // [!code highlight]
  'No preamble — output only the summary.'

const summarize = (dropped: string): Effect.Effect<string | null> =>
  Option.isNone(utility) || dropped.length < SUMMARY_MIN_DROPPED_CHARS
    ? Effect.succeed(null)
    : utility.value
        .complete(`${SUMMARIZE_PROMPT}\n\n<omitted>\n${dropped.slice(0, SUMMARY_INPUT_MAX_CHARS)}\n</omitted>`, { role: 'fast' })
        .pipe(
          Effect.map((res) => res.text),
          Effect.catchAll(() => Effect.succeed(null)), // degrade — never fail the pass
        )
```

The prompt is tuned for what a *model* needs from a summary, which is not what a human needs. "Dense and factual: preserve identifiers, file paths, numbers, error messages" — a digest that says "various modules compiled with some warnings" is worthless; one that says "modules 0–1199 compiled clean except legacy.ts (deprecated API ×2); foo.test.ts failed at foldThing src/foo.ts:42" hands the model real coordinates it can act on or retrieve against. The digest lands inside the marker itself: `Summary of the omitted part: …` — so the hole comes pre-labeled.

The integration is best-effort by construction, and Effect makes both halves of that visible in the types. The `utility` above comes from `Effect.serviceOption(UtilityLlm)` — the service is an *optional* dependency, so headroom works in environments that never wired a utility model (evals, tests, minimal setups). And the `catchAll` means a rate-limited or misconfigured summarizer degrades to the plain marker rather than failing the compression pass; the whole-system Effect tour is a post of its own. Note also where the digest *doesn't* run: the search planner sets `omitted: ''` because two thousand homogeneous grep matches contain nothing a 120-word digest could add — the per-file counts already said it all.

The cost math is almost embarrassing. The summarizer reads at most 24,000 characters (~6k tokens) and writes ~160, once, on a tier priced at small fractions of the main model. The clip it annotates saves ~16k main-model input tokens *per remaining turn* — over a 20-turn tail, a few hundred thousand tokens at the most expensive rate you buy. The digest is a rounding error purchasing insurance on the clip; the spend is still accounted honestly, surfaced through a loop hook into the session's per-role ledger rather than hidden in the noise.

## The same rule at every altitude

Per-string clipping at append time is the centerpiece, but it's one tier of three, and the same head+tail philosophy runs through all of them.

Below headroom sit **tool-level output caps**: bounds on what a single call may return at all. The interesting design decision is that they keep head+tail too:

```ts title="packages/core/src/usecases/codingToolkit.ts"
/**
 * Tool-level output cap: keep head + tail, drop the middle. The tail
 * matters — long runs END in their conclusion (exit summaries,
 * 'N pass / M fail'), and a head-only cut erased exactly the lines
 * headroom's log compression most wants to keep.
 */
export const truncateOutput = (s: string, max: number): string => {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return (
    `${s.slice(0, head)}\n` +
    `... (truncated: ${s.length - max} bytes omitted from the middle of this output) ...\n` + // [!code highlight]
    `${s.slice(s.length - tail)}`
  )
}
```

That comment records a real lesson: an earlier head-only cap was destroying the exact summary lines the log planner downstream is built to preserve. The tiers have to agree on where signal lives, or the lower one starves the upper one. Tools with natural paging — `read_file`, `web_fetch` — carry their own caps and report `truncated: true`; headroom is the **generic backstop** for everything without one: bash stdout, grep floods, whatever tool gets added next year by someone who never read this post.

Above headroom sits the question of **sub-agents**. [efferent](https://github.com/xandreeddev/efferent) fans work out to child agents, each running the same loop with its own conversation — and a sub-agent that doesn't compress would ship its bloat right back to the parent as a tool result. The budget therefore travels with the run, not the wiring: it rides a `FiberRef` — Effect's typed, fiber-scoped take on ambient context, inherited by every child fiber — so every loop in the tree compresses like the root without a parameter threaded through forty signatures:

```ts title="packages/core/src/usecases/runContext.ts"
export interface RunContext {
  readonly rootConversationId: ConversationId | null
  readonly depth: number
  readonly tokenPool: TokenPool // one shared spend pool for the whole subtree
  /** Headroom budget (chars) per tool-result string, threaded so
   *  sub-agent loops compress like the root. 0 disables. */
  readonly toolResultMaxChars?: number // [!code highlight]
}
```

The spawn machinery reads `toolResultMaxChars` off the ambient context and passes it into every child loop it starts — set the budget once at the top of a run and the entire agent tree honors it, including agents spawned three levels down by code that has never heard of headroom.

And when the *whole conversation* nears the window despite all of this, a different mechanism folds it at a deliberate boundary — one intentional prefix rebuild, then byte-stable again — but checkpoint folding and handoffs are a post of its own.

## What it costs

Honesty section. Headroom is heuristics about where information lives, and heuristics have failure modes.

**Any compression can drop the one line that mattered.** The blind clip's middle, the search planner's match #6 in some file, a log line that looked like filler — sometimes that was the line. The mitigation is the whole point of the marker design: the data is never *gone*, it's one targeted tool call away, and the marker spells out the path. But the mitigation costs a round trip, and it only fires if the model notices it's missing something. A model that confidently reasons over a clipped transcript without pulling the marker's thread is the residual risk, and no marker text fully retires it.

**Digests add latency on the hot path.** The summarizer call runs inside the turn, between the tool returning and the next model call, and a turn that clips several oversized strings serializes several of them. The fast tier exists precisely to keep this cheap and quick, and the thresholds keep it rare — but it's real wall-clock time spent polishing a hole.

**Characters are a proxy for tokens.** The 4:1 estimate that converts the configured token budget into a character budget is honest for typical code and logs and wrong for dense Unicode, base64 blobs, and minified output. The budget is a heuristic with a safety margin, not an accounting identity — which is also why the gauge that decides bigger questions (like when to fold the conversation) uses the provider's real token counts, not this estimate.

**Shape detectors are regexes.** The search planner's thresholds and the log planner's error patterns were tuned against the outputs these tools actually emit; an exotic test runner or a log format that buries errors in unindented prose can slip past classification. The failure is graceful by design — anything unrecognized gets the blind clip, which never lies — but graceful degradation is still degradation. The conservative gating (log shape only for bash) trades missed wins for never misclassifying prose, and I'd make that trade again.

## Buckets spill; caches page

Most agent harnesses treat the context window as a bucket: pour tool outputs in until it overflows, then do something violent — truncate, summarize the world, start over. Headroom treats it as what it actually is: the hottest tier of a storage hierarchy. The full data stays in the workspace, on disk, retrievable. The transcript holds a working set — heads, tails, structure, exact counts, a digest — plus a pointer for paging the rest back in. The human rail gets the whole stream because humans skim for free.

Once you see it that way, the design writes itself, and the one rule that makes it sound is the one this post is named for: **eviction happens at write time, never after.** Compress the moment the data enters history and the cache stays warm, the persisted record agrees with what the model saw, and nothing is ever rewritten. Compress later and you're not managing memory anymore — you're falsifying it, and paying the provider for the privilege.

The token bill is the symptom people notice. The deeper claim is about trust: an agent's transcript is the only world the model has, and a transcript full of unlabeled holes makes that world unreliable in ways that are hard to debug and expensive to discover. Cut what you must, label every cut, price the cut in the model's own currency, and always — always — leave the way back. That's not a token optimization. That's an interface contract with the only consumer that reads every byte.
