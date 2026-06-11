---
title: 'Subscription OAuth is the hard half of multi-provider auth'
description: 'API keys are the easy case. Subscription OAuth — PKCE, refresh races, header shaping — behind the same port.'
pubDate: 2026-06-11
tags: [effect, agents, typescript]
draft: true
---

The auth story in most agent READMEs is one line: set an environment variable, move on. And for a weekend demo that really is the whole story — an API key is a string that never changes, you send it in a header, the meter runs.

It stops being the story the moment real users show up, because the way most heavy users pay for models in 2026 isn't an API key. It's a subscription — Claude Pro/Max, ChatGPT Plus/Pro — and subscriptions don't hand out API keys. They speak OAuth: an access token that dies in hours, a refresh token that rotates when used, an absolute expiry to track, and request shapes the plain API never asks for. An agent that only accepts API keys is quietly telling subscribers to pay for the same models twice.

[efferent](https://github.com/xandreeddev/agent), the coding agent I'm building on Effect, supports five providers — Anthropic, Google, OpenAI, OpenCode, Ollama — which multiplies the problem: several credential shapes, several lifecycles, two full OAuth implementations, and one local provider that needs no secret at all. Most tools special-case whichever flow they personally need and let the rest rot. The pitch of this post is the alternative: **credentials are a domain concept.** Give them one port, make every shape answer the same verb, and the ugliest protocol work in the codebase collapses into two adapter files nobody upstream knows exist. (Which *model* serves a turn is the router's problem and a post of its own — this is the layer underneath it: whether the call may be made at all.)

## Three credential shapes, three lifecycles

Start with what actually has to be stored. An **API key** is the degenerate case: one opaque string, valid until someone revokes it server-side. An **OAuth subscription credential** is three values that only work as a unit — an *access token* (the short-lived proof you attach to requests), a *refresh token* (a long-lived secret whose only job is minting the next access token), and an *expiry* (the moment the access token stops working). And a **local provider** like Ollama, running on your own machine, needs no secret at all — at most a base URL.

That's the entire taxonomy, and [efferent](https://github.com/xandreeddev/agent) writes it down as one union in the core port file:

```ts title="packages/core/src/ports/AuthStore.ts"
export type Credential =
  | { readonly type: 'api_key'; readonly key: string }
  | {
      readonly type: 'oauth'
      readonly access: string // short-lived proof, attached to every request
      readonly refresh: string // long-lived; its only job is minting the next access
      readonly expires: number // absolute expiry, epoch ms // [!code highlight]
      readonly accountId?: string // OpenAI: the ChatGPT account, mined from a JWT
      readonly installationId?: string // OpenAI: a stable per-install id
    }
  /** Local provider (Ollama) — no secret; optional custom base URL. */
  | { readonly type: 'local'; readonly baseUrl?: string }

/** The whole credential map — one entry per configured provider. */
export type AuthData = Partial<Record<Provider, Credential>>
```

The highlighted field is where the engineering lives. `expires` turns a credential from *data* into *state with a lifecycle*: an API key never expires (until revoked), an OAuth pair expires and refreshes on a clock, and any of them can be dead on arrival — a key deleted from a dashboard, a refresh token invalidated by a logout elsewhere. Three lifecycles, one map. Notice also the two optional OpenAI fields riding along: provider quirks show up *in the schema*, on day one, and we'll meet both of them later. The shape diversity isn't an edge case to paper over; it's the actual domain.

## One verb hides the lifecycle: `resolveKey`

A *port*, in the hexagonal sense, is an interface the core owns and adapters implement — the core describes what it needs, never how it's done. [efferent](https://github.com/xandreeddev/agent)'s credential port is an Effect `Context.Tag` (a typed service identifier; the full Effect tour is a post of its own), and its surface is small:

```ts title="packages/core/src/ports/AuthStore.ts"
export class AuthStore extends Context.Tag('@efferent/core/AuthStore')<
  AuthStore,
  {
    /** The full credential map — drives the `:login` provider-status tags. */
    readonly all: Effect.Effect<AuthData>
    /** The raw stored credential for a provider, if any. */
    readonly get: (p: Provider) => Effect.Effect<Credential | undefined>
    /**
     * A usable secret for the provider's API calls — the API key, or a valid
     * OAuth access token (refreshing + persisting first if it's near expiry).
     */
    readonly resolveKey: (
      p: Provider,
    ) => Effect.Effect<Redacted.Redacted | undefined, AuthError> // [!code highlight]
    readonly setApiKey: (p: Provider, key: string) => Effect.Effect<void, AuthError>
    readonly setOAuth: (p: Provider, tokens: OAuthTokens) => Effect.Effect<void, AuthError>
    readonly remove: (p: Provider) => Effect.Effect<void, AuthError>
  }
>() {}
```

`resolveKey` is the whole post in one signature. It doesn't return "the credential" — it returns *a usable secret right now*: the API key as-is, or an OAuth access token that the store has already refreshed and re-persisted if it was near death. `Redacted` is Effect's wrapper for secrets — a value that prints as `<redacted>` in logs and errors, so an access token can't leak through a stack trace. `undefined` means "this provider isn't configured." And the typed `AuthError` is the one failure the lifecycle can't hide: a refresh that's truly dead.

The point of the design is what the *caller* can't do: it cannot tell a forever-key from a token that was three seconds from expiry and got rotated mid-call. Expiry, refresh, persistence — all of it happens behind one verb. Everything else in this post is the work that makes that signature honest.

## auth.json: one file, written carefully

Credentials live in exactly one place: `~/.efferent/auth.json`, a per-provider map written by the in-app `:login` flow.

```json
{
  "anthropic": { "type": "oauth", "access": "…", "refresh": "…", "expires": 1788034022000 },
  "openai": { "type": "api_key", "key": "sk-…" }
}
```

No env vars are read in the product — credentials never enter shell history or process listings, and there's nothing to export before the TUI boots. (The one exception is the eval/CI environment, which swaps in an env-backed adapter because headless runs can't click through a login — one line in the eval layer stack, and that adapter's setters deliberately fail.)

The function that writes this file is six lines, and both halves of its trick matter:

```ts title="packages/adapters/src/auth/local.ts"
const writeAuthFile = (data: AuthData): void => {
  mkdirSync(authDir(), { recursive: true })
  const p = authFilePath()
  const tmp = `${p}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 }) // [!code highlight]
  renameSync(tmp, p)
}
```

**The rename is about your own process dying.** A direct `writeFileSync` onto `auth.json` can be interrupted halfway — power loss, a kill signal — leaving a truncated file. A truncated credential file means *every* provider logs out at once. Writing to a sibling temp file and then `renameSync`-ing over the original makes the swap atomic on POSIX filesystems: readers see the complete old file or the complete new one, never a half-written hybrid.

**The mode is about other users.** `0o600` is owner read/write, nobody else — on a shared box or a misconfigured server, another account can't `cat` your refresh tokens. And the mode is set *at creation of the temp file*, so there's no window where the secrets exist world-readable before a `chmod` lands.

Two different threats, two mechanisms, six lines. Around them sits a small runtime cache: the adapter reads the file once at layer build into a `Ref` (Effect's atomic mutable cell), every mutation writes the file *then* updates the `Ref`, and all reads hit memory. The parse on the way in is deliberately forgiving — malformed entries are dropped rather than thrown on, so a corrupted file degrades to "please log in again" instead of refusing to boot, and the legacy flat-string format from an older version is silently read as an API key.

## `:login`, end to end

The user-facing surface is one command. `:login` opens a picker: *use a subscription (OAuth)* or *use an API key*, then a provider list where each row carries its status — `✓ api key`, `✓ subscription`, or `• unconfigured`. The API-key path is a masked paste and a write. The subscription path is the interesting one.

A design note before the protocol: the flow itself is a pure state machine in the TUI (every keypress returns a new state; effects happen only on the outcome), and the OAuth *protocol* — PKCE, authorize URL, code-for-token exchange — is its own small port, `AuthFlow`, so the TUI driver depends on core rather than on the per-provider adapter internals. The loopback server and the browser-open stay in the driver, because those are terminal edge, not protocol.

### PKCE, because a shipped CLI can't keep a secret

The flow both providers implement is OAuth's *authorization-code* grant. In plain language: the app never sees your password. It sends your browser to the provider's consent page; after you approve, the provider redirects the browser back with a one-time *authorization code*; the app exchanges that code for the real tokens.

The classic version of this assumes the app can authenticate itself with a *client secret*. A CLI can't — it ships to everyone's machine, so any "secret" inside it is public by definition. **PKCE** (Proof Key for Code Exchange) closes that gap: generate a random *verifier*, send only its SHA-256 hash (the *challenge*) with the authorize request, then present the verifier itself at the exchange. A stolen authorization code is useless to an attacker, because the verifier that unlocks it never left your machine.

```ts title="packages/adapters/src/auth/oauth/anthropic.ts"
/** Generate a PKCE verifier + S256 challenge (Web Crypto). */
export const generatePkce = (): Effect.Effect<Pkce> =>
  Effect.promise(async () => {
    const verifierBytes = new Uint8Array(32)
    crypto.getRandomValues(verifierBytes)
    const verifier = base64url(verifierBytes)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    return { verifier, challenge: base64url(new Uint8Array(digest)) }
  })

export const anthropicAuthorizeUrl = (pkce: Pkce): string => {
  const params = new URLSearchParams({
    code: 'true',
    client_id: ANTHROPIC_CLIENT_ID, // the public Claude Code client id — not a secret
    response_type: 'code',
    redirect_uri: 'http://localhost:53692/callback',
    scope: SCOPES, // user:inference user:profile …
    code_challenge: pkce.challenge, // [!code highlight]
    code_challenge_method: 'S256',
    state: pkce.verifier, // echoed back by the callback; checked on return
  })
  return `https://claude.ai/oauth/authorize?${params.toString()}`
}
```

The protocol constants — client id, endpoints, scopes — match the public Claude Code OAuth client, per the adapter's own comments; the client id is public by design, since PKCE is what binds the flow to this machine. The OpenAI sibling file is the same dance with different coordinates: `auth.openai.com`, port 1455, scopes `openid profile email offline_access`.

### The callback race

Now the driver. `begin` hands back the authorize URL plus the callback coordinates; the driver starts a loopback HTTP server bound to `127.0.0.1`, opens the browser, and forks a waiter:

```ts title="packages/cli/src/tui-solid/actions/login.ts"
const begun = yield* authFlow.begin(provider) // fresh PKCE + the authorize URL
const server = startCallbackServer(begun.callbackPort, begun.callbackPath)
yield* shell.exec({ command: browserCommand(begun.authorizeUrl), cwd, timeoutMs: 5_000 })

const waiter = Effect.gen(function* () {
  const { code, state } = yield* Effect.promise(() => server.waitForCode)
  // CSRF / code-injection guard: the callback's `state` must echo the
  // verifier WE generated — otherwise this redirect isn't from the login
  // we started, and the code must not be exchanged.
  if (state !== begun.verifier) { // [!code highlight]
    return yield* failLogin('OAuth state mismatch — run :login again.')
  }
  yield* finishOAuth(store, provider, code, begun.verifier, server.stop)
})
yield* Effect.forkDaemon(waiter) // races the callback against a manual paste
```

Two paths can finish the login, and the fork is why both work. The happy path: the browser hits `localhost`, the server captures `code` and `state`, the waiter proceeds. The headless path: you're SSH'd in, the browser is on another machine — so the same overlay also accepts a *pasted* redirect URL, and whichever side lands first wins.

Both paths are guarded. The waiter rejects any callback whose `state` doesn't echo the verifier — an unsolicited redirect to your loopback port can't trick the app into exchanging an attacker's code. And the paste path refuses to complete when there's no in-flight login at all, because PKCE needs *our* verifier: falling back to a pasted `state` as the verifier would let the paste supply both halves of the proof, which defeats PKCE entirely. The code's comments call both of these out by name; neither check is decorative.

### The exchange, and what lands on disk

`finishOAuth` swaps the code for tokens and persists in one motion. The exchange itself is a plain POST, with one quiet decision in how the expiry is stored:

```ts title="packages/adapters/src/auth/oauth/anthropic.ts"
const data = JSON.parse(text) as {
  access_token: string
  refresh_token: string
  expires_in: number // seconds from now
}
return {
  access: data.access_token,
  refresh: data.refresh_token,
  expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000, // refresh early // [!code highlight]
}
```

The provider says "valid for `expires_in` seconds"; the adapter stores an *absolute* timestamp five minutes shy of the truth. Relative durations rot the moment they're written down — an absolute, deliberately pessimistic expiry means every later check is one subtraction, with a built-in margin for clock drift and slow requests.

`auth.setOAuth` then does the atomic `0600` write from earlier, and — because `resolveKey` is read lazily per request — the credential works **that turn**, no restart. The first login even pins that provider's default model, so the very next message goes somewhere. `:logout <provider>` is the inverse: one entry deleted, same careful write.

## Refresh is lazy — and it's a race

So tokens are on disk with an expiry. Who refreshes them, and when? One school runs a background timer that keeps tokens eternally fresh — more moving parts, and it burns refreshes for sessions that go idle. [efferent](https://github.com/xandreeddev/agent) refreshes *lazily, at the moment of use*: every request resolves its key, and the resolution refreshes only if the token is within a skew window (sixty seconds, on top of the five-minute haircut at mint time) of expiring.

Lazy has a sharp edge, though: requests are **concurrent**. A single agent turn can run four tool calls in parallel and fan out sub-agents, each resolving a key. If the token is near expiry, every one of them decides to refresh — and refresh tokens *rotate*: the exchange returns a new refresh token, and the old one may die. Two concurrent refreshes send the same soon-dead refresh token; both may even succeed, but whichever response is persisted *last* can carry the stale pair — and the user is silently logged out, with nothing to blame in the moment it happened. The fix is a *single-flight* gate — a one-permit semaphore, so at most one refresh is ever in flight — plus a re-check inside it:

```ts title="packages/adapters/src/auth/local.ts"
resolveKey: (p) =>
  Ref.get(ref).pipe(
    Effect.flatMap((d) => {
      const cred = d[p]
      if (cred === undefined) return Effect.succeed(undefined)
      if (cred.type === 'api_key') return Effect.succeed(Redacted.make(cred.key))
      if (cred.type === 'local') return Effect.succeed(Redacted.make('ollama'))
      if (cred.expires - Date.now() > REFRESH_SKEW_MS) {
        return Effect.succeed(Redacted.make(cred.access)) // fresh enough — no IO
      }
      // Near expiry: refresh under the single-flight gate.
      return refreshGate.withPermits(1)( // [!code highlight]
        Effect.gen(function* () {
          const cur = (yield* Ref.get(ref))[p] // re-read INSIDE the gate
          if (cur.type === 'oauth' && cur.expires - Date.now() > REFRESH_SKEW_MS) {
            return Redacted.make(cur.access) // a waiter: the winner already refreshed
          }
          const tokens = yield* refreshFor(p, cur.refresh) // …provider dispatch
          yield* set(p, oauthCredential(p, tokens)) // atomic 0600 persist
          return Redacted.make(tokens.access)
        }),
      )
    }),
  )
```

The choreography under load: ten concurrent calls find the token near expiry and queue on the gate. The first one in refreshes, persists, returns. Each waiter then *re-reads the credential inside the gate*, finds it fresh, and returns immediately — one network round-trip, one rotation, ten satisfied callers. Without the re-read, the gate would merely *serialize* the poisoning instead of preventing it. (The gate is one semaphore across all providers, which the code defends in a comment: a refresh is rare and fast, so the simpler global gate wins. Also worth noticing: `Redacted.make('ollama')` — the local provider returns a dummy secret so the key plumbing stays uniform all the way up.)

Then there's the failure surface. When a refresh genuinely dies — token revoked, subscription lapsed — the store fails with an `AuthError` whose message ends in the actual remedy: *"run `:login <provider>` again."* The router deliberately surfaces this instead of mapping it to "no credential"; its comment notes that masking the failure would read as the model silently vanishing from the picker. A dead refresh is a session-level event that one command fixes, and the error message says which command. That's the difference between a credential *domain* and credential *plumbing*: the failure modes were designed, not discovered.

## Subscriptions reshape the request

Here's the part that surprises people: a subscription credential doesn't just change the secret — it changes the *shape of the request*. An Anthropic API key travels in an `x-api-key` header. An Anthropic subscription token must not; it authenticates as OAuth, with different headers entirely:

```ts title="packages/adapters/src/llm/providers.ts"
// Anthropic OAuth authenticates as a subscription: Bearer + Claude Code
// beta flags, never `x-api-key`.
const anthropicOAuthTransform =
  (access: Redacted.Redacted) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.mapRequest((req) =>
        req.pipe(
          HttpClientRequest.setHeaders({
            Authorization: `Bearer ${Redacted.value(access)}`,
            'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20', // [!code highlight]
          }),
        ),
      ),
    )
```

When the stored credential is OAuth, the provider client is built with `apiKey: undefined` plus this transform — same SDK, same endpoints, different authentication posture, selected per call from the credential's type.

And it goes one layer deeper than headers, into the prompt itself. The adapter's comment states the constraint flatly: *Anthropic rejects OAuth tokens unless the first system block is exactly this.*

```ts title="packages/adapters/src/llm/providers.ts"
export const CLAUDE_CODE_SYSTEM =
  "You are Claude Code, Anthropic's official CLI for Claude."

const claudeCodePrompt = Prompt.make([{ role: 'system', content: CLAUDE_CODE_SYSTEM }])

export const prependClaudeCode = (options: unknown): unknown => ({
  ...(options as Record<string, unknown>),
  prompt: Prompt.merge(claudeCodePrompt, Prompt.make(options.prompt)), // [!code highlight]
})
```

So for subscription traffic — and only subscription traffic — the router prepends that exact system block ahead of [efferent](https://github.com/xandreeddev/agent)'s own system prompt, which rides along as the second block. The provider builder returns a `prependClaudeCode` flag next to the model service, and the router applies the shaping per call. API-key traffic to the same provider is left untouched. The system prompt, it turns out, is part of the authentication surface.

OpenAI's subscription lane is more drastic still: ChatGPT-plan traffic doesn't go to `api.openai.com` at all. It goes to a Codex backend (`chatgpt.com/backend-api/codex`) with its own streaming protocol, a `ChatGPT-Account-ID` header carrying an account id that the login flow mines out of a JWT claim in the access token, and a stable per-install id — the two optional fields you saw in the `Credential` schema back at the start, now earning their keep. In [efferent](https://github.com/xandreeddev/agent) that's an entire bespoke adapter, roughly the size of the auth layer itself. "Support subscriptions" is never one feature; it's one feature per provider, each with its own physics.

## One port, many shapes

Now the payoff. Here is everything the router — the single `LanguageModel` the agent loop talks to — knows about credentials:

```ts title="packages/adapters/src/llm/router.ts"
const resolveAndBuild = (sel: ModelSelection) =>
  Effect.gen(function* () {
    const cred = yield* authStore.get(sel.provider)
    const key = yield* authStore.resolveKey(sel.provider) // [!code highlight]
    const settings = yield* settingsStore.get()
    return yield* makeProviderLanguageModel(sel, key, cred, settings)
  })
```

Per call: read the live model selection, resolve a usable secret, build the provider client, delegate. The agent loop above this sees only `LanguageModel`. The web-search tier and the utility-LLM tier resolve keys through the same port. None of them can distinguish a plain key from an OAuth token that was refreshed, single-flighted, and re-persisted two milliseconds ago — `resolveKey` made the lifecycle invisible, exactly as its signature promised.

One bit does leak, honestly and on purpose: `makeProviderLanguageModel` looks at the credential's *type* to pick the transport — Bearer-plus-beta-flags versus `x-api-key`, Codex backend versus platform API. That's the correct place for the bit to surface, because it's the one function whose entire job is building the HTTP client; the knowledge lives where it's used and nowhere else.

And because resolution is per-request and lazy, two product behaviors fall out for free. `:login` mid-session takes effect on the very next turn — no client is cached against a stale credential, so there's nothing to invalidate. And the eval environment swaps the whole storage story by substituting one layer — env-backed, read-only — while every line of router, loop, and tool code stays identical. The port isn't architecture for its own sake; it's the thing that makes "credentials added live" and "credentials from CI" the same code path.

## What this costs

Honesty section, because this design has real bills attached.

**OAuth flows are provider-fragile.** The endpoints, scopes, beta flags, and client ids in those adapter files mirror each provider's public client — they're observed constants, not a contract. The `anthropic-beta` values are date-stamped strings, which tells you how often this surface moves. A provider can rename a scope, retire an endpoint, or change the required system block, and the adapter breaks until someone updates it. API keys never do this to you.

**Tokens on disk are an attack surface, and `0600` is necessary but not sufficient.** The file mode stops other *users*; it does nothing about other *processes running as you* — any post-install script in any package you ever execute can read `~/.efferent/auth.json`. The tokens are plaintext, not in an OS keychain, and a refresh token is a long-lived credential for everything your subscription can do. That's roughly the industry posture for CLI tools today, which makes it a known tradeoff rather than a solved problem.

**Wire-complete is not live-verified.** The repo's own journey doc is explicit about status: the store contracts and the single-flight refresh structure are covered by tests, the login flow is verified into the TUI up to the credential step, and a live credentialed smoke run exercised real turns — but the full browser OAuth round-trip was still on the "unexercised" list at the time of writing. I'd rather print that sentence than imply a green checkmark the doc doesn't claim.

**N providers means N quirks, forever.** The OpenAI installation-id backfill for old auth files, the JWT account-id extraction, the bespoke Codex transport, the exact-match system block — none of these are temporary scaffolding. They're permanent residents, one set per provider, and every new provider arrives with its own. The port keeps them contained; it cannot make them go away.

## The front door is part of the product

Credentials are the least glamorous layer in an agent and the very first one a user touches. Before your loop loops, before a single tool call streams, somebody has to get a secret into the process — and if the cheapest tokens they already pay for every month can't get through that door, your agent is more expensive than the one that ships `:login`.

So I'll end on the claim the code has been making all along: treat credentials as a domain, not a config value. A config value is a string you read at startup. A domain has shapes (three of them), lifecycles (three of those too), concurrency hazards (one semaphore's worth), failure modes with named remedies, and a port that compresses all of it into one verb the rest of the system calls without thinking. The README line `export ANTHROPIC_API_KEY=…` was never the auth story — it was the demo's placeholder for one. The real story is a small, careful machine, and the best thing about putting it behind a port is that nobody else in the codebase ever has to know how interesting it was.
