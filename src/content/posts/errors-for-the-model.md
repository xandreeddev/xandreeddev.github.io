---
title: 'Error messages are prompt engineering now'
description: "An agent's failure strings are read by the model that caused them — each should name what happened and the next move."
pubDate: 2026-07-08
tags: [agents, ai, ux]
series:
  name: 'Building a coding agent'
  order: 8
draft: true
---

Every error message you've ever written was addressed to someone who isn't there. That's the genre's founding assumption: the failure happens now, the reading happens later — tonight in a terminal scrollback, next week in a log aggregator, possibly never. The reader arrives with context the message doesn't have to supply (they know what they were trying to do) and tools the message doesn't have to replace (a debugger, the source, a search engine). So we write `EACCES` and a stack trace and call it ergonomics, because the string only has to be a *clue*. The human does the rest.

A coding agent breaks every clause of that assumption. When a tool call fails inside an agent loop, the failure string is read by the model that made the call — the same model, in the same conversation, about two seconds later. It doesn't arrive with context; the transcript *is* its context, and your string just became the newest line of it. It doesn't have a debugger; the string is the entire debugging session. And it doesn't file the message away for later — it acts on it, immediately, in its very next output.

So a failure string in an agent isn't diagnostics. It's an instruction that fires at the precise moment the model leaves the happy path. Here's the same failed write, rendered for each audience:

```
// audience: a human, reading the log tomorrow
Error: EACCES: permission denied, open '/repo/packages/auth/login.ts'

// audience: the model that made the call, reading it in two seconds
{
  error: 'OutOfScope',
  message: 'packages/auth/login.ts is outside this scope (packages/core).
            Defer it to the parent in your summary.',
}
```

The first costs a turn. The model now guesses — `sudo`? `chmod`? retry and hope? Every guess is an LLM call you pay for and a fresh chance to make things worse. The second names what happened in a term the model can act on (*scope* — a concept its system prompt taught it) and ends with the move to make instead. One string wastes the turn; the other saves it.

That's the thesis: **an agent's failure strings are load-bearing prompt engineering.** Each one should name what happened *and* the next move, because the reader will act on it within seconds. The rest of this post is receipts — the real model-facing failure strings from [efferent](https://github.com/xandreeddev/efferent), the coding agent I'm building, quoted verbatim, each with the reasoning behind its wording.

## A failure is a tool result, not an exception

First, the plumbing fact that makes any of this possible. An agent loop is a conversation: the model emits a *tool call* (a named function plus JSON arguments), the runtime executes it, and the outcome goes back into the transcript as a *tool result* — a message the model reads when the loop invokes it again. That is the only channel the model has eyes on. A failure that throws past it — an exception unwinding the stack, killing the turn — is, from the model's point of view, silence. For a failure to be read by the thing that caused it, it has to come back through the same slot as a success: as data in the transcript.

`@effect/ai`, the LLM layer [efferent](https://github.com/xandreeddev/efferent) is built on, makes that a declared property of each tool. A tool ships a `failure` schema next to its `success` schema, and `failureMode: 'return'` means a handler failure becomes the tool's *result* — flagged as an error, but an ordinary message the loop appends and keeps going past:

```ts title="packages/core/src/usecases/codingToolkit.ts"
export const Failure = Schema.Struct({
  error: Schema.String,
  message: Schema.optional(Schema.String),
})

export const EditFile = Tool.make('edit_file', {
  description: 'Apply targeted substring edits to a file. …',
  parameters: { path: Schema.String /* … edits */ },
  success: Schema.Struct({
    path: Schema.String,
    editsApplied: Schema.Number,
    diff: Schema.String,
  }),
  failure: Failure,
  failureMode: 'return', // [!code highlight]
})
```

(How Effect's typed error channel makes these failures pleasant to produce and impossible to forget is a post of its own; what matters here is the *destination*.) The design consequence is bigger than the one-line setting suggests. Once every model-caused failure ends up as `{ error, message }` in the transcript, the `message` field stops being a debugging artifact and becomes a prompt surface — text you know the model will condition on at the most consequential moment available: right after it got something wrong. Exceptions still exist in the codebase, but they're reserved for *our* bugs — a store that won't connect, a result that fails our own schema. The split is by audience: our failures go to logs, the model's failures go to the model.

## The gallery

Six strings from production. None is decoration; each earns its tokens by saving a turn that would otherwise be spent guessing.

### The schema miss

The most common model-caused failure: right tool, wrong argument shape. In `@effect/ai`, a known tool's parameters are decoded against its schema *before* the handler runs — so `failureMode: 'return'`, which only catches handler failures, never sees a decode miss. Left alone, it surfaces as a `MalformedOutput` error that aborts the entire turn over a malformed JSON object. [efferent](https://github.com/xandreeddev/efferent) wraps the toolkit's resolved handler to catch exactly that case and convert it into a tool result:

```ts title="packages/core/src/usecases/agentLoop.ts"
const handle = (name: unknown, params: unknown) =>
  rawHandle(name, params).pipe(
    Effect.catchAll((err) => {
      const e = err as { _tag: string; description: string }
      if (e._tag !== 'MalformedOutput') return Effect.fail(err)
      const failure = {
        error: 'InvalidToolCall',
        message: `${clip(e.description, 800)} — the arguments did not match the tool's schema; re-call the tool with parameters that match its documented shape.`, // [!code highlight]
      }
      return Effect.succeed({ isFailure: true, result: failure })
    }),
  )
```

The message is two halves. The first is the decoder's own description, up to 800 characters — the actual field and the expected type, evidence rather than vibes. Then the dash and the instruction: *"the arguments did not match the tool's schema; re-call the tool with parameters that match its documented shape."* The word "documented" is doing quiet work: the tool's schema is already in the model's context — it ships with every request as part of the tool definition — so the string doesn't re-teach the shape, it redirects attention to documentation the model already holds. Note also which failures the wrapper deliberately lets through: `MalformedInput` — a *result* that fails our own schema — is our bug, and it keeps failing loudly where we'll see it. Same error machinery, two audiences, routed by tag.

### The hallucinated tool

One failure happens a layer earlier: the model invents a tool *name* — `apply_patch`, `str_replace_editor`, vocabulary imported from whichever harness dominated its training data. Now there's no handler to even address. The response itself fails to decode inside `generateText`, so the wrapper above never fires, and the naive outcome is a dead turn over a single wrong token. Instead, the loop catches the decode failure and synthesizes a corrective *user* message:

```ts title="packages/core/src/usecases/agentLoop.ts"
let consecutiveMalformed = 0
const MAX_MALFORMED = 3

// in the loop, when the response itself failed to decode:
if (outcome._tag === 'malformed') {
  consecutiveMalformed++
  if (consecutiveMalformed > MAX_MALFORMED) return yield* Effect.fail(outcome.err)
  const corrective: AgentMessage = {
    role: 'user',
    content:
      `Your previous reply could not be parsed: ${desc}\n\n` +
      `This usually means you called a tool that doesn't exist or used the wrong ` +
      `argument shape. The only tools available are: ${toolNames.join(', ')}. ` + // [!code highlight]
      `Reply again using one of those tools, or plain text if you're done.`,
  }
  messages = [...messages, corrective]
  turnIndex++
  continue
}
consecutiveMalformed = 0
```

The load-bearing clause is the roster. A hallucinated tool name isn't random noise — it's a high-prior guess from training, and the only thing that beats a prior is fresh evidence, so the list of *real* names goes directly into the message where it outranks memory. Two more clauses are deliberate. *"or plain text if you're done"* gives a model that was genuinely finishing an exit — a pure "use a tool!" corrective would pressure it into one more pointless call. And the whole path is bounded: three correctives without a successful parse and the loop fails for real. More on that bound in the rules.

### The denial

When [efferent](https://github.com/xandreeddev/efferent) wants to run a shell command in an interactive session, a human approves or denies it (an LLM judge pre-screens the obviously-fine ones — a post of its own). The naive encoding of "deny" is an exception: permission denied, turn over. But the human pressed deny *for a reason*, and the model is about to choose its next action without knowing it. So a denial is a returned failure that carries the human's intent forward:

```ts title="packages/core/src/usecases/codingToolkit.ts"
const decision = yield* approval.request({
  tool: 'Bash',
  summary: command,
  cwd: rootDir,
  ruleKey: bashRuleKey(command),
})
if (decision.kind === 'deny') {
  return yield* Effect.fail({
    error: 'Denied',
    message:
      decision.reason !== null
        ? `the user denied this command: ${decision.reason} — adjust your approach; don't retry it verbatim.` // [!code highlight]
        : `the user denied this command. Don't retry it verbatim — adjust your approach or ask what they'd prefer.`,
  })
}
```

This is the gallery's only string co-authored at runtime by a human. The reason — "don't touch prod", "use bun, not npm" — is the most valuable sentence available to the turn, and this is the only channel that delivers it to the model. The trailing clause, *"adjust your approach; don't retry it verbatim"*, is anti-loop phrasing aimed at the exact behavior models exhibit after a refusal: re-issuing the same command with cosmetic changes. The no-reason variant ends differently — *"or ask what they'd prefer"* — making conversation an explicitly allowed move, so a dead end becomes a fork. And because the denial is data in the transcript, it persists: ten turns later the model still knows that command was refused, and why. A refusal stops being an event and becomes knowledge.

### The budget

[efferent](https://github.com/xandreeddev/efferent)'s sub-agents — child agent loops spawned to work on a folder — all draw from one shared token pool per top-level turn, the *token budget*: depth and step caps bound termination, the pool bounds spend. When it drains, two strings do the strategy work, and they sit side by side in the same file:

```ts title="packages/core/src/usecases/tokenBudget.ts"
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

The first refuses the *next* spawn — and notice it names the replacement strategy, not just the limit. The model's plan was delegation; *"do the remaining work yourself instead of spawning"* converts "your plan is blocked" into "here is your new plan" within one clause. There is also nothing to vary and retry — the budget doesn't depend on the arguments — so the string preempts the retry rather than letting the model discover futility empirically. (Its cousin for the depth cap reads the same way: *"sub-agent nesting limit (2) reached — do this part yourself."*)

The second string handles the harder case: a sub-agent that was already running when the pool hit zero stops at its next turn boundary — and its final text, at that moment, is mid-thought. The danger isn't the missing work; it's that the parent can't tell. A sub-agent's one-line summary is what the `run_agent` tool *returns*, and an unmarked partial summary reads exactly like a deliverable:

```ts title="packages/core/src/usecases/buildScopeRuntime.ts"
// A budget OR step-cap stop is an *ok* outcome with a partial result —
// say so, so the parent model knows not to trust it as complete.
const stopNote = stoppedByBudget
  ? BUDGET_STOP_NOTE
  : result.stoppedAtMaxSteps
    ? STEP_STOP_NOTE
    : null
const summary = stopNote !== null
  ? `${result.finalText}\n\n${stopNote}` // [!code highlight]
  : result.finalText
```

The step-cap sibling says the same thing about a different limit: *"[stopped early: the step limit was reached — this result is partial]"*. Both convert *confidently incomplete* into *explicitly incomplete*, at exactly the place the parent reads — the cheapest possible insurance against the worst sub-agent failure mode, which is a parent building on work that never finished.

### The headroom marker

This one isn't a failure at all, but it's the same genre. Oversized tool outputs are clipped before they enter the message buffer — keep the head and tail, drop the middle — because a 200KB build log would crowd out everything else (the cache-safe compression scheme behind this is a post of its own). The risk in any omission is that the model doesn't know what it isn't seeing — or worse, doesn't notice the hole and confabulates across it. So the marker that replaces the dropped middle ships its own undo instructions:

```ts title="packages/core/src/usecases/headroom.ts"
/** Assemble the clipped text: head + a reversible marker (+ summary) + tail. */
export const renderClip = (plan: ClipPlan, toolName: string, summary: string | null): string => {
  const dropped = `~${estimateTokens(plan.dropped.length)} tokens`
  const digest = summary !== null ? ` Summary of the omitted part: ${summary}` : ''
  return (
    `${plan.head}\n` +
    `[…headroom: ${dropped} of this ${toolName} output omitted.${digest}` +
    ` To retrieve it, re-run the tool narrower — read_file with offset/limit,` + // [!code highlight]
    ` a more specific grep, or bash piped through head/tail.]\n` +
    `${plan.tail}`
  )
}
```

Mid-transcript, rendered, it reads:

```
[…headroom: ~5800 tokens of this Bash output omitted. To retrieve it, re-run
the tool narrower — read_file with offset/limit, a more specific grep, or bash
piped through head/tail.]
```

Three things are deliberate. It sizes the hole — *~5800 tokens* — so the model can judge whether what's missing is likely to matter. It names the source tool. And it lists three retrieval recipes that exactly match the toolkit's real capabilities: `read_file` genuinely takes `offset`/`limit`, `grep` is genuinely in the kit, bash genuinely exists. Instructions in a marker only count if this model can execute them verbatim with these tools. When the dropped middle is big enough, a fast-tier model also folds a digest of it into the marker — so the model knows roughly what's behind the door before paying a tool call to open it. An omission with a recipe is compression; an omission without one is a lie about the world.

### The staleness brief

The last entry is for a failure that hasn't happened yet. [efferent](https://github.com/xandreeddev/efferent) keeps every sub-agent's transcript as a resumable node in a persistent tree (a post of its own), which creates a subtle hazard: a node's context is a cache of a world-model whose backing store — the repo — keeps changing. A node that read files two commits ago and is resumed today will confidently act on its in-context copies, because models trust context over re-reading; to the model, the in-context file *is* the file. So nodes are stamped with the workspace's git HEAD when their run finishes, and resuming against a moved HEAD prepends a brief to the task:

```ts title="packages/core/src/usecases/staleness.ts"
export const stalenessNote = (args: {
  readonly oldRef: string
  readonly newRef: string
  readonly folder: string
  readonly diffStat: string | null
}): string => {
  const head = `[workspace changed since this context last ran: ${short(args.oldRef)}..${short(args.newRef)}]`
  const body =
    args.diffStat !== null
      ? `Changed under ${args.folder} since then:\n${args.diffStat}`
      : `(no changes under ${args.folder} itself, but the repo moved — shared code may differ)`
  return `${head}\n${body}\nFiles you read earlier may be stale — re-read anything you intend to edit before editing it.` // [!code highlight]
}
```

The brief is evidence first, instruction last. The ref range establishes that the world moved; the `git diff --stat`, scoped to the node's own folder and clipped to 25 lines, shows *where* — changes elsewhere don't invalidate this node's context, so they don't dilute its message. And the imperative final line is the part that actually changes behavior: *"Files you read earlier may be stale — re-read anything you intend to edit before editing it."* Nothing failed here. This is the same craft applied *before* the mistake instead of after — it's far cheaper to tell a model its memory is old than to unwind an edit built on a file that no longer says what the model remembers. Everything in the path is best-effort by design: no git repo, no `git` binary, a garbage-collected old ref — all mean "no brief", never a broken resume.

## Five rules the gallery keeps

These strings were written weeks apart for unrelated subsystems, but laid side by side they keep the same five rules.

**Name the cause in the model's terms, not the OS's.** The model's working ontology is tools, schemas, scopes, budgets, turns — not errno. `EACCES` describes a syscall; `OutOfScope` describes the agent's world: *"packages/auth/login.ts is outside this scope (packages/core). Defer it to the parent in your summary."* And the vocabulary is pre-taught — the system prompt and the failure strings are two halves of one contract. The sub-agent prompt says: *"Tool failures are data: state what happened in one line, adjust, continue. An OutOfScope error means you must defer that part to the parent — keep going on what you can do."* The prompt teaches the noun; the failure uses it; the model recognizes instead of interprets.

**Always include the next move.** Every string above carries an imperative after the dash: re-call, adjust, do it yourself, re-run narrower, re-read. The test I apply: delete everything before the dash — if the model could still act correctly on what remains, the message works. This holds down to the micro-failures; `edit_file`'s match error doesn't stop at the diagnosis: *"oldText is ambiguous (matches multiple times); include more surrounding context."*

**Make refusals data, not dead ends.** The denial, the budget, the write sandbox — all are policies the model is *supposed* to hit sometimes. A policy hit that aborts the turn punishes the human for the agent's reach; a policy hit returned as `{ error, message }` keeps the turn alive and makes the boundary part of the model's knowledge. The sandbox refusal even scripts the workaround — defer it to the parent — because hitting the boundary is a normal step in delegated work, not misbehavior.

**Bound the retries.** A corrective is a wager that the model can do better with more information. `MAX_MALFORMED = 3` is the loop admitting the wager can lose: three consecutive correctives without a single parseable response and the turn fails for real, instead of burning tokens politely forever. The counter resets on any successful decode — the bound is on *consecutive* confusion, not total mistakes. Instructive failures without a bound are an invitation to the politest possible infinite loop, billed per lap.

**When work is partial, say so where the parent will read it.** `BUDGET_STOP_NOTE` is appended to the sub-agent's *summary* because the summary is the only artifact the parent model ever sees. A warning emitted to a log no model reads is a warning to nobody; the placement is as much a part of the design as the wording. Write the caveat into the value that gets consumed, or it doesn't exist.

## Turns that self-heal

What all of this buys, in aggregate: the turn stops being fragile to the model's own mistakes. The loop re-invokes the model with the grown transcript until it stops requesting tools (its full anatomy is a post of its own), and every string in the gallery lands in that transcript as either a tool result or a user message — the newest evidence in context at the very next step. So recovery happens *inside* the turn: a schema miss becomes a corrected re-call one step later; a denial becomes an adjusted command seconds after the human's reason arrives; a budget refusal becomes the parent quietly absorbing the remaining work without spawning. There's a protocol dividend too: because the wrapper answers the failed call's id with a result, the assistant tool-call ↔ tool-result pairing stays valid — providers reject transcripts with unanswered tool calls — so recovery preserves not just momentum but the transcript's well-formedness. The naive design dies entirely, turn and all, on the model's smallest formatting slip. This design turns the same slip into a one-step wobble the user mostly never sees.

## What it costs

Three honest costs.

**Instructive failures are prompt tokens.** The message buffer is append-only, so every corrective persists for the rest of the conversation and rides along (cached, but still context) with every subsequent call. The `InvalidToolCall` message can carry up to 800 characters of decode description; a staleness brief can carry 25 lines of diff stat. Each is cheap against the turn it saves — but they compound, and an agent that fails often becomes an agent hauling a transcript full of advice about its past mistakes.

**Strings drift from behavior unless tested.** *"re-run the tool narrower — read_file with offset/limit"* is true exactly as long as `read_file` has `offset` and `limit`. Rename a tool, drop a parameter, and the string lies — and nothing will tell you, because prose doesn't typecheck. Of everything quoted in this post, only the handoff brief's behavior is currently guarded by an eval (a scorer asserts it's a summary, not a chat reply); the rest are tested the way comments are: by hoping. The honest fix is evals that induce each failure and assert on the transcript that follows — cheap to write, just not yet written.

**Too-helpful errors teach leaning on recovery.** If every malformed call earns a patient corrective, sloppy calls are cheap — and not just across training runs; *in context*, a transcript full of graceful recoveries teaches this model, right now, that schema discipline is optional. There's also accommodation creep: [efferent](https://github.com/xandreeddev/efferent)'s `edit_file` eventually stopped correcting one wrong shape and started *accepting* it — models trained on another harness's edit tool kept emitting a flat `oldText`/`newText` instead of the documented `edits` array, so the decoder now takes both. Probably the right call. But every such acceptance deletes the failure signal that told you what models actually get wrong, and you can only read the signals you still emit.

## The user changed

Error messages were always UX writing. We just wrote them badly for decades because the user was a developer with a debugger, source access, and time — a reader who could forgive `EACCES` because the string only had to point somewhere. The user is now a model with no debugger and two seconds, and it forgives nothing — but it *obeys everything*. That's the trade that makes this worth doing well: a human reads your error and sighs; a model reads it and does what it says. Almost nothing else in a codebase has that property. Not the comments, not the docs, not even most of the system prompt, which the model is half-ignoring by turn thirty. A failure string fires at the moment of maximal relevance, about the exact thing that just went wrong, to a reader guaranteed to act on it — the best prompt real estate in the entire system, and most agents spend it on `Error: ENOENT`. So budget your writing time where the leverage is: give the system prompt its afternoon, give the failure strings the week, and when you review transcripts, look for one thing — the places the model stumbled and *guessed*. Every guess marks a string that didn't say the next move. Write it in, and the guess disappears from every future run.
