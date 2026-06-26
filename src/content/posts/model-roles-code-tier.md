---
title: "The model role, not the model id — and why 'code' earns its own tier"
description: 'Agents should declare a job, not a model. Three roles — general, code, fast — resolved once per run, and why coding got pulled onto its own tier.'
pubDate: 2026-07-31
tags: [ai, agents, effect]
series:
  name: 'Building a coding agent'
  order: 10
draft: true
---

A sibling post argued that your LLM provider is *state*, not architecture — a string you re-read per call, never a layer you freeze at startup. This is that argument one level up, and it changes a question most agents answer badly. The bad question is "which model should my agent use?" It has a hidden assumption — that there's *one* — and the assumption is wrong twice over.

It's wrong on the cheap end first, and that's the [familiar half](https://github.com/xandreeddev/efferent): a long-running agent makes far more model calls than it has chat turns — compaction digests, approval verdicts, session titles — and running those on a frontier model pays frontier prices for jobs a small model finishes fine. But it's *also* wrong on the expensive end, which is the part this post is about: the agentic work itself isn't one job. Reasoning about a change, planning an approach, reading a codebase — that's one skill. Sitting down and *writing the diff* is another, and the model that's best at the first isn't always the one that's best (or cheapest-for-good-enough) at the second.

So [efferent](https://github.com/xandreeddev/efferent), the coding agent I'm building on Effect, doesn't have a model. It has three **roles**, and the only thing a piece of code ever names is which role it wants.

## A role is a job description, not a model

The whole vocabulary is one type and one pure function:

```ts title="packages/sdk-core/src/entities/Model.ts"
export type ModelRole = 'general' | 'code' | 'fast'

/** code/fast fall back to general when unset. The single place the chain lives —
 *  the router, the helper tier, and the settings UI all call this. */
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

Three jobs, one breath each. **general** is the default brain: the root conversation, and the sub-agents doing research, analysis, and planning. **code** is the same agentic loop narrowed to one job — sub-agents that *write* code — so a model tuned for editing can sit behind the diffs while reasoning stays on `general`. **fast** is the helper tier: the latency-sensitive and background one-shot calls (digests, the approval judge, session titles) that a [separate post](https://github.com/xandreeddev/efferent) maps in full.

The highlighted line is the design, not the `switch`. A role is defined by *what the call is for*, and it resolves to a model the user chose — never the other way around. Nothing in the agent loop, no tool handler, no sub-agent spawn ever names a model id. It names a job; `modelForRole` turns the job into a model; the user owns the mapping with three settings (`:set codeModel …`, `:set fastModel …`, and the live `:model` picker for `general`). The day a better coding model ships, that's one setting, not a grep through call sites for a hardcoded id.

## Code is a role the model asks for

The split only pays off if *something* decides, per piece of work, whether it's reasoning or editing — and that decision lives where the work is delegated. efferent fans work out to sub-agents with one generic `run_agent` tool, and the role is a parameter the orchestrator fills in:

```ts
run_agent({
  folder: 'packages/auth',
  task: 'Apply the token-refresh fix we scoped: …',
  role: 'code',   // this sub-agent WRITES — put it on the code tier // [!code highlight]
})
```

The tool description is blunt about the rule, because the description is the policy that runs on every turn: *set `role` to `"code"` when the sub-agent will write code, `"general"` (the default) for research, analysis, or planning — it is **never** a specific model.* That last clause is load-bearing. The orchestrating model is good at classifying *its own* intent ("am I about to investigate, or about to edit?") and bad at — and shouldn't be trusted with — choosing a model id. So the interface only lets it express the job. Which model that job runs on was decided once, by a human, in settings.

## Resolve once, freeze for the run

Here's the part that makes roles safe in a system where the provider is otherwise live. The provider *picker* re-reads on every call — `:model` mid-session switches the next message, no restart. But you do **not** want that liveness reaching inside a running fleet: a sub-agent that's three turns into writing a file should not have its model yanked out from under it because you flipped `:model code` in another pane. So each role is resolved to a concrete model *once*, at the top of a run, and frozen for that run's whole tree:

```ts title="packages/sdk-core/src/usecases/runAgent.ts"
Effect.locally(RunContextRef, {
  // …rootConversationId, depth, the shared token pool…
  pinnedModels: {
    general: input.pinnedGeneral ?? settings.model,
    code: settings.codeModel ?? input.pinnedGeneral ?? settings.model, // [!code highlight]
    fast: settings.fastModel ?? input.pinnedGeneral ?? settings.model,
  },
})
```

`RunContextRef` is a `FiberRef` — fiber-scoped ambient state that every child fiber inherits a copy of (the concurrency toolkit behind it is [its own post](/posts/effect-semantics-layers-concurrency/)). Pinning the three models into it at run start means the entire sub-agent tree, however deep it fans out, reads the *same* frozen mapping. A `code` spawn five levels down resolves to whatever `codeModel` was when its top-level turn began — not whatever it is now. Liveness at the session boundary, stability within a run: the `FiberRef` is exactly the seam that lets those two coexist without a flag.

Note the fallback riding through every field: `?? settings.model`. An unset `codeModel` resolves to `general`, so the `code` role *works on day one* — every coding sub-agent just runs on your main model until you decide a dedicated code model is worth configuring. The capability ships before the configuration does; you opt into the second model when you have a reason, and `code` quietly upgrades the moment you do. (`codeModelDistinct(settings)` is the predicate the UI uses to show whether a *separate* code model is actually in play, or whether `code` is currently just `general` wearing a different label.)

## We didn't guess that code wanted its own tier

The honest origin story: the `code` role isn't an a-priori bit of taxonomy, it's an eval result. For a while there were two roles — agentic and helper — and all agentic work, reasoning and editing alike, ran on one model. Then the colocated eval suites (the [case for which](/posts/colocated-evals/) is its own post) started saying something specific: on a model-comparison matrix scored across tiers, the model that planned best and the model that produced the cleanest small diffs weren't the same model, and the gap was big enough to spend a config knob on. So coding work got [routed onto its own tier](https://github.com/xandreeddev/efferent), and the very next thing the evals caught was the failure mode of a *cheaper* code tier — small edits, the kind a coding model should ace, regressing — which became its own fix to make code-tier delegation reliable for exactly those one-line changes.

That loop is the point as much as the tier is: a role isn't a place you stash a vibe about which model is "better at code." It's a measurable seam. Because every call already carries its role, you can score `general` vs `code` candidates independently, swap one without touching the other, and watch the per-role spend ledger (`Σ general 64k · code 12k · fast 1.2k`) tell you what each tier actually costs. The taxonomy is what makes the model choice an experiment instead of an opinion.

## What it costs

Three honest prices.

**A second model is a quality bet you have to keep paying off.** Putting `code` on a different — especially a cheaper — model asserts that model can write your diffs as well as your reasoning model would have. That assertion rots: providers ship new models, your codebase's idioms drift, and a code tier that was fine in June regresses in September. The mitigation is the same machinery that justified the tier — evals that score the code role on its own — but if you set `codeModel` and never re-measure, you've bought a silent quality regression nobody's dashboard shows. (This is exactly why the cheaper-code-tier fix above existed at all.)

**Roles are indirection, and indirection has a floor.** A reader of a `run_agent({ role: 'code' })` call has to hop to settings to learn which model that is today — one level more than a literal id. On day one, with one model configured, the whole apparatus is pure ceremony; it starts paying at the second model and the second call site. If your agent will only ever run one model, you don't need roles — you need the fallback, which is "everything is `general`," which is what you already had.

**Pinning means you can't hot-swap mid-fleet — on purpose.** Flip `:model code` while a coding sub-agent is running and the running agent ignores you; your change applies to the *next* run. That's the correct behavior — model-swapping a fiber mid-write is how you corrupt a diff — but it does mean "use the new model right now" requires the current fleet to drain first. Liveness stops at the run boundary, and that boundary is a feature you'll occasionally wish were a bug.

## Pick the job, not the model

The reframe is small and it travels. Every place your application is about to hardcode a model id, ask what *job* that call is — reasoning, editing, a cheap background chore — and name the job instead. Resolve jobs to models in one pure function, pin them once per run so a live picker can't destabilize work in flight, and let the fallback make every role work before any of them is configured. You get a system where swapping a model is a setting, splitting a workload across two models is a role, and "is the code tier earning its keep?" is a number you can actually read — instead of four hardcoded ids and a quarterly argument about which one to bump.

The provider was state, not architecture. The role is the same insight applied to *which* model, for *which* job — and "writing code" turned out to be a job worth naming.
