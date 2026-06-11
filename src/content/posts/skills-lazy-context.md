---
title: 'Pay for the index, not the book: extending an agent with markdown on disk'
description: 'Skills and instruction files make the filesystem a plugin system: cheap always-on index, bodies loaded on demand.'
pubDate: 2026-06-11
tags: [agents, ai, effect]
draft: true
---

Every team that runs a coding agent for more than a week ends up with the same backlog item: *teach it our stuff*. Our migrations work like this. Never hand-edit generated files. The release script has a verify step everyone forgets. None of this is in the model's weights, none of it is in the code in a form the model reliably trips over, and all of it is the difference between an agent that helps and an agent you babysit.

The options usually on offer are bad in three distinct ways:

1. **Fork the system prompt.** Now you maintain a prompt fork. Every upstream change is a merge conflict in a 4,000-word string, and the knowledge lives wherever the fork lives — not with the code it describes.
2. **Paste it into every session.** Groundhog day. The knowledge lives in someone's notes app, every teammate has a slightly different version, and the one day you skip the paste is the day the agent hand-edits a generated file.
3. **Wait for the plugin API.** It's coming, any quarter now. It will have a manifest format, a registration call, a versioning story, and a review process, and you will write TypeScript to tell a language model things you could have told it in English.

There's a fourth option, and it's almost embarrassingly simple: **markdown files in known places**. The agent discovers them, the filesystem is the registry, and git is the distribution mechanism. [efferent](https://github.com/xandreeddev/agent), the coding agent I'm building, ships this as its entire extension system — no plugin API, no manifest schema, no registration step. This post is about why that works, and about the one design decision that makes it scale: **pay tokens for an index up front; lazy-load the bodies on demand.**

## A plugin is a markdown file

Start with the unit. A **skill** is a markdown file with two parts: a tiny frontmatter header carrying a `name` and a one-line `description`, and a free-form body containing the actual procedure. Here's a real one — it lives at `.efferent/skills/commit-style.md` in [efferent](https://github.com/xandreeddev/agent)'s own repo, trimmed for the page:

```markdown
---
name: commit-style
description: How to write a commit message for this repo — lowercase verb-led
  title, prose body, HEREDOC commit. Read this whenever you are about to write
  or propose a commit message.
---

# Write a commit message for this repo

## Before composing

1. Run `git log --oneline -5` to refresh your memory of recent style.
2. Run `git status --short` and `git diff --stat HEAD` — the staged set
   must match what you intend to describe.

## Title

- Lowercase, action-verb-led: `pivot CLI from notes to no-compromise coding agent`.
- No Conventional Commits prefixes. Optional capability prefix (`tui:`)
  only when it genuinely helps locate the change.
- Aim for ≤ 72 chars. No emojis. No marketing.

## Body

- Blank line after the title, then prose explaining the *why* — the diff
  already shows the what.

## After committing

- Run `git status --short` to confirm clean. Run `git log -1` to eyeball
  the result. Do not push unless the user asked.
```

That's the whole format. No JSON schema, no SDK import, no build step. Anyone on the team who can write a runbook can write one — which is the point, because a skill *is* a runbook with a reader that never skims.

Inside the agent, a skill is barely more than a pointer. Look at what the entity type actually stores:

```ts title="packages/core/src/entities/Skill.ts"
export interface Skill {
  readonly name: string
  readonly description: string
  /** Absolute path to the source `.md` — read lazily by `read_skill`. */
  readonly sourcePath: string // [!code highlight]
}
```

The highlighted line is the design decision this post is named after. The body is **not a field**. After discovery, the agent holds a name, a one-liner, and a path. The expensive part of the file — the procedure itself — stays on disk until something deliberately goes and gets it. Everything else in this post falls out of that one omission.

## The index: what the model actually sees

So how does the model learn the skill exists? At startup, [efferent](https://github.com/xandreeddev/agent) injects the names and descriptions — only those — into the system prompt. The rendering is a dozen lines:

```ts title="packages/core/src/prompts/coder.ts"
const renderSkillsSection = (skills: ReadonlyArray<Skill>): string => {
  if (skills.length === 0) return ''
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n') // [!code highlight]
  return `
# Skills
The following named procedures are available. Each is a short markdown
document with steps for handling a specific kind of task. Read one with
'read_skill({ name })' when its name and description suggest it applies —
then follow the steps.

${lines}
`
}
```

In a workspace with a few skills, the rendered section the model reads on every turn looks like this:

```
# Skills
The following named procedures are available. Each is a short markdown
document with steps for handling a specific kind of task. Read one with
'read_skill({ name })' when its name and description suggest it applies —
then follow the steps.

- commit-style: How to write a commit message for this repo — lowercase
  verb-led title, prose body, HEREDOC commit. Read this whenever you are
  about to write or propose a commit message.
- db-migration: How to create, name, and verify a schema migration —
  includes the generator command and the rollback check.
- release: Cut a release — version bump, changelog, tag, and the exact
  publish commands in order.
```

That's an **index** in the most literal sense: a list of titles with enough description to decide whether to open the book. One detail worth noticing in the prompt assembly: the tool list's mention of `read_skill` is itself conditional — `skills.length > 0` or the line doesn't render. A workspace with no skills pays *zero* tokens for the mechanism. The feature has no idle cost.

## The arithmetic that makes lazy non-negotiable

Here's the part that looks like a micro-optimization and isn't. The system prompt is re-sent with **every request** — that's just how chat completions work. Prompt caching discounts the price of those repeated bytes (a post of its own), but it doesn't give you the window space back: every token of system prompt is a token of context the task can't use, on every single turn.

Now run the numbers on the eager design — the one where you'd inline skill bodies into the prompt, which is exactly what "fork the system prompt" does by hand. The trimmed `commit-style` above is one of the smaller skills you'd write; a real migrations runbook or release procedure lands around 2,000 tokens without trying. Ten skills:

```
eager:  prompt = base + body₁ + … + body₁₀     ≈ base + 20,000 tokens, every request
lazy:   prompt = base + index (10 lines)        ≈ base + ~400 tokens, every request
        + read_skill('db-migration') if needed  ≈ 2,000 tokens, once, only that session
```

Twenty thousand tokens of standing overhead, against a few hundred — and the eager version pays it on a session where you're asking the agent to rename a variable and nothing in the index applies at all. The lazy version pays for exactly the skills a session uses, exactly when it uses them, and the cost lands in conversation history where it belongs instead of in permanent prompt real estate. (How an agent budgets the whole window is a post of its own; this post is about the extension mechanism that respects the budget.)

The subtler half of the design is *who reads the index*. There's no keyword matcher, no embedding search, no "skill router" model deciding what's relevant. The index sits in front of the same model doing the task, and the model decides relevance the way it decides everything else — by reading. That's the right reader for the job: relevance here is a judgment about the *task*, and the model is the only component holding the task. When the user says "commit this," the model sees `commit-style: … Read this whenever you are about to write or propose a commit message` and the lookup is one obvious step. You get retrieval-flavored behavior with no retrieval infrastructure, because the corpus is small enough to put the entire table of contents in front of the judge.

## read_skill is a tool like any other

The fetch half of lazy loading is deliberately boring. `read_skill` is a tool definition sitting in the same toolkit as `read_file` and `grep`, declared with the same schema machinery:

```ts title="packages/core/src/usecases/codingToolkit.ts"
export const ReadSkill = Tool.make('read_skill', {
  description:
    'Read the full body of a named skill (a markdown procedure). Use when ' +
    'a skill listed in the system prompt applies to the current task — ' +
    'then follow the steps described in the body.',
  parameters: {
    name: Schema.String.annotations({
      description: 'Skill name, as listed in the Skills section.',
    }),
  },
  success: Schema.Struct({
    name: Schema.String,
    sourcePath: Schema.String,
    body: Schema.String,
  }),
  failure: Schema.Struct({ error: Schema.String, message: Schema.String }),
  failureMode: 'return', // [!code highlight]
})
```

This sameness is a feature, not a shrug. The model already knows how to call tools; pulling its own documentation is the identical motion to reading a file, so there's nothing new to teach and nothing new to go wrong. The handler is a map lookup and a disk read:

```ts title="packages/core/src/usecases/codingToolkit.ts"
read_skill: ({ name }) =>
  Effect.gen(function* () {
    const skill = skillByName.get(name)
    if (skill === undefined) {
      return yield* Effect.fail({
        error: 'UnknownSkill',
        message: `No skill named '${name}'. Available: ${
          [...skillByName.keys()].join(', ') || '(none)'
        }`,
      })
    }
    const read = yield* fs.read(skill.sourcePath) // [!code highlight]
    return {
      name: skill.name,
      sourcePath: skill.sourcePath,
      body: stripFrontmatter(read.content),
    }
  }),
```

Two details pay rent here. First, the failure: `failureMode: 'return'` means a bad name comes back to the model as *data* — and the message lists every available skill, so the model's next call is almost always correct. The error is written for the reader who caused it (designing errors for the model is a post of its own). Second, the highlighted line: the body is read **from disk at call time**, not from anything cached at startup. Edit a skill mid-session — tighten a step, fix a command — and the very next `read_skill` returns the new body. The index entry was parsed once at boot, but the knowledge itself is as fresh as your last save. Hot reload, implemented by not implementing caching.

## Discovery: the filesystem is the registry

Nothing registers a skill. [efferent](https://github.com/xandreeddev/agent) finds them at startup by walking a search path of `.efferent/skills/` directories, from the working directory up through every ancestor, ending at your home directory:

```ts title="packages/core/src/usecases/loadSkills.ts"
/** cwd/.efferent/skills, each ancestor up to root, then home (deduped). */
const skillSearchPath = (cwd: string, homeDir: string) => {
  const out: string[] = []
  let dir = cwd
  while (true) {
    out.push(resolve(dir, '.efferent/skills'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  out.push(resolve(homeDir, '.efferent/skills'))
  return out // earlier entries win — closer-to-cwd shadows farther // [!code highlight]
}
```

The walk order is the precedence rule. Skills are deduped by `name`, first occurrence wins, so a skill in the package you're standing in shadows a same-named one at the repo root, which shadows a same-named one in `~/.efferent/skills/`. That last directory is the personal tier: skills you carry between projects — your own commit habits, your own debugging rituals — without asking any repo to adopt them.

Just as deliberate is the type of the whole loader:

```ts
export const loadSkills = (
  cwd: string,
  homeDir: string,
): Effect.Effect<ReadonlyArray<Skill>, never, FileSystem> => // …
```

That `never` in the error channel is a policy, compiler-checked: a missing directory, an unreadable file, a typo'd frontmatter — every failure is caught and the file silently skipped. A broken skill degrades to an absent skill; it cannot take the agent down with it. Extension content authored by many hands should never be load-bearing for boot.

## Instruction files: the eager half

Skills are the lazy tier, and lazy has a hard limit: the model might not look. Some knowledge can't tolerate that — *never hand-edit generated files* is not advice to consult when relevant, it's a constraint that must be in force on every single turn. For that, [efferent](https://github.com/xandreeddev/agent) has a second discovery mechanism with the opposite loading policy: **instruction files**, eagerly inlined into every prompt.

The convention: a file named `AGENT.md` anywhere from the filesystem root down to your working directory, plus an `AGENT.local.md` sibling for guidance that's yours rather than the team's — same discovery, but you add it to `.gitignore` so your personal notes never land in a PR. Discovery walks the ancestor chain and renders root-most first, so the model reads broad guidance and then narrows: organization-level conventions, then the repo's, then the package's, then your home-directory file last.

Because this content rides along on every request, it's the one place the mechanism enforces a budget:

```ts title="packages/core/src/usecases/discoverInstructionFiles.ts"
/** Per-file char cap in the rendered prompt. */
export const MAX_INSTRUCTION_FILE_CHARS = 4_000
/** Total char budget for the whole `# Instructions` section. */
export const MAX_TOTAL_INSTRUCTION_CHARS = 12_000 // [!code highlight]

const INSTRUCTION_FILE_NAMES = ['AGENT.md', 'AGENT.local.md'] as const

export const discoverInstructionFiles = (
  cwd: string,
  homeDir: string,
): Effect.Effect<ReadonlyArray<InstructionFile>, never, FileSystem> =>
  Effect.gen(function* () {
    // walk root → … → cwd → home; try both names in each directory;
    // dedupe by normalized content; skip unreadable files — same `never`
    // policy as skills: a broken AGENT.md must not break the agent
    // …
  })
```

Four thousand characters per file, twelve thousand for the whole section — roughly 1k and 3k tokens. A file over its cap is cut with a visible `[truncated]` marker; files past the total budget surface as a one-line *omitted* notice instead of silently vanishing, so the model knows its picture is incomplete rather than believing a partial one. Each file renders under a header carrying its scope — `## AGENT.md (scope: /repo/packages/core)` — so guidance is legible as workspace-wide versus package-local versus personal. And where skills dedupe by *name* (shadowing — one wins), instruction files dedupe by *normalized content* (stacking — all distinct files render). Skills are alternatives; constraints accumulate.

The two mechanisms together give you the placement rule, and it's worth stating as a rule because every team relearns it the slow way: **if it must be true on every task, it goes in AGENT.md; if it's what to do for one kind of task, it's a skill.** Constraints are eager because they can't depend on the model's judgment to be loaded. Procedures are lazy because most tasks don't need most procedures. When you find a five-step process inside an AGENT.md, it's a skill paying eager rent; when you find "never force-push" inside a skill, it's a constraint gambling on relevance.

## SCOPE.md: instructions with a postcode

There's a third file in the family, for knowledge that's true of a *place* rather than a project: `SCOPE.md`. Drop one in a directory and its body becomes ambient context for any agent working there. [efferent](https://github.com/xandreeddev/agent) discovers these per-folder:

```ts title="packages/core/src/usecases/discoverScopeTree.ts"
export const getScopePromptBody = (
  folder: string,
): Effect.Effect<string | undefined, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const read = yield* fs
      .read(resolve(folder, 'SCOPE.md'))
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
    if (read === undefined) return undefined
    const parsed = parseScopeFile(read.content)
    const body = parsed !== undefined ? parsed.body : read.content
    return body.trim().length > 0 ? body : undefined // [!code highlight]
  })
```

A `SCOPE.md` at the workspace root feeds the main agent's prompt under a `# Project scope` heading. One in a subdirectory is injected verbatim — under `## Scope-specific instructions` — into any sub-agent dispatched to work in that folder, which is where this mechanism earns its keep in [efferent](https://github.com/xandreeddev/agent)'s folder-sandboxed sub-agent system (a post of its own). The frontmatter follows the same `name` + `description` convention as skills, parsed by the same shape of forgiving parser, with the same silent-skip policy for malformed files. One family of conventions, three loading policies: skills load on demand, AGENT.md loads always, SCOPE.md loads *when you're standing there*.

## Writing skills that earn their line

The mechanism is the easy half. After writing and rewriting [efferent](https://github.com/xandreeddev/agent)'s own skills, here's what separates ones that fire from ones that rot.

**Name the task, not the topic.** `commit-style`, `db-migration`, `release` — a skill is the answer to "how do I do X here," so its name should be an X. A skill named `git` or `database` is a filing cabinet, not a procedure, and the model has no moment at which it obviously applies.

**The description is the retrieval key — include the trigger.** The model decides whether to open the book from the one-liner alone, so write the one-liner for that decision. The real `commit-style` description ends with *"Read this whenever you are about to write or propose a commit message."* That clause isn't decoration; it's the condition-action rule that makes the lookup reliable. A description that just summarizes the topic makes the model infer when it's relevant; a description that states the trigger makes it match.

**Put the commands in.** The body should contain the exact incantations — `git log --oneline -5`, the real generator command with its real flags — not descriptions of them. The model executes what it reads; a skill that says "run the usual checks" outsources the hard part back to guessing. The best skills end with a verification step, because "how do I know it worked" is part of the procedure, and a model that reads it will actually run it.

**Anti-pattern: the novel.** Lazy loading makes a long skill free *until it's read* — then it's five thousand tokens of context the rest of the session drags around. If a skill covers three tasks, it's three skills sharing a file; split them so a session pays for the one it needs.

**Anti-pattern: duplicating the README.** The agent can read your README; it has `read_file`. A skill that restates the architecture overview costs index space to make existing knowledge slightly more reachable. A skill should be the *distilled procedure* — the part that took a human three attempts to learn — not prose the repo already carries.

**Anti-pattern: the grab-bag.** A skill named `project-notes` described as "useful things to know" is the worst of both worlds: no trigger, so it rarely fires; broad content, so when it does fire most of it is noise. If the content is always true, it's AGENT.md. If it's task-shaped, it's a named skill. If it's neither, it's probably not worth a line in the index.

## What this doesn't give you

The honest section. Markdown-as-plugin has real costs, and most of them are the flip side of its virtues.

**There is no compiler for prose.** When the migration generator gains a flag, every skill mentioning the old invocation is silently wrong. Code that drifts fails a build; a skill that drifts fails a *session*, three weeks later, in a way that looks like the model being dumb. The only mitigations are process ones: review skills in PRs like the code they describe, and treat "the agent followed the skill and it didn't work" as a bug report against the skill. You can go further and eval that the model reads the right skill at the right moment (colocated evals are a post of its own), but nothing structural stops the rot the way a type does.

**Shadowing is silent.** First-by-name wins across the search path, and nothing warns on a collision. That's the right default — a project skill *should* beat your personal one without ceremony — but it means a teammate adding `commit-style` to a nested package can quietly disable the repo-root version for anyone working in that folder, and no log line says so.

**The index still costs, linearly.** Forty-odd tokens per skill, every request, forever. Ten skills round to free; a hundred are multiple thousands of tokens of permanent overhead and an index too long to reliably read — at which point you're rediscovering retrieval and need tiers, curation, or search. Lazy loading flattens the cost of *bodies*; nothing flattens the cost of the catalog except keeping it short. The mechanism does not curate for you.

**Discoverability cuts both ways.** "What does the agent know right now?" has no obvious answer when knowledge is scattered across three filename conventions and an ancestor walk. [efferent](https://github.com/xandreeddev/agent)'s TUI answers it directly — the activity pane's workspace section lists the discovered skills and instruction files for the session — and some equivalent is genuinely necessary, because the same forgiveness that makes a broken skill harmless makes it *invisible*: a typo'd frontmatter key doesn't error, it just quietly removes the skill from existence.

**And the model can simply not look.** The whole lazy tier rides on the model judging relevance from one line. Mostly it does — the trigger-clause pattern makes it boringly reliable — but "mostly" is the honest word, and when it misses, the failure is indistinguishable from the skill not existing. The eager tier exists precisely because some knowledge can't accept that gamble.

## The plugin API you already have

Step back from the mechanics and look at what this design didn't have to build. Plugin systems live or die on the boring parts — distribution, versioning, review, rollback — and every bespoke plugin API rebuilds all four, badly, with a manifest format nobody loves. Files in a repo inherit all four from git, in their best available implementations. A skill is reviewed in the same PR as the code it describes. It ships to every teammate on `git pull`. It's versioned with the system it documents — check out last month's commit and the agent's knowledge rolls back with the code, which no plugin registry on earth gets right. A skill on a feature branch *ships with the branch*.

And the extension language is the one your whole team already writes. Nobody files a ticket to "integrate with the agent SDK"; they write down the runbook they already had in their head, in the format they'd have used anyway, and the agent starts following it that afternoon. The entire integration surface is two conventions — a folder name and a frontmatter header — plus one tool the model already knows how to call.

The deeper shift is what happens to documentation. Docs have always been a description of the system, aspirationally accurate, structurally ignorable. Put a tireless reader in the loop and a known place on disk, and a runbook stops describing the procedure — it *is* the procedure, executed every time the trigger fires, never skimmed, never "I'll read it later." The index-plus-lazy-body split is just the engineering that makes this affordable at context-window prices: a few hundred tokens to know what's knowable, full price only for what the task actually needs.

The whole feature is a few hundred lines: a walk, a parser, a prompt section, one tool. Option three — wait for the plugin API — was never the real choice. The filesystem was the plugin system all along; the only new part is an agent that reads it.
