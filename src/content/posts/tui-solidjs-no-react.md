---
title: 'Updating one cell should cost one cell: the architecture of an agent TUI'
description: "How efferent's terminal UI works: OpenTUI over FFI, Solid signals, one Effect queue, and a pure presentation core."
pubDate: 2026-06-11
tags: [tui, agents, typescript]
draft: true
---

A coding agent's UI has a strange job description. For long stretches nothing happens — a fiber is parked on a provider request, or the human is reading. Then a turn resolves and the terminal has to absorb a hailstorm: assistant prose, a dozen tool pills flipping from running to done, three sub-agent rows updating in place, a context gauge, a spinner and an elapsed clock ticking eight times a second. Each of those updates touches a few terminal cells. The natural cost of "this number changed" should be roughly the cost of changing the number.

This post is the architecture of a terminal UI built around that sentence — the TUI inside [efferent](https://github.com/xandreeddev/agent), the coding agent I'm building on Effect. The README's one-liner is *no Electron, no React, no Ink*; the stack is **OpenTUI + SolidJS signals**. The agent is the production receipt throughout, but the subject is the architecture: how a native renderer, a fine-grained reactivity graph, and an Effect-driven agent loop meet in one process without any of the three leaking into the others.

## The workload is the argument

Start with the default everyone reaches for. **Ink** is React for the terminal, and it inherits React's update semantics: a state change schedules a re-render, components re-execute, the **reconciler** — React's machinery for diffing the element tree you returned this time against the one you returned last time — works out what actually changed, and the renderer applies it. Reconciliation is a brilliant amortization strategy for its home turf: big DOM trees mutated unpredictably by user handlers.

An agent TUI is the opposite shape. Updates are *predictable* (a tool pill goes `running → ok`, a counter increments), *tiny* (a few cells), and *relentless while a turn runs* (a parallel sub-agent fan-out interleaves events from several runs at once; the spinner ticks every 120 ms regardless). Paying a tree diff per cell-sized change, at burst frequency, with the garbage collector invited to every render — that's buying insurance against a risk this workload doesn't have.

**SolidJS** sits at the other end of the cost curve. Solid has no virtual anything: a **signal** is a getter/setter pair, and reading the getter inside a tracked expression — a JSX hole, a computation — subscribes *that expression* to the value:

```tsx
const [tokens, setTokens] = createSignal(0)

// Solid components run ONCE — this JSX builds real nodes, then never re-executes.
// The {tokens()} hole subscribes to the signal; it is the entire update surface.
<text>tok out {tokens()}</text>

setTokens((n) => n + 1) // re-runs that one hole. No component re-render, no diff.
```

That "runs once" is the part React habits trip over: a Solid component is a setup function, not a render function. It executes a single time, wires its JSX holes to the signals they read, and gets out of the way. From then on, data flows through the dependency graph straight to the holes. When `setTokens` fires, the one text node showing the count updates. The diff step doesn't get cheaper — it gets deleted.

That's the whole thesis. Everything below is what it takes to hold onto it in a real program: a renderer that can accept surgical writes, a disciplined seam to the agent, and a layering that keeps the UI testable without a terminal.

## OpenTUI: a retained scene graph behind FFI

**OpenTUI** is a terminal UI runtime in two halves. The native half is a renderer written in Zig, loaded into the process over **FFI** (foreign function interface — the JS runtime `dlopen`s a platform-specific shared library and calls into it directly). It owns the terminal: alternate screen, raw mode, mouse protocol, and a frame loop. The JS half exposes a **retained scene graph** — a persistent tree of renderables like `<box>`, `<text>`, `<scrollbox>`, laid out with Yoga, the same C++ flexbox engine React Native uses. Retained is the operative word: the tree lives across frames, and you mutate it — set a `fg`, replace a text run — rather than describing the whole screen again.

`@opentui/solid` is the bridge: a Solid renderer that maps JSX directly onto those renderables. Compose the two and the pipeline gets very short. Solid's dependency graph already knows *exactly which property of which node* a signal write affects, so the write lands directly on the retained renderable; the native side repaints what changed on the next frame tick. There is no "figure out what changed" phase anywhere in the stack, because nothing ever forgot.

Here's the renderer's whole lifecycle in [efferent](https://github.com/xandreeddev/agent), wrapped so the terminal is restored on success, failure, *and* interruption:

```ts title="packages/cli/src/tui-solid/runtime.ts"
const renderer = yield* Effect.acquireRelease(
  Effect.promise(() =>
    createCliRenderer({
      exitOnCtrlC: false, // exit is a Deferred we control, not a signal handler
      exitSignals: [],
      useMouse: true,
      targetFps: 30,
    }),
  ),
  (r) => Effect.sync(() => r.destroy()), // [!code highlight]
)

yield* Effect.forkScoped(runEventPump(eventQueue, reduce)) // Effect → signals
yield* Effect.promise(() => render(() => createComponent(App, { ctx }), renderer))
yield* Deferred.await(exitDeferred) // block here; scope finalizers restore the terminal
```

Two details carry weight. The frame loop is capped at 30 fps, but a frame's *work* is proportional to what changed — an idle frame costs almost nothing because nothing wrote to the tree (the spinner ticker literally checks `busy()` before touching its signal, so an idle TUI performs no signal writes at all). And the whole module is loaded by the CLI through a lazy dynamic `import()`: the print/JSON/RPC modes of the same binary never touch the native library.

This file is also where the architecture announces itself. Three runtimes meet in one process — **Effect owns the domain services and the agent fiber, Solid owns UI state and the view, OpenTUI owns layout and the terminal** — and they're allowed to touch at exactly two one-directional crossings: a captured Effect runtime for UI-initiated actions (`ctx.run`, `ctx.submit`), and an event pump for everything flowing back. The rest of this post walks those crossings and the layers around them.

## The seam: every agent event crosses on one queue

The agent loop knows nothing about terminals. What it has is **hooks** — callbacks it invokes at lifecycle points — and the CLI's entire production of UI events is one function that turns each hook into a `Queue.offer`:

```ts title="packages/cli/src/events.ts"
export type AgentEvent =
  | { type: 'flush' } // drain sentinel — see below // [!code highlight]
  | { type: 'turn_start'; turnIndex: number }
  | { type: 'assistant_message'; turnIndex: number; text: string; reasoning?: string; usage?: TokenUsage; nodeId?: string }
  | { type: 'tool_call_start'; turnIndex: number; id: string; toolName: string; args: unknown; nodeId?: string }
  | { type: 'tool_call_end'; turnIndex: number; id: string; toolName: string; ok: boolean; result: unknown; nodeId?: string }
  | { type: 'subagent_start'; name: string; task: string; nodeId?: string; parentNodeId?: string }
  | { type: 'subagent_end'; name: string; nodeId?: string; ok: boolean; summary: string; filesChanged: ReadonlyArray<string> }
  | { type: 'skill_load'; name: string }
  | { type: 'helper_usage'; role: 'fast' | 'cheap'; usage: TokenUsage }
  | { type: 'agent_end'; finalText: string; messages: ReadonlyArray<AgentMessage> }
  | { type: 'error'; message: string }

// makeEventHooks(queue): every AgentHooks callback is a Queue.offer of one of these.
```

This vocabulary is mode-agnostic on purpose: the TUI, the one-shot print mode, the JSONL mode, and the RPC mode all consume the same queue and just render differently. A few entries deserve a definition at first sight:

- **`tool_call_start` / `tool_call_end`** pair by the provider's tool-call `id`, because two same-named calls can run in one turn. The TUI's reducer keeps a FIFO queue *per* id (falling back to the name when a provider omits it), so each call resolves its own pill — naive name-keyed matching strands a pill on "running" forever.
- **`nodeId`** on the tool and message events attributes a sub-agent's *inner* activity to that run's container instead of the parent's rail. It's the bridge to the persistent context tree, which is a topic of its own.
- **`helper_usage`** exists purely for accounting: an auxiliary model call inside the loop (a fast-tier judgment, a summarization) has to land on the right line of the spend ledger you'll meet later.
- **`flush`** is the odd one: a drain sentinel. The one-shot modes offer it *after* their run completes, and their consumer fiber exits its loop when it reads one — a deterministic "everything before this has been rendered," with no sleeps and no interruption racing a half-rendered event. The TUI never offers it; its pump is scoped to the app's lifetime and just runs forever.

The queue itself is `Queue.unbounded<AgentEvent>` — deliberately. A bounded queue would mean a slow paint could apply backpressure to an agent turn, and "the UI stalls the model" is exactly the inversion this design exists to forbid. On the other side, a single consumer fiber drains it:

```ts title="packages/cli/src/tui-solid/events/eventPump.ts"
export const runEventPump = (
  queue: Queue.Queue<AgentEvent>,
  reduce: (event: AgentEvent) => void,
): Effect.Effect<never> =>
  Effect.forever(
    Effect.flatMap(Queue.take(queue), (event) =>
      Effect.sync(() => batch(() => reduce(event))), // [!code highlight]
    ),
  )
```

Eleven lines, and it's the *entire* Effect→Solid crossing. `batch` is Solid's "group these writes": one event may touch the rail, the execution tree, the stats, and the header state machine, and batching flushes their subscribers once per event instead of once per setter. The `reduce` function it wraps is a big pure-ish switch — one closure per pump holding the FIFO matching state — whose every branch ends in a store setter. Agent fibers produce from whatever fiber they're on; one consumer writes signals; signals repaint cells. The two frameworks never see each other's types.

## The store: one source of truth, five slices

`createTuiStore` composes five concern-scoped slices — conversation, side pane, session, ui, overlay — into one flat object the views read directly. Each slice is the same pattern: signals plus intention-revealing setters. The conversation slice is the busiest:

```ts title="packages/cli/src/tui-solid/state/conversation.ts"
const [blocks, setBlocks] = createSignal<ScrollbackBlock[]>([])
const [nodePreview, setNodePreview] = createSignal<NodePreview | null>(null)
// Imperative renderer handles live OUTSIDE the signal graph, in plain slots.
const convScroller: { current?: ConvScroller } = {}

return {
  blocks,
  // Append-only; tools update in place by id (never spliced), so fold ids stay stable.
  pushBlock: (block) => setBlocks((bs) => [...bs, block]),
  updateTool: (id, patch) =>
    setBlocks((bs) => bs.map((b) => (b.kind === 'tool' && b.id === id ? { ...b, ...patch } : b))),
  // Readers see the open preview; writers keep hitting the live rail underneath.
  viewBlocks: () => nodePreview()?.blocks ?? blocks(), // [!code highlight]
  // …
}
```

Two store decisions do a lot of quiet work. First, the things that are *not* signals. The handle to the running agent fiber lives in a non-reactive slot (`store.run`), as does the scrollbox handle: an imperative renderer handle is never something the view renders, and a fiber is not UI state. The store holds both worlds, but it knows which is which.

Second, the highlighted line. When you open a sub-agent's session as a read-only preview, every conversation-pane *reader* — the view, the fold cursor, the search — goes through `viewBlocks()`, while every *writer* (the event pump, actions) keeps targeting the live `blocks`. A turn streaming in the background can't clobber what you're reading, and closing the preview reveals everything that happened meanwhile. One derived function, no flags, no copies.

## presentation/: the pure layer that makes a TUI testable

Here is the layering discipline that the directory tree enforces: `presentation/` is **pure functions from state to view-model** — plain data describing what should be on screen — with no Solid import, no OpenTUI import, no IO. It holds the conversation's turn/fold model, the execution tree reducers, the tool-call describers, the status-bar math, the pane-navigation row flattening. Out of its twenty-odd modules, **seventeen ship a colocated `.test.ts`** — this layer is where the TUI's correctness actually lives, and it tests like any other pure code: call function, assert data, no terminal in sight.

The cleanest specimen is the agent's live state machine — *what is the agent doing right now*, derived from the same event stream everything else reads:

```ts title="packages/cli/src/tui-solid/presentation/agentState.ts"
export type AgentPhase = 'idle' | 'thinking' | 'tool'

export interface AgentState {
  phase: AgentPhase
  since: number              // when the phase last changed
  openToolCount: number      // open ROOT tool calls
  lastTool: string | null    // most recently started root tool's label
  fleet: ReadonlyArray<{ nodeId: string; name: string }> // live sub-agents
}

export const reduceAgentState = (s: AgentState, e: AgentEvent, now: number): AgentState => {
  switch (e.type) {
    case 'turn_start': // a new model call: last turn's tools are settled
      return { ...phaseTo(s, 'thinking', now), openToolCount: 0 }
    case 'tool_call_start': {
      if (e.nodeId !== undefined) return s     // a fleet member's inner tool
      if (e.toolName === 'run_agent') return s // its lifetime IS the fleet // [!code highlight]
      return phaseTo({ ...s, openToolCount: s.openToolCount + 1, lastTool: label(e) }, 'tool', now)
    }
    case 'tool_call_end': {
      const open = Math.max(0, s.openToolCount - 1)
      // Last root tool settled → the model is reading results: thinking again.
      return open === 0 ? phaseTo({ ...s, openToolCount: 0 }, 'thinking', now) : { ...s, openToolCount: open }
    }
    // … subagent_start/end maintain the fleet; agent_end/error → idle
  }
}
```

The highlighted exclusion is the kind of judgment call this layer is for: `run_agent` is the spawn tool, and its call can stay open for minutes while the sub-agent works — counting it as a "running tool" would pin the header on the spawn forever, when the fleet chip already tells that story. The **fleet** (live sub-agents) is deliberately orthogonal to the phase: the root can be `thinking` while three agents grind. Every one of these transitions is a unit test away from regression, with zero rendering involved.

The same layer owns the heaviest lift in the TUI: `historyProjection` derives rail blocks, the activity tree, *and* the files-changed diffstat from **one walk** over a session's persisted messages — so booting, resuming, forking, and live streaming all converge on identical screens because they share the projection.

## keys/: input is a dispatch problem

The TUI is **modal**, in the vim sense: the composer is INSERT, the two read-only panes are NORMAL, and what a key means depends on where you are. The tempting implementation — listeners sprinkled across components — makes precedence emergent and unreproducible. Instead there's exactly one keyboard subscription, in the root component, and it calls a dispatcher whose ordering *is* the policy:

```ts title="packages/cli/src/tui-solid/keys/dispatch.ts"
export const dispatch = (ctx: TuiContext, key: Key): void => {
  if (overlayKey(ctx, key)) return // a modal owns ALL input while open // [!code highlight]
  if (key.ctrl && key.shift && key.name === 'c') { ctx.copySelection(); return }
  if (key.ctrl && key.name === 'c') { /* 2×-to-quit: arm, then exit within 2 s */ }
  if (key.name === 'escape' && store.busy()) { ctx.interrupt(); return }
  // Ctrl-h/k → conversation · Ctrl-l → side · Ctrl-j → input
  // '/' in a read-only pane seeds a per-pane search; ':' seeds the command palette
  if (store.focus() === 'input' && inputKey(ctx, key)) return        // palette nav, history
  if (store.focus() === 'side' && sideKey(ctx, key)) return          // per-view cursor/fold
  if (store.focus() === 'conversation' && conversationKey(ctx, key)) return
  // … preview close (q) · yank (y) · zoom (z)
}
```

Reading top to bottom answers every "why did that key do that" question: an open modal swallows everything; copy must beat quit (or Ctrl-Shift-C arms the quit instead of copying); Esc means *interrupt the turn* while busy and only then falls through to its quieter meanings. Below the globals, each pane contributes a handler that returns `true` iff it consumed the key.

The NORMAL-mode vocabulary is vim's, adapted to fold-structured content: `j/k` scroll lines while `{`/`}` and `[`/`]` step a **fold cursor** by paragraph and message, `gg`/`G` jump the ends, `Tab`/`Enter`/`h`/`l` fold the unit under the cursor, `Z` folds everything, and `/` opens a search scoped to the focused pane with `n`/`N` cycling matches. All of the cursor logic lives in `presentation/paneNav.ts` as pure row math; `keys/` just routes. Even the composer participates: OpenTUI fires global key handlers before the focused `<textarea>` and skips it when the event is `preventDefault()`-ed, which is how `↑`/`↓` can mean "palette highlight" on a `:command` line and "history recall" on a plain message while remaining ordinary cursor keys in a multi-line draft.

## view/: components that run once

After all that, the view layer has remarkably little to do — which is the point. Of the ~110 files in the TUI, only 25 are `.tsx`; they paint store state and forward intent, nothing else. The header is representative — the agent's face, rendering the state machine from two sections ago:

```tsx title="packages/cli/src/tui-solid/view/chrome/Header.tsx"
export const Header = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const st = () => store.agentState()
  const spin = () => glyph.spinner[store.spinner() % glyph.spinner.length]
  const elapsed = () => {
    void store.spinner() // the spinner tick doubles as the clock // [!code highlight]
    return st().since > 0 ? fmtElapsed(Date.now() - st().since) : ''
  }
  return (
    <box flexDirection='row'>
      <text fg={tokens.accent.conversation}>{'▌efferent'}</text>
      <Show when={st().phase !== 'idle'} fallback={<text fg={tokens.text.dim}>{'  · idle'}</text>}>
        <text fg={tokens.state.running}>{`  ${spin()} `}</text>
        <text>{agentStateLabel(st())}</text>
        <text fg={tokens.text.dim}>{` ${elapsed()}`}</text>
      </Show>
      <Show when={fleetLabel(st())}>
        <text fg={tokens.accent.side}>{`  ◆ ${fleetLabel(st())}`}</text>
      </Show>
    </box>
  )
}
```

The highlighted line is the fine-grained model used as a scheduling trick. `Date.now()` isn't reactive, so an elapsed readout needs *something* to invalidate it — and the spinner signal already advances every 120 ms, but **only while a turn is busy**. Reading it (and voiding the value) makes the clock tick exactly when a clock should tick and stop costing anything the moment the agent goes idle. In a re-render world you'd reach for an interval and a teardown; here it's one discarded read.

The same thin-view discipline runs through the side pane's Activity view: a context gauge (input tokens against the model's window, with an honest `~` prefix while the count is still a resume estimate), the agent's live plan, the execution tree — and the **per-role spend ledger**, a `Σ main 1.2M · fast 40k · cheap 8k` line that appears once any helper tier has spent. Every token billed anywhere lands on a role: the agent and its sub-agents on `main`, the approval judge's calls on `fast`, session-title generation on `cheap`. The view just folds `stats.byRole` into a string; the *policy* of who pays for what lives where it belongs, in the reducers feeding the store.

## Overlays: the moment the UI blocks the agent

Modals are one discriminated signal, not a stack of booleans: `Overlay` is `none | select | login | settings | approval`, and `overlayKey` — the first line of the dispatcher — owns all input while one is open. The generic `select` member covers the `:model`, `:effort`, `:search`, `:theme`, and resume pickers with shared move/filter/submit plumbing; a `purpose` tag re-narrows the erased value type at the submit boundary, so adding a picker is one tag plus one switch branch.

The approval modal is the interesting one, because it inverts the usual direction: the *agent fiber* asks the *UI* a question. When a bash command needs human sign-off (after the rule ledgers and the fast-tier judge have had their chance to settle it silently — that judge is a story of its own), the requesting fiber suspends inside an `Effect.async` whose resume callback is stashed where the key handler can reach it; opening the modal is just one more `setOverlay`. The fiber sleeps until a keystroke answers, and if the human interrupts the whole turn instead, the async's cleanup closes the modal so nothing dangles. The Effect-side mechanics of parking fibers on humans deserve — and have — a post of their own; what matters *here* is that from the UI's perspective an approval is an ordinary overlay with an ordinary key handler:

```ts title="packages/cli/src/tui-solid/keys/overlay.ts"
if (o.kind === 'approval') {
  // choose mode: three of the four answers create a standing rule.
  if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
    ctx.resolveApproval({ kind: 'deny' }) // "get this off my screen" must not run the command // [!code highlight]
    return true
  }
  if (key.name === 'a') { ctx.resolveApproval({ kind: 'allow', scope: 'once' }); return true }
  if (key.name === 's') { ctx.resolveApproval({ kind: 'allow', scope: 'session' }); return true }
  if (key.name === 'p') { ctx.resolveApproval({ kind: 'allow', scope: 'project' }); return true }
  if (key.name === 'd') { store.setOverlay({ kind: 'approval', state: beginDenyReason(o.state) }); return true }
  return true // a modal owns all input while open
}
```

`ctx.resolveApproval` is the captured resume; the parked agent fiber wakes with the decision as a value. Note the highlighted default: Esc denies. A modal's escape hatch must never be the dangerous answer. And `d` doesn't deny immediately — it opens a one-line editor for a typed reason, because a denial *with a reason* goes back to the model as data it can course-correct on within the same turn.

## The content pipeline: prose, diffs, folds, yank

A conversation rail full of raw strings would waste the medium. The pipeline that turns agent output into something readable has four stages, and all of them ride the same signal graph as everything else.

**Prose is markdown, natively.** Assistant text renders through OpenTUI's `<markdown>` renderable — `marked` parses it, and each token is styled by scope lookup, so headings, bold, lists, inline code and links arrive styled instead of as literal `**` and backticks. **Code is tree-sitter.** Fenced blocks inside that markdown, and the hunk contents of diffs, are highlighted by a shared tree-sitter client — a real incremental parser running in a worker, the same parsing technology editors use, not a pile of regexes. Both families share one style table, built from the active theme's semantic tokens:

```ts title="packages/cli/src/tui-solid/view/syntax.ts"
const styleCache = new Map<string, SyntaxStyle>()

export const syntaxStyle = (): SyntaxStyle => {
  const name = activeThemeName() // reactive read — highlighting follows :theme // [!code highlight]
  const cached = styleCache.get(name)
  if (cached !== undefined) return cached
  const built = SyntaxStyle.fromStyles({
    'markup.heading': { fg: tokens.syntax.heading, bold: true },
    'markup.raw': { fg: tokens.syntax.raw },
    keyword: { fg: tokens.syntax.keyword },
    string: { fg: tokens.syntax.string },
    comment: { fg: tokens.syntax.comment, italic: true },
    // …forty more scopes, every colour a tokens.syntax role
  })
  styleCache.set(name, built)
  return built
}
```

**Diffs are first-class.** The edit tool emits a canonical unified diff, and the rail renders it through the native `<diff>` renderable — `+`/`-` line colouring, line numbers, per-token highlighting inside hunks with the filetype inferred from the `+++` header. The same diffstat that annotates a finished tool pill (`+12/-3`) is accumulated structurally, straight off tool results, into the Activity pane's files section.

**Structure folds.** The rail isn't a log; it's a tree wearing a log's clothes. A *turn* — a user message plus everything until the next one — folds to a single quiet `❯ subject ▸ N steps` line. A run of two or more consecutive tool calls aggregates into a *tool group*: `▸ read · grep · edit (3 tools, +5 -2)`, expanded with live pills while any member runs, settling collapsed when the last lands. Fold identity is pure data in `presentation/conversation.ts` (`turn:<index>`, `grp:<firstToolId>` — stable because the block list is append-only and tools patch in place), and the rhythm is opinionated: **sending a message folds every previous turn**, so the live exchange is always the only expanded story on screen.

**Selection leaves the machine.** Mouse drag-select is native (`useMouse: true`), and `y` — or the conventional Ctrl-Shift-C — yanks the selection via **OSC 52**, the escape sequence that asks the terminal emulator itself to set the system clipboard. That detail is load-bearing for an agent you run on remote boxes: the copy works over SSH because the *terminal on your desk* performs it.

## Themes are token records

The design system is two tiers. A small palette names raw colours; a `Tokens` record names every *visual role* the views are allowed to paint with — and views reference roles, never hexes:

```ts title="packages/cli/src/tui-solid/presentation/theme/tokens.ts"
export interface Tokens {
  accent: Record<'conversation' | 'side' | 'input', string> // per-pane focus accents
  text: { default: string; user: string; assistant: string; heading: string; muted: string; dim: string }
  state: { running: string; ok: string; error: string }     // tool pills, tree glyphs
  overlay: { bg: string; border: string }
  cursorLine: string
  syntax: SyntaxTokens // keyword/string/comment/… — code and markdown share it
  // …
}
```

A **theme** is one complete set of values for those fixed names — [efferent](https://github.com/xandreeddev/agent) ships three: `efferent` (the default — warm near-black with an ember/verdigris/chartreuse triad), `one-dark`, and `tokyo-night`. The token *shape* is the stable interface; a theme is just data satisfying it. Which leaves one problem: `presentation/` is pure and static, so its `tokens` is a module constant — how does `:theme` switch live? With the smallest possible amount of magic:

```ts title="packages/cli/src/tui-solid/state/theme.ts"
const [activeTheme, setActiveTheme] = createSignal<Theme>(defaultTheme)

export const setTheme = (name: string): boolean => {
  const next = themes[name] // efferent · one-dark · tokyo-night
  if (next === undefined) return false
  setActiveTheme(next)
  return true
}

// Same shape as the static Tokens; every group access reads the signal.
export const tokens: Tokens = new Proxy({} as Tokens, {
  get: (_t, prop) => activeTheme().tokens[prop as keyof Tokens], // [!code highlight]
})
```

Every view imports `tokens` from this module and writes `tokens.text.dim` exactly as before — but each access now reads the active-theme signal, so every JSX hole that paints a colour is *subscribed to the theme*. `:theme` opens the shared select overlay, the action calls `setTheme`, and the entire screen re-resolves on the next frame with zero call-site changes — including syntax highlighting, since `syntaxStyle()` above keys its cache on the reactive theme name. The choice persists to settings and is seeded back before the first render at boot. Sixteen-odd view modules got live theming for the price of one Proxy.

## What it costs

The honest ledger, because this stack is not free.

**A native dependency is a real dependency.** The published package has exactly two runtime deps, and both exist because of this article: `@opentui/core` ships a platform-specific native library that's `dlopen`'d at startup and *cannot* be inlined into the JS bundle, plus the tree-sitter worker and grammar WASM; `web-tree-sitter` rides along as the worker's import. That's a per-platform binary matrix where pure-JS Ink has none, and a class of failure (FFI load, worker spawn) that JavaScript-only stacks never see. The mitigations are themselves work: highlighting is best-effort by design — if the worker can't spawn, code renders plain instead of the TUI breaking — and the worker keeps the Bun process alive, so a scope finalizer has to destroy it on every exit path or `:exit` simply doesn't. Grammar coverage is whatever the package bundles (JS/TS/markdown/zig today); other languages render unhighlighted until more grammars are wired in.

**Terminals lie about keys.** The dispatcher's first lines aren't design; they're scar tissue. Two fast Escapes arrive as one `meta+escape` and must be re-split or a double-Esc swallows the second. Legacy terminals — tmux above all — deliver Ctrl-J as a bare linefeed, and Ctrl-H *is* backspace (0x08) there, unrecoverable in code. Ctrl-Shift-C only reaches the app if the terminal forwards it, which OpenTUI's Kitty-protocol request enables on terminals that speak it — and on ones that don't, the terminal copies its own (empty, in mouse mode) selection and no code can fix that. The durable lesson sits in the keymap itself: the advertised paths lead with `Esc`, `w`, `v`, `:` — keys that need no modifier protocol at all. If you build a TUI, design the hints for the worst terminal you support, not the best.

**You can't unit-test feel.** The split helps enormously — seventeen tested presentation modules carry the logic, and the view layer gets smoke coverage through OpenTUI's headless test renderer, which boots the real pipeline (Solid transform, reconciler, native FFI layout and draw) into a memory buffer and lets tests assert on the frame as text:

```ts title="packages/cli/src/tui-solid/view/smoke.test.ts"
test('OpenTUI + Solid render a bordered box with text', async () => {
  const { waitForFrame, renderer } = await testRender(SmokeApp, { width: 40, height: 8 })
  try {
    const frame = await waitForFrame((f) => f.includes('hello opentui')) // [!code highlight]
    expect(frame).toContain('hello opentui')
    expect(frame).toContain('smoke') // border title rendered
  } finally {
    renderer.destroy()
  }
})
```

That catches "the pill never turned green" and "the theme switch didn't repaint" — app-level tests drive the real event reducer into a real store and assert on rendered frames. What it cannot catch is dynamics: the bug where reactive scroll-into-view *fights* sticky-bottom while content streams, yanking the viewport to a stale cursor, shipped, was found by hands on a keyboard, and its fix is a code comment explaining why cursor scrolling is imperative-on-keypress only. Budget for manual passes; no frame assertion replaces feel.

## The browser's hand-me-downs

Strip the inventory and three decisions remain. Make the UI a pure function of state, and put the functions where tests can reach them. Make state cheap to change, so honesty about every counter and gauge costs nothing. Make the seams one-directional and countable — one queue in, one captured runtime out — so three frameworks can share a process without sharing assumptions.

None of that is novel; what's novel is that the terminal is worth it again. Coding agents made the TUI a primary surface — the place real work happens for hours a day — and most of them are still rendered with a framework whose core bet, amortizing unpredictable DOM mutation, answers a question the terminal never asked. An agent's update pattern is the opposite physics: predictable, tiny, relentless. Signals into a retained native scene graph is simply the cost model that matches it.

So the conclusion isn't "use Solid" any more than it's "never use React." It's that *render targets deserve stacks built for their own physics*. The browser earned twenty years of architectural seriousness; the terminal, now that it's where the agents live, has earned the same — not the browser's hand-me-downs.
