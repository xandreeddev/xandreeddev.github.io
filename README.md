# xandreed.dev

Source for [xandreed.dev](https://xandreed.dev) — writing on Effect, agents, and evals,
published alongside [efferent](https://github.com/xandreeddev/agent), an open-source
coding agent built on Effect.ts.

**No React.** No framework JavaScript at all, in fact. The site ships hand-written CSS
and two small inline scripts (style switching and copy buttons). The one exception is
opt-in: the `vector` style lazy-loads a vanilla Three.js chunk — only when you pick it —
and turns the homepage into a flyable star system.

## Stack

- [Astro 5](https://astro.build) — static output, content collections
- Plain Markdown posts — no CMS, no MDX
- [Shiki](https://shiki.style) dual-theme highlighting with diff/highlight notations
- [Bun](https://bun.sh) for everything

## Six design systems, one switcher

The header switcher swaps the entire visual identity live — typography, layout,
decoration, motion — not just a palette. Choice persists in `localStorage`; first
visit follows `prefers-color-scheme` (dark → phosphor, light → gazette).

| style    | mood               | type                          |
| -------- | ------------------ | ----------------------------- |
| phosphor | terminal editorial | Newsreader · JetBrains Mono   |
| gazette  | print issue        | Fraunces · Libre Franklin     |
| aurora   | signal lab         | Syne · Hanken · Victor Mono   |
| zine     | xerox riot         | Archivo · Space Mono          |
| system   | retro desk         | Silkscreen · Chivo · Fragment |
| vector   | context overworld  | VT323 · JetBrains Mono        |

In **vector**, the blog is efferent's context tree as a star system you fly: the
core is the sun, every post is a wireframe planet (one moon per tag, amber if
draft) on procedurally generated orbit shells — the layout is seeded from post
slugs and scales to any number of articles, newest innermost. Click the void to
take the stick (pointer lock) — mouse aims, `W` thrusts, `shift` boosts,
`space`/click fires lasers with target lead, `E`/right-click sends a homing
missile at the auto-locked target, `S` brakes, `A`/`D` roll, `esc` releases. On
touch screens (iPad / iPhone / Android) the left half of the screen is a virtual
stick and a right-thumb cluster handles thrust (toggle), boost, brake, fire and
missiles — pinch/double-tap zoom is suppressed while flying, and tapping a
planet still opens it. An asteroid belt drifts between the orbits; rocks drop
scrap and score, interceptors start hunting once your score climbs, and docking
at a planet repairs. **Reading an article banks a ⬡ core to spend in the ability
tree** (`T`): guns / drive / hull branches with visible ship components — twin
cannons, missile pods, lance coils, afterburner, swept wings, reflex gyros, a
regenerating deflector shield, gilded hull, nanoreactor. Portal rings at the
system edge open **seeded transit runs**: a generated tunnel of obstacles and
boost gates with a warden boss at the far end. Ship state and score survive
article round-trips; the best score sticks. All sound is synthesized WebAudio
(`M` mutes) — no audio assets. Click a planet (or dock and press `↵`) to open
the article. Article pages keep a quiet ambient field behind a readable HUD
panel, with a "return to system" chip (`esc` works too). The world reads the
post list straight from the DOM, mounts/unmounts live with the switcher, and
the other styles never pay for it. No WebGL? The CRT fallback is a complete
theme on its own.

Each style is one CSS file in `src/styles/` that overrides a token contract
(colors, fonts, radii, border weight) plus its own signature moves under
`[data-style="…"]`. The base in `global.css` is fully usable with JS disabled.
Fonts are declared for every style but the browser only downloads the families
the active style renders with.

## Writing a post

Drop a Markdown file in `src/content/posts/`:

```md
---
title: 'Post title'
description: 'One-sentence lede shown in lists and meta tags.'
pubDate: 2026-06-12
tags: [effect, agents]
draft: true # visible in dev, excluded from build/RSS/sitemap
---
```

Code fences support `title="path/to/file.ts"` plus `[!code highlight]`,
`[!code ++]` / `[!code --]` line notations.

## Commands

```bash
bun install
bun run dev      # localhost:4321 (drafts visible)
bun run build    # static build to dist/ (drafts excluded)
bun run preview
```
