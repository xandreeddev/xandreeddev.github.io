---
title: 'An agent loop is a while loop with good manners'
description: 'One agent turn, dissected: a plain while loop whose exits, hooks, and recovery paths are the actual engineering.'
pubDate: 2026-06-17
tags: [agents, effect, ai]
series:
  name: 'Building a coding agent'
  order: 1
draft: true
---

"Agentic loop" is doing a lot of mystical work in 2026. Say it in a talk and people picture planners, graph executors, some emergent decision engine humming inside the framework. Here is what it actually is: assemble a prompt, call the model once, run whatever tools it asked for, append everything to a list, and go again — until the model stops asking. A while loop with good manners.

That's not a dismissal. It's the load-bearing observation of this post, because once the loop itself stops being magic, you can see where the engineering really lives: in what gets assembled each lap, in who decides when to stop, in what the loop tells the outside world, in what gets persisted, and in what happens when the model emits garbage. The edges, not the center.

Everything below is lifted from [efferent](https://github.com/xandreeddev/efferent), the coding agent I'm building on Effect. Its entire loop is one ~250-line file, `agentLoop.ts`, and this post is a guided dissection of it — simplified where simplification teaches, but every claim checked against the real code.

## One turn, in ten naive lines

First, vocabulary. A **turn** (the code also says *step*) is one full lap: build the prompt, make one model call, execute any tools, append the results. A **tool call** is the model replying not with prose but with a structured request — "run `read_file` with these arguments" — and a **finish reason** is the provider's label for why generation stopped: it ran out of things to say (`'stop'`), or it stopped *on purpose* because it wants tool results before continuing (`'tool-calls'`).

With those three terms, the whole architecture fits in a sketch:

```ts
let messages = [...history, { role: 'user', content: prompt }]

while (true) {
  const res = await llm.generate({ system, messages, tools })
  messages.push(...res.newMessages) // assistant text + tool calls + tool results
  if (res.finishReason !== 'tool-calls') break // the model stopped asking
}

return res.text
```

That is, genuinely, the shape of every coding agent you've used. The model can't run `grep`; it can only *ask*. So the loop's job is to keep answering — execute the request, append the result, re-send the whole conversation — until a reply arrives that asks for nothing.

But every line of the sketch hides a decision. Who actually executes the tools on line 4, and how many at once? `while (true)` trusts the model to terminate — would you? `push` appends, but appends *what exactly*, and who persists it? There's exactly one exit, and it belongs to the model, not to you. And nothing outside this function can see a turn happen, which means no UI, no budget, no logs. The rest of this post is those decisions, one section at a time.

## The division of labor: the step is the library's, the loop is yours

The first decision is where to stop writing code. [efferent](https://github.com/xandreeddev/efferent) sits on `@effect/ai`, whose `LanguageModel.generateText` does something stronger than a raw provider call: hand it a **toolkit** — a set of schema-typed tool definitions whose handlers are Effects — and it resolves *one entire step*. It decodes the model's tool calls against the schemas, runs your handlers with bounded concurrency, and returns a response that already contains both the assistant's parts *and* the tool results. One step in, one fully-resolved step out.

What it deliberately does not do is iterate. Calling `generateText` again with the grown history — the loop — is left to you, and the doc comment at the top of [efferent](https://github.com/xandreeddev/efferent)'s loop file treats that as a feature, not a gap. Here's the skeleton:

```ts title="packages/sdk-core/src/usecases/agentLoop.ts"
export const runAgentLoop = (input: RunAgentLoopInput) =>
  Effect.gen(function* () {
    const maxSteps = input.maxSteps ?? 20
    let messages = input.messages
    let turnIndex = 0
    const newTail: AgentMessage[] = [] // everything the loop appends — more later

    // Handlers are stable across turns: resolve the toolkit's handler from
    // its Layer once, not per request.
    const toolkit = recoverMalformedToolCalls(yield* input.toolkit)

    while (turnIndex < maxSteps) {
      // …hooks: onTransformContext, onTurnStart

      const prompt = Prompt.make([
        { role: 'system', content: input.system },
        ...toPromptMessages(messages),
      ])
      const res = yield* LanguageModel.generateText({
        prompt,
        toolkit, // one resolved step: tool calls decoded, handlers run, results included // [!code highlight]
        concurrency: input.toolConcurrency ?? DEFAULT_TOOL_CONCURRENCY,
      })

      const tail = responseToAgentMessages(res.content)
      messages = [...messages, ...tail]
      newTail.push(...tail)
      turnIndex++

      if (res.finishReason !== 'tool-calls') break
      // …the driver's veto: onShouldStopAfterTurn
    }

    return { finalText, messages, newTail }
  })
```

The division is exactly right, and it's worth saying why. The per-step machinery — argument decoding, handler dispatch, running four handlers at once without leaking on interruption — is genuinely fiddly and completely generic. Let a library own it. (`DEFAULT_TOOL_CONCURRENCY` is 4: enough that a model emitting three sub-agent spawns in one turn gets real fan-out, bounded so a twenty-call turn doesn't stampede a provider rate limit.)

The *iteration* is the opposite: nothing about it is generic. The `messages` buffer is your domain entity — it's what you persist, compress, and resume from. The exit condition is product policy. The observation surface decides what your UI can ever show. Whoever owns the loop owns all four, which is why a framework that owns your loop ends up owning your product's shape. [efferent](https://github.com/xandreeddev/efferent) buys the step and keeps the loop.

## Prompt assembly: the model is stateless, the buffer is the state

A thing worth saying plainly, because the "conversation" framing obscures it: chat models remember nothing between calls. Every turn, the loop re-sends *everything* — system prompt plus the entire mapped history. That's what those two `Prompt.make` lines in the skeleton are doing, every lap, from scratch.

The mapping step exists because [efferent](https://github.com/xandreeddev/efferent) persists its own `AgentMessage` shape rather than any provider's wire format. `toPromptMessages` translates one into the other:

```ts title="packages/sdk-core/src/usecases/promptMapping.ts"
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
                params: p.input,
                options: p.providerOptions, // the opaque blob rides along, untouched // [!code highlight]
              }
            : { type: p.type, text: p.text, options: p.providerOptions },
        ),
      }
    }
    return { role: 'tool', content: /* …tool-result parts, same idea */ }
  })
```

The highlighted field is the one subtle obligation in an otherwise mechanical function: `providerOptions` is an opaque blob the loop never inspects, carried verbatim in both directions — response metadata in, prompt options out — which is how Gemini's `thought_signature` (a signed receipt for the model's reasoning that the provider demands back on the next call) survives across turns. Mapping by hand instead of using the framework's response-to-prompt helper exists almost entirely to keep that blob alive.

One ordering detail that will matter twice more in this post: assembly happens *after* the `onTransformContext` hook has had its chance to reshape `messages`. Whatever the driver decides history should look like this turn — folded, trimmed, untouched — that's what gets sent.

## Exits are policy, not accident

The naive sketch had one exit and gave it to the model. The real loop has four, and each one is a decision somebody had to make on purpose.

**Exit 1 — the model is done.** The natural ending, but stated more defensively than the sketch:

```ts title="packages/sdk-core/src/usecases/agentLoop.ts"
const wantsMore = res.finishReason === 'tool-calls' && toolCalls.length > 0 // [!code highlight]
if (!wantsMore) {
  stillWantedMore = false
  break
}
stillWantedMore = true
```

Both conjuncts, deliberately: a provider can report `'tool-calls'` while delivering a response with no decodable calls in it, and trusting the label alone would loop forever on a prompt the model has no further moves for.

**Exit 2 — the step cap.** `while (turnIndex < maxSteps)` — 20 by default for the top-level agent, 80 for sub-agents, which have one job and a budget rather than a human watching. The cap is a backstop against a model that never stops asking, and the interesting part isn't the number, it's the *bookkeeping*: a capped run is not a finished run, and conflating the two produces a nasty failure mode. The last assistant text of a capped run is mid-thought narration — "now I'll update the second call site" — and any caller that surfaces it as the answer is presenting an abandoned thought as a deliverable. So the loop marks it:

```ts title="packages/sdk-core/src/usecases/agentLoop.ts"
// Exhausted the step cap while the model still asked for tools → the last
// text is mid-thought, not a final answer. Tell the caller.
const stoppedAtMaxSteps = turnIndex >= maxSteps && stillWantedMore
return {
  finalText,
  messages,
  newTail,
  ...(stoppedAtMaxSteps ? { stoppedAtMaxSteps } : {}),
}
```

That's why `stillWantedMore` exists at all — at the top of the loop the two exits are indistinguishable; the flag records *which* condition ended things. Downstream, a sub-agent run that ended this way gets its summary stamped `[stopped early: the step limit was reached — this result is partial]`, so the parent model reads truncation instead of trusting a half-sentence.

**Exit 3 — the driver's veto.** After every completed turn where the model *does* want more, the loop offers its caller a vote:

```ts title="packages/sdk-core/src/usecases/agentLoop.ts"
if (hooks?.onShouldStopAfterTurn) {
  const stop = yield* hooks.onShouldStopAfterTurn({
    turnIndex,
    finishReason: res.finishReason,
  })
  if (stop) break
}
```

The placement is the entire design. This hook fires at a turn *boundary* — after `generateText` has resolved the step, after the tail (tool results included) is in the buffer — and never anywhere else. The invariant being protected is **pairing validity**: providers require every assistant tool-call to be followed by its matching tool-result, and an API call against a history that breaks the pairing is a 400, not a warning. Stop *between* turns and the buffer is always a legal conversation; stop *mid-step* and you'd strand an unanswered call. [efferent](https://github.com/xandreeddev/efferent)'s token budget rides exactly this hook — every sub-agent in a turn's fan-out drains one shared pool, and when it's spent:

```ts title="packages/sdk-core/src/usecases/buildScopeRuntime.ts"
onShouldStopAfterTurn: () =>
  Effect.gen(function* () {
    const spent = yield* poolExhausted(pool) // shared across the whole sub-agent subtree // [!code highlight]
    if (spent) yield* Ref.set(budgetStopRef, true)
    return spent
  }),
```

The running sub-agent halts at its next boundary, the flag routes to the same `[stopped early …]` stamping as the step cap, and — note what's absent — the loop itself contains not one line about budgets. (The sub-agent tree this budget governs is a post of its own.)

**Exit 4 — the give-up bound.** When the model's response doesn't even parse, the loop retries with a corrective — but only `MAX_MALFORMED = 3` times consecutively before failing the run outright. The mechanics get their own section below; for now it completes the inventory: model's choice, your cap, your caller's veto, your patience. Four exits, four owners, zero accidents.

## Hooks: the loop's only outward face

Grep `agentLoop.ts` for imports and you'll find no terminal UI, no database, no budget, no event queue. The loop's entire relationship with the outside world is one optional interface:

```ts title="packages/sdk-core/src/entities/AgentHooks.ts"
export interface AgentHooks<R = never> {
  /** Reshape history before each turn's prompt assembly. */
  readonly onTransformContext?: (
    messages: ReadonlyArray<AgentMessage>,
  ) => Effect.Effect<ReadonlyArray<AgentMessage>, never, R> // [!code highlight]
  readonly onTurnStart?: (e: AgentTurnStartEvent) => Effect.Effect<void, never, R>
  readonly onAssistantMessage?: (
    e: AgentAssistantMessageEvent, // text, reasoning, tool calls, token usage
  ) => Effect.Effect<void, never, R>
  readonly onBeforeToolCall?: (e: AgentBeforeToolCallEvent) => Effect.Effect<BeforeToolCallDecision, never, R>
  readonly onAfterToolCall?: (e: AgentAfterToolCallEvent) => Effect.Effect<void, never, R>
  readonly onShouldStopAfterTurn?: (e: AgentShouldStopEvent) => Effect.Effect<boolean, never, R>
  readonly onAgentEnd?: (e: AgentEndEvent) => Effect.Effect<void, never, R>
  // …sub-agent, skill-load, and helper-usage events elided
}
```

Every hook is optional, every hook is an Effect, and the `R` parameter is the quietly great part: a hook implementation that needs a database or an LLM declares it, and the requirement flows up through the loop's generic signature to whoever runs it. The loop stays dependency-free while its hooks can be arbitrarily rich.

Walk the vocabulary in loop order. `onTransformContext` is the highlighted one because it's unique: the only hook whose *output* the loop takes back. Whatever it returns becomes the buffer for this turn's prompt assembly — which makes it the seam where mid-run history folding and compression plug in (the folding strategy itself is a post of its own; the loop just provides the socket). `onTurnStart` announces a lap. `onAssistantMessage` delivers the model's text, surfaced reasoning, tool-call summaries, and token usage for the turn — the event a status bar and a transcript rail are built from. The tool events, `onBeforeToolCall` and `onAfterToolCall`, deserve an honest footnote: since `@effect/ai` resolves the whole step inside `generateText`, the loop *re-emits* these from the already-resolved response — call events first, then results, paired by the provider's `toolCallId`. They're an observation vocabulary for drivers, not interception points; the names predate the architecture and the comment in the loop says so. Then `onShouldStopAfterTurn`, the policy vote from the previous section, and `onAgentEnd`, the curtain.

The payoff is who consumes this interface. The TUI builds its hooks once — every event becomes an offer onto a queue that a render fiber drains (what happens on the other side is a post of its own). The sub-agent machinery wraps a parent's hooks to stamp events with the child's identity, chains a file-change tracker onto `onAfterToolCall`, and wires the budget veto — all without the loop knowing sub-agents exist. The eval suite is the cleanest demonstration: one suite tests *which tool the agent reaches for first* by running the real loop with an `onShouldStopAfterTurn` that returns `true` after the first tool turn. A bounded, cheap eval of a real behavior, expressed as a hook — no test-only fork of the loop, no flag threaded through it.

That's the extensibility argument in one sentence: in eleven days of building features around this loop — budgets, an execution-tree UI, file tracking, eval bounding — the loop file itself changed for none of them.

## newTail: persist exactly what you appended

Now the smallest section, about the discipline I'd argue is the least obvious and the most load-bearing. The loop's caller needs to persist the new messages a run produced. The tempting implementation is arithmetic: remember `messages.length` before the run, slice after. And it's wrong — quietly, eventually — because of a seam this post already crossed: `onTransformContext` can *reshape the buffer mid-run*. Fold ten messages into one summary on turn three, and every index you memorized on turn one now points at the wrong things. Nothing crashes. You persist a corrupted slice.

So the loop refuses to let anyone do arithmetic. You saw `newTail` accumulating in the skeleton: every message the loop appends — model response tails *and* the synthetic correctives the next section introduces — is recorded in a second list, and that list is the contract. Here's the caller's side, the use case that wraps every interaction:

```ts title="packages/sdk-core/src/usecases/runAgent.ts"
export const runAgent = (config, conversationId, userPrompt, hooks) =>
  Effect.gen(function* () {
    const store = yield* ConversationStore

    // The active window: real messages since the latest checkpoint, with a
    // handoff summary standing in for everything folded away before it.
    const checkpoint = yield* store.getLatestCheckpoint(conversationId)
    const active = yield* store.listActive(conversationId)
    const prefix = checkpoint !== null ? [handoffToMessage(checkpoint.summary)] : []

    const userMsg: AgentMessage = { role: 'user', content: userPrompt }
    yield* store.append(conversationId, userMsg) // persist the prompt before risking the run

    const result = yield* runAgentLoop({
      system: config.systemPrompt,
      messages: [...prefix, ...active, userMsg],
      toolkit: config.toolkit,
      maxSteps: settings.maxSteps,
      hooks,
    })

    // Persist exactly what the loop appended — reported explicitly,
    // never reconstructed by index arithmetic on a transformable buffer.
    for (const m of result.newTail) yield* store.append(conversationId, m) // [!code highlight]

    return result
  })
```

Read the shape: load history, prepend the checkpoint's stand-in summary (in memory only — the store keeps the originals), persist the user's message eagerly so a crashed run still remembers the question, run the loop, persist the tail the loop *says* it grew. The doc comment on the `AgentResult` schema makes the rule explicit: persist `newTail`, never a reconstruction — reconstruction "silently breaks the moment a context transform reshapes the buffer mid-run."

One sentence on a sibling detail visible in the loop but not the skeleton: before a turn's tail enters the buffer, each turn's token usage is tucked into the assistant message's `providerOptions` (`attachUsageToAssistant`), so a resumed conversation can rebuild its token gauge from the persisted record alone. The buffer isn't just conversation state; it's the run's accounting ledger.

## Recovery: when the model emits garbage

A production loop talks to a probabilistic text generator that sometimes produces structurally invalid output. There are two distinct failure shapes, they surface at two different layers, and [efferent](https://github.com/xandreeddev/efferent) recovers from both by the same principle: convert the failure into *text the model reads*, and let the loop keep looping. (Why feedback-as-text beats retry machinery — the error-writing philosophy — is a post of its own; here is just the mechanics.)

**Shape one: right tool, wrong arguments.** [efferent](https://github.com/xandreeddev/efferent)'s tools declare `failureMode: 'return'`, so an ordinary handler failure — file not found, ambiguous edit — already comes back as a tool result the model reacts to. But `failureMode` only covers *handler* failures, and there's a failure zone before the handler: `@effect/ai` decodes the model's arguments against the tool's schema inside `Toolkit.handle`, and a call with a valid name but a wrong-shaped payload dies there as `AiError.MalformedOutput` — which would abort the whole turn. The fix is the wrapper you saw applied to the toolkit back in the skeleton:

```ts title="packages/sdk-core/src/usecases/agentLoop.ts"
const handle = (name: unknown, params: unknown) =>
  base.handle(name, params).pipe(
    Effect.catchAll((err) => {
      // MalformedInput is OUR bug (a result that fails our own schema) — surface it.
      if (err._tag !== 'MalformedOutput') return Effect.fail(err)
      // MalformedOutput is the MODEL's bug (bad arguments) — make it feedback.
      const failure = {
        error: 'InvalidToolCall',
        message: `${err.description} — the arguments did not match the tool's ` +
          `schema; re-call the tool with parameters that match its documented shape.`,
      }
      return Effect.succeed({ isFailure: true, result: failure }) // [!code highlight]
    }),
  )
```

The branch encodes attribution: whose bug is this? The model's malformed arguments become a failed tool *result* — the tool-call/tool-result pairing stays valid, the loop proceeds, the model reads the decode error in context and re-calls correctly. Our own encode bugs are deliberately let through to crash, because masking them would hide real defects behind model retries.

**Shape two: a hallucinated tool name.** This one fails a layer earlier, and the wrapper never sees it. The toolkit's tool names form a literal union in the response schema, so a model inventing `read_files` fails *response decoding inside `generateText`* — before any handler is consulted. The loop catches that case around the call itself and synthesizes a corrective:

```ts title="packages/sdk-core/src/usecases/agentLoop.ts"
if (outcome._tag === 'malformed') {
  consecutiveMalformed++
  if (consecutiveMalformed > MAX_MALFORMED) return yield* Effect.fail(outcome.err)

  const corrective: AgentMessage = {
    role: 'user',
    content:
      `Your previous reply could not be parsed: ${desc}\n\n` +
      `This usually means you called a tool that doesn't exist or used the wrong ` +
      `argument shape. The only tools available are: ${toolNames.join(', ')}. ` +
      `Reply again using one of those tools, or plain text if you're done.`,
  }
  messages = [...messages, corrective]
  newTail.push(corrective) // synthetic messages are part of the persisted record too // [!code highlight]
  turnIndex++
  continue
}
consecutiveMalformed = 0
```

Three details earn their lines. The retry is *bounded and consecutive*: three malformed responses in a row fails the run, but one good response resets the counter, so a model that occasionally stumbles isn't punished like one that's broken. The corrective *costs a step* — `turnIndex++` — so recovery can't circumvent the cap. And the corrective goes into `newTail`: the synthetic message is part of what really happened, so it persists with the conversation, which is precisely why the previous section insisted the loop track its own appends instead of assuming every new message came from the model.

## What owning the loop costs

The honest ledger, because "just write the while loop yourself" glosses over what you're signing up for.

**The invariants are yours now.** Pairing validity isn't enforced by anything except your own care — every path that touches the buffer (correctives, the malformed-arguments wrapper, the boundary-only veto) had to be designed so an assistant tool-call is never left unanswered, and a future refactor can silently break what a provider will only report as a 400 at runtime. Ordering invariants too: oversized tool results are compressed at the moment they enter the buffer — before persistence, before the next prompt — so the persisted record and every future prompt prefix carry the clipped form from byte one and provider-side prompt caches never see a rewrite (the clip mechanics are a post of its own). Get that ordering wrong in either direction and you persist bloat or invalidate every cached prefix; nothing in the type system holds the line for you.

**`maxSteps` is a blunt instrument.** It counts laps, not progress. A methodical 25-step refactor and a model spinning in circles look identical to it, correctives spend from the same allowance, and the only mitigation is layering smarter signals — token budgets, the driver's veto — on top while the cap stays as the dumb, reliable backstop. I'd rather have a crude bound that always fires than a clever one I have to trust, but it's a real cost: sometimes the cap cuts off legitimate work, which is exactly why the partial-result marking exists.

**Per-step concurrency is a constant, not a solution.** Four tool handlers in parallel is a guess that balances fan-out against provider rate limits, and nested fan-out multiplies it — each concurrent `run_agent` call is a sub-agent making its own model calls. The number is caller-overridable, which is another way of saying the hard problem is deferred to whoever can see the whole system.

**And one step is still atomic.** The loop uses `generateText`, so a turn resolves as a block — turn-level events, not token-level streaming. Moving to `streamText` and mapping stream parts onto the hook vocabulary is known future work, and the hooks were shaped so that change stays inside the loop file.

Against all that: the alternative is a framework's loop, where these same invariants still exist but live in someone else's code, behind someone else's extension points, on someone else's release schedule.

## The loop is the easy part — that's the point

There's a whole product category built on the premise that the agent loop is hard: graph DSLs, orchestration frameworks, platforms whose pitch is *we'll run the loop for you*. After writing one, I think the premise is backwards. The loop was an afternoon. It's 250 lines, most of which are comments explaining decisions, and the decisions are the product: where exits live, what the hooks expose, what gets persisted, what the model reads when it fumbles.

Every feature [efferent](https://github.com/xandreeddev/efferent) grew in its first weeks — token budgets, partial-result marking, eval bounding, an execution-tree UI, sub-agent fan-out — landed on the loop's edges, through the hook vocabulary, without touching the file. That's not because the loop is cleverly extensible. It's because the loop is *small enough to have edges*. A framework's loop has surface area instead: configuration, escape hatches, version notes about which callback fires when.

So my advice runs opposite the category: buy the step, own the loop. Let a library do the genuinely fiddly per-step work — schema decoding, handler dispatch, bounded concurrency — and write the while loop yourself, with the exits your product needs and the manners your model deserves. If reading one 250-line file makes the "agentic" part of your system boring, that's not a loss of magic. That's what understanding your own system feels like.
