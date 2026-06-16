---
title: 'Make the compiler tell your ids apart: a guide to branded types'
description: 'To the type checker, every id and path in your domain is the same primitive — and that is a bug it should have caught. Branded types in Effect give them distinct identities that erase on encode: no migration, just compile errors at the call sites that were always wrong.'
pubDate: 2026-06-12
tags: [effect, typescript]
series:
  name: 'Effect in practice'
  order: 2
draft: false
---

I had a branded type doing its job, and then one return-type annotation quietly threw the brand away — and nothing complained for weeks.

The type was `ContextNodeId`, the identity of a node in [efferent](https://github.com/xandreeddev/agent)'s context tree. It was minted correctly, validated at its boundary, threaded through the spawn machinery. But the function that resumes a node declared its result as `{ …; nodeId: string }`, and from that line outward the brand was gone: every consumer of a resumed node held a plain `string` the compiler was happy to confuse with any other. The brand existed; the annotation laundered it. This is a post about why you'd brand a type at all, how the two flavors differ, a rubric for which primitives earn one — and the reclaim that started it, with the diffs.

## What a brand actually is

TypeScript is **structurally typed**: two types with the same shape are the same type. A `ConversationId` that's "really" a `string` *is* a `string`, interchangeable with every other string in the program — a file path, a model name, a user's raw input, the literal `"oops"`. The compiler sees one type where your domain has a dozen.

A **branded type** is a structural type with a phantom tag welded on — a property that exists only in the type system, never at runtime:

```ts title="packages/core/src/entities/AgentContext.ts"
export const ContextNodeId = Schema.UUID.pipe(Schema.brand("ContextNodeId"))
export type ContextNodeId = typeof ContextNodeId.Type
```

`ContextNodeId.Type` is `string & Brand<"ContextNodeId">`. At runtime it's the same string it always was — the brand is erased. At compile time it's a distinct type: a function asking for a `ContextNodeId` will reject a bare `string`, and a function asking for a `string` will happily take the id (the subtype relationship only runs one way). You've turned a structural type into a **nominal** one for exactly the values where identity matters, and paid nothing in bytes to do it.

Effect's `Schema.brand` does this *and* gives you a decoder. The same declaration that defines the type defines `Schema.decodeUnknown(ContextNodeId)` — a parse that validates the UUID shape and hands back a value the type system now trusts. The brand and the runtime check are one artifact; you can't get the type without going through the validation. (Typed failures from that decode are [their own discipline](https://github.com/xandreeddev/agent), and a post of its own.)

## The bug a brand prevents

Here's the bug in its natural habitat. A sub-agent run produces a node id and a conversation id; both are UUIDs; both are `string`:

```ts
// both are string — so this compiles, and it is wrong
store.findNode(conversationId)   // expects a ContextNodeId
notFound({ id: someFolderPath }) // expects an id, got a sandbox path
```

Nothing here is exotic. It's a transposed argument, a copy-paste from the wrong variable, a refactor that renamed one field and not its twin. The values are the same *type*, so the only thing standing between you and the bug is attention — and attention is the resource you have least of at 6pm during a rename. Brand the two ids apart and the first line stops compiling: `Argument of type 'ConversationId' is not assignable to parameter of type 'ContextNodeId'`. The bug becomes a red squiggle instead of a production incident.

That's the whole pitch, and it's the FP slogan you've heard — *make illegal states unrepresentable* — but aimed at the smallest unit. Not "model your state machine so bad transitions can't be built," just "make these two strings refuse to be each other." The payoff scales with **reach**: a primitive that flows through forty signatures is forty call sites the compiler now checks for free.

## A brand is only as strong as its narrowest annotation

Which brings us back to the reclaim. `ContextNodeId` was already a brand — so why was there a bug to fix? Because a brand leaks through the *widest* type any value passes through on its way to a caller. The id was branded at the mint, but the function that resumed a node annotated its return as `string`:

```ts title="packages/core/src/usecases/buildScopeRuntime.ts"
readonly resumeNode: (/* … */) => Effect.Effect<
  { summary: string; filesChanged: ReadonlyArray<string>; nodeId: string },       // [!code --]
  { summary: string; filesChanged: ReadonlyArray<string>; nodeId: ContextNodeId }, // [!code ++]
  Failure,
  /* … */
>
```

The runtime value was a real `ContextNodeId` the whole time — the annotation just *described* it as `string`, and an annotation that's wider than its value is a one-way valve: every downstream consumer inherits the wider type and the brand is gone, silently, with no cast to grep for and no error to notice. The same widening had crept into the hook events that narrate a run…

```ts title="packages/core/src/entities/AgentHooks.ts"
readonly subAgentNodeId?: string         // [!code --]
readonly subAgentNodeId?: ContextNodeId  // [!code ++]
```

…and into the not-found errors, whose `id` field had always *carried* a branded value from its constructor but *declared* a `string`:

```ts title="packages/core/src/ports/ContextTreeStore.ts"
export class ContextNodeNotFound extends Data.TaggedError("ContextNodeNotFound")<{
  readonly id: string         // [!code --]
  readonly id: ContextNodeId  // [!code ++]
}> {}
```

None of this was a runtime change. The reclaim added no decode calls, minted no new values — it deleted the places where annotations were quietly throwing an existing brand away. The lesson generalizes past Effect: a brand is a claim every signature on the value's path has to keep, and the moment one annotation widens to the base type, the claim is void from there on, invisibly. The fix is a discipline, not a feature: **let the brand be inferred; never re-annotate it back to its base.**

## Two flavors: decode at the edge, or tag in the core

Not every brand needs a runtime decoder, and Effect gives you both kinds. The choice is about *where the value comes from*.

**`Schema.brand`** — for anything that decodes at a boundary: a DB row, model or user input, tool I/O. You want the validation, because the value is arriving from outside the type system's jurisdiction. efferent's two ids are this kind — `ContextNodeId` and `ConversationId`, both `Schema.UUID` refined to a brand.

**`Brand.nominal`** — for a value that's born inside the core, never crosses a decode boundary, and only needs confusability protection. It's a pure type-level tag with *zero* runtime cost — no validation, no wrapper:

```ts
// a provider-opaque tool-call id: minted by code we trust, never parsed —
// confusability is the only risk, so tag it and skip the runtime check
export type ToolCallId = string & Brand.Brand<"ToolCallId">
export const ToolCallId = Brand.nominal<ToolCallId>()
```

And a third axis cutting across both: **refined** vs. plain. A refined brand carries a real invariant — `Schema.UUID`, a `provider:modelId` shape, `NonNegativeInt`, an `http(s)` URL — and the decoder enforces it. A plain brand only enforces *which type this is*. Reach for refined where there's an invariant worth the check; reach for nominal where the only goal is "don't swap me with that other string." A bonus of refined brands: `Arbitrary.make(schema)` derives a property-test generator straight from the brand, so the invariant gets [fuzzed for free](https://github.com/xandreeddev/agent) — also a post of its own.

## A rubric for what to brand

Branding everything is its own bug — a wall of `unwrap` ceremony that buries the brands that matter. So the actual guide is a rubric. Brand a primitive when it scores high on:

1. **Confusability.** Could it be swapped with another same-typed value at a call site and still compile? `folder` vs. `displayRoot` vs. `path`; `inputTokens` vs. `messagePosition`. High confusability is the whole reason brands exist.
2. **Reach.** How many signatures pass it around. Reach multiplies the payoff — and the cost of *not* branding, since every signature is a place to get it wrong.
3. **An invariant worth enforcing.** A UUID, a non-empty string, a non-negative count. Present → favor a *refined* brand. Absent, pure confusability → a *nominal* one.
4. **Boundary clarity.** Few mint/decode points make a brand cheap to adopt; a value created in fifty places is fifty decodes to add.
5. **Security signal.** Secrets earn a brand paired with `Redacted` — the type makes accidental logging a compile error, and you unwrap with `Redacted.value` only at the call site that actually needs the bytes.

And the other half of the rubric — when to *skip*. Leave it a bare `string` when the value is free-form (`summary`, `content`, `query`, prompt text), provider-opaque passthrough (`providerOptions`), or used in exactly one place. A brand on a value with no confusability and no invariant is pure tax: `LineCount`, `ByteCount`, `EditCount` all sounded principled and all got cut from efferent's plan, because none of them is ever standing next to a different count waiting to be swapped.

## Where the brand stops

The most instructive line in the whole reclaim is one I deliberately *didn't* change. The cross-mode event stream — what gets serialized to JSONL when the agent runs headless — keeps its node id as a plain `string`:

```ts title="packages/cli/src/events.ts"
/** …a core ContextNodeId deliberately widened to string — AgentEvent is the
 *  cross-mode WIRE vocabulary (serialized to JSONL in json mode), so the
 *  brand stays in the domain and the transport stays a plain string. */
readonly nodeId?: string
```

This isn't a contradiction of the section above; it's the rule's natural edge. Brands erase on encode anyway — the moment a value is serialized it's bytes, and bytes have no brand. So a transport type modeling the *wire* should speak the wire's vocabulary: strings. The brand lives in the domain, gets copied into the event from an already-branded core value, and widens at exactly one documented seam.

The difference between this and the bug from three sections ago is *one word in a comment*. Both widen a `ContextNodeId` to `string`. The bug did it silently, in a return-type annotation, where no one could see the brand being dropped. This does it **explicitly**, at a named boundary, with the reason written down. Same erasure; opposite engineering. A brand you give up on purpose, at the edge, is a design decision; a brand you give up by accident, in the middle, is the defect.

## What it costs

Honesty section. Brands are not free, and the cost is **unwrap noise**. The moment a `TokenCount` has to be added to another `TokenCount`, or compared, or summed into a ledger, you're either threading unwrap helpers through the arithmetic or you've made `+` stop type-checking. That's why efferent's plan quarantines the count and secret brands into their own phase, behind their own branch — viral, behavioral brands have to be revertible in isolation, because the only way to know if the unwrap tax beats the safety is to live with it for a week.

Two more honest edges. There are **casts that survive** — a couple of `as ConversationId` in the synchronous TUI key handlers, kept because pushing an Effectful decode into a keypress handler to guard an impossible failure is a worse trade than the cast; left in with the rationale in a comment, to be revisited only if those handlers ever go effectful. And the adoption itself is a **flag day per family**: turning a primitive into a brand surfaces every mismatched call site at once as a compile error. That's the feature — but it means you brand one family per branch, lean on `tsc` to enumerate the fallout, and don't bulk-adopt the whole zoo in one heroic diff. No DB migration, ever — brands erase on encode, so the JSON and the rows don't move; the cost is paid entirely in compile errors, which is the cheapest currency you have.

## A type is a promise

A `string` promises almost nothing: *these characters are characters.* A `ContextNodeId` promises *these characters are the identity of a node in the context tree, and the function that wanted a folder will refuse them.* You were already making that second promise — at every call site, in your head, every time you passed the right variable to the right parameter. Branding doesn't add a new rule. It moves a promise you were already keeping out of your attention and into the compiler, which never has a long day and never gets to 6pm. That's the entire trade: a little ceremony now, against the one transposed argument you would otherwise ship — and find out about from a stack trace that points at a `string`, three days later, when you've forgotten which string it was.
