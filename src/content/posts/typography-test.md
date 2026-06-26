---
title: 'Typography test'
description: 'A kitchen-sink draft exercising every markdown element this blog renders. If something looks wrong anywhere, it looks wrong here first.'
pubDate: 2026-06-11
tags: [meta]
draft: true
---

This draft exists to break the design. Every element the blog can render appears below — if spacing, rhythm, or color is off anywhere on the site, it should be visible on this page. It never ships: `draft: true` keeps it out of production builds, RSS, and the sitemap.

## Headings and rhythm

Body text is Newsreader with optical sizing, targeting a ~68-character measure and 1.65 line height. Here is a second sentence so the paragraph wraps and you can judge the rag. *Italics carry real shapes*, **bold sits at 640**, and `inline code` drops into JetBrains Mono without blowing up the line box.

### A third-level heading

Links [look like this](https://github.com/xandreeddev/efferent) with an amber underline. Footnotes work too.[^1]

#### A fourth-level heading, italic by design

That's as deep as the scale goes; if a post needs h5, the post is wrong.

## Lists

Unordered, with nesting:

- Ports stay in `core`, adapters wrap one SDK each
- Layers compose at the edge
  - `cli` → `adapters` → `core`, strictly inward
  - nothing imports back out
- Every error is tagged

Ordered:

1. Read the failing test
2. Edit the source
3. Run the suite again

## Blockquote

> A port is allowed to have a hole in it, as long as the hole is typed and exactly one adapter looks inside.

## Code

A TypeScript block with a title, a highlighted line, and a long line to force horizontal scroll:

```ts title="packages/core/src/usecases/agentLoop.ts"
export const agentLoop = Effect.gen(function* () {
  const model = yield* LanguageModelPort
  const store = yield* ConversationStore
  const events = model.stream({ messages: yield* store.loaded }) // [!code highlight]
  yield* events.pipe(
    Stream.tap(renderEvent),
    Stream.runForEach((event) => store.append(event)),
    Effect.catchTag('ModelError', (e) => Effect.logError('turn failed', { cause: e.cause, provider: e.provider, retryable: e.retryable })),
  )
})
```

A diff block:

```ts
const ModelLive = AnthropicLanguageModel.layer // [!code --]
const ModelLive = RouterLanguageModel // [!code ++]
```

And a plain shell block:

```bash
bun run typecheck && bun test
bun run eval tool-selection
```

## Table

| Mode      | Flag           | Renderer            |
| --------- | -------------- | ------------------- |
| TUI       | *(default)*    | OpenTUI + Solid     |
| One-shot  | `--print`      | plain text          |
| JSONL     | `--mode json`  | event stream        |
| RPC       | `--mode rpc`   | JSON-RPC over stdio |

## Image

![A branching context tree: a root conversation node with two sub-agent children, one marked stale, one branched fork](/images/context-tree.svg)

## Horizontal rule

Above this sentence sits a paragraph; below it, a rule; after that, the end.

---

That's everything. If this page reads comfortably in both themes at 390px and 1440px, the design is doing its job.

[^1]: Footnotes render small, in the secondary color, under a hairline — and the backlink arrow returns you to the reference.
