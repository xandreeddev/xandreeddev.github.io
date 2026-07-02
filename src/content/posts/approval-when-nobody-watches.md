---
title: 'Nobody clicked allow'
description: 'What an approval gate does at 3 a.m.: wave through the ordinary, deny-and-record the rest, and verdict the deliverable — so an unattended run never reads as approved, and never as silence.'
pubDate: 2026-10-02
tags: [agents, effect]
draft: true
---

The approval gate I wrote about in [an earlier post](/posts/bash-approval-rules/) is a ladder of four tiers — project rules, session rules, a fast LLM judge, a modal — and every tier quietly leans on the same assumption: **someone is there.** The rules were written by a human's keystroke. The judge's worst case is showing a dialog to a human. The modal *is* a human. Even that post's headless section kept the assumption in disguise: `--allow-bash` works as a standing decision because a human typed the flag minutes before the run, with the prompt in front of them.

Then [efferent](https://github.com/xandreeddev/efferent) grew cron, and the assumption stopped holding. A scheduled run fires at 03:00 against a machine whose owner is asleep. Somewhere mid-run it wants a command the judge won't clear — an install, a path outside the permitted folders, something genuinely ambiguous. The gate has three inherited answers, and all three are wrong:

- **Block on the modal.** Nobody will answer. That's not safety, it's a deadlock with a cron schedule.
- **Allow everything.** Now "nobody was there" reads as "approved" — the one inference an approval system must never make.
- **Deny silently.** The run limps or dies, and in the morning there's no trace of what it needed or why.

The design that replaced them isn't looser permissions. It's a different **failure mode**: park what can wait for a human, deny-with-reason-and-record what can't, and verdict the deliverable either way. This post walks that machinery, freshest commits included.

## The agent schedules its own 3 a.m.

First, how a run ends up ownerless. Scheduling in [efferent](https://github.com/xandreeddev/efferent) is deliberately boring: a JSON job list (`~/.efferent/cron.json`), five-field cron expressions, and a once-a-minute tick that fires due jobs — at most once per matching minute, forked so a long job never stalls the tick. The tick runs headless under `efferent --mode daemon`, and `schedule` is also **a tool the agent itself holds**: an orchestrator can validate a cron expression and book its own follow-up work, into the same list the human-facing `:schedule` command writes.

What unified the story is the **JobController**. A turn starts from one of three sources — a human typing, a message queued while the agent was busy, a cron tick — and they used to take three different code paths with three different (and for scheduled, *missing*) setups. Now every start is one value:

```ts title="packages/sdk-core/src/entities/Job.ts"
export interface Job {
  readonly conversationId: ConversationId
  readonly folder: string
  readonly prompt: string // the task — also seeded as the run's mission
  readonly source: 'interactive' | 'queued' | 'scheduled'
  readonly interactionPolicy: 'interactive' | 'headless' // [!code highlight]
  readonly agent?: string // optional role to run as, e.g. 'reviewer'
  readonly title?: string
}
```

`submitJob` routes the interactive and queued sources to the ordinary send/queue path. The scheduled source spawns a fresh run with two things the bare spawn never used to set: `mission` (the job's prompt, inherited by every sub-agent, so a terse brief three spawns deep still knows the overall goal) and `interactionPolicy: 'headless'` — a single field, inherited down the whole subtree, that says *nothing in this run may block forever on a human.* That field is what selects everything below.

## The confession

Before the fix, the scheduled path satisfied the `Approval` port with `ApprovalAllowAllLive` — the same five-line allow-everything layer the one-shot `--allow-bash` modes use. The doc comment on its replacement doesn't flinch about what that meant:

> the old `ApprovalAllowAllLive` was a real hole: it silently allowed EVERYTHING an unattended agent tried, including reaching outside the workspace / installing software / touching the network — exactly the set a human is supposed to see.

Allow-all is fine where it started — a human typing `--allow-bash`, run watched. Reused on a cron tick it's the second wrong answer from the intro: absence read as consent. The scheduled path now takes a different layer, worth seeing whole.

## Two kinds of nobody

The subtlety is that "nobody is watching" comes in two grades, and [efferent](https://github.com/xandreeddev/efferent) answers them differently.

**Nobody right now.** The persistent per-workspace daemon (the [protocol post](/posts/headless-agent-modes/) covers it) runs the loop server-side while clients attach and detach freely. When a run there needs approval, the request **parks**: the agent fiber suspends on a `Deferred`, an `approval_needed` event goes out on the workspace stream, and every attached client renders the approval sheet — one sheet at a time across the daemon. Any client's answer (`Workspace.approve`, `POST /approve` on the wire) resolves the fiber; an `approval_resolved` event clears stale sheets everywhere else. Parking is correct here because absence is *temporary* — you closed the laptop; the run waits; you come back.

**Nobody at all.** A cron job has no client and no reason to expect one before the run's budget expires. Parking the fiber would be the deadlock. So the scheduled path gets its own `Approval` layer — the headless parking approval — where what parks is not the fiber but the *decision*:

```ts title="packages/cli/src/workspace/headlessApproval.ts"
request: (req) =>
  Effect.gen(function* () {
    // The SAME judge + permitted-folder logic the interactive gate runs
    // (shared `judgeGate` — one copy of the classification, never two).
    // No session grants: an unattended run can't grow its own permitted set.
    const gate = yield* judgeGate(req, { settings })
    if (gate.allow) return { kind: 'allow', scope: 'once' } as const

    // Not auto-allowed + nobody watching → record the need, then DENY.
    const reason =
      gate.hint?.reason ??
      "the auto-approval judge wouldn't allow this and no human is available to ask"
    yield* publish({
      type: 'needs_human', // [!code highlight]
      tool: req.tool,
      summary: clip(req.summary, 400),
      reason,
      parked: true, // recorded for a human to review later
    })
    return {
      kind: 'deny',
      reason: `parked — needs human approval (this was an unattended run): ${reason}`,
    } as const
  })
```

Three properties carry the design.

**The judge stays, the modal goes.** Ordinary in-scope development work — builds, tests, greps inside the permitted folders — is waved through at 3 a.m. exactly as it would be at 3 p.m., because it's the same `judgeGate` the interactive daemon approval calls: the project's `approvedBashRules` and `approvedFolders` first, then the fast-tier judge over the permitted set. The ledgers a human wrote during the day are the approval context at night. What an unattended run *can't* do is add to them — there are no session grants headless, so a run can't talk itself into a wider sandbox that outlives it. (The judge's tokens still land as `helper_usage` on the fast role; even the 3 a.m. spend shows in the ledger.)

**The failure direction flips.** In the interactive gate, every judge failure — no key, a 429, garbled output — collapses to "prompt," and the worst case is a dialog a human would have seen anyway. Headless, "prompt" *means* deny-and-record. Same mechanism, opposite resting state: the interactive gate fails toward asking, the unattended gate fails **closed**. And because the headless layer can only deny where allow-all allowed, swapping it in strictly shrank what an unattended agent can do.

**The deny is data, so the run continues.** A denial returns as the bash tool's failure payload, which the model reads mid-turn like any failing command: *"the user denied this command: parked — needs human approval (this was an unattended run): … — adjust your approach; don't retry it verbatim."* The run doesn't die at the fence. It finishes what the ledgers and the judge do cover, and the part it couldn't do is exactly what got recorded.

## The roster: decisions need you

Recording is only honest if a human actually sees the record. The `needs_human` event is the control-plane channel for that, and it carries both grades of nobody: `parked: false` mirrors a live interactive ask (the sheet already handles answering it), `parked: true` is the unattended denial. In the TUI they surface as a compact roster in the bottom chrome — the **DecisionsBar** — between the pending queue and the input fence:

```
⚠ 2 decisions need you
  ⚠ ~/deploy (parked) · touches a path outside the permitted folders
  ⚠ Bash (asking) · installs a global package
```

A header with the count, then one attributed line per decision — the most specific locator the producer gave (the out-of-bounds folder, else the tool, else the session) plus the judge's reason. Entries de-duplicate by session + summary; an `approval_resolved` clears a session's parked entries. Deliberately not a modal — the live ask owns the sheet; the roster is for what accumulated while you were gone.

The plumbing matters for the "while you were gone" part: the workspace daemon's event ledger stamps every event with a sequence number and replays the retained tail to any client that attaches. A parked decision from an hour ago is just an event in that stream — you attach, the replay delivers it, the roster renders it. Nobody-was-there never decays into nothing-happened.

## And then, the deliverable

Approval covers what the run *does*. A second question an absent human can't answer: was what it *produced* any good? Interactive fleet runs already pass a mandatory verify gate — an independent verifier judging the deliverable against the objective, with a retry loop ([the self-improving loop post](/posts/self-improving-loop/) covers it). Scheduled runs bypassed all of it: `spawnAgent` never entered the loop that hosts the gate, so cron output shipped unexamined.

That hole is closed now, with unattended-shaped semantics. The scheduled path runs a **one-shot** gate over the spawned run's deliverable — `attempt: 1, maxAttempts: 1`, no retry loop, because a retry re-runs the whole fleet and nobody is there to steer a re-run — and does three things with the verdict:

```ts title="packages/cli/src/workspace/inProcess.ts"
Effect.map((r) => ({
  conversationId: job.conversationId,
  nodeId: r.nodeId,
  outcome:
    r.gateVerdict === 'needs_work' || r.gateVerdict === 'blocked'
      ? ('partial' as const) // [!code highlight]
      : r.outcome === 'partial'
        ? ('partial' as const)
        : ('ok' as const),
}))
```

First, the verdict is **persisted**: every gate round now lands a row in a `gate_verdicts` audit table — verdict, reasons, files changed, advisory flag, duration, and for `unavailable` the verifier's error text — so "was this actually verified?" is a query, not an archaeology project. Second, a `needs_work` or `blocked` folds into the run's outcome as `partial` — the deliverable stands, but its label is honest. Third, the gate runs as an **observer**: the whole thing is wrapped in a `catchAllCause`, because an audit hiccup must never convert a finished scheduled run into a failure.

`partial` slots into the outcome vocabulary that landed the same day: every run now ends in exactly one of `ok | partial | error | killed`, recorded on its context node with a typed stop reason. The old controller returned success-shaped values no matter what happened; a failed cron run was indistinguishable from a clean one. Now the morning read is one glance at `:sessions` — the scheduled conversation is there, its node carries the outcome, the gate verdict sits in the audit table, and any parked decisions are in the roster. Four artifacts, zero silence.

## What this still doesn't do

**A parked decision isn't a resumable one.** Answering the roster entry in the morning doesn't un-deny the command — the run already adapted around it or shipped partial. The record tells you what the job needed; acting on it means blessing the rule or folder in the TUI and letting the next scheduled fire pick it up from the project ledger. Park-and-resume for unattended runs would need the daemon to hold the fiber across hours, and that's a different design with different costs.

**The standalone cron daemon logs, it doesn't stream.** `--mode daemon` runs with no attachable clients, so its parked decisions go to the daemon log — durable, greppable, but not the roster. The `needs_human` event is the interface either way; the roster shows whatever rides an event stream a client can attach to, and folding scheduling into the per-workspace daemon (one process, one replayable ledger) is where this is headed, not where it is.

**The one-shot gate has edges.** It only fires when the scheduled run actually used sub-agents, and `autoLoop: false` turns it off entirely. The verdict labels the deliverable; it doesn't roll anything back — a `blocked` scheduled run has still written what it wrote, inside its folder scope. And the event ledger is a ring buffer: a daemon restart empties it, so a parked decision's *replay* is bounded even though its denial and its log line are not.

**The judge is still a judge.** Everything the [interactive post](/posts/bash-approval-rules/) conceded about a fast model misreading a command applies at night, with one asymmetry in your favor: unattended, a confused judge can only deny too much, never allow too much — the failure modes all land on deny-and-record.

## The failure mode is the design

The through-line, one more time. An approval model built around a modal encodes an assumption — a human within arm's reach — and no flag can retrofit that away; `--allow-bash`-style standing consent just relocates the human to invocation time. Unattended operation needs the assumption *replaced*: absence as a first-class state with its own semantics. Park the fiber where a human might attach. Where none will, run the same judgment you'd run by day, deny what it won't clear, say why in words the model can route around, and write the need somewhere a human will look. Then judge the deliverable once, persist the verdict, and let the outcome vocabulary say `partial` out loud.

None of that made the gate more permissive. Every change either shrank what an unattended agent can do or grew what it must confess. That's the shape I'd argue for in any agent that outlives its operator's attention: nobody-was-there must never parse as "approved" — and never as silence either.
