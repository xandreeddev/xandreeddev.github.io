---
title: 'Zero-config storage: Postgres is an option, not a prerequisite'
description: 'A local tool should remember on first run — SQLite by default, migrations in the bundle, Postgres one env var away.'
pubDate: 2026-06-11
tags: [effect, agents, ux]
draft: true
---

Here's a first-run experience you've had: install a promising CLI, run it, and get a stack trace ending in `DATABASE_URL is not defined`. The README knows the drill — start Docker, copy `.env.example`, run the migrate command, *then* try again. The tool hasn't done anything for you yet, and it's already handed you an ops job.

This post is about the opposite bar, and the storage architecture that clears it: **zero-config persistence**. A local tool should remember things the first time you run it, with nothing to set up — and a real server database should be an option you can take later, not a toll you pay at the door. Every snippet comes from [efferent](https://github.com/xandreeddev/agent), the coding agent I'm building on Effect, where persistence is the difference between an agent and a goldfish: conversations resume, sub-agent context survives restarts, checkpoints make long sessions foldable. All of that has to work thirty seconds after `npm i -g`.

## The bar: install, run, remember

Spell the bar out, because it's stricter than it sounds: `npm i -g efferent`, run it, ask it something, quit, run it again — and it can resume the conversation. No service started, no env var exported, no `migrate up`, no init wizard. The tool remembered, and you never thought about how.

Most tools that need memory fail this bar the same way, with some variation of this at the top of `main`:

```ts
// first run, before the tool has done anything for you:
const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set — see README for setup.')
  process.exit(1)
}
```

That guard isn't laziness; it's a default that quietly assumes every user is a deployment. But a single-user CLI isn't a deployment. It's one process, on one machine, owned by one human, writing at human-plus-agent rates. There is a database engine designed for exactly that shape: **SQLite** — a full SQL engine that runs *inside your process*. No server, no port, no daemon to babysit; the database is a single file, and "connecting" is a library call. It's the most widely deployed database on earth (it's in your phone and your browser), and for a one-process tool it isn't the compromise option — it's the correct one.

So [efferent](https://github.com/xandreeddev/agent)'s storage policy starts with a parser whose *default branch* is the product decision. One value — the `EFFERENT_DB_URL` environment variable — selects the backend, and the absence of that value is not an error:

```ts title="packages/adapters/src/database/migrator.ts"
const defaultSqlitePath = () => join(homedir(), '.efferent', 'efferent.db')

type DbTarget =
  | { readonly kind: 'postgres' }
  | { readonly kind: 'sqlite'; readonly filename: string }

/** Interpret the EFFERENT_DB_URL value into a concrete backend target. */
export const parseDbTarget = (raw: string | null): DbTarget => {
  const v = raw?.trim()
  if (!v) return { kind: 'sqlite', filename: defaultSqlitePath() } // [!code highlight]
  if (/^postgres(ql)?:\/\//i.test(v)) return { kind: 'postgres' }
  const path = v.replace(/^sqlite:(\/\/)?/i, '')
  return { kind: 'sqlite', filename: path || defaultSqlitePath() }
}
```

Unset means SQLite at `~/.efferent/efferent.db`. A `postgres://` URL means Postgres. Any other non-empty value is treated as a SQLite path. Three cases, and the one nobody configures is the one that works.

The other half of zero-config is that *first contact creates everything*. The layer that builds the SQLite stack makes the directory before it opens the file, and runs migrations before anything queries:

```ts title="packages/adapters/src/database/migrator.ts"
/** SQLite client + migrator at `filename` (creating its parent dir). */
const sqliteDatabaseLive = (filename: string) =>
  Layer.unwrapEffect(
    Effect.sync(() => {
      mkdirSync(dirname(filename), { recursive: true }) // [!code highlight]
      return SqliteMigrator.layer({ loader: sqliteLoader }).pipe(
        Layer.provideMerge(SqliteClient.layer({ filename })),
      )
    }),
  )
```

(A *layer*, if you're new to Effect, is a recipe for constructing a service; `Layer.unwrapEffect` lets a program compute which recipe to use — the full semantics are a post of their own. Read this one as: "make the folder, open the file, bring the schema up to date, hand back a database.")

Trace the first run end to end: no env var → `parseDbTarget` says SQLite at the default path → `mkdirSync` conjures `~/.efferent/` → opening the file creates it → the migrator brings an empty database to the current schema → the agent appends message one. Every step happens at boot, inside layer construction, before any feature code runs. The user did nothing, and was asked nothing. The status bar quietly shows `sqlite`, the only acknowledgment that a storage decision was made at all.

## What one file holds

Briefly — because the semantics of what's *in* these tables are posts of their own — here is what that file contains. Conversations and their messages, plus **checkpoints**: fold points that let a long session collapse everything before a summary. And the **context tree**: one node per sub-agent spawn, with its own message log. The whole schema is readable in one screen:

```ts title="packages/adapters/src/database/migrations-sqlite/0001_init.ts"
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient // [!code highlight]
  yield* sql`
    CREATE TABLE conversations (
      id            TEXT PRIMARY KEY,
      created_at    INTEGER NOT NULL,
      workspace_dir TEXT
    )
  `
  yield* sql`
    CREATE TABLE messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      position        INTEGER NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      UNIQUE (conversation_id, position)
    )
  `
  yield* sql`
    CREATE TABLE checkpoints (
      id               TEXT PRIMARY KEY,
      conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_position INTEGER NOT NULL,
      summary          TEXT NOT NULL,
      created_at       INTEGER NOT NULL
    )
  `
  // … indexes; context_nodes + context_messages arrive in the next migration
})
```

Five tables (plus the migrator's own ledger), one file. And "one file" is a feature with teeth: backup is `cp`, reset is `rm`, inspection is any SQLite browser, and "where does this thing keep my data?" has a one-path answer a user can hold in their head. Compare the same question for a tool that scattered state across a Docker volume — most users couldn't *find* their own conversation history, let alone copy it to a new laptop.

One detail in that snippet matters for the next section, and it's the highlighted line: a migration here is not a `.sql` file. It's an ordinary Effect that asks for a `SqlClient` — the same service the stores use — and runs statements. A migration is *code*, importable like any other module. Hold that thought.

## Migrations as data, not files

A **migration**, if the term is new: schemas change over time, so databases carry a versioned list of change scripts, and a **migrator** tracks which have already run (in a small bookkeeping table) and applies only the new ones. The dominant pattern puts those scripts in a directory — `migrations/0001_init.sql`, `0002_add_titles.sql` — and the migrator reads the directory at runtime. `@effect/sql` supports exactly that via `Migrator.fromFileSystem`.

And it would break [efferent](https://github.com/xandreeddev/agent) the moment anyone installed it. The published package is a single-file bundle: `bun run build` inlines core, adapters, and all of `@effect/*` into one `dist/efferent.js`. There is no `migrations/` directory sitting next to the executable on a user's machine — the repo layout simply doesn't exist at runtime. A filesystem-path loader works perfectly in development, passes every test, and then dies on the first `npm i -g` with a path error pointing at a folder that was never shipped. (The same trap waits for anyone compiling to a standalone binary — same property, no filesystem to read your own source from.)

The fix is to stop treating migrations as files the program *finds* and start treating them as data the program *contains*:

```ts title="packages/adapters/src/database/migrator.ts"
import sqlite0001 from './migrations-sqlite/0001_init.js'
import sqlite0002 from './migrations-sqlite/0002_context_tree.js'
// … 0003–0006

const sqliteLoader = Migrator.fromRecord({ // [!code highlight]
  '0001_init': sqlite0001,
  '0002_context_tree': sqlite0002,
  '0003_workspace_ref': sqlite0003,
  '0004_seed_count': sqlite0004,
  '0005_conversation_title': sqlite0005,
  '0006_node_title': sqlite0006,
})
```

`Migrator.fromRecord` takes a static map from migration name to migration effect. Because each migration is an imported module, the bundler treats it like any other dependency and inlines it — the schema's entire history rides inside the artifact. Nothing about the migrator's contract changes: it still consults its ledger, still runs only what's pending, still works against a database from any previous version. Only the *loading* changed, from "scan a directory I hope exists" to "here is the list, at compile time."

The record looks like boilerplate — it's the load-bearing kind. The explicit imports are what make the bundle self-contained, and the explicit keys are what make ordering reviewable in a diff. When migration eleven lands, it shows up in code review as one import and one record entry, not as a file the build process may or may not have copied.

## Two stores, one database

[efferent](https://github.com/xandreeddev/agent) has two SQL-backed services: `ConversationStore` (conversations, messages, checkpoints) and `ContextTreeStore` (the sub-agent tree). Ports-and-adapters instinct says package each one as a self-contained layer — store plus its own database stack — so consumers can take either without knowing about the other:

```ts
// tempting: each store ships with its own batteries
const ConversationsLive = SqliteConversationStoreLive.pipe(
  Layer.provide(sqliteDatabaseLive(file)), // stack #1: client + migrator
)
const ContextTreeLive = SqliteContextTreeStoreLive.pipe(
  Layer.provide(sqliteDatabaseLive(file)), // stack #2: same file, second client, second migrator
)
```

This compiles, and it's a bug. Layers are memoized *by reference* — Effect builds one instance per layer **value**, not per layer recipe. Two separate calls to `sqliteDatabaseLive(file)` produce two distinct values, so at boot the runtime cheerfully builds both: two connections to the same file, and — worse — **two migrators racing each other over the same ledger**. Both wake up, both read the bookkeeping table, both conclude `0002_context_tree` is pending, and both try to run it. Best case, one loses with a "table already exists" error; on SQLite you can also just deadlock on the file's write lock during boot. A race in the part of the program whose entire job is to run exactly once, before everything else.

So the composition root provides both stores over a *single* database stack, and the layer that does it is where the product decision from section one becomes code:

```ts title="packages/adapters/src/database/migrator.ts"
export const StoresLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const url = yield* Config.option(Config.string('EFFERENT_DB_URL'))
    const target = parseDbTarget(Option.getOrNull(url))
    return target.kind === 'postgres'
      ? Layer.merge(
          PostgresConversationStoreLive,
          PostgresContextTreeStoreLive,
        ).pipe(Layer.provide(PgDatabaseLive))
      : Layer.merge(
          SqliteConversationStoreLive,
          SqliteContextTreeStoreLive,
        ).pipe(Layer.provide(sqliteDatabaseLive(target.filename))) // [!code highlight]
  }),
)
```

One `Layer.merge` of the two stores, one shared `Layer.provide` of the database underneath: one client, one migrator run, by construction. The highlighted line is the entire concurrency fix — the database layer appears *once*, so memoization has one value to memoize. Note also what this layer is, product-wise: the **whole** storage policy, in one expression. Read the env var, pick the engine, wire both stores over one stack. There is no second place where storage gets decided; the app's entry point takes `StoresLive` and is done.

The same shape pays again in tests: the eval environment swaps both stores for in-memory maps in one move — a story that's a post of its own.

## The Postgres escape hatch

Why ship Postgres support at all, if SQLite is the right answer for a single-user CLI? Because "single-user" is a today-fact, not a forever-fact, and some users arrive already past it. History you want shared across two machines. An agent running headless on a box you ssh into, with the history queried from your laptop. A team that wants one place to watch agent runs. The moment more than one machine needs the same memory, a file in one home directory stops being an answer — that's when a tool has *earned* a server database, and the upgrade should cost one value, not a rewrite.

You already saw the env-var route: set `EFFERENT_DB_URL=postgres://…` and `StoresLive` builds the Postgres branch. For people who'd rather not manage env vars, the TUI has a `:db` command that persists the choice to config:

```ts title="packages/cli/src/tui-solid/actions/settings.ts"
/** `:db` — show the active store, or write a new `dbUrl` to project/global config. */
export const applyDb = (store: TuiStore, cwd: string, tokens: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const wantGlobal = tokens.some((t) => t === 'global')
    const args = tokens.filter((t) => t !== 'global')
    if (args.length === 0) {
      return // ':db' alone: report what's actually connected, env override and all
    }
    const dbUrl =
      args[0] === 'sqlite'
        ? (args[1] ?? '') // '' → back to the zero-config default
        : args.slice(1).join(' ').trim() // ':db pg postgres://…'
    const cfgPath = wantGlobal
      ? join(homedir(), '.efferent', 'config.json')
      : join(cwd, '.efferent', 'config.json')
    // … read-modify-write that file: set (or clear) its `dbUrl` key
    store.pushBlock({
      kind: 'info',
      text: `database → ${maskDbUrl(dbUrl)} · saved · relaunch efferent to connect`, // [!code highlight]
    })
  })
```

Two honest details live in that snippet. First, the highlighted line says *relaunch* — the store is chosen at layer build, at boot, so `:db` writes intent rather than hot-swapping your history mid-conversation. At the next launch, a tiny pre-boot step reads `dbUrl` from project config (falling back to global) and seeds it into `EFFERENT_DB_URL` — a real env var always wins, config only fills the gap. Second, `wantGlobal`: storage scope is *per project* by default. One repo can point at a team Postgres while everything else stays on the local file.

Here's the part that makes the hatch trustworthy rather than aspirational: **the same migrator architecture runs on both engines.** `Migrator.fromRecord`, the bundled-record trick, the single-stack rule — all identical; only the client layer and the record's contents differ. A fresh Postgres database gets schema'd up from nothing on first connect, exactly like the SQLite file did.

What it costs is SQL portability, and the bill is real. There is no single migration history — there are two dialect-specific ones (ten Postgres migrations, six SQLite), because the engines genuinely differ: `uuid` becomes `TEXT`, `jsonb` becomes a JSON string in `TEXT`, `bigint` becomes `INTEGER`. The stores mirror each other but not literally — the Postgres queries carry `::uuid` and `::jsonb` casts, and the "first user message" preview is `content->>'content'` on Postgres versus `json_extract(content, '$.content')` on SQLite. Even *reading* differs: Postgres hands `jsonb` back as a parsed object, SQLite hands back a string, and one shared codec is the only place that knows:

```ts title="packages/adapters/src/database/messageCodec.ts"
/**
 * Reassemble a stored (role, content) row for schema decoding. `content` is a
 * JSON *string* in SQLite and an already-parsed object in Postgres (jsonb).
 */
export const reassembleMessageRow = (role: string, content: unknown): unknown => {
  const parsed = typeof content === 'string' ? JSON.parse(content) : content // [!code highlight]
  return parsed !== null && typeof parsed === 'object'
    ? { role, ...(parsed as Record<string, unknown>) }
    : parsed
}
```

The discipline that keeps the gap small: generate everything generatable in the app. IDs are `crypto.randomUUID()` strings, timestamps are `Date.now()` integers — so there are no database-side defaults, sequences, or `now()` calls to behave differently between engines. The dialect surface shrinks to types and JSON operators, and one codec absorbs the read side. It's not free — every schema change from here on is written twice — but it's bounded, and it's the price of the default *and* the hatch being first-class.

## What the default costs

Tradeoffs, plainly, because "SQLite by default" is a position with edges.

**One writer at a time.** SQLite serializes writers — the whole database has a single write lock. Inside one [efferent](https://github.com/xandreeddev/agent) process that's a non-issue: every fiber's writes funnel through the one shared client anyway, and an agent's write rate (messages, node updates) is nowhere near contention territory. But run two instances against the same file and they *will* contend for the lock; SQLite handles it with waiting, not magic. The design point is one human on one machine, and the single-stack rule from earlier exists precisely because even *one process* accidentally holding two connections was enough to bite.

**No remote access, by design.** Nothing listens on a port — which is a security property you get for free, and a sharing property you give up. Two laptops means two histories. There's no replication story, no "open my home server's file from here." That's not a missing feature; it's the line where the escape hatch begins. The failure mode worth avoiding is pretending a file can be a server — sync-the-file-with-Dropbox schemes corrupt databases for a living.

**Schema evolution becomes a public API.** This is the cost people underestimate. Once users install the tool, there are copies of your database schema *in the wild*, at every version you ever shipped, and the migrator runs unattended at boot on all of them. No ops team runs a backfill; no release note saying "run this script" will reach anyone. Every migration must be safe to apply to any predecessor, with live data, with nobody watching. In practice that means additive, nullable, tolerant: when conversations and context nodes grew display titles, the new columns were nullable and every reader falls back to old behavior for old rows. Contrast the one destructive migration in the repo's history — a `TRUNCATE` when the message format changed — which was acceptable *only* because Postgres was still a disposable dev database at the time. That's also why the SQLite history shipped pre-collapsed: its `0001` creates the final shape directly, because a fresh file has no legacy rows to evolve — the cleanest migration history is the one users never accumulate. The day real users exist, the truncate move is gone forever, and discipline is the only tool left.

**Everything twice.** Two dialects means each schema change is two migration files and a mirrored pass over two store implementations. The codecs and app-generated IDs keep the duplication mechanical rather than treacherous, but it's still a tax, paid on every change, forever. If the Postgres hatch had no users it would not be worth it — supporting an engine "just in case" is how codebases grow dead wings.

## Storage is a UX surface

Here's the position this architecture takes, stated as advice. The database behind a local tool is not an infrastructure decision that users happen to encounter — it *is* part of the interface, and first run is its most important screen. Users will forgive a missing feature; they rarely forgive a tool that demands a standing service before it has provided any value. Sequence matters: earn trust with `it just remembered`, and the day someone needs the team database, they'll set one env var with full confidence the schema will assemble itself on the other side — because they've already watched it do that, silently, on day one.

The whole policy fits in a sentence, and most local tools could adopt it wholesale: default to a SQLite file in a dotdir, carry your migrations inside the artifact, run them at boot over a single shared stack, and leave one URL-shaped variable as the door to a real server. None of it is exotic — `parseDbTarget` is fourteen lines — and the payoff is a quickstart with no prerequisites section.

The gauntlet version survives because we build tools the way we deploy services, and a `DATABASE_URL` check feels like rigor. It isn't. It's a decision you declined to make, exported as homework. Make the decision. Ship the file.
