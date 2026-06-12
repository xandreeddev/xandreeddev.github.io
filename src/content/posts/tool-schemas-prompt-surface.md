---
title: 'The model never reads your handler'
description: 'A tool schema is prompt surface — the descriptions and annotations are the only docs a model reads before it acts.'
pubDate: 2026-06-11
tags: [ai, agents]
---

Somewhere in your agent's transcript there's a turn like this: the model rewrites a whole file with `write_file` when a two-line edit would do, or calls `edit_file` with an argument shape it invented, or resumes a stale sub-agent for a task that deserved a fresh one. The instinct is to blame the model — too small, too eager, badly trained.

But look at what the model actually had to work with. It never saw your handler. It never saw the careful path resolution, the write lock, the truncation logic, the tests. It saw a **name**, a **description**, and a **parameter schema** — a few hundred tokens of JSON — and then it acted, within seconds, without asking a single clarifying question. If it misused the tool, the first suspect isn't the reader. It's the only thing the reader read.

That's the frame this post sells: **a tool's schema is prompt surface.** The description is API documentation; the parameter annotations are the only types the model perceives; the success shape is a promise about what comes back. Every word of it is prompt engineering, whether you wrote it like prompt engineering or not. The receipts come from [efferent](https://github.com/xandreeddev/agent), the coding agent I'm building, whose toolkit has absorbed a few months of models reading its docs badly — and whose schemas got better every time.

## The reader who never asks questions

First, the mechanics, because "tool call" hides a very specific contract. When you hand a model tools, the provider API takes a list of tool definitions alongside the prompt. Each definition is three things:

```
{
  name: 'read_file',
  description: '…when and why to call this…',
  parameters: { /* JSON Schema for the arguments */ }
}
```

The model emits a tool call — a name plus a JSON object of arguments — your code runs something, and the result goes back into the conversation as a message. The handler, the part you spent your effort on, is invisible. From the model's side of the wire, the definition *is* the tool.

Now consider who's reading those definitions. A human reading API docs skims, experiments, reads the error, searches the issue tracker, asks a colleague. The model does none of that. It reads your description once per turn, picks a tool in the same forward pass that writes the arguments, and commits. There is no "wait, is `offset` zero-indexed?" — there is only the call it makes under whatever assumption it landed on. Documentation for a human is a reference they consult when stuck. Documentation for a model is the entire interface, consumed in full, every single time, by a reader that acts immediately and never follows up.

That asymmetry is the whole discipline. Everything below is one rule applied repeatedly: write the schema for a brilliant, hurried reader who will never ask you what you meant.

## One declaration, two artifacts

[efferent](https://github.com/xandreeddev/agent) defines its tools with `@effect/ai`'s `Tool.make`, where the parameters, success shape, and failure shape are all Effect `Schema` values — runtime validators that carry static types. The detail that matters here: a `Schema` can carry **annotations**, free-form metadata attached to a type, and the `description` annotation flows straight through to the JSON Schema the provider receives. Here's the real `read_file`:

```ts title="packages/core/src/usecases/codingToolkit.ts"
export const ReadFile = Tool.make('read_file', {
  description:
    "Read a file's contents with line numbers. Use offset/limit to page through large files.",
  parameters: {
    path: Schema.String.annotations({
      description: 'Path to the file (relative to cwd, or absolute).',
    }),
    offset: Schema.optional(
      Schema.Number.annotations({ description: '1-indexed start line.' }), // [!code highlight]
    ),
    limit: Schema.optional(
      Schema.Number.annotations({ description: 'Max lines to return.' }),
    ),
  },
  success: Schema.Struct({
    path: Schema.String,
    content: Schema.String,
    totalLines: Schema.Number,
    truncated: Schema.Boolean,
  }),
  failure: Failure,
  failureMode: 'return',
})
```

One declaration, two artifacts. Facing inward, the schema is a decoder: arguments are validated against it before any handler runs, and TypeScript knows the handler receives `{ path: string; offset?: number; limit?: number }`. Facing outward, the same declaration serializes into the JSON the provider ships to the model — roughly this, modulo each provider's field names:

```
{
  "name": "read_file",
  "description": "Read a file's contents with line numbers. Use offset/limit to page through large files.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Path to the file (relative to cwd, or absolute)."
      },
      "offset": { "type": "number", "description": "1-indexed start line." },
      "limit":  { "type": "number", "description": "Max lines to return." }
    },
    "required": ["path"]
  }
}
```

Read that JSON the way the model does. It answers, in order: *what does this do and when do I want it* (the description), *what do I pass* (the properties), *what conventions apply* (the annotations). That's the entire knowledge transfer. The highlighted annotation — `1-indexed start line.` — is three words resolving an ambiguity the model would otherwise gamble on, in a domain where half its training data counts from zero. `relative to cwd, or absolute` does the same for paths. These aren't comments. They're the only types the caller can perceive.

## Anatomy of a description that routes

A tool description has two jobs, and most people only write the first: say what the tool does. The second job is **routing** — saying when to use it *and when to use its sibling instead* — because the model's real decision is rarely "can this tool do X" but "which of these twelve tools is right for X." [efferent](https://github.com/xandreeddev/agent)'s file-writing pair makes the routing explicit, in the description itself:

```ts title="packages/core/src/usecases/codingToolkit.ts"
export const WriteFile = Tool.make('write_file', {
  description:
    "Create or fully replace a file. Use 'edit_file' instead for targeted in-place edits to existing files.", // [!code highlight]
  // …
})

export const EditFile = Tool.make('edit_file', {
  description:
    "Apply targeted substring edits to a file. Each edit's oldText must match exactly once in the current file content. For multiple edits pass the `edits` array; for a single edit you may instead pass top-level `oldText`/`newText`.",
  // …
})
```

The highlighted sentence exists because of transcripts where a model nuked a 400-line file to change one import. The fix wasn't a bigger model or a sterner system prompt — it was telling the tool's own docs about the sibling. Selection happens at the moment the model is reading this exact description, so this is the highest-leverage place the redirect can live.

The web pair goes further and documents a *workflow* across two tools — `search_web`'s description ends: "It returns a summary plus its sources; call web_fetch on a source url to read that page in full." One sentence, and the model knows the two tools compose into search-then-read instead of treating them as rivals.

### The success schema anticipates the next turn

Look back at `read_file`'s success shape: `{ path, content, totalLines, truncated }`. The last two fields are not for your code — your handler obviously knows them — they're for the *model's next decision*. A model that reads lines 1–200 of a file immediately wonders: was that everything? `truncated: true, totalLines: 1843` answers the follow-up before it's asked, and the very tool description already told it what to do about it ("Use offset/limit to page through large files"). The question, the answer, and the remedy form a closed loop across the schema.

The pattern repeats everywhere. `edit_file` succeeds with `{ path, editsApplied, diff }` — the diff means the model doesn't burn a turn re-reading the file to confirm what changed. `Bash` succeeds with `{ exitCode, stdout, stderr, durationMs, timedOut }`; `timedOut: true` is the difference between "the tests hang" and "the tests fail," two situations a model should handle completely differently and would otherwise have to infer from absence. A success schema designed this way is the cheapest latency optimization in the loop: every anticipated question is a round trip you don't pay for.

The failure side mirrors it — every tool shares a `{ error, message }` struct with `failureMode: 'return'`, meaning failures come back to the model as data instead of exceptions. What makes a failure *message* teach instead of scold is a post of its own; today's subject is the input side of the contract.

### Annotations as the enforcement's user manual

Sometimes a parameter annotation isn't describing a convention — it's describing a wall. `grep`'s `flags` argument gets spliced into a real shell command, which historically made it a command-injection hole; the fix was an allowlist that only admits bare flags. The annotation documents the wall so the model doesn't have to find it by collision:

```ts title="packages/core/src/usecases/codingToolkit.ts"
flags: Schema.optional(
  Schema.String.annotations({
    description:
      "Extra grep flags, e.g. '-i' (case-insensitive) or '-w' (word match). " +
      '-rnE are always set. ' + // [!code highlight]
      'Only bare flags (letters/hyphens, like -i, -iw, --ignore-case) are ' +
      "accepted — no '=value' forms or shell characters.",
  }),
),
```

Three moves in one annotation: examples of valid input (models pattern-match examples better than grammars), defaults the model shouldn't re-supply (`-rnE are always set` stops it wastefully passing `-r`), and the boundary stated as a rule. When the handler does reject a flag, the failure message restates the same rule — but the annotation means most models never hit the rejection at all. Docs first, enforcement second, the same text in both.

## Names are load-bearing

A tool's name looks like the one part of the schema with no semantics. It has two. The first is habit: a model has seen millions of transcripts of *some* tool names, and a name it recognizes comes with free training — [efferent](https://github.com/xandreeddev/agent) names its search tools `grep`, `glob`, and `ls` precisely because the model already knows what those words mean down to the flag conventions. The second is collision, and it's nastier, because the collision space isn't your codebase — it's the provider's. This comment sits on the shell tool, and I'd frame it if I could:

```ts title="packages/core/src/usecases/codingToolkit.ts"
// NB: named "Bash" — the capital B is LOAD-BEARING, don't lowercase it.
// Anthropic reserves the lowercase names "bash"/"web_search"/"computer"/
// "code_execution"/"str_replace_*" for its built-in provider tools, and
// `@effect/ai-anthropic` rewrites those exact response tool names to its
// provider-defined tools (`AnthropicBash`, …) — which aren't in our toolkit,
// so the turn fails. The lookup is a case-sensitive `Map.get`, so "Bash" (the
// name Claude Code itself uses) sidesteps it while staying the well-trained
// name the model expects.
export const Bash = Tool.make('Bash', { // [!code highlight]
  description:
    'Execute a shell command in the workspace. Use for git, build, test, install, ' +
    'and other operations not covered by the other tools.',
  // …
})
```

Unpack what's stacked in there: the provider reserves a set of lowercase names for its own built-in tools; the client library rewrites responses that use those exact names; a custom tool that happens to be called `bash` therefore gets its calls routed to a tool that isn't in your toolkit, and the turn dies. The escape hatch is a capital letter — which happens to also be the spelling Claude Code uses, so the model's habits transfer intact. The web search tool plays the same dodge from the other side: it's named `search_web`, not `web_search`, because `web_search` is on the reserved list too.

None of this is visible in any type signature. It's pure namespace politics between your schema, the model's training, and the provider's built-ins — and the only place it can be recorded is a comment and a naming convention. When you name a tool, you're picking a word in a language you don't control.

## Descriptions as policy

Everything so far treats the description as documentation. The most interesting tool in [efferent](https://github.com/xandreeddev/agent) treats it as something stronger: **policy**. `run_agent` spawns a folder-scoped sub-agent with its own persisted context, and can also resume or branch a previous one — which means every call embeds a judgment call about context hygiene that models reliably get wrong on their own. The description is where that judgment got encoded:

```ts title="packages/core/src/usecases/buildScopeRuntime.ts"
const RunAgentTool = Tool.make('run_agent', {
  description:
    'Spawn a sub-agent to do focused work scoped to a folder. It reads anywhere but ' +
    'writes/runs bash only inside that folder, runs in its own persisted context, and ' +
    'returns { summary, filesChanged, nodeId }. Prefer it when a change is localized to one ' +
    "area; it keeps your own context focused. Be explicit in 'task' — the sub-agent starts " +
    'fresh unless you resume/branch a node. DEFAULT TO A FRESH SPAWN: one agent = one piece ' + // [!code highlight]
    'of work; a new task gets a new agent even in the same folder (fresh context is cheaper ' +
    'and more focused — a resume re-feeds the node\'s entire history every turn). Reuse a node ' +
    "only when the new task is a direct follow-up on that node's OWN work: seedMode 'resume' " +
    "to continue/fix/extend what it just did (its accumulated file knowledge pays for itself), " +
    "'branch' to retry or take an alternative direction from its context without growing it.",
  // … parameters: name, folder, task, seedFromNode, seedMode
})
```

This is a policy document wearing a description's clothes, and every sentence is a scar. Walk it:

**"Spawn a sub-agent to do focused work scoped to a folder."** — what it does, first, in one sentence, because selection happens on the opening words and everything after is for the model that's already interested.

**"…returns { summary, filesChanged, nodeId }."** — the return shape, *in the description*, even though the success schema already declares it. Redundant to a type checker; not redundant to a planner. A model deciding whether to delegate needs to know what it gets back *before* it calls, because "will I be able to verify this work?" is part of the decision.

**"Be explicit in 'task' — the sub-agent starts fresh unless you resume/branch a node."** — preempting the single most common delegation failure: a parent writing `task: 'fix the bug we discussed'` to a child that has no idea what was discussed. The mental model ("starts fresh") is the cure, so the description teaches the mental model, not just the rule.

**"DEFAULT TO A FRESH SPAWN: one agent = one piece of work…"** — the only caps in the toolkit, spent on the highest-cost mistake. Early transcripts showed models hoarding context: reusing yesterday's node because the folder matched, piling unrelated tasks into one ever-growing history. The fix states the default, then — crucially — the *reason* in parentheses: "a resume re-feeds the node's entire history every turn." Models follow a rule with a stated mechanism far better than a bare imperative, because the mechanism lets them generalize to cases the rule didn't enumerate.

**"Reuse a node only when the new task is a direct follow-up on that node's OWN work…"** — the exception path, with a cost model attached to each mode: resume "pays for itself" only via accumulated file knowledge; branch explores "without growing" the original. The parameter annotations then repeat the policy at the point of use — `seedFromNode`'s annotation says "ONLY when the task is a direct follow-up on that node's own work," and `seedMode`'s opens with "'handoff' (PREFER for follow-ups)." Policy at selection time, policy again at argument time. (The machinery underneath — context-tree nodes, staleness briefs, what resume/branch/handoff actually persist — is a post of its own.)

Here's why I find this genuinely exciting: a tool description is **the cheapest deployable unit of operational learning you have.** Watch a transcript, see a recurring misuse, edit a string, and every future call across every model benefits — no fine-tune, no code change, no new abstraction. The smaller `update_plan` tool shows the same accretion: "Every call REPLACES the whole plan, so always send the complete list," "statuses honest (mark 'done' only when actually done), and exactly one step 'active' while you work." Each clause is a transcript where a model did the opposite. The description is where lessons go to compound.

## The schema is also the bouncer

There's a structural fact about `@effect/ai` that turns all this from style advice into a hard interface: **parameters decode before the handler runs.** The doc comment in the agent loop states it precisely:

```ts title="packages/core/src/usecases/agentLoop.ts"
/**
 * `@effect/ai` decodes a *known* tool call's parameters inside `Toolkit.handle`,
 * before our handler runs — so a wrong-shaped call (right name, bad args) fails // [!code highlight]
 * with `AiError.MalformedOutput`, which `failureMode: "return"` never sees (it
 * only catches *handler* failures), aborting the whole turn.
 */
```

A call with the right name but the wrong shape never reaches your code. No defensive `typeof` checks at the top of the handler, no half-validated arguments wandering into the filesystem layer — the schema you published is the schema that's enforced, mechanically, at the door. ([efferent](https://github.com/xandreeddev/agent) wraps the handler so the decode error comes back to the model as a structured failure it can correct, rather than a dead turn — but that recovery loop is a post of its own.)

Sit with the implication, because it cuts both ways. Enforcement means your docs can't lie in the permissive direction — the model can't pass a string where you declared a number and have it "mostly work." But it also means your schema rejects everything you didn't think of, at the door, including calls that were *morally correct*. Which brings us to the most instructive function in the toolkit.

## Meeting the model where it is

Models arrive pre-trained on other people's harnesses. A model that has spent its training life calling Claude Code's `Edit` tool — which takes a flat `old_string`/`new_string` pair — will, with measurable frequency, emit that flat shape at *your* edit tool, whatever your schema says. [efferent](https://github.com/xandreeddev/agent)'s `edit_file` canonically takes an `edits` array. The comment on the normalizer tells the story:

```ts title="packages/core/src/usecases/codingToolkit.ts"
/**
 * Accept either the canonical `edits: [{ oldText, newText }]` array or the
 * flat single-edit convenience form (top-level `oldText`/`newText`). Models
 * trained on Claude Code's `Edit` tool routinely drop the array wrapper for a
 * single edit and emit the flat shape — which used to fail *parameter decode*
 * (before our handler runs, so `failureMode: "return"` couldn't catch it) and
 * abort the whole turn. Normalising both shapes here lets the decode succeed;
 * an empty result is returned by the handler as a graceful tool failure.
 */
export const normalizeEdits = (args) => {
  if (args.edits !== undefined && args.edits.length > 0) {
    return args.edits.map((e) => ({ oldText: e.oldText, newText: e.newText }))
  }
  if (args.oldText !== undefined) { // [!code highlight]
    return [{ oldText: args.oldText, newText: args.newText ?? '' }]
  }
  return []
}
```

Trace the failure chain that motivated it: the model emits the flat shape → the shape isn't in the schema → decode fails *before the handler* → the bouncer from the previous section ejects a well-intentioned call → the turn aborts. The model wasn't wrong about what to do; it was wrong about your dialect. Punishing dialect with a dead turn is bad economics.

So the accommodation happened *at the schema level*: `edit_file` grew optional top-level `oldText`/`newText` parameters, each annotated as the single-edit form ("Pair with newText; ignored when `edits` is provided"), and the tool description advertises both shapes. The trained habit is now a documented, validated part of the interface — decode succeeds, the normalizer canonicalizes, the handler sees one shape.

When do you accommodate a habit, and when do you correct it? The toolkit embodies a clean rule. **Accommodate when the habit is widespread, unambiguous, and harmless** — the flat edit shape means exactly one thing; accepting it costs two optional parameters. The `Bash` capitalization is the same move in the name dimension: keep the spelling the model already trusts. **Correct when the habit is ambiguous or dangerous** — the grep `flags` allowlist refuses shell metacharacters no matter how confidently a model emits them, because `-i` and `; rm -rf` differ in blast radius, not just in shape. And `run_agent`'s description *corrects* the context-hoarding habit rather than accommodating it, because accommodation there compounds into degraded runs. The boundary isn't aesthetic preference. It's whether forgiving the input changes what the system does.

## The annotation budget

All this generosity has a meter running. Tool definitions ship with **every request** — the toolkit's serialized JSON rides alongside the system prompt on every single turn, of every conversation, whether or not any tool gets called. Twelve tools' worth of descriptions, annotations, and schema structure is a standing tax measured in thousands of tokens. (Prompt caching makes the re-reads cheap on providers that support it — [efferent](https://github.com/xandreeddev/agent) pins tools and system prompt into the cached prefix, a post of its own — but cached tokens still occupy context, and context is the scarcer currency.)

So the toolkit spends like someone who knows it's a budget. The spread is deliberate:

- **Terse where training carries the load.** `ls` gets eleven words: "List a directory's entries. Use recursive: true to descend." Every model on earth knows `ls`. Annotating it heavily would buy nothing.
- **Medium where there's one convention to pin.** `read_file` is two sentences plus three short annotations — the 1-indexing and path conventions are the only ambiguities worth money.
- **Verbose where a wrong call is expensive and the decision is genuinely hard.** `run_agent`'s description runs ~150 words — by far the longest — because each call spins up an entire sub-agent loop with its own model spend, and the fresh-vs-resume decision has no training-data default to lean on. A wasted spawn costs five orders of magnitude more than its description does.

The budget heuristic that falls out: **description length should be proportional to the cost of misuse times the ambiguity of the choice,** not to how proud you are of the feature. And some guidance doesn't belong in the schema at all — [efferent](https://github.com/xandreeddev/agent)'s system prompt carries the cross-tool workflow ("Prefer 'grep' for searching content and 'glob' for finding files by name. Reach for 'Bash' only when the other tools can't do the job"), because routing *between* tools is global behavior, while each description owns the contract of one call. Two surfaces, two altitudes, one budget.

## What this costs

Schema-as-prompt-surface has failure modes of its own, and they're worth naming straight.

**Descriptions drift, and nothing breaks when they do.** The compiler checks that your handler matches your parameter types; nothing checks that your handler matches your *prose*. Change the truncation cap, forget the description's "Defaults to 50000," and you now ship confidently wrong documentation to a reader that believes every word. The schema and the handler are one declaration but two contracts, and only one of them is type-checked. The honest mitigation is regression-testing tool *selection* the way you test outputs — eval territory, and a post of its own.

**Provider dialects eat your schema's edges.** A toolkit that serves multiple providers serializes through multiple JSON Schema dialects, and not everything survives the trip. The toolkit's header comment records one such scar: every tool ships explicit success/failure Structs because "Gemini's functionResponse must be an object" — a bare string result that Anthropic happily accepts is a protocol error there. The defensive posture is writing schemas in the conservative intersection: object roots, plain types, descriptions doing the work that exotic schema keywords (patterns, unions, conditionals) would do less portably. The expressive ceiling of your schema is set by your *worst* target dialect.

**Over-specification rejects legitimate calls.** The grep flags allowlist that closes the injection hole also rejects `--include=*.ts` — a completely reasonable thing for a model to want — because `=value` forms can't be distinguished from injection cheaply. Every constraint you add to a parameter is a bet that you've enumerated the legitimate uses. You haven't. The best you can do is make the rejection teach (the annotation and the failure message both say exactly what's allowed) and keep an escape hatch (`Bash` exists, behind approval).

**Tuning is model-family-relative.** "Bash" with a capital B is the right name *because* the strongest current models trained on a harness that spells it that way. `normalizeEdits` accommodates Claude Code's edit shape specifically. A description calibrated against one family's instincts can mistune for another — and [efferent](https://github.com/xandreeddev/agent) routes across providers at runtime, so the same toolkit text serves models with different habits on different turns. There's no stable optimum here, only a moving average you re-check when the router's mix changes. Schema text that encodes today's models' habits is a depreciating asset; the comments saying *why* each word is there are what keep it maintainable.

## Read your own wire format

Here's the practice I'd actually push on you. Serialize your toolkit — the literal JSON your provider ships — and read it cold, the way you'd review a public API reference written by someone else. No peeking at handlers. For each tool ask: would I know when to pick this over its neighbor? Would I know the units, the index base, the path convention? Would I know what comes back, and what to do when it's truncated, timed out, denied? Every "well, it's obvious from the code" is a bug, because your one user — the most attentive reader your documentation will ever have, and the least able to ask — does not have the code.

When the agent misbehaves, diff the docs before you blame the reader. The fix for a model that rewrites whole files was one sentence pointing at a sibling. The fix for dead turns on flat edit shapes was two optional parameters. The fix for context hoarding was a policy paragraph with the reasons left in. The best prompt engineering I've shipped this year wasn't in a system prompt — it was a sentence in a tool description with the caps lock on.
