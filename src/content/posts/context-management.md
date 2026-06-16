---
title: 'The context window is a resource you engineer, not a buffer you fill'
description: 'What lives in an agent context window, and the lifecycle — admit, clip, fold, curate — that keeps it working.'
pubDate: 2026-06-29
tags: [agents, ai, effect]
series:
  name: 'How an agent remembers'
  order: 2
draft: true
---

Every coding agent has the same anatomy at the bottom: a loop that sends a pile of text to a model, reads the reply, runs some tools, appends the tool results to the pile, and sends the pile again. The pile is the **context** — everything the model can see while producing its next token, and the agent's entire working memory, because the model itself keeps nothing between calls. (Why a stateless model makes that transcript the *only* memory, and how it's persisted as an append-only log, is a post of its own.) This post starts a layer up — with what happens to the pile as it grows.

That pile lives inside a hard budget called the **context window** — the maximum number of tokens (roughly, word fragments; about four characters each) a model accepts in one request. Window sizes sound generous in 2026 — frontier models take a million tokens — and they are not generous at all, because an agent is a machine for filling them. One `cat` of a build log is 80,000 characters. One enthusiastic `grep` is 40,000. Every tool result lands in the pile and *stays* there, re-sent on every subsequent call, because the loop is append-and-resend. Left alone, a long session doesn't fail loudly; it degrades — the model starts forgetting constraints from hour one, re-reading files it already read, paying more per turn for worse answers — and then it hits the wall and the session is simply over.

So here's the claim this post argues: the context window is the scarcest resource in an agent system, and it deserves what scarce resources always get — a managed lifecycle. **What gets admitted at all. What gets clipped on the way in. What gets folded into summaries. What gets rebuilt by hand.** Each stage is a small, concrete piece of engineering, and each one is checkable in real code: every snippet below is lifted from [efferent](https://github.com/xandreeddev/agent), a coding agent built on Effect, where the main conversation's context is managed through exactly these stages. (Sub-agents get their own persisted, branching contexts there too — that machinery is a post of its own; today is about the one conversation you're actually typing into.)

## What one turn actually sends

Before managing the thing, look at the thing. How a turn's pile gets assembled and persisted — load the folded summary, load the active history, append the new prompt, run the loop, persist exactly what it produced — is the foundation post's subject (a post of its own). Take that assembled pile as given and weigh what the model actually receives each turn, with rough weights:

- **The system prompt** — identity, behavioral rules, a dozen tool descriptions, the sub-agent routing policy, plus three injected sections we'll meet in a moment (a skills index, discovered instruction files, ambient folder context). In [efferent](https://github.com/xandreeddev/agent) the fixed part is roughly 2,500 tokens. Rebuilt every turn, byte-identical.
- **The handoff prefix** — at most one synthetic message carrying a summary of everything already folded away. A few hundred tokens, or absent entirely.
- **The active message history** — user messages, assistant replies, and tool results, in order. Unbounded by nature. This is where the budget goes: a turn that reads four files and runs a test suite can append more tokens than everything above combined.
- **The new user message** — whatever you just typed.

Notice the shape of the problem. Every component except one is *bounded by construction* — the system prompt is fixed, the prefix is one message, your prompt is your prompt. History is the only part that grows, and tool results are the only part of history that grows *fast*. So the lifecycle has an obvious structure: be stingy at admission time (the system prompt), clip the firehose at the edge (tool results), and fold the accumulated past when it gets long (history). Each gets a section.

## Admission control: pay for an index, lazy-load the body

The first lifecycle stage happens before the conversation even starts: deciding what earns a permanent seat in the system prompt. Permanent seats are the most expensive real estate in the system — whatever sits there is re-sent on *every single call*, forever. The principle [efferent](https://github.com/xandreeddev/agent) applies, three times over, is one you already know from every other corner of computing: **pay for an index up front; lazy-load the body on demand.**

### Skills: names up front, bodies behind a tool

A *skill* is a reusable procedure written as a markdown file — "how we do database migrations here", "the release checklist" — with a name and a one-line description in its frontmatter. The tempting design is to inject every skill wholesale into the system prompt: the model would always know everything. It would also pay for everything, every turn, whether or not any of it applies.

So only the index is admitted. At startup, skills are discovered by walking `cwd → parent directories → ~/.efferent/skills/` (closer files shadow farther ones on name collisions), and the prompt gets one line per skill:

```ts title="packages/core/src/prompts/coder.ts"
const renderSkillsSection = (skills: ReadonlyArray<Skill>): string => {
  if (skills.length === 0) return ''
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n') // [!code highlight]
  return `
# Skills
The following named procedures are available. Each is a short markdown document
with steps for handling a specific kind of task. Read one with
'read_skill({ name })' when its name and description suggest it applies —
then follow the steps.

${lines}
`
}
```

The bodies stay on disk. The toolkit gains one tool, `read_skill({ name })`, that returns a skill's full text as an ordinary tool result — so a thousand-token procedure enters the context only in the sessions that actually need it, *when* they need it. The standing cost of carrying ten skills is ten lines, maybe two hundred tokens; the cost of the wholesale design would be ten thousand, every turn, forever. Same knowledge, two orders of magnitude apart — that's what admission control buys.

### Instruction files: discovered, ordered, capped

The second admitted artifact is workspace guidance — the `AGENT.md` convention, where a repo carries durable instructions for any agent working in it ("run `bun test`, not `npm test`; never touch `generated/`"). These *do* earn permanent seats: they're rules, and a rule the model can't see is a rule it will break. But the discovery is hierarchical and the budget is explicit:

```ts title="packages/core/src/usecases/discoverInstructionFiles.ts"
/** Per-file char cap in the rendered prompt. */
export const MAX_INSTRUCTION_FILE_CHARS = 4_000
/** Total char budget for the whole '# Instructions' section. */
export const MAX_TOTAL_INSTRUCTION_CHARS = 12_000 // [!code highlight]

// Order: root → … → cwd → homeDir. Broad guidance first, narrowing in.
const instructionSearchPath = (cwd: string, homeDir: string): ReadonlyArray<string> => {
  const chain: string[] = []
  let dir = cwd
  while (true) {
    chain.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  chain.reverse()
  if (!chain.includes(homeDir)) chain.push(homeDir)
  return chain
}
```

The walk collects `AGENT.md` and `AGENT.local.md` from the filesystem root down to the working directory, then the home directory — so the rendered section reads broad-then-narrow, monorepo conventions before package quirks. Duplicate content is deduped (people copy the same AGENT.md between repos; it should cost its tokens once), each file is labeled with the directory it came from so the model knows *which guidance applies where*, and the caps are hard: 4,000 characters per file, 12,000 for the whole section — about 3,000 tokens, worst case. A workspace can't accidentally spend a fifth of the window on prose just because someone wrote an enthusiastic README-shaped rulebook. Past the budget, the section says so out loud — `_Additional instruction content omitted…_` — rather than silently dropping files.

### SCOPE.md: context attached to a place

The third instance is the quietest. A folder can carry a `SCOPE.md` whose body is ambient context for that folder — the local conventions of one package. It's admitted into a prompt only when an agent is actually *scoped there* (sub-agents in [efferent](https://github.com/xandreeddev/agent) run confined to a folder; a root `SCOPE.md` seeds the main prompt the same way):

```ts title="packages/core/src/usecases/discoverScopeTree.ts"
/** Ambient folder context: the body of a folder's SCOPE.md, injected into
 *  any agent that runs scoped to that folder. */
export const getScopePromptBody = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const read = yield* fs.read(resolve(folder, 'SCOPE.md')).pipe(
      Effect.catchAll(() => Effect.succeed(null)), // [!code highlight]
    )
    if (read === null) return null
    const body = stripFrontmatter(read.content)
    return body.trim().length > 0 ? body : null
  })
```

Note what these three mechanisms have in common, because it's the actual lesson: in every case, the *decision about relevance* is made structurally — by name matching, by directory hierarchy, by physical location — instead of by stuffing everything in and hoping the model's attention sorts it out. Attention over a bloated context is exactly what degrades first in long sessions. Admission control isn't (only) about cost; it's about keeping the signal-to-noise of the working memory high enough that the rules which *are* present still bind. (The reads are also all failure-proof, the `catchAll` above — a malformed skill or an unreadable AGENT.md silently contributes nothing rather than breaking the agent. Ambient context must never be load-bearing for liveness.)

## Compression at the edges

Stage two guards the fast-growing part: tool results. The moment a result enters the message buffer — before the model, the store, or anything else sees it — any string over a budget (default 4,000 tokens, ~16,000 characters) is compressed *once, at append time*: structure-aware where the output has shape (grep output keeps every file with its first matches and exact counts; bash logs keep errors, tracebacks, and summary lines), a blind head-plus-tail clip where it doesn't, always ending in a marker that names what was dropped and how to get it back — `[…headroom: ~4509 tokens of this Bash output omitted. To retrieve it, re-run the tool narrower — read_file with offset/limit, a more specific grep…]`. The discipline that matters for *this* post is the "once, at append time" part: nothing already in the buffer is ever rewritten — the append-only invariant that keeps provider caches warm, which is a post of its own. Clipped on entry, immutable thereafter. The compression machinery itself — the structure detection, the reversible markers, the fast-model digests woven into them — is one stage of this lifecycle and a post of its own.

## Folding: the handoff

Admission control bounds the prompt; edge compression bounds each result. Neither touches the real killer: the *accumulation*. Forty turns of perfectly reasonable, individually-clipped messages will still fill a window. Eventually you need to shrink history itself — and this is where most agent tooling reaches for the blunt instrument called "compaction": summarize the conversation, throw away the originals, hope the summary was good. The fold in [efferent](https://github.com/xandreeddev/agent) — called a **handoff** — is built on a refusal to do the second part. Summaries are views. Originals are forever.

The mechanism rests on one storage decision: the conversation store offers two read paths over the same immutable rows — `list`, the permanent record, and `listActive`, only the messages after the latest checkpoint. A **checkpoint** is a fold row that says *this summary stands in for everything up to position N*; it deletes nothing, it moves a boundary. That store and its append-only guarantee are the foundation post's subject (a post of its own); what matters here is what folding *does* with those two read paths — the loaded view narrows, the record doesn't.

Creating a fold is the `:handoff` command, and the use case is short enough to read whole:

```ts title="packages/core/src/usecases/handoff.ts"
export const createHandoff = (conversationId: ConversationId) =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const prior = yield* store.getLatestCheckpoint(conversationId)
    const active = yield* store.listActive(conversationId)
    if (active.length === 0) return // nothing new since the last fold

    const view = [
      ...(prior === null ? [] : [handoffToMessage(prior.summary)]), // [!code highlight]
      ...active,
    ]
    const summary = yield* generateHandoffBrief(view)
    yield* store.checkpoint(conversationId, summary)
  })
```

The highlighted line is the subtle one. The summarizer is fed the **currently loaded view** — the prior summary plus everything since — not the raw full record. That makes folds *cumulative*: the second handoff folds the first summary back in, so there is always exactly one summary in play, refreshed each time, rather than a chain of summaries-of-fragments the model would have to mentally splice. Fold ten times across a marathon session and the next turn still loads one brief plus the recent tail.

The summary itself is generated against a structured prompt — Goal, State & what's done (with real paths and symbols), Next steps, Constraints & preferences — because from the next turn on it is the *only* prior context the model sees, and "be specific enough to continue the work" is the entire job description. One implementation detail earned its keep the hard way: the transcript is rendered into a *single flat user message* (`USER: …` / `ASSISTANT: …` lines) rather than replayed as role-alternating messages. Replayed roles structurally cue a chat model to *continue* the conversation — an early version of the fold once came back with "Let me know how you'd like to proceed!" as the summary. A flat transcript inside one user turn leaves the model only one reasonable move: actually summarize. Context engineering goes all the way down; even the summarizer's input is a managed context.

And on the next turn, `runAgent` — back in the first section's snippet — loads `getLatestCheckpoint` + `listActive` and prepends the summary as one synthetic user message, prefixed with a system note telling the model the earlier history was handed off and the summary is now the source of truth. The model sees `[handoff] + [recent messages] + [your prompt]`. Everything before the fold still exists, browsable, recoverable — just never re-fed.

### The auto-fold

Manual `:handoff` is for when you feel the session getting heavy. The system also watches for you. After each turn, the driver checks whether that turn's *reported* input size crossed a threshold of the window:

```ts title="packages/core/src/usecases/headroom.ts"
export const DEFAULT_AUTO_HANDOFF_PCT = 85

/** `true` when the context is full enough that the driver should fold now. */
export const shouldAutoHandoff = (
  inputTokens: number,
  contextWindow: number,
  pct: number,
): boolean =>
  pct > 0 && contextWindow > 0 && inputTokens / contextWindow >= pct / 100 // [!code highlight]
```

Crossing 85% triggers a handoff automatically *at the turn boundary* — with two deliberate refusals visible at the call site. It doesn't fire while follow-up messages are queued (fold once the queue drains, not in the middle of a burst of work). And it doesn't fire on resume *estimates* — when you reopen an old session, the gauge is seeded from a chars-divided-by-four guess, and a guess must never trigger a surprise fold; the first real turn's actual usage decides. Both refusals encode the same judgment: a fold is a meaningful, slightly lossy event, so it happens at deliberate moments, not reflexively.

Why 85% and not 99%? Headroom. The whole point is to fold *before* the wall, while there's still room for the post-fold session to do real work — including the fold itself, which is one more model call. And there's a second economy running underneath: since provider caches key on byte-stable prefixes, an unfolded session keeps hitting cache turn after turn, and a fold is one deliberate prefix rebuild — the next call re-pays for the new, much shorter prefix once, and then the cache is warm again (the provider-by-provider cache mechanics are a post of their own).

## Curation: context you can edit

Everything so far is automatic or one keystroke. The last stage is the interesting one philosophically: treating context as something you *edit*, not just something that accumulates and occasionally folds.

The entry point is `:context`, which opens a viewer over the conversation — built from `list` plus `listCheckpoints`, which is exactly why the store keeps both read paths. The viewer partitions the full record into **archived segments** (each one the set of original messages a particular handoff folded away, headed by that handoff's summary) and the final **loaded segment** (what the model currently sees). Within each segment, messages are grouped into **turns** — a user message plus every assistant reply and tool result that followed it, one complete unit of work — rendered as a foldable, selectable tree. For the first time in the session, you can *see* the thing this whole post is about: here's what the model gets, here's the three hundred messages it no longer does, here's the summary standing in for them.

Then comes the verb. `Space` selects units — individual turns, or a whole handoff — and `b` (the `:build` command) creates a **new conversation seeded with exactly the selected units**, and switches to it:

```ts title="packages/cli/src/tui-solid/presentation/contextView.ts"
export const messagesForSelectedTurns = (
  segments: ReadonlyArray<ContextSegment>,
  selected: ReadonlySet<number>,        // turn indices
  selectedHandoffs: ReadonlySet<number>, // handoff indices
): ReadonlyArray<AgentMessage> => {
  const out: AgentMessage[] = []
  let turnIdx = 0
  for (const seg of segments) {
    if (seg.kind === 'archived' && selectedHandoffs.has(seg.handoffIndex)) {
      out.push(handoffToMessage(seg.summary)) // [!code highlight]
    }
    for (const turn of groupTurns(seg.messages)) {
      if (selected.has(turnIdx)) out.push(...turn)
      turnIdx++
    }
  }
  return out
}
```

The seed preserves conversation order, and two invariants make it safe. First, **turn granularity keeps the transcript structurally valid**: providers reject a history where an assistant message calls a tool and no matching result follows, and since a turn carries its tool calls *and* their results as one unit, whole-turn selection can't orphan a pair — validity by construction, not by validation. Second, a selected handoff contributes *only its summary*, as the same synthetic message `runAgent` would build — and the viewer keeps a handoff and its own inner turns mutually exclusive at selection time (picking one clears the other), so the seed can never contain both the summary of a segment and the originals it summarizes saying subtly different things.

The original conversation is untouched — `:build` writes a brand-new one via `create` and `append` and leaves the source exactly as it was. So the move is really a *fork with intent*: "give me a fresh session that knows the architecture discussion from Tuesday, the summary of the refactor, and nothing about the four debugging detours." That's surgery you simply cannot express with an append-only chat and a compact button. It also reframes what a long messy session *is*: not a liability to be flushed, but raw material — the turns that mattered are sitting right there, selectable.

One small grace note rides on the same store: each conversation gets a generated title after its first exchange (a one-shot call on the cheap helper tier — `generateSessionTitle`, persisted via `setTitle`), so the session list you're choosing from reads like commit subjects instead of raw first-prompt previews. Curation starts with being able to tell your contexts apart.

## The accounting

None of the above matters if the user can't see the resource being spent. The lifecycle's quietest component is its instrumentation, and the TUI treats context spend as a first-class number: the status bar reads like `gemini-3.5-pro · ▓▓░░ 12% 18k/1M · 86% cached · sqlite · ~/code/app` — current model, a context gauge with used-over-window, and the share of the last turn's input that was served from the provider's cache. The gauge's color follows one shared scale:

```ts title="packages/cli/src/tui-solid/presentation/statusBar.ts"
export type GaugeSeverity = 'ok' | 'warn' | 'critical'

export const gaugeSeverity = (used: number, total: number): GaugeSeverity => {
  const pct = contextPercent(used, total)
  if (pct === null) return 'ok'
  return pct >= 90 ? 'critical' : pct >= 70 ? 'warn' : 'ok' // [!code highlight]
}
```

Under 70%, bookkeeping. From 70%, the gauge turns warm — a fold is worth planning. From 90%, critical, with an explicit nudge to `:handoff` now — that's past the auto-fold threshold, so seeing it means auto-fold is off or an estimate is uncertain, and the human is the remaining line of defense. The same severity function drives every surface the number appears on, so the status bar and the activity dashboard can't disagree about how worried to be. Alongside it runs a per-role spend ledger — `Σ main 64k · fast 1.2k · cheap 160` — because the lifecycle itself costs tokens: handoff summaries, clip digests, and session titles all run on helper models, and spend that isn't counted is spend that quietly grows.

Here's why this section earns its place in a lifecycle post rather than a UI post: **visibility changes behavior, on both sides of the screen.** A user who watches the gauge climb folds at a natural boundary — after the tests pass, before the next work item — instead of having degradation diagnose itself three turns too late. A user who sees `86% cached` understands viscerally why history is immutable and why the fold happens at boundaries rather than continuously. And a user who sees one turn add twelve points to the gauge learns which of their own habits are expensive — "read the whole file" versus "read the function" — in a way no documentation teaches. Resource meters create resource discipline. Fuel gauges work; warning lights after the engine stops don't.

## What this costs

The honest section. Three tradeoffs are inherent to this design, and one is just true of the whole problem.

**Summaries lose nuance — definitionally.** A handoff brief is a lossy projection chosen by a model, and the loss has a particular flavor: briefs keep *conclusions* and shed *texture*. The exact error message that motivated a workaround, the precise `oldText` of an edit, the user's offhand "oh, and never use barrel imports" from forty turns ago — any of these can fall out of a Goal/State/Next-steps brief, and the post-fold model will be confidently ignorant of them. This is exactly why originals are never deleted: `list` still has everything, the viewer can show it, and `:build` can resurrect the original turns when the summary turns out to have dropped the load-bearing detail. The architecture's bet is not "summaries are good enough"; it's "summaries are good enough *most* of the time, and recoverable when they aren't." An agent that compacts destructively is making the first bet without the hedge.

**The auto-fold threshold is a heuristic, and a percentage doesn't know what it's truncating.** 85% of the window says nothing about whether *now* is a good moment — the turn boundary right before the model was about to use a detail from the foldable region is a bad fold, and no threshold can see that coming. The mitigations are procedural, not clever: fold only at turn boundaries, never mid-burst, never on estimated usage, and keep the knob user-owned (`:set autoHandoffPct`, including off). It also only folds *between* runs — folding inside one very long multi-tool run is a separate, harder problem (the loop's buffer would have to shrink under the model mid-flight) that [efferent](https://github.com/xandreeddev/agent) deliberately hasn't shipped yet.

**Curation assumes the curator knows what mattered.** `:build` is a scalpel, and a scalpel transfers responsibility to the hand holding it. Turn granularity guarantees the seeded session is *structurally* valid; nothing guarantees it's *semantically* complete — skip the turn where the constraint was stated and the new session will cheerfully violate it. The viewer narrows the gap (subjects, summaries, message previews make turns skimmable) but cannot close it. This is a tool for someone who was present for the work. That's the right default for a terminal agent driven by its own user; it would be the wrong default for an autonomous fleet, which is why the sub-agent side of the system leans on generated handoff briefs instead of human selection.

And underneath all three: every stage here adds machinery — checkpoint tables, append-time clipping, severity plumbing, a curation UI — to *partially* compensate for a hard physical budget. The complexity doesn't make the window bigger. It makes the window's contents deliberate. That's the only honest framing of every context-management system, including this one.

## The window is the work

A prediction you can test against your own experience: take two agents on the *same* model, same tools, same task, and run them for three hours. One is still sharp; one is re-reading files, forgetting your conventions, apologizing its way toward the wall. People reflexively blame the model — wrong size, wrong vendor, wrong week. But the difference between an agent that degrades over a long session and one that doesn't is rarely the model. It's whether anyone engineered the window: whether knowledge pays for an index instead of a permanent seat, whether tool output is clipped at the door, whether the past folds into something dense instead of dragging behind the conversation, whether the human can see the gauge and edit the pile.

None of the code in this post is exotic. A checkpoint table. A directory walk with a character budget. A threshold check. A set of selected turn indices. The model gets all the headlines, but the model is the one component you *can't* engineer — it's an API call. The window is the part that's actually yours. Treat it like working memory, because that's what it is — and nobody who cares about a system's performance has ever said "the memory will sort itself out."
