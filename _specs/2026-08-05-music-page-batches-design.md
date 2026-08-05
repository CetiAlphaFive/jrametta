# Music page: batched album wall with shuffle

**Date:** 2026-08-05
**Status:** Design settled. Sequencing and implementation deferred to a later planning phase.
**Surface:** `music.qmd`, `styles.css`, `albums.yml` (data only, unchanged)

---

## 1. Goal

The music page today renders all 60 album covers at once as a seamless, gapless
contact sheet spanning `column: screen-inset`. At `minmax(110px, 1fr)` auto-fill
the individual covers are small — thumbnails, not artwork.

The redesign makes covers roughly **three times larger** by showing **eight at a
time in a 4-across x 2-down grid**, with a **Shuffle** button that draws another
batch at random, without replacement, from the same 60.

The wall aesthetic is not being replaced. It is being enlarged and paginated.

---

## 2. Settled decisions

These are decided. They are recorded here so a later planning phase does not
re-litigate them.

### 2.1 Batch size is 8, always

Every draw yields exactly eight albums. There is never a short batch, never a
"you've seen them all" state, never a disabled button. The button always reads
`Shuffle`. (This governs the button whenever batching is active. The separate
question of whether the button appears at all is settled in section 5 — with
fewer than eight albums, or with JS off, it is not rendered visible rather than
being rendered inert.)

When the pool has fewer than eight indices remaining:

1. Take the remainder (whatever is left, 0–7 items — 0 when the pool size is an
   exact multiple of 8, in which case the rule degenerates to a plain reshuffle).
2. Reshuffle the full set of 60 indices into a new pool.
3. Move any index that appears in the remainder to the **back** of the new pool.
4. Top up the batch from the **front** of the new pool until it holds eight.

Step 3 is what makes step 4 safe: because every remainder member has been pushed
behind position 52 in the new pool, the top-up drawn from the front cannot
collide with the remainder. Two properties follow, and both are requirements:

- **No duplicate within a visible batch.** Ever.
- **No album skipped across the seam.** Every index in the old pool is displayed
  before the reshuffle happens.

With 60 albums and batches of 8, the seam falls on the eighth draw: draws 1–7
consume 56 distinct indices, the eighth draw is 4 leftovers plus 4 fresh.

The reshuffle is **silent**. Nothing in the UI marks the seam. The user sees a
continuous stream of batches.

### 2.2 Grid

- **4 columns at viewport >= 1200px, 2 columns below that.** No intermediate
  breakpoint. The fixed auto-fill `minmax(110px, 1fr)` track definition is
  replaced by explicit column counts.
- **`gap: 0` is preserved.** Covers stay edge to edge.
- **`column: screen-inset` is preserved.** The grid keeps spanning the full
  inset width.

The 3x size increase is a consequence of these two facts together: the same
screen-inset width divided into 4 tracks instead of ~10–12 gives covers roughly
three times the edge length.

Because hidden tiles are removed from flow entirely (see 2.5), the grid always
contains exactly eight in-flow children, so its height is constant across
draws and the page does not jump when a batch is swapped.

### 2.3 No captions

Art only. No artist name, no album title, no hover label rendered as text.

Artist and title remain exactly where they are today: in the anchor's `title`
attribute and the image's `alt` text. This is unchanged behavior, and it is what
keeps the page accessible and hoverable without adding visible chrome.

### 2.4 Control

A real `<button class="tidal-cta album-shuffle">Shuffle</button>`, centered
below the grid. Not a link, not a div. It is an interactive control and must be
a `<button>` for keyboard and assistive-technology behavior to come for free.

It reuses the existing `.tidal-cta` visual styling. That rule set is currently
**orphaned** — `playlist_url` is `""`, so the playlist CTA it was written for is
suppressed and nothing on the page carries the class. Reusing it means the new
button matches the site's existing button look, including the
`.quarto-dark .tidal-cta` inversion, with no new visual vocabulary.

`.tidal-cta` was written for an `<a>`, so applying it to a `<button>` needs the
usual UA-style neutralization on the button element: zero border, `font:
inherit`, `cursor: pointer`. Centering comes from the `.album-shuffle` rules,
which override `.tidal-cta`'s `display: inline-block` with `display: block` plus
auto inline margins.

**Click behavior:** a crossfade of about 200ms. Fade the *grid container's*
opacity to 0, swap which tiles are shown, fade back in. The fade is on
`.album-grid`, not on individual tiles — individual tiles cannot transition
because their visibility is driven by `display`, which is not animatable.

The swap is scheduled on a timer matched to the transition duration rather than
on `transitionend`. A timer fires unconditionally; `transitionend` does not fire
when the transition has been disabled, which is exactly the reduced-motion case.

Rapid repeated clicks are absorbed by an internal in-flight guard: while a fade
is running, further clicks are ignored. The guard is invisible. The button is
never disabled and its label never changes, per 2.1.

### 2.5 Approach A (chosen): render all, toggle visibility

R continues to emit all 60 anchors into the DOM, exactly as it does now,
including the render-time `sample.int` shuffle.

An inline script stamps `class="js"` on `<html>` before first paint. CSS uses
that class to hide tiles 9–60. JS then manages which eight tiles carry
`.is-shown`.

**Why this one:** the no-JS fallback is free and is *identical to today's page*.
No JS means no `.js` class, means no CSS rule matches, means all 60 covers are
visible in the same full wall the page ships today. Nothing is lost, nothing
needs a duplicate copy of the content, and the enhancement layers cleanly on top.

**Rejected alternatives:**

- **(B) Emit the album list as JSON and build tiles in JS.** State management is
  genuinely cleaner — one array, one render function, no dual source of truth
  between DOM order and pool order. Rejected because with JS off the grid is
  empty. Restoring the fallback means emitting all 60 tiles inside `<noscript>`
  in addition to the JSON, which duplicates the entire payload and re-creates
  the exact markup Approach A was going to emit anyway. The cleanliness win is
  paid for twice over.

- **(C) Pure-CSS pre-baked batches via `:target` or hidden radio inputs.** Zero
  JavaScript, which is attractive. Rejected because the batches are fixed at
  render time. The user gets a carousel through 7–8 predetermined groupings, and
  clicking Shuffle a second time through the cycle shows the same eight albums
  in the same order. That is not shuffling, and the whole point of the feature is
  that the draw is random per click.

---

## 3. CSS handoff

This is the subtle part of the design and the reason Approach A works without a
visible flash.

```css
html.js .album-grid:not(.ready) .album-tile:nth-child(n+9) { display: none; }
html.js .album-grid.ready  .album-tile          { display: none; }
html.js .album-grid.ready  .album-tile.is-shown { display: block; }
```

Two regimes, one handoff:

**Before JS boots** (`.album-grid` has no `.ready`): the first rule hides tiles
9 through 60 positionally, by `nth-child`. This is evaluated at parse time,
during the same first paint in which the tiles appear. The user never sees all
60 covers render and then collapse to 8 — the collapse never happens, because
the tail was never painted.

This is only possible because the `.js` class is stamped **synchronously in
`<head>`, before body parse**. A deferred script, a module script, or a
`DOMContentLoaded` handler all run after first paint, and any of them would
produce the flash this design exists to avoid.

**After JS boots** (JS adds `.ready`): the second and third rules take over.
Visibility is now driven entirely by the `.is-shown` class, and `nth-child`
position becomes irrelevant. The two regimes are mutually exclusive by selector —
`:not(.ready)` and `.ready` cannot both match — so specificity never arbitrates
between them and the transition is atomic: adding one class flips the whole grid
from positional hiding to class-driven hiding.

**Structural constraint.** The `:not(.ready)` rule counts `nth-child` among a
tile's actual DOM siblings. It is therefore correct only if all 60 anchors are
siblings of one another. Today they are, because the R chunk emits them in a
single `cat()` with no whitespace between tiles, so Pandoc cannot break them
across multiple wrappers. (The existing `.album-grid > p { display: contents }`
rule is evidence that Pandoc does sometimes insert a `<p>` around asis chunk
output; `display: contents` keeps that wrapper out of the grid's layout, but it
does *not* keep it out of `nth-child` counting.) Emitting the button must not
introduce a break in the tile run — it belongs after the closing `</div>`, in
its own `cat()`.

JS must mark its first eight `.is-shown` **before** adding `.ready`, so that no
frame exists in which `.ready` is set but nothing is shown. Otherwise the grid
blanks for one frame.

Additional CSS:

- `.album-grid { transition: opacity 200ms ease; }` plus a fading state class
  that sets `opacity: 0`.
- `@media (prefers-reduced-motion: reduce) { .album-grid { transition: none; } }`
- `.album-shuffle { display: none; }` by default, with `.album-shuffle.is-active
  { display: block; margin-inline: auto; }`. The button is revealed by JS and
  only by JS, so a no-JS visitor never sees a control that cannot do anything.

---

## 4. Data flow

```
albums.yml (60 entries)
  -> R chunk in music.qmd
       sample.int shuffle (retained — see below)
       slugify + fetch_cover per album, cached under images/albums/<slug>.jpg
       emits 60 <a class="album-tile"> anchors inside <div class="album-grid">
       emits <button class="tidal-cta album-shuffle">Shuffle</button> after it
  -> CSS: html.js + :not(.ready) shows tiles 1-8 and hides 9-60;
          .album-shuffle is hidden by default, independent of html.js
  -> JS on boot:
       builds a shuffled index pool over 0..N-1
       marks the first 8 tiles .is-shown
       adds .ready to the grid, .is-active to the button
  -> each click: fade out, splice the next 8, fade in
  -> after each draw: preload the FOLLOWING 8 covers via new Image()
```

**The render-time shuffle is retained.** It is not made redundant by the JS
pool. It is what determines which eight covers a no-JS visitor sees first, and
it varies the page between renders. The two shuffles are independent and both
have a job.

**Pool state runs one batch ahead of the display.** After rendering a batch, the
pool is immediately advanced again and the resulting indices are stored as the
next batch, then their cover URLs are warmed with `new Image()`. There is no
separate "peek" code path, so the preloaded set is exactly and always what the
next click will show.

Preloading is not optional polish. Hidden tiles are `display: none` and their
images carry `loading="lazy"`, which means the browser has no reason to fetch
them and will not. Without an explicit warm, the first frame after a crossfade
reveals half-decoded or blank images — the exact artifact the crossfade is
meant to hide.

---

## 5. Error handling and edge cases

**No JavaScript.** No `.js` class on `<html>`, so none of the three handoff
rules match, so nothing is hidden: the full 60-cover wall, exactly as the page
renders today. The shuffle button stays hidden because `.is-active` is only ever
applied by JS. This is the primary argument for Approach A.

**Fewer than 8 albums total.** Show all of them and do not reveal the button. JS
detects this at boot and declines to activate: it does not add `.ready`, does not
add `.is-active`. The `:not(.ready)` rule's `nth-child(n+9)` matches nothing, so
all tiles remain visible. No special-case CSS is needed.

**Exactly 8 albums.** The button *is* revealed, and every draw is a permutation
of the same eight albums. Because tile visibility is positional in the DOM and
DOM order does not change, the swap is visually a no-op. This is accepted, not
special-cased — it is a degenerate configuration of the general rule, not a bug,
and adding a threshold to hide the button at exactly 8 would be a rule with no
principled boundary.

**`prefers-reduced-motion: reduce`.** Skip the crossfade entirely. Swap the
`.is-shown` classes synchronously on click. JS checks the media query via
`matchMedia` rather than relying on the CSS transition being suppressed, so the
swap is immediate rather than merely un-animated.

**Missing cover art.** The two albums with no fetched cover continue to render
`images/albums/_placeholder.svg`, unchanged. The placeholder is an ordinary image
source and participates in batching, preloading, and crossfade identically to a
JPEG. Nothing about this design touches `fetch_cover` or its caching.

**`mockup_count > 0` branch.** Batching **applies**, with no special-casing. The
mockup branch produces a tile array of the same shape — `<a class="album-tile">`
anchors carrying an `<img class="album-cover">` — into the same
`<div class="album-grid">`. The only contract the CSS and JS depend on is "the
grid contains N `.album-tile` children"; both branches satisfy it. The mockup
tiles carry empty `alt` and no `title`, which is unchanged and out of scope here.

---

## 6. Verification criteria

1. On load with JS enabled: exactly 8 tiles visible, 52 hidden.
2. Nine consecutive draws (initial load plus eight clicks) contain no repeat
   within any single batch; the first seven draws collectively show 56 distinct
   albums; the eighth draw is the seam and contains the 4 leftovers plus 4 fresh
   indices with no internal duplicate.
3. With JS disabled, all 60 covers render and the shuffle button is not visible.
4. Viewport below 1200px yields 2 columns; at or above 1200px, 4 columns.
5. No console errors on load or on any click.
6. `git status --short docs/senate-forecast/` is empty after any render.

Criterion 6 is a standing repo hazard, not specific to this feature:
`project.resources` includes `senate-forecast/**`, so any render copies the
stale root `senate-forecast/index.html` over the bot-maintained
`docs/senate-forecast/index.html`. Any work on this feature that renders the
site must check this before committing.

---

## 7. Artifacts

Indicative of where each piece lives. Sequencing is deferred.

- `music.qmd` — R chunk emits the button after the grid; YAML gains an
  `include-in-header` pointing at the head snippet and an `include-after-body`
  pointing at the batching script.
- `_includes/` (new files) — the synchronous `<html class="js">` head snippet and
  the batching script. `_includes/` is already ignored by Quarto's input
  discovery and is the repo's existing home for partials.
- `styles.css` — grid column rules, the three handoff rules, the opacity
  transition and its reduced-motion suppression, and the `.album-shuffle`
  reveal rules. `.tidal-cta` itself is not modified; it is reused as-is and
  stops being orphaned.
- `albums.yml` — unchanged.

---

## 8. Open question for the author

The intro copy on line 6 of `music.qmd` currently reads:

> A wall of albums I keep coming back to. Click any cover to open it on Tidal.

It no longer describes the page once the wall is batched. Suggested revision, for
the author to accept or replace:

> A rotating wall of albums I keep coming back to. Click any cover to open it on
> Tidal, or shuffle for eight more.

This is a question, not a decision. The implementation does not depend on it.

---

## 9. Explicitly out of scope

Deferred. Recorded so they are not lost, and so no one designs them into this
change.

- **Opaque hex stickers.** `mlbalance_sticker.png` is RGBA but its alpha channel
  has min 255 — fully opaque despite having the channel.
  `utopiaplanitia_sticker.png` is palette mode with no alpha channel at all. Both
  render a solid box behind the hex shape. Separate fix.
- **Oversized sticker asset.** `roadrunner_sticker.png` is 2400x2772 and 1.5MB,
  displayed at 120px. Wants downscaling. Separate fix.
- **Dead `playlist_url`.** Currently `""`, so the playlist CTA is suppressed.
  This design reuses the orphaned `.tidal-cta` styling but does not resolve,
  populate, or remove `playlist_url` itself.
- **The two missing covers.** RH Factor "Distractions" and "Like Minds" have no
  fetched art and fall through to the placeholder. Sourcing art for them is a
  data task, not a layout task.
- **Intro copy.** See section 8 — raised as an open question, deliberately not
  decided here.
