---
title: 'Retry is not a policy'
description: 'Five classes of provider failure — transient, quota, config, auth, model — and a failover that only ever lands on a model the human configured.'
pubDate: 2026-09-25
tags: [agents, effect, ai]
draft: true
series:
  name: 'Building a coding agent'
  order: 14
---

Here are five ways a model call died in [efferent](https://github.com/xandreeddev/efferent)'s run forensics — the ten days of fleet runs (376 spawned nodes, 29% of them ending in error; 56% on the worst day) that kicked off a self-healing rework:

- a 429 whose `Retry-After` header said `48489` — thirteen and a half hours, the seconds until the gateway's midnight-UTC quota reset
- `CreditsError: Insufficient balance`
- a 400 reading `invalid thinking: only type=enabled is allowed for this model`
- a 404 from `api.anthropic.com/v1/messages?beta=true`
- a reply that arrived fine and failed to decode

In the record, all five wore the same face: node died, provider call failed. And the runtime had the same two reactions on offer for every one of them: retry in place, or give up.

That menu is the bug. **"Retry" is a verb, not a policy** — a policy is knowing *which failures get which verb*. A 429 asking for a twenty-second wait, a 429 asking for a thirteen-hour wait, an expired credential, and a model emitting garbage are four different failures wanting four different reactions, and classifying them is what makes automatic failover safe instead of chaotic. This post is the classifier that landed as phase four of that rework, and the failover built on it — whose most interesting property is a restraint: it never lands on a model the human didn't configure.

It builds on the [per-call provider router](/posts/llm-provider-runtime-selection/) that decides which model answers each call, and on the [role vocabulary](/posts/model-roles-code-tier/) — `general` / `code` / `fast` — that decides which *job* each call is. Both seams are load-bearing here.

## Five names for a dead call

The whole taxonomy is one pure function in core. Given a failure from the LLM layer, it answers the only question the runtime needs: retry, fail over, or surface?

```ts title="packages/sdk-core/src/usecases/classifyProviderError.ts"
export type ProviderDefectClass = 'transient' | 'quota' | 'config' | 'auth' | 'model'

/** Honor a provider's Retry-After only up to this; longer ⇒ quota. */
export const QUOTA_RETRY_AFTER_MS = 60_000

const QUOTA_BODY =
  /insufficient\s+balance|credits?err|out of credits|usage limit|quota exceeded|billing/i

export const classifyProviderError = (
  e: unknown,
  nowMs = Date.now(),
): ProviderDefectClass | undefined => {
  if (!AiError.isAiError(e)) return undefined
  switch (e._tag) {
    case 'HttpResponseError': {
      const status = e.response.status
      const body = `${e.body ?? ''} ${e.description ?? ''}`
      if (status === 401 || status === 403) return 'auth'
      if (status === 402 || QUOTA_BODY.test(body)) return 'quota'
      if (status === 429) {
        const retryAfter = parseRetryAfterMs(e.response.headers['retry-after'], nowMs)
        // A multi-hour wait is a quota wall, not a blip. // [!code highlight]
        return retryAfter !== undefined && retryAfter > QUOTA_RETRY_AFTER_MS
          ? 'quota'
          : 'transient'
      }
      if (status === 400 || status === 404 || status === 422) return 'config'
      if (TRANSIENT_STATUS.has(status)) return 'transient' // the retryable 5xx
      return undefined
    }
    case 'HttpRequestError':
      return 'transient' // transport — the request never got an answer
    case 'MalformedOutput':
      return 'model' // an answer arrived; it couldn't be decoded
    case 'UnknownError': // the custom adapters stringify their cause here
      return QUOTA_BODY.test(e.description)
        ? 'quota'
        : transientText(e.description)
          ? 'transient'
          : undefined
    default:
      return undefined // anything novel: no classification beats a false one
  }
}
```

One breath per class. **transient** — the request was fine, the provider couldn't serve it *now*: a plain 429 ("engine overloaded"), a retryable 5xx, a reset socket, a timeout. Retried in place, with visible backoff. **quota** — the account is out of budget for *hours*: an insufficient-balance or usage-limit body, a 402, or the interesting one, a 429 whose `Retry-After` exceeds a one-minute honor ceiling. Retrying in place is pointless; this is the failover class. **config** — the *request* is invalid for this model or provider: an invalid-param 400, a 404 endpoint. Also failover — the run gets a working model while the human fixes the setting. **auth** — 401, 403, a revoked credential. Surfaces, always. **model** — the model emitted something undecodable. Classified for observability, but the router keeps its hands off it; we'll get to why.

The highlighted branch is the thesis in miniature: *a 429 is not one thing.* The status code says "come back later"; only the header says whether "later" means twenty seconds or tomorrow. The retry layer already refused to sleep on the long ones — an earlier fix clamped honored waits at sixty seconds, after a node spent hours parked on that `48489` — but refusing to sleep just converted a frozen node into a dead one. The classifier gives the long wait its real name, `quota`, so something smarter than dying can happen.

And the fixtures pinning each class aren't invented. The test file opens with its own provenance note — *"Real forensic fixtures: every class below anonymously killed nodes in the July run data before the taxonomy existed"* — and reads like a war diary:

```ts title="packages/sdk-core/src/usecases/classifyProviderError.test.ts"
test('quota: the opencode daily-quota 429 (multi-hour Retry-After) — the value that must NOT retry in place', () => {
  // "48489" seconds ≈ 13.5h until the midnight-UTC reset.
  expect(classifyProviderError(httpError(429, { 'retry-after': '48489' }), NOW)).toBe('quota')
  // …while a short server-suggested wait stays transient.
  expect(classifyProviderError(httpError(429, { 'retry-after': '20' }), NOW)).toBe('transient')
})

test('config: the kimi invalid-thinking 400 and the anthropic ?beta=true 404', () => {
  expect(
    classifyProviderError(
      httpError(400, {}, 'invalid thinking: only type=enabled is allowed for this model'),
      NOW,
    ),
  ).toBe('config')
  expect(classifyProviderError(httpError(404), NOW)).toBe('config')
})
```

`GoUsageLimitError: Weekly usage limit reached. Resets in 7hr 49min` is in there too, verbatim, classified `quota` off the body regex. Every string in that file cost a real run to learn.

## One classification, two consumers

The taxonomy would be worth having for the names alone, but the design point is who reads it. Before this landed, the retry layer had a private transient sniffer — its own status set, its own text matching — and the router had no opinion at all. Now the sniffer is one line:

```ts title="packages/sdk-adapters/src/llm/retry.ts"
/** Worth retrying in place? Exactly the `transient` class of the shared taxonomy. */
export const isTransientAiError = (e: AiError.AiError): boolean =>
  classifyProviderError(e) === 'transient'
```

The in-place retry consumes the `transient` class; the router's failover consumes `quota` and `config`. One classification, two consumers — which means the two policies *can't drift*: no failure can be simultaneously "worth retrying here" and "worth abandoning this provider over," because both decisions are the same function's answer read at different call sites.

## One retry, on a model you chose

Here's the failover, in the router — wrapped around the same per-call resolution the [provider-selection post](/posts/llm-provider-runtime-selection/) built:

```ts title="packages/sdk-adapters/src/llm/router.ts"
// The failover selection for a PERSISTENT provider defect: the code role falls
// back to the run's pinned GENERAL model; the general role to the human-
// configured Settings.fallbackModel. Never a model the agent chose, never the
// same selection that just failed; undefined ⇒ no failover.
const fallbackSelection = (sel: ModelSelection) =>
  Effect.gen(function* () {
    const rc = yield* FiberRef.get(RunContextRef)
    const role = rc.modelRole ?? 'general'
    const raw =
      role === 'code'
        ? (rc.pinnedModels?.general ?? (yield* settingsStore.get()).fallbackModel) // [!code highlight]
        : (yield* settingsStore.get()).fallbackModel
    if (raw === undefined) return undefined
    const fb = selectionFromString(raw)
    return fb.provider === sel.provider && fb.modelId === sel.modelId ? undefined : fb
  })

const withFailover = <A, E, R>(
  sel: ModelSelection,
  attempt: (s: ModelSelection) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  attempt(sel).pipe(
    Effect.catchAll((e) => {
      const cls = classifyProviderError(e)
      if (cls !== 'quota' && cls !== 'config') return Effect.fail(e) // [!code highlight]
      return fallbackSelection(sel).pipe(
        Effect.flatMap((fb) =>
          fb === undefined
            ? Effect.fail(e)
            : announce(sel, fb, cls).pipe(Effect.zipRight(attempt(fb))),
        ),
      )
    }),
  )
```

Mechanically it's small: on a `quota` or `config` defect, retry the call *once* on a fallback selection. Both attempts carry the full armor underneath — the request timeout, the transient in-place retries — so a fallback that hits a blip of its own still gets a fair shot.

The design decision is `fallbackSelection`, and it's role-scoped on purpose. A tier is a promise about capability. When the human set `codeModel`, they declared "this model may write my diffs" — and the role system's own fallback chain, `codeModel ?? model`, already declares that the general model is trusted with every job the code tier does. So when the code role hits a quota wall, falling back to *the run's pinned general model* never crosses the human's intent: a model the human already chose, for a superset of the job, frozen at run start like [every pinned selection](/posts/model-roles-code-tier/). The general role has no senior tier above it, so its fallback must be explicit — the new `fallbackModel` setting (`:set fallbackModel <provider>:<modelId>`), which fires only on a persistent defect, once, loudly annotated. Unset means no failover; the error surfaces. That's the right zero-config default — an escape hatch you didn't install shouldn't open.

Underneath both branches, one rule: **failover only ever lands on a model the human configured.** Never one the agent chose — a running agent still never picks its own model, quota wall or not — and never the selection that just failed (the last guard in `fallbackSelection` refuses a fallback equal to the failed selection, so a misconfigured `fallbackModel` can't produce a doomed second attempt on the same dead account).

The arc from the forensics is worth naming. The old clamp turned a 13.5-hour sleep into a fast failure so *the human* could type `:model` and move the run to a model they trusted. Phase 4 automates exactly that human move — switch once, to a pre-approved model — and nothing more. The automation inherits the human's judgment instead of replacing it.

## Loud, not silent

A failover that works too quietly is its own failure mode: a run that secretly succeeded on a different model poisons everything you conclude from it — the per-role spend ledger, any model-comparison eval, your own sense of which model earned the win. So the failover announces itself on three surfaces before the fallback attempt starts:

```ts title="packages/sdk-adapters/src/llm/router.ts"
if (rc.onLlmRetry !== undefined) {
  yield* rc.onLlmRetry({ reason: `${cls} on ${from} — failing over to ${to}`, /* … */ })
}
if (rc.failoverNotes !== undefined) {
  yield* Ref.update(rc.failoverNotes, (ns) => [...ns, `[failover: ${from} → ${to} after ${cls}]`]) // [!code highlight]
}
yield* Effect.annotateCurrentSpan({
  'llm.failover': true,
  'llm.failover.from': from,
  'llm.failover.to': to,
  'llm.failover.class': cls,
})
```

The first line rides the retry sink — the same channel that renders `retrying in 8s (1/3)` in the TUI rail and the fleet tree's per-node health suffix — so a failover is visible live, in the same place a retry is. The span attributes make it queryable after the fact. And the highlighted line is my favorite: `failoverNotes` is a per-run `Ref`, and the run's one terminal path folds whatever accumulated there into the outcome's notes — appended to the persisted summary *and* the line the parent agent reads from its inbox. The durable record says, in so many words, which model actually did the work. Days later, wondering why one node's diff reads unlike its siblings', the answer is sitting in its summary: `[failover: … → … after quota]`.

## The two defects that never fail over

The taxonomy has five classes and the failover consumes two. The other two exclusions are as deliberate as the inclusions.

**`auth` never fails over.** A 401 means a credential is wrong, expired, or revoked — a *human* problem, and the only failure here whose fix the human must perform. The error already carries its remedy (the OAuth path literally says `run :login <provider> again`, composed where the knowledge lives). Failing over past it would be worse than useless: the run keeps going, the credential stays broken, and the human discovers it days later when the fallback hits *its* quota. Some failures are supposed to stop the machine.

**`model` stays with the loop.** `MalformedOutput` — a response arrived and couldn't be decoded — is not a provider defect at all; it's a conversation defect. A [sibling post](/posts/errors-for-the-model/) is entirely about that channel: errors *for* the model, corrective messages fed back into the transcript (bounded by `MAX_MALFORMED`) so the model can fix its own reply. This post is the mirror image — errors *from* the provider, handled by the runtime — and the taxonomy is what keeps the two channels from bleeding into each other. Fail over on a malformed reply and you'd yank a conversation-level problem onto a different model mid-conversation, trading a recovery that usually works for one that might not even accept the transcript.

## What it costs

Four honest prices.

**The classifier is regexes over provider prose.** `QUOTA_BODY` matches "insufficient balance" and "usage limit" because those are the strings real gateways sent; nothing stops a provider from rewording. The mitigation is the default: an unrecognized failure classifies as `undefined` and gets no special treatment — surfaced, not guessed at (the suite pins `"something novel"` → `undefined`). The classifier grows by fixture, one forensic string at a time, which means it's always a little behind the world. That's the correct direction to be wrong in.

**Failover is per-call and stateless — so a quota'd run pays a toll.** `withFailover` never rewrites the run's pinned selections; rewriting them would silently migrate a whole fleet, exactly the chaos this design exists to prevent. The consequence, by construction: after a quota wall, every remaining call re-attempts the dead primary (one fast, doomed request), then fails over again — and the fallback provider has no warm prompt-cache prefix for a conversation it's never seen, so the first fallback call pays full-price input tokens. A long run on a dead primary costs noticeably more than the same run started on the fallback; the notes in the summary at least tell you it happened. (The wrap covers the collected-response calls, `generateText`/`generateObject` — what the agent loop uses; a live stream can't be re-attempted without duplicating emitted tokens.)

**One retry means one.** A fallback that's also dead — quota'd, misconfigured, logged out — produces two failures and a slower surface than no failover at all. The single-attempt bound is the anti-cascade choice (no fallback-of-fallback chains, no retry storms across providers), but it makes the feature's value hang on the human keeping one healthy fallback configured — a maintenance promise the system can't check for you.

**The composed path is verified by construction, not by live repro.** The commit says it plainly: *"Live quota-exhaustion failover not reproducible on demand — covered by the classifier tests + construction."* You cannot ask a gateway to exhaust your daily quota at 2pm for a test. The classifier — the part with all the judgment in it — is pinned by one real forensic fixture per class; the failover wiring above it is small, typed, and readable in one screen. I believe the composition because each half is verified and the seam is one function call. But "I believe it" is not "I watched it": the next real quota wall is the integration test, and the `llm.failover.*` spans are how I'll grade it.

## Name the failure first

The reframe travels beyond agents: error handling against any flaky upstream is a classification problem before it's a strategy problem, and most systems skip straight to strategy — one `retry(3, exponential)` wrapped around everything, the same face-blindness the forensics started with, just politer. When someone says their agent "has retries," ask *which of the five failures they mean*. Retrying a transient blip is correct. Retrying a quota wall is a space heater. Retrying a bad credential is a lockout. Retrying a config rejection is a metronome. Retrying malformed output works — but through the transcript, not the transport.

Five names, each bound to one reaction — wait, switch, surface, converse. The next time a provider tells your agent to come back in thirteen and a half hours, the right answer isn't patience, and it isn't a stack trace at 2am either. It's a different model — one specific model, chosen in advance by the only party entitled to choose it — and a loud note in the permanent record saying exactly what happened.
