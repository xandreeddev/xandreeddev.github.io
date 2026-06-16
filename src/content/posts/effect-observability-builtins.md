---
title: 'Observability is built in; where it goes is a layer'
description: 'Spans, metrics, and logs are Effect built-ins, not a vendor SDK you thread through your code — and one layer at the edge decides the backend, so telemetry-off costs nothing.'
pubDate: 2026-07-24
tags: [effect, typescript, observability]
series:
  name: 'Observing an agent'
  order: 1
draft: true
---

Here's the question that started this. A single agent run cost me $2.14 and took fifty seconds, and I wanted to know where the seconds and the cents went — which turn, which model call, which tool. The usual way to answer that is to *bolt on* observability: install a vendor's OpenTelemetry SDK, build a tracer, reach for it (or an ambient global) at every call site you care about, wrap the interesting ones in `tracer.startActiveSpan(…)`, and remember to `.end()` each one on every exit path — including the one where it threw. Then you carry that machinery, and its cost, whether or not anyone is looking.

In an Effect program you don't do any of that, and the reason is the point of this post. Tracing, metrics, and logs aren't a library you add. They're built into the runtime the same way typed errors and structured concurrency are. **You don't instrument an Effect program — you describe what's worth observing as ordinary values, and a layer at the edge decides whether, and where, anyone records them.** Telemetry-off costs nothing, and "nothing" here is a claim the runtime keeps, not a thing you hope is true.

Everything below is real code from [efferent](https://github.com/xandreeddev/agent), the coding agent I'm building on Effect. The agent is the receipt; the subject is the three built-ins and the one layer.

One paragraph of Effect for readers who haven't met it. An `Effect<A, E, R>` is a *description* of a program — inert until run — that succeeds with an `A`, can fail with a typed `E`, and needs the services in `R` to execute. A **`Layer`** is a recipe that builds those services, supplied once at the program's edge, which is what makes swapping an implementation (real exporter, in-memory exporter, *no* exporter) a one-line change at one location. Hold onto that last clause — it's the whole argument.

## The first built-in: a span is a combinator, not an object

A span is the unit of a trace — a named, timed interval with attributes, nested under whatever span was open when it started. In the SDK world a span is an object you create, hold, and end. In Effect it's a *combinator* you wrap around a description:

```ts title="packages/core/src/usecases/runAgent.ts"
runAgentLoop({ system, messages, toolkit, maxSteps }).pipe(
  Effect.withSpan('agent.run', {
    attributes: {
      'agent.kind': 'run',
      'agent.conversation_id': conversationId,
      'agent.model': settings.model,
      'agent.prompt': userPrompt.slice(0, 120),
    },
  }),
)
```

`Effect.withSpan` takes a description and returns a *new* description that, when run, opens the span, runs the inner effect, and closes the span — on success, on failure, and on interruption, because the span's lifetime is the effect's lifetime and the runtime owns both. There is no `.end()` to forget. Cancel the run halfway through and its span closes with the cancellation; the `finally` you'd have to write by hand is structural.

Two things follow that don't in the SDK model. First, **the span context is ambient**, carried on the fiber, not passed as an argument. A function thirty calls deep can open a child span without anyone threading a tracer down to it — and the child nests under the parent automatically because "the current span" is fiber state, not a variable you plumbed. Second, you can reach the active span and annotate it mid-effect, which is how a run's totals land on the run span *after* the loop that computed them has finished:

```ts title="packages/core/src/usecases/agentLoop.ts"
// The turn spans have closed, so the current span is the enclosing run.
yield* Effect.annotateCurrentSpan({
  'agent.turns': turnIndex,
  'agent.total_input_tokens': totalIn,
  'agent.total_output_tokens': totalOut,
  'agent.total_cache_read_tokens': totalCache,
})
```

`annotateCurrentSpan` is a write to whatever span is currently open on the fiber. No handle, no global lookup — the runtime knows which span is current because it's been carrying it the whole time. Which spans an *agent* should open, and what to put on them, is its own subject — a post of its own, the next part of this series. This post is about the fact that opening one is free of ceremony.

## The second built-in: a metric is a value you define once and record into

Metrics are counters, gauges, and histograms — the numbers a dashboard graphs over time. Effect's `Metric` is a first-class value: you *define* it once as a module-level constant, and *record* into it at the chokepoints, and it is completely inert until something at the edge wires up a meter. Here's the agent's metric set, abridged:

```ts title="packages/core/src/telemetry/metrics.ts"
const tokensTotal = Metric.counter('gen_ai_tokens_total', {
  description: 'LLM tokens billed (tags: role, model, type=input|output|cache).',
  incremental: true,
})

const callsTotal = Metric.counter('gen_ai_calls_total', {
  description: 'LLM generate calls (tags: role, provider, model).',
  incremental: true,
})

const turnLatencyMs = Metric.histogram(
  'agent_turn_latency_ms',
  MetricBoundaries.exponential({ start: 50, factor: 2, count: 12 }),
  'Agent-loop turn wall time (ms).',
)
```

A `Metric.counter` is not a registered handle on some global meter — it's a description, like everything else. Recording into it produces an `Effect<void>` that does nothing observable unless a meter is present in the runtime. So production code only ever *records*; **where the numbers go is a layer choice**, decided at the edge, exactly like spans.

Recording is where the one real discipline of metrics lives: **tags**. A tag is a dimension you can later group by — `role`, `provider`, `model`. Tags multiply: every distinct combination of tag values is a separate time series your backend must store. Tag a counter with something unbounded — a request id, a full error message, a user prompt — and you've built a cardinality bomb that takes the metrics backend down with it. Effect makes tagging composable (`Metric.tagged` returns a new tagged metric), which means the cardinality of a metric is *visible at the record site*, in code you can review:

```ts title="packages/core/src/telemetry/metrics.ts"
export const recordLlmCall = (
  role: string,
  provider: string,
  model: string,
  usage: TokenUsage,
): Effect.Effect<void> =>
  Effect.all(
    [
      Metric.update(
        callsTotal.pipe(
          Metric.tagged('role', role),
          Metric.tagged('provider', provider),
          Metric.tagged('model', model),
        ),
        1,
      ),
      Metric.update(
        tokensTotal.pipe(
          Metric.tagged('role', role),
          Metric.tagged('model', model),
          Metric.tagged('type', 'input'), // [!code highlight]
        ),
        usage.inputTokens,
      ),
      // … output and cache buckets, same shape
    ],
    { discard: true },
  )
```

`role`, `provider`, `model`, and the literal `'input'`/`'output'`/`'cache'` are all small closed sets — the product stays in the dozens of series, not the millions. The error metric makes the discipline explicit, because errors are where the temptation to tag a raw message is strongest:

```ts title="packages/core/src/telemetry/metrics.ts"
/** A `_tag` / slug is a short identifier; anything wordy is a free-text
 *  message we must NOT use as a metric label (cardinality bomb). */
const clipErr = (error: string): string => {
  const e = error.trim()
  if (e.length === 0) return 'unknown'
  if (e.length > 48 || /\s/.test(e)) return 'unknown' // [!code highlight]
  return e
}

export const recordError = (kind: string, error: string): Effect.Effect<void> =>
  Metric.update(
    errorsTotal.pipe(Metric.tagged('kind', kind), Metric.tagged('error', clipErr(error))),
    1,
  )
```

A typed error's `_tag` — `RateLimit`, `ContextTooLong` — is a fine label: short, bounded, exactly the set you'd group by. A provider's free-text message ("Request failed: model is overloaded, please retry after 3000ms…") is not, and the guard collapses anything with a space or over 48 characters to `'unknown'`. That's not paranoia; it's the difference between a counter and an outage.

## The third built-in: logs are structured, and they ride the trace

Effect's logger is built in too — `Effect.logInfo`, `logWarning`, `logError` — and two features make logs first-class telemetry rather than `console.log` with extra steps. The first is **annotations**: `Effect.annotateLogs` attaches key–value pairs to *every* log emitted within its scope, inherited down the whole fiber tree. The agent stamps the conversation id once, at the top of a run:

```ts title="packages/core/src/usecases/runAgent.ts"
runAgentLoop({ … }).pipe(
  Effect.withSpan('agent.run', { /* … */ }),
  Effect.annotateLogs({ conversationId }), // [!code highlight]
)
```

Every log line emitted anywhere inside that run — thirty calls deep, inside a tool handler, inside a sub-agent — carries `conversationId` as a structured field, with no parameter threaded anywhere. The second feature is the one that makes observability *cohere*: when a tracer is active, the runtime correlates logs with the span that was open when they were emitted, stamping each line with the `trace_id` and `span_id`. A log written inside a span isn't a separate stream you cross-reference by timestamp and hope — it's *attached* to that span, so a trace viewer can show "the logs that happened during this exact operation." Logs, metrics, and traces stop being three siloed tools and become three views of one fiber's execution.

## The layer: one read decides the backend, and off is a no-op

Here's the payoff the first three sections have been setting up. The instrumented core — the spans, the metric records, the logs — does not name a backend anywhere. It can't, because a `withSpan` or a `Metric.update` is just a description. Something has to provide a tracer and a meter for any of it to leave the process, and that something is a **layer**, supplied once at the composition root.

efferent's exporter is the Effect-native OTLP layer — no heavyweight OpenTelemetry SDK, just an HTTP POST of the serialized spans and metrics:

```ts title="packages/adapters/src/telemetry/otlp.ts"
export const OtlpTelemetryLive: Layer.Layer<never> = Layer.unwrapEffect(
  Effect.gen(function* () {
    const baseUrl = yield* Config.string('OTEL_EXPORTER_OTLP_ENDPOINT').pipe(
      Config.withDefault('http://localhost:4318'),
    )
    const serviceName = yield* Config.string('OTEL_SERVICE_NAME').pipe(
      Config.withDefault('efferent'),
    )
    return Otlp.layerJson({
      baseUrl,
      resource: { serviceName, attributes: { 'deployment.environment': 'production' } },
    })
  }).pipe(Effect.orDie),
).pipe(Layer.provide(FetchHttpClientLive))
```

And here is the entire on/off switch — a single settings read at the edge that picks the exporter layer or the *empty* one:

```ts title="packages/cli/src/main.ts"
const TelemetryLive: Layer.Layer<never> = Layer.unwrapEffect(
  Effect.gen(function* () {
    const settings = yield* (yield* SettingsStore).load(process.cwd(), homedir())
    return settings.telemetry === true ? OtlpTelemetryLive : Layer.empty // [!code highlight]
  }).pipe(Effect.orElseSucceed(() => Layer.empty)),
)

// … and at the very bottom of the program:
program.pipe(Effect.provide(AppLive), Effect.provide(TelemetryLive))
```

`Layer.empty` provides nothing. With no tracer and no meter in the runtime, every `withSpan` runs its inner effect and opens *nothing*; every `Metric.update` is a no-op; every annotated log goes to the default logger and no further. The instrumentation doesn't get *skipped by an `if`* at each call site — there are no `if`s at the call sites. It's the same described program either way; the runtime simply has nowhere to send the data, so it doesn't compute it. That's what "zero overhead when off" means structurally: not a fast path, but an *absent* one.

This is why the env var named in the OTLP layer is `OTEL_EXPORTER_OTLP_ENDPOINT` and not something like `TELEMETRY_ENABLED`. The endpoint controls *where* spans go when telemetry is on; *whether* it's on is one boolean read through the settings service. Where and whether are different decisions, and Effect lets you make the "whether" exactly once, in one place, by choosing a layer.

There's a quiet bonus in the same shape: the eval harness — the last post in this series — provides a *different* telemetry layer (an in-memory span collector instead of an HTTP exporter) and gets the identical instrumentation pointed at a different sink, with zero changes to the agent. The core describes what's observable; the edge decides who observes. Production exports to Grafana; an eval run reads the same spans out of memory to build its scorecard. Same spans, two backends, one layer apart.

## What it costs

The model is clean, but it isn't free, and the bills are worth itemizing before you adopt it.

**You wire the layer, and you wire it correctly.** The convenience of "describe everywhere, decide at the edge" is paid for at that edge: the composition root has to provide the right telemetry layer, and `Layer` errors are the part of Effect with the steepest learning curve. Get the provision order wrong and you'll stare at a type error that names six services. The flip side is that once it compiles, it's *correct* — the tracer can't be half-initialized, can't leak, can't be present in one code path and absent in another.

**Pure recording means deliberate recording.** Because a `Metric.update` does nothing on its own, you don't get metrics by accident — you get exactly the ones you wrote, at exactly the chokepoints you chose. That's mostly a virtue (no mystery series, no auto-instrumentation tax), but it's also work: the seven counters and one histogram in `metrics.ts` are eight decisions someone made about what's worth counting. Auto-instrumentation gives you a hundred metrics you didn't choose; this gives you eight you did. For an agent loop, where the interesting quantities are domain-specific — tokens by role, cost by model, turns to completion — choosing beats guessing. For a generic CRUD service, you might miss the convenience.

**Low cardinality is a standing discipline, not a setting.** Nothing stops you from writing `Metric.tagged('prompt', userPrompt)`. The `clipErr` guard exists because the temptation is real and the failure is delayed — a cardinality bomb looks fine in dev and detonates in production a week later when the unique-value count crosses your backend's limit. The model makes cardinality *visible* in code; it can't make it *safe* for you.

## You describe; the edge decides

Step back and the three built-ins are one idea wearing three hats. A span, a metric, a log are all *values* — descriptions of something worth observing — and none of them names where it goes. The naming happens once, at the composition root, by choosing a layer: the OTLP exporter for a real session, an in-memory collector for an eval, the empty layer for a run nobody's watching. Swap the layer and the same instrumented program lights up a different backend, or none, without a line changing in the code that does the actual work.

That's the inversion. Bolted-on observability makes every instrumented function *know* about the tracer; it threads a dependency through your domain logic and bills you for it on every call. Effect makes the domain logic describe what's interesting and stay ignorant of who's listening — and pushes the entire question of *whether anyone is listening* to a single, reviewable, swappable decision at the edge. The spans don't know where they're going. That's the feature.

The next post takes these three built-ins into the agent loop and asks the operational question: given that opening a span is free, *which* spans, with *which* attributes, make an agent you can actually debug at 2 a.m. — and why the attribute you put on the span matters more than the name you give it.
