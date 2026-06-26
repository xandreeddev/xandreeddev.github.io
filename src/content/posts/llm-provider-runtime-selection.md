---
title: 'Your LLM provider is state, not architecture'
description: 'Provider choice is request-scoped state — one LanguageModel that re-resolves model, credential, and client per call.'
pubDate: 2026-06-06
tags: [effect, ai, agents]
series:
  name: 'Building a coding agent'
  order: 3
---

A terminal agent has a feature so small that nobody puts it on a feature list: you type `:model`, pick a different model — maybe a different *company's* model — and the next message just goes there. Mid-session, mid-conversation, no restart. You type `:login anthropic`, finish the OAuth dance in a browser tab, and the very next turn runs on your Claude subscription. Nothing rebuilt, nothing reloaded, no "please restart to apply changes."

If you build on Effect — or honestly on any dependency-injection setup — the *natural* way to wire an LLM provider makes that feature impossible. This post is about why, and about the surprisingly small amount of code that makes it trivial instead. The sentence to keep is the title: **provider choice is request-scoped state, not architecture.** Everything below is that sentence applied twice — once to providers, then again, one level up, to model roles.

The receipts come from [efferent](https://github.com/xandreeddev/efferent), a coding agent built on Effect.ts that routes a single conversation across Anthropic, Google, OpenAI, OpenCode, and a local Ollama — switching between them live, without ever rebuilding its runtime.

## The idiomatic answer answers the wrong question

Quick vocabulary, because the whole argument turns on it. In Effect, a **service** is an interface declared as a typed key (`Context.Tag`) with no implementation attached; a **layer** is a recipe that supplies the implementation; and the **composition root** is the one place — the program's entry point — where layers get assembled and provided. The deep semantics of all that are a post of its own; the conclusion that matters here is one line from it: *layers answer "the program is different"; state answers "the request is different."*

For LLMs, the service already exists — `@effect/ai` ships a `LanguageModel` tag with `generateText`, `streamText`, and `generateObject` — and each provider package ships a layer for it. So the standard multi-provider answer writes itself, and it's the one I shipped first:

```ts
// composition root, take one
const ModelLive =
  config.provider === 'google'
    ? GoogleLanguageModel.model('gemini-…')
    : AnthropicLanguageModel.model('claude-…')

const AppLive = Layer.mergeAll(ModelLive, StoresLive /* … */)
```

This is clean, idiomatic, and wrong — not broken-wrong, *question*-wrong. Layers are resolved when the runtime is built, which happens once, at startup. They are the right tool when the program itself is different: a test run, an eval run, CI. But a user sitting in the TUI who types `:model` and picks a different provider is not running a different program. They're expressing a preference, mid-session, and they expect the next message to honor it. Same for `:login`: writing a credential to disk should change what the *next call* can do, not what the next *process* can do.

Bind that preference into the layer graph and the only way to honor a change is to tear the graph down and rebuild it — which in practice means a restart. A restart to switch models is roughly the moment a terminal tool stops feeling native.

So the design goal, stated precisely: keep the single `LanguageModel` service (the agent loop should never know providers exist), but move *which provider backs it* out of the wiring and into state that gets read on every call.

## "The current model" is a value you can read

Step one is making the selection itself a first-class thing. A **selection** is just a provider name plus the provider's own model id — that's all routing needs:

```ts title="packages/sdk-core/src/entities/Model.ts"
export type Provider = 'google' | 'openai' | 'anthropic' | 'opencode' | 'ollama'

export interface ModelSelection {
  readonly provider: Provider
  readonly modelId: string
  readonly contextWindow: number // display only — the status-bar gauge
}
```

[efferent](https://github.com/xandreeddev/efferent)'s core declares a `ModelRegistry` service around it:

```ts title="packages/sdk-core/src/ports/ModelRegistry.ts"
export class ModelRegistry extends Context.Tag('@efferent/core/ModelRegistry')<
  ModelRegistry,
  {
    /** The model the loop should use right now. */
    readonly current: Effect.Effect<ModelSelection> // [!code highlight]
    /** Live, chat-capable models for every provider with a credential. */
    readonly list: Effect.Effect<ReadonlyArray<ModelInfo>, ModelListError>
    /** Switch the active model and persist the choice. */
    readonly select: (info: ModelInfo) => Effect.Effect<ModelSelection>
  }
>() {}
```

The implementation detail that makes everything downstream trivial: `current` is not a cache. The selection is persisted in the settings store as a single `'<provider>:<modelId>'` string; `select` writes that string; `current` parses it back out on every read. There is no in-memory copy to invalidate, so "the `:model` switch applies on the next message" isn't a synchronization feature anyone built — it's the absence of a cache to get stale. (`list` is fetched live from each provider's models endpoint and is key-gated: a provider you haven't logged into simply contributes nothing to the picker.)

## The router: built once, decides every call

Now the centerpiece. The live layer for `LanguageModel` is still a layer — built once, like any other — but what it builds is a **router**: a service whose every method defers the provider decision to the moment it's called.

```ts title="packages/sdk-adapters/src/llm/router.ts"
export const RouterLanguageModelLive = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    const registry = yield* ModelRegistry
    const authStore = yield* AuthStore
    const settingsStore = yield* SettingsStore
    const http = yield* HttpClient.HttpClient // shared; provided to every build

    // Everything provider-specific is resolved HERE, once per call:
    const resolveAndBuild = (sel: ModelSelection) =>
      Effect.gen(function* () {
        const cred = yield* authStore.get(sel.provider)
        const key = yield* authStore.resolveKey(sel.provider) // may refresh OAuth
        const settings = yield* settingsStore.get()
        return yield* makeProviderLanguageModel(sel, key, cred, settings)
      })

    const service: LanguageModel.Service = {
      generateText: (options) =>
        registry.current.pipe( // [!code highlight]
          Effect.flatMap((sel) =>
            resolveAndBuild(sel).pipe(
              Effect.flatMap(({ svc }) => svc.generateText(options)), // …prompt shaping elided
            ),
          ),
          Effect.scoped,
        ),

      streamText: (options) =>
        Stream.unwrapScoped(
          registry.current.pipe(
            Effect.flatMap((sel) =>
              resolveAndBuild(sel).pipe(
                Effect.map(({ svc }) => svc.streamText(options)),
              ),
            ),
          ),
        ),

      // generateObject: same shape as generateText
    }
    return service
  }),
)
```

Three things to read out of that, in order.

**The layer body runs once.** It captures four dependencies — registry, credentials, settings, an HTTP client — and none of them is a provider. The expensive, shared thing (the platform HTTP client) lives at layer scope; everything cheap and decision-shaped happens later.

**Every method starts with `registry.current`.** The highlighted line is the whole thesis in code: the selection is consulted at the last possible moment, inside the call, so there is no window in which a stale choice can be in flight. `:model` writes settings; the next `generateText` reads them. Done.

**The `scoped` suffixes are doing real work.** A `Scope` is Effect's reified resource lifetime — acquire things into it, and when it closes, every finalizer runs, on success, failure, *or interruption* (the full semantics are a post of its own). `Effect.scoped` closes that lifetime when the one call ends; `Stream.unwrapScoped` does the same for a streaming response (a `Stream` is Effect's async sequence — here, the token stream), keeping the scope open exactly as long as the stream and not a tick longer. The provider client built by `resolveAndBuild` lives inside that scope, so it exists for precisely one call. Nothing anywhere holds a client for a provider you switched away from; "request-scoped" isn't a comment, it's the type.

### Credentials resolve at the same moment

The same late-binding move applies to secrets. `:login` runs an interactive flow — paste an API key, or complete a real OAuth authorization — and writes the result to `~/.efferent/auth.json`. The store's interface is small:

```ts title="packages/sdk-core/src/ports/AuthStore.ts"
export type Credential =
  | { readonly type: 'api_key'; readonly key: string }
  | {
      readonly type: 'oauth' // a subscription (Claude Pro/Max, ChatGPT)
      readonly access: string
      readonly refresh: string
      readonly expires: number // absolute expiry, epoch ms
    }
  | { readonly type: 'local'; readonly baseUrl: string | null } // Ollama: no key at all

export class AuthStore extends Context.Tag('@efferent/core/AuthStore')<
  AuthStore,
  {
    readonly get: (p: Provider) => Effect.Effect<Credential | null>
    /**
     * A usable secret for the provider's API — the API key, or a valid
     * OAuth access token, refreshing + persisting it FIRST if it's near
     * expiry. Null when the provider has no credential.
     */
    readonly resolveKey: (p: Provider) => Effect.Effect<Redacted.Redacted | null, AuthError> // [!code highlight]
    // … setApiKey / setOAuth / setLocal / remove (`:logout`)
  }
>() {}
```

`resolveKey` is where laziness pays twice. First, the obvious way: because the router calls it per request, a credential added mid-session is simply *there* on the next read — `:login` works on the next turn for the same non-reason that `:model` does. Second, OAuth: access tokens expire on the order of hours, so `resolveKey` checks the expiry and runs the refresh exchange before answering. Refresh tokens rotate when used, which makes a concurrent double-refresh actively destructive — so the live implementation puts the refresh behind a single-flight gate: the first caller refreshes and persists, queued callers re-read and find the fresh token waiting. (`Redacted` is Effect's wrapper for secrets — a value that renders as `<redacted>` in logs and traces instead of leaking.)

The eval and CI environments swap this one layer for an env-var-backed store, because headless runs can't click through OAuth. Note what kind of difference that is: a different *program*. That swap is a layer's job, and it stays one.

### One function, one provider, one call

`resolveAndBuild` bottoms out in a single function whose entire job is: given a selection, a secret, a credential, and the current settings, construct the chosen provider's `@effect/ai` service — into the surrounding scope, for one call.

```ts title="packages/sdk-adapters/src/llm/providers.ts"
export const makeProviderLanguageModel = (
  sel: ModelSelection,
  key: Redacted.Redacted | null,
  cred: Credential | null,
  settings: Settings,
) => {
  const oauth = cred?.type === 'oauth'
  switch (sel.provider) {
    case 'google':
      return GoogleClient.make({ apiKey: key }).pipe(
        Effect.flatMap((client) =>
          GoogleLanguageModel.make({
            model: sel.modelId,
            config: { generationConfig: { thinkingConfig: googleThinking(sel.modelId, settings.geminiThinkingLevel) } },
          }).pipe(Effect.provideService(GoogleClient.GoogleClient, client)),
        ),
      )
    case 'anthropic':
      return AnthropicClient.make(
        oauth
          ? { apiKey: null, transformClient: bearerAuth(key) } // subscription: Bearer header, never x-api-key // [!code highlight]
          : { apiKey: key },
      ).pipe(/* … same shape: make the model, provide the client */)
    // 'openai' | 'opencode' | 'ollama' — same pattern, different SDK
  }
}
```

Five providers, one `switch`, and each branch is allowed to be as weird as its provider actually is, because the weirdness is contained to one arm:

- **Reasoning knobs don't normalize, so don't pretend.** Anthropic's "extended thinking" wants a token budget (the settings tiers map to 1k/2k/3k `budget_tokens`); Gemini 3 wants a discrete `thinkingLevel` of LOW/MEDIUM/HIGH while older Gemini models want token budgets; OpenAI wants a reasoning `effort` and only on model families that support it. Each branch reads its own settings key (`anthropicThinkingEffort`, `geminiThinkingLevel`, `openAiReasoningEffort`) — and reads it *now*, at build time, which is call time. Changing an effort setting mid-session obeys the same contract as everything else: next call, new behavior.
- **Auth shape is per-provider too.** An Anthropic OAuth credential is a Claude subscription, and subscriptions don't authenticate like API keys: the highlighted branch builds the client with no API key at all and a transform that stamps `Authorization: Bearer …` plus Anthropic's OAuth beta header onto every request. An OpenAI OAuth credential (a ChatGPT plan) routes through a different transport entirely. Ollama needs no key — its `local` credential just carries an optional base URL to your own machine.

The result rides back to the router along with one boolean (whether the Claude-subscription system block must be prepended), and the client is gone when the scope closes.

### Per-call shaping: where provider quirks live

Between building the provider and invoking it, the router gets one last hook — and per-call routing means per-call shaping comes for free:

```ts title="packages/sdk-adapters/src/llm/router.ts"
const shapeOptions = <O>(sel: ModelSelection, shouldPrepend: boolean, options: O): O => {
  let shaped: unknown = options
  if (shouldPrepend) shaped = prependClaudeCode(shaped) // the system block Claude subscriptions require
  if (sel.provider === 'anthropic') shaped = withAnthropicCacheBreakpoints(shaped) // [!code highlight]
  return shaped as O
}
```

The highlighted line earns its place: Anthropic's prompt caching is opt-in per request — send no `cache_control` markers and it caches *nothing* — so the router stamps breakpoints onto each outgoing Anthropic call right here (where the markers go and why moving them every turn doesn't invalidate anything is a post of its own). The point for this post is architectural: per-request routing didn't preclude provider-specific behavior. It gave it exactly one place to live.

## Opaque state is where multi-provider abstractions die

Everything so far is the happy path, and multi-provider abstractions don't die on the happy path. They die on this: **providers attach private state to messages and expect to get it back.**

The sharpest example is Gemini. Its thinking models return a `thought_signature` — a signed blob attached to reasoning and tool-call parts — and expect it echoed back on the next turn. Drop it and, at best, the model loses its reasoning thread; on tool calls, the API can reject your history outright. If your conversation type normalizes everything down to `{ role, content }` — which is the first thing every well-meaning abstraction does — you have silently destroyed provider state you didn't know existed, and you'll discover it as a confusing 400 three turns later.

So [efferent](https://github.com/xandreeddev/efferent)'s persisted message schema gives every content part a slot that core *never reads*:

```ts title="packages/sdk-core/src/entities/Conversation.ts"
export const ReasoningPart = Schema.Struct({
  type: Schema.Literal('reasoning'),
  text: Schema.String,
  providerOptions: Schema.optional(Schema.Unknown), // [!code highlight]
})

export const ToolCallPart = Schema.Struct({
  type: Schema.Literal('tool-call'),
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: Schema.Unknown,
  providerOptions: Schema.optional(Schema.Unknown),
})

export const AssistantMessage = Schema.Struct({
  role: Schema.Literal('assistant'),
  content: Schema.Array(Schema.Union(TextPart, ReasoningPart, ToolCallPart)),
  providerOptions: Schema.optional(Schema.Unknown),
})
```

`Schema.Unknown` is the type-level version of a promise: core stores this, persists it, and hands it back, but never branches on it. The mapping layer that converts between persisted messages and `@effect/ai` prompts carries the blob verbatim in both directions — message `providerOptions` becomes prompt-part options on the way out, response-part metadata becomes `providerOptions` on the way back in. That round-trip is deliberate enough that [efferent](https://github.com/xandreeddev/efferent) skips the framework's own convenience converter, which drops response metadata, and maps the parts by hand purely to keep the blob alive.

And the blob is namespaced by provider — `{ google: { … } }`, `{ anthropic: { … } }` — so exactly one adapter ever looks inside its own key. Gemini's signatures ride past the Anthropic adapter as inert luggage; nobody else can develop an opinion about them. An abstraction is allowed to have a hole in it, as long as the hole is typed and exactly one party looks inside.

The hole turned out to be useful enough that [efferent](https://github.com/xandreeddev/efferent) claims a namespace of its own: after each turn, the API-reported token usage is stowed under `providerOptions.efferent` on the assistant message, so resuming a session days later can rebuild the spend gauge by scanning the transcript instead of replaying anything. Opaque-to-core, meaningful-to-one-reader is a pattern, not a workaround.

## Failures that name the fix

Moving resolution from startup to request time moves *failure* there too, and that's a UX decision hiding inside an architecture decision. A layer that can't build fails loudly at startup, when a stack trace is acceptable. A per-request resolution that fails does so mid-conversation, where a provider SDK's stack trace is the worst possible answer.

The failure that actually happens is the credential one: `resolveKey` fails when an OAuth refresh dies — token revoked, subscription lapsed, refresh token consumed by another machine. The router refuses to soften it:

```ts title="packages/sdk-adapters/src/llm/router.ts"
const key = yield* authStore.resolveKey(sel.provider).pipe(
  Effect.mapError((e) =>
    new AiError.UnknownError({
      module: 'Router',
      method: 'resolveKey',
      description: e.message, // 'OAuth token refresh failed (…) — run :login anthropic again.' // [!code highlight]
    }),
  ),
)
```

Two deliberate choices in five lines. First, this *fails* rather than degrading to "no credential" — masking a dead refresh as a missing key would read as the model silently vanishing from the session, which is the kind of bug users can't even report coherently. Second, the message is composed where the knowledge is: the auth store is the only component that knows this was a refresh failure and knows the remedy, so the `AuthError` it raises carries the literal instruction — `run :login <provider> again` — and the router just forwards it into the error type every mode (TUI, one-shot, JSON-RPC) already renders. The user sees a sentence telling them what to type. The error channel as product surface, not plumbing.

## Roles: the same move, one level up

Here's the part that wasn't in the first version of this design. A real agent makes far more LLM calls than it has chat turns. Inside a single turn of [efferent](https://github.com/xandreeddev/efferent): a tool dumps forty thousand tokens of build output and a model digests it down; a bash command needs a safety verdict before the approval dialog decides whether to interrupt the human. In the background: every session gets titled after its first exchange. Run all of that on your big model and you pay frontier prices and frontier latency for jobs a small model does fine. Hardcode a small model's id somewhere and you've recreated the original sin — a model choice baked into the program.

The answer is a tiny vocabulary of **roles** — and roles are the thesis again, applied at a second level:

```ts title="packages/sdk-core/src/entities/Model.ts"
export type ModelRole = 'general' | 'code' | 'fast'

/** code/fast → general when unset. The single place the chain lives. */
export const modelForRole = (settings: RoleModelSettings, role: ModelRole): string => {
  switch (role) {
    case 'general':
      return settings.model
    case 'code':
      return settings.codeModel ?? settings.model // [!code highlight]
    case 'fast':
      return settings.fastModel ?? settings.model
  }
}
```

The semantics, in one breath each. **general** is the default agentic tier — the root conversation *and* the research, analysis, and planning sub-agents, because delegation changes the context, not the brain. **code** is the same agentic work narrowed to one job: sub-agents that *write* code, so you can put a coding-tuned model behind the edits while reasoning stays on `general` — a routing decision earned from evals that's a post of its own. **fast** does the latency-sensitive and background helper calls — the compression digests, the approval judgments, the session titles (each a post of its own) — quick jobs where a round-trip on the agentic tier would visibly drag the run or just burn frontier price on nothing. The highlighted fallback is the zero-config story: an unset role follows `general`, so the capability exists before anyone configures it.

One-shot helper calls reach their tier through a deliberately tiny doorway — `UtilityLlm.complete(prompt, { role })`, a prompt in, a completion out — and its live implementation is the router's logic replayed almost line for line:

```ts title="packages/sdk-adapters/src/llm/utilityLlm.ts"
const complete = (prompt: string, options?: { role?: 'fast' }) =>
  Effect.gen(function* () {
    const role = options?.role ?? 'fast'
    const settings = yield* settingsStore.get()
    const sel = roleIsConfigured(settings, role)
      ? selectionFromString(modelForRole(settings, role)) // [!code highlight]
      : yield* registry.current // unset → follow the LIVE general selection
    const cred = yield* auth.get(sel.provider)
    const key = yield* auth.resolveKey(sel.provider) // same lazy OAuth refresh
    const { svc } = yield* makeProviderLanguageModel(sel, key, cred, settings)
    const res = yield* svc.generateText({ prompt: Prompt.make([{ role: 'user', content: prompt }]) })
    return { text: res.text, usage: extractUsage(res.usage, res.content) }
  }).pipe(Effect.scoped) // the provider client lives exactly this one completion
```

Settings read at call time, role resolved through the one fallback chain, credential resolved with the same refresh semantics, provider built into a one-call scope. Which means the helper tiers inherit the liveness contract for free: `:model fast` (the same live picker, scoped to a role) or a `:login` takes effect on the next helper call, no rebuild, exactly like the chat path. If provider choice had stayed a layer, each role would have needed its own slice of the layer graph and its own restart story. As state, a role is one string read.

Roles also turn out to be the durable axis for *accounting*. Because every completion reports its usage, the TUI accumulates billed tokens per role — the root conversation and reasoning sub-agents land on `general`, code-writing sub-agents on `code`, helper calls on `fast` — and renders a running ledger in the activity pane: `Σ general 64k · code 12k · fast 1.2k`. That line is the fast-tier argument made empirical: thousands of helper tokens that cost effectively nothing because they went to a model priced for it. And it's stable vocabulary in a way model names can never be — you can swap every provider tomorrow and `fast` still means "the one that keeps turns snappy," in the settings keys, in the picker, and in the ledger.

One small asymmetry worth noticing: the router stamps Anthropic cache breakpoints only on the agentic (`general`/`code`) chat path. Helper calls are one-shot prompts that will never be reused, and Anthropic charges a premium to *write* cache entries — so the `fast` tier deliberately skips the stamping. A per-call seam makes even that distinction one `if` instead of a configuration system.

## What layers are still for

None of this dethrones layers; it relocates them to the question they actually answer. [efferent](https://github.com/xandreeddev/efferent)'s unit tests provide a *scripted* `LanguageModel` — `Effect.provideService(LanguageModel.LanguageModel, scripted)` — and run the entire agent loop against canned responses, asserting on tool dispatch and malformed-call recovery with zero network involved. That's a different program, so it's a layer swap, made at composition like every layer swap. The eval suites go the other way and keep the live router with real credentials around in-memory stores, because their whole purpose is judging real model behavior. Both substitutions happen at a composition root; neither happens mid-session. Layers pick which *world* the program runs in; state picks which *model* answers the next message. Confusing the two is how you end up restarting your agent to honor a dropdown.

## What it costs

The honest ledger, because this design isn't free.

**The seam is type-hostile at the edges.** `shapeOptions` juggles `unknown` and casts back to its generic; the error-widening in `resolveKey` needs an `as never` because the options' generic error parameter can't be widened from inside the router's signature. Both casts are commented and contained, but they're casts — the price of routing underneath `@effect/ai`'s generics rather than above them.

**Per-call construction is cheap, not free — and it's a commitment.** Building a provider service per call costs almost nothing here because the heavy thing (the HTTP client) is shared and the wrapper is configuration. But the design forbids any client-level state surviving between calls; a provider SDK that wanted a warm session handle would fight this architecture, and the architecture would have to win.

**Switching mid-conversation is cheap, not lossless.** The router makes the *switch* instant; it cannot make the new provider accept history it didn't write. Gemini rejects prior non-Gemini tool calls that lack its `thought_signature` — a hard 400 — so [efferent](https://github.com/xandreeddev/efferent) surfaces a one-line hint when you switch providers mid-conversation, and the honest escape hatch is `/reset`. The opaque-state slot preserves each provider's luggage; it can't conjure luggage that never existed.

**Every call re-reads settings and credentials.** Against local JSON files this is unmeasurable. But it's a real constraint: move those stores onto a network and you'd suddenly want the cache this design's correctness comes from not having.

## The dropdown test

Every knob in a system should be interrogated once, early: *would a user expect to change this while the program is running?* If no — the database engine, the approval policy in CI — bind it early, make it a layer, and enjoy startup-time failures and compiler-checked wiring. If yes, it's state, and the only honest implementation is the one that reads it at the last possible moment, every time, with the failure message written for the person who'll see it.

Model choice answers the question instantly. Nobody has ever wanted to restart a tool to change models; every chat product on earth ships the dropdown. What's strange is how much agent infrastructure still treats the provider as load-bearing architecture — frozen at startup, threaded through constructors, swapped only by redeployment — when the entire job was: one router that re-reads a string, one credential store that refreshes lazily, one opaque slot that round-trips what it doesn't understand. That's the whole bill for never having to care which company answers the next message. Pay it on day one, because the version of you that's three providers deep will not enjoy the refactor — and the user typing `:model` will never know there was anything to get right.
