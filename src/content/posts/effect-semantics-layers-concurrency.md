---
title: 'Effect, in full: services, layers, errors, and the concurrency toolkit'
description: 'What Effect.ts actually buys you — dependencies, failures, and concurrency as ordinary values. A long tour of the semantics, every claim backed by real code.'
pubDate: 2026-06-11
tags: [effect, typescript]
---

Effect has a marketing problem: it gets introduced as functional programming, so people file it next to monad tutorials and move on. That's a shame, because the library is a concrete answer to the three things that actually hurt in long-running TypeScript programs — **dependencies**, **failures**, and **concurrency** — and the whole answer fits in one type:

```ts
Effect.Effect<A, E, R>
// a program that succeeds with A, fails with E, and needs R to run
```

The three type parameters are the three acts of this post: `R` is dependencies, `E` is failures, and the runtime that executes them is concurrency.

Nothing here is a toy. Every snippet is lifted from [efferent](https://github.com/xandreeddev/agent), a coding agent I'm building on Effect — long-running, concurrent, full of slow IO and humans who press Esc at inconvenient moments. Which is to say: a stress test for exactly the three channels.

## Prelude: what an Effect actually is

Before the acts, the sixty-second mental model. A Promise runs the moment you create it. An `Effect` doesn't — it's a *description* of a program, inert until something executes it:

```ts
const random = Effect.sync(() => Math.random())  // wraps synchronous code
const body = Effect.tryPromise(() => fetch(url).then((r) => r.text())) // wraps a Promise
const config = Effect.succeed({ retries: 3 })    // lifts a plain value
```

None of those lines *did* anything. Composing them is where the value-ness starts paying. `Effect.gen` is the everyday workhorse — it reads exactly like `async/await`, with `yield*` where you'd write `await`:

```ts
const program = Effect.gen(function* () {
  const text = yield* body      // "await" an effect
  const roll = yield* random
  return roll > 0.5 ? text : text.toUpperCase()
})
// still — nothing has run
```

`program` is an ordinary value. You can store it, pass it to a function, retry it, race it against another program, run it a thousand times concurrently. Execution happens once, at the edge, when a description is handed to a runtime:

```ts
const result = await Effect.runPromise(program) // the only line that runs anything
// Effect.runSync(random)                       // same idea, for a purely sync effect
```

That's the full model: build one big description out of small ones, run it once at the entry point — efferent does exactly this, a single `BunRuntime.runMain` at the bottom of `main.ts`. Everything else in this post — services, layers, typed errors, fibers — is leverage that falls out of programs being values you can manipulate before they run. Hold onto `yield*` ("run this effect, give me its success value"); it's in every snippet from here on.

## Act I — the R channel: services are tags

Effect's dependency story starts with `Context.Tag`: a service is declared as a *type* plus a unique identifier, with no implementation anywhere in sight.

```ts title="packages/core/src/ports/ConversationStore.ts"
export class ConversationStoreError extends Data.TaggedError(
  'ConversationStoreError',
)<{
  readonly cause: unknown
  readonly message: string
}> {}

export class ConversationNotFound extends Data.TaggedError(
  'ConversationNotFound',
)<{ readonly id: string }> {}

export class ConversationStore extends Context.Tag(
  '@efferent/core/ConversationStore',
)<
  ConversationStore,
  {
    readonly create: () => Effect.Effect<ConversationId, ConversationStoreError> // …
    readonly append: (
      id: ConversationId,
      msg: AgentMessage,
    ) => Effect.Effect<void, ConversationStoreError | ConversationNotFound>
    // … list, checkpoint, listActive
  }
>() {}
```

(The `Data.TaggedError` at the top is Act II's subject — for now, read it as a failure type with a name.) Using a service is one line — `const store = yield* ConversationStore` — and the act of using it adds the tag to the effect's `R`. That's the part that changes how a codebase feels: **the R channel is the architecture, inferred.** A use-case that reads the store and runs shell commands has type `Effect<A, E, ConversationStore | Shell>`, whether or not you remembered to document that. You cannot quietly reach into the database from a function whose type says it doesn't.

This is ports-and-adapters, but with the dependency direction enforced by the compiler. [efferent](https://github.com/xandreeddev/agent)'s core package declares twelve such tags — `FileSystem`, `Shell`, `Approval`, `AuthStore`, `ModelRegistry`, `SettingsStore`, and so on — and imports zero provider SDKs. The adapters package implements them. Core compiles without knowing Postgres exists.

## Act I, scene 2 — layers: constructors as values

A `Layer<Out, Err, In>` is a recipe for building services out of other services. `Layer.succeed` wraps a value, `Layer.effect` runs an effect to construct one, `Layer.scoped` ties the service to a resource lifetime. Like effects, layers are values — so wiring an application is an expression. Here's the deep end first; every operator in it gets unpacked right below:

```ts title="packages/cli/src/main.ts"
// Credentials + settings feed the model/search tiers. Both are provided at the
// bottom so `ModelLive` (AuthStore + SettingsStore) and `WebSearchLive`
// (AuthStore) resolve against them, and both stay exposed for `main` to read.
const CredentialsLive = Layer.mergeAll(
  LocalAuthStoreLive,
  LocalSettingsStoreLive.pipe(Layer.provide(LocalFileSystemLive)),
)

const AppLive = Layer.mergeAll(
  // Both SQL stores (ConversationStore + ContextTreeStore) over one DB stack.
  StoresLive,
  ModelLive,
  LocalFileSystemLive,
  LocalShellLive,
  // …
  WebSearchLive.pipe(Layer.provide(FetchHttpClient.layer)),
  UtilityLlmLive.pipe(
    Layer.provide(ModelRegistryLive),
    Layer.provide(FetchHttpClient.layer),
  ),
).pipe(Layer.provideMerge(CredentialsLive)) // [!code highlight]
```

That's the entire composition root of a multi-provider, multi-mode CLI. Three operators do all the work, and their semantics are worth spelling out because they're the vocabulary of every Effect app:

- **`Layer.mergeAll`** — union the outputs. The result provides everything its inputs provide.
- **`Layer.provide`** — feed dependencies *into* a layer and hide them. `WebSearchLive.pipe(Layer.provide(FetchHttpClient.layer))` is web search with its HTTP client baked in; the client doesn't leak into the app's environment.
- **`Layer.provideMerge`** — feed dependencies in *and keep them exposed*. The highlighted line is why it exists: `CredentialsLive` must satisfy `ModelLive` and `WebSearchLive` *and* remain readable by `main` itself. Plain `provide` would wire the model tier and then hide the auth store from everyone else.

Two more semantics hide in plain sight. First, **memoization**: layers are built once per layer *value*. Reference the same `const` in five places and Effect constructs one instance — [efferent](https://github.com/xandreeddev/agent)'s eval environment leans on this, naming `const FsLive = LocalFileSystemLive` precisely so two references resolve to a single `FileSystem`. Second, **a layer can be chosen by a program**, because of course it can — it's a value:

```ts title="packages/adapters/src/database/migrator.ts"
export const StoresLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const url = yield* Config.option(Config.string('EFFERENT_DB_URL'))
    const target = parseDbTarget(url) // …
    return target.kind === 'postgres'
      ? Layer.merge(
          PostgresConversationStoreLive,
          PostgresContextTreeStoreLive,
        ).pipe(Layer.provide(PgDatabaseLive))
      : Layer.merge(
          SqliteConversationStoreLive,
          SqliteContextTreeStoreLive,
        ).pipe(Layer.provide(sqliteDatabaseLive(target.filename)))
  }),
)
```

`Layer.unwrapEffect` runs an effect that *returns a layer* — here, reading config and picking the whole persistence stack. Note both stores ride one database layer: providing each store its own self-contained DB stack would open two connections and race the migrator on the same file. The layer graph isn't just wiring; it's where resource-sharing decisions become visible.

## The swap: one program, three worlds

Here's the payoff for all that ceremony. [efferent](https://github.com/xandreeddev/agent)'s eval suites run the *actual agent* — same loop, same prompts, same toolkit — inside a different world:

```ts title="packages/evals/src/env.ts"
const FsLive = LocalFileSystemLive
const SettingsLive = LocalSettingsStoreLive.pipe(Layer.provide(FsLive))
// Headless credentials: read the provider keys from the env (the product CLI
// uses auth.json via :login; evals/CI can't run the interactive flow).
const CredentialsLive = Layer.mergeAll(EnvAuthStoreLive, SettingsLive) // [!code highlight]

export const EvalEnvLive: Layer.Layer<EvalEnv> = Layer.mergeAll(
  ModelLive, // the real multi-provider router
  InMemoryConversationStoreLive, // [!code highlight]
  InMemoryContextTreeStoreLive, // [!code highlight]
  FsLive,
  LocalShellLive,
  HttpLive,
  WebSearchLive.pipe(Layer.provide(FetchHttpClientLive)),
).pipe(Layer.provideMerge(CredentialsLive), Layer.orDie)
```

Read it against `AppLive` above — it's the same shape, with three substitutions. The SQL stores become in-memory maps (CI shouldn't need Docker). Credentials come from env vars instead of the interactive `:login` flow. And the human approval modal becomes a five-line policy:

```ts title="packages/core/src/ports/Approval.ts"
export const ApprovalAllowAllLive = Layer.succeed(
  Approval,
  Approval.of({
    request: () => Effect.succeed({ kind: 'allow', scope: 'once' } as const),
  }),
)
```

Just as telling is what *didn't* change: the model layer is the real router hitting real providers, and the filesystem and shell are the real adapters pointed at a disposable temp workspace. The swap is surgical because every seam was already a tag. Unit tests cut deeper — they substitute a scripted `LanguageModel` and run the whole loop against canned responses. Nobody wrote a mocking framework; substitution is what layers *are*. (The eval design itself deserves its own post.)

## Interlude — Scope: resource lifetimes as values

That throwaway workspace is worth slowing down for, because it demos the Effect feature I'd miss most anywhere else. Every resource has the same three-beat life — acquire it, use it, release it — and in Promise-land the third beat is a `finally` you *hope* runs. Mostly it does. It doesn't when the process is interrupted mid-use, when an error throws past it, or when someone cancels the work — which a Promise can't even express. Effect makes the three beats one value:

```ts
const result = Effect.acquireUseRelease(
  openConnection(db),            // acquire
  (conn) => runQuery(conn, q),   // use
  (conn) => conn.close,          // release — runs on success, failure, OR interrupt
)
```

The guarantee is the feature: the release runs *no matter how the use ends*, including interruption — the case every hand-rolled cleanup forgets. Here's the real one behind the eval environment:

```ts title="packages/evals/src/support/workspace.ts"
export const withTempWorkspace = <A, E, R>(
  files: Record<string, string>,
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const dir = mkdtempSync(join(tmpdir(), 'agent-eval-'))
      // …materialise `files` into it
      return dir
    }),
    use,
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })), // [!code highlight]
  )
```

Every eval case gets a fresh directory and *cannot* leak it. A failing scorer, a thrown decode error, Ctrl-C halfway through the suite — the directory is gone in all three endings, and nobody wrote three cleanup paths.

A `Scope` is this idea reified: a lifetime, as a value, that any number of acquisitions can attach to — when the scope closes, every finalizer runs in reverse order. You rarely touch one directly; you meet it through the combinators that open one around a region: `Layer.scoped` ties a service to the application's lifetime (its finalizer runs at shutdown), and `Effect.scoped` / `Stream.unwrapScoped` open a scope around a single call. That last one is the next section's whole move.

## Where layers stop

One discipline keeps this from going wrong: **layers answer "the program is different"; state answers "the request is different."** Tests run a different program — layer swap. A user switching LLM providers mid-session is changing a preference — that must *not* be a layer, or you're rebuilding the runtime to honor a dropdown.

[efferent](https://github.com/xandreeddev/agent)'s `LanguageModel` is therefore one layer whose implementation routes per call:

```ts title="packages/adapters/src/llm/router.ts"
streamText: (options) =>
  Stream.unwrapScoped( // [!code highlight]
    Effect.gen(function* () {
      const sel = yield* registry.current          // the live `:model` choice
      const { svc } = yield* resolveAndBuild(sel)  // resolve key, build the client
      return svc.streamText(options)
    }),
  ),
```

The `Scoped` suffix is the interlude's idea opened around a stream: the provider client built inside lives exactly as long as this one call — released on completion, failure, *or interruption*, with no cleanup code at the call site. "Request-scoped" isn't a comment here; it's the type. (The full argument for runtime provider selection is a post of its own.)

## Act II — the E channel: failures are data

Effect's second channel makes failure modes part of a function's interface. `Data.TaggedError` declares an error as a class with a `_tag`; the `E` channel accumulates as a union (`ConversationStoreError | ConversationNotFound` in the first snippet), and `catchTag` handles exactly one variant, with the compiler narrowing what remains.

In an agent, the error channel has an unusual second consumer: not just humans, but *the model*. [efferent](https://github.com/xandreeddev/agent)'s tools all declare `failureMode: 'return'` — a handler failure becomes a tool **result** the model reads and reacts to, not an exception that kills the turn. The interesting case is failures the tool handler never sees, because the model's arguments didn't even decode:

```ts title="packages/core/src/usecases/agentLoop.ts"
// Wrap the toolkit's handler so a model-caused decode failure
// becomes a tool *result* instead of aborting the turn.
const handle = (name: unknown, params: unknown) =>
  base.handle(name, params).pipe(
    Effect.catchAll((err) => {
      const e = err as { _tag: string; description: string } // …
      if (e._tag !== 'MalformedOutput') return Effect.fail(err) // [!code highlight]
      const failure = {
        error: 'InvalidToolCall',
        message: `… the arguments did not match the tool's schema; re-call the tool with parameters that match its documented shape.`,
      }
      return Effect.succeed({ isFailure: true, result: failure })
    }),
  )
```

The highlighted line encodes a policy that would be mush in a `try/catch` world: `MalformedOutput` is *the model's* bug (bad arguments), so convert it into feedback and keep looping — the model corrects itself next turn. `MalformedInput` is *our* bug (a result that doesn't match our own schema), so let it surface. Tagged errors make "whose fault is this?" a branch on data.

And sometimes the most expressive thing in a signature is the error type `never`:

```ts title="packages/core/src/usecases/autoApproval.ts"
export const judgeApproval = (
  req: ApprovalRequest,
  permittedFolders: ReadonlyArray<string>,
): Effect.Effect<JudgeOutcome, never, UtilityLlm> => // [!code highlight]
  Effect.gen(function* () {
    const utility = yield* UtilityLlm
    const res = yield* utility.complete(buildJudgePrompt({ /* … */ }), { role: 'fast' })
    const verdict = parseJudgeVerdict(res.text)
    return { ...verdict /* … */ }
  }).pipe(Effect.catchAll(() => Effect.succeed({ verdict: 'prompt' } as JudgeOutcome)))
```

This is the LLM judge that pre-screens bash approvals. Its `E` channel says `never`: *every* failure — missing key, rate limit, malformed JSON — has been handled, by degrading to "show the human the dialog." That's not a comment promising safety; it's a compiler-checked claim. Add a new failure path later and the signature breaks at build time, not in someone's terminal.

## Act III — the concurrency toolkit

Effect programs run on **fibers** — lightweight threads, cheap enough to have tens of thousands. Every running effect is on one (your whole program starts as a single fiber at `runMain`), `Effect.fork` starts a child, and combinators like `Effect.all` or a `concurrency` option fork and join them for you — most of the time you say *how much* parallelism you want and never touch a fiber directly. Two properties make them safe where raw Promises aren't: they're **structured**, so a child can't outlive its parent's scope, and they're **interruptible**, so cancellation runs finalizers instead of abandoning work mid-flight.

On top of fibers sits a small standard library of coordination primitives. What sold me wasn't any one of them — it's that one real system needs *all* of them at once, and they compose because each is just another effect value on the same runtime.

One turn of [efferent](https://github.com/xandreeddev/agent) can have four tool handlers in flight, three sub-agents fanning out across folders, a UI fiber painting tokens, and a human deciding whether to allow `rm`. Here's the toolkit that holds it together.

### Bounded fan-out: a number, not an architecture

Concurrency limits in Effect are an option you pass, not a worker pool you build:

```ts title="packages/core/src/usecases/agentLoop.ts"
const outcome = yield* LanguageModel.generateText({
  prompt,
  toolkit,
  concurrency: DEFAULT_TOOL_CONCURRENCY, // = 4, caller-overridable
})
```

`@effect/ai` resolves one step's tool calls with `Effect.forEach`, so a model that emits three `run_agent` calls in one turn gets three sub-agents running simultaneously — bounded, so a twenty-call turn doesn't stampede a provider rate limit. Every collection combinator in Effect takes this option; "make it parallel, but not too parallel" is a constant, not a refactor.

### Queue: the seam between worlds

A `Queue` is the classic producer/consumer seam, used here to decouple agent fibers from the UI:

```ts title="packages/cli/src/tui-solid/runtime.ts"
const eventQueue = yield* Queue.unbounded<AgentEvent>()
const hooks = makeEventHooks(eventQueue) // every loop hook offers onto the queue
// …the agent loop runs with these hooks; one consumer fiber drains the queue
```

Hooks deep inside the loop — assistant deltas, tool starts, sub-agent spawns — offer events onto the queue from whatever fiber they're on; one consumer fiber drains it into Solid signals. Unbounded is a deliberate choice ratified by the type: rendering must never apply backpressure to an agent turn. (What happens on the other side of that queue — fine-grained SolidJS signals, no React — is a post of its own.)

### Semaphore: mutual exclusion per key

[efferent](https://github.com/xandreeddev/agent)'s sub-agents are sandboxed to folders, which makes *disjoint* folders safe to run concurrently by construction. Two spawns into the *same* folder would race on the same files — so each folder gets a one-permit semaphore, created on demand:

```ts title="packages/core/src/usecases/folderLock.ts"
export type FolderLocks = Ref.Ref<ReadonlyMap<string, Effect.Semaphore>>

/** Get-or-create the folder's semaphore atomically (unsafeMake is pure). */
const lockFor = (
  locks: FolderLocks,
  folder: string,
): Effect.Effect<Effect.Semaphore> =>
  Ref.modify(locks, (m) => {
    const existing = m.get(folder)
    if (existing) return [existing, m] as const
    const sem = Effect.unsafeMakeSemaphore(1)
    const next = new Map(m)
    next.set(folder, sem)
    return [sem, next] as const
  })

/** Run `effect` holding the folder's exclusive permit. */
export const withFolderLock =
  (locks: FolderLocks, folder: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(lockFor(locks, folder), (sem) => sem.withPermits(1)(effect))
```

`Ref.modify` makes the get-or-create atomic without a mutex around the map. And the file's doc comment owns an honest limitation: ancestor/descendant overlap (a spawn into `pkg/` racing one into `pkg/sub/`) is *deliberately* not locked, because detecting it means holding multiple locks — buying a deadlock risk for a case the prompt already steers away from. Concurrency design is tradeoffs; the primitives just make them small enough to see.

### Ref: shared state that admits it's shared

A `Ref` is an atomic mutable cell. [efferent](https://github.com/xandreeddev/agent) uses one as a spend gate: every sub-agent spawned within a turn drains a single shared token pool —

```ts title="packages/core/src/usecases/tokenBudget.ts"
/** Default pool: 1M tokens per top-level turn across all sub-agents. */
export const DEFAULT_SUB_AGENT_TOKEN_BUDGET = 1_000_000

/** Drain one call's usage from the pool. */
export const drainPool = (
  pool: Ref.Ref<number>,
  u: ContextUsage,
): Effect.Effect<void> =>
  Ref.update(pool, (n) => n - usageCost(u)) // …

/** True when the pool is spent. */
export const poolExhausted = (pool: Ref.Ref<number>): Effect.Effect<boolean> =>
  Ref.get(pool).pipe(Effect.map((n) => n <= 0)) // …
```

— shared, not sliced: children race for the remainder rather than getting pre-committed allocations they might not use. Exhaustion circles back to Act II: a drained pool fails the next spawn with a model-readable `BudgetExhausted` value, and the model finishes the work itself instead of the turn dying.

### FiberRef: ambient context, inherited

A `FiberRef` is fiber-local state that child fibers inherit. [efferent](https://github.com/xandreeddev/agent) threads each agent's identity through one — which is what lets a tool handler built once at the composition root know, at call time, *which* agent in *which* subtree is invoking it:

```ts title="packages/core/src/usecases/runContext.ts"
export interface RunContext {
  readonly rootConversationId: ConversationId | null // null = the top-level run
  readonly parentNodeId: ContextNodeId | null
  readonly depth: number
  readonly tokenPool: Ref.Ref<number> // [!code highlight]
}

export const RunContextRef: FiberRef.FiberRef<RunContext> =
  FiberRef.unsafeMake<RunContext>(initialRunContext)
```

Each spawn re-seeds the ref with `Effect.locally` — parent node, depth + 1 — for exactly the scope of the child's run. The highlighted field is my favorite composition in the codebase: the token pool `Ref` rides *inside* the `FiberRef`. Re-seeding copies the reference, so it's the *same* cell at every depth — a grandchild's spend is instantly visible to the root's gate. Ambient identity plus global accounting, two primitives nested, zero parameters threaded.

### Effect.async + Deferred: parking a fiber on a human

The slowest dependency in a coding agent is the person running it. When a bash command needs approval, the requesting fiber simply parks:

```ts title="packages/cli/src/tui-solid/approval.ts"
const ask = (req: ApprovalRequest) =>
  Effect.async<ApprovalDecision>((resume) => {
    pending = (d) => resume(Effect.succeed(d)) // …
    store.setOverlay({ kind: 'approval', state: openApproval(req) })
    // Interruption (Esc kills the turn): drop the request + close the modal.
    return Effect.sync(() => store.closeOverlay()) // [!code highlight]
  })
```

`Effect.async` adapts callback-world into a fiber: the agent suspends until the overlay's key handler calls `resume`. The highlighted return value is the detail that pays rent — an optional cleanup effect that runs *if the fiber is interrupted while parked*. Esc kills the turn; the modal closes; nothing dangles. A one-permit semaphore in front serializes concurrent requests (parallel sub-agents can want bash at once), and each waiter re-checks the rule ledgers when its turn comes — so one "allow for session" answers the whole queue behind it. The TUI's exit works the same way in miniature: a `Deferred` — a one-shot, fiber-safe promise — that the quit handler completes and the main fiber awaits.

### The unifying semantics: interruption

Press Esc mid-turn and watch what one interrupt does: the in-flight `generateText` HTTP request aborts, the four tool-handler fibers unwind, sub-agent trees stop at safe boundaries, the approval modal's cleanup closes it, semaphore permits release, the call-scoped provider client is disposed by its `Scope`, the eval workspace from the interlude is deleted. I wrote none of that as shutdown code. It falls out of every primitive being a value on the same runtime with the same interruption protocol — which is the real argument for using the toolkit instead of hand-rolling each piece around `AbortController`.

## The service you didn't write

One more consequence of services-as-tags: a *library* can ship the tag and you ship the layer. [efferent](https://github.com/xandreeddev/agent)'s port for the LLM isn't a port I wrote — it's `@effect/ai`'s `LanguageModel` service; the router from earlier is just its live layer. The same package treats tools as schema-typed values:

```ts title="packages/core/src/usecases/codingToolkit.ts"
export const ReadFile = Tool.make('read_file', {
  description:
    "Read a file's contents with line numbers. Use offset/limit to page through large files.",
  parameters: {
    path: Schema.String, // …annotations elided
    offset: Schema.optional(Schema.Number),
    limit: Schema.optional(Schema.Number),
  },
  success: Schema.Struct({
    path: Schema.String,
    content: Schema.String,
    totalLines: Schema.Number,
    truncated: Schema.Boolean,
  }),
  failure: Schema.Struct({ error: Schema.String, message: Schema.String }),
  failureMode: 'return', // [!code highlight]
})
```

`parameters`, `success`, and `failure` are all `Schema` — decoding, validation, and the JSON the provider sees derive from one declaration. Handlers are Effects, supplied through a handler layer at the composition root like any other service, which is why they can demand `FileSystem | Shell | Approval` in their `R` and have the eval environment swap those out from under them. The agent loop, the provider routing, the toolkit: each is the same three channels again at a different altitude.

## What it costs

Stack traces are fiber traces; debugging takes recalibration. The vocabulary is genuinely large — this post used fifteen-odd exports and barely touched `Schedule` or `Stream`. And the type errors when a layer graph is missing a dependency are accurate but not kind.

Against that: every mechanism in Act III is something this program needed anyway. The alternative wasn't simplicity — it was hand-rolled semaphores around a `Map`, an `AbortController` forest, and cleanup paths I'd have gotten wrong in the cases that matter (the interrupt *during* the approval modal, the failure *during* client setup). In Effect, each one is a few dozen commented lines that interrupt correctly because they can't not. A steep vocabulary, for a system where the hard parts are ordinary values.

## Why this is the right substrate for the agent era

Here's the argument I actually care about in 2026: most new code is written with a coding agent in the loop, and the three channels are precisely the three places generated code goes bad. Hidden dependencies — an agent will happily reach for a singleton four imports deep. Swallowed failures — `try/catch` around everything, log and continue. Improvised concurrency — a `Promise.all` with no cancellation story, a boolean pretending to be a lock. None of those are intelligence failures; they're what happens when the language doesn't make structure checkable.

Effect turns each one into something the compiler rejects. A generated function that touches a new service wears it in its `R` — reviewing the change is reading a signature diff, not an archaeology dig through call sites. A swallowed failure doesn't typecheck against an honest `E`, and `never` is a claim the agent has to *earn*, the same way `judgeApproval` earned it above. And because the concurrency primitives are named, composable values, the agent reaches for `Semaphore` and `Queue` instead of inventing either badly — the worst code agents write is bespoke async plumbing, and Effect simply removes the occasion for it.

That changes the feedback loop more than any prompt ever will. Instructions in an agent's context are suggestions; types are enforcement. An agent iterating against `tsc --noEmit` converges on a coherent program *before a human reads it*, because the rails it can't leave are the same properties that make code good: visible dependencies, visible failures, visible concurrency. The biggest factors for crap code, solved at the type level — and unlike a human, an agent never gets tired of satisfying the compiler. That's why [efferent](https://github.com/xandreeddev/agent) is built on Effect, and why the next thing I start will be too.
