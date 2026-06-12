---
title: 'Effect from zero: the beginner''s guide I wanted'
description: 'Programs as values, errors you can see, and batteries included — Effect.ts from nothing, with standalone examples and a map of what to ignore at first.'
pubDate: 2026-06-12
tags: [effect, typescript]
draft: true
---

Every Effect resource I found when I started assumed I already believed. The docs are a reference, the talks sell the vision, and the examples jump to layered architectures before explaining why `yield*` is everywhere. This is the guide I wanted instead: start from zero, build one small real thing, and be honest about which 10% of the library you need on day one.

No agent code in this one, no architecture — just Effect, a fake user API, and the moments where each piece earns its place.

## The one idea everything hangs on

A `Promise` starts running the moment you create it. This line *does* something:

```ts
const p = fetch('https://api.example.com/users/1') // request is already in flight
```

An `Effect` doesn't. It's a **description** of a program — a value you hold, pass around, and combine, which does nothing until you explicitly run it:

```ts
import { Effect } from 'effect'

const program = Effect.tryPromise(() => fetch('https://api.example.com/users/1'))
// nothing has happened. no request. `program` is a plan.
```

That's the entire foundation. Everything people praise about Effect — retries, typed errors, dependency injection, cancellation — falls out of programs being inert values, because values can be *manipulated before they run*. You can't retry a Promise; by the time you hold one, it's already underway. You can retry a plan.

The type spells out what a plan is:

```ts
Effect.Effect<A, E, R>
// succeeds with A · fails with E · needs R to run
```

Read it as a contract: "give me an environment `R`, and I'll either produce an `A` or fail with an `E` — and both of those are types the compiler holds me to." For most of this guide `R` will be `never` (needs nothing); it gets its moment near the end.

## Making effects

Four constructors cover nearly everything you'll write in week one:

```ts
const one = Effect.succeed(42)                    // lift a plain value
const boom = Effect.fail(new Error('nope'))       // lift a failure
const now = Effect.sync(() => Date.now())         // wrap sync code, run later
const body = Effect.tryPromise(() => fetch(url))  // wrap async code that may throw
```

The names encode an important split: `succeed`/`sync` are for code that *can't* fail, `fail`/`tryPromise` for code that can. `Effect.tryPromise` is the workhorse at the JavaScript boundary — it runs your Promise-returning function when the effect runs, and a rejection or throw becomes a *typed failure* instead of an exception flying up the stack.

## Running effects

A description needs an interpreter. You run effects at the **edge** of your program — `main`, a route handler, a test — and ideally exactly once:

```ts
const result = await Effect.runPromise(program) // async programs
const n = Effect.runSync(one)                   // pure sync programs
```

If you remember one structural rule from this guide: **build one big description out of small ones, run it once at the entry point.** Code that sprinkles `runPromise` through its internals is fighting the model — every internal run is a place where composition, errors, and cancellation stop working.

## Composing: `Effect.gen` reads like async/await

Combining effects with `.pipe(Effect.flatMap(...))` chains works but reads like homework. `Effect.gen` is what you'll actually write — a generator where `yield*` means exactly what `await` means in an async function:

```ts
import { Effect } from 'effect'

const getUser = (id: number) =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise(() => fetch(`https://api.example.com/users/${id}`))
    const json = yield* Effect.tryPromise(() => res.json())
    return json
  })
// still nothing has run — getUser(1) returns a description
```

Mental translation table: `async function` → `Effect.gen(function* () { … })`, `await x` → `yield* x`, `return v` → `return v`. That's it. If you can read async/await, you can read 90% of real-world Effect code right now.

So far this is async/await with extra ceremony. The next three sections are where the ceremony starts paying rent.

## Errors you can see

Here's `getUser`'s inferred type so far: `Effect<unknown, UnknownException>`. Both type parameters are mush — `unknown` success, vague failure. Let's fix the failure side first, because this is Effect's sharpest difference from Promises.

Define errors as **tagged classes** — a name on the type, checked by the compiler:

```ts
import { Data, Effect } from 'effect'

class NetworkError extends Data.TaggedError('NetworkError')<{ cause: unknown }> {}
class UserNotFound extends Data.TaggedError('UserNotFound')<{ id: number }> {}

const getUser = (id: number) =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () => fetch(`https://api.example.com/users/${id}`),
      catch: (cause) => new NetworkError({ cause }), // [!code highlight]
    })
    if (res.status === 404) return yield* Effect.fail(new UserNotFound({ id }))
    return yield* Effect.tryPromise({
      try: () => res.json(),
      catch: (cause) => new NetworkError({ cause }),
    })
  })
// type: Effect<unknown, NetworkError | UserNotFound>
```

Look at that error type: `NetworkError | UserNotFound`. Nobody wrote it — it *accumulated* from the failure paths, the way return types always have. Every caller now sees exactly what can go wrong, and handling one case **narrows the type**:

```ts
const userOrGuest = (id: number) =>
  getUser(id).pipe(
    Effect.catchTag('UserNotFound', () => Effect.succeed(GUEST)), // [!code highlight]
  )
// type: Effect<unknown, NetworkError> — UserNotFound is GONE from the type
```

Sit with that for a second, because it's the moment Effect clicked for me. In Promise-land, `catch` receives `unknown`, handles whatever it guesses might arrive, and the type system learns nothing. Here, handling `UserNotFound` *deletes it from the contract*. A function whose error channel says `never` is compiler-verified to handle everything. "Did we handle that error?" stops being a code-review question and becomes a type.

## Structure from strangers: Schema

The success side is still `unknown`, because `res.json()` returns whatever the server felt like sending. The companion library `effect/Schema` turns "I hope it's a user" into "decode it or fail like everything else":

```ts
import { Schema } from 'effect'

const User = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  email: Schema.String,
})

// inside getUser, replace the res.json() line:
const raw = yield* Effect.tryPromise({ try: () => res.json(), catch: (c) => new NetworkError({ cause: c }) })
const user = yield* Schema.decodeUnknown(User)(raw) // [!code highlight]
return user
// type: Effect<{ id: number; name: string; email: string }, NetworkError | UserNotFound | ParseError>
```

One declaration gives you the type, the validator, and a precise error explaining exactly which field disagreed. The bad-data failure rides the same error channel as everything else — no try/catch, no `as User` lie.

## Batteries: retry and timeout as one-liners

Now the payoff for "programs are values." Our `getUser` hits a flaky API. With Promises, retry logic means a hand-written loop with sleep, backoff arithmetic, and an off-by-one. With Effect, a retry *policy* is a value too:

```ts
import { Effect, Schedule } from 'effect'

const resilientGetUser = (id: number) =>
  getUser(id).pipe(
    Effect.retry({
      schedule: Schedule.exponential('100 millis'), // 100ms, 200ms, 400ms…
      times: 3,
      while: (e) => e._tag === 'NetworkError', // don't retry a 404, it won't improve // [!code highlight]
    }),
    Effect.timeout('5 seconds'),
  )
```

Read what that does: retry up to three times with exponential backoff, *but only network errors* — a missing user is permanently missing — and give the whole thing five seconds before it fails with a timeout. Eight lines, no loop, no `setTimeout`, and it composes: that entire resilient program is still just a value you can map, race, or retry *again* at a higher level.

This is the section to show a Promise-pilled colleague. Nobody misses their hand-rolled backoff loop.

## Services: the `R` finally matters

One more idea and you have the full type. Real programs depend on things — a database, a clock, an API client — and testing them means substituting those things. Effect's answer: declare a dependency as a **tag**, use it as if it existed, and let `R` track the debt.

```ts
import { Context, Effect, Layer } from 'effect'

class UsersApi extends Context.Tag('UsersApi')<
  UsersApi,
  { readonly byId: (id: number) => Effect.Effect<User, NetworkError | UserNotFound> }
>() {}

const greeting = (id: number) =>
  Effect.gen(function* () {
    const api = yield* UsersApi          // "I need this" — adds UsersApi to R // [!code highlight]
    const user = yield* api.byId(id)
    return `hello, ${user.name}`
  })
// type: Effect<string, NetworkError | UserNotFound, UsersApi> — the debt is visible
```

`greeting` compiles without any implementation existing. Implementations come as **layers**, and you pick one at the edge:

```ts
const UsersApiLive = Layer.succeed(UsersApi, { byId: resilientGetUser })
const UsersApiTest = Layer.succeed(UsersApi, {
  byId: (id) => Effect.succeed({ id, name: 'test user', email: 't@example.com' }),
})

await Effect.runPromise(greeting(1).pipe(Effect.provide(UsersApiLive))) // prod
await Effect.runPromise(greeting(1).pipe(Effect.provide(UsersApiTest))) // tests — no mocking library
```

Providing *subtracts* from `R`; a fully provided program has `R = never` and is the only thing a runtime will accept. Forget a dependency and it's a compile error at the one line where wiring happens. This scales further than it looks — whole applications are wired as a single layer expression — but that story deserves its own post.

## What to ignore at first

Effect's real beginner tax isn't the concepts — you just read all of them — it's the **surface area**. The library ships fibers, streams, STM, metrics, schedules, scopes, runtimes, and a dozen data types, and the docs present them with equal enthusiasm. Day-one advice: the ten exports in this guide (`succeed`, `fail`, `sync`, `tryPromise`, `gen`, `runPromise`, `catchTag`, `retry`, `Data.TaggedError`, `Schema.Struct` + `Context.Tag`/`Layer` as a pair) cover the overwhelming majority of application code. Treat everything else as a standard library you'll look up when a problem demands it — concurrency primitives when you fan out, `Stream` when you process sequences, `Scope` when resources need guaranteed cleanup. They're excellent. They can wait.

And one honest cost up front: stack traces become fiber traces, type errors on mis-wired layers are accurate but verbose, and for the first week `yield*` will feel like typing with gloves on. The week after, plain async/await starts feeling like the gloves.

## How to actually start

Don't rewrite your app. Pick one function at its edge — the flaky API call everyone fears, the JSON parse that crashed prod once — and rebuild just it: `tryPromise` with a tagged error, a `Schema` decode, a retry policy. Run it with `runPromise` right where the old function was called; the rest of your codebase can't tell the difference. That seam is how Effect enters real codebases — one resilient function at a time, each one a small advertisement to whoever reads it next.

The deep ends — layered architecture, the concurrency toolkit, resource scopes — are all real and all reachable from exactly the foundation you now have: programs are values, failures are types, and the edge runs it once.
