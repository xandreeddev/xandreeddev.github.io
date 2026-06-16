---
title: 'Your eval has no database; the trace is the dataset'
description: "Once the agent loop is fully traced, evals need no separate store — the runner discards its own return value and rebuilds the scorecard by reading the span tree. Tokens, steps, and cost come from the same trace the dashboards do."
pubDate: 2026-07-29
tags: [evals, effect, observability]
series:
  name: 'Observing an agent'
  order: 3
draft: true
---

A while back I wrote that [evals are unit tests for behavior and belong in the repo](/posts/colocated-evals/) — cases, tasks, and scorers as Effect programs, the real agent run against each case in a disposable world. That post built the framework. This one is about a change the framework made since, the kind that's invisible in a feature list and reorganizes how you think about the system: the eval runner became **trace-first**. It no longer keeps its own record of what happened. It runs the agent, lets the agent emit the same trace it emits in production, and then *reads the trace back* to build its scorecard.

That sounds like a plumbing detail. It's the opposite of a plumbing detail. It's the moment two things I'd been building as separate projects — the observability from the first two posts in this series, and the eval harness — turned out to be one thing wearing two hats.

## The double-bookkeeping you don't notice you're doing

Start with the eval setup almost everyone builds first, because it's the obvious one. The harness runs a case, and as it runs it *records*: it counts the steps the agent took, sums the tokens each model call reported, totals the cost, times the wall clock, collects the scorer outputs — and writes all of that to its own store, a SQLite file or a results table or a dashboard the eval tool ships with. Meanwhile, if the agent is instrumented at all (and after the previous two posts, efferent's is, densely), it's *also* emitting that exact information as spans and metrics: `agent.turn` spans you could count, `gen_ai.usage.*` attributes you could sum, a `gen_ai.cost_usd` derived from the pricing table.

So you have two sources of truth for "how many tokens did this case use." One is what the eval harness tallied; one is what the trace recorded. They're computed by different code, and the day they disagree — a retry the harness double-counted, a sub-agent call the trace caught and the harness didn't — you won't know which to believe. You've built a parallel measurement system next to a measurement system you already had.

The trace-first move deletes one of them. The agent is already the authority on what it did; it says so in spans. The eval's job isn't to *re-measure* the run — it's to *score* it. So let the agent emit its trace exactly as it does in production, and have the eval read that trace for everything except the scores. The dataset the eval analyzes isn't a database the harness fills. It's the span tree the run already produced.

## The runner annotates the trace; it doesn't keep books

Here's the runner for one case. The framework hasn't changed shape from the [original post](/posts/colocated-evals/) — the task and every scorer still go through `Effect.exit` so a 429 or a thrown judge becomes a captured 0 instead of a dead suite. What's new is that the whole thing runs *inside spans*, and the scores are written *onto* the case span as attributes:

```ts title="packages/evals/src/framework/runEval.ts"
const runCase = <I, O, T, R>(spec: EvalSpec<I, O, T, R>, kase: EvalCase<I, T>) =>
  Effect.gen(function* () {
    const taskExit = yield* spec
      .task(kase.input, kase)
      .pipe(Effect.withSpan('eval.task'), Effect.exit) // the REAL agent runs here // [!code highlight]

    if (Exit.isFailure(taskExit)) {
      yield* Effect.annotateCurrentSpan({ 'eval.ok': false })
      return { name: kase.name, ok: false, error: Cause.pretty(taskExit.cause), scores: [], mean: 0 }
    }

    const output = taskExit.value
    const scores: Array<ScoreOutcome> = []
    for (const scorer of spec.scorers) {
      const scoreExit = yield* scorer
        .score({ input: kase.input, output, expected: kase.expected })
        .pipe(Effect.withSpan(`eval.scorer:${scorer.name}`), Effect.exit)
      scores.push(/* the score, or 0 on a scorer crash */)
    }

    const mean = average(scores.map((s) => s.score))
    // The scores go ONTO the span — eval.mean + eval.score.<name> — so the
    // trace carries everything a reader needs. This is the data channel.
    yield* Effect.annotateCurrentSpan({ 'eval.ok': true, 'eval.mean': mean, ...scoreAttrs(scores) }) // [!code highlight]
    return { name: kase.name, ok: true, scores, mean }
  }).pipe(
    Effect.withSpan('eval.case', { attributes: { 'eval.suite': spec.name, 'eval.case': kase.name } }),
  )
```

Look at what `spec.task(kase.input)` is. In the whole-task suite it's `runCoder(...)` — the *real* coder agent, built by the same functions the CLI uses, run over a throwaway workspace:

```ts title="packages/evals/src/suites/wholeTask.eval.ts"
task: (input) =>
  runCoder(input.files, input.prompt, { readback: input.readback }),
```

That call runs the agent loop from the second post — which opens `agent.run`, `agent.turn`, `llm.generate`, and `agent.tool` spans, all carrying `agent.kind` and `gen_ai.usage.*`, exactly as it does in a real session. The eval doesn't instrument the run. The run instruments itself, the way it always does. The `eval.case` span just becomes the parent of that whole subtree — and the scores get annotated onto it. The trace now holds the complete picture of the case: the agent's behavior (its own spans) *and* the judgment (the `eval.score.*` attributes), in one tree.

## Reading the tree back

Now the part that does the work. `processSpans` takes the finished spans and reconstructs the scorecard — and the only thing it knows how to do is walk a span tree and read attributes. For each `eval.case` span it pulls the scores off the span itself, then walks the subtree for everything else:

```ts title="packages/evals/src/trace/process.ts"
const subtree = descendants(s) // every span beneath this eval.case
let input = 0, output = 0, cacheRead = 0, steps = 0
let cost: number | undefined

for (const d of subtree) {
  // Match on the stable `agent.kind` attribute, not the (renamable) span
  // name — the same identity the Grafana dashboards filter on.
  const kind = strAttr(d.attributes, 'agent.kind') // [!code highlight]
  if (kind === 'turn') steps++
  if (kind === 'llm') {
    const c = llmContribution(d) // reads gen_ai.usage.* + prices via costUsd
    input += c.input
    output += c.output
    cacheRead += c.cacheRead
    if (c.cost !== undefined) cost = (cost ?? 0) + c.cost
  }
}
```

That highlighted line is the whole series clicking shut. **Steps are the count of `agent.kind === "turn"` descendants. Tokens are the sum over `agent.kind === "llm"` descendants' `gen_ai.usage.*`. Cost runs those tokens through the same `costUsd` table the production metrics use** — so a session and an eval price a model identically, by construction, because it's literally the same function. And every one of those reads is by the *stable attribute*, not the span name. The rename-proofing from the second post wasn't only protecting dashboards; it was protecting this. The commit that switched eval collection from matching span names to matching `agent.kind` fixed the dashboards and the eval reader in one move, because they are clients of the same taxonomy. Two readers, one contract.

`llmContribution` is the small honest core of it — it reads the GenAI attributes the router already wrote and reuses core's pricing:

```ts title="packages/evals/src/trace/process.ts"
const llmContribution = (s: ReadableSpan) => {
  const a = s.attributes
  const input = numAttr(a, 'gen_ai.usage.input_tokens') ?? 0
  const output = numAttr(a, 'gen_ai.usage.output_tokens') ?? 0
  const cacheRead = numAttr(a, 'gen_ai.usage.cache_read_tokens') ?? 0
  const provider = strAttr(a, 'gen_ai.system')
  const model = strAttr(a, 'gen_ai.request.model')
  const cost = provider && model
    ? costUsd(`${provider}:${model}`, { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead })
    : undefined
  return { input, output, cacheRead, ...(cost !== undefined ? { cost } : {}) }
}
```

And because `processSpans` is *pure* — `ReadableSpan[]` in, aggregates out, no LLM, no Docker, no clock — it's unit-tested with synthetic spans: hand-build a little tree of fake spans with the right attributes, assert the tokens sum correctly. The thing that reads the data is testable without producing any.

## The runner throws away its own answer

Here's the detail that made me certain this was the right shape, the one that would look like a bug to anyone who hadn't internalized the move. `runCase` returns a perfectly good `CaseResult` with the scores in it. `runEval` collects those into a perfectly good `EvalReport`. And the driver **discards all of it** and reads the spans instead:

```ts title="packages/evals/src/run.ts"
// Run every selected suite under the eval.run span — and drop the returned
// reports on the floor.
yield* Effect.forEach(selected, (s) => runEval(s), { discard: true }) // [!code highlight]

// The scorecard is built from the COLLECTED SPANS — the single data path.
const spans = collector.getSpans()
const runs = processSpans(spans)
console.log(json ? JSON.stringify(runs, null, 2) : renderRuns(runs))
```

`{ discard: true }` — the report objects the runner so carefully assembled are thrown away. They were never the product; annotating the spans was. The one true data path is span → `processSpans` → scorecard, so there's exactly one place the numbers come from, and it's the same place the dashboards get theirs. If the eval and the dashboard ever disagree about a case's token count, it's a bug in one reader, not a disagreement between two datasets — because there's one dataset.

The scorecard that comes out the other end reads like the original post's, because the format didn't change, only its source did:

```
━━ config: default ━━

▌ whole-task  mean 0.78 · pass 80% · 5 cases
  ✓ bug-fix             mean 1.00  expectations_met=1.00 coverage=1.00 correctness=1.00   3 steps · 2.1k→0.4k tok · $0.0142 · 38.1s
  ~ multi-file-feature  mean 0.50  expectations_met=0.00 coverage=0.50 correctness=1.00   6 steps · 5.8k→1.1k tok · $0.0391 · 71.0s
```

Every dimmed number on the right of those case lines — steps, tokens, cost, wall time — was read out of the trace, not tracked by the harness. `3 steps` is three `agent.kind="turn"` spans. `$0.0142` is the `gen_ai.usage.*` of the `llm` spans run through `costUsd`. The harness counted none of it.

## Same spans, two backends, one layer

The first post promised this and here it is. The eval collector is a *different telemetry layer* than production's OTLP exporter — but it's pointed at the same instrumentation:

```ts title="packages/evals/src/telemetry/collect.ts"
export const makeCollector = (otlpEndpoint?: string, runId?: string): Collector => {
  const exporter = new InMemorySpanExporter() // ALWAYS on — the runner reads this
  const processors = [new SimpleSpanProcessor(exporter)]
  const metricReaders = []
  if (otlpEndpoint) {
    // ALSO export to Grafana, so the same run lights up the dashboards
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` })))
    metricReaders.push(new PeriodicExportingMetricReader({ /* … */ }))
  }
  const layer = NodeSdk.layer(() => ({
    // a SEPARATE resource keeps eval data disjoint from a real session's
    resource: {
      serviceName: 'efferent-evals', // → Prometheus `job`, queryable in Tempo
      attributes: { 'deployment.environment': 'eval', ...(runId ? { 'eval.run_id': runId } : {}) },
    },
    spanProcessor: processors,
    ...(metricReaders.length ? { metricReader: metricReaders } : {}),
  }))
  return { layer, getSpans: () => exporter.getFinishedSpans() }
}
```

The in-memory exporter is always there — which is why `bun run eval` works on a laptop with no Docker, no Grafana, nothing: the spans finish in memory, `getSpans()` hands them to `processSpans`, you get your scorecard. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and the *same run* also streams to Grafana, under `service.name = "efferent-evals"` so it never pollutes production's `efferent`, with an `eval.run_id` resource attribute so the eval dashboard can scope its case list to one invocation. Offline scorecard and live dashboard from one run, the only difference being which sinks the layer wired up. That's the first post's thesis — *the core describes what's observable, the edge decides who observes* — paid back in full: the edge here decided "in-memory, and maybe also Grafana," and the agent didn't notice.

## Cost is recorded, not scored — and that's why the trace matters

One design choice falls out of having cost in the trace rather than in the score. The whole-task suite scores *correctness* — file checks and an LLM judge — and deliberately does **not** fold tokens or cost into the mean. A cheaper model that gets the job done shouldn't lose to a pricier one on a correctness number. So cost lives on the trace as data, and the place you *weigh* it is the comparison view: run two configs (`--config` pins model, prompt variant, step cap), and the runner diffs them suite by suite, because each config's run sits under its own `eval.run` span and `processSpans` walks ancestors to find which one a case belongs to:

```ts title="packages/evals/src/trace/report.ts (comparison, abridged)"
//   sonnet-vs-haiku:
//     whole-task   mean 0.81 (+0.07) · tok 41.2k (-12.3k) · cost $0.21 (-0.34)
```

"Haiku scores 0.07 lower but costs a third as much" is a sentence you can only write if correctness and cost are *separate* numbers read from the *same* run. Bury cost inside the score and you can't make the trade; keep it on the trace and the trade is right there. The eval.run span carrying `config.name` is the join that makes a config matrix a diff instead of two unrelated reports.

## What it costs

**The eval is exactly as honest as the trace.** This is the real price of the move. If a model call happens on a code path that *doesn't* open an `llm` span — a helper tier someone forgot to instrument, a provider call outside the router — its tokens are simply absent from the case total, silently, and the scorecard underreports cost with total confidence. Before, the dataset was the harness's own bookkeeping; now it's the trace, which means *gaps in instrumentation are gaps in eval data*. The second post's "the attribute is an API" stops being a dashboards concern and becomes a correctness concern: a span missing `agent.kind` doesn't just drop off a graph, it drops out of the numbers you're making decisions on.

**The numbers still wobble, and now the wobble is in the trace too.** Everything the [original evals post](/posts/colocated-evals/) said about a stochastic system under test still holds — means and thresholds, not exact assertions, because the same case scores 0.78 and then 0.71. Trace-first doesn't fix that; it just means the noisy run is the run you also see in Grafana. The trace is a faithful record of one sample, not a stable truth.

**Everything is in memory for the run.** `InMemorySpanExporter` holds every span the run produced until `processSpans` reads them. For a handful of suites and a few dozen cases that's nothing; if you ever fanned this out to thousands of cases you'd want to flush and aggregate incrementally rather than holding the whole forest. The current scale doesn't need it, and pretending it does would be the premature kind of engineering this project keeps trying not to do.

## One substrate, three readers

Step back and the arc of this series is a single substrate read three ways. The agent loop emits a trace. A human reads it in the waterfall at 2 a.m. to find the turn that hung. A dashboard reads it by stable attribute to graph p95 latency and cost across every run. And the eval reads it — the *same* spans, by the *same* attributes — to score a case and price a model. Three readers, one dataset, no copies.

That's why "we improved the observability" and "we improved the evals" turned out to be the same sentence. I thought I was building a telemetry stack and, separately, an eval harness. What I'd actually built was one source of truth about what the agent does — a span tree carrying behavior, timings, tokens, and cost — and then pointed three different readers at it. The eval doesn't have a pipeline. It has a *reader*, aimed at the trace I already had for entirely different reasons.

The general version, for any system with an LLM in the loop: if you've done the work to make your agent observable — real spans, stable attributes, a standard dialect for the model calls — you are most of the way to an eval harness and you don't know it yet. The hard part was never tallying tokens or counting steps. The hard part was making the run *legible*, and once a run is legible to a dashboard, it's legible to a scorer. Don't build the eval its own memory. Let it read the one the agent already keeps.
