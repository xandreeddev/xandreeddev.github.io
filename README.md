# xandreed.dev

Source for [xandreed.dev](https://xandreed.dev) — writing on Effect, agents, and
evals. Built alongside [efferent](https://github.com/xandreeddev/agent), an
open-source coding agent on Effect.ts, which the posts draw their examples from.

**No React. No framework JavaScript.** Hand-written CSS, two small inline scripts
(style switcher, code-copy buttons), and one opt-in exception: the `vector` and
`sodium` styles each lazy-load a vanilla Three.js chunk and turn the site into
a game — a flyable star system and a night drive.

## Quickstart

```bash
bun install
bun run dev      # localhost:4321 — drafts visible
bun run build    # static build to dist/ — drafts excluded
bun run preview  # serve the build locally
```

Deploys are automatic: every push to `main` builds and publishes to GitHub Pages
on the custom domain. **Push = publish** — there is no scheduling; a future
`pubDate` goes live with the next push.

## Stack

- [Astro 5](https://astro.build) — static output, content collections
- Plain Markdown — no CMS, no MDX
- [Shiki](https://shiki.style) dual-theme highlighting with diff / highlight / `title=""` notations
- [Bun](https://bun.sh) for everything

## Writing a post

Drop a Markdown file in `src/content/posts/`:

```md
---
title: 'Post title'
description: 'One-sentence lede shown in lists and meta tags.'
pubDate: 2026-06-12
tags: [effect, agents] # lowercase single words — used raw in URLs
draft: true # visible in dev; excluded from build, RSS, sitemap
---
```

Code fences take `title="path/to/file.ts"` plus `[!code highlight]` and
`[!code ++]` / `[!code --]` line notations.

## Seven design systems, one switcher

The header switcher swaps the entire visual identity live — typography, layout,
decoration, motion — not just a palette. Choice persists in `localStorage`;
first visit follows `prefers-color-scheme` (dark → phosphor, light → gazette).

| style    | mood               | type                          |
| -------- | ------------------ | ----------------------------- |
| phosphor | terminal editorial | Newsreader · JetBrains Mono   |
| gazette  | print issue        | Fraunces · Libre Franklin     |
| aurora   | signal lab         | Syne · Hanken · Victor Mono   |
| zine     | xerox riot         | Archivo · Space Mono          |
| system   | retro desk         | Silkscreen · Chivo · Fragment |
| vector   | context overworld  | VT323 · JetBrains Mono        |
| sodium   | night drive        | Michroma · Outfit · Martian   |

Each style is one file in `src/styles/` overriding the token contract declared
in `global.css` (colors, fonts, radii, border weights) plus its own signature
moves under `[data-style="…"]`. The base renders complete with JS disabled, and
the browser only downloads the fonts the active style uses.

## vector: the blog as a game

Pick **vector** and the homepage becomes a flyable wireframe star system —
every post is a planet on procedurally seeded orbit shells (any post count
works; the newest sits innermost), with a dashed chronology route threading
them oldest → newest.

- **Fly** — click the void for pointer lock: mouse aims, `W` thrusts, `shift`
  boosts, `S` brakes, `space` fires lasers with target lead, `E` sends a homing
  missile at the auto-locked target, `esc` releases. Full touch support on
  iPad / iPhone / Android: virtual stick on the left, thumb cluster on the
  right, pinch/double-tap zoom suppressed.
- **Fight** — asteroids drop scrap and score, interceptors start hunting as
  your score climbs, docking at a planet repairs. Best score sticks.
- **Progress** — reading an article banks a ⬡ core for the ability tree (`T`):
  offence / defense / ai branches, resettable for a full refund. Offence builds
  the manual guns; defense runs from a depleting shield with reboot charges to
  the afterburner; the ai branch installs autonomous modules — a sentry turret,
  plasma-burn rounds, a missile autoloader — and support nodes that overclock
  them. Every hit shows its number; every enemy carries its health bar.
- **Transit runs** — portal rings at the system edge open infinite procedural
  tunnels: four challenge kinds (gauntlet, slalom, hunt, surge) that scale with
  a persistent run level, ending in a free-flight arena against the warden —
  boss bar, escort waves and all. Win and every portal levels up.
- **Sound** — every effect synthesized in WebAudio, zero assets. `M` mutes.

Ship state and score survive article round-trips. The world reads the post
list straight from the DOM, mounts and unmounts live with the switcher, and
the other styles never pay for it. No WebGL? The CRT fallback is a
complete theme on its own.

## sodium: the night drive

Pick **sodium** and the homepage becomes a nocturne you drive through: a ring
road around a lake, lit by sodium streetlights under a custom-shader sky
(stars, moon, a faint aurora). Every post is a billboard exit on the shoulder
— dark static until you pull up close, when it boots into a glowing card.
Discovery is the game: `docs n/m discovered`, persisted.

- Real-time moonlight shadows (PCFSoft) that follow the car, planar-reflective
  water with procedurally generated wave normals, wind turbines turning over
  the lake, drifting clouds, fireflies, sky-matched reflections on the paint.
- Arcade-honest car physics: lateral grip you can break with the handbrake
  (`space`), suspension lean, speed-dependent steering, FOV that widens with
  speed. `W` gas, `S` brake/reverse, `A/D` steer. Touch: stick steers, gas
  latches, brake/drift hold.
- Engine and tyre-skid audio synthesized in WebAudio — zero assets, `M` mutes.
- Drive into the lake and you get fished out. The car position survives
  article round-trips. Same lazy-chunk rule: only sodium pays for it.
