---
title: 'Tools are programs: a post-mortem of migrating from the Vercel AI SDK to @effect/ai'
description: 'A migration post-mortem with the diff: what @effect/ai restructured, what survived untouched, and what it cost.'
pubDate: 2026-06-11
tags: [effect, ai, agents]
draft: true
---

One afternoon in late May, four commits moved [efferent](https://github.com/xandreeddev/agent) — the coding agent I'm building on Effect — off the Vercel AI SDK and onto `@effect/ai`. The big one looks like this:

```
$ git show --stat 398aa2c   # "move the agent loop onto @effect/ai"
 28 files changed, 434 insertions(+), 2286 deletions(-)
```

Minus 1,852 lines, net, and the agent did the same job afterwards. The persisted conversation history — every message in Postgres — needed **no data migration at all**. That second fact is the most useful thing in this post, and it wasn't luck; it was a decision made four days earlier for entirely different reasons.

This is a post-mortem, not a takedown. The Vercel AI SDK was the right first choice and I'd make it again. But the codebase around it was an Effect codebase — services as tags, failures as typed values, dependencies in the type signature — and the SDK's view of the world is callbacks and Promises. The gap between those two worlds didn't show up as a bug. It showed up as an adapter: four hundred lines whose only job was escorting values across the border, growing a little with every feature. The migration deleted the border.

The one-sentence thesis: **under the SDK, a tool is data with a callback attached; under `@effect/ai`, a tool is a program** — schemas for its parameters, success, *and* failure, with a handler that is an Effect: typed errors, declared dependencies, real interruption. Everything else in the diff falls out of that difference.

## Day one: the SDK was the right call

First, what the SDK actually bought — because the generous version is the true one. [efferent](https://github.com/xandreeddev/agent) started as a hexagonal Effect monorepo — `core` for the domain, `adapters` for the outside world — and on day one its single LLM feature was classifying a user message. The Vercel AI SDK got that working in an hour: `generateObject` takes a model, a schema, and a prompt, and returns parsed, validated JSON. Provider abstraction came in the same box — `@ai-sdk/google` today, any other provider by swapping one constructor.

Here's that day-one adapter, condensed (the file no longer exists):

```ts title="packages/adapters/src/llm/gemini.ts (day one — since deleted)"
const ZClassification = z.object({
  intent: z.enum(['add_todo', 'list_todos', 'complete_todo', 'ask', 'other']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
})

return Llm.of({
  classify: (message: string) =>
    Effect.tryPromise({
      try: () => generateObject({ model, schema: ZClassification, prompt }),
      catch: (cause) => new LlmError({ cause, message: 'Gemini classification failed' }),
    }).pipe(
      Effect.flatMap((res) => Schema.decodeUnknown(Classification)(res.object)), // [!code highlight]
      // …mapError into LlmError
    ),
})
```

It works, and it shipped a feature on day one. But the highlighted line is the embryo of everything that came later: the SDK validates the response against a **zod** schema, then the domain decodes *the same value* against an **Effect Schema** — `Schema` being Effect's built-in validation library, already used everywhere else for entities and ports. One shape, two schema languages, two decode passes. On day one that's a shrug. It stops being a shrug when the shapes are tools.

The SDK is optimized for getting from zero to a streaming, tool-calling, provider-agnostic LLM call faster than anything else in the ecosystem, and it delivered exactly that. The friction that follows isn't the SDK failing at its job — it's the cost of holding two execution models in one codebase, and it accumulated in three places.

## Exhibit A: two type systems for one tool

Within a week, [efferent](https://github.com/xandreeddev/agent) had pivoted into a coding agent with real tools — `read_file`, `edit_file`, `bash` and friends. Tools are where an agent touches the world, so in an Effect codebase they naturally came out Effect-shaped. This was the domain's own tool type, before the migration:

```ts title="packages/core/src/entities/AgentTool.ts (pre-migration)"
/**
 * A capability the agent can invoke. Pure data: the `execute` Effect carries
 * its requirements `R` in the type, so the LLM adapter can run it inside the
 * caller's runtime without the adapter knowing what the requirements are.
 */
export interface AgentTool<I, O, R = never> {
  readonly name: string
  readonly description: string
  readonly parameters: Schema.Schema<I, any>
  readonly execute: (input: I) => Effect.Effect<O, AgentToolError, R> // [!code highlight]
}
```

Read the highlighted line closely — the domain was already trying to do the right thing. `execute` returns an `Effect`: a *description* of a program with three type parameters — what it produces, how it fails, and what services it needs (that third one, `R`, is the requirements channel; the full semantics of Effect are a post of their own). A `read_file` tool could say "I need the `FileSystem` service" in its type, and the compiler would hold everyone to it.

But notice what the type *couldn't* say. The error channel is a single `AgentToolError` with a `cause: unknown` inside — every distinct failure a tool could have, melted into one bag, because the thing on the other side of the boundary wouldn't preserve anything finer. And notice the comment calling the tool "pure data": the SDK was going to receive this object, and the SDK's contract for a tool is not an Effect. It's this:

```
// the Vercel AI SDK's contract: a schema and an async callback
const myTool = tool({
  description: '…',
  inputSchema: z.object({ path: z.string() }),
  execute: async (args) => doTheThingSomehow(args),
})
```

An `async` function. Untyped errors (whatever `throw` happens to carry), no requirements channel, no interruption protocol — a Promise starts running and finishes when it finishes. So the domain had Effect-shaped tools, the SDK wanted Promise-shaped tools, and something had to translate. That something is Exhibit B.

## Exhibit B: the adapter that left the world on every call

The translation lived in a 405-line file called `vercelAi.ts`, and its core move was `buildSdkTools`: wrap every domain tool in an SDK `tool()` whose `execute` callback re-enters the Effect runtime by hand. `Runtime.runPromise` is Effect's escape hatch — it takes a captured runtime and runs an Effect as a plain Promise. Here's the wrapper, condensed but structurally faithful:

```ts title="packages/adapters/src/llm/vercelAi.ts (pre-migration)"
const buildSdkTools = <R>(tools, hooks, turnIndex, runtime: Runtime.Runtime<R>) =>
  Object.fromEntries(
    tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: toToolInputSchema(t.parameters), // Effect Schema → JSON Schema
        execute: async (rawArgs: unknown) => {
          if (hooks?.onBeforeToolCall) {
            const decision = await Runtime.runPromise(runtime)(
              hooks.onBeforeToolCall({ turnIndex, toolName: t.name, args: rawArgs }),
            )
            if (decision.action === 'block') { /* …run the after-hook, return a refusal */ }
          }
          const validated = Schema.decodeUnknownSync(t.parameters)(rawArgs)
          const result = await Runtime.runPromise(runtime)( // [!code highlight]
            t.execute(validated).pipe(
              Effect.catchTag('AgentToolError', (err) =>
                Effect.succeed({ ok: false, tool: err.tool /* …string-mine err.cause */ }),
              ),
            ),
          )
          if (hooks?.onAfterToolCall) { /* …a third runPromise */ }
          return result
        },
      }),
    ]),
  )
```

Count the border crossings in one tool call: the before-hook leaves the Effect world and comes back; the execute leaves and comes back; the after-hook leaves and comes back. Three round trips through `Runtime.runPromise`, per tool, per turn. Each crossing is a place where Effect's guarantees stop applying:

- **Errors flatten.** Inside the Effect, `catchTag('AgentToolError', …)` catches the one tag the type allows, then *string-mines the `cause`* — reaching into an `unknown` to fish out a `_tag` and a message, so the model gets something readable. The type system supervised none of it.
- **Validation throws.** `Schema.decodeUnknownSync` is the synchronous decoder — called *outside* any Effect, it throws on bad arguments. And bad arguments are not rare; they're the model having a bad moment. That throw became an SDK-level tool-execution error, which — per the adapter's own comment — would abort the entire `generateText` call. The model's typo crashed the turn.
- **Interruption stops at the border.** The adapter did wire interruption for the HTTP request itself (`Effect.tryPromise` hands you an abort signal; the SDK accepts one — credit where due). But a tool already running inside `execute` was launched by `Runtime.runPromise` *without* a signal. Press Esc mid-`bash` and the agent's fiber dies while the shell command keeps running on a detached runtime, beyond the interrupt's reach.

None of this was a mystery while I wrote it — every piece was a known, commented compromise, the file *full* of notes explaining which guarantee is being traded away and why. That's what an architectural mismatch looks like in practice: not a bug, but a file where every paragraph is an apology.

## Exhibit C: one message, two owners

The third exhibit is quieter. An agent's history is a list of messages, and two parties had opinions about their shape: the SDK (which consumes and produces its `ModelMessage` type) and the domain (which persists `AgentMessage` rows to Postgres and replays them every run). The adapter resolved the standoff with two casts:

```ts title="packages/adapters/src/llm/vercelAi.ts (pre-migration)"
// outbound: our persisted history *is* the SDK's message type — by design
const requestMessages = input.messages as ReadonlyArray<ModelMessage>
// …generateText({ model, messages: requestMessages, tools: sdkTools, stopWhen: stepCountIs(1) })

// inbound: and the SDK's response is our history
const newMessages = step.response.messages as unknown as ReadonlyArray<AgentMessage> // [!code highlight]
```

`as unknown as` is TypeScript's way of saying "trust me," and here the trust was earned — `AgentMessage` had been deliberately built as a structural mirror of the SDK's `ModelMessage`, so the cast really was a near-identity. Hold that thought; it becomes the hero of this story two sections from now.

But double bookkeeping ran deeper than the cast. Because the message type was nominally the adapter's business, the agent loop in `core` wasn't allowed to look inside messages at all — the adapter pre-extracted `assistantText` and `toolCalls` into parallel summary types and shipped those alongside. Two representations of every turn, one for persistence and one for the loop, kept in sync by the adapter. And the port that carried all this had to be generic over `R` — `runTurn: <R>(input: LlmRunTurnInput<R>) => Effect<…, LlmError, R>` — with the tools type-erased to `AgentTool<any, any, R>` inside, because a hand-rolled port can't track a heterogeneous bag of tool types. The `any`s weren't sloppiness; they were the ceiling of what I could express.

## What `@effect/ai` changes: a tool is schemas all the way down

`@effect/ai` is the Effect organization's own LLM package, and its design answer to all three exhibits is the same move: stop translating, and make the LLM layer *out of* the primitives the rest of the codebase already uses. Tools first. `Tool.make` declares a tool as four schemas and a policy:

```ts title="packages/core/src/usecases/codingToolkit.ts"
export const Bash = Tool.make('bash', {
  description: 'Execute a shell command in the workspace. …',
  parameters: {
    command: Schema.String.annotations({
      description: "Shell command. Runs via 'bash -c' in the workspace cwd.",
    }),
    timeout: Schema.optional(Schema.Number), // …annotations elided
  },
  success: Schema.Struct({
    exitCode: Schema.Number,
    stdout: Schema.String,
    stderr: Schema.String,
    durationMs: Schema.Number,
    timedOut: Schema.Boolean,
  }),
  failure: Schema.Struct({ error: Schema.String, message: Schema.String }),
  failureMode: 'return', // [!code highlight]
})

export const codingToolkit = Toolkit.make(
  ReadFile, WriteFile, EditFile, Bash, Grep, Glob, Ls, ReadSkill,
)
```

Everything Exhibit A wanted and couldn't have is in this declaration. `parameters` is Effect Schema — the JSON Schema the provider sees is *derived* from it, and decoding the model's arguments happens against it, inside the framework, as a typed failure rather than a sync throw. `success` types what the handler returns. `failure` types how the handler *fails* — per tool, not one error bag for everyone. And the highlighted `failureMode: 'return'` is a policy the old world couldn't express at the type level: a handler failure is encoded and **returned to the model as a tool result** — data the model reads and reacts to — instead of an exception aborting the turn. The model called `edit_file` with an `oldText` that matches twice? It gets back `{ error: 'EditFailed', message: 'oldText is ambiguous…' }` and fixes its own call on the next turn. The graceful-degradation dance the adapter hand-rolled with `catchTag` and string-mining is now a field in a declaration.

`Toolkit.make` bundles the tools, *preserving each tool's types* — no `AgentTool<any, any, R>` erasure, because the toolkit is generic over the exact record of tools it holds.

## Handlers are services, supplied as a Layer

A `Tool.make` declaration has no implementation — deliberately. Handlers arrive separately, through the same mechanism every other dependency in an Effect codebase arrives: a `Layer` (a composable recipe for building services). The toolkit derives a handler layer; you implement each tool as an Effect:

```ts title="packages/core/src/usecases/codingToolkit.ts"
export const codingToolkitLayer = (cwd: string, skills: ReadonlyArray<Skill> = []) =>
  codingToolkit.toLayer(
    Effect.gen(function* () {
      const fs = yield* FileSystem // [!code highlight]
      const shell = yield* Shell
      return {
        read_file: ({ path, offset, limit }) =>
          Effect.gen(function* () {
            const result = yield* fs.read(resolvePath(cwd, path), { offset, limit })
            return { path: displayPath(cwd, path), /* …content, totalLines, truncated */ }
          }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),
        bash: ({ command, timeout }) => shellExec(shell, cwd, command, timeout),
        // …six more handlers, same pattern
      }
    }),
  )
```

The highlighted line is the structural difference between the two worlds in miniature. The handler builder just *yields* the `FileSystem` service from context — so the handler layer's own type records that it requires `FileSystem | Shell`, and those requirements are satisfied once, at the composition root, exactly like every other service in the app. No captured runtime, no `runPromise`, no border: when the model calls `bash`, the handler runs as an Effect **inside the same fiber tree as the agent loop**. Typed failure flows to `failureMode`. Esc interrupts the shell command, actually. And because handlers are services, swapping them is what layers do — the eval suites provide a different handler layer and the production toolkit never knows (colocated evals are a post of their own).

## The model is a service too — and the loop stays yours

The last piece: `@effect/ai` ships `LanguageModel` as a `Context.Tag` — a service interface with no implementation attached. This was the part I deleted my own code for with the least regret: the hand-rolled `Llm` port (81 lines, generic-`R` gymnastics and all) was my attempt at exactly this abstraction, and the library's version is better. The agent loop asks the *environment* for a model; which provider answers is a wiring decision made elsewhere. The heart of [efferent](https://github.com/xandreeddev/agent)'s loop today:

```ts title="packages/core/src/usecases/agentLoop.ts"
while (turnIndex < maxSteps) {
  const prompt = Prompt.make([
    { role: 'system', content: input.system },
    ...toPromptMessages(messages),
  ])

  const res = yield* LanguageModel.generateText({
    prompt,
    toolkit, // this step's tool calls run as Effects, against the handler layer // [!code highlight]
    concurrency: input.toolConcurrency ?? DEFAULT_TOOL_CONCURRENCY,
  })

  messages = [...messages, ...responseToAgentMessages(res.content)]
  turnIndex++
  const toolCalls = responseToolCalls(res.content)
  if (!(res.finishReason === 'tool-calls' && toolCalls.length > 0)) break
}
```

One call does what the old adapter needed three hundred lines for: `generateText` sends the prompt, decodes the response, decodes each tool call's arguments, runs the handlers — as Effects, concurrently, bounded by that `concurrency` option (under the hood it's an `Effect.forEach` over the step's calls; four parallel `read_file`s, never twenty) — and returns the resolved step. Note what it does *not* do: iterate. `@effect/ai` resolves one step's tools but does not loop across turns; the `while` is mine, on purpose, because the loop is where an agent's actual behavior lives — context transforms, persistence boundaries, stop conditions, recovery (the full anatomy of that loop is a post of its own).

And because `LanguageModel` is a tag rather than a constructor you call with a provider object, the provider became swappable at a distance. The initial Google adapter — the entire file — was 26 lines: compose `GoogleLanguageModel.layer` over `GoogleClient.layerConfig` over an HTTP client. Three and a half hours after the migration landed, [efferent](https://github.com/xandreeddev/agent) had a multi-provider router with a live `/model` switch, precisely because "which model?" had become "which layer implements the tag?" — and a layer can route per request (the router's design is a post of its own).

## The migration, by the numbers

The whole thing was four commits in one afternoon, and the order matters — build the new world alongside the old, then cut over:

1. **`add @effect/ai coding toolkit`** (+491) — the `Tool.make` defs and handler layer you saw above, written while the SDK path still ran.
2. **`add @effect/ai-google LanguageModel adapter`** (+26) — the whole provider.
3. **`move the agent loop onto @effect/ai`** (+434, −2,286) — the cutover.
4. **`drop dead Vercel SDK deps`** — `ai`, `@ai-sdk/google`, and `@google/genai` out of `package.json`.

What commit 3 deleted tells you where the SDK's integration cost had been hiding:

| deleted file | lines | what it was |
| --- | --- | --- |
| `adapters/llm/vercelAi.ts` | 405 | the adapter — Exhibits B and C |
| `adapters/llm/gemini.ts` | 378 | Gemini cache plumbing *for* the adapter |
| `core/usecases/codingTools.ts` | 418 | tools as `AgentTool` records |
| `core/usecases/buildScopedCodingTools.ts` | 391 | sandboxed variants of the same tools |
| `core/ports/Llm.ts` + `LlmCache.ts` | 115 | the hand-rolled model port |
| sub-agent + safety-hook plumbing | ~239 | built against the old port |

Almost two thousand lines, barely any of it business logic — translation, type-erasure recovery, second copies of things. The rewrite side was small: the loop itself (smaller than before), and a new `promptMapping.ts` we'll get to in a moment.

Just as telling is what *barely changed*. The CLI drivers — print, json, rpc, TUI — took diffs of about two dozen lines each, and they're all the same diff:

```ts title="packages/cli/src/modes/print.ts"
import { LanguageModel } from '@effect/ai' // [!code ++]
// …the program's stated requirements:
  | FileSystem
  | Shell
  | Llm | LlmCache // [!code --]
  | LanguageModel.LanguageModel // [!code ++]
  | ConversationStore
// …and at the edge, supply the tool handlers like any other dependency:
yield* runAgent(coderAgentConfig(cwd, skills), cid, input.prompt, hooks).pipe(
  Effect.provide(codingToolkitLayer(input.cwd, input.skills)), // [!code ++]
)
```

Swap one tag for another in the requirements union, provide one extra layer at the composition root. The hooks vocabulary that drives the TUI survived with a one-line import change. When the seams of a codebase are service tags, even replacing the LLM substrate is a local operation — that's not a `@effect/ai` advantage so much as a hexagonal-architecture dividend, but the migration is where the dividend got paid.

## The cast that saved the data

Now the part I'd teach even to someone who never touches Effect. The migration's headline risk wasn't code — code you can rewrite in an afternoon. It was **data**: every conversation [efferent](https://github.com/xandreeddev/agent) ever had sat in Postgres as `AgentMessage` JSON, one row per message, replayed at the start of every run. Change the message schema and you're writing a data migration for an agent's memory.

The migration commit's diff for the message schema file is empty. Here's why:

```ts title="packages/core/src/entities/Conversation.ts"
/**
 * Content-part schemas, structurally mirroring Vercel AI SDK v6
 * `ModelMessage` parts so the adapter boundary is a near-identity cast. // [!code highlight]
 * `providerOptions` is opaque — it round-trips provider-private fields
 * (e.g. Gemini's `thought_signature` on a reasoning part) without us
 * inspecting them.
 */
export const ToolCallPart = Schema.Struct({
  type: Schema.Literal('tool-call'),
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: Schema.Unknown,
  providerOptions: Schema.optional(Schema.Unknown),
  // …
})
// …TextPart, ReasoningPart, ToolResultPart
// AgentMessage = Union(UserMessage, AssistantMessage, ToolMessage)
```

Four days before the migration, `AgentMessage` had been shaped to structurally mirror the SDK's `ModelMessage` parts — at the time, purely so Exhibit C's casts would be honest. The accidental consequence: the persisted format was coupled to a *wire shape* — the role/content-parts vocabulary that every modern chat API speaks, stable across providers and SDK generations — rather than to any library's internal types. So when the library underneath changed, the data didn't have to. Old conversations replayed through `@effect/ai` on the first post-migration run, unmodified.

The boundary work didn't disappear — it moved into `promptMapping.ts` and got smaller and more honest. Where the old adapter cast and hoped, the new mapping converts explicitly between `AgentMessage` and `@effect/ai`'s `Prompt`/`Response` types:

```ts title="packages/core/src/usecases/promptMapping.ts"
/**
 * Bridges our persisted `AgentMessage` (Vercel-shaped) with `@effect/ai`'s
 * `Prompt`/`Response`. The opaque provider blob is carried verbatim both
 * ways — which is how Gemini's `thought_signature` round-trips across turns
 * (the framework drops it via `fromResponseParts`, so we never use that;
 * we map by hand and keep the blob). // [!code highlight]
 */
export const toPromptMessages = (
  messages: ReadonlyArray<AgentMessage>,
): Array<unknown> => /* …role by role, part by part */
```

If I were starting any stateful LLM project tomorrow, this is the lesson I'd carry over before any framework choice: **align your storage schema with a stable wire shape, not with your current library.** Libraries are an afternoon. Data is forever.

## What got harder

Time for the honest column, because some things genuinely got worse — and the highlighted line above already leaked the theme: `@effect/ai` is younger, and the loop had to grow workarounds where the SDK had batteries.

**The same afternoon's notes list four regressions.** The migration commit's own follow-up list, written hours after the cutover: Gemini context caching (the old `LlmCache` port died with the adapter; rebuilt later against the provider config), scoped sub-agent delegation (built against the old port; rebuilt later as toolkit tools), the interactive bash-approval modal (the old `onBeforeToolCall` hook could *block* a call mid-flight; the new loop re-emits hook events from the already-resolved response, so they're a rendering feed, not a gate — gating had to be rebuilt inside the handlers as a proper approval service, a post of its own), and live token streaming (the loop calls `generateText` per turn). Each came back better-placed than before, but "we'll win that back later" is a real cost, and anyone planning a similar migration should budget for the trough.

**The framework's edges needed wrapping.** `@effect/ai` decodes a known tool's arguments before your handler runs, so a wrong-shaped call fails with `MalformedOutput` — which `failureMode: 'return'` never sees, because it only catches *handler* failures. Unhandled, that aborts the turn: the exact crash from Exhibit B, resurfaced one layer up. The fix is a wrapper around the toolkit's resolved handler that converts model-caused decode failures into tool results the model can correct. A *hallucinated tool name* fails earlier still — inside `generateText`, where the response's tool-call part won't decode against the toolkit's name union — so the loop catches that too and feeds back a corrective message:

```ts title="packages/core/src/usecases/agentLoop.ts"
if (outcome._tag === 'malformed') {
  consecutiveMalformed++
  if (consecutiveMalformed > MAX_MALFORMED) return yield* Effect.fail(outcome.err) // [!code highlight]
  const corrective: AgentMessage = {
    role: 'user',
    content:
      `Your previous reply could not be parsed: ${desc}\n\n` +
      `The only tools available are: ${toolNames.join(', ')}. ` +
      `Reply again using one of those tools, or plain text if you're done.`,
  }
  messages = [...messages, corrective]
  turnIndex++
  continue
}
```

Notice both recoveries are *typed* branches on tagged errors — the framework's failure vocabulary made the workarounds small and precise. But I still had to discover each failure path empirically and own the policy. The Vercel SDK, with its enormously larger user base, has sanded down more of these edges; with `@effect/ai` (version 0.35 at migration time — a 0.x, like everything in its orbit) you occasionally *are* the sandpaper.

**Long-tail providers are yours to build.** Official `@effect/ai-*` packages cover the majors. [efferent](https://github.com/xandreeddev/agent) also routes to OpenCode Zen and local Ollama, and both adapters are hand-written against the `LanguageModel` interface — SSE parsing, `AiError` construction, prompt mapping, the lot. In SDK-land, somebody on npm has already written nearly every provider. And some lessons no framework absorbs for you: Gemini rejects a tool with zero parameters and requires tool results to be JSON objects — both learned the hard way, both now encoded as conventions in the toolkit (`success` is always a `Struct`).

## The scorecard

What the migration bought, concretely:

- **Typed tool failures the model reads.** Per-tool `failure` schemas plus `failureMode: 'return'` turned error handling from adapter string-mining into declarations — and made "the model fixes its own mistake" the default recovery path.
- **Handlers in the architecture.** Tool handlers demand services through `R` and arrive via a layer, so evals swap the world under the real toolkit, and the approval gate lives inside the handler where it can actually block.
- **One execution model.** No `Runtime.runPromise` borders: interruption reaches into running tools, concurrency is a number on `generateText`, and every guarantee the rest of the codebase enjoys now covers the LLM layer too.
- **The model as a port I don't maintain.** Deleting my hand-rolled `Llm` port for the library's `LanguageModel` tag is what made per-request provider routing a three-hour follow-up instead of a project.
- **Net −1,852 lines**, most of them apologies.

What it cost, concretely: an afternoon of rewrite plus several days of winning back regressed features; ownership of loop iteration, malformed-call recovery, and two hand-built provider adapters; and a seat on the 0.x train, where minor versions occasionally rearrange the furniture. The SDK's community-sized cushion — the long tail of providers, the sanded edges, the thousand Stack Overflow answers — is gone, and I feel its absence maybe once a week.

For this codebase the ledger isn't close: every line of the cost column is *Effect-shaped* work — typed, composable, testable like everything else — while the thing it replaced was a border post between two worlds. But notice the load-bearing phrase: *for this codebase*.

## Should you do this?

Not by default, no. If the Vercel AI SDK is serving you well — and for most TypeScript apps doing LLM calls, it will — there is no prize for this migration. The SDK's execution model matches ordinary async TypeScript; its provider coverage is unmatched; `generateObject` on day one is genuinely hard to beat. If your codebase isn't invested in Effect, `@effect/ai` would *import* that investment as a cost: you'd be adopting a whole semantics to get typed tool handlers, which is a terrible trade if typed tool handlers are all you want. And if your product is a thin orchestration over LLM calls rather than a long-running system, the guarantees this post celebrates — interruption, requirements tracking, handler layers — mostly defend against problems you don't have.

The one signal that you should: **you've built an adapter whose only job is translating your LLM library's world back into your architecture's world — and it's growing.** Not a wrapper that adds behavior; a border post that converts execution models, flattens your typed errors into bags, and re-erects guarantees the library dropped. Mine was four hundred lines and every comment in it was an apology. The moment you find yourself maintaining one of those, the translation layer *is* the bug, and no amount of polishing it will fix the mismatch it exists to hide.

And whichever side of that line you're on: shape your persisted data like the wire, not like your dependencies. I got that one half by accident, and it turned the scariest migration in the project into an empty diff. The libraries went; the messages stayed. Choose dependencies you can leave — then leaving is just an afternoon with `git`.
