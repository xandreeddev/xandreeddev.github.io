---
title: 'The transcript is the memory'
description: 'A model call is stateless, so the conversation transcript is the agent''s entire memory. Keep the whole history as an append-only log — and that one invariant is what makes caching, compression, and resume all work.'
pubDate: 2026-06-18
tags: [agents, ai, effect]
series:
  name: 'How an agent remembers'
  order: 1
draft: true
---

I closed the laptop mid-task on Tuesday — the agent halfway through a refactor, a constraint I'd handed it an hour earlier ("don't touch the public API") still in force. Wednesday morning I reopened it, typed *keep going*, and it kept going: the same files in mind, the same constraint honored, the thread picked up as if the night hadn't happened.

That looks like memory. It isn't — not in the model. The model that produced Wednesday's first token had no recollection of Tuesday; it had never seen any of it. What carried the constraint across the night was not the model remembering. It was a list of messages, written to disk, read back, and handed to a brand-new stateless call *in full*. This post is about that list: why **the transcript is the agent's entire memory**, why you keep all of it, and how it persists and resumes — worked through [efferent](https://github.com/xandreeddev/agent), the coding agent I'm building on Effect.

## A model call has no memory

Start from the uncomfortable fact the whole design rests on: a model call is **stateless**. You send a request, you get a completion, and the provider keeps *nothing*. The next request starts from absolute zero — no session, no scrollback, no "as we discussed." Whatever isn't inside the bytes you send this turn didn't happen, as far as the model is concerned.

So an agent that *appears* to remember is an agent that re-tells the model everything, every single turn. One turn's prompt is the whole world, rebuilt from scratch:

```ts
// every turn: the entire world the model sees, reassembled from nothing
const prompt = [systemPrompt, ...history, newUserMessage]
```

The model is a pure function from that array to the next message. `systemPrompt` is fixed and `newUserMessage` is whatever just got typed — but `history` is the interesting one, because it has to come from *somewhere durable*. It is the only place "what happened so far" can live. The model won't hold it for you; the provider won't; the process won't survive a restart. The memory lives entirely on your side of the wire, and it is exactly as good as your discipline about keeping it.

## So keep the whole history — as an append-only log

The discipline is the simplest one available: write every message down, in order, and never touch it again. **Append-only.** Messages are inserted once and are thereafter immutable — never updated, never deleted, never reordered. One conversation is one growing sequence of rows:

```sql
-- one row per message; written once, never updated, never deleted
CREATE TABLE messages (
  id               uuid    PRIMARY KEY,
  conversation_id  uuid    NOT NULL,
  position         integer NOT NULL,   -- 0, 1, 2, … monotonic within a conversation
  role             text    NOT NULL,   -- denormalised into its own column for cheap filtering
  content          jsonb   NOT NULL,   -- everything else about the message
  created_at       bigint  NOT NULL,
  UNIQUE (conversation_id, position)
)
```

The two load-bearing details are `position` and that `UNIQUE` constraint. The store computes the next position itself, atomically, at the moment of insert — the caller never passes one:

```ts title="packages/adapters/src/conversationStore/sqlite.ts"
INSERT INTO messages (id, conversation_id, position, role, content, created_at)
VALUES (
  ${id}, ${conversationId},
  COALESCE((SELECT MAX(position) + 1 FROM messages WHERE conversation_id = ${conversationId}), 0), // [!code highlight]
  ${msg.role}, ${encodeMessageContent(msg)}, ${createdAt}
)
```

`COALESCE(MAX(position) + 1, 0)` means the first message lands at 0 and every later one takes the next slot; `UNIQUE (conversation_id, position)` means two concurrent appends can't both claim it — one wins, the other is rejected. The sequence is the store's invariant, not the caller's hope. That's the whole persistence model: `append`, and the log grows by one.

It sounds almost too plain to write a post about. But this one rule — *the prefix never changes* — is what three completely different systems quietly depend on. Hold that thought; it's the payoff at the end.

## What a message is, and how a row becomes one

A message isn't free-form text. It's a tagged union — the model's turns, the user's, and tool results all have different shapes:

```ts title="packages/core/src/entities/Conversation.ts"
export const AgentMessage = Schema.Union(UserMessage, AssistantMessage, ToolMessage)
export type AgentMessage = typeof AgentMessage.Type
```

Persisting it is a small codec. On the way down, the `role` is split out into its own column (so you can filter without parsing JSON) and the rest is serialized; on the way *up*, the role is re-attached and the whole thing is **decoded**, not merely parsed:

```ts title="packages/adapters/src/database/messageCodec.ts"
// down: role to its own column, the rest to JSON
export const encodeMessageContent = (msg: AgentMessage): string => {
  const { role: _role, ...rest } = msg as Record<string, unknown>
  return JSON.stringify(rest)
}
// up: re-attach role, then DECODE — a row is bytes until the schema says it's a message
const message = Schema.decodeUnknown(AgentMessage)(reassembleMessageRow(role, content)) // [!code highlight]
```

That distinction matters. A row on disk is bytes; it becomes a trustworthy `AgentMessage` only by surviving the schema on the way out. It also names the most dangerous spot in the whole store: the moment that re-attaching content runs a `JSON.parse` that can throw. Let that throw escape as an untyped defect instead of a tagged failure and your "the only errors here are `ConversationStoreError`" contract is a lie — which is a post of its own. (The `ConversationId` threaded through all of this is a branded type, not a bare string, for reasons that are also a post of their own.)

## Resume is just: load the log and keep going

Here's the part that felt like magic on Wednesday morning, with the magic removed. There is no "restore session" routine. Resuming is the same three moves as starting fresh — read the log, send it, keep appending:

```ts title="packages/core/src/usecases/runAgent.ts"
yield* store.ensure(conversationId, workspaceDir)            // idempotent: create it if new
const checkpoint = yield* store.getLatestCheckpoint(conversationId)
const active     = yield* store.listActive(conversationId)  // the history after the last fold
const prefix     = checkpoint ? [handoffToMessage(checkpoint.summary)] : []

const userMsg: AgentMessage = { role: "user", content: userPrompt }
yield* store.append(conversationId, userMsg)                // persist the new prompt immediately

const result = yield* runAgentLoop({ messages: [...prefix, ...active, userMsg], /* … */ })
for (const m of result.newTail) yield* store.append(conversationId, m) // [!code highlight]
```

Load the prior history, prepend it to the new prompt, run the loop, and append exactly what the loop produced. A first run and a thousandth resume are the same code path — the only difference is how many rows `listActive` hands back. Statelessness stops being a problem the instant the history is durable.

Note the last line: the loop returns `result.newTail` — the precise list of messages it appended this turn — and the caller persists *those*, not a slice of the working buffer. That matters because the buffer can be reshaped mid-run (a giant tool result gets compressed in place), so an index-arithmetic "everything after message N" would persist the wrong bytes. The loop tracking its own output is a discipline worth its own post.

## `list` vs. `listActive`: two read paths, one truth

The store exposes the history two ways, and the difference is the whole game:

```ts title="packages/core/src/ports/ConversationStore.ts"
readonly list:       (id: ConversationId) => Effect.Effect<ReadonlyArray<AgentMessage>, …> // the permanent record
readonly listActive: (id: ConversationId) => Effect.Effect<ReadonlyArray<AgentMessage>, …> // only what's after the latest fold
```

`list` returns everything that ever happened — the immutable record, for browsing, audit, export. `listActive` returns only the suffix the loop actually needs to load. Same rows underneath; one read returns all of them, the other returns the tail after the most recent fold. **The record is immutable; the view narrows.** Keeping those two ideas separate is what lets an agent both "remember everything" and "not re-send everything" — which is the next section.

## A checkpoint is a fold, not a delete

A million-token window fills. You can't re-send a forty-thousand-line history every turn forever. The instinct is to delete or rewrite old messages — and that instinct breaks the append-only rule and everything built on it. The escape is a **checkpoint**: a single row that says *a summary stands in for everything up to position N.*

```ts title="packages/core/src/entities/Conversation.ts"
export const Checkpoint = Schema.Struct({
  conversationId:  ConversationId,
  messagePosition: Schema.Number,   // "everything up to here is covered by the summary"
  summary:         Schema.String,
  createdAt:       Schema.Number,
})
```

`checkpoint(id, summary)` writes one of these at the current head. It deletes nothing. Afterward, `listActive` returns the messages *after* `messagePosition`, with the summary synthesised back in as a single handoff message at load time — so the loop sees "summary of the first 200 turns, then the last 12 verbatim" while `list` still returns all 212. A fold moves a boundary; the originals stay forever. *What* to fold, *when* to fold, and the lossy economics of trading four hundred lines of transcript for a paragraph — that's the window-engineering problem, and a post of its own. The persistence layer's only job is to make folding non-destructive.

## The quiet rule that makes three things work

Now the payoff. "Append-only" reads like tidiness. It's load-bearing — three unrelated systems all depend on the prefix never changing:

- **Prompt caching.** Providers bill a repeated prompt *prefix* at a steep discount, keyed on it being **byte-stable**. An append-only log's prefix only ever grows; every turn after the first re-sends bytes the provider has already seen, unchanged, so all but the new tail is a cache hit. Edit one message in the middle and you invalidate the cache from that byte to the end — the mechanics are a post of its own.
- **Edge compression.** An oversized tool result is clipped *once*, the instant it's appended, and then frozen like every other row. Compression is only safe because nothing already in the log is ever rewritten — clip-on-entry, immutable thereafter — and that, too, is a post of its own.
- **Decode on load.** Every row is re-validated into an `AgentMessage` when read back. The log is bytes at rest and typed values in use, and the boundary between is the schema.

Three features, one invariant. Break "never rewrite the prefix" and you don't lose a nicety — you lose your cache, your compression safety, and your ability to trust what you loaded, all at once.

## Where this log stops, and the next one begins

What I've described is the *linear* conversation: one append-only sequence with fold points, in `ConversationStore`. The moment the agent spawns a sub-agent, that investigation gets its own message log in a *separate, branching* store — `ContextTreeStore`, a tree of runs rather than a line, no shared tables. Why a sub-agent's finished transcript is capital worth persisting and resuming is a post of its own. And both stores ride the same SQLite-by-default substrate that's there thirty seconds after `npm i -g`, with Postgres one env var away — which is, you guessed it, a post of its own.

## What it costs

Honesty section. "Keep everything, forever, append-only" has bills attached.

- **Storage only grows.** A long-lived conversation is a strictly increasing table. For a local coding agent this is rounding-error cheap (text compresses, disks are large), but it is monotonic — nothing here ever reclaims space, by design.
- **You re-send the active history every turn.** Stateless calls mean the per-turn token bill scales with the loaded history. Caching softens the steady state and checkpoints cap the growth, but a *cold* resume re-pays for the whole active prefix once, before the cache warms.
- **You can't edit a message in place.** A correction is a new row the model reads *in sequence*, not a clean redaction of the mistake. That's auditable truth over a tidy buffer — usually the right trade, occasionally the annoying one.
- **The log is only as trustworthy as its codec.** A row that won't decode has to fail loudly, as a typed error, not silently vanish from the history. The invariant is exactly as strong as the parse that enforces it — which is why that one `JSON.parse` got its own post.

## The memory is a list

The agent-memory discourse always reaches for something clever — vector stores, embeddings, a "memory layer," retrieval over a knowledge base. Those have their place. But for the conversation you are actually *in*, the memory is something far dumber and far more reliable: an append-only list of messages, re-sent in full, because the model on the other end remembers nothing and never will.

Statelessness isn't the limitation you engineer around. It's the property that makes the transcript the single source of truth — there is no other copy of what happened, so the list of messages *is* the agent's mind for the length of the task. Write it down, in order, and never take it back, and everything sophisticated you build on top — caching, folding, curation, the whole window lifecycle — has solid ground to stand on. Lose the discipline and none of it can be trusted. The whole trick is a table you only ever append to.
