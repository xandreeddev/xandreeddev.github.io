---
title: 'Your agent is a protocol, not an app'
description: 'One loop, one typed event stream, four renderers — why headless modes fall out of the architecture for free.'
pubDate: 2026-07-22
tags: [agents, effect, typescript]
series:
  name: 'Building a coding agent'
  order: 9
draft: true
---

There's a one-question architecture review for any coding agent, and you don't need to read its source to run it: **can a program use this thing, or only a person?**

Pipe a prompt into it from a shell script. Run it in CI. Drive it from an editor plugin. If the answer to all three is "well… it opens a terminal UI," you're looking at an app that happens to contain an agent. The loop and the interface grew up together until nobody can say where one ends, and now every consumer that isn't a human at a terminal is locked out — permanently, because the assumptions are load-bearing.

The alternative is to treat the agent as a **protocol**: the loop's only output is a typed stream of events, and every interface — terminal UI, one-shot print, JSON lines, JSON-RPC — is a small program that consumes that stream and renders it somehow. New consumer, new renderer, loop untouched.

This post is the case for that inversion, with receipts from [efferent](https://github.com/xandreeddev/efferent), the coding agent I'm building on Effect. Its terminal UI is the client with all the screenshots. It is also, architecturally, just client number one of four.

## The trap: the UI leaks into the loop

Nobody designs the trap; it accretes. You're building an agent, you're testing it in a terminal, and the shortest path to every feature runs through that terminal. A sketch of where six weeks of shortest paths land:

```ts
async function agentLoop(prompt: string) {
  while (true) {
    const step = await llm.generate(messages)
    process.stdout.write(render(step.text))      // rendering, mid-loop
    for (const call of step.toolCalls) {
      if (call.toolName === 'bash') {
        const a = await rl.question(`run \`${call.args.command}\`? [y/n] `)
        if (a !== 'y') continue                  // a human, assumed present
      }
      results.push(await runTool(call))
      spinner.succeed(call.toolName)             // more rendering
    }
    if (step.finishReason === 'stop') return
  }
}
```

Each of those lines quietly forecloses a category of consumer:

- **`process.stdout.write(render(…))` inside the loop** means output is presentation, interleaved with execution. You can't pipe this program anywhere — the final answer is shuffled into spinners and color codes, and there's no machine-readable trace of what happened.
- **`rl.question(…)` mid-run** assumes a human within arm's reach of the keyboard. In CI there isn't one. The job doesn't fail — it *hangs*, silently, until the runner times it out forty minutes later.
- **Rendering decisions living next to loop logic** means every new surface — a web view, an editor panel, a plain log — is surgery on the loop itself, with all the regression risk that implies.

Call the property we lost **headless**: the ability to run with no human and no terminal attached. The instinct is to retrofit it — add a `--quiet` flag, an `--auto-approve` flag, a `--json` flag — but flags can only *subtract* UI from a loop that's made of UI. What's needed is an inversion: the loop produces **data**, always, and presentation happens somewhere else, optionally.

## The inversion: the events are the product

In [efferent](https://github.com/xandreeddev/efferent), the agent loop's entire observable output is a value of one union type. This file is the contract every interface is built against — worth reading in full, because everything else in this post is a consumer of it:

```ts title="packages/cli/src/events.ts"
export type AgentEvent = // [!code highlight]
  // internal drain sentinel — never serialized (more on this below)
  | { readonly type: 'flush' }
  | { readonly type: 'turn_start'; readonly turnIndex: number }
  | {
      readonly type: 'assistant_message'
      readonly turnIndex: number
      readonly text: string
      readonly reasoning?: string
      readonly usage?: TokenUsage
      readonly nodeId?: string // set when a sub-agent said it
    }
  | {
      readonly type: 'tool_call_start'
      readonly turnIndex: number
      readonly id: string // provider call id — pairs start ↔ end exactly
      readonly toolName: string
      readonly args: unknown
      readonly nodeId?: string
    }
  | {
      readonly type: 'tool_call_end'
      readonly turnIndex: number
      readonly id: string
      readonly toolName: string
      readonly ok: boolean
      readonly result: unknown
      readonly nodeId?: string
    }
  | {
      readonly type: 'subagent_start'
      readonly name: string
      readonly task: string
      readonly nodeId?: string
      readonly parentNodeId?: string // nests this run under its parent
    }
  | {
      readonly type: 'subagent_end'
      readonly name: string
      readonly ok: boolean
      readonly summary: string
      readonly filesChanged: ReadonlyArray<string>
      readonly nodeId?: string
      readonly usage?: TokenUsage // …
    }
  | { readonly type: 'skill_load'; readonly name: string }
  | {
      readonly type: 'helper_usage' // a fast/cheap-tier call ran inside the loop
      readonly role: 'fast' | 'cheap'
      readonly usage: TokenUsage
    }
  | {
      readonly type: 'agent_end'
      readonly finalText: string
      readonly messages: ReadonlyArray<AgentMessage>
    }
  | { readonly type: 'error'; readonly message: string }
```

Read it as a narration grammar. A run is a sequence of turns (`turn_start`); each turn produces prose (`assistant_message` — with the model's reasoning and token usage when available) and tool activity (`tool_call_start` / `tool_call_end`, paired by the provider's call id, because two same-named calls in one turn share a name but not an id). Sub-agents open and close their own bracketed stories (`subagent_start` / `subagent_end`, with a summary and the files they changed), nested via `parentNodeId` when a sub-agent spawns its own. Skills loading and helper-tier LLM calls — the cheap background work, like compression digests — get their own lines so a consumer can keep an honest spend ledger. And `agent_end` closes the run with the final text plus the full message transcript.

Two design choices in that union do most of the work. First, **everything is data, nothing is presentation** — no color, no layout, no strings pre-formatted for a terminal. `args` and `result` are `unknown` because they're tool-shaped, not display-shaped. Second, the events carry enough identity (`turnIndex`, call ids, `nodeId`) that a consumer can reconstruct *structure* — which call belongs to which turn belongs to which sub-agent — instead of just receiving a flat log.

Once the vocabulary exists, every interface becomes a **fold**: a function that consumes the event sequence one element at a time and accumulates something — pixels, lines of JSON, a data structure, a verdict. That word is the post's whole thesis, so to be precise: the loop produces `AgentEvent`s; a *mode* is the fold you chose to run over them.

### How events leave the loop without the loop knowing

The loop itself never touches stdout, a socket, or a screen. It accepts an optional bag of **hooks** — callbacks like `onTurnStart`, `onAssistantMessage`, `onBeforeToolCall`, `onAgentEnd`, each an Effect — and invokes them at the corresponding moments. (One hook, `onBeforeToolCall`, returns a decision and can block a call; the rest are pure observation.) The hook surface lives in the core package, which has no idea what a terminal is.

The CLI wires those hooks to a queue, and this adapter is mechanical — one `Queue.offer` per hook:

```ts title="packages/cli/src/events.ts"
export const makeEventHooks = <R = never>(
  queue: Queue.Queue<AgentEvent>, // [!code highlight]
): AgentHooks<R> => ({
  onTurnStart: (event) =>
    Queue.offer(queue, { type: 'turn_start', turnIndex: event.turnIndex }),
  onAfterToolCall: (event) =>
    Queue.offer(queue, {
      type: 'tool_call_end',
      turnIndex: event.turnIndex,
      id: event.toolCallId,
      toolName: event.toolName,
      ok: event.ok,
      result: event.result,
    }),
  // … one offer per hook, same shape throughout
})
```

A queue is the right seam because the producer and the consumer are different concerns running on different fibers: hooks fire from wherever the loop happens to be — possibly four tool handlers deep, possibly inside a parallel sub-agent — and offering onto the queue costs them nothing. One consumer fiber drains it at whatever pace rendering takes. The loop cannot tell whether anything is listening, which is exactly the property that makes four clients possible.

### The flush sentinel, or: how a one-shot mode knows it's done

Decoupling creates one genuinely subtle problem, and [efferent](https://github.com/xandreeddev/efferent) solves it with the union's odd member out: `flush`.

A one-shot mode runs the agent, renders the events, prints a result, and exits. But "the run completed" and "every event has been rendered" are two different moments — when `runAgent` returns, the last few events may still be sitting in the queue with the consumer fiber mid-drain. Exit now and you truncate output. The folk fixes are all bad: `sleep(50)` is the same race wearing a blindfold; interrupting the consumer can kill it halfway through writing a line.

The deterministic fix is a **sentinel** — a marker value with no meaning except "you have reached the end." After the run completes, the mode offers `{ type: 'flush' }`; since nothing else produces anymore, it is *strictly* the last element. The consumer returns when it takes it, and the mode joins the consumer fiber:

```ts title="packages/cli/src/modes/json.ts"
// The run is done — nothing else produces, so the sentinel is strictly last.
yield* Queue.offer(queue, { type: 'flush' }) // [!code highlight]
yield* Fiber.join(consumer)
```

`Fiber.join` waits for the consumer to finish — so by the next line, every event that ever entered the queue has been fully rendered. No sleeps, no races, no half-written lines. The sentinel is internal plumbing: every consumer checks for it first and exits, and it is never serialized to stdout, stderr, or an RPC notification. A consumer of the *protocol* never sees it; only consumers of the *queue* do.

That's the entire substrate: a vocabulary, a queue, a sentinel. Now the four clients.

## Client one: the TUI

The default when you run `efferent` in an interactive terminal is the full TUI — OpenTUI's native renderer driving SolidJS signals, with foldable turns, a live activity tree, syntax-highlighted diffs, and the approval modals. As a consumer it's the deepest fold by far: the same queue drains into fine-grained signals and the view updates reactively. It's also the only client that costs real money to load, so the composition root imports it lazily — the native FFI renderer is touched only on this path, and `tui.ts` at the mode seam is 19 lines of input type. How that client works inside is a post of its own; for this post the load-bearing fact is that the TUI holds no privileged position. It subscribes to the same events as everything below.

## Client two: print mode — the agent as a shell command

```bash
efferent "summarise the public API of packages/core"   # answer on stdout
echo 'list every TODO under src/ with file paths' | efferent
efferent -p --allow-bash "fix the failing rpc test" > report.md
```

Print mode is the agent as a well-behaved Unix citizen: run once, do the work, print the answer, exit. The discipline that makes it composable is the stream split — **stdout carries exactly one thing, the final text**; the running tool log goes to stderr, where a human can glance at progress without polluting whatever stdout is piped into. The fold is a switch statement that renders three event types and deliberately drops the rest:

```ts title="packages/cli/src/modes/print.ts"
const consumeEvents = (queue: Queue.Queue<AgentEvent>) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue)
      if (event.type === 'flush') return // drain sentinel — never rendered
      switch (event.type) {
        case 'tool_call_start':
          yield* writeStderr(`[tool] ${event.toolName} ${renderArgs(event.args)}`) // [!code highlight]
          break
        case 'tool_call_end':
          yield* writeStderr(event.ok ? '       done' : '       failed')
          break
        case 'error':
          yield* writeStderr(`[error] ${event.message}`)
          break
        default:
          break // a renderer chooses what to drop; the loop doesn't decide for it
      }
    }
  })
```

After the sentinel-and-join drain, one line: `process.stdout.write(result.finalText + '\n')`. That `default: break` is quietly the point — the loop emits everything, and *ignoring* events is a renderer's prerogative, made locally, with no flag threaded back into the loop.

Print is also where mode *selection* earns its keep. You never asked for it in those examples — the dispatcher inferred it:

```ts title="packages/cli/src/main.ts"
const resolveMode = (modeFlag, printFlag, hasPromptArg): Mode => {
  if (modeFlag !== 'auto') return modeFlag // explicit always wins
  if (printFlag) return 'print'
  if (hasPromptArg) return 'print'
  return process.stdout.isTTY ? 'tui' : 'print' // [!code highlight]
}
```

A prompt argument means you want an answer, not a session. Piped stdin (when there's no prompt argument) is *swallowed as the prompt* — except in RPC mode, which needs stdin for its protocol, and the TUI, which needs it for keystrokes. And the highlighted line is the part most terminal apps get wrong: if stdout isn't a TTY — because you piped or redirected it — the TUI is off the table and print mode engages. `efferent "x" > out.txt` can never hang trying to draw boxes into a file.

## Client three: `--mode json` — the agent as a data source

```bash
efferent --mode json 'audit packages/cli for unused exports' \
  | jq -r 'select(.type == "tool_call_start") | .toolName'
```

JSON mode is print mode's control flow with the most literal fold imaginable: every event, `JSON.stringify`-ed, one per line, on stdout. The format is **JSONL** — newline-delimited JSON, one complete object per line — which matters because it's *streamable*: a consumer parses each line as it arrives instead of waiting for a document to close. `jq` works on it out of the box, as does every log pipeline built in the last decade. A run looks like this on the wire:

```
{"type":"turn_start","turnIndex":0}
{"type":"tool_call_start","turnIndex":0,"id":"call_x7Qf","toolName":"read_file","args":{"path":"packages/cli/src/main.ts"}}
{"type":"tool_call_end","turnIndex":0,"id":"call_x7Qf","toolName":"read_file","ok":true,"result":{"path":"packages/cli/src/main.ts","content":"…","totalLines":369,"truncated":false}}
{"type":"assistant_message","turnIndex":1,"text":"Three exports are never imported…","usage":{"inputTokens":18412,"outputTokens":231,"totalTokens":18643,"cacheReadTokens":15890}}
{"type":"agent_end","finalText":"Three exports are never imported: …","messages":[…]}
```

The renderer, in full, is the `consumeEvents` while-loop with its switch replaced by one line — `process.stdout.write(JSON.stringify(event) + '\n')`. The entire mode file is 104 lines, and most of them are the shared scaffolding every mode has (decode the conversation id, build the queue and hooks, run, drain).

This is the mode for everything that wants to *measure* an agent rather than watch one: dashboards, run archives, cost accounting off the `usage` fields, scripts that fail a pipeline when `tool_call_end` events show `ok: false`. Note `agent_end` carries the full message transcript — heavyweight, but it means a JSONL archive of a run is *complete*: you can reconstruct the conversation later without the database.

## Client four: `--mode rpc` — the agent as a server

The first three clients share a shape: one prompt in, one run out. The fourth inverts who's in charge. `efferent --mode rpc` starts the agent as a long-lived process that another *program* drives over stdio — an editor plugin, an orchestrator fanning work across repos, another agent.

The protocol is JSON-RPC 2.0 — the boring, twenty-year-old convention where a **request** carries an `id` and gets exactly one **response** with the same `id`, and a **notification** carries no `id` and expects no reply. [efferent](https://github.com/xandreeddev/efferent) frames it as one JSON object per line (newline-delimited, not the `Content-Length` headers LSP uses). There is one method — `agent.send`, taking `{ prompt, conversationId?, cwd?, allowBash? }` — and one notification, `agent.event`, which wraps each `AgentEvent` as it happens. A session, from the driving program's perspective:

```
→ {"jsonrpc":"2.0","id":1,"method":"agent.send","params":{"prompt":"add a --version flag","allowBash":true}}
← {"jsonrpc":"2.0","method":"agent.event","params":{"conversationId":"0b6e3a52-…","event":{"type":"turn_start","turnIndex":0}}}
← {"jsonrpc":"2.0","method":"agent.event","params":{"conversationId":"0b6e3a52-…","event":{"type":"tool_call_start","turnIndex":0,"id":"call_2c","toolName":"edit_file","args":{…}}}}
← … more agent.event notifications as the run proceeds …
← {"jsonrpc":"2.0","id":1,"result":{"conversationId":"0b6e3a52-…","finalText":"Added --version; tests pass."}}
```

Same vocabulary, third rendering — here the fold wraps each event in a notification envelope instead of printing or painting it. The flush-sentinel drain runs before the response is written, which gives the protocol an ordering guarantee a driver can rely on: **every `agent.event` notification for a request precedes that request's response on stdout.** When your editor plugin sees the `result`, it has already seen the whole story.

The details that make it drivable in practice: the result's `conversationId` feeds straight back into the next `agent.send` as `params.conversationId`, so multi-turn conversations are a loop in the *calling* program. A per-request `cwd` re-discovers the workspace's scope tree, so one server process can serve requests against different projects. Malformed input gets proper JSON-RPC errors (`-32700` parse error, `-32601` unknown method, `-32602` bad params, `-32000` when the run itself failed) rather than a crash. And v1 is deliberately modest: one request at a time — concurrent `agent.send` calls queue behind each other.

## History without a UI: `--resume`

Conversations in [efferent](https://github.com/xandreeddev/efferent) persist to SQLite at `~/.efferent/efferent.db` no matter which mode wrote them, because persistence is a port of the core — a `ConversationStore` the loop appends to — not a feature of any client. The corollary is that **session continuity and the TUI are fully decoupled**:

```bash
efferent --resume 0b6e3a52-7c41-4d2e-9f0a-b3d1c5e8a2f4 \
  --allow-bash 'apply step 2 of the plan we agreed on'
```

That's print mode picking up a conversation — same history, same context, no TUI. The id can come from the RPC response above, or from a morning TUI session (the same flag without a prompt reopens it interactively; `:sessions` lists every conversation in the workspace). Plan a refactor interactively over coffee, then let a script grind through the steps headlessly in the afternoon — and when you reopen the TUI, the startup picker lists the conversations the headless runs extended, because they were never anything other than rows in the same store.

## Headless safety: a standing decision, not a dialog

Here's what headless operation genuinely changes, and it deserves to be said plainly: **a modal that nobody can see is just a deadlock.** That's the CI hang from the opening sketch. In the TUI, a risky bash command can end in a dialog because a human is, by definition, present. Headless, the question "may the agent run shell commands?" doesn't disappear — it changes *kind*, from an interactive decision made mid-run to a standing decision made at invocation time: the `--allow-bash` flag.

Without the flag, bash isn't silently dropped — it fails *as data the model reads*:

```ts title="packages/core/src/usecases/codingToolkit.ts"
Bash: ({ command, timeout }) =>
  Effect.gen(function* () {
    if (!allowBash) {
      return yield* Effect.fail({
        error: 'BashNotAllowed', // [!code highlight]
        message: 'bash execution is disabled in this mode — re-run with --allow-bash to enable',
      })
    }
    // … run the command through the Shell port
  })
```

Because tools declare their failures as returnable results, that error lands in the model's context as an ordinary tool outcome — so the agent routes around it, leaning on the read and search tools and telling you what it *would* have run, instead of the turn dying. With the flag, the `Approval` port — the interface every approval decision flows through — is satisfied by an allow-all implementation provided as a layer:

```ts title="packages/cli/src/modes/json.ts"
yield* runAgent(config, cid, input.prompt, hooks, input.cwd).pipe(
  Effect.provide(runtime.handlerLayer),
  // Headless: --allow-bash already encodes the standing decision.
  Effect.provide(ApprovalAllowAllLive), // [!code highlight]
)
```

The port stays in every signature; only the implementation swapped — the same seam the eval environment substitutes through. (How the TUI's interactive gate works — an LLM judge pre-screening commands, folder-scoped grants — is a post of its own.)

Credentials follow the same logic. Headless modes can't run the interactive `:login` flow, so they require a credential already on disk in `~/.efferent/auth.json`, written by a prior TUI login. If it's empty, the mode exits immediately with a one-line hint instead of failing mid-run — and there's deliberately no env-var fallback for provider keys in the product path. A standing decision should look like a file you placed, not a variable you forgot was set.

## Why a mode costs a hundred lines

Now the claim in the title. "Headless support" sounds like a feature — a milestone, a refactor, a label on a roadmap. In this architecture it's none of those, and the line counts make the argument better than prose can:

| File | Lines | What it is |
| --- | --- | --- |
| `events.ts` | 173 | the entire contract: the union + one `Queue.offer` per hook |
| `modes/json.ts` | 104 | JSONL renderer |
| `modes/print.ts` | 144 | one-shot renderer, stdout/stderr split |
| `modes/rpc.ts` | 270 | JSON-RPC server (half is protocol plumbing: framing, error codes) |
| `modes/tui.ts` | 19 | the seam; the actual TUI hangs off the same contract |

Every mode has the same skeleton — decode a conversation id, make a queue, fork the consumer (the fold), wire hooks, run the agent, drain with the sentinel — and differs only in the fold. The loop's files were not touched to add any of them; `runAgent`'s signature never changed. That's the test of whether something is a feature or a property: features show up as diffs across the system, properties show up as new files beside old ones.

The two enablers were both decided before any second client existed. The loop was written against an optional hook surface in core, where nothing knows stdout exists. And the queue made "who consumes this and how fast" somebody else's problem from day one. Given those, a mode *can't* be much more than a hundred lines, because there's nothing left for it to do except fold.

## What the protocol costs

Honesty section. Three real costs, none of them dealbreakers, all of them permanent.

**A frozen vocabulary is API surface.** The moment one CI script greps your JSONL for `"type":"tool_call_end"`, every rename is a breaking change — and JSONL consumers break *silently*: a `jq` filter over renamed events doesn't error, it matches nothing, and the pipeline goes green on vacuous data. Today the contract is a TypeScript type in the repo — no version field on events, no published JSON Schema — so the discipline is all convention: evolve additively (new optional fields, new variants), and write consumers that ignore what they don't recognize. That's a promissory note that comes due the day there's an external consumer I can't see.

**The granularity is per-message, not per-token.** `assistant_message` lands when a turn's text is complete. For pipes, CI, and orchestrators that's exactly right — but a client that wants typewriter-style streaming needs a delta event the vocabulary doesn't have, and adding one is a contract change for every existing consumer, not a tweak. The vocabulary you freeze is also the granularity you freeze.

**Headless approval is all-or-nothing.** The TUI's gate is graded — a judge pre-screens, grants are scoped to folders, denials carry reasons the model adapts to. `--allow-bash` collapses all of that to one bit. There's no headless middle tier today (say, an allowlist file the static gate consults), so the honest operational advice is blunt: a standing yes is standing risk, and an unattended agent with bash deserves a container. Two smaller warts in the same drawer: print and JSON modes mint a conversation id but never surface it — resuming currently means fishing it out of the TUI or driving RPC, which returns it. And RPC v1 has no cancel method; Esc has no wire equivalent yet.

## The product is the protocol

The conclusion I keep arriving at from different directions: **the most important user of your agent is not a person, and the interface you're proudest of is the one you should trust least to drive the architecture.** A TUI seduces you into terminal assumptions precisely because it's where you live all day. But look at where agents actually run as they become infrastructure — CI jobs, cron, editor backends, other agents' tool calls — and almost none of those seats have a human in them.

So invert the build order. Define the event vocabulary first, make the loop emit it blindly, and write your beloved interactive client as *a* fold — the first, not the foundation. Everything in this post followed from that ordering: print mode is a fold that drops events, JSON mode is a fold that serializes them, RPC is a fold that envelopes them, and the TUI is a fold with very good taste. One hundred and seventy-three lines of contract, four clients, and the certainty that client five — whatever drives [efferent](https://github.com/xandreeddev/efferent) next year — is a new file, not a rewrite. The TUI is the demo. The protocol is the product.
