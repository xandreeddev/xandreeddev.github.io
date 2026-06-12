---
title: 'AI applications are Effect-shaped'
description: 'Flaky IO, string boundaries, provider churn, fan-out, cancellation that stops billing — the defining problems of LLM apps are the ones effect systems were built for.'
pubDate: 2026-06-12
tags: [effect, ai]
draft: true
---

Strip any LLM application to its load-bearing properties and you get a list: every important call is slow, expensive, rate-limited, and nondeterministic. Every output is a string that must become structure. The vendor you build on today will be the fallback you route around next quarter. Parallelism is the difference between a usable product and a demo, and *cancelling* work isn't hygiene — it's money.

Read that list again as a requirements document. It's not asking for a framework. It's asking for typed failures, declarative retries, schema-driven decoding, swappable dependencies, bounded concurrency, and real cancellation — which is to say, it's asking for an effect system. The thesis of this post: **AI didn't create new engineering problems; it took the problems effect systems were built for and made them the whole application.**

I'll make the case property by property. Sketches are generic; where a claim needs a production receipt, it points at [efferent](https://github.com/xandreeddev/agent), the coding agent I build in the open on exactly this stack.

## Failure is the common case, so it has to be typed

A web app's database call fails rarely enough that `try/catch` feels acceptable. A model call fails *routinely* — 429s under load, timeouts on long generations, overloaded errors at peak, content filters, and the special category of "succeeded, but the output is garbage." When failure is this frequent and this *varied*, two things stop scaling: treating all failures alike, and keeping their handling invisible to the types.

Effect's error channel makes the variety first-class:

```ts
type ModelError = RateLimited | Overloaded | ContextTooLong | SafetyRefusal | MalformedOutput

const complete: (prompt: string) => Effect.Effect<Completion, ModelError>
```

That union isn't documentation — the compiler tracks it, and each variant gets the policy it deserves, by name:

```ts
const robust = complete(prompt).pipe(
  Effect.retry({
    schedule: Schedule.exponential('200 millis').pipe(Schedule.jittered),
    while: (e) => e._tag === 'RateLimited' || e._tag === 'Overloaded', // [!code highlight]
  }),
  Effect.catchTag('ContextTooLong', () => complete(compress(prompt))), // recoverable, differently
  Effect.timeout('60 seconds'),
)
```

Read the highlighted line: retry exactly the transient failures. A `SafetyRefusal` retried with backoff is a slow refusal; a `ContextTooLong` retried verbatim is a paid-for guarantee of the same error. Promise-world code can implement this — with a hand-rolled loop, an error-classification helper, and string matching on messages. The difference is that here the *policy is a value*, the classification is a type, and forgetting a case is visible in the signature. In an app where the unhappy path runs hourly, that's not elegance. It's the difference between operating the system and being operated by it.

## The string boundary

Every LLM boundary has the same shape: structured world in, *string* out, structured world needed again. Tool arguments, JSON-mode replies, judge verdicts, extracted entities — all of it arrives as text that claims to be data. The naive seam is `JSON.parse` plus a cast plus hope; the failure modes are exceptions in production and silent shape-drift everywhere else.

Schema makes the boundary a declaration:

```ts
const Verdict = Schema.parseJson(
  Schema.Struct({
    label: Schema.Literal('approve', 'reject', 'escalate'),
    confidence: Schema.Number,
    reason: Schema.String,
  }),
)

const verdict = yield* Schema.decodeUnknown(Verdict)(reply.text)
// typed on success; a *value-level* failure on garbage — same channel as every other error
```

One declaration is simultaneously the TypeScript type, the runtime validator, the precise this-field-disagreed error, and — the part specific to AI — **the JSON Schema the provider receives**. Tool definitions in `@effect/ai` derive the wire format from the same `Schema` that validates the call when it comes back; there is no second copy to drift. A model that replies with prose, a hallucinated enum value, or a string where a number belongs produces a typed decode failure your retry policy can act on — *feed the error back, ask again* — instead of an exception your process eats at 3 a.m.

## Provider churn is the climate, not the weather

Three frontier vendors ship breaking model improvements quarterly; pricing changes overnight; the model you'd pick today didn't exist when you started the repo. Architecture that hard-binds to a provider SDK converts every one of those events into a refactor. The effect-system answer is the oldest trick in the book — the dependency is a *service*, the SDK lives behind it:

```ts
class LanguageModel extends Context.Tag('LanguageModel')<LanguageModel, {
  readonly generate: (p: Prompt) => Effect.Effect<Completion, ModelError>
}>() {}
```

Everything interesting follows from the tag. Implementations are layers, so provider choice is wiring, not plumbing through forty call sites. Tests provide a scripted model and run the *real* application logic against canned replies — no mocking framework, no HTTP interception. Evals provide the live model and swap the side-effecting services instead. And because `@effect/ai` ships this tag as a shared vocabulary, the ecosystem's adapters all speak it — in [efferent](https://github.com/xandreeddev/agent) the live layer is a router that re-resolves the provider on every call, which is how a `:model` switch mid-session applies to the very next message. The modularity isn't an architecture you maintain; it's what services-as-values *do*.

## Concurrency you can put a number on

AI workloads fan out constantly — embed five hundred chunks, judge twenty outputs, run three sub-tasks — against vendors who rate-limit you for enthusiasm. So the requirement is never just "parallel"; it's "parallel, *bounded*, and one failure shouldn't strand the other in-flight calls." That sentence is a day of Promise-pool code, or:

```ts
const judged = yield* Effect.forEach(outputs, judge, { concurrency: 8 })
```

Bounded fan-out is an option you pass. Under it sit fibers — structured, cheap, and above all **interruptible**, which lands differently in AI than anywhere else: interruption isn't tidiness, it's *billing*. A user who hits Esc mid-generation, a race where the fallback provider answered first, a timeout cutting a runaway agent turn — in each case Effect's interruption propagates through the whole tree of in-flight work, aborts the underlying HTTP requests, and runs every cleanup on the way down. Tokens stop being emitted because the connection is gone. The same property makes the riskier patterns safe to even attempt: racing two providers for latency (`Effect.race` interrupts the loser — you pay one bill, not two), hedged requests, speculative tool execution. Without real cancellation, those patterns are budget leaks; with it, they're one-liners.

Streaming gets the same treatment — a token stream is a `Stream`, typed and interruptible, so backpressure and early termination compose instead of being hand-rolled per provider.

## Composition is the actual killer feature

Each property above has a point solution somewhere in npm — a retry library, zod for parsing, a rate-limiter package, an abort-controller discipline. The reason I'd still pick Effect is that in an AI app these concerns *stack on the same call*: one model request wants typed failure classification AND schema-decoded output AND a retry policy AND a timeout AND bounded parallelism with its siblings AND interruption from above AND its dependencies injected for testing. Point solutions each solve one layer and fight at the seams — the retry library doesn't know about the abort signal; the parser throws past the rate limiter. In Effect, every one of those is the same kind of value composing with the rest:

```ts
const pipeline = Effect.forEach(documents, (doc) =>
  extract(doc).pipe(                       // service-injected, schema-decoded
    Effect.retry(transientOnly),           // policy as a value
    Effect.timeout('30 seconds'),
  ),
  { concurrency: 8 },                      // bounded fan-out
).pipe(Effect.withSpan('extract-batch'))   // traced, interruptible, testable
```

That's the whole argument in seven lines: nothing in it is a framework feature built "for AI" — it's general-purpose composition that the AI workload happens to need *all of, at once, on every call*.

## And the agent era doubles it

One more property, specific to this moment: most new code is now written with coding agents in the loop, and the same machinery that makes Effect good to *run* AI makes it good to be *written by* AI. Typed error channels mean a generated function can't silently swallow failures; the `R` channel makes a generated change's new dependencies visible in its signature; greppable, compiler-enforced rules survive a contributor that never reads the style guide. An agent iterating against `tsc` converges on coherent programs before a human reviews them. [efferent](https://github.com/xandreeddev/agent) is the existence proof I can offer — an agent built *on* Effect, largely *by* agents, where the architecture's rules held because the compiler enforced them.

## Where the argument doesn't apply

Honesty section. A cron job that sends one prompt and writes the reply to a file does not need an effect system — `fetch`, `try/catch`, ship it. The argument above is load-bearing only when the AI calls are *the application*: many call sites, real concurrency, real money, more than one provider over the product's life. Below that threshold, Effect's learning curve buys you ceremony; above it, the curve amortizes over every incident you don't have. And the curve is real — fiber stack traces, a large vocabulary, a hiring pool that mostly hasn't seen it. I'd rather onboard someone to `yield*` than onboard them to our bespoke retry loop, but that's a judgment call, and it's only obvious after the third 2 a.m. rate-limit incident.

The shape of the bet, though, I'll state plainly: LLM calls are the most failure-prone, most expensive, most cancellation-sensitive IO most of us have ever built products on. Betting that the workload *least* tolerant of invisible failures should be built with the tools that make failures visible — that's not even a brave bet. It's reading the requirements document and answering it.
