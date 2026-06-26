---
title: 'Your app calls a model in more places than you think'
description: 'Every LLM call site in a real agent, enumerated: which tier serves it, how it fails, and where its tokens land.'
pubDate: 2026-06-19
tags: [ai, agents, effect]
series:
  name: 'Building a coding agent'
  order: 2
draft: true
---

Here's a question to ask about any LLM application that's been alive for more than a quarter: **how many places in the codebase can turn into a model request at runtime?**

Not which models, not how the prompts work — just the count. How many distinct call sites are there, which model serves each one, what happens when one of them errors, and what share of the bill is each one running up?

Most teams can't answer it, and the reason isn't sloppiness. The number starts at one — the chat endpoint, the agent loop, the feature the app exists for — and then grows the way dependencies grow: quietly, one good reason at a time. A summarizer so long outputs fit. A classifier to route requests. A title generator because untitled sessions look terrible in a sidebar. Each is a small, sensible diff that sailed through review. Two quarters later the application calls a model from nine places, four of them hardcode a model id somebody chose in March, and nobody can say what happens when the cheap one starts returning 429s.

We already solved this shape of problem once. Library dependencies used to accrete exactly this way — an unenumerable `node_modules` jungle — until lockfiles and audit tooling made the inventory explicit and checkable. **Model call sites deserve the same treatment: enumerated, tiered, budgeted, and documented.** I'll call the resulting artifact a *model-usage map*, and this post argues you should keep one by walking through a complete, real census: every LLM call site in [efferent](https://github.com/xandreeddev/efferent), the coding agent I'm building — which actually ships its map as a file in the repo.

## How the census gets away from you

The main loop never gets lost. It's the product; everyone knows where it lives. The sneaky spend is everything *around* it — what I think of as **helper calls**: one-shot completions that smooth an edge of the product without being the product. They tend to look like this, scattered across a codebase:

```ts
// notifications/digest.ts — added in March
const digest = await llm.complete({ model: 'small-model-2', prompt: digestPrompt })

// triage/route.ts — added in May, different author, different small model
const label = await llm.complete({ model: 'mini-8b', prompt: routePrompt })

// sessions/title.ts — added in August, with a retry wrapper, after an incident
const title = await retry(() => llm.complete({ model: 'small-model-2', prompt: titlePrompt }))
```

Every line is individually defensible. Collectively they're an unaudited surface, and it leaks in three currencies at once:

- **Cost.** Helper calls are cheap per call and that's exactly why nobody meters them. A summarizer that fires on every oversized tool result can quietly run thousands of times a day. If your accounting only tracks the main loop, your bill and your dashboard will disagree, and the gap is the helpers.
- **Latency.** Some helpers run off the critical path (a title can arrive whenever); some run *inside* it (a classifier gating an action blocks the action). Without an inventory, nobody decided which is which — it just fell out of where the `await` landed.
- **Failure.** This is the one that pages you. **Every call site is a place a 429 can land** — or a timeout, an expired key, a model that started returning prose where you parse JSON. If a decorative title generator can take a user's turn down with it, you didn't add a feature in August; you added a dependency on a third-party service to your critical path without writing that down anywhere.

The third currency is the tell. Ask "what happens when this call fails?" for each helper and you'll usually get silence — not because the answer is bad, but because the question was never asked. The call site was added to make something nicer, and nobody priced in that it can also make something broken.

## One rule and a map

[efferent](https://github.com/xandreeddev/efferent) is a long-running agent, which means it grows helper calls faster than most apps — anything that touches context, approvals, or session chrome is a candidate. The defense is one routing rule, stated in the repo's own words:

> All *agentic* work — anything that drives the tool loop — runs through the router `LanguageModel`, on the **general** tier by default or the **code** tier for sub-agents that write code. Everything else is a **one-shot helper call** and goes through `UtilityLlm.complete(prompt, { role: 'fast' })`. Web search is the deliberate exception (a provider-server-side tool, not a chat completion). No other module may call a provider SDK.

Two doorways and one named exception. Because every call funnels through them, the census is short enough to fit in a table — and here is the complete in-app inventory, every row verified against the code:

| call site | trigger | tier | on failure | spend lands in |
| --- | --- | --- | --- | --- |
| agent loop (root + every sub-agent) | every turn | **general** / **code** | the turn fails — the one site allowed to | context gauge + `byRole.general` / `byRole.code` |
| approval judge | a command with no matching approval rule | **fast** | degrade: show the human the modal | `byRole.fast` |
| compaction digests | oversized tool result with a big dropped middle | **fast** | degrade: plain clip marker | `byRole.fast` |
| handoff brief | `:handoff`, auto-fold, or a handoff-seeded spawn | **general** | error block on the rail; unfolded context stays | uncounted — known gap |
| session title | a session's first exchange | **fast** | nothing — the session stays untitled | `byRole.fast` |
| web search | the `search_web` tool | its own search model | a tool error the model reads | uncounted — known gap |

(There's a seventh category — eval scoring and eval tasks run LLM calls too — but those run under a separate eval environment and their spend lands in the eval report, out of the app by design.)

Notice what the columns are. Not just *where* and *which model* — also *what happens on failure* and *where the tokens land*. Those two columns are the whole thesis of this post, and the rest of it walks the rows to earn them.

### The loop is the easy part

One `LanguageModel.generateText` per turn in `agentLoop.ts`, resolved through a router that re-reads the live model selection on every call. Sub-agents — spawned scopes working in parallel folders — run *the same loop*, on the **general** tier by default; the repo's phrasing is that **delegation changes the context, not the brain**. The one refinement: a sub-agent that *writes* code can be pinned to the **code** tier, so the brain is *specialized* — a coding-tuned model behind the edits — never *discounted*. Running real edits on a cheaper model would be a quality decision smuggled in as a cost optimization; the `code` tier exists precisely so that decision is explicit and configurable instead of implicit. The loop's internals are a post of its own; for the census all that matters is: one call site, the agentic tiers, and it's the only row whose failure is allowed to fail the turn — it *is* the turn.

### Call site: the approval judge

When the agent wants to run a bash command that no existing approval rule covers, a classifier gets one question — does this command stay inside the folders the human already granted, doing ordinary development work? — and returns `allow` (skip the dialog) or `prompt` (show it). The judge's reasoning and the path-based grant model are a post of their own; what matters here is its shape *as a call site*:

```ts title="packages/sdk-core/src/usecases/autoApproval.ts"
export const judgeApproval = (
  req: ApprovalRequest,
  permittedFolders: ReadonlyArray<string>,
): Effect.Effect<JudgeOutcome, never, UtilityLlm> => // E = never: total by construction
  Effect.gen(function* () {
    const utility = yield* UtilityLlm
    const res = yield* utility.complete(buildJudgePrompt({ /* … */ }), { role: 'fast' })
    const verdict = parseJudgeVerdict(res.text)
    return { ...verdict, ...(res.usage !== undefined ? { usage: res.usage } : {}) }
  }).pipe(Effect.catchAll(() => Effect.succeed({ verdict: 'prompt' } as JudgeOutcome))) // [!code highlight]
```

Trigger: an unmatched command, mid-turn, with a human waiting — so it runs on the **fast** tier, because a round-trip on the main model would drag every approval. Failure policy: the highlighted line converts *every* error — missing key, rate limit, malformed JSON — into the verdict `prompt`, which is exactly the behavior the app had before the judge existed. The judge can remove dialogs, never add risk; an outage downgrades a convenience instead of breaking a turn. And spend: the verdict carries its `usage` up, and the caller books it under `fast` in the session ledger.

### Call site: compaction digests

[efferent](https://github.com/xandreeddev/efferent) compresses oversized tool results the moment they enter the message buffer — a 200k-character build log gets clipped to head + tail with a marker explaining how to retrieve the rest. (The mechanics of doing that without poisoning the provider's prompt cache are a post of their own.) The helper call: when the dropped middle is big enough to matter — at least 4,000 characters — a fast-tier model writes a ≤120-word digest of what was cut, woven into the marker so the main model knows what it isn't seeing:

```ts title="packages/sdk-core/src/usecases/compaction.ts"
const utility = yield* Effect.serviceOption(UtilityLlm) // optional dependency: absence is a policy, not an error // [!code highlight]

const summarize = (dropped: string): Effect.Effect<string | undefined> =>
  Option.isNone(utility) || dropped.length < SUMMARY_MIN_DROPPED_CHARS
    ? Effect.succeed(undefined)
    : utility.value
        .complete(`${SUMMARIZE_PROMPT}\n\n<omitted>\n${dropped.slice(0, SUMMARY_INPUT_MAX_CHARS)}\n</omitted>`, { role: 'fast' })
        .pipe(
          Effect.map((res) => res.text),
          Effect.catchAll(() => Effect.succeed(undefined)),
        )
```

Trigger: per loop step, only on oversized results. Tier: **fast**, declared at the call. Failure policy: the digest is best-effort twice over — the highlighted `serviceOption` means the whole feature degrades to a plain clip marker when no `UtilityLlm` is wired at all (the loop runs fine without it), and the `catchAll` means a provider error degrades the same way. A summary is an enhancement to a marker that was already correct. Spend: the loop sums digest usage per step and reports it through a hook, so it lands in the same `fast` bucket as the judge — even when the digest ran inside a sub-agent, whose loop forwards it to the parent's ledger.

### Call site: the handoff brief

When the context window fills past a threshold (or the user types `:handoff`), the conversation gets folded: an LLM summarizes the loaded view into a brief, a checkpoint is written, and future turns load only the brief plus what came after. Here's the row that proves tiering is a real decision and not a reflex: the summarizer runs on **general** — `generateHandoffBrief` calls `LanguageModel.generateText` directly, the only helper that does. Deliberately so: the brief *is* the continuity. Every fact it drops is gone from the agent's working memory, so this is the last place to save a fraction of a cent. A tier is a judgment about how much a call's quality matters, and this call's answer is "maximally."

Failure policy: a failed fold surfaces as an error block in the UI and the unfolded context stays loaded — annoying, never fatal. Spend: **uncounted**, and the map says so out loud. More on that below.

### Call site: session titles

After a session's first exchange, a model names it for the session list. Trigger: once per session, entirely off the critical path. Tier: **fast** — though this is the least latency-sensitive thing `fast` does: nothing is waiting, nobody notices a slow title, and the prompt is two clipped messages. (Titles once had a `cheap` tier of their own; folding it into `fast` left one helper tier instead of two — a simplification the census made easy to make safely.) Failure policy is the most honest in the codebase: *nothing*. The whole thing runs as a daemon fiber after the turn already finished, wrapped in `Effect.ignore` — a missing credential or a provider hiccup means the session stays untitled, which is precisely what it was before the feature shipped. Spend: the title's reported usage is booked under `fast` before the result is even used.

### Call site: web search — the exception that proves the rule

The `search_web` tool is the one call site that bypasses both doorways, and the map explains why instead of hiding it. Grounded search — where the *provider* runs the web search server-side and the model answers from the results — isn't a chat completion you can route like the others: the request must carry only the provider's search tool, and only some providers offer one. So the adapter builds its own client per call, against its own configured selection — a `searchModel` setting, an environment override, or whichever logged-in provider supports grounding:

```ts title="packages/sdk-adapters/src/llm/webSearch.ts"
// NOT the chat router: a dedicated, grounding-only generateText whose
// request carries only the provider's server-side search tool.
const res = yield* svc.generateText({
  prompt,
  toolkit: Toolkit.make(GoogleTool.GoogleSearch({})), // [!code highlight]
})
return { answer: res.text, sources: extractSources(res.content) }
```

Trigger: the model decides to search. Tier: its own — a sixth model selection, independent of the chat model, which is exactly the kind of fact that lives nowhere except in an inventory. Failure policy: a `WebSearchError` becomes a returned tool failure the model reads and works around, like any other tool error. Spend: uncounted — the second admitted gap.

An exception you can point to, with a reason attached, is fine. The unacceptable thing is an exception nobody knows exists.

## Tiers are a vocabulary, not a parameter

Look back at the generic sketch from the accretion section. Its real disease isn't the helpers — it's that each one names a concrete model id at the call site. `'small-model-2'` appears twice; are those the same decision or two coincidences? When a better small model ships, the migration is a grep, and greps miss.

The fix is a layer of indirection with names: **roles**. [efferent](https://github.com/xandreeddev/efferent) has three — `general`, `code`, `fast` — and they're defined by *job description*, not by model:

- **general** — the default brain: every turn of the agent loop, root and reasoning sub-agents alike, plus the one helper where quality is the whole point (the handoff brief).
- **code** — the same agentic loop, narrowed to sub-agents that *write* code, so a coding-tuned model can sit behind the edits while reasoning stays on `general`. Specialized, not discounted.
- **fast** — the helper tier: latency-sensitive calls inside a running turn (the approval judge, the compaction digests) and the off-path background ones (session titles). Quick jobs where a round-trip on the agentic model would drag the run or just burn frontier price.

Call sites declare a role; one pure function, in one file, resolves roles to models:

```ts title="packages/sdk-core/src/entities/Model.ts"
export type ModelRole = 'general' | 'code' | 'fast'

/** The single place the fallback chain lives — router, utility tier,
 *  and settings UI all call this instead of re-deriving it. */
export const modelForRole = (settings: RoleModelSettings, role: ModelRole): string => {
  switch (role) {
    case 'general':
      return settings.model
    case 'code':
      return settings.codeModel ?? settings.model // [!code highlight]
    case 'fast':
      return settings.fastModel ?? settings.model
  }
}
```

The fallback chain is half the design: an unconfigured role resolves to the current general selection, so every helper and every code spawn works with zero configuration — you opt *into* a specialized model per role, with one setting, when you're ready to make that bet. Changing the code model is `:set codeModel …`, not a code change, not a grep, not a deploy.

The helper doorway itself is one deliberately tiny port — a prompt in, a completion out, the role as the only knob:

```ts title="packages/sdk-core/src/ports/UtilityLlm.ts"
export interface UtilityOptions {
  /** `fast` — every one-shot helper call: tool-output summaries,
   *  approval judgments, session titles. Unset → the general model. */
  readonly role?: 'fast' // [!code highlight]
}

export class UtilityLlm extends Context.Tag('@efferent/core/UtilityLlm')<
  UtilityLlm,
  {
    readonly complete: (
      prompt: string,
      options?: UtilityOptions,
    ) => Effect.Effect<UtilityCompletion, UtilityLlmError>
  }
>() {}
```

Note what the port *doesn't* offer: no tools, no streaming, no message history. A helper call that needs those isn't a helper call — it's agentic work trying to sneak out of the general/code tiers, and the interface refuses to carry it. The return type matters too: `UtilityCompletion` is `{ text, usage? }` — usage comes back with every completion *so that each tier's spend is countable*. The live implementation resolves the role's selection per call, pulls the key from the auth store per call, and builds a provider client scoped to exactly that one request — so a mid-session `:set fastModel` or fresh login applies on the next helper call with no rebuild. (How a selection becomes a provider client is the routing story, a post of its own.)

The deeper benefit of role names isn't even the swappability — it's that they force the classification conversation. The repo's history has a commit retagging which jobs count as `fast` exactly because the roles made someone argue about it. "Which role does this new call get?" is a question a reviewer can ask in five seconds. "Which of our four hardcoded model ids should this new file copy?" is not.

## Failure policy is a design column

Run down the failure column of the census again, because it's the part I'd defend in a fight:

- the **judge** degrades to showing the human the dialog,
- the **digest** degrades to a plain clip marker,
- the **title** degrades to nothing at all,
- the **handoff** degrades to an error message and an unfolded context,
- **web search** degrades to a tool error the model routes around.

Five helpers, five degrade paths, and every one lands on the same principle: **a helper call must never take the main loop down with it.** Each path falls back to the behavior the app had before the helper existed — which is always a behavior that worked, because the app shipped with it.

The judge's version of this is compiler-checked: its error channel is `never`, meaning Effect's type system can prove every failure has been converted into the `prompt` verdict. Add an unhandled failure path in a refactor and the signature breaks at build time. The title's version is the other extreme — fired as a daemon after the turn already completed, with all outcomes ignored:

```ts title="packages/code/src/cli/actions/submit.ts"
// The session's first exchange just landed: name it on the fast tier,
// off the critical path. A missing credential must never surface here.
if (firstExchange) {
  yield* Effect.forkDaemon(
    Effect.gen(function* () {
      const history = yield* cs.list(cid)
      const res = yield* generateSessionTitle(history)
      if (res.usage !== undefined) countFastSpend(res.usage)
      if (res.title.length === 0) return
      yield* cs.setTitle(cid, res.title)
    }).pipe(Effect.ignore), // [!code highlight]
  )
}
```

`Effect.ignore` is usually a smell. Here it's the documented policy: there is no version of a failed title that the user should ever hear about. The point isn't the mechanism — it's that *someone decided*, per call site, what failure means, and the decision is legible in the code. When the failure column is blank, the policy still exists; it's just whatever the exception happens to do, discovered during an incident instead of a review.

## Where the tokens land

A census of call sites implies a census of spend, and the role vocabulary is what makes one possible. [efferent](https://github.com/xandreeddev/efferent)'s session ledger is keyed by role, not by model:

```ts title="packages/code/src/cli/presentation/sidePane.ts"
export interface SessionStats {
  // …
  /** Billed tokens per model role (general / code / fast). */
  readonly byRole: RoleSpend // [!code highlight]
}

/** Add billed tokens to one role's running spend. */
export const accumulateRoleSpend = (
  s: SessionStats,
  role: keyof RoleSpend,
  billed: number,
): SessionStats => ({
  ...s,
  byRole: { ...s.byRole, [role]: s.byRole[role] + billed },
})
```

Every row of the census names its route into this ledger: root-loop and reasoning sub-agent usage accumulate under `general`, code-writing spawns under `code`; the judge and the title daemon book their own usage directly; the compaction digests report through a loop hook that sub-agents forward to their parent, so a digest three spawns deep still lands in the session's `fast` bucket. The UI renders the sum as a `Σ general/code/fast` line — keyed by role, because "the helpers cost a third of the bill" is an actionable sentence and a flat token total is not. (What the UI does with all this is a post of its own; the census only cares that every call site has a destination.)

And two call sites *don't* have one. The handoff brief and web search bill real tokens that no ledger sees, and the map's accounting section names both, explains exactly what each fix needs — `WebSearch` returning usage alongside its answer, `generateHandoffBrief` reporting usage to its caller — and calls them the next slice. I'd argue the documented gap is the most load-bearing part of the whole document. An inventory that quietly omits two rows is worse than no inventory, because it teaches people to trust a wrong number. An inventory that says "these two are missing, here's why, here's the fix" is a to-do list with an audit trail.

## Ship the map

Everything above exists in [efferent](https://github.com/xandreeddev/efferent) as a checked-in document: `docs/models.md`, titled "Model usage map." It opens with the one rule, tabulates all nine call sites (the six in-app rows plus the eval ones), explains how a selection becomes a client, lists the non-inference provider traffic that bills no tokens (model catalogue fetches, OAuth refresh — completeness means listing what *doesn't* count too), and ends with the accounting summary and its admitted gaps.

The claim I want to leave you with: **every LLM application should ship this document.** Not a wiki page — a file in the repo, next to the code it indexes, versioned with it. It's the same genre as a threat model or a dependency policy: a structured answer to a question that will otherwise be answered ad hoc, during an incident, by whoever is on call. If yours has one row, write the one-row version; the value is the discipline of having a place where the next row must be written down.

The columns that earn their keep:

- **Call site** — file and function, precise enough to click through.
- **Trigger** — what causes the call, and roughly how often.
- **Tier/selection** — the *role*, plus how it resolves to a model.
- **Failure policy** — what the user experiences when this call errors. If you can't fill this cell, you've found a bug that hasn't happened yet.
- **Spend destination** — which ledger the tokens land in. "Nowhere" is a legal value only if it's written down.

One process rule makes the document live instead of decorative: a diff that adds or moves a model call must touch the map in the same PR — exactly like a diff that adds a dependency must touch the lockfile. The one rule gives reviewers a cheap tell: in this codebase, any new import of a provider SDK outside the two doorways and the named exception is a map violation *by definition*, greppable in CI.

## What this costs

Honesty section. Three real prices.

**Tiering is indirection.** A reader of `judgeApproval` sees `role: 'fast'` and must hop to settings to learn which model that is today — one more level than a literal model id, and on day one, with a single call site, it's pure ceremony. The investment pays at call site three or four; if your app will only ever have one, you don't need roles, just the document.

**Cheap models doing judgment is a quality bet, and you must eval it.** Moving the judge to the fast tier asserts that a small model can classify command safety reliably. That's testable, and it had better be tested — [efferent](https://github.com/xandreeddev/efferent) runs eval suites for exactly such behaviors, and the judge is additionally designed so its worst failure is a spurious dialog rather than a wrong approval. The design lesson generalizes: helpers whose *errors are cheap* (an unnecessary prompt, a missing digest) are good tier-down candidates; helpers whose errors compound silently — like the handoff brief, where a dropped fact is unrecoverable — are not, which is why that row stays on general. If you tier down a call site without an eval and without bounding its failure, you've replaced an unaudited cost with an unaudited quality regression, which is strictly worse because nobody's dashboard shows it.

**The map goes stale.** It's prose; the compiler won't defend it. Without the review rule it drifts within a month, and a stale inventory is actively misleading. The mitigations are structural — few doorways so there's little to forget, a greppable invariant for CI, the same-PR rule — but the honest answer is that the map is a discipline, not a mechanism, and disciplines need someone who cares.

## The census question

There's a version of this post that's just the question from the first paragraph, asked annoyingly often. How many places can your application call a model? Which tier serves each one? What does the user see when each one fails? Where do its tokens land?

None of these questions are hard. That's what makes the silence after them so informative: they're only unanswerable when nobody has *decided* — and undecided failure policy ships as whatever your runtime's default exception behavior is, undecided tiering ships as whatever model id got copy-pasted, undecided accounting ships as a bill you reverse-engineer quarterly. The map doesn't make these decisions for you. It just refuses to let you not make them — one row, five columns, every time a `complete()` sneaks into a diff. Helper calls are going to keep accreting; that part is inevitable and mostly good, because each one really does smooth an edge. The only question is whether they accrete onto a map or into the dark. Lockfiles won that argument for dependencies a decade ago. Call sites are next.
