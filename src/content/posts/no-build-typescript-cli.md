---
title: 'No build step: run the source, gate with tsc, bundle only to publish'
description: 'Bun runs the .ts you edit, tsc --noEmit becomes a pure type gate, and the bundler appears only at publish time.'
pubDate: 2026-07-20
tags: [typescript, agents]
draft: true
---

Every TypeScript project carries a shadow program: the pipeline that turns the code you wrote into the code that actually runs. We've normalized it so thoroughly that `npm run build` feels like a law of nature — of course there's a `dist/`, of course dev mode is two processes in a trenchcoat, of course the stack trace points at a file you've never opened. But the build step was never a law. It was a workaround for one historical fact: runtimes couldn't execute TypeScript. Bun removes the fact, and most of the pipeline evaporates with it.

What's left is the part you actually wanted all along — the type *checker* — reassigned from code generator to gate. `tsc --noEmit` doesn't produce anything; it verifies, exactly like a linter or a test suite, and execution never waits for it.

This post walks that model end to end: what the build step historically bought, what running the source actually means, what it does to a monorepo, and how you still publish to npm at the end. The receipts come from [efferent](https://github.com/xandreeddev/efferent), a coding agent CLI built on Effect and Bun — four workspace packages, a terminal UI with a native renderer, SQL migrations, an npm package with a `bin` — every awkward thing that supposedly forces a build pipeline, shipping without one.

## What the build step bought — and what it bills

Be fair to the pipeline first. The classic TypeScript build performed three genuinely necessary services:

- **Type erasure.** TypeScript's types don't exist at runtime; something has to strip them before a JavaScript engine will parse the file. That something was `tsc`, later babel or esbuild or swc — different tools, same job: rewrite every file you save into a file you didn't.
- **Module-format lowering.** You wrote ES modules; the ecosystem ran CommonJS; for years a respectable library emitted both. The dual-package matrix was an entire genre of build configuration.
- **Bundling.** Collapsing a dependency tree into one artifact that runs without `node_modules` — the legitimate need behind shipping a CLI.

All three were real. The question is the daily bill, because you pay it on every save, not once at release:

```json
{
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsc --watch & nodemon dist/index.js",
    "prepublishOnly": "npm run build"
  }
}
```

That sketch is thousands of repos, and every line leaks. The `dist/` on the run path creates the **stale-dist class of bug**: the program's behavior comes from an artifact, not from your source, and the two drift the moment a watcher hiccups or a teammate forgets to rebuild — you end up debugging code you already fixed, which is among the most demoralizing ways to lose an afternoon. Source maps exist as an entire technology whose only purpose is to *undo* the transformation you just applied, so stack traces can point back at the files you actually edit — and they still break at the worst moments. Dev mode is a watcher process babysitting a runner process. And because dev typically runs through `ts-node` or `tsx` while production runs the emitted `dist/`, you get **dev/prod skew**: two module resolutions, two artifacts, two sets of bugs, one of which only appears after deploy.

Each cost compensates for a single upstream decision: *the code that runs is not the code you wrote.* Remove that decision and the compensations go with it.

## The Bun model: the file you edit is the program

Bun's runtime embeds a transpiler — the component that rewrites TypeScript syntax into JavaScript — directly in the module loader. When an import resolves to a `.ts` file, the types are stripped in memory, on load, and nothing is written to disk. There is no artifact because there is no output. "Compile" stops being a phase of your project and becomes an implementation detail of `import`, the same way you don't think about JavaScript being parsed.

Here's what a project looks like when that's true. The root scripts of [efferent](https://github.com/xandreeddev/efferent), in full:

```json title="package.json" {3}
{
  "scripts": {
    "dev": "bun --hot packages/cli/src/main.ts",
    "start": "bun packages/cli/src/main.ts",
    "build": "bun run scripts/build.ts",
    "eval": "bun packages/evals/src/run.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

Read it for what's missing. `dev` and `start` point at the same file — the actual source entrypoint — and differ only in that `--hot` swaps modules in place when you save. No watcher compiling into a directory, no `nodemon` watching the watcher, no `main` field aimed at `dist/`. The `build` script exists, but nothing else references it; we'll get there, and it's the boundary of the system, not the center.

The entrypoint itself is directly executable, because a shebang works on a `.ts` file when the interpreter understands TypeScript:

```ts title="packages/cli/src/main.ts"
#!/usr/bin/env bun // [!code highlight]
import { Args, Command, Options } from '@effect/cli'
import { BunContext, BunRuntime } from '@effect/platform-bun'
// …
```

And the development "binary" — the thing on `PATH` while hacking on the agent — is a bash wrapper of exactly two lines:

```bash
#!/usr/bin/env bash
exec bun "$(cd "$(dirname "$0")/.." && pwd)/packages/cli/src/main.ts" "$@"
```

That's `bin/eff` in the repo, verbatim. Edit a file, run `eff`, and the behavior is the edit. There is no state of the world in which the program you observe and the program you wrote disagree — which sounds like a small guarantee until you remember how many tools exist to paper over its absence.

## tsc, configured to emit nothing

So where did the compiler go? Into the gate. Here's the shared compiler configuration, trimmed to its load-bearing lines:

```json title="tsconfig.base.json" {12}
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noEmit": true
  }
}
```

`noEmit: true` tells `tsc` to produce no output files, ever — and once it does, every other option changes meaning. `target` and `module` no longer describe an artifact to generate; they describe which syntax the *checker* should accept, and both are set to `ESNext` because there's no downlevel-for-old-runtimes story when the runtime is pinned. `moduleResolution: "bundler"` makes the checker resolve imports the way modern runtimes do — honoring `exports` fields, not demanding file extensions. Everything else in the file is verification strictness: `noUncheckedIndexedAccess` making array indexing honest, `exactOptionalPropertyTypes` distinguishing "absent" from "undefined". The compiler has been demoted from manufacturer to inspector, and the inspection got *stricter*, because strictness no longer costs build time on the run path.

The two flags worth a second look are `isolatedModules` and `verbatimModuleSyntax`. Together they enforce that every file can be transpiled *alone*, with no knowledge of any other file — type imports must be marked `import type`, no cross-file `const enum` inlining, nothing whose erasure requires whole-program analysis. That's not stylistic preference; it's the contract the entire model rests on. A per-file load-time transpiler can only be correct for code where erasure is per-file. These flags make the compiler reject anything outside that subset, which means the gate is also guarding the assumption the runtime depends on.

Where does the gate actually run? In [efferent](https://github.com/xandreeddev/efferent) it's the first of two commands the README names "the correctness gates":

```bash
bun run typecheck && bun test   # the correctness gates (no build step for dev)
```

There's no CI directory in the repo yet; the gates run from the working tree — before a commit, after a refactor, and (more on this below) by the agent itself after every change it makes. The repo's own architecture doc states the convention in one line: *"Bun runs `.ts` directly. No build step, no emit. `tsc --noEmit` is purely a typecheck gate."*

One consequence of the decoupling deserves to be said plainly: **code that fails to typecheck still runs.** Execution never consults the checker. Mid-refactor, with forty type errors across the workspace, you can still run the one test you care about — the checker has opinions, not a veto, until you ask for the verdict. That's genuinely useful, and it's also the model's sharp edge: nothing *forces* the gate. A gate nobody runs is a gate that doesn't exist, which is precisely why it belongs in the same breath as the test suite rather than tucked into a build nobody reads.

## The monorepo dividend

If you've run a multi-package TypeScript repo the traditional way, you know the project-references dance. **Project references** are `tsc`'s mechanism for splitting a codebase into separately compiled units: each package gets `composite: true`, emits declaration files, declares which other packages it references, and `tsc --build` walks the graph in dependency order. It works. It is also a second dependency graph you maintain by hand, a build-order constraint solver in your editor, and a steady tax of "why is this package seeing stale types" — answered, always, by rebuilding.

With no emit anywhere, a workspace package stops being a compilation unit and becomes *a name for a folder of source*. Here is the entire interface of [efferent](https://github.com/xandreeddev/efferent)'s core domain package:

```json title="packages/core/package.json" {6,7}
{
  "name": "@efferent/core",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./*": "./src/*.ts"
  }
}
```

The `exports` field — the map that tells a resolver which file each import specifier means — points straight at TypeScript source. When `packages/cli` imports `@efferent/core`, Bun resolves through the workspace symlink in `node_modules`, lands on `src/index.ts`, and transpiles it on load like any other file. The type checker reaches the same files through `paths` mappings in `tsconfig.base.json` (`'@efferent/core': ['packages/core/src/index.ts']`) — the same fact, restated in the checker's dialect. And the root `tsconfig.json` checks everything as one flat program:

```json title="tsconfig.json"
{
  "extends": "./tsconfig.base.json",
  "include": ["packages/*/src/**/*"]
}
```

Four packages — `core`, `adapters`, `cli`, `evals` — one `tsc` invocation, zero build orchestration. Change a port signature in `core` and the call sites in `cli` are red *immediately*, in the editor, with no intermediate "rebuild core's declarations" step, because there are no declarations. The packages keep their dependency direction (`cli` → `adapters` → `core`, strictly inward) through import discipline checked by that one flat program — not through build-order machinery. There is no build order because there are no builds.

The dividend compounds with repo size. Every piece of per-package ceremony — `composite`, `outDir`, `references`, declaration maps, the incremental-build cache that sometimes lies — exists to coordinate *emit* across packages. Subtract emit and the coordination problem isn't solved; it's gone.

## Publishing anyway: one build, at the boundary

The model has to survive contact with npm, because users don't clone monorepos — they run `npm i -g efferent` and expect a binary. Distribution is the one legitimate job the bundler has left, and it's worth looking at exactly what the published artifact is, because it inverts the usual `package.json` logic:

```json title="packages/cli/package.json" {12,13}
{
  "name": "efferent",
  "bin": { "efferent": "dist/efferent.js", "eff": "dist/efferent.js" },
  "files": ["dist"],
  "engines": { "bun": ">=1.2.0" },
  "scripts": {
    "build": "bun run ../../scripts/build.ts",
    "prepublishOnly": "bun run build"
  },
  "dependencies": {
    "@opentui/core": "0.3.1",
    "web-tree-sitter": "0.25.10"
  },
  "devDependencies": {
    "@efferent/adapters": "workspace:*",
    "@efferent/core": "workspace:*",
    "effect": "^3.21.2"
    // …@effect/ai, @effect/cli, @effect/platform-bun, solid-js, @opentui/solid
  }
}
```

Read the dependency sections twice, because they're upside down. `effect`, the entire `@effect/*` constellation, `solid-js`, the workspace packages — the whole program — sit in `devDependencies`, which npm does not install for consumers. The two-entry `dependencies` list isn't describing what the program imports; it's describing **the holes in the bundle** — the only pieces that must exist on the user's disk because they couldn't be inlined. Everything else ships *inside* `dist/efferent.js`.

That file is produced by the only build script in the repository, which runs at exactly one moment — `prepublishOnly`, npm's hook before packing a release:

```ts title="scripts/build.ts"
const result = await Bun.build({
  entrypoints: [join(root, 'packages/cli/src/main.ts')],
  outdir: join(root, 'packages/cli/dist'),
  naming: 'efferent.js',
  target: 'bun',
  external: ['@opentui/core'], // [!code highlight]
  plugins: [(await import('@opentui/solid/bun-plugin')).createSolidTransformPlugin()],
})
```

`Bun.build` is Bun's bundler as a programmatic API — and the script uses the API rather than the `bun build` CLI for a concrete reason recorded in its header comment: the TUI's Solid JSX needs a real transform plugin, and the CLI ignores `bunfig.toml` preload plugins at build time; only the programmatic `plugins` array applies. `target: 'bun'` declares the output is *for Bun*, not Node — the bundle keeps the `#!/usr/bin/env bun` shebang from `main.ts` (so npm's bin shim execs Bun) and opens with a `// @bun` pragma marking it as already transpiled. The result is a single self-contained file — about 5.5 MB, a hair over a hundred thousand lines — that is the entire product. Even the SQL migrations ride inside it: they're registered as a static map via `Migrator.fromRecord` rather than read from a migrations directory, precisely so nothing has to exist on disk at runtime (the zero-config storage design behind that is a post of its own).

So in the project's whole life, "build" happens for roughly the ninety seconds before `npm publish`. `dist/` is gitignored. Nobody develops against it, no watcher maintains it, no bug report ever traces to its staleness — it's not a phase of the project, it's a packaging format, the same way a `.tar.gz` is.

### The two dependencies that survive

Why two holes? Because both sit on the one boundary a JavaScript bundler genuinely cannot cross: code that loads things *by filesystem path at runtime* instead of *by import at build time*.

**`@opentui/core`** is the terminal renderer, and its hot path is a native Zig library loaded through FFI — `dlopen()` of `@opentui/core-<platform>/libopentui.so`, with the path resolved relative to the package's own install location. You can't inline a shared object into a JavaScript file, and you can't relocate the JavaScript that locates it, because its resolution logic assumes it's sitting in `node_modules` next to its platform-specific sibling package. So the whole package stays external — the single entry in the `external` array, the line highlighted above. (What the renderer does with that native library at runtime — the FFI surface, the render loop — is a post of its own; here it matters only as the thing a bundle can't swallow.)

**`web-tree-sitter`** is the subtler case: it isn't in the `external` list *at all*, because no source file in the repo imports it — search the codebase and you'll find only type-level mentions. The TUI's syntax highlighting asks `@opentui/core` for its tree-sitter client, which spawns a parser **worker** that loads `web-tree-sitter` and its grammar `.wasm` files from disk, resolved from the package's install directory. The bundler never sees any of that in the import graph; there's nothing to inline and nothing to externalize. The package appears in `dependencies` — pinned to the exact version the worker expects — purely so `npm install` materializes it on disk where the runtime resolution will find it.

There's a transferable rule hiding in those two cases: **a bundle's boundary is wherever resolution leaves JavaScript** — native libraries reached by `dlopen`, WASM reached by path, workers spawned by filename. Inline everything up to that line; declare everything past it. [efferent](https://github.com/xandreeddev/efferent)'s README states the result as a sentence — "a Bun bundle with two runtime dependencies; everything else is inlined" — and the sentence is auditable from the build script.

## The inner loop, in the agent era

One more pressure makes this model timely rather than just tidy. A coding agent iterating on a codebase lives inside the edit → run → verify loop thousands of times a session, and every second of build latency lands in the middle of it — multiplied. With no build phase, the loop an agent runs against [efferent](https://github.com/xandreeddev/efferent)'s own source is: edit the file, run the file, then `bun run typecheck && bun test` as the verdict (the test suite is 440+ colocated `bun test` files, property-based tests included — their design is a post of its own).

The subtler win is what *can't* happen. The stale-dist bug is uniquely vicious for an agent: it edits the source, observes unchanged behavior from an artifact that wasn't rebuilt, concludes the edit was wrong, and "fixes" correct code — a confusion loop a human escapes by remembering the build exists, which is exactly the kind of out-of-band knowledge agents lack. A world where the source *is* the program removes the trap structurally. The type gate plays the same role for the agent as for CI: a cheap, total verdict it can converge against before any human looks at the diff.

## What it costs

The honest ledger, because there is one.

**Bun is a hard requirement for your users, not just for you.** `npm i -g efferent` succeeds on a machine with no Bun installed — npm doesn't act on an `engines.bun` field; it's documentation — and then the first run dies at the shebang with `env: 'bun': No such file or directory`. The README leads with "requires Bun" for exactly this reason. For a developer-tool audience the ask is small, but it's real: you're shipping to the subset of users willing to have a second runtime. And note this isn't a tax you could trivially refund later — [efferent](https://github.com/xandreeddev/efferent) uses `bun:sqlite` through `@effect/sql-sqlite-bun` and boots with `BunRuntime`; the runtime choice is load-bearing in the code, not a compile flag away from Node compatibility.

**You live in the erasable subset — by discipline, not by force.** Bun's transpiler actually handles full TypeScript, enums included; it transforms rather than merely strips. But the model is only airtight inside the subset where erasure is per-file, and the place that breaks isn't Bun — it's the ecosystem of TypeScript features whose semantics historically came from `tsc`'s *emit*: cross-file `const enum` inlining, `emitDecoratorMetadata` feeding runtime reflection. The repo holds the line structurally — `isolatedModules` and `verbatimModuleSyntax` in the config, zero enums and zero decorators in the source. If your codebase leans on decorator metadata the way NestJS or TypeORM idioms do, this model is not for you without a migration first.

**There's one asterisk on "run the source," and it's JSX.** The TUI is written in Solid JSX, which is a real compile — Solid rewrites JSX into fine-grained reactive DOM (well, terminal) updates; no amount of type-stripping produces that. So the repo carries one transform, declared visibly: a `bunfig.toml` preload registers the Solid plugin scoped to `.tsx`/`.jsx` files only (plain `.ts` everywhere stays untouched), the build script applies the same plugin programmatically, and `bun test` needs its own `[test] preload` entry because the test runner doesn't read the top-level one. One transform, two declaration sites, a comment explaining each. That's the honest version of "no build step": *no build artifacts on the run path*, with one in-memory transform where a DSL genuinely requires it.

**You're trusting one bundler's compatibility surface.** The classic `tsc`-emit pipeline is the most-trodden path in the ecosystem; `Bun.build` is newer, and dependency edge cases surface as *your* problem. The repo has a receipt: the build script's comment notes the Solid plugin also performs solid-js's server-to-client entry swap, because bundling resolved the wrong package condition by default. Package exports conditions are exactly where bundlers betray you silently, and a publish-time bundle means you find out at publish time.

**The dev/prod skew is compressed, not abolished.** Users run a bundle you never run during development. The skew that used to live on every save now lives at one boundary, produced by one script at one moment — vastly better odds, same engine on both sides — but a bundle-only bug remains a class of bug you can ship. The mitigation is unglamorous: run the bundled artifact before publishing, treat it like any other release candidate.

## Verify or produce

Here's the lens this whole setup left me with. Every stage in a pipeline does one of two things: it **verifies** (types, tests, lint) or it **produces** (transpile, bundle, emit). The historical sin of the TypeScript build step was fusing them — you couldn't get the verification without paying for the production, on every save, in the middle of your tightest loop. Bun unfuses them. Verification becomes a gate you run when a verdict matters; production becomes a packaging concern that fires once, at the boundary, ninety seconds before the tarball.

So my default has inverted, and I'd argue yours should too: a new TypeScript CLI in 2026 starts with no build step, and every piece of production machinery has to argue its way back in. In [efferent](https://github.com/xandreeddev/efferent), exactly two things made the case — one Solid JSX transform and one publish-time bundle — and both had to show receipts. Everything else is just the file you wrote, running.
