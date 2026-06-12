# xandreed.dev — blog

Astro 5 static site, built with Bun, deployed to GitHub Pages at https://xandreed.dev
on every push to `main`. **No React, no framework JS** — hand-written CSS and two small
inline scripts; the one exception is the lazy-loaded vanilla Three.js chunks for the
`vector` and `sodium` styles. That constraint is part of the site's identity, not an
accident.

## Commands

```bash
bun run dev      # localhost:4321 — drafts visible
bun run build    # static build to dist/ — drafts excluded
bun run preview
```

There is no test suite or linter. Verification = `bun run build` succeeds + visual check
in dev. When touching the vector world or touch controls, test with real pointer events
(headless Chromium with `hasTouch` works).

## Map

| Path | Role |
| --- | --- |
| `src/layouts/Base.astro` | Head/SEO, font imports per style, FOUC-guard inline script, header + style switcher, copy-button injector, lazy world bootstrap |
| `src/pages/index.astro` | Homepage — intro + posts grouped by UTC year |
| `src/pages/posts/[id].astro` | Post page — TOC, reading time, tags, draft badge, older/newer nav |
| `src/pages/tags/[tag].astro` | Tag listings (tags derived from non-draft posts in prod) |
| `src/pages/rss.xml.js` | RSS endpoint, own draft filter |
| `src/pages/404.astro` | Terminal-styled 404; inline script echoes `location.pathname` |
| `src/components/PostRow.astro` | Whole-row post link (date, title, description) |
| `src/components/Toc.astro` | h2/h3 TOC; desktop `<nav>` + mobile `<details>`, rendered only with ≥2 headings |
| `src/utils/posts.ts` | `getPosts()` (draft filter + desc sort), `isoDate`, `readingTime` |
| `src/content.config.ts` | `posts` collection schema |
| `src/styles/` | `global.css` = token contract + default style (phosphor); one file per other style |
| `src/scripts/vector-world.js` | The flyable star system (~2.5k lines), lazy-loaded only for `vector` |
| `src/scripts/sodium-world.js` | The night-drive game (~1.5k lines), lazy-loaded only for `sodium` |
| `.github/workflows/deploy.yml` | Build with Bun (frozen lockfile) → upload-pages-artifact → deploy-pages |

## The style system (core invariant)

Seven design systems switched live via `data-style` on `<html>`: **phosphor**
(default, dark), **gazette** (light), **aurora** (dark), **zine** (light),
**system** (light), **vector** (dark), **sodium** (dark). Choice persists in `localStorage.style`; first visit follows
`prefers-color-scheme` (light → gazette, dark → phosphor). A pre-paint inline script in
`Base.astro` sets the attribute before first render — keep it inline and first.

`global.css` `:root` declares the **token contract** every style must fully re-declare
under `[data-style='…']`:

- 11 colors: `--bg --surface --surface-2 --border --text --text-2 --text-3 --accent
  --accent-dim --ok-dim --bad-dim`
- 3 font stacks: `--font-body --font-display --font-mono`
- shape: `--radius-s --radius-m --border-w`, plus `--display-weight`
- also required in practice: `color-scheme`, the `.brand-mark::before` / `.sw-glyph::before`
  glyph, and a light-theme flip of the Shiki vars (see below)

The fluid type scale (`--step-*`), `--w-prose`, and `--pad-inline` are shared from
`:root` — don't fork them per style. Structural CSS (header, prose, code blocks) lives
once in `global.css`; style files only override tokens and add signature moves.
Adding a style also means: an entry in `STYLES` in `Base.astro` (dots are hand-copied
oklch values — keep them in sync with the tokens), font imports at the top of
`Base.astro`, the `known` array in the FOUC script, and a row in `README.md`.

## Code blocks

Shiki dual theme: `github-light` / `vesper` with `defaultColor: false`. `global.css`
maps tokens to `var(--shiki-dark)` (dark is the default); each light style flips to
`var(--shiki-light)`. Every style forces the `pre` background with `!important` to beat
Shiki's inline style — that's deliberate. Fences support `title="path"` (custom
transformer in `astro.config.mjs`) plus `[!code highlight]`, `[!code ++]`, `[!code --]`.

## Content

Posts are plain Markdown in `src/content/posts/`:

```yaml
title: '…'
description: 'One-sentence lede for lists and meta tags.'
pubDate: 2026-06-12
tags: [effect, agents]   # lowercase single words — tags are used raw as URL segments
draft: true              # visible in dev; excluded from build, RSS, sitemap, tag pages
```

There is **no future-date scheduling**: a post with tomorrow's `pubDate` publishes on
the next push. Commit a post to `main` only when it should go live.
`typography-test.md` is a permanent kitchen-sink draft — never remove its `draft: true`.

## Vector world

`vector-world.js` is mounted/unmounted live as the user switches styles
(`mod.mount()` returns `{ unmount }`; a `MutationObserver` in `Base.astro` drives it).
Rules that keep it healthy:

- Every listener goes through the mount's `AbortController` signal; `unmount()` must
  stay idempotent and dispose Three.js resources (`disposeObject`, bloom pass,
  `forceContextLoss`). Glow textures and the missile material are shared/cached for
  the page lifetime — disposal skips anything with `userData.shared`.
- The DOM is the source of truth: the world reads `.post-row` elements. Homepage =
  world mode; post pages = ambient mode with a return chip. Planet layout is
  procedural — shells of six, seeded from post slugs (`hash01`) — so any post count
  works without touching the code; the newest post takes the innermost slot.
- Desktop input is pointer-lock + mouse-follow; touch is a virtual stick (left ~60% of
  the screen, quadratic response curve) + right-thumb cluster (`data-vt-*` buttons;
  thrust latches, boost holds). Touch must never feed the mouse-follow path or call
  `requestPointerLock`; pinch/double-tap zoom is suppressed in world mode (gesture
  events + body `touch-action: none`).
- Game state: reading a post banks a ⬡ core (`vector-visited`); the ability tree
  spends them (`vector-tree`) across three branches — offence / defense / ai (auto
  modules: sentry turret, igniter burn, missile autoloader, plus support nodes that
  speed them up) — and is fully resettable for a refund. You start with the base
  laser + parry only. Scrap / best score / run level (`vector-runlvl`) / mute
  persist in localStorage; the full ship state + session score round-trip article
  visits and style flips via sessionStorage (`vector-ship`, saved on pagehide and
  unmount).
- Portals at the system edge open transit runs — infinite and procedural: seeded
  with `mulberry()` from `portal index + run level`, one of four challenge kinds
  (gauntlet / slalom / hunt / surge), difficulty scaling with the level, ending in
  a separate free-flight boss arena (the tube group is disposed and rebuilt as the
  cage). Victory bumps the persistent level and relabels the portals. Never use
  `Math.random` for anything that must look the same across visits.
- HUD panels (`.vh-boss` etc.) set `display` explicitly, which beats the UA
  `[hidden]` rule — every such panel needs an explicit `[hidden] { display: none }`
  pair. Damage pops and enemy hp bars render with `depthTest: false` — they spawn
  at the surface of the thing they hit, so depth-tested sprites lose to their own
  target and never show.
- Projectile collision is swept (segment-vs-sphere via `sweepHit`), never
  point-sampled — fast bolts tunnel through small targets otherwise.
- Sound is synthesized WebAudio (`makeAudio`), created lazily on the first user
  gesture; `M` and the HUD button mute (persisted).
- Keep it a lazy dynamic import — the other styles must never pay for Three.js.

## Sodium world

`sodium-world.js` follows the same mount/unmount contract via the `WORLDS` map in
`Base.astro` (one world active at a time, swapped live by the switcher):

- Drive-to-discover: billboards along the ring road render a scrambled "?" face
  until the car gets within range; discovery persists (`sodium-found`), and reading
  an article counts too. Car state round-trips via sessionStorage (`sodium-car`).
- Toy-world look (bruno-simon-style night): checker-tile ground texture, flat-shaded
  merged-blob tree canopies (`mergeGeometries`), ~700 instanced grass tufts — when
  filling an InstancedMesh, never skip a slot: an unset instance renders at the
  origin (mid-lake). All textures stay canvas-procedural.
- Knockables (pin clusters + the box-built XANDREED letters) share one toy-physics
  pool: they are NOT in `colliders` — the car drives through and applies an impulse;
  rest height follows orientation via `|localY·up|` so props settle standing or
  lying without a solver. Letter strokes: `rotation.z` is CCW from the front, and
  screen-right from the road is *decreasing* ring angle — both signs flip glyphs or
  the whole word into mirror writing.
- The lake uses `three/addons` `Water` with a procedurally generated normal map —
  no texture assets anywhere; billboard faces and HUD textures are canvas-drawn
  (redrawn after `document.fonts.load`, Michroma/Outfit).
- The sky ShaderMaterial doubles as the PMREM environment so metals reflect the
  horizon. The moon DirectionalLight follows the car texel-snapped to avoid
  shadow shimmer. Mute persists in `sodium-mute`.
- Scratch-vector discipline: the chase camera has a dedicated `camLook` — aliasing
  `tmpV`/`fwd` here caused a camera bug once already.
- Rendering (applies to both worlds): the EffectComposer bypasses the canvas's
  MSAA, so each composer renders into a multisampled HalfFloat target — drop the
  `samples` option and every edge becomes a staircase. Sodium's grade pass
  (vignette / grain / chromatic aberration) must stay AFTER `OutputPass`,
  display-referred: additive grain in linear HDR lifts night blacks into gray
  haze. No volumetric headlight cones — the chase camera looks straight down the
  beam axis, so an additive cone reads as a permanent blob mid-screen.

## Deploy / domain

Custom domain `xandreed.dev` is set in repo settings and pinned by `public/CNAME`;
`site` in `astro.config.mjs` must stay `https://xandreed.dev` (canonicals, RSS, sitemap
derive from it). The workflow builds with `bun install --frozen-lockfile` — update
`bun.lock` in the same commit as `package.json` changes.

## Repo hygiene

- Root-level `*.png` and `PROMPT.md` are gitignored local working notes / QA
  screenshots — never force-add them. Tracked images belong in `public/`.
- Dates are UTC everywhere (`isoDate`, year grouping) — keep it that way.
