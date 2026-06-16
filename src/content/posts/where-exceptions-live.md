---
title: 'Where exceptions are allowed to exist'
description: 'Failures are values everywhere inside; exceptions survive only at the adapter boundary, under Effect.try. An audit of my own codebase, with the diffs.'
pubDate: 2026-06-04
tags: [effect, typescript]
series:
  name: 'Effect in practice'
  order: 1
draft: false
---

Yesterday I was rereading one of my own drafts — the one praising the approval judge in [efferent](https://github.com/xandreeddev/agent) — and the code snippet under my own headline had a `try/catch` in it. In the *domain*. The article was selling typed failures while quoting a function that handled failure the JavaScript way, in the one package where that's supposed to be impossible.

The fix took an afternoon. The afternoon produced a rule worth writing down, an audit that found three more violations — each a different species, the last of them a genuine bug the rule would have prevented. This post is all of it, diffs included.

## Two vocabularies for failure

A program has exactly two ways to say "this didn't work."

The first is the **exception**: `throw` transfers control to whoever catches, invisibly. Nothing in a function's type says it throws, nothing says what it throws, and the set of things that *might* throw under you — `JSON.parse`, `new URL`, a library three calls down — is unknowable from signatures. Handling is a `try/catch` placed where you *guess* the blast radius ends.

The second is the **value**: the function returns its failure, typed, and the caller decides. In Effect that's the `E` channel of `Effect<A, E, R>` — and for pure, synchronous helpers, its little sibling `Either<R, L>`: a value that's either `Right(result)` or `Left(error)`, no runtime needed. Failures-as-values compose, accumulate as unions, and are tracked by the compiler. (The full tour of the `E` channel is a post of its own; this post is about *geography* — where each vocabulary is allowed.)

The problem is that the JavaScript ecosystem speaks the first vocabulary, and your domain wants to speak the second. Somewhere they must meet. The entire discipline is choosing where.

## The rule

> **Exceptions may exist only where foreign code throws — in adapters, captured immediately by `Effect.try` / `Effect.tryPromise` and mapped to a tagged error. Everywhere inward of that line, failure is a value: ports return Effects, and pure domain helpers reach for `Either` at most.**

"At most" is doing real work in that sentence. A domain helper that can't fail returns a plain value. One that can fail *synchronously and purely* returns an `Either`. One that needs services or async returns an `Effect`. What none of them ever do is throw — because the moment a domain function throws, every caller inherits an invisible contract, and the typed error channel the rest of the architecture leans on becomes decorative.

The rule has a pleasant property: **you can grep for violations.** `try {`, bare `JSON.parse`, `decodeUnknownSync`, `throw ` — in the domain package, every one of those is a finding, no judgment calls required. Which is how the audit went.

## Finding №1: the judge parser — the classic

The snippet that started this. The approval judge is a fast-tier model that pre-screens bash commands; its reply is supposed to be one JSON object, and the parser held it to that — using both forbidden words:

```ts title="packages/core/src/usecases/autoApproval.ts"
export const parseJudgeVerdict = (text: string): JudgeVerdict => {
  const match = text.match(/\{[\s\S]*\}/)
  if (match === null) return { verdict: 'prompt' }
  try { // [!code --]
    const parsed = JSON.parse(match[0]) as Record<string, unknown> // [!code --]
    return { verdict: parsed['verdict'] === 'allow' ? 'allow' : 'prompt' /* … */ } // [!code --]
  } catch { // [!code --]
    return { verdict: 'prompt' } // [!code --]
  } // [!code --]
  const JudgeReply = Schema.parseJson( // [!code ++]
    Schema.Struct({ // [!code ++]
      verdict: Schema.Literal('allow', 'prompt'), // [!code ++]
      folder: Schema.optional(Schema.String), // [!code ++]
      reason: Schema.optional(Schema.String), // [!code ++]
    }), // [!code ++]
  ) // [!code ++]
  return Either.match(Schema.decodeUnknownEither(JudgeReply)(match[0]), { // [!code ++]
    onLeft: (): JudgeVerdict => ({ verdict: 'prompt' }), // [!code ++]
    onRight: ({ verdict, folder, reason }): JudgeVerdict => ({ verdict /* … */ }), // [!code ++]
  }) // [!code ++]
}
```

(In the real file the schema is declared once at module level; it's inlined here so the diff reads as one motion.)

The load-bearing discovery is that `Schema.parseJson` *subsumes* `JSON.parse`. You don't wrap the throwing parser — you declare what a valid reply *is*, and parsing and validation become one decode that fails as a value. Malformed JSON, a verdict that isn't in the literal union, a `folder` that's a number: previously three different behaviors (one caught, one silently coerced, one silently ignored); now one `Left`, one policy, `prompt`.

That last point is worth slowing down for. The old code wasn't just stylistically impure — it was *less strict than it looked*. `{"verdict":"allow","folder":123}` parsed fine, dropped the junk field, and allowed. The schema version refuses to decode it, and the refusal lands on the safe branch. Hand-rolled parsing always has these gaps, because every field check is an opportunity to be accidentally lenient. A schema is leak-proof by construction.

## Finding №2: the same bug, wearing a different hat

The grep's second hit was in the eval framework's LLM-as-judge scorer — a different package, a different author-day, the *identical* pattern: regex out the JSON, `try { JSON.parse … } catch { score: 0 }`. Same fix, five minutes.

The lesson isn't "I made the same mistake twice." It's *where* the mistakes were: both sat at the exact spot where **a model's string output meets the type system**. That seam is the most exception-prone place in any LLM application, because the input is adversarially unstructured — a model can reply with prose, fences, emoji, or half a JSON object, and `JSON.parse` is the first throwing function everyone reaches for. If your codebase has domain-side try/catch, I'd bet money it's parked next to a model reply. Audit there first.

## Finding №3: the port that wasn't an Effect

The rule says ports return Effects. Thirty-nine of [efferent](https://github.com/xandreeddev/agent)'s port methods did; the sweep found two that didn't, both on the OAuth-flow port:

```ts title="packages/core/src/ports/AuthFlow.ts"
readonly supportsOAuth: (provider: Provider) => boolean // [!code --]
readonly parseRedirect: (input: string) => OAuthRedirect // [!code --]
readonly supportsOAuth: (provider: Provider) => Effect.Effect<boolean> // [!code ++]
readonly parseRedirect: (input: string) => Effect.Effect<OAuthRedirect> // [!code ++]
```

`supportsOAuth` is a pure capability check — it can't fail, and making it an Effect costs one `yield*` at the call site. So why bother? Because a port method's signature is a *promise about every future implementation*. The day a fancier implementation reads capabilities from config, a bare `boolean` return forces it to lie or to block; `Effect<boolean>` was free insurance.

`parseRedirect` is the instructive one. Implementations parse a pasted redirect URL, and URL parsing in JavaScript means `new URL(value)` — which throws. With the port returning a bare value, the adapter *had* to contain that exception synchronously, and it did, with try/catch as control flow ("not a URL → try the next format"). The port's shape was forcing the implementation's hand. After the change, the adapter could have used `Effect.try` — but the better fix was to delete the exception entirely:

```ts title="packages/adapters/src/auth/oauth/anthropic.ts"
try { // [!code --]
  const url = new URL(value) // [!code --]
  return { code: url.searchParams.get('code') ?? undefined /* … */ } // [!code --]
} catch { // [!code --]
  /* not a URL */ // [!code --]
} // [!code --]
// Total by construction: canParse instead of catching a thrown URL. // [!code ++]
if (URL.canParse(value)) { // [!code ++]
  const url = new URL(value) // [!code ++]
  return { code: url.searchParams.get('code') ?? undefined /* … */ } // [!code ++]
} // [!code ++]
```

`Effect.try` is the tool for exceptions you can't avoid. When the platform offers a total API — `URL.canParse`, `Number.isFinite`, a regex — the best wrapping is none. The hierarchy of fixes, best first: *make it total, decode it as a value, capture it at the boundary.* Catching is the floor, not the pattern.

## Finding №4: the bug the rule existed to prevent

The first three findings were hygiene — same behavior, better citizenship. The fourth was a live defect, and it needs one more piece of Effect vocabulary to explain.

Effect distinguishes **failures** from **defects**. A failure is an expected error traveling the typed `E` channel — `ConversationStoreError`, handled, recoverable. A defect is a *betrayal*: an exception thrown from code the runtime believed couldn't throw. Defects don't ride the `E` channel; they kill the fiber, skip your `catchTag`s, and surface as the unstructured crash Effect was supposed to end. `Effect.try` exists precisely to turn would-be defects into failures at the moment of capture.

Now look at what the SQL stores did with stored messages. SQLite returns a message row's JSON as a *string*; Postgres returns parsed `jsonb`. One shared codec absorbed the difference:

```ts title="packages/adapters/src/database/messageCodec.ts"
export const reassembleMessageRow = (role: string, content: unknown): unknown => {
  const parsed = typeof content === 'string' ? JSON.parse(content) : content // [!code highlight]
  return /* …re-attach role… */
}
```

This is adapter code — exceptions are *allowed* here, right? Right — but "allowed in an adapter" means *captured inside an Effect*, where the capture maps the throw onto a tagged error. This throw is captured by nothing. Look at where the codec was called — one file over, in the SQL store:

```ts title="packages/adapters/src/conversationStore/sqlite.ts"
const decodeMessage = (row: MessageRow) =>
  Schema.decodeUnknown(AgentMessage)(
    reassembleMessageRow(row.role, row.content), // runs while BUILDING the Effect, not inside it // [!code highlight]
  ).pipe(Effect.mapError((cause) => new ConversationStoreError({ cause /* … */ })))
```

The `mapError` promises that a bad row becomes a tagged `ConversationStoreError`. But `reassembleMessageRow` runs *while building* the effect, not inside it — so a corrupt row's `JSON.parse` throw never reaches that `mapError`. It detonates as a **defect**: an untyped fiber death from a port whose signature swears the only failures are tagged. Every caller pattern-matching on `ConversationStoreError` would have been skipped. The store's error contract was a lie waiting for one bad byte on disk.

The fix makes the codec total — an unparseable string passes through *as the string*, and the schema decode right behind it rejects it through the channel that was always supposed to handle this:

```ts title="packages/adapters/src/database/messageCodec.ts"
const JsonValue = Schema.parseJson(Schema.Unknown)
const parseJsonString = (s: string): unknown =>
  Either.getOrElse(Schema.decodeUnknownEither(JsonValue)(s), () => s) // [!code highlight]
```

Corrupt row → decode failure → `ConversationStoreError` with the cause attached — the typed path, end to end. No new error handling was written; the existing handling finally became *reachable*.

This is the finding that justifies the whole rule. The first three were aesthetics with benefits. This one was a defect-shaped hole in a typed contract, invisible in review because the throwing expression sat twelve characters away from the `mapError` that looked like it covered it. "Exceptions only under `Effect.try`" isn't a style preference — it's the property that makes `E` channels *true*.

## The boundary, done right

For contrast, here's what the rule looks like where exceptions are supposed to live. Every HTTP call in the OAuth adapters has this shape:

```ts title="packages/adapters/src/auth/oauth/anthropic.ts"
const postToken = (body: Record<string, string>): Effect.Effect<OAuthTokens, AuthError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(TOKEN_URL, { method: 'POST', /* … */ })
      // …throwing code is welcome in here: fetch, res.json, the lot
    },
    catch: (cause) => new AuthError({ cause, message: 'token exchange failed' }), // [!code highlight]
  })
```

One capture, at the outermost point where foreign code can throw, mapped to a tagged error on the way out. Inward of this function, `AuthError` is a value like any other. The exception existed for exactly as long as the foreign API required and not one frame longer.

## What it costs, and how it sticks

Honesty section. `Schema.parseJson` + `Either.match` is more ceremony than `try { JSON.parse }` — for a three-field reply it's roughly double the lines, and you pay a schema declaration for every wire shape. The `URL.canParse` trick double-parses the URL (a non-cost in practice, a smell to some eyes). And `Effect<boolean>` for a pure predicate will read as zealotry to anyone who hasn't been burned by a port signature they couldn't evolve.

Against that: every one of the four findings was *invisible at review time* and mechanical to find by grep. Which suggests the enforcement story, and it's pleasingly dumb — the rule is a one-liner in CI:

```bash
# fails the build if exception machinery sneaks into the domain
! grep -rnE '(^|[^A-Za-z])(try \{|throw |JSON\.parse|decodeUnknownSync)' \
    packages/core/src --include='*.ts' --exclude='*.test.ts'
```

A rule you can grep for is a rule that survives contributors, tired evenings, and coding agents. That last one isn't hypothetical: most of [efferent](https://github.com/xandreeddev/agent) is written with an agent in the loop, and an agent will absolutely reach for `try/catch` around `JSON.parse` — it's the most statistically likely error handling in its training data. The grep doesn't care. It fails the build, the agent reads the failure, and the next attempt uses the decoder. Architecture that defends itself is the only kind that holds when the contributor never gets tired and never reads the style guide.

## From grep to a gate

I wrote *grep* up there because it fits in a tweet and it's true. It isn't what guards the repo. A grep reads text, not syntax, and the rule lives in three blind spots no regex closes cleanly:

- **`Effect.try` and `Effect.tryPromise` are the sanctioned escape hatch — and they contain the letters `try`.** The whole post hands exceptions a visa stamped `Effect.try`; a gate that can't tell the visa from the crime is the wrong gate. In text you start bolting on negative lookarounds. In a syntax tree, a `try` *statement* and a `.try(…)` *call* are just different nodes — one banned, one blessed, no cleverness.
- **Strings and comments lie.** A comment that says "don't `throw` here" is a finding to grep and nothing to a reader. An AST never mistakes them for code.
- **`.catch()` is a `try/catch` wearing a method call.** Grepping for `try {` and `throw ` walks straight past `somePromise.catch(…)` — a whole species of exception handling the line-based version never sees.

So the shipped gate is a ~90-line walk over the TypeScript AST (`scripts/banTryCatch.ts`), zero new dependencies — `typescript` was already in the tree for the typecheck. It flags `try`/`throw` statements and `.catch()` calls under `@efferent/core/src`, then prints `file:line:col — use Effect.catchAll / Effect.catchTag`. It's folded into `bun run typecheck` (now `tsc --noEmit && bun scripts/banTryCatch.ts`), so purity rides along with the types everywhere the typecheck already runs.

It's also stricter than the grep in a way I didn't plan: the grep carried `--exclude='*.test.ts'`; the AST walk exempts nothing. Turning it on immediately flagged four test doubles that did `throw new Error("unused")` to mean "this method is never called." Fair intent — but a mock that throws is still an exception living in the domain's own test surface, so they became `Effect.die("unused")`: same meaning, value vocabulary, no `throw` on the line.

Then the scan is wired at three depths, fastest to firmest:

1. **A local `pre-commit` hook**, installed for free — `bun install` runs a `prepare` script (`installHooks.ts`) that drops the hook into `.git/hooks`, no-ops outside a real checkout, and never clobbers a hook it didn't write. This is the fast feedback loop, not the guarantee: `git commit --no-verify` walks past it by design. A hook's job is to save you the round-trip to CI, not to be the wall.
2. **The `ci` workflow**, on every push to `main` and every PR: `bun run typecheck` (scan included) plus the test suite.
3. **Branch protection on `main` requiring `ci`, no admin bypass.** *This* is the wall. A banned construct can't be merged and can't be pushed to `main` — no matter who's tired or what `--no-verify` they typed locally.

The rule went into `AGENT.md` as well, in plain English, so the agent reads it before it writes a line. But the gate deliberately doesn't *depend* on the agent reading it — that's the previous section made load-bearing. The English is a courtesy; the AST scan is the contract.

So: failures are values, everywhere a value can reach. Exceptions get a visa for the adapter boundary, stamped `Effect.try`, and nowhere else. And once a quarter, run the grep on your own domain — yesterday it found four things in mine, in a codebase whose whole thesis is doing this properly. The vocabulary doesn't enforce itself.
