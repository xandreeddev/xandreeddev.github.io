---
title: 'Most approval prompts should never render'
description: 'How a fast-tier LLM judge waves ordinary shell work through silently — and why the worst it can do is show a dialog.'
pubDate: 2026-06-02
tags: [agents, effect, ux]
---

A coding agent that can't run shell commands is a very expensive autocomplete. `bun test`, `git diff`, `rg`, `tsc --noEmit` — that's the texture of real development work, so the agent gets a shell, and now you own a design problem that gets filed under *security* but is mostly **attention rationing**: the human in the loop has a fixed budget of attention per session, and the approval gate is the component that decides what spends it. Yes, a yes/no dialog asked forty times an hour trains a rubber-stamp reflex — that's true, and it's also all the prompt-fatigue argument this post needs.

The interesting question is the inverse one: how much machinery can stand *in front of* the dialog, so that the prompts which do render are exactly the ones worth human eyes? In [efferent](https://github.com/xandreeddev/agent), the coding agent I'm building, every bash command descends a ladder of four tiers, and a dialog appears only when the first three decline to answer:

1. **Project rules** — command patterns this project has blessed before, persisted in settings.
2. **Session rules** — patterns blessed for the current session, held in memory.
3. **The judge** — a fast, cheap model that classifies whatever no rule matched.
4. **The modal** — the human, finally.

Tiers one and two are string lookups: deterministic, instant, free. Tier four is the dialog everybody builds first. The star of this post is tier three, the **auto mode**: an LLM that reads each unmatched command, checks it against the folders you've already handed over, and waves ordinary development work through without rendering anything. In a typical [efferent](https://github.com/xandreeddev/agent) session, most approval prompts never appear at all.

An LLM deciding which security prompts you see *should* make you suspicious. The reason it's safe to put one there is a type signature, and we'll get to it. First, the gate itself.

## One port, four answers

Everything below hangs off a single service. In ports-and-adapters terms it's a **port**: an interface the core package declares without implementing, so different modes can answer the same question differently. (In Effect, a port is a `Context.Tag` — a type plus a unique identifier, implementation supplied later as a layer. The full Effect tour is a post of its own; that gloss carries you through this one.)

```ts title="packages/core/src/ports/Approval.ts"
export interface ApprovalRequest {
  readonly tool: string     // 'Bash' — the only asker today
  readonly summary: string  // what will run, verbatim
  readonly cwd: string      // where it will run
  readonly ruleKey: string  // the rule this command matches — see bashRuleKey below
}

export type ApprovalDecision =
  | { readonly kind: 'allow'; readonly scope: 'once' | 'session' | 'project' } // [!code highlight]
  | { readonly kind: 'deny'; readonly reason?: string }

export class Approval extends Context.Tag('@efferent/core/Approval')<
  Approval,
  { readonly request: (req: ApprovalRequest) => Effect.Effect<ApprovalDecision> }
>() {}
```

The highlighted line is the gate's whole UX, compressed. In the TUI, the modal offers four answers on four keys: **a** — allow once; **s** — allow for this session; **p** — always allow in this project; **d** — deny, with a typed reason. Note what each answer leaves behind. `scope: 'once'` is the stateless dialog everyone builds, and it's the *only* answer that teaches the system nothing. The `'session'` and `'project'` scopes write the rule ledgers that become tiers one and two. And `deny` carries a `reason` that — we'll get there — travels back into the model's context as course-correction data. The contract is that an answer is rarely just an answer; it's a human judgment, captured at the moment it was cheapest to give.

## The judge: a model in front of the modal

Here is the observation the auto mode is built on: most commands an agent runs are ordinary development actions inside folders the human already handed over. Listing, reading, searching, building, testing, version control — inside the project you opened the agent in, every one of those prompts has the same answer, and you know it before you finish reading the command. A gate that asks anyway isn't being careful; it's spending your attention on questions with known answers.

So before any dialog, an unmatched command goes to the **judge**: one completion on the **fast** role — [efferent](https://github.com/xandreeddev/agent)'s settings name for the model used in latency-sensitive helper calls (point it at something small with `:set fastModel`; unset, it falls back to the main model — the roles ride the runtime provider routing, a post of its own). The judge is asked a single question: *does this command stay inside the permitted folders, doing ordinary development work?* The **permitted folders** are the heart of the design — the working directory you opened the agent in, plus every folder a previous answer has granted. The prompt is short enough to read whole, and it's the best artifact in the feature:

```ts title="packages/core/src/usecases/autoApproval.ts"
export const buildJudgePrompt = (input: {
  readonly tool: string
  readonly summary: string // the command, verbatim
  readonly cwd: string
  readonly permittedFolders: ReadonlyArray<string>
}): string => {
  const folders = input.permittedFolders.map((f) => `- ${f}`).join('\n')
  return (
    `You classify one tool call made by a coding agent. This is routing, not enforcement: ` + // [!code highlight]
    `"allow" skips a confirmation prompt, "prompt" shows it to the human. When unsure, prompt.\n\n` +
    `Permitted folders (the call may read or write anything under these):\n${folders}\n\n` +
    `Tool: ${input.tool}\nWorking directory: ${input.cwd}\n` +
    `Input:\n<input>\n${input.summary}\n</input>\n\n` +
    `Verdict rules:\n` +
    `- "allow" — ordinary development work (listing, reading, searching, building, testing, ` +
    `version control, editing files) whose paths all stay inside the permitted folders. ` +
    `Relative paths resolve against the working directory.\n` +
    `- "prompt" — it touches a path outside the permitted folders (set "folder" to that ` +
    `directory, absolute), or it installs software, changes global system state, deletes ` +
    `broadly, talks to the network, or its effect is unclear.\n\n` +
    `Reply with ONLY this JSON, no fences, no prose:\n` +
    `{"verdict":"allow"|"prompt","folder":"<out-of-bounds dir, omit if none>","reason":"<at most 12 words>"}`
  )
}
```

Three sentences in there carry the design. **"This is routing, not enforcement"** tells the model — and you — which tier it's on: the judge isn't deciding whether a command *may* run, only whether a human needs to look first. **"When unsure, prompt"** sets the prior for every ambiguous case. And the verdict vocabulary has exactly two words. There is no `deny` — the judge is structurally incapable of refusing a command on your behalf; the strongest thing it can do is show you a dialog. Notice also that path containment isn't the only axis: installs, global system state, network access, and broad deletes escalate *even when every path is in bounds*, because those are the categories where "inside the project folder" stops being a useful proxy for "you'd wave it through."

The reply contract is one JSON object, and the parser holds the model to it with cold strictness — as a Schema, not as hand-rolled parsing:

```ts title="packages/core/src/usecases/autoApproval.ts"
// JudgeVerdict = { verdict: 'allow' | 'prompt'; folder?: string; reason?: string }
const JudgeReply = Schema.parseJson(
  Schema.Struct({
    verdict: Schema.Literal('allow', 'prompt'), // [!code highlight]
    folder: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
  }),
)

export const parseJudgeVerdict = (text: string): JudgeVerdict => {
  const match = text.match(/\{[\s\S]*\}/)
  if (match === null) return { verdict: 'prompt' }
  return Either.match(Schema.decodeUnknownEither(JudgeReply)(match[0]), {
    onLeft: (): JudgeVerdict => ({ verdict: 'prompt' }),
    onRight: ({ verdict, folder, reason }): JudgeVerdict => ({
      verdict, // … folder + reason ride along when present and non-empty
    }),
  })
}
```

The highlighted literal is the parser's entire security posture: the only replies that decode at all carry a clean `'allow'` or `'prompt'`. Prose wrapped around the JSON, a third verdict the model invented, a wrong-typed field, malformed JSON, no JSON at all — every other shape lands in `onLeft` and collapses to `prompt`. Notice what's *absent*: there is no `JSON.parse` and no `try/catch`. `Schema.parseJson` subsumes both — a parse failure and a wrong shape are the same decode failure, returned as an `Either` value. Exception machinery stays out of the domain; `Either` is as far as a pure helper ever needs to reach. A confused judge can only ever cause a dialog the human would have seen anyway.

And silent doesn't mean invisible. Each judge allow drops a dim `fast approved: <command> — <reason>` line into the transcript, and the judgment's tokens are billed to the fast role in the session stats. Every prompt that didn't render leaves a receipt.

## Why it can't add risk

Now the suspicious part. The judge is an LLM call, and LLM calls fail in a dozen mundane ways: no API key configured for the fast model, a 429 at the wrong moment, a timeout, a model that answers in haiku. If any of those failures could slip a command through unprompted, the auto mode would be a security hole with good intentions. The function's signature is where that gets settled — one line of Effect first, for anyone new to it: an `Effect<A, E, R>` is a program that succeeds with `A`, fails with `E`, and needs services `R`, and `E` is a real type the compiler tracks, not documentation.

```ts title="packages/core/src/usecases/autoApproval.ts"
// JudgeOutcome = JudgeVerdict + the fast-tier tokens the judgment billed
export const judgeApproval = (
  req: ApprovalRequest,
  permittedFolders: ReadonlyArray<string>,
): Effect.Effect<JudgeOutcome, never, UtilityLlm> => // [!code highlight]
  Effect.gen(function* () {
    const utility = yield* UtilityLlm
    const res = yield* utility.complete(
      buildJudgePrompt({ tool: req.tool, summary: req.summary, cwd: req.cwd, permittedFolders }),
      { role: 'fast' },
    )
    return parseJudgeVerdict(res.text) // … plus folder normalization + usage
  }).pipe(Effect.catchAll(() => Effect.succeed({ verdict: 'prompt' } as JudgeOutcome)))
```

Read the highlighted `E` slot: `never`. An error channel of `never` is a compiler-verified claim that every failure path has been handled, and here they're all handled the same way — the closing `catchAll` converts *any* failure into `{ verdict: 'prompt' }`. No key? Prompt. Rate-limited? Prompt. Garbled output? The parser already turned it into a prompt. The failure mode of the auto mode is, exactly, the behavior the gate had before the auto mode existed.

That property deserves a name, because it's rare in features with "AI" in them: **the judge can only subtract dialogs, never add risk.** Its failure set and its confusion set both collapse onto the human path. And this isn't a code-review observation that can rot — extend `judgeApproval` later with a path that doesn't land on `prompt` (a retry policy that re-raises, a stricter parser that fails) and the `never` stops typechecking. The guarantee breaks at build time, not in someone's terminal.

One honest boundary on the claim: `never` covers the *machinery* failing, not the model being *wrong*. A verdict can be mistaken. That's a real tradeoff, and it gets its own section near the end.

## Grants are folders, not command strings

Where do the permitted folders come from? The first one is free: **opening [efferent](https://github.com/xandreeddev/agent) in a directory is the standing grant on that directory.** You chose the cwd; the gate treats that choice as the one permission that never needed asking. Every other folder arrives through the modal — and this is the part of the design I'd defend hardest. When a command reaches *outside* the permitted set, the judge names the out-of-bounds folder in its verdict, and the modal's "allow for session" / "always allow in this project" answers grant **that folder**, not the command string that happened to touch it.

Why folders? Because that's the shape of the decision you actually made. When the agent runs `cat ../shared-lib/src/index.ts` and you answer "always allow," the judgment you formed was not "`cat` is fine" — it was "*that codebase* is fine to work in." Persisting `cmd:cat` would miss in both directions: too narrow, because tomorrow's `ls ../shared-lib` re-prompts; too broad, because `cat` of anything anywhere is now blessed. Persisting the folder records the decision at the granularity you decided it. (Folders the judge names come back normalized — resolved absolute against the cwd, trailing separator stripped — so grants compare stably forever after.)

Here's the whole cascade as the TUI implements it, condensed from the real layer:

```ts title="packages/cli/src/tui-solid/approval.ts"
const allowOnce = { kind: 'allow', scope: 'once' } as const

request: (req) =>
  gate.withPermits(1)(                       // 1-permit semaphore — one question at a time
    Effect.gen(function* () {
      const settings = yield* settingsStore.get()
      if (settings.approvedBashRules?.includes(req.ruleKey)) return allowOnce // tier 1
      if ((yield* Ref.get(sessionRules)).has(req.ruleKey)) return allowOnce   // tier 2

      let hint: { reason?: string; folder?: string } | null = null
      if (settings.autoApprove !== false) {                                   // tier 3 — default ON
        const permitted = [
          req.cwd, // the standing grant // [!code highlight]
          ...(settings.approvedFolders ?? []),
          ...(yield* Ref.get(sessionFolders)),
        ]
        const outcome = yield* judgeApproval(req, permitted)
        if (outcome.verdict === 'allow') return allowOnce // no modal; a dim info line
        hint = outcome // the modal shows the judge's reason + named folder
      }

      const decision = yield* ask(req, hint)                                  // tier 4 — park on a keystroke
      if (decision.kind === 'allow' && decision.scope === 'project') {
        yield* settingsStore.update((curr) =>
          hint?.folder
            ? { ...curr, approvedFolders: [...(curr.approvedFolders ?? []), hint.folder] }
            : { ...curr, approvedBashRules: [...(curr.approvedBashRules ?? []), req.ruleKey] },
        )
      }
      // … scope 'session' does the same into the in-memory Refs
      return decision
    }),
  ),
```

A few lines earn their wages here. The grant branch at the bottom is the folder thesis in code: when the judge named a folder, the "project" answer appends it to `approvedFolders`; when it didn't — auto mode off, or a prompt with no folder in play — the answer falls back to granting the command's *rule*, the tier-1 mechanism we'll dissect next. Both ledgers are plain string arrays in the project's settings file:

```ts title="packages/core/src/entities/Settings.ts"
autoApprove: Schema.optional(Schema.Boolean),
// unset → on; false → every unmatched command prompts
approvedBashRules: Schema.optional(Schema.Array(Schema.String)),
// 'cmd:bun test', 'exact:…' — written by 'always allow in this project'
approvedFolders: Schema.optional(Schema.Array(Schema.String)), // [!code highlight]
// absolute paths beyond the workspace root, granted when a command reached outside
```

Then there's `gate.withPermits(1)` wrapping the whole thing — a one-permit **semaphore**, a counter of permits where holding the only one means exclusive access. It exists because approval requests arrive concurrently: [efferent](https://github.com/xandreeddev/agent) fans work out to parallel sub-agents, and several can want bash in the same instant. The semaphore serializes them into single file, and because the ledger checks live *inside* the permit, each waiter re-checks the ledgers when its turn finally comes. Press **s** — allow for session — on the first sub-agent's `bun test`, and the identical requests queued behind it match the fresh session rule and dissolve without rendering anything. One keystroke, a whole queue answered.

One more structural choice that's easy to miss: the session ledgers (`sessionRules`, `sessionFolders`) are `Ref`s — Effect's atomic mutable cells — created *outside* the layer, in the closure that builds it. The layer is rebuilt per agent run; the ledgers must outlive a turn, or "allow for session" would quietly mean "allow for the next few seconds."

## The deterministic tier: what a rule remembers

Underneath the judge sits the zero-cost tier, and its entire intelligence is in choosing *which string to remember*. When the modal grants a command rather than a folder, what persists is a **rule key** derived from the command — and granularity is the whole game. Too coarse, and one click recreates unrestricted shell. Too fine, and every changed test path re-prompts, which recreates the rubber stamp the gate exists to avoid.

```ts title="packages/core/src/ports/Approval.ts"
/** Shell metacharacters that make a command's effect non-obvious from its head. */
const SHELL_META = /[|&;<>$`(){}\[\]*?!\\\n]/

export const bashRuleKey = (command: string): string => {
  const trimmed = command.trim().replace(/\s+/g, ' ')
  if (SHELL_META.test(trimmed)) return `exact:${trimmed}`
  const [head, second] = trimmed.split(' ')
  // … empty-command guard
  return second !== undefined && !second.startsWith('-')
    ? `cmd:${head} ${second}` // [!code highlight]
    : `cmd:${head}`
}
```

The landing spot is command + subcommand. Bless `bun test src/judge.test.ts` and the rule left behind is `cmd:bun test` — next week's `bun test` on a different file matches without a prompt, while `bun install` doesn't. Two escape hatches keep the heuristic honest. A *flag* as the second word collapses to the bare command: `rm -rf` becomes `cmd:rm`, because a persisted `cmd:rm -rf` would *read* like a narrower, safer rule while being the opposite. And anything carrying shell metacharacters gets an `exact:` key — the full normalized string, matching only itself — because a pipe or a command substitution can't be judged by its first two words, so it never earns a prefix rule.

Where the judge is probabilistic and priced per call, this tier is a string lookup that costs nothing forever. The two compose into a tidy division of labor: humans write durable rules through the modal, the judge handles the long tail the rules haven't met yet, and any judged command that ends up earning a human answer graduates into the deterministic tier.

## A deny is data, not a dead end

The fourth modal answer deserves its own section, because most gates get it wrong. In the common design a denial is a dead end: the tool call errors, the model apologizes, the turn limps or dies. [efferent](https://github.com/xandreeddev/agent) treats a denial as *information addressed to the model*. The deny answer takes a free-text reason, and the whole thing returns as the bash tool's failure payload:

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
    message: `the user denied this command: ${decision.reason} — adjust your approach; don't retry it verbatim.`, // [!code highlight]
  })
}
```

All of [efferent](https://github.com/xandreeddev/agent)'s tools declare their failures as *returned* values — a failed call becomes a result the model reads, not an exception that kills the turn — so this payload lands in context exactly like a failing compiler line. Deny a command aimed at the production database with the reason *"don't touch the prod db, use test.db,"* and the next tool call targets `test.db`: same turn, no restart, no second dialog. The appended instruction does quiet work too — *don't retry it verbatim* heads off the failure-loop reflex, and a reason-less deny gets a variant nudging the model to adjust or ask what you'd prefer. One typed sentence of judgment, and the rest of the turn bends around it instead of dying.

## Headless: where the apparatus vanishes

Everything above assumes a human is present. In `--print` mode and CI there isn't one, and the honest version of an approval gate with nobody watching is a static flag. Headless runs keep the blunt instrument: bash is off unless the invocation passes `--allow-bash`, and when it's off the tool returns a failure saying so —

```ts title="packages/core/src/usecases/codingToolkit.ts"
if (!allowBash) {
  return yield* Effect.fail({
    error: 'BashNotAllowed',
    message: 'bash execution is disabled in this mode — re-run with --allow-bash to enable',
  })
}
```

— and when it's on, the `Approval` port is satisfied by a five-line allow-everything layer, because `--allow-bash` already *is* the human's standing decision, made once at invocation time:

```ts title="packages/core/src/ports/Approval.ts"
export const ApprovalAllowAllLive = Layer.succeed(
  Approval,
  Approval.of({
    request: () => Effect.succeed({ kind: 'allow', scope: 'once' } as const), // [!code highlight]
  }),
)
```

No judge, no modal, no ledgers: CI never prompts and never spends a token judging, and the eval suites run against this same layer. A dialog nobody will ever see isn't safety; it's a hang with extra steps. The structural point is what the swap *didn't* cost — the gate is a port, so "who answers the question" is a one-layer decision per mode, not an `if` forest inside the bash handler.

## What the auto mode trades away

The ledger, honestly kept.

**The judge can be wrong in the direction that matters.** The `never` channel guarantees the machinery fails safe; it says nothing about a fast model misreading a command and answering `allow` where a human would have squinted. The design hedges — the escalation list routes installs, network, global state, and broad deletes to the human even in-bounds; "when unsure, prompt" sets the prior; the strict parser eats anything garbled — but a hedge is not a boundary, and the source is blunt about it: the judge is *"not a security boundary… a prompt-fatigue killer."* If your threat model includes adversarial command strings — a hostile repo whose scripts are crafted to read innocuously, prompt injection aimed at the judge itself — then a classifier reading the attacker's text is attack surface, and `:set autoApprove false` exists precisely so you can run rules-plus-modal only.

**It isn't free.** Every unmatched command is a round-trip on the fast role: tokens billed (visible in the session stats), and latency added — including to commands that end up prompting anyway, which now show their dialog a beat later than they would have. The prompt is small and the model is cheap, but a long session pays the toll many times.

**Judge allows don't learn.** An auto-approved command comes back with scope `'once'`; run it again tomorrow and it's judged again. That's a deliberate asymmetry — only a human's answer writes a ledger, so the durable permission record contains nothing a model put there — but it means the long tail of odd-but-fine commands costs a judgment every time, where a persisting design would amortize it.

**Folder grants are coarse and quiet.** "Always allow in this project" on a folder blesses ordinary work under it indefinitely, and there's no `:approvals` view yet to list or revoke what's accumulated — today, revocation means opening the settings file and deleting a line. The strings are at least plain and greppable, but "audit by text editor" is a stopgap, and the view is on the roadmap.

## Attention is the budget

Permission gates get designed as if the unit of safety were the prompt — more prompts, more checkpoints, more safety. I think the unit of safety is the *read* prompt, and reads are bought from a budget that every needless dialog drains. The mental model that holds up is a cache hierarchy for human judgment: persisted rules are the hot tier, session rules the warm tier, the judge is the prefetcher guessing what you'd say, and the modal is the expensive miss — which should be rare precisely so that it stays meaningful. Then make the prefetcher's only failure mode a miss, never a silent corruption, and let nothing but a human keystroke write to the durable tiers.

Auto mode isn't autonomy. It's triage, and what makes it trustworthy is mechanical, not aspirational: a classifier that can wave through or escalate but never refuse, an error channel that can only produce a dialog — `never`, checked by the compiler — and ledgers only humans write. The same shape is next in line for [efferent](https://github.com/xandreeddev/agent)'s out-of-cwd writes and network egress, and I'd argue it's where every human-in-the-loop gate lands once an agent does real volumes of work. A prompt that renders should mean something. The machinery's whole job is to keep it that way.
