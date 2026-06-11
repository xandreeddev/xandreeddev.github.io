# xandreed.dev — blog

Astro 5 static site, built with Bun, deployed to GitHub Pages at https://xandreed.dev
on every push to `main`. **No React, no framework JS** — hand-written CSS and two small
inline scripts; the one exception is the lazy-loaded vanilla Three.js chunk for the
`vector` style. That constraint is part of the site's identity, not an accident.

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
| `src/layouts/Base.astro` | Head/SEO, font imports per style, FOUC-guard inline script, header + style switcher, copy-button injector, lazy vector bootstrap |
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
| `src/scripts/vector-world.js` | The 3D world (~1.5k lines), lazy-loaded only for `vector` |
| `.github/workflows/deploy.yml` | Build with Bun (frozen lockfile) → upload-pages-artifact → deploy-pages |

## The style system (core invariant)

Six design systems switched live via `data-style` on `<html>`: **phosphor** (default,
dark), **gazette** (light), **aurora** (dark), **zine** (light), **system** (light),
**vector** (dark). Choice persists in `localStorage.style`; first visit follows
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
  stay idempotent and dispose Three.js resources (scene traverse + renderer/composer).
- The DOM is the source of truth: the world reads `.post-row` elements. Homepage =
  world mode; post pages = ambient mode with a return chip.
- Desktop input is pointer-lock + mouse-follow; touch is a virtual stick (left ~60% of
  the screen) + right-thumb cluster (`data-vt-*` buttons; thrust latches, boost holds).
  Touch must never feed the mouse-follow path or call `requestPointerLock`.
- Progress lives in `localStorage` (visited posts unlock ship mods, scrap persists).
- Keep it a lazy dynamic import — the other five styles must never pay for Three.js.

## Deploy / domain

Custom domain `xandreed.dev` is set in repo settings and pinned by `public/CNAME`;
`site` in `astro.config.mjs` must stay `https://xandreed.dev` (canonicals, RSS, sitemap
derive from it). The workflow builds with `bun install --frozen-lockfile` — update
`bun.lock` in the same commit as `package.json` changes.

## Repo hygiene

- Root-level `*.png` and `PROMPT.md` are gitignored local working notes / QA
  screenshots — never force-add them. Tracked images belong in `public/`.
- Dates are UTC everywhere (`isoDate`, year grouping) — keep it that way.
