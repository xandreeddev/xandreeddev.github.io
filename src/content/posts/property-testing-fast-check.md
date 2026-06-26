---
title: 'The model will find the fourth shape: property-based testing with fast-check'
description: 'Property-based testing for mapping code: fast-check via Effect, with generators derived from your schemas.'
pubDate: 2026-06-14
tags: [effect, typescript, agents]
series:
  name: 'Effect in practice'
  order: 3
draft: false
---

There's a category of code that decides whether your system works and that nobody can review by reading: mapping code. Serializers, message translators, compression planners, parsers. It's not hard code — every branch is a `case` and a field rename — but its input space is combinatorial, and your example tests cover exactly the inputs you thought of. Three message shapes, hand-typed in a test file, asserting three outputs you also hand-typed.

Then production produces the fourth shape.

In most systems "production" means users, and users are at least predictably weird. In an agent, the upstream producer of your trickiest inputs is a language model — a sampling process that will eventually emit every structurally valid combination your types allow, plus a few your types allow but your brain didn't. An assistant message whose content is an empty array. A reasoning part with a provider blob attached. A provider blob that is `{}` — present, but empty. You will not write that example test, because you will not think of that example.

Property-based testing is the fix, and it's old, well-understood technology — QuickCheck shipped in 1999. What's new enough to be worth a post is how cheap Effect has made it: the library ships fast-check inside it, and — the part that actually changed my testing habits — it can **derive the test-data generators from the same schemas that validate production data**. One source of truth describes what a message is; the validator and the fuzzer are two views of it.

Everything below is real code from [efferent](https://github.com/xandreeddev/efferent), the coding agent I'm building on Effect — specifically the test suite added in one commit that property-tested the message-mapping seam, the context-compression planners, and a couple of parsers. We'll start with the bug class, build property testing up from nothing, and then walk the actual properties.

## The seam that has to be perfect: messages in, messages out

[efferent](https://github.com/xandreeddev/efferent) persists conversations as `AgentMessage` rows — a shape structurally mirroring the Vercel AI SDK's `ModelMessage`, kept stable so the database survives framework changes. The LLM layer, though, is `@effect/ai`, which speaks its own `Prompt` and `Response` types. Between them sits `promptMapping.ts`: pure functions that translate every persisted message into a prompt message before each turn, and every response part back into persisted messages after it.

The mapping itself is exactly as boring as you'd hope:

```ts title="packages/sdk-core/src/usecases/promptMapping.ts"
const hasKeys = (o: unknown): o is Record<string, unknown> =>
  typeof o === 'object' && o !== null && Object.keys(o).length > 0

const withOptions = (blob: unknown) => (hasKeys(blob) ? { options: blob } : {}) // [!code highlight]

/** Persisted `AgentMessage[]` → `@effect/ai` prompt messages. */
export const toPromptMessages = (messages: ReadonlyArray<AgentMessage>) =>
  messages.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.content }
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content.map((p) =>
          p.type === 'tool-call'
            ? {
                type: 'tool-call',
                id: p.toolCallId,
                name: p.toolName,
                params: p.input ?? {},
                providerExecuted: p.providerExecuted ?? false,
                ...withOptions(p.providerOptions),
              }
            : { type: p.type, text: p.text, ...withOptions(p.providerOptions) },
        ),
        ...withOptions(m.providerOptions),
      }
    }
    // role === 'tool': same dance for tool-result parts
  })
```

Boring, but load-bearing in a way that's easy to miss: that `providerOptions` blob is *opaque provider state that must round-trip*. The sharpest example is Gemini's `thought_signature` — when thinking is enabled, Gemini attaches a signature to its output parts and expects to receive it back verbatim on later turns; lose it and multi-turn tool calling degrades. `@effect/ai` has a convenience helper that builds prompt messages from response parts, and it drops that metadata — which is precisely why [efferent](https://github.com/xandreeddev/efferent) maps by hand and carries the blob through both directions: response part metadata → persisted `providerOptions` → prompt part `options`.

Now count the input space. Three message roles. Four content-part types. Each part optionally carrying `providerOptions`, which can be absent, a populated object, an *empty* object, or — because the schema says `Unknown` — anything at all. Parts compose into arrays of any length, messages into conversations of any length. The function has maybe forty lines, and the number of structurally distinct inputs is, for testing purposes, infinite.

An example suite samples that space at three points and declares victory. The model samples it continuously, forever, with no regard for which points you tested. The `hasKeys` line highlighted above is exactly the kind of decision that example tests ratify without examining: `{}` is treated as *absent*, not as an empty options object. Is that right? Is it *consistently* right, across all four part types and the message level too? I genuinely don't know how to answer that by reading, and I wrote it.

## Property-based testing in sixty seconds

Property-based testing inverts the usual deal. Instead of you choosing inputs and asserting exact outputs, you state an **invariant** — something that must hold for *every* input — and the framework generates hundreds of random inputs trying to break it. Three concepts cover the whole field:

**Arbitraries** are composable random generators. `fc.integer()` makes integers, `fc.array(fc.string())` makes arrays of strings, `fc.record({ … })` makes objects. They nest like the types they describe.

**Properties** are predicates over generated inputs. Here's the whole pattern, generically, on a function that deduplicates an array:

```ts
import * as fc from 'fast-check'

const dedupe = <A>(xs: ReadonlyArray<A>): Array<A> => [...new Set(xs)]

fc.assert(
  fc.property(fc.array(fc.integer()), (xs) => {
    const out = dedupe(xs)
    expect(new Set(out).size).toBe(out.length)  // no duplicates remain
    for (const x of xs) expect(out).toContain(x) // nothing was lost
    expect(dedupe(out)).toEqual(out)             // running it twice changes nothing
  }),
)
```

Notice what the property *doesn't* say: it never states what `dedupe([3, 1, 3])` returns. It states three things that must be true of the output for any input — completeness, uniqueness, idempotence (a function is **idempotent** when applying it twice gives the same result as applying it once). That's the discipline shift: you're writing down the function's contract, not its trace.

**Shrinking** is the feature that makes failures usable. When a property fails on some 80-element array of large integers, fast-check doesn't hand you that monster — it systematically simplifies the failing input while re-checking the property, and reports the *minimal* case that still fails. You don't debug `[483, -291, 0, 17, …]`; you debug `[0, -1]`. It also prints the seed and path that reproduce the run, so a property failure is exactly as replayable as an example failure. Shrinking is the difference between "the fuzzer found something" and "here is your bug, reduced".

That's the entire theory. The practice question is: where do good arbitraries come from? Hand-writing a generator for a recursive union-of-structs message type is real work — work that drifts out of sync with the type the moment someone adds a field. Which brings us to the part Effect changed.

## One source of truth: the schema that validates also generates

[efferent](https://github.com/xandreeddev/efferent)'s message type isn't a TypeScript interface — it's an Effect `Schema`, a runtime value that describes a data shape and can derive things from that description: a decoder, an encoder, a JSON-Schema, a TypeScript type. This is what messages actually are:

```ts title="packages/sdk-core/src/entities/Conversation.ts"
export const TextPart = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String,
  providerOptions: Schema.optional(Schema.Unknown), // [!code highlight]
})
// … ReasoningPart, ToolCallPart, ToolResultPart: same idea, more fields

export const UserMessage = Schema.Struct({
  role: Schema.Literal('user'),
  content: Schema.String,
  providerOptions: Schema.optional(Schema.Unknown),
})

export const AssistantMessage = Schema.Struct({
  role: Schema.Literal('assistant'),
  content: Schema.Array(Schema.Union(TextPart, ReasoningPart, ToolCallPart)),
  providerOptions: Schema.optional(Schema.Unknown),
})

export const ToolMessage = Schema.Struct({
  role: Schema.Literal('tool'),
  content: Schema.Array(ToolResultPart),
  providerOptions: Schema.optional(Schema.Unknown),
})

export const AgentMessage = Schema.Union(UserMessage, AssistantMessage, ToolMessage)
```

This schema already earns its keep in production — every conversation row decodes through it on load. The discovery that reshaped the test suite is that Effect can derive *one more thing* from it: a fast-check arbitrary. Effect ships fast-check as a re-export (`effect/FastCheck` is literally `export * from 'fast-check'` — no extra dependency, no version skew with the `Arbitrary` module), and `Arbitrary.make` turns any schema into a generator:

```ts title="packages/sdk-core/src/entities/Conversation.test.ts"
import { Arbitrary, FastCheck as fc, Schema } from 'effect' // [!code highlight]
import { AgentMessage } from './Conversation.js'

const roundTrip = <A, I>(schema: Schema.Schema<A, I>) => {
  const encode = Schema.encodeSync(schema)
  const decode = Schema.decodeUnknownSync(schema)
  return (value: A) => expect(decode(encode(value))).toEqual(value)
}

it('AgentMessage survives encode→decode for any generated message', () => {
  fc.assert(fc.property(Arbitrary.make(AgentMessage), roundTrip(AgentMessage)), {
    numRuns: 100,
  })
})
```

Sit with what that one-liner covers. `Arbitrary.make(AgentMessage)` generates messages across all three union members, all four part types, arrays of every length, and — because `providerOptions` is `Schema.optional(Schema.Unknown)` — the optional field is sometimes missing, sometimes a string, sometimes `{}`, sometimes a seven-level nested object of garbage. Every shape the schema admits, the generator produces. The property is the most fundamental one a persisted type has: **encoding then decoding is the identity** — what you write to the database is what you read back, for *any* value the type allows, including branded IDs and unknown payloads.

And the drift problem is structurally gone. Add a field to `ToolCallPart` next month and the generator grows it automatically; there is no hand-rolled test factory to forget. The schema that validates production data *is* the schema that generates test data. One definition, two directions: data in, checked; data out, generated. When people ask what schema libraries buy you over interfaces, this is my current favorite answer.

## The receipts: properties over the prompt seam

With generators free, the question becomes which invariants to state. Here are the strongest ones from `promptMapping.test.ts`, in ascending order of how much they'd have cost me as production bugs.

### Every message maps 1:1, and options presence is exact

```ts title="packages/sdk-core/src/usecases/promptMapping.test.ts"
const msgArrayArb = fc.array(Arbitrary.make(AgentMessage), { maxLength: 8 })

it('is total and maps every message 1:1, preserving roles, parts, and options presence', () => {
  fc.assert(
    fc.property(msgArrayArb, (messages) => {
      const out = toPromptMessages(messages)
      expect(out.length).toBe(messages.length)
      messages.forEach((src, i) => {
        const dst = out[i]
        expect(dst.role).toBe(src.role)
        if (src.role === 'user') return expect(dst.content).toBe(src.content)
        src.content.forEach((sp, j) => {
          const dp = dst.content[j]
          // an `options` key exists iff providerOptions is a non-null object
          // with ≥1 own key — and it carries the blob verbatim
          expect('options' in dp).toBe(hasKeys(sp.providerOptions)) // [!code highlight]
          if ('options' in dp) expect(dp.options).toEqual(sp.providerOptions)
          // … then per-type field checks: text/reasoning keep their text,
          // tool-calls keep id/name/params, defaults applied exactly once
        })
      })
    }),
    { numRuns: 100 },
  )
})
```

Three invariants ride in this one property. **Totality** — the function never throws, for any input the schema admits; just running it 100 times on adversarial messages proves that. (A *total* function is defined for every input in its domain — the opposite of the function that works until someone passes the case you didn't switch on.) **1:1 structure** — no message or part is ever dropped, duplicated, or reordered. And the highlighted line, the one I care most about: **options presence is exact**. The `options` key exists on the output if and only if `providerOptions` is a non-null object with at least one key, and when it exists it carries the blob *verbatim*. That single `expect` pins the `{}` question from earlier — empty blobs are dropped, populated ones survive untouched, consistently, across every part type and nesting the generator can produce. This is the property standing guard over Gemini's `thought_signature`: "the blob survives verbatim" checked against thousands of generated blob placements, not the two I'd have typed by hand.

A fair question: why is this a field-by-field correspondence check rather than a tidy round-trip like the schema test? Because the two sides are *different types* — `AgentMessage` and `@effect/ai`'s prompt shape don't compose into an identity you can assert. When a true inverse exists, state the round-trip; when it doesn't, pin the correspondence. Both are properties; one is just prettier.

### Usage embedding: idempotent, and surgical about what it overwrites

[efferent](https://github.com/xandreeddev/efferent) persists each turn's token usage *inside* the first assistant message's `providerOptions`, under an `'efferent'` key — so cost data survives in the conversation row with no schema migration. That's a write into the exact blob that must otherwise round-trip untouched, which makes its contract worth stating precisely:

```ts title="packages/sdk-core/src/usecases/promptMapping.test.ts"
const usageArb = fc.record({
  inputTokens: fc.nat(),
  outputTokens: fc.nat(),
  totalTokens: fc.nat(),
  cacheReadTokens: fc.nat(),
})

it('attach is idempotent and round-trips through assistantUsage', () => {
  fc.assert(
    fc.property(msgArrayArb, usageArb, (messages, usage) => {
      const arr = structuredClone(messages)
      attachUsageToAssistant(arr, usage)
      const once = structuredClone(arr)
      attachUsageToAssistant(arr, usage) // attaching a second time…
      expect(arr).toEqual(once)          // …changes nothing
      const head = arr[0]
      if (head?.role === 'assistant') expect(assistantUsage(head)).toEqual(usage)
    }),
  )
})

it("preserves every prior providerOptions key except 'efferent'", () => {
  fc.assert(
    fc.property(msgArrayArb, usageArb, (messages, usage) => {
      const head = messages[0]
      if (head?.role !== 'assistant') return
      const prev = { ...(head.providerOptions ?? {}) }
      attachUsageToAssistant(messages, usage)
      for (const [k, v] of Object.entries(prev)) {
        if (k === 'efferent') continue // intentionally overwritten
        expect(head.providerOptions[k]).toEqual(v) // [!code highlight]
      }
      expect(head.providerOptions['efferent']).toEqual(usage)
    }),
  )
})
```

The second property is the one a hand-written example would have fumbled. To exercise "attaching usage must not clobber unrelated provider state", an example test needs me to *invent* the unrelated provider state — and I'd have invented something polite. The generator instead produces assistant messages whose `providerOptions` already contain arbitrary junk at arbitrary keys — including, occasionally, a pre-existing `'efferent'` key, which is why the carve-out is written into the property as an explicit, documented exception rather than papered over. The invariant reads like the contract you'd want in the doc comment: *every key survives, except the one we own.* A companion property pins the other direction — `recoverConversationStats`, which scans a persisted conversation and rebuilds the cost totals, must sum *exactly* the usages that were attached, in order, and stay total on arbitrary message arrays that contain no usage at all.

That pair — careful write, exact read — is the entire persistence story for token accounting, and I trust it more than any code I've reviewed this month, because it's been adversarially sampled a few hundred times per CI run since the day it was written.

## Properties for compression plans

The same commit property-tested a very different seam: **compaction**, the context-compression pass in [efferent](https://github.com/xandreeddev/efferent) — its core idea borrowed from the [chopratejas/headroom](https://github.com/chopratejas/headroom) library (efferent's pass was even called `headroom` once, since renamed; a post of its own). When a tool result is oversized, a planner splits it into a head to keep, a middle to drop, and a tail to keep. Compression is the canonical place where example tests give false confidence — every example you write is text you chose, and text you chose has friendly lengths and friendly characters:

```ts title="packages/sdk-core/src/usecases/compaction.test.ts"
it('planClip fires iff oversized; the split is lossless; head/tail sizes exact', () => {
  fc.assert(
    fc.property(
      // fullUnicodeString included deliberately: slices can land mid-surrogate
      // and the code-unit concat identity must still hold
      fc.oneof(fc.string({ maxLength: 400 }), fc.fullUnicodeString({ maxLength: 400 })),
      fc.integer({ min: -10, max: 300 }),
      (text, maxChars) => {
        const plan = planClip(text, maxChars)
        if (maxChars <= 0 || text.length <= maxChars) {
          expect(plan).toBeUndefined()
        } else {
          expect(plan.head + plan.dropped + plan.tail).toBe(text) // [!code highlight]
          expect(plan.head.length).toBe(Math.floor(maxChars * 0.75))
          expect(plan.tail.length).toBe(Math.floor(maxChars * 0.125))
        }
      },
    ),
    { numRuns: 300 },
  )
})
```

The highlighted line is a **lossless-split invariant**: head, dropped middle, and tail concatenate back to the original, exactly, for any text and any budget — including negative budgets, zero budgets (which mean "disabled"), and strings full of emoji whose surrogate pairs a slice can land in the middle of. That last case is in the generator *on purpose*: `fc.string()` alone leans toward tame ASCII-ish output, so the test mixes in `fc.fullUnicodeString()` to drag the nasty plane in. I would never have typed an example with a budget boundary that bisects an emoji. The generator found that case in its first hundred runs, and the property says the identity holds anyway.

One level up, the structural planners get a different generator strategy worth naming: **constructed corpora**. Fully random text almost never looks like grep output, so a totality property over `fc.string()` proves "never throws" but exercises nothing interesting. The fix is an arbitrary that *builds* realistic input from random parts, so the property can assert real arithmetic:

```ts title="packages/sdk-core/src/usecases/compactionContent.test.ts"
const matchArb = fc.record({
  file: fc.stringMatching(/^[a-z]{1,8}$/).map((w) => `src/${w}.ts`),
  lineNo: fc.integer({ min: 1, max: 9999 }),
  text: fc.string({ maxLength: 200 }).map((t) => t.replace(/[\r\n]/g, ' ')),
})

it('kept lines come from the input, budget holds, counts add up', () => {
  fc.assert(
    fc.property(
      fc.array(matchArb, { minLength: 20, maxLength: 150 }),
      fc.integer({ min: 2000, max: 20_000 }),
      (matches, maxChars) => {
        const text = matches.map((m) => `${m.file}:${m.lineNo}:${m.text}`).join('\n')
        const plan = planSearchCompression(text, maxChars)
        const m = /^(\d+) of (\d+) matched lines omitted \((\d+) files/.exec(plan.summary)
        const [, omitted, total, files] = m.map(Number)
        expect(total).toBe(matches.length) // [!code highlight]
        expect(files).toBe(new Set(matches.map((x) => x.file)).size)
        // … plus: every kept line is a line from the input, and the
        // output stays within the budget's stated slack
      },
    ),
  )
})
```

The compressor tells the model "412 of 3,000 matched lines omitted (61 files, 12 shown)", and the model makes decisions based on those numbers — so the numbers had better be *arithmetic*, not vibes. Because the test constructed the corpus, it knows the ground truth: the real match count, the real distinct-file count. The property asserts the summary's claims against that ground truth across thousands of random corpora. This is the pattern I'd point at for anyone testing report-generating code: generate the facts, render the input from the facts, then check the output's claims against the facts you started from.

## Where properties win, and where examples keep the job

The pattern generalizing across these examples: property tests dominate wherever the code is **algebraic** — where its correctness is a law relating inputs and outputs, independent of what any particular input *means*. Mappings (1:1, presence-exact), codecs (decode ∘ encode = identity), compression plans (lossless split, honest arithmetic), parsers (total on garbage, exact on constructed input). The cleanest specimens in the codebase are two one-line laws about model-string parsing:

```ts title="packages/sdk-core/src/entities/Model.test.ts"
it('parse∘format is the identity for any provider and any model id', () => {
  fc.assert(
    fc.property(Arbitrary.make(Provider), fc.string(), (provider, modelId) => {
      expect(parseModel(formatModel(provider, modelId))).toEqual({ provider, modelId }) // [!code highlight]
    }),
    { numRuns: 200 },
  )
})

it('format∘parse is stable on arbitrary raw strings (inference is idempotent)', () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.fullUnicodeString()), (raw) => {
      const a = parseModel(raw)
      expect(parseModel(formatModel(a.provider, a.modelId))).toEqual(a)
    }),
  )
})
```

Two laws, and `provider:model` strings are a closed subject — including model IDs that themselves contain colons, which the generator produced immediately and which forced the "split on the *first* colon" behavior into being a tested decision instead of an accident.

But examples didn't disappear from these files, and the line between the two is instructive. `extractUsage` — the function that normalizes token counts across providers — keeps a battery of plain example tests, because its hard cases are *semantic*: Anthropic reports `input_tokens` excluding cache reads and writes while Gemini and OpenAI include them, so the Anthropic branch must fold cache numbers back in or the context gauge reads near-zero on a fully-cached turn. "10 input + 100 cache-read + 50 cache-write = 160" is not a law over arbitrary inputs; it's a fact about one provider's billing semantics, and a hand-written example with those exact numbers is the clearest possible statement of it. Properties answer "does this hold for everything"; examples answer "is this specific, meaningful case handled the way the provider's docs say".

And one level above both sits the question neither can touch: "given this prompt, does the agent read the file before editing it?" That's behavior with meaning, judged on real model output — the eval suite's territory, and a post of its own. The stack has three floors: properties for algebra, examples for semantics, evals for behavior. Confusing the floors is how you end up asserting string-contains on an LLM transcript and calling it a unit test.

## What it costs

Property tests are not free confidence, and the failure modes are worth knowing before the first one bites.

**Underconstrained generators produce flaky-looking failures.** Run 312 fails, run 313 passes, and your CI looks haunted — when actually the generator's domain is wider than the function's, and run 312 happened to sample the gap. fast-check prints the seed and shrunken counterexample, so it's deterministic once caught, but the *judgment call* is yours: is the input the generator found one the function must handle, or one that can't occur? [efferent](https://github.com/xandreeddev/efferent)'s suite hit exactly this on `extractUsage`'s totality property, and the resolution is in the repo, comment and all:

```ts title="packages/sdk-core/src/usecases/promptMapping.test.ts"
// Content elements are filtered non-nullish: the helpers read `p.type` on
// each element, which throws on null/undefined — real @effect/ai response
// content never contains nullish elements, so the generator excludes them
// rather than masking a non-bug. // [!code highlight]
const contentArb = fc.array(
  fc.anything().filter((v) => v !== null && v !== undefined),
  { maxLength: 6 },
)
```

The generator found that a `null` inside the content array throws. True — and irrelevant, because the upstream library never produces one. The wrong responses are to "fix" the function with a defensive check it doesn't need, or to silently shrink the generator and move on. The right response is what's there: constrain the generator *and write down why*, so the constraint is a reviewable claim about the input domain instead of a buried fudge. Every `.filter` on an arbitrary is an assertion about the world; undocumented, it's a place for bugs to hide.

**Time budgets are real.** Each property here runs 100–300 times; a file with eight properties is a couple thousand function executions per test run. For pure functions that's milliseconds and nobody cares. The trap is property-testing through anything slow — real IO, real crypto rounds, a real database — where 300 runs quietly turns the fast suite into the slow one. Properties belong on the pure core; in an Effect codebase the layer system already pushed IO behind service interfaces, so the pure core is most of `packages/sdk-core` — which is not a coincidence so much as compound interest on the architecture.

**The invariant discipline is the actual price.** The standing temptation in every property test is to compute the expected output the same way the function does — at which point you've written `expect(f(x)).toEqual(f(x))`, an expensive tautology. Real invariants come from asking what must be true *without* re-deriving the answer: lengths match, nothing invented, nothing lost, applying twice equals applying once, the counts in the summary add up to the input's ground truth. Sometimes honesty costs a constant: the search-compression budget property allows a stated slack, because the planner deliberately admits the first file block even when it overflows the budget — and the test says so in a comment instead of pretending the bound is tight. A property test is a small formal spec, and writing a spec that isn't the implementation in disguise is a skill. The first week, it's slower than examples. Then the schema-derived generators delete the factory-maintenance work, the specs start catching real edges before the model does, and the trade goes permanently positive.

## The fuzzer you don't pay per token

Here's the frame I've landed on for agent codebases specifically. Every seam in an agent — message mapping, tool-argument decoding, output parsing, context compression — has an LLM on one side of it. That means the inputs to your most delicate code are drawn from a distribution you don't control, can't enumerate, and that shifts every time a provider ships a model update. You are being fuzzed in production whether you like it or not; the only choice is whether you also get fuzzed in CI, where the counterexamples arrive shrunk, seeded, and free.

So the playbook is short. Define data as schemas, because you need the validation anyway. Derive the generators with `Arbitrary.make`, because they're sitting inside the definition you already wrote. State the laws — round-trips, presence rules, lossless splits, honest arithmetic — and let fast-check spend a few thousand executions a day trying to break them. Keep examples for provider semantics, and keep evals for meaning. The model will still find the fourth shape. The difference is that now, so will you — first, in milliseconds, with the failing case reduced to two elements and a seed to replay it.
