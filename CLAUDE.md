# xandreed.dev — blog

Astro 5 static site, built with Bun, deployed to GitHub Pages at https://xandreed.dev
on every push to `main`. **No React, no framework JS** — hand-written CSS and two small
inline scripts; the one exception is the lazy-loaded vanilla Three.js chunks for the
`vector`, `sodium` and `canopy` styles. That constraint is part of the site's identity,
not an accident.

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
| `src/layouts/Base.astro` | Head/SEO, font imports per style, FOUC-guard inline script, prod-only GoatCounter analytics snippet, header + style switcher, copy-button injector, lazy world bootstrap |
| `src/pages/index.astro` | Homepage — intro + posts grouped by UTC year |
| `src/pages/posts/[id].astro` | Post page — TOC, reading time, tags, draft badge, older/newer nav, series banner |
| `src/pages/tags/[tag].astro` | Tag listings (tags derived from non-draft posts in prod) |
| `src/pages/series/[name].astro` + `index.astro` | Per-series index + the series directory; ordered parts, full arc incl. drafts (`index.astro` runs `assertSeriesIntegrity`) |
| `src/pages/rss.xml.js` | RSS endpoint, own draft filter |
| `src/pages/404.astro` | Terminal-styled 404; inline script echoes `location.pathname` |
| `src/components/PostRow.astro` | Whole-row post link (date, title, description, series hint) |
| `src/components/SeriesBanner.astro` | Top-of-post series box: "Part N of M" + ordered part list (live → /posts, drafts → /drafts); renders only with ≥2 parts |
| `src/components/Toc.astro` | h2/h3 TOC; desktop `<nav>` + mobile `<details>`, rendered only with ≥2 headings |
| `src/utils/posts.ts` | `getPosts()`/`getDrafts()`/`getAllPosts()`, `isoDate`, `readingTime`, series helpers (`seriesPosts`/`allSeries`/`toSeriesParts`/`seriesSlug`/`assertSeriesIntegrity`) |
| `src/content.config.ts` | `posts` collection schema (incl. optional `series: { name, order }`) |
| `src/styles/` | `global.css` = token contract + default style (phosphor); one file per other style |
| `src/scripts/vector-world.js` | The flyable star system (~2.5k lines), lazy-loaded only for `vector` |
| `src/scripts/sodium-world.js` | The night-drive game (~1.5k lines), lazy-loaded only for `sodium` |
| `src/scripts/canopy-world.js` | The forest action-RPG (~2.8k lines), lazy-loaded only for `canopy` |
| `public/models/canopy/` | Meshy-generated rigged GLBs for canopy (hero/gremlin/ogre/axe + animation clips) |
| `tools/optimize-glb.mjs` | GLB pipeline: strip animation files to skeleton+clip, inspect rigs |
| `.github/workflows/deploy.yml` | Build with Bun (frozen lockfile) → upload-pages-artifact → deploy-pages |

## The style system (core invariant)

Eight design systems switched live via `data-style` on `<html>`: **phosphor**
(default, dark), **gazette** (light), **aurora** (dark), **zine** (light),
**system** (light), **vector** (dark), **sodium** (dark), **canopy** (light). Choice persists in `localStorage.style`; first visit follows
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
series:                  # optional — groups ordered related posts
  name: 'Effect, from zero'  # display + grouping key; slugified for /series/<slug>/
  order: 1                   # reading order, independent of pubDate
```

There is **no future-date scheduling**: a post with tomorrow's `pubDate` publishes on
the next push. Commit a post to `main` only when it should go live.
`typography-test.md` is a permanent kitchen-sink draft — never remove its `draft: true`.

A `series` block groups ordered posts. A banner renders at the top of each member that
has **≥2 visible parts**, and `/series/<slug>/` lists the arc. Membership shows the
**full arc** (live + draft) everywhere — draft parts are marked and link to their
`/drafts/` preview; live parts link to `/posts/`. `order` is reading order (not date);
duplicate orders within one series fail the build (`assertSeriesIntegrity`). Current
series: *Effect, from zero* · *Effect in practice* · *How an agent remembers* ·
*Building a coding agent*.

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
- The three portals at the system edge are three FIXED game modes (`MODES`,
  keyed by portal index, each with its own color identity): THE GAUNTLET
  (green rail-dodger — rocks, walls, sentries — ending in the warden arena),
  TIME TRIAL (amber rail-race — gates buy clock time, finish line = victory,
  no boss), THE SIEGE (magenta — skips the tube, three interceptor waves in
  the cage, then the warden). All scale with the persistent run level
  (`vector-runlvl`); layouts are seeded with `mulberry()` from
  `portal index + run level` — never use `Math.random` for anything that
  must look the same across visits. Victory bumps the level and relabels
  the portals. The arena cage is the tube group disposed and rebuilt.
- Touch input rules, earned on real iPads: never `preventDefault()` a
  canvas `touchstart` — it kills the implicit pointer capture and the
  browser ends the pointer stream after the first moves (a canvas-level
  non-passive `touchmove` preventDefault is fine and backs up
  `touch-action: none`). Apple Pencil counts as `pen`, not `touch`: sodium
  accepts it for the stick; vector steers it through mouse-follow, which
  must NOT be gated off `coarse` (an iPad with a trackpad is coarse with a
  real cursor — `setPointer` filtering touch is the only guard needed).
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
- Physics is cannon-es (~165 KB, in the lazy sodium chunk): the car is a
  `RaycastVehicle` (AWD, per-wheel force under the traction cap or it all
  vaporizes as wheelspin; handbrake = rear `frictionSlip` drop), knockables
  (pins, cones, the XANDREED letters) are real rigid bodies that sleep when
  settled, ramps and `colliders` are static boxes/cylinders. Hard-earned
  cannon rules: the GROUND IS A BIG BOX, never `CANNON.Plane` (its ray path
  misses the wheel raycasts at some coordinates and the car falls through);
  `updateAABB()` every static body AFTER posing it (statics never refresh,
  and a stale AABB makes rays AND contacts pass through); `copy()` into
  `body.quaternion`, don't reassign it; the chassis gets `allowSleep =
  false` (a sleeping chassis ignores the engine and its own suspension).
  `carA`/`vel` are now derived FROM the chassis each frame, not inputs.
  Letter strokes: `rotation.z` is CCW from the front, and screen-right from
  the road is *decreasing* ring angle — both signs flip glyphs or the whole
  word into mirror writing.
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
  (split-tone / vignette / grain / chromatic aberration) must stay AFTER
  `OutputPass`, display-referred: additive grain in linear HDR lifts night
  blacks into gray haze. No volumetric headlight cones — the chase camera looks
  straight down the beam axis, so an additive cone reads as a permanent blob
  mid-screen.
- The toy-render look (both worlds): shadows are a COLOR, never gray — a
  saturated hemisphere (violet at night, lavender by day) plus a display-
  referred split-tone in the grade (toe lifts toward violet, highlights warm
  toward cream, mild vibrance). Sodium's world palette is "purple hour"
  (`NIGHT 0x191036`), and sodium.css mirrors it — its cool oklch tokens sit at
  hue ~290 to match the canvas; keep theme and world in the same family.
- Lighting: streetlights are REAL PointLights (no additive cones/pools), but
  forward rendering pays per light per fragment — only the nearest two are
  `visible` at a time, and the active count must stay CONSTANT or three
  recompiles every program. Mass props (cones) render as one InstancedMesh and
  are promoted to physics meshes on contact; ~250 individual prop groups cost
  the iGPU two thirds of its frame rate.
- Stunt ramps are pitched static boxes flush with the visual wedges — the
  launch is real ballistics now; airtime reads from `numWheelsOnGround`.
- AO strategy: canopy runs GTAO on every device (fewer samples on coarse),
  behind a persisted HUD toggle (`canopy-fx`, default on — flips
  `gtaoPass.enabled` live, no rebuild);
  sodium deliberately does NOT — AO occludes ambient light and that scene is
  lamp-lit night, so GTAO measured -20fps for an invisible change. Both
  worlds bake vertex AO into geometry (`bakeVertexAO`) and a canvas
  contact-shadow overlay onto the ground — free at runtime, works everywhere.
- If a world's `mount()` throws, the Base.astro bootstrap blacklists that style
  for the session (`failed` set). Before that guard, a throwing mount looped
  mount → catch → re-sync forever, leaking a WebGL context per attempt.

## Canopy world

`canopy-world.js` is the third world in the `WORLDS` map — a dense-forest
action-adventure (TERA-berserker kit on a platformer base):

- Talents derive from articles read (`canopy-read` set, thresholds 1/3/6/10:
  double jump, cyclone skill, ground-slam ultimate, berserk) — article pages
  record the read in ambient mode, no renderer. Articles are CHESTS on the
  trail spiral (slug-hashed; any post count works) — closed until read, then
  open with a glow beam. Coins (`canopy-coins`) and boss stars
  (`canopy-stars`) persist; player position round-trips via sessionStorage.
- The hub is a rolling heightfield: `terrainH(x, z)` is the single ground
  truth — the displaced meadow disc, `findGround()`, every placement, the
  gremlins' feet and the camera floor all read it. Gameplay spots (spawn,
  trail, chests, camps, gates, the platform yard) sit in flattening wells
  (`terrainFlat`) so hills never fight the level design. Collision stays
  AABB (`boxes` + `findGround()`, the hub's round box delegates to
  terrainH); platforms never rotate; movers carry the player (`groundBox`).
  Jump feel: coyote time + jump buffering + variable height. Don't "fix"
  those as bugs.
- Grounded movement FOLLOWS the heightfield: walkability is the slope's
  property (`terrainGrad`, walkable to 50°), never the per-frame rise — a
  fixed rise tolerance fails as speed×dt grows and the player runs inside
  the hill. Too steep kills the uphill velocity component and slides along
  the contour; snap-down scales with speed·dt·tan(slope) so crests don't
  bunny-hop; and one unconditional clamp (y < terrainH is always invalid —
  no overhangs exist) makes any future logic slip self-healing.
- Ground look is macro × micro: `groundColor(x,z)` bakes warm/cool patches,
  height/slope/trail-halo tints and cloud shade into the disc's VERTEX
  colors (and the tufts' `instanceColor` — same function, so grass never
  floats on alien green); `meadowTexture()` is only a deliberately
  low-contrast (±8% luma) tileable detail map. Macro variation is what
  kills tiling; don't move art into the repeating map.
- Camera is Genshin-grammar, researched against the real thing: desktop is
  pointer-lock mouse-look (the click that ACQUIRES the lock is swallowed —
  never an attack; while locked, click attacks and esc frees the cursor),
  touch is drag-anywhere-orbit + pinch zoom alongside the stick. Wheel sets
  `camDistT`, the boom eases toward it; auto-follow is lazy
  (`sin(offset)`-scaled yaw gain, dead above ~120° so running at the camera
  never fights you, idle ~1.6s `orbitIdleT`); `pivotY` smooths vertical so
  jumps don't pump the horizon; terrain occlusion marches the boom —
  pull-in is same-frame, pull-out eased. Hero turn is shortest-arc
  (a plain lerp pirouettes through ±π on 180° reversals).
- The axe grip wrap rotation was SOLVED analytically against the idle pose
  (map axe-local +Y to character-space `(0.45, 0.78, -0.45)` via the hand
  bone's world quaternion), not hand-tuned — re-derive through the `__cw`
  hook if the rig or clips change; blind euler sweeps don't converge.
- All three worlds have a stuck-escape: `R` + a `⟲ reset` corner chip
  (canopy → respawn, sodium → `resetToRoad`, vector → `resetShip`, which
  bails a live run via `endRun(false)`). Keep them when reworking HUDs.
- Anything transparent draped over terrain (the trail/contact-shadow
  overlay, chest glow beams) carries `userData.gtaoSkip` — the GTAO patch
  parks those alongside sprites, or the AO composite paints everything
  beneath them black. Contact-shadow blots accumulate on an offscreen
  union canvas composited once at fixed alpha: 270 trees of stacked
  per-blot alpha saturate the whole floor to black.
- The hero, gremlin, ogre and axe are Meshy-generated rigged GLBs in
  `public/models/canopy/` (~4 MB total: meshopt + webp via
  `tools/optimize-glb.mjs` and the gltf-transform CLI; animation GLBs are
  stripped to skeleton + clip). They load via `loadAssets()` after the
  procedural world is already running; failure degrades to a capsule
  placeholder and a toast, never a blacklisted mount.
- Meshy rig gotchas, all earned: (1) `normalizeHeight` measures BOTH through
  node transforms and skinned bind sampling and trusts whichever is
  character-plausible — the GLBs are internally inconsistent about units, in
  both directions. (2) Anything parented to a bone (the axe) inherits the
  rig's centimeter bind scale — counter the hand bone's WORLD scale, not the
  model scale. (3) Clips need their Hips position tracks (dropping them sinks
  the rig) but XZ must be pinned per-frame and wrong-unit tracks rescaled
  against the set's idle (`fixRootUnits`) — Block1 ships an order of
  magnitude off. (4) The block pose freezes mid-clip (`action.paused`); the
  clip's tail lowers the guard and its end pose is garbage.
- GTAOPass parks Points/Lines but NOT sprites in its G-buffer pre-pass — any
  near sprite composites as a floating opaque black rectangle. The module
  patches `_overrideVisibility` to park sprites too; damage numbers are DOM
  chips (`.cp-pop`) projected per-frame, not sprites, for the same reason.
  Single-sided planes have the same beauty/G-buffer mismatch — the chest
  signs are thin boxes, not planes.
- Combat: foes (`makeFoe`) are `SkeletonUtils.clone`s with per-foe material
  clones (hit flash). Hub gremlin camps respawn on a timer; the three boss
  gates warp to mulberry-seeded arena clearings offset +700x per index (fog
  hides them). Bosses: dormant → taunt → chase/swing + timed slam shockwave
  rings (jump over), enrage under 50%, star on death. Leaving an arena
  resets its boss. Falling below y -34 respawns at the hub or arena spawn.
- A `localStorage['canopy-debug']` flag exposes `window.__cw` (axe grip
  wrap, foes, damageFoe, a raycast `pick`) for headless QA.

## Deploy / domain

Custom domain `xandreed.dev` is set in repo settings and pinned by `public/CNAME`;
`site` in `astro.config.mjs` must stay `https://xandreed.dev` (canonicals, RSS, sitemap
derive from it). The workflow builds with `bun install --frozen-lockfile` — update
`bun.lock` in the same commit as `package.json` changes.

## Repo hygiene

- Root-level `*.png` and `PROMPT.md` are gitignored local working notes / QA
  screenshots — never force-add them. Tracked images belong in `public/`.
- Dates are UTC everywhere (`isoDate`, year grouping) — keep it that way.
