---
title: 'Evals are unit tests for behavior, and they belong in the repo'
description: "Cases, tasks, and scorers as Effect programs — and why an agent's evals belong in the same repo as its prompts."
pubDate: 2026-06-10
tags: [evals, effect, ai]
---

Agent codebases have a geography problem. Everything that *decides* how the agent behaves lives in the repo: the system prompt, the tool descriptions the model reads before picking one, the loop policy that says when to stop and what's allowed. Everything that *measures* how the agent behaves usually lives somewhere else — an eval dashboard, a notebook somebody ran in March, a separate "evals" repo with its own pasted copy of the prompt. Then someone softens one sentence in a tool description, it looks fine in one manual session, it ships — and the regression is found by a user, three days later, doing the one thing nobody tried.

The fix is not a platform. **Evals are unit tests for behavior, and nobody puts their unit tests in a different repo.**

This post builds the idea up from zero — what an eval actually *is*, one piece at a time — and then walks the real harness inside [efferent](https://github.com/xandreeddev/efferent), the coding agent I'm building on Effect: a few-hundred-line framework, an environment that runs the *actual* agent in a disposable world, and three production suites, including one that exists to pin a prompt bug I actually shipped. Every claim comes with the receipt.

## The drift problem

Start with what's strange about agents as software. A disproportionate amount of the system's behavior is *prose*. The system prompt is prose. Tool descriptions are prose the model reads to decide which tool fits the job — edit one adverb and the model's first move on a whole class of requests can change. Loop policy is code, but it encodes judgment: how many steps, which tools are allowed, when to summarize. All of it lives in ordinary source files, versioned like everything else.

And all of it is invisible to the type checker. `tsc` proves the program is coherent; it has no opinion on whether the agent, asked to *find* something, reaches for `grep` or starts rewriting files. Behavior changes don't fail builds. They don't fail unit tests either, because unit tests exercise *your* code, and the interesting failures live in the model's response to your code.

The standard answer is to measure: collect representative inputs, run the system, score the outputs. The standard *mistake* is where that measurement lives. Every hop between the behavior and its measurement adds latency to the only loop that matters — *edit the prompt, see what broke*:

- If the evals live in another repo, an edit means a context switch, a sync, maybe a deploy to an eval service. The loop costs an afternoon, so it runs before releases. Quarterly, in practice.
- If the eval tool needs your prompt and tools re-declared in its own format — a YAML file, a web form — you now have two sources of truth, and they drift the day after you create the second one.
- If the results live in a dashboard, the PR that changes behavior and the evidence about that behavior are reviewed in different tabs, by different people, on different days.

Colocation collapses all three. The argument isn't tidiness — it's **latency of the loop**. When the suite is one command in the same terminal, it runs like tests run: on every behavior change, before the diff goes up. [efferent](https://github.com/xandreeddev/efferent)'s workspace makes the point structurally; evals are simply the fourth package:

```
packages/
├── core/       prompts, ports, tools — the behavior being judged
├── adapters/   provider SDKs + IO
├── cli/        composition root + TUI
└── evals/      the judges, in the same dependency graph
```

`packages/evals` imports the *real* system prompt builder, the *real* agent loop, and the *real* toolkit from `core`. There is no copy of the prompt anywhere. When a tool description changes, the next eval run measures the new description, automatically, because there is only one; when a type the suites depend on changes, the eval package stops compiling and tells you so. Drift requires two copies. There's one.

The rest of this post is the anatomy of that fourth package.

## What an eval actually is

Strip the vocabulary down. An **eval** (short for evaluation) is a test where the system under test includes a model. It has exactly three parts, and the names are worth memorizing because every framework on earth converges on them:

- A **case** is data: an input, plus what you expect to happen.
- A **task** runs the real system on the case's input and captures something scoreable.
- A **scorer** is judgment: it turns `(input, output, expected)` into a number between 0 and 1.

That's the whole concept. In sketch form:

```ts
const kase = {
  input: 'Read config.json and tell me which port the server uses.',
  expected: { firstTool: 'read_file' },
}

const output = await runMyAgent(kase.input) // task — the real agent, not a mock
const score = output.tools[0] === kase.expected.firstTool ? 1 : 0 // scorer
```

Arrange, act, assert — a unit test with two of the bolts loosened. First, the act is non-deterministic: the same case can pass at 9:00 and fail at 9:05, because there's a model in the middle. Second, the assert is sometimes itself a judgment call: "did the agent's summary faithfully capture the session?" has no `===`. Those two loosened bolts generate every interesting design decision in the rest of this post.

One paragraph of Effect, for readers who haven't met it. An `Effect<A, E, R>` is a *description* of a program — inert until executed — that succeeds with an `A`, can fail with an `E`, and needs the services listed in `R` to run. A `Layer` is a recipe that builds those services, supplied once at the program's edge — which makes swapping implementations (real database, in-memory map) a one-line change at one location. That's all this post needs; the full tour of Effect's semantics is a post of its own. What matters here: if a task and a scorer are Effects, then *running the real agent* and *asking a model to judge* are the same kind of value as everything else, and one runner can treat them uniformly.

## A spec is data; the runner is a program

Here is [efferent](https://github.com/xandreeddev/efferent)'s entire eval vocabulary — one file, no classes, no runner magic:

```ts title="packages/evals/src/framework/Eval.ts"
/** A scorer returns a bare 0..1 number or `{ score, detail }`. */
export type ScoreResult = number | { score: number; detail?: string }

export interface ScorerArgs<I, O, T> {
  readonly input: I
  readonly output: O
  readonly expected: T
}

/** Judges one task output. `E`/`R` flow up into the spec, so a scorer
 *  that calls a model just declares it in `R`. */
export interface Scorer<I, O, T, E = never, R = never> {
  readonly name: string
  readonly score: (a: ScorerArgs<I, O, T>) => Effect.Effect<ScoreResult, E, R>
}

export interface EvalCase<I, T> {
  readonly name: string
  readonly input: I
  readonly expected: T
}

export interface EvalSpec<I, O, T, R> {
  readonly name: string
  readonly data:
    | ReadonlyArray<EvalCase<I, T>>
    | Effect.Effect<ReadonlyArray<EvalCase<I, T>>, unknown, R>
  readonly task: (input: I) => Effect.Effect<O, unknown, R> // [!code highlight]
  readonly scorers: ReadonlyArray<Scorer<I, O, T, unknown, R>>
  /** Mean-score pass bar, 0..1. Default 0.6. */
  readonly threshold?: number
  /** How many cases run at once. Default 1 (gentle on rate limits). */
  readonly concurrency?: number
}

/** Identity helper that pins the generic inference at the definition site. */
export const defineEval = <I, O, T, R>(spec: EvalSpec<I, O, T, R>) => spec
```

Four type parameters, each earning its place. `I` and `T` are the case — input and expected. `O` is the task's output, and it's the quiet differentiator: in string-based harnesses the output is text, so scorers do substring archaeology; here `O` is whatever structure the task returns — you'll see a `CoderRun` later that carries *which tools fired, in what order*, and the post-run contents of files — and scorers consume that structure with the compiler watching. `R` is the Effect environment: the spec declares what services its task and scorers need (a language model, a conversation store) without saying how they're built. The environment arrives later, once, as a Layer.

Three smaller decisions in the same file:

- **`data` can be an Effect.** A dataset is allowed to be *computed* — read from fixture files, queried, even generated by a model — without the spec changing shape. ([efferent](https://github.com/xandreeddev/efferent)'s cases are inline arrays today; the slot is there for the day they move to files.)
- **`threshold` is a mean-score pass bar, not per-case.** This is the first concession to the loosened bolts: with a stochastic system, "every case scores 1.0" is a flaky CI gate, and a flaky gate gets deleted. "The suite's mean stays above 0.6" survives a bad sample while still catching a real regression.
- **`concurrency` defaults to 1.** Each case may hit a live provider; the fan-out knob is a number you raise deliberately, not a thread pool you build.

And note what a spec *doesn't* do: anything. `defineEval` is the identity function — it exists purely to pin type inference where the spec is written. A spec is pure data describing an experiment. Running it is someone else's job.

## A failing case is a data point, not a crash

That someone is `runEval`, and its one structural idea is worth slowing down for. Eval suites talk to flaky networks, rate-limited providers, and a model that occasionally emits something unparseable. In a naive runner, any of those kills the process twenty minutes into a run — and a suite that dies randomly is a suite that stops getting run. The cure is `Effect.exit`: it converts an effect's outcome — success *or* failure — into a plain value called an `Exit`, so failure becomes something you inspect instead of something that propagates.

```ts title="packages/evals/src/framework/runEval.ts"
const runCase = <I, O, T, R>(spec: EvalSpec<I, O, T, R>, kase: EvalCase<I, T>) =>
  Effect.gen(function* () {
    const taskExit = yield* spec.task(kase.input).pipe(Effect.exit) // [!code highlight]

    if (Exit.isFailure(taskExit)) {
      // The report shows WHY this case died; the suite lives on.
      return { name: kase.name, ok: false, error: Cause.pretty(taskExit.cause), scores: [], mean: 0 }
    }

    const scores = []
    for (const scorer of spec.scorers) {
      const exit = yield* scorer
        .score({ input: kase.input, output: taskExit.value, expected: kase.expected })
        .pipe(Effect.exit)
      scores.push(
        Exit.isFailure(exit)
          ? { name: scorer.name, score: 0, detail: 'scorer error' }
          : toOutcome(scorer.name, exit.value),
      )
    }

    return { name: kase.name, ok: true, scores, mean: average(scores.map((s) => s.score)) }
  })

export const runEval = <I, O, T, R>(
  spec: EvalSpec<I, O, T, R>,
): Effect.Effect<EvalReport, never, R> =>
  Effect.gen(function* () {
    const cases = Array.isArray(spec.data)
      ? spec.data
      : yield* spec.data.pipe(Effect.orElseSucceed(() => []))

    const results = yield* Effect.forEach(cases, (kase) => runCase(spec, kase), {
      concurrency: spec.concurrency ?? 1,
    })

    const mean = average(results.map((r) => r.mean))
    return { name: spec.name, cases: results, mean, passed: mean >= (spec.threshold ?? 0.6) }
  })
```

Both the task *and every individual scorer* go through `Effect.exit`. A provider 429 mid-task becomes a case with `ok: false` and the pretty-printed cause in the report. A judge that throws becomes a 0 score with a `detail` saying so, while the case's other scorers still count. The signature carries the proof: `runEval` returns `Effect<EvalReport, never, R>` — that `never` in the error slot is a compiler-checked claim that *every* failure has been converted into data. (Why a type can make that promise is the deep-dive's territory.)

The last thing the signature says is the colocation thesis in miniature: `R` is still open. The runner doesn't know what world it executes in. The caller provides one — next section — and provides it *once*, so every suite in a run shares one set of clients and one settings load.

## A scorer is an Effect — which is how a judge gets to call a model

Scorers come in two species, and the type system lets them be the same thing. The deterministic species is trivial:

```ts title="packages/evals/src/framework/scorers.ts"
/** Pass/fail predicate — 1 if true, 0 if false. */
export const predicate = <I, O, T>(
  name: string,
  test: (a: ScorerArgs<I, O, T>) => boolean,
): Scorer<I, O, T> => ({
  name,
  score: (a) => Effect.sync(() => (test(a) ? 1 : 0)),
})
```

Next to it lives `includesAll`, a substring-coverage ratio — "what fraction of these expected facts appear in the output" — for partial credit. Both are pure functions in an Effect costume. The second species is why the costume matters. Some behavior has no predicate: *is this summary faithful?* *Is this edit complete and unbroken?* The honest scorer for those questions is a model with a rubric — the pattern the field calls **LLM-as-judge**. And because a `Scorer`'s `score` returns an Effect with an `R` channel, a judge is just a scorer that declares it needs a `LanguageModel`:

```ts title="packages/evals/src/framework/scorers.ts"
const JUDGE_SYSTEM =
  'You are a strict evaluator. Read the rubric and the candidate output, then ' +
  'grade it. Be conservative: only award a high score when the output clearly ' +
  'satisfies the rubric.'

/** LLM-as-judge: grade an output against a rubric. Unparseable verdicts score 0. */
export const llmJudge = <I, O, T>(
  name: string,
  buildPrompt: (a: ScorerArgs<I, O, T>) => string,
): Scorer<I, O, T, unknown, LanguageModel.LanguageModel> => ({
  name,
  score: (a) =>
    Effect.gen(function* () {
      const prompt = Prompt.make(
        `${JUDGE_SYSTEM}\n\n${buildPrompt(a)}\n\n` +
          'Reply with ONLY a JSON object: {"score": <number between 0 and 1>, "reason": "<one sentence>"}.',
      )
      const res = yield* LanguageModel.generateText({ prompt }) // [!code highlight]
      return parseJudge(res.text) // fail closed: no JSON, bad JSON → score 0
    }),
})
```

Three details carry the weight. The judge runs on **whatever `LanguageModel` is in context** — the same multi-provider router the agent itself uses, so there's no second client, no judge-specific API key, no separate configuration to drift. The verdict parsing **fails closed**: a judge that rambles instead of emitting JSON scores the case 0, biasing errors toward false alarms rather than false confidence — for a regression gate, that's the right direction to be wrong in. And the judge's one-sentence `reason` rides back as the score's `detail`, so the terminal report tells you *why* a case got 0.5, not just that it did.

The escape hatch `fromEffect` rounds out the set — any Effect that produces a score is a scorer. The framework doesn't distinguish a string comparison from a model call from a database lookup. They're all programs that judge.

## The environment: the real agent in a disposable world

Now the part most eval setups fumble. The task must run *the real agent* — and the unit-testing instinct says to mock the model, which is exactly backwards here, because the model's behavior is the thing being measured. Mock it and you're testing your mock. So the rule for the eval environment is: **everything that shapes behavior stays real; everything stateful or interactive gets swapped.** [efferent](https://github.com/xandreeddev/efferent)'s version is one Layer:

```ts title="packages/evals/src/env.ts"
// Headless credentials: provider keys from env vars — the product CLI's
// interactive :login flow can't run in an eval or in CI.
const CredentialsLive = Layer.mergeAll(
  EnvAuthStoreLive,
  LocalSettingsStoreLive.pipe(Layer.provide(LocalFileSystemLive)),
)

export const EvalEnvLive = Layer.mergeAll(
  ModelLive, // the REAL multi-provider router — the thing being measured // [!code highlight]
  InMemoryConversationStoreLive, // swapped: SQL store → a Ref of Maps
  InMemoryContextTreeStoreLive, //  swapped: no Docker, no DB file, in CI or anywhere
  LocalFileSystemLive, // real fs — pointed at a throwaway dir per case
  LocalShellLive, // real shell — same
  HttpLive,
  WebSearchLive.pipe(Layer.provide(FetchHttpClientLive)),
).pipe(Layer.provideMerge(CredentialsLive), Layer.orDie)
```

Read the comments column as a ledger. **Real:** the model layer (the actual router with the actual provider selection logic — runtime model routing is a post of its own), the filesystem, the shell, HTTP. **Swapped:** the conversation and context-tree stores become in-memory maps — and not casually; the in-memory store replicates the production adapter's position and checkpoint semantics exactly, so the loop's history machinery behaves identically. Credentials come from environment variables via `EnvAuthStoreLive` — deliberately the *only* place in the codebase that reads provider-key env vars, and it's read-only: its setters fail, because there's no file behind it to persist to. The layer composition mirrors the CLI's `main.ts` move for move; what `provideMerge` and friends actually mean at the type level is a post of its own.

A real filesystem and a real shell need somewhere safe to point. Every case gets a fresh temporary directory, materialized from the case's declared files and destroyed afterwards:

```ts title="packages/evals/src/support/workspace.ts"
export const withTempWorkspace = <A, E, R>(
  files: Record<string, string>,
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const dir = mkdtempSync(join(tmpdir(), 'agent-eval-'))
      // … materialise `files` into it, creating nested dirs
      return dir
    }),
    use,
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })), // [!code highlight]
  )
```

`acquireUseRelease` guarantees the release runs however the use ends — success, failure, or interrupt (semantics that get a post of their own). For evals the payoff is hygiene you don't have to think about: cases can't contaminate each other, a crashed case can't litter `/tmp`, and Ctrl-C halfway through a suite leaves nothing behind.

One swap remains. The product agent asks a human before running bash — in production that's a TUI modal fronted by an LLM judge, a post of its own. An eval has no human, so the suites provide core's static allow-all `Approval` implementation: every request answered `allow`, instantly, by a five-line layer. Same port, different policy — which is the whole layer trick, applied to consent.

### Bounding a case to one model call

The last support piece is the bridge between "a case" and "the agent": `runCoder` stands up a real coder agent — real system prompt, real skills discovery, real scope tree, built by the same functions `main.ts` calls — over a temp workspace, runs one prompt through the real loop, and reports a typed result:

```ts title="packages/evals/src/support/coder.ts"
export interface CoderRun {
  readonly tools: ReadonlyArray<string> // tool names, in call order
  readonly finalText: string
  readonly files: Record<string, string> // `readback` contents, captured before teardown
}

export const runCoder = (
  files: Record<string, string>,
  prompt: string,
  opts: {
    allowTools?: ReadonlyArray<string>
    stopAfterFirstToolTurn?: boolean
    readback?: ReadonlyArray<string>
  } = {},
): Effect.Effect<CoderRun, unknown, EvalEnv> =>
  withTempWorkspace(files, (dir) =>
    Effect.gen(function* () {
      const { config, runtime } = yield* buildConfig(dir) // the REAL prompt + toolkit, as main.ts builds them
      const id = yield* (yield* ConversationStore).create(dir)
      const toolsRef = yield* Ref.make<ReadonlyArray<string>>([])
      const allow = opts.allowTools ? new Set(opts.allowTools) : null

      const hooks: AgentHooks = {
        onBeforeToolCall: (e) =>
          Ref.update(toolsRef, (a) => [...a, e.toolName]).pipe(
            Effect.as(
              allow === null || allow.has(e.toolName)
                ? ({ action: 'continue' } as const)
                : ({ action: 'block', reason: `tool '${e.toolName}' is not permitted in this eval` } as const), // [!code highlight]
            ),
          ),
        onShouldStopAfterTurn: () => Effect.succeed(opts.stopAfterFirstToolTurn === true),
      }

      const result = yield* runAgent(config, id, prompt, hooks, dir).pipe(
        Effect.provide(runtime.handlerLayer),
        Effect.provide(ApprovalAllowAllLive), // evals never prompt a human
      )

      const tools = yield* Ref.get(toolsRef)
      const readback: Record<string, string> = {}
      for (const rel of opts.readback ?? []) readback[rel] = readWorkspaceFile(dir, rel)
      return { tools, finalText: result.finalText, files: readback }
    }),
  )
```

The options are cost controls disguised as test fixtures. `allowTools` turns the loop's before-tool-call hook into an allowlist: a disallowed call is *blocked with a reason the model can read* — an ordinary tool failure, not a crash — so a "read-only" case is read-only by construction, not by hoping the prompt behaves. `stopAfterFirstToolTurn` ends the loop after the first turn that issues tool calls, bounding a case to roughly **one** LLM call. And the same hook that enforces the allowlist records every tool name into a `Ref`, which is how `CoderRun.tools` ends up carrying call order — the typed output the scorers were promised. `readback` snapshots named files in the instant before the workspace evaporates, so edit suites can assert on what's actually on disk.

That's the whole machine. Now the three suites that use it — deliberately at three different altitudes.

## Suite one: the agent's first move

The cheapest meaningful question about a coding agent: given a small workspace and a clear read-only intent, what does it reach for *first*? An agent asked to find a symbol should grep, not open files one by one; asked to read a named file, it should read it, not list the directory first. First-move quality is exactly the kind of behavior a tool-description edit silently perturbs.

```ts title="packages/evals/src/suites/toolSelection.eval.ts"
interface ToolInput {
  readonly files: Record<string, string>
  readonly prompt: string
}
interface ToolExpected {
  readonly firstTool: string
}

const READ_ONLY = ['grep', 'glob', 'ls', 'read_file', 'read_skill']

const CASES = [
  {
    name: 'read-named-file',
    input: {
      files: { 'config.json': '{ "port": 8088, "host": "localhost" }\n' },
      prompt: 'Read config.json and tell me which port the server uses.',
    },
    expected: { firstTool: 'read_file' },
  },
  {
    name: 'search-for-symbol',
    input: {
      files: { 'src/math.ts': '…', 'src/index.ts': '…' },
      prompt: 'Search the codebase for where `mul` is defined and tell me the file and line.',
    },
    expected: { firstTool: 'grep' },
  },
  // … list-directory → expects 'ls'
]

export const toolSelectionEval = defineEval<ToolInput, CoderRun, ToolExpected, EvalEnv>({
  name: 'tool-selection',
  threshold: 0.6,
  data: CASES,
  task: (input) =>
    runCoder(input.files, input.prompt, {
      allowTools: READ_ONLY,
      stopAfterFirstToolTurn: true, // a case costs ~1 LLM call and can never mutate // [!code highlight]
    }),
  scorers: [
    predicate('first_tool_exact', ({ output, expected }) => output.tools[0] === expected.firstTool),
    predicate('used_expected_tool', ({ output, expected }) => output.tools.includes(expected.firstTool)),
  ],
})
```

Notice the scorer pairing: `first_tool_exact` is the strict claim, `used_expected_tool` is the consolation prize — an agent that gets there on the second call earns half the case's mean rather than zero. With a stochastic system you design score *surfaces*, not binary gates: the suite distinguishes "slightly suboptimal" from "lost the plot" instead of flattening both into FAIL. This suite is also the one to run obsessively while editing tool descriptions — three cases, three model calls, seconds of wall time, zero writes.

## Suite two: the full loop, judged three ways

The second suite removes the training wheels: a tiny repo, an edit instruction, the *unbounded* loop — the agent reads, edits, re-reads, finishes when it decides it's done. Then the workspace's target file comes back via `readback` and faces three scorers in ascending order of sophistication:

```ts title="packages/evals/src/suites/coderEdit.eval.ts"
const CASES = [
  {
    name: 'fix-clamp-bug',
    input: {
      files: {
        'src/clamp.ts':
          'export const clamp = (n: number, lo: number, hi: number): number =>\n' +
          '  n < lo ? lo : n > hi ? lo : n\n', // returns `lo` at the upper bound — the bug
      },
      target: 'src/clamp.ts',
      prompt: 'There is a bug in src/clamp.ts: when n is greater than hi it returns lo instead of hi. Fix the upper bound.',
    },
    expected: { mustContain: ['hi : n'], mustNotContain: ['n > hi ? lo'] },
  },
  // … add-function, rename-literal
]

export const coderEditEval = defineEval<EditInput, CoderRun, EditExpected, EvalEnv>({
  name: 'coder-edit',
  threshold: 0.6,
  data: CASES,
  task: (input) => runCoder(input.files, input.prompt, { readback: [input.target] }),
  scorers: [
    predicate('edit_applied', ({ input, output, expected }) => {
      const content = output.files[input.target] ?? ''
      return (
        expected.mustContain.every((s) => content.includes(s)) &&
        (expected.mustNotContain ?? []).every((s) => !content.includes(s))
      )
    }),
    includesAll('contains_expected', ({ input, output, expected }) => ({
      haystack: output.files[input.target] ?? '',
      needles: expected.mustContain,
    })),
    llmJudge('edit_correctness', ({ input, output }) => // [!code highlight]
      `A coding agent was asked:\n"${input.prompt}"\n\n` +
      `The file ${input.target} now contains:\n---\n${output.files[input.target] ?? '(missing)'}\n---\n\n` +
      'Rubric: score 1.0 if the change correctly and completely satisfies the request ' +
      'with no obvious breakage; 0.5 if partial; 0 if the file is unchanged, wrong, or broken.'),
  ],
})
```

The three scorers are a deliberate belt-braces-and-judge arrangement. `edit_applied` is the deterministic floor: the strings that must (and must not) appear in the file, no model involved, immune to judge moods. `contains_expected` softens the same check into partial credit. `edit_correctness` is the ceiling only a judge can reach — "no obvious breakage" is not a substring. The judge gets the actual post-run file contents, not the agent's claim about what it did; agents are at their least reliable when narrating their own success, and `readback` makes the narration irrelevant.

## Suite three: a regression test for a prompt bug

The third suite is my favorite argument for colocation, because it exists to pin a real bug. Some background in one clause: when a conversation grows long, [efferent](https://github.com/xandreeddev/efferent) folds it into a **handoff** — an LLM-written summary checkpointed into the store, which future turns load instead of the full history (the surrounding context-management design is a post of its own).

Early on, a handoff came back as: *"Let me know how you'd like to proceed!"* The summarizer had been fed the transcript as role-alternating chat messages, and a transcript shaped like a conversation structurally cues a model to *continue* it — produce the next assistant turn — rather than summarize it. The fix was to render the whole transcript as one flat user message, leaving the model only one reasonable move. The eval is what keeps the fix fixed:

```ts title="packages/evals/src/suites/handoff.eval.ts"
interface HandoffInput {
  readonly transcript: ReadonlyArray<AgentMessage> // the loop's own message type
  readonly goal: string
}
interface HandoffExpected {
  readonly mustMention: ReadonlyArray<string>
}

export const handoffEval = defineEval<HandoffInput, string, HandoffExpected, EvalEnv>({
  name: 'handoff',
  threshold: 0.6,
  data: CASES, // two seeded transcripts: an auth refactor, an N+1 perf hunt
  task: (input) =>
    Effect.gen(function* () {
      const store = yield* ConversationStore
      const id = yield* store.create()
      for (const m of input.transcript) yield* store.append(id, m) // seed the history
      yield* createHandoff(id) // the REAL use case the product runs // [!code highlight]
      const cp = yield* store.getLatestCheckpoint(id)
      return cp?.summary ?? '' // no checkpoint → '' → every scorer hands out 0
    }),
  scorers: [
    predicate('not_chat_reply', ({ output }) =>
      output.trim().length > 40 &&
      !/(let me know|how would you like|shall i\b|would you like me to)/i.test(output)),
    includesAll('captures_facts', ({ output, expected }) => ({
      haystack: output,
      needles: expected.mustMention, // e.g. ['JWT', 'refresh', 'OAuth', 'login']
    })),
    llmJudge('handoff_quality', ({ input, output }) =>
      `A coding session is being handed off to a fresh agent. The session goal was:\n"${input.goal}"\n\n` +
      `Candidate handoff summary:\n---\n${output || '(empty)'}\n---\n\n` +
      'Rubric: a good handoff states the Goal, the current State / what was already done, ' +
      'and concrete Next steps — and reads as a summary, NOT a reply that continues the conversation.'),
  ],
})
```

This task never touches a workspace — it seeds a fabricated transcript (user turns, assistant turns, tool calls and results) straight into the in-memory store, then runs the *production* `createHandoff` use case against it. The in-memory store's faithful checkpoint semantics earn their keep right here: `getLatestCheckpoint` behaves exactly as it does over SQL, so the eval exercises the real persistence path of the real use case.

The first scorer is the bug, immortalized as a regex: an output matching "let me know…" is a chat reply, score 0, regardless of how informative it was. `captures_facts` checks the summary retained the load-bearing nouns — including `OAuth`, which in the seeded transcript appears only in a *constraint the user added mid-session* ("don't touch the OAuth path"); a summary that drops it would send the next agent straight into the one thing forbidden. The judge grades the gestalt against a Goal/State/Next-steps rubric. Bug, fix, and the test that pins the fix — one repo, one commit, one review.

## Running it

```bash
bun run eval                        # all three suites
bun run eval handoff coder-edit     # a subset, by name
bun run eval tool-selection --json  # machine-readable report
```

A run prints a per-suite block — score per scorer per case, judge reasons as dimmed detail lines, a mean against the threshold:

```
▌ coder-edit  the requested edit actually lands in the target file
  ✓ add-function    edit_applied=1.00  contains_expected=1.00  edit_correctness=1.00  mean 1.00  41318ms
  ✓ rename-literal  edit_applied=1.00  contains_expected=1.00  edit_correctness=1.00  mean 1.00  24871ms
  ~ fix-clamp-bug   edit_applied=0.00  contains_expected=0.50  edit_correctness=0.50  mean 0.33  38112ms
      edit_correctness: the fix changes the upper bound but also reorders the lower comparison
  PASS  mean 0.78 (threshold 0.60) · 3 cases · 104.3s
```

The entry point has one more behavior worth copying — it's **key-gated**:

```ts title="packages/evals/src/run.ts"
const creds = yield* (yield* AuthStore).all
const haveKey = Object.keys(creds).length > 0
// no provider key → every suite reports `skipped` + a reason, and the process exits 0

// … after running the selected suites …
if (reports.some((r) => r.skipped !== true && !r.passed)) process.exitCode = 1 // [!code highlight]
```

No credentials in the environment? The suites skip *politely* — each report says why, the exit code stays 0. A contributor cloning the repo, or a fork PR with no access to secrets, sees a wired-but-skipped harness instead of a red build; nobody learns to ignore eval failures because half of them were missing-key noise. With keys present, the contract inverts: any non-skipped suite below threshold exits 1.

That exit-code-plus-`--json`-plus-clean-skip triple *is* the CI story — the runner is shaped to drop into a pipeline next to `typecheck` and `bun test`, gating behavior changes from the same checkout that gates code changes. Full honesty: the workflow file itself is still on [efferent](https://github.com/xandreeddev/efferent)'s deferred list. The harness was the hard part; the YAML is ten lines and a repository secret. And one layer below all of this, the framework itself is unit-tested with plain `bun test` — the captured-failure behavior, the in-memory store's checkpoint contract — with no model and no key. The judges are themselves judged, deterministically.

## What this costs

Colocated evals are the right default; they are not free, and the bills are worth itemizing.

**Evals spend real money.** Every `coder-edit` case is a full agent loop against a live provider — multiple model calls, plus a judge call to score it. A suite run costs actual cents and actual minutes, which is why cost control is welded into the harness rather than left to discipline: `stopAfterFirstToolTurn` bounds a case to one call, `concurrency: 1` is the default, suites run individually by name. Even so, these are not tests you run on every save. The honest cadence is *every behavior change* — prompt edits, tool-description edits, loop-policy changes — not every keystroke.

**The numbers wobble.** The same suite at the same commit can score 0.78 and then 0.71. That's not a flaw in the harness; it's the system under test. It's also why everything is thresholds and means instead of exact assertions, and why a single red run is a prompt to look, not proof of a regression. You're reading a trend through noise. Anyone promising deterministic evals of a non-deterministic system is selling something.

**Judges can be wrong.** `llmJudge` is a model grading a model, with documented failure modes — leniency toward plausible-sounding text chief among them. The mitigations here are real but partial: a conservative system prompt, fail-closed parsing, and — most importantly — never letting a judge stand alone. In `coder-edit` the judge sits on top of a deterministic floor; if `edit_applied` says the strings aren't in the file, no generous judge can drag the case to 1.0. A judge-only suite gating CI is a footgun; a judge bounded by predicates is a sensor.

**And the framework had to be written.** That's a cost too — eval frameworks are a classic yak. The plan, written down before any of this existed, was "Evalite until it actively hurts," and Evalite's `data → task → scorers` shape is visibly the skeleton this framework keeps — the lineage is right there in the type names. It hurt at three points simultaneously: a native `better-sqlite3` dependency that fought the runtime, coupling to the Vercel AI SDK while [efferent](https://github.com/xandreeddev/efferent) had moved to `@effect/ai`, and Node-vs-Bun runner APIs. Two pulls finished the argument, and both are really one pull — types: suites needed to *provide Layers* (the whole environment story above), and scorers wanted the typed `CoderRun` — tools in call order, files off disk — instead of strings. The replacement is about 340 lines across four files, unit-tested, with no persistence and no UI. Borrow a framework's shape; own its execution model only when the integration tax exceeds the rewrite. It eventually did. Yours may never — in which case, use Evalite.

## The riskiest diffs are prose

Step back far enough and this whole post is one claim: **behavior is part of the codebase, so it deserves the codebase's machinery.** We spent two decades building reflexes for risky code — tests next to the code, CI on every push, review on every diff — and then the riskiest diffs changed species. A one-line edit to a tool description can do more damage than a hundred-line refactor, and it sails through every reflex we built, because the reflexes watch code and the diff is prose.

The eval suite is how prose gets pulled back inside the machinery. Cases are the spec of the agent's judgment. The runner is a program in the same dependency graph as the loop it measures. The PR that softens a prompt carries the eval that documents what "working" now means — and the reviewer sees behavior and measurement move in the same diff, the way they'd see a function and its test.

None of that survives distance. Move the evals out of the repo and each piece decays on its own schedule: the prompt copy drifts in a week, the dashboard loses its audience in a month, the loop quietly stops being run. If your agent's behavior is defined in one repo and measured in another, one of those repos is lying to you — and you'll find out which one from a user.
