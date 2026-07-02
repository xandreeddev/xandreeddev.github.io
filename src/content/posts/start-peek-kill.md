---
title: 'A dev server is not a slow command'
description: 'Long-running work is a lifecycle problem, not a timeout problem — background processes and tmux sessions as start/peek/kill moves, on a foundation that kills the whole process group.'
pubDate: 2026-09-29
tags: [agents, effect]
draft: true
---

There's a turn in one of [efferent](https://github.com/xandreeddev/efferent)'s research transcripts that ran for forty-one minutes. The agent wanted to observe a TUI live — fair, that was the task — and the only shell it had was one-shot: run a command, block, collect the pipes, return. So it improvised. It wrapped the TUI in `script -q -c '…'` to fake a terminal, inside a blocking call. The timeout fired and killed the direct child; the turn hung anyway, because `script`'s reparented grandchild still held the output pipe, and the runtime was blocked reading a pipe that would never close. Forty-one minutes of a model doing the only thing its toolkit allowed, which was the wrong thing, done badly.

The instinct is to patch that with a bigger timeout, or a smaller one, or a cleverer one. The diagnosis I ended up with is that timeouts weren't the problem at all. A foreground shell tool can express exactly one lifecycle: *start, block until done, get everything back at once.* A dev server doesn't have that lifecycle. Neither does a file watcher, a long build you want to work alongside, or a REPL. Their shape is: *start it, go do something else, peek at it, act on what you saw, eventually kill it* — and each of those is a separate decision the model makes on a separate turn. **Long-running work is a lifecycle problem, not a timeout problem**, and the fix was to give the agent the lifecycle as verbs: three tools for processes that outlive a call, five for processes that need a real terminal. This post is both halves, plus the two questions they forced — what the approval gate does about them, and what actually enters the transcript.

## First, a kill that means it

Neither half is trustworthy until "kill" reaches everything. The forty-one-minute hang had two causes stacked: the timeout killed only the direct child, and the call settled on pipe EOF. Fixing that is the foundation both features stand on:

```ts title="packages/sdk-adapters/src/shell/local.ts"
/**
 * Signal an entire process GROUP. With `detached: true` the child is its own
 * group leader (pgid === pid), so `process.kill(-pid, …)` reaches the child AND
 * every descendant — `script`/`setsid`/reparented orphans included. Killing only
 * the direct child (the old bug) left grandchildren alive holding the pipe fds.
 */
const killGroup = (pid: number | undefined, signal: 'SIGTERM' | 'SIGKILL'): void => {
  if (pid === undefined) return
  try { process.kill(-pid, signal) } catch { /* group already gone */ }
}
```

Every spawn — foreground or background — is `detached: true`, so each command is its own process group and the negative-pid kill reaches the whole tree: SIGTERM first, SIGKILL a grace second later if the group won't die. And the foreground call now settles on the shell process's **exit** plus a bounded 200 ms drain grace, never on pipe EOF — an orphan holding a file descriptor can delay the result by a fifth of a second, not forty minutes. None of this is visible in any tool schema, but it's what makes the schemas honest: `kill_bash` promises to terminate "a background process (and its whole process group)," and that clause is only true because of the minus sign in `killGroup`.

## Start, peek, kill

The background half is one flag and two tools. `Bash` grew `run_in_background`; its description does the routing — [the schema is the only documentation the model ever reads](/posts/tool-schemas-prompt-surface/), so the lifecycle guidance lives there, verbatim:

> Default timeout is 5 minutes (override with `timeout`). For a command that should OUTLIVE this call — a dev server, a file watcher, a long build you want to keep working alongside — set `run_in_background: true`: it returns a `processId` immediately, then read its output with `bash_output` and stop it with `kill_bash`. Do NOT launch an interactive TUI here; use a terminal session (`session_start`) instead.

Three moves in three sentences: when to leave the foreground, how the three tools compose, and where the boundary with the *other* new capability sits — the exact confusion that produced the `script -q` hack, addressed at the moment of tool selection. The handler's background branch is small; the interesting choice is what it *doesn't* do:

```ts title="packages/sdk-core/src/usecases/codingToolkit.ts"
// Background: fork-and-return immediately. No writeGate (it doesn't
// hold the turn), tagged with the conversation for teardown scoping.
if (run_in_background === true) {
  const { id } = yield* shell.spawnBackground({
    command,
    cwd: rootDir,
    conversationId: rc.rootConversationId, // [!code highlight]
  })
  return { processId: id, running: true, /* zeroed exec fields */ }
}
```

The process lands in a registry keyed by that id, its stdout/stderr appended to a rolling per-process buffer capped at 256 KB — oldest chunks dropped so a chatty long-runner can't grow unbounded. `bash_output` reads it incrementally: every read returns an opaque `cursor`, and passing it back returns only what's new since, plus `running` and the exit code once there is one. `kill_bash` is `killGroup` with a tool name.

Now the design question underneath, because it's the one that generalizes: **what enters the transcript?** A foreground `bun test` enters as one block — up to 32 KB of stdout, after the turn spent its whole wait blocked. A background dev server enters as a `processId` — a dozen tokens — and after that, *only what the model asks for, when it asks*: each `bash_output` call appends an increment, sized by the cursor, timed by the model's own judgment about when checking is worth a tool call. The transcript cost of a two-hour server isn't two hours of log spew; it's the polls the model actually made. The human gets a separate channel: each output chunk also fires a `bg_output` event, and the TUI shows the latest non-empty line in the rail — liveness for the person watching, zero tokens for the model. Two audiences, two channels, neither paying for the other's.

## A REPL is not a pipe

Background processes still speak stdin/stdout. A TUI, a REPL, `ssh`, anything that probes for a terminal — those need a TTY, screen state, and keystrokes, which is a genuinely different capability, so it got a different port:

```ts title="packages/sdk-core/src/ports/TerminalSession.ts"
export class TerminalSession extends Context.Tag('@xandreed/sdk-core/TerminalSession')<
  TerminalSession,
  {
    readonly available: Effect.Effect<boolean> // feature-detect: is tmux on PATH?
    readonly start: (input: StartInput) => Effect.Effect<{ sessionId: string }, TerminalSessionError>
    readonly send: (input: SendInput) => Effect.Effect<void, TerminalSessionError>
    readonly read: (input: ReadInput) => Effect.Effect<{ screen: string }, TerminalSessionError>
    readonly kill: (sessionId: string) => Effect.Effect<{ killed: boolean }>
    readonly list: () => Effect.Effect<ReadonlyArray<{ sessionId: string }>>
    readonly killAll: (conversationId?: string) => Effect.Effect<void>
  }
>() {}
```

Five of those become tools — `session_start`, `session_send`, `session_read`, `session_kill`, `session_list` — and the adapter behind them is tmux. Not a homegrown pty pool, and the reason is what "peek" means for a full-screen program. A pty gives you the *byte stream*: every escape sequence, cursor jump, and redraw the program ever emitted. To answer the question the model actually has — *what does the screen say right now?* — you'd have to maintain a terminal emulator over that stream yourself. tmux **is** that emulator, already persistent, already debugged, with a CLI query surface: `capture-pane -p` returns the rendered screen as plain text, `send-keys` already encodes `C-c` and `Enter`, and detached sessions survive between tool calls by design. The whole adapter — sessions map, feature detection, every operation shelling out through the same `Shell` port — is under 150 lines, because the hard part ships with every Linux distribution.

It also comes with a feature I didn't have to build: co-presence. Session ids are namespaced — `efferent-<conversation>-<n>` — and the tool description advertises it: "A human can `tmux attach -t <sessionId>` to watch the same pane." The agent drives a REPL; you attach and watch the same live screen it's reading, or type into it yourself. Try retrofitting that onto a pty pool.

The port/adapter split pays off exactly where [the approval post](/posts/bash-approval-rules/)'s `ApprovalAllowAllLive` did: environments without tmux don't get a crash or a mock, they get a layer. Evals and CI run `NoopTerminalSessionLive` — `available` is false, every op fails with a model-readable "interactive terminal sessions are unavailable in this environment," `kill` reports `killed: false`, `list` is empty. One `Layer.succeed`, and headless mode never knows tmux exists.

## The same gate, in front of both

Both features are arbitrary code execution, so both stand behind the [approval ladder](/posts/bash-approval-rules/). A background command is judged **before** the fork — the same `approval.request` with the same `bashRuleKey`, so `bun run dev` in the background descends the same rules → session rules → judge → modal cascade as any foreground command, and a denial comes back as the same teachable failure. `session_start` with a `command` is gated identically: launching a program in a pane is execution, whoever renders it.

And here is the honest edge: **the gate sits at the mouth of the session, not inside it.** `session_start` with *no* command opens a plain shell without a prompt, and `session_send` — the tool that types into the pane — passes through no approval at all. Once a session exists, keystrokes are ungated; an approved `psql` pane accepts whatever the model types. Per-keystroke approval of an interactive session would be prompt fatigue at its most absurd (approve `j`, approve `k`, approve `Enter`…), so the launch is the decision point — but that makes a terminal session a coarser grant than a bash command, closer in spirit to a folder grant than to a `cmd:` rule, and the gate's ledger doesn't yet have a vocabulary for saying so. Both kinds of long-lived thing are at least tagged with the conversation that made them, and the app's exit finalizer group-kills every background process and every tmux session on the way out — detached from the *turn* on purpose, never allowed to outlive the *app*.

## The eval the coverage map demanded

The [colocated-evals argument](/posts/colocated-evals/) says behavior gets regression tests in the same repo as the prompts. These tools shipped violating it — adapter unit tests, zero behavioral coverage — and the thing that caught the violation is itself worth showing. The eval package keeps a coverage map: every tool in the toolkit, mapped to the suites that behaviorally exercise it, with a test that fails if a tool exists the map has never heard of:

```ts title="packages/evals/src/coverage.ts"
export const TOOL_COVERAGE: Record<string, ReadonlyArray<string>> = {
  Bash: ['whole-task', 'repo-tasks', 'background-shell'],
  bash_output: ['background-shell'],
  kill_bash: ['background-shell'],
  // tmux interactive sessions — the eval env has no tmux (NoopTerminalSession),
  // so these are deliberately uncovered here; their adapter has unit tests.
  session_start: [], // [!code highlight]
  // …
}
```

An empty array means "considered, deliberately not covered" — a documented gap, not an oversight; a *missing* entry fails the build. The map is what turned "we never evaled the background tools" from a silent fact into a red test, and the `background-shell` suite is what closed it. It's small and deliberately judge-free:

```ts title="packages/evals/src/suites/backgroundShell.eval.ts"
{
  name: 'background-then-read',
  input: {
    prompt:
      "Start the command `bash -c 'sleep 2; echo RESULT=42'` as a BACKGROUND process " +
      '(do not block on it), then read its output once it finishes and tell me the value it printed.',
  },
  expected: { requiredTool: 'bash_output', mustContain: '42' },
},
// …scored on tool usage + outcome, deterministically:
scorers: [
  predicate('used_required_tool', ({ output, expected }) =>
    output.tools.includes(expected.requiredTool)),
  predicate('outcome', ({ output, expected }) =>
    output.finalText.includes(expected.mustContain)),
]
```

Note what's being scored. Not "did the command run" — a model that blocks on `sleep 2` in the foreground gets the right answer too. The predicate demands the *route*: `bash_output` in the tool trace, which can only appear if the model actually started the process in the background. A second case starts `sleep 60` and requires `kill_bash`. Capabilities like this fail quietly — the model just doesn't reach for the flag, tasks still mostly succeed, and nothing tells you the feature you shipped is decoration. A deterministic usage predicate is the cheapest possible alarm for that, and its score is honest signal, not judge noise.

## What this doesn't do yet

**Polling is the model's job, and forgetting is silent.** Nothing pushes background output into the model's context — the `bg_output` rail line is for the human. An agent that starts a server and never calls `bash_output` again has a running process and no knowledge of it; there's no "notify the model on exit" hook yet.

**The buffer forgets the beginning.** Past 256 KB the oldest chunks are gone. For a dev server that's fine — you want recent output. For a long build whose *first* error scrolled away two hundred kilobytes ago, an early poll is the only way to have caught it.

**Sessions are eval-blind.** The coverage map documents the `session_*` gap rather than closing it; the eval sandbox has no tmux, by design. The adapter has unit tests asserting the tmux argv, which verifies my code and says nothing about whether models drive a REPL well.

**`session_read` is a screen scrape.** The model reads rendered text and infers state — no structured "the REPL is idle" signal, no exit code for a pane. That's the price of the tmux shortcut, and mostly it's the right price; but a model deciding "is this program done?" from a still screen is doing OCR-grade inference.

**And the send gate, from above:** keystrokes into an approved pane are unjudged. Mouth of the session, not per key.

## Lifecycle, not timeout

The foreground timeout is still there — five minutes now, up from sixty seconds, because installs and test suites earned it. But it no longer defines the ceiling of what the agent can do; it defines the *category boundary*. Fits in five minutes and you want everything at once: foreground, one block in the transcript. Outlives the call: background, a `processId`, and increments on demand. Needs a screen: a session, keystrokes and scrapes. The model picks among lifecycles instead of stretching one until it snaps — and the transcript records decisions about attention (poll now? peek at the pane? kill it?) instead of forty-one minutes of a turn holding its breath.

The part I'd generalize: when an agent misuses a capability for a long time, look for the lifecycle it couldn't express. The `script -q` hack wasn't a dumb model — it was a correct read of an impoverished toolkit, the only shape available bent around a job it didn't fit. The fix wasn't intelligence. It was three more verbs.
