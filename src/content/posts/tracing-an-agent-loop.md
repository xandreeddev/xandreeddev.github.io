---
title: 'Name spans for humans, query them by attribute'
description: 'What to trace in an agent loop — and why the stable attribute you put on a span outlives the name you give it, for dashboards and for evals alike.'
pubDate: 2026-07-27
tags: [agents, effect, observability]
series:
  name: 'Observing an agent'
  order: 2
draft: true
---

The first post in this series argued that in Effect, spans, metrics, and logs are built-ins, and opening a span is free of ceremony. This post spends that freedom. Given that you *can* trace anything, the operational question is which spans, carrying which attributes, turn a coding agent from a black box into something you can debug at 2 a.m. when a run cost triple what it should have and you don't know why.

An agent is an unusually good thing to trace and an unusually bad thing to `console.log`. It's a loop: the model proposes tool calls, you run them, you feed the results back, it proposes more, until it stops. One user prompt becomes a tree — turns inside a run, model calls and tool calls inside a turn, sometimes whole sub-agents inside a tool call. The interesting failures are *relational*: this turn was slow because that tool call hung; this run cost $2 because turn four re-read a 40k-line file the model already had. A flat log stream flattens exactly the structure you need. A trace *is* the structure.

So you trace the tree. And the first real decision — the one this whole post turns on — is the difference between what you name a span and what you put *on* it. Everything below is real code from [efferent](https://github.com/xandreeddev/agent), the coding agent I build on Effect.

## The tree, and the names humans read

Here's the shape. A top-level run wraps the loop; each turn wraps one `generateText`; under a turn sit the LLM call and the tool calls it triggered; a tool that spawns a sub-agent nests that sub-agent's whole tree beneath it. The span *names* are written for the one place a human reads them — the trace waterfall — so they carry the identifiers you'd want at a glance:

```ts title="packages/core/src/telemetry/spanNames.ts"
export const runSpanName = (): string => 'agent.run'

export const turnSpanName = (turnIndex: number): string => `agent.turn ${turnIndex}`

export const toolSpanName = (toolName: string): string => `agent.tool.${toolName}`

/** `llm.generate <prompt-label> · <provider>/<model>` */
export const llmSpanName = (prompt, role, provider, model): string => {
  const label = prompt !== undefined ? promptLabel(prompt) : role
  return `llm.generate ${label} · ${provider}/${model}`
}
```

In Grafana's waterfall this reads like a story: `agent.run` over `agent.turn 0` over `llm.generate coder@3 · anthropic/claude-sonnet-4-6` and `agent.tool.read_file`, then `agent.turn 1`, and so on. You can see, by eye, that turn 2 took nine seconds and turn 3 took forty, that the slow one had a `agent.tool.bash` under it, and that the model is `claude-sonnet-4-6`. Good names are a real feature; they're how you read a trace without running a query.

And good names are *exactly the wrong thing to build a dashboard on.*

## The rename trap, and the attribute that survives it

Say you want a panel: p95 turn latency for a conversation. The obvious query matches the span by name — turns are called `agent.turn 0`, `agent.turn 1`, so you write something like `{ name =~ "agent.turn.*" }`. It works. Then three weeks later you rename the span to `agent.step <n>` because "turn" got overloaded in the codebase, or you start appending the finish reason to the name, and every panel that matched `agent.turn.*` silently returns nothing. No error — dashboards don't fail a build. You find out when you go looking during an incident and the graph is empty.

The fix is to stop asking the machine to parse a human-readable string. Put a **stable, low-cardinality attribute** on every span that names its *role* in the trace, decoupled from whatever the span is called this month:

```ts title="packages/core/src/telemetry/spanNames.ts"
/**
 * Stable, rename-proof discriminator for an agent span's role. Span *names*
 * are for humans and change freely; this is the machine identity dashboards
 * and TraceQL filter on, so a name change never breaks a query.
 */
export type AgentSpanKind = 'run' | 'turn' | 'tool' | 'llm' | 'subagent'

export const agentSpanAttributes = (
  kind: AgentSpanKind,
  conversationId: string | null | undefined,
): Record<string, string> => ({
  'agent.kind': kind,
  ...(conversationId != null && conversationId !== ''
    ? { 'agent.conversation_id': conversationId }
    : {}),
})
```

Now every span carries `agent.kind`, and the dashboard queries *that*. The run span is opened with it:

```ts title="packages/core/src/usecases/runAgent.ts"
Effect.withSpan('agent.run', {
  attributes: {
    ...agentSpanAttributes('run', conversationId),
    'agent.model': settings.model,
    'agent.prompt': userPrompt.slice(0, 120),
  },
})
```

and so is every turn, tool, and LLM span. The name `agent.turn 3` is now pure courtesy — rename it to anything, append anything, and `span.agent.kind = "turn"` still selects it. This is a real fix with a real commit behind it: efferent's eval trace-reader and its dashboards both used to match on span names, and a refactor that touched the names broke them in two places at once. The repair was to query the `agent.kind` tag everywhere instead — a single taxonomy that names change can't reach. The lesson generalizes past traces: **the name is a UI; the attribute is an API.** Treat the attribute schema with the seriousness you'd give any other contract, because dashboards, alerts, and (as the next post shows) your evals are all clients of it.

## conversation_id: the join key that flattens the tree

The second stable attribute earns its keep differently. `agent.conversation_id` is stamped on *every* span in a run — run, turn, llm, tool, sub-agent — which means you can ask "show me everything that happened in this conversation" with a flat equality filter, no tree-walking:

```ts title="packages/core/src/usecases/agentLoop.ts"
// On the tool span — the conversation id is ambient on the fiber's RunContext,
// so a tool nested under a sub-agent under a run still gets tagged.
const rc = yield* FiberRef.get(RunContextRef)
yield* Effect.annotateCurrentSpan({
  ...(failed ? { 'agent.tool.ok': false, error: true } : { 'agent.tool.ok': true }),
  ...(rc.rootConversationId !== null
    ? { 'agent.conversation_id': rc.rootConversationId }
    : {}),
})
```

Why this matters in TraceQL specifically: trace query languages make you reach descendants with a structural operator (`>>`), which is both slower and more fragile than an attribute match. With the id on every span, you skip it. The conversation dashboard's panels are all flat equality:

```sql
-- Runs in this conversation, newest first
{ resource.service.name = "efferent" && span.agent.kind = "run"
  && span.agent.conversation_id = "$conversation" }
  | select(span.agent.prompt, span.agent.model)

-- Every tool call in the conversation, ok/failed — no descendant operator
{ resource.service.name = "efferent" && span.agent.kind = "tool"
  && span.agent.conversation_id = "$conversation" }
  | select(span.agent.tool.name, span.agent.tool.ok)

-- p95 turn latency, by the stable kind tag, not the renamable name
{ resource.service.name = "efferent" && span.agent.kind = "turn"
  && span.agent.conversation_id = "$conversation" }
  | quantile_over_time(duration, .95)
```

The id comes from the fiber's ambient `RunContext` (the first post covered how span and log context ride the fiber rather than function arguments) — which is why a tool call buried three sub-agents deep still self-tags with the *root* conversation. You seed the id once, at the top of the run, and it's present on every span anywhere beneath it, forever, without being passed.

## The LLM span speaks a standard dialect

The most attribute-rich span is the model call, and there it pays to not invent your own vocabulary. OpenTelemetry has a published semantic convention for generative-AI calls — the `gen_ai.*` namespace — and using it means generic OTel tooling (and your future self, and anyone who's seen another LLM app's traces) reads your spans without a decoder ring. The router annotates the active `llm.generate` span as the response passes through, untouched:

```ts title="packages/adapters/src/llm/router.ts"
yield* Effect.annotateCurrentSpan({
  ...agentSpanAttributes('llm', rc.rootConversationId),
  'gen_ai.request.model': sel.modelId,
  'gen_ai.system': sel.provider,
  'gen_ai.operation.name': 'generate',
  ...usageAttributes(usage), // gen_ai.usage.input_tokens / output_tokens / cache_read_tokens
  ...costAttribute(sel.provider, sel.modelId, usage), // gen_ai.cost_usd, gen_ai.cache_hit_ratio
  ...content, // gen_ai.prompt / gen_ai.completion — opt-in, see below
})
yield* recordLlmCall('main', sel.provider, sel.modelId, usage)
```

Two of those deserve a note. `gen_ai.cost_usd` is *derived* — the usage runs through the same pricing table the metrics use, so a number on the span and a number on the dashboard can never disagree; and when the model isn't in the pricing catalogue the attribute is simply *absent*, never a wrong number. `gen_ai.cache_hit_ratio` is the fraction of input served from the provider's prompt cache, which is the single most useful number for "why did this run cost what it did" — a run that should be 80% cache-hit and is sitting at 5% is a prompt-prefix bug you can *see*. Both ride along as ordinary attributes on a span you were opening anyway.

## Metrics at the chokepoints: the RED view

Traces answer "what happened in *this* run." Metrics answer "what's happening across *all* runs" — the rate/error/duration view you alert on. The first post covered how Effect metrics are defined and tagged; operationally, the agent records into them at the three places the loop pivots. A turn, timed:

```ts title="packages/core/src/usecases/agentLoop.ts"
const turnStart = yield* Clock.currentTimeMillis
const outcome = yield* LanguageModel.generateText({ prompt, toolkit }).pipe(
  Effect.tap((res) =>
    Effect.annotateCurrentSpan({
      'agent.turn': turnIndex,
      'agent.finish_reason': String(res.finishReason),
      'agent.tool_calls': responseToolCalls(res.content).length,
      ...usageAttributes(extractUsage(res.usage, res.content)),
    }),
  ),
  Effect.withSpan(turnSpanName(turnIndex), {
    attributes: { ...agentSpanAttributes('turn', runContext.rootConversationId), 'agent.turn': turnIndex },
  }),
)
yield* recordTurn((yield* Clock.currentTimeMillis) - turnStart) // [!code highlight]
```

And every tool result, tallied by name and outcome, with a failure also bumping the error counter:

```ts title="packages/core/src/usecases/agentLoop.ts"
for (const tr of responseToolResults(content)) {
  yield* recordToolCall(tr.toolName, tr.ok)
  if (!tr.ok) {
    yield* recordError('tool', tr.toolName)
    yield* Effect.logWarning(`tool ${tr.toolName} failed`)
  }
  // … re-emit the hook so the CLI's execution tree updates
}
```

That's the whole RED story for an agent: `agent_turns_total` and `agent_turn_latency_ms` are the rate and duration; `agent_errors_total{kind="tool"|"llm"|"turn"|"run"}` is the error rate, split by where it happened; `agent_tool_calls_total{tool, ok}` tells you *which* tool is failing. None of it needs a separate metrics pipeline — it's recorded inline at the points the loop already passes through, and it goes wherever the layer at the edge sends it.

## "Logs for this span": the I/O you actually want

A trace tells you a tool call failed; it doesn't, by itself, tell you what the model *said*, or what arguments it passed. That's what the correlated logs are for. Because a log emitted inside a span is stamped with that span's id, a trace viewer can show "the logs that happened during this span" — and the agent uses that pane deliberately, writing the LLM's input and output as logs *inside* the `llm.generate` span:

```ts title="packages/adapters/src/llm/router.ts"
const output = content['gen_ai.completion']
if (output !== undefined) yield* Effect.logInfo(`llm output ▸ ${output}`)
const input = content['gen_ai.prompt']
if (input !== undefined) yield* Effect.logInfo(`llm input ▸ ${input}`)
```

and the tool's args and result as a log inside the `agent.tool` span:

```ts title="packages/core/src/usecases/agentLoop.ts"
yield* Effect.logInfo(
  `tool ${String(name)}(${safeArgsSummary(params)}) ${failed ? '✗ failed' : '▸ ok'}\n` +
    safeResultSummary(r, 1500),
)
```

Click a failed `agent.tool.bash` span, open "Logs for this span," and you see the exact command and the exact error — the breadcrumb that turns "a tool failed" into "this is why." A per-turn heartbeat log rides the *run* stream (it's emitted after the turn span closes), so "Logs for this trace" reads like a transcript: `turn 0: tool-calls · 2 tool calls · 1843 tok`, `turn 1: stop · 502 tok`.

Two of those helpers are doing careful work that's easy to overlook. `safeArgsSummary` and `safeResultSummary` are *total, schema-free projections* — they walk arbitrary, type-erased tool I/O keeping only short scalar leaves, bounded in depth, cycle-safe, never calling `JSON.stringify` (which can throw, and throwing in the middle of emitting a log is how observability code becomes the outage). A trace label is a best-effort breadcrumb, not a contract, and the code is written to fail soft — drop a field, never crash the thing it's observing.

## The privacy line: capture is opt-in and clipped

Prompts and completions are the most useful thing to put in a trace and the most dangerous. They're the model's actual input and output — invaluable for debugging, and exactly the data you can't ship to a telemetry backend without thinking. So capture is gated and bounded. The `gen_ai.prompt`/`gen_ai.completion` attributes are only populated when telemetry is on at all, and even then each is clipped, keeping the useful ends:

```ts title="packages/core/src/telemetry/metrics.ts"
export const GEN_AI_CONTENT_CAP = 12_000

/** Clip keeping head and tail — a prompt's system block + latest message are
 *  the useful ends; the grown middle is what's elided. */
const clipEnds = (s: string, max: number): string => {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.7)
  const tail = max - head - 32
  return `${s.slice(0, head)}\n…[${s.length - head - tail} chars elided]…\n${s.slice(s.length - tail)}`
}
```

The default posture is that a run nobody configured exports nothing, a run with telemetry on exports structure (timings, token counts, costs, tool names) but clips content, and the content itself keeps the head and tail — the system block and the latest message — because the elided middle is the part that grew, not the part you read. Capturing model I/O is a decision you make on purpose, per environment, not a default you discover after it's already in someone's Loki.

## The stack is one container

None of this needs a SaaS account to try. Point the agent at a local `grafana/otel-lgtm` — one image bundling the OTLP collector, Tempo (traces), Prometheus (metrics), Loki (logs), and Grafana — and you have the whole picture on `localhost`:

```yaml title="docker-compose.observability.yml"
services:
  lgtm:
    image: grafana/otel-lgtm:latest
    ports:
      - '3000:3000' # Grafana UI
      - '4318:4318' # OTLP HTTP — point OTEL_EXPORTER_OTLP_ENDPOINT here
    volumes:
      # persist Tempo/Prometheus/Loki/Grafana data across restarts
      - efferent-lgtm-data:/data
      # mount the checked-in dashboards
      - ./observability/grafana/dashboards:/var/lib/grafana/dashboards/efferent:ro
```

`docker compose -f docker-compose.observability.yml up -d`, flip `telemetry` on, and a run's traces, metrics, and correlated logs all land in one Grafana — the OTLP layer from the previous post POSTing to `:4318`, the dashboards querying by the stable `agent.kind` and `agent.conversation_id` tags. The dashboards are checked into the repo as JSON, which means they're versioned next to the code whose attributes they depend on — when someone adds a span kind, the panel that reads it is in the same diff.

## What it costs

**Capturing content is a real exposure, not a toggle you forget.** The clipping and the opt-in gate are mitigations, not absolution — if you turn content capture on in an environment whose telemetry backend you don't fully trust, you've shipped prompts there. The honest default is structure-on, content-off, and content-on only where you own the whole pipe.

**The attribute schema is now an API you have to maintain.** The flip side of "query by attribute, not name" is that `agent.kind`, `agent.conversation_id`, and the `gen_ai.*` set are a contract. Rename a *value* (not just a span name) — `'turn'` to `'step'` — and you've broken every dashboard and every eval that filters on it, exactly the failure you were avoiding, just moved. Stable attributes are only stable if you treat them as load-bearing. They are.

**Best-effort projections can mislead if you trust them too much.** `safeArgsSummary` deliberately drops arrays, objects, and long strings from a tool's args label — which is right for a trace label and wrong if you ever start *reasoning* from it ("the args summary didn't show the file path, so the model didn't pass one" — no, it passed one and the projection dropped it). The label is a breadcrumb; the full result lives in the buffer and the span. Don't promote a breadcrumb to evidence.

**And it's all still gated on one boolean.** Everything here — every span, every metric, every correlated log — is a no-op when the telemetry layer is `Layer.empty`. That's the first post's point cashed in: the instrumentation above is dense, and it costs a run with telemetry off exactly nothing, because there's no tracer to receive it.

## The name is a courtesy; the attribute is a contract

The whole post is one distinction held consistently. A span's *name* is a message to the human reading the waterfall — make it rich, make it scannable, change it whenever a better phrasing occurs to you. A span's *attributes* are messages to machines — the dashboards, the alerts, the eval reader — and those you design like the API they are: a small, stable taxonomy (`agent.kind`), a universal join key (`agent.conversation_id`), and a standard dialect for the parts the ecosystem already understands (`gen_ai.*`).

Get that split right and an agent loop stops being a thing you `console.log` and starts being a thing you *query*: which conversation, which kind of span, p95 over which window, cost by which model. The tree the agent already is becomes the tree you can ask questions of — and the answers don't break the next time you rename something, because you were never asking about names.

There's one more client of that attribute taxonomy, and it's the one that surprised me most: the eval harness reads the exact same `agent.kind` and `gen_ai.usage.*` attributes out of the trace to build its scorecard — no separate eval database, just the spans. That's the next, and last, post in this series.
