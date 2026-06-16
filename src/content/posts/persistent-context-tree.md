---
title: 'Sub-agent transcripts are capital, not exhaust'
description: "Most frameworks throw away a sub-agent's context. Keep every one as a node in a persistent, resumable tree instead."
pubDate: 2026-06-11
tags: [agents, ai, effect]
series:
  name: 'How an agent remembers'
  order: 3
---

Every agent framework has sub-agents now, and nearly all of them borrowed the same mental model from operating systems: a sub-agent is a subprocess. Spawn it, hand it a task, collect its stdout, forget it ever existed.

A quick definition, because this post lives on it: a **sub-agent** is a second instance of the agent loop, started by the first, with its own **context window** — its own working memory of messages, separate from the parent's. The parent delegates a task ("find every place we configure retry behavior"), the sub-agent goes off and reads files, runs greps, follows wrong leads, builds a mental model, and finally reports back. In the subprocess framing, that report is the only thing that crosses the boundary:

```ts
const result = await runSubAgent({
  task: 'find every place we configure retry behavior',
})
// result.summary survives. Nothing else does.
```

Look at what the summary *isn't*. It isn't the forty files the sub-agent read. It isn't the three plausible-looking modules it investigated and ruled out. It isn't the layout of a package it now genuinely understands. All of that lived in its context window, all of it cost real tokens — the unit providers bill by, for every word in and out — and all of it is garbage-collected the moment the summary lands.

Then, twenty minutes later, you need a follow-up. "Good — now apply that retry config change you proposed." In the subprocess model there is exactly one option: spawn a fresh sub-agent and pay for the entire investigation again. The re-reading, the dead ends, the ruling-out — from zero. The most expensive thing your system produced last hour was a context window full of verified knowledge about your codebase, and you treated it as exhaust.

[efferent](https://github.com/xandreeddev/agent), the coding agent I'm building, makes the opposite bet: **a sub-agent's context is capital**. Every spawn becomes a node in a persistent tree — stored in the same database as the conversations themselves, resumable, forkable, summarizable, browsable. This post is the full tour: what a node is, the one tool that creates them, the three verbs for spending history, what happens when the repo moves under the tree, what parallel fan-out costs, and the UI for walking through all of it.

## A finished run is a row, not a memory

Start with the data, because the data is the thesis. When a sub-agent finishes, it doesn't evaporate — it settles into a row shaped like this:

```ts title="packages/core/src/entities/AgentContext.ts"
export const EdgeKind = Schema.Literal('spawned', 'branched', 'resumed')

export const AgentContextNode = Schema.Struct({
  id: ContextNodeId,
  parentId: Schema.NullOr(ContextNodeId), // null = a root; the tree is this flat chain // [!code highlight]
  rootConversationId: Schema.NullOr(ConversationId), // the human conversation it hangs off
  edgeKind: EdgeKind,             // how this node came to exist (more below)
  folder: Schema.String,          // writes and bash were confined here
  title: Schema.optional(Schema.String), // the spawner-given name: 'audit state layer'
  seed: ContextSeed,              // descriptor of how the context started: task | selection | handoff
  status: Schema.Literal('running', 'ok', 'error'),
  returnSummary: Schema.optional(Schema.String), // what it reported back
  filesChanged: Schema.Array(Schema.String),
  usage: Schema.optional(ContextUsage),  // billed tokens: input, output, cache reads
  workspaceRef: Schema.optional(Schema.String), // git HEAD when the run finished
  createdAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
})
```

Walk the fields and you can see every section of this post coming. `parentId` makes it a tree — nodes are stored flat and the structure is reconstructed by following the chain, exactly like rebuilding a git history from commit parents. `edgeKind` is **provenance**: was this node `spawned` fresh, `branched` off another node's context, or `resumed` in place? `folder` records the sandbox — the directory this agent was allowed to write in. `returnSummary`, `filesChanged`, and `usage` are the receipt: what it said, what it touched, what it cost. And `workspaceRef` — a stamp of the repo's git `HEAD` at the moment the run finished — is the field that lets the tree notice when the world has moved on (it gets its own section).

Two storage decisions matter here. First, the node row holds a *descriptor* of its context, not the context itself — the actual message history lives in a sibling table, one row per message. Two plain tables, `context_nodes` and `context_messages`, in the same SQLite or Postgres database that holds your conversations. The `seed` field records *how* the context began (a fresh `task`, a `selection` of another node's messages, a generated `handoff` brief) without ever storing a message twice. Second, because this is the conversation database and not process memory, sub-agent history survives the process. Quit the TUI, come back tomorrow, and every investigation any sub-agent ever ran is still there, attached to the conversation it served.

That's the whole bet in schema form. Now, how do nodes get made?

## One spawning tool, and a description that does the teaching

[efferent](https://github.com/xandreeddev/agent) has exactly one delegation tool. Not a tool per pre-configured agent role, not a YAML registry of personas — one generic `run_agent` whose parameters the model fills in at call time:

```ts title="packages/core/src/usecases/buildScopeRuntime.ts"
const RunAgentTool = Tool.make('run_agent', {
  description:
    'Spawn a sub-agent to do focused work scoped to a folder. It reads anywhere but ' +
    'writes/runs bash only inside that folder, runs in its own persisted context, and ' +
    'returns { summary, filesChanged, nodeId }. Prefer it when a change is localized ' +
    'to one area; it keeps your own context focused. … ' +
    'DEFAULT TO A FRESH SPAWN: one agent = one piece of work; a new task gets a new ' +
    "agent even in the same folder (fresh context is cheaper and more focused — a " +
    "resume re-feeds the node's entire history every turn). Reuse a node only when " +
    "the new task is a direct follow-up on that node's OWN work.",
  parameters: {
    name: Schema.String,    // short display name: 'audit state layer'
    folder: Schema.String,  // relative to the workspace root
    task: Schema.String,    // explicit — the sub-agent starts fresh unless seeded
    seedFromNode: Schema.optional(Schema.String), // a nodeId from a prior result
    seedMode: Schema.optional(Schema.Literal('resume', 'branch', 'handoff')),
  },
  success: Schema.Struct({
    summary: Schema.String,
    filesChanged: Schema.Array(Schema.String),
    nodeId: Schema.String, // [!code highlight]
  }),
  failure: Failure,
  failureMode: 'return', // a failed spawn is data the model reads, not a dead turn
})
```

Three things in this declaration deserve a slow look.

**The sandbox is a folder.** A spawned sub-agent can *read* anywhere in the workspace — context is cheap to gather and starving it helps nobody — but its writes and its bash commands are confined to the `folder` it was scoped to. If that folder contains a `SCOPE.md` file, its body gets injected into the sub-agent's system prompt as ambient context: the directory's local rules, conventions, and warnings, known automatically by every agent that ever works there. Folder scoping is also what makes parallelism safe later, so file it away. Nesting is bounded too — a sub-agent can spawn its own sub-agents, but past a depth limit (default 2) the tool returns a model-readable refusal: *"sub-agent nesting limit (2) reached — do this part yourself."*

**The `nodeId` in the success type is the claim ticket.** This is the line that breaks the subprocess model. The parent doesn't just get a summary back; it gets a durable reference to the context that produced the summary. Every later section of this post is a different way of redeeming that ticket.

**The description is the policy.** Read it again — it isn't documentation, it's *teaching*. It tells the model when delegation pays ("a change localized to one area"), what the default should be ("DEFAULT TO A FRESH SPAWN: one agent = one piece of work"), why ("fresh context is cheaper and more focused — a resume re-feeds the node's entire history every turn"), and the one condition under which reuse is justified ("a direct follow-up on that node's OWN work"). Tool descriptions are the most underrated prompt surface in agent design: this paragraph runs on every single turn, exactly where the decision gets made, and it encodes an economic argument the model can actually apply. When people ask where the "when should the agent spawn vs. reuse" logic lives, the answer is: right there, in the schema.

## Three verbs over history

`seedFromNode` plus `seedMode` is where persisted context turns into spendable capital. Given a node id from any prior result, the parent has three verbs — and the interesting question is why there are three instead of one.

The answer is that "continue that earlier work" is not one operation. It's a point on a curve that trades **fidelity** (how much of the original context survives) against **cost** (how many tokens every subsequent turn pays to carry it). One verb would force one point on that curve; [efferent](https://github.com/xandreeddev/agent) exposes three:

- **`resume`** — continue *in* the node's own context. The task is appended to its persisted history and the loop re-runs over all of it; the same node keeps growing. Full fidelity: every file the agent read is still literally in its window, byte for byte. Also full price: the entire history is re-fed on every turn. The tool description reserves it for when *exact file contents in that context matter* — "fix the bug in the function you just wrote" wants the function verbatim, not a paraphrase.
- **`branch`** — fork a *new* node seeded with a copy of the source's messages. Same fidelity as resume on the first turn, but the original node stays frozen — you can retry, or take an alternative direction, without contaminating the context you might want to come back to. This is the default when `seedMode` is omitted.
- **`handoff`** — seed a *fresh* node with a **generated brief**: a small model-written summary of the source node's work. Continuity at a fraction of the tokens. The schema annotation is blunt about the preference: *"'handoff' (PREFER for follow-ups) seeds a fresh node with a generated brief of the source's work — continuity at a fraction of the tokens."* Most follow-ups need what the source *concluded*, not the raw transcript it concluded it from.

Here's the seeding logic, simplified from the `run_agent` handler:

```ts title="packages/core/src/usecases/buildScopeRuntime.ts"
const node = yield* store.get(nodeId)
const brief = yield* buildStalenessBrief({          // §"The world moves", below
  workspaceDir: displayRoot,
  nodeFolder: node.folder,
  stampedRef: node.workspaceRef,
})
const taskMsg = brief !== null ? `${brief}\n\n${task}` : task

if (seedMode === 'resume') {
  // The same node keeps growing: append the task, re-run over the full history.
  yield* store.append(nodeId, { role: 'user', content: taskMsg })
  const seedMessages = yield* store.listMessages(nodeId)
  return yield* runSpawnedAgent({ nodeId, folder: node.folder, seedMessages /* … */ })
}

// 'branch' and 'handoff' both create a child node — they differ only in the seed.
const sourceMsgs = yield* store.listMessages(nodeId)
const seedMessages =
  seedMode === 'handoff'
    ? [handoffToMessage(yield* generateHandoffBrief(sourceMsgs)), { role: 'user', content: taskMsg }] // [!code highlight]
    : [...sourceMsgs, { role: 'user', content: taskMsg }]
const childId = yield* store.spawn({
  parentId: nodeId, // the fork hangs off its source in the tree
  edgeKind: 'branched',
  seedMessages,
  // …
})
```

The highlighted line is the entire economics of `handoff` in one expression: instead of copying a history that might be a hundred thousand tokens, generate a brief once, and the new node's every turn carries a few hundred tokens of distilled context instead. The investigation was paid for once; the *conclusions* are now nearly free to hand around.

### Why the handoff brief is a flat transcript

`generateHandoffBrief` has one trick worth stealing. The obvious implementation — replay the source node's messages to a summarizer model in their original user/assistant roles — fails in a funny way: a transcript fed back as alternating turns structurally cues the model to *continue the conversation*, not summarize it. An early version of this code got back a handoff that read "Let me know how you'd like to proceed!" — the model had politely produced the next assistant turn.

The fix is to render the whole history as one labelled transcript string inside a *single* user message:

```ts title="packages/core/src/usecases/handoff.ts"
export const generateHandoffBrief = (view: ReadonlyArray<AgentMessage>) =>
  Effect.gen(function* () {
    const prompt = Prompt.make([
      { role: 'system', content: HANDOFF_PROMPT },
      {
        role: 'user',
        content:
          'Summarize the following conversation transcript into a handoff, ' +
          'following your instructions exactly. Reply with ONLY the summary.\n\n' +
          '<transcript>\n' + renderTranscript(view) + '\n</transcript>', // [!code highlight]
      },
    ])
    const res = yield* LanguageModel.generateText({ prompt })
    return res.text.trim()
  })
```

A flat transcript inside one user turn leaves the model only one reasonable move: reply with the summary. The rendering also keeps tool calls visible by name with their ok/fail status — so the brief can say what was actually *done*, not just what was discussed. (The main human conversation has its own checkpoint-and-fold story built on the same summarizer — a post of its own. This tree is about sub-agent contexts.)

## The world moves under the tree

A persisted context has a failure mode an ephemeral one can't: it outlives the world it describes. A node that read fifteen files two days ago holds, in effect, cached copies of those files — and models trust their context over re-reading. Resume that node after a teammate's refactor landed and it will confidently edit code that no longer looks like what's in its window.

This is why every node gets stamped with `workspaceRef` — the repo's git `HEAD` — when its run finishes. Any later `resume` or `branch` compares the stamp against the current `HEAD`. If they differ, the spawner prepends a **staleness brief** to the task: which ref range moved, a `git diff --stat` (the per-file changed-lines summary) scoped to the node's folder, and one imperative sentence:

```ts title="packages/core/src/usecases/staleness.ts"
export const stalenessNote = (args: {
  oldRef: string
  newRef: string
  folder: string
  diffStat: string | null
}): string => {
  const head = `[workspace changed since this context last ran: ${short(args.oldRef)}..${short(args.newRef)}]`
  const body =
    args.diffStat !== null
      ? `Changed under ${args.folder} since then:\n${args.diffStat}`
      : `(no changes under ${args.folder} itself, but the repo moved — shared code may differ)`
  return `${head}\n${body}\nFiles you read earlier may be stale — re-read anything you intend to edit before editing it.` // [!code highlight]
}
```

The last line is the one that changes behavior — the diffstat tells the model *what* to distrust, the imperative tells it *what to do about it*. The tree UI surfaces the same comparison passively: a finished node whose stamp differs from the current `HEAD` wears a `stale` badge, so the human browsing the tree knows that node's beliefs predate the current code.

Note what staleness is *not*: an eviction. A stale node is still capital — its understanding of structure, its ruled-out dead ends, its conclusions are mostly intact; it's the byte-level file contents that have rotted. So the design answer is a brief, not a deletion. And the whole mechanism is deliberately best-effort: a non-git workspace simply never stamps, a garbage-collected old ref produces no diffstat rather than an error. A staleness check must never be the reason a spawn fails.

## Fan-out wants a budget, not a leash

Sub-agents earn their keep in parallel. One assistant turn can emit several `run_agent` calls, and the loop resolves a turn's tool calls concurrently (four at a time by default) — so "audit these three packages" genuinely fans out into three simultaneous investigations. Folder scoping is what makes that safe *by construction*: agents sandboxed to disjoint folders cannot race each other's writes. Spawns into the *same* folder would race, so each folder gets a lock and same-folder spawns queue behind one another — the semaphore mechanics are a post of its own; the product-level point is just that disjoint work parallelizes freely and overlapping work serializes automatically, with nothing for the model to coordinate.

Parallelism has a second failure mode, though, and it isn't correctness — it's the bill. Depth limits and step caps bound how *long* a tree can run, but a depth-2 tree with enthusiastic fan-out is still an unbounded spend. So all sub-agents spawned within one top-level turn share a single **token pool** — default one million billed tokens, adjustable with `:set subAgentTokenBudget`. Shared, not sliced: children race for the remainder rather than receiving pre-committed allocations they might never use. Every LLM call any sub-agent makes drains the pool by what the provider actually bills for it.

What happens at exhaustion is the part designed with care, because both audiences of the failure are models:

```ts title="packages/core/src/usecases/tokenBudget.ts"
/** Default pool: 1M tokens per top-level turn across all sub-agents. */
export const DEFAULT_SUB_AGENT_TOKEN_BUDGET = 1_000_000

/** The model-facing failure for a spawn attempted on a drained pool. */
export const budgetExhaustedFailure = {
  error: 'BudgetExhausted',
  message:
    'the sub-agent token budget for this turn is exhausted — do the remaining work yourself instead of spawning.', // [!code highlight]
} as const

/** Appended to a sub-agent's summary when the pool stopped it early. */
export const BUDGET_STOP_NOTE =
  '[stopped early: the shared sub-agent token budget ran out — this result is partial]'
```

A drained pool refuses *new* spawns with that first message — not an exception, a tool result, complete with the recommended next move, so the parent model degrades gracefully and finishes the remaining work in its own context. Sub-agents *already running* aren't killed mid-flight: each one stops at its next **turn boundary** — never mid-tool-call, which would leave a tool invocation without its result and corrupt the message history — and its summary arrives wearing the `BUDGET_STOP_NOTE`. That last detail matters more than it looks: without an explicit partial-result marker, a truncated run's mid-thought final sentence reads exactly like a confident deliverable. The same trick guards the per-agent step cap (eighty turns by default): a capped run's summary gets stamped `[stopped early: the step limit was reached — this result is partial]`.

Spend is also visible after the fact — every node records its billed usage, and the tree view shows per-node token counts. When a turn cost more than it should have, you can see exactly which subtree ate it.

## Browsing the capital

Capital you can't inspect is just a bigger database. The `:tree` command in [efferent](https://github.com/xandreeddev/agent)'s TUI opens the agent navigator: the active session as the root, with its persisted sub-agent tree railed beneath it, git-log-graph style —

```
❯ refactor retry handling                       ◀ active
├─ ✓ audit retry config    spawned · task · 3 files · 41k tok
│  └─ ✓ apply new backoff  branched · handoff · 2 files · 9k tok
└─ ✓ map adapter ports     spawned · task · 38k tok · stale
```

Each row is a rendering of one node, and the row model is a compact restatement of everything this post has covered:

```ts title="packages/cli/src/tui-solid/presentation/contextTreeView.ts"
export interface TreeNodeDisplay {
  kind: 'node'
  label: string            // the spawner-given title, else the folder basename
  status: 'running' | 'ok' | 'error'
  edgeKind: 'spawned' | 'branched' | 'resumed'
  seedKind: 'task' | 'selection' | 'handoff'
  summary: string | null   // first line of what the node returned
  filesCount: number
  tokens: string | null    // billed tokens, formatted: '38k tok'
  stale: boolean           // the workspace moved since this node ran
  active: boolean          // this node's session is open — the composer feeds IT // [!code highlight]
  nodeId: string
}
```

Provenance, seed kind, cost, staleness — the receipt fields, on screen. But the view isn't read-only, and that's where it gets good. Press Enter on a node and its full persisted session opens as a preview over the conversation pane: every message replayed, with a marker showing where the seed ends and the node's own run begins. And while that preview is open, the composer routes to *that node* — type a message and it resumes the node in place, through the same machinery as the model's `seedMode: 'resume'`, staleness brief included, with a fresh token budget since the human is now the root of the spend. That's the highlighted field above: `active` means "where a typed message goes," and only one row can claim it.

Two more keys complete the verb set. `c` on a node forks its entire context into a brand-new conversation and makes it the active session — the human-driven counterpart of `branch`, for when a sub-agent's investigation turns out to be the real work and you want to take over exactly where it stopped. `d` drops a node and its descendants, for the trees that turned out to be weeds. A second view, `:sessions`, lists every conversation on the workspace so you can hop between the trees themselves.

The symmetry is the design: **the human gets the same verbs over the same capital as the model.** Resume in place, fork and redirect, inspect the receipt. A sub-agent's context isn't an implementation detail of one tool call anymore; it's a first-class object either kind of operator can pick up later.

## What it costs

Honesty section. Persisting every sub-agent context is a bet with real downsides, and three of them live in this design today.

**Storage only grows.** Every spawn persists its full message history, forever, until a human presses `d`. There's no retention policy, no automatic pruning of month-old nodes. For text transcripts in SQLite this is cheap in absolute terms — but "we never delete an investigation" is a decision, and right now the garbage collector is you.

**Staleness detection is folder-deep, not dependency-deep.** The diffstat that powers the staleness brief is scoped to the node's folder, because that's what the node was sandboxed to. A node whose conclusions depend on shared code *outside* its folder — a type it imports from a sibling package, say — gets only the weaker "the repo moved — shared code may differ" warning when that dependency changes. A real dependency graph would catch it; a folder-scoped `git diff --stat` is a heuristic that's right most of the time and cheap all of the time.

**Handoff is lossy by a model's judgment, and the policy is prompted, not enforced.** A generated brief is a summary — it can drop the one detail the follow-up actually needed, and you find out one turn later. That's precisely why `resume` survives as the escape hatch. And the fresh-vs-reuse-vs-handoff routing lives in a tool description, which means it's persuasion: a model can still `resume` a two-hundred-thousand-token node to ask a one-line question. The shared budget is the backstop that turns that mistake from a disaster into a line item. (Provider prompt caching softens the resume tax considerably — a post of its own.)

What I'd claim against all three: the disposable model has the same costs, paid differently. You "prune" by losing everything, your staleness detection is *nothing is ever stale because nothing is ever kept*, and your handoff fidelity is whatever survived in one summary paragraph. The tree doesn't add these problems; it makes them visible and gives you knobs.

## Keep what you paid for

The agent-memory conversation in 2026 is dominated by two answers: make the window bigger, or distill experience into a vector store and hope retrieval surfaces the right shard at the right moment. Both quietly accept the same premise — that the working context itself is disposable, so memory has to be *reconstructed* from it before it's thrown away.

I think that premise is wrong for coding agents, where the expensive artifact is a transcript full of verified, situated knowledge: this file does X, that approach fails because Y, this package's tests run like Z. You don't need to embed what you can simply keep — with provenance saying where it came from, a git stamp saying which world it described, and a usage line saying what it cost. Persistence, provenance, and accounting: that's the whole trick, and none of it is machine learning. It's a schema.

Context windows are the scarce resource in agent systems. Scarce resources get treated one of two ways — burned, or invested. Stop strip-mining your sub-agents; the transcript was the expensive part. Keep it.
