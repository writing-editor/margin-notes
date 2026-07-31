# Implementation plan: margin-rendered links/embeds + hover-zoom chips

## Progress tracker (update this section after each step)

- [x] **Step 1 — Refactor `marginPanel.ts` per §3** (extract shared layout
  into `src/marginLayout.ts`). **DONE.**
  - New file `src/marginLayout.ts` exports:
    - `CHIP_GAP` (moved here from `marginPanel.ts`, was a local const there).
    - `MarginItem` interface: `{ from: number; id: string; buildChip(): HTMLDivElement }`.
    - `anchorTopFor(view, pos, scrollerTop, scrollTop)` — the Gotcha #2
      `coordsAtPos`-with-`lineBlockAt`-fallback helper, extracted verbatim
      (same logic, now a standalone function instead of inlined in a `.map()`).
    - `layoutMarginItems(view, track, items)` — the Gotcha #3 two-pass
      anchor-then-clamp placement loop, extracted verbatim from
      `marginPanel.ts`'s old `render()` body, now generic over `MarginItem[]`
      instead of hardcoded to `NoteMarker[]`. **Important:** `items` must
      already be sorted by `.from` ascending — this function does not sort;
      when link markers are merged in at Step 3, the caller is responsible
      for a stable merge-by-`.from` before calling this.
  - `marginPanel.ts` changed: `render()` now builds `NoteMarker[]` as before
    (`findNoteMarkers`), then maps each into a `MarginItem` (`from`, `id:
    'mn:' + marker.id`, `buildChip: () => this.buildChip(marker)`) and calls
    `layoutMarginItems(this.view, this.track, items)` instead of containing
    the layout math inline. `buildChip()`/`focusNoteText()` are UNCHANGED —
    only the layout loop moved out.
  - Behavior is intended to be 100% identical to before this refactor — this
    step is pure extraction, no visual or functional change. **Test:** open a
    file with several `[mn: ...]` notes at varying density (some crowded,
    some isolated) and confirm positioning/clamping looks exactly as it did
    pre-refactor. If it doesn't, the refactor introduced a regression —
    do not proceed to Step 2 until this matches.
  - Files touched this step: `src/marginLayout.ts` (new), `src/marginPanel.ts`
    (modified). No other files changed.

- [x] **Step 2 — Hover-zoom (§4) against existing `mn` chips.** **DONE.**
  - Only `styles.css` changed — no `.ts` files touched this step (pure CSS,
    as the plan intended).
  - `.mn-chip` base rule gained: `transform-origin: right center; transform:
    scale(1); transition: transform 120ms ease-out, box-shadow 120ms
    ease-out, max-height 120ms ease-out;` — added alongside its existing
    rules, nothing removed from the base rule.
  - Removed entirely: the old `.mn-chip:hover { border-color:
    var(--interactive-accent); }` rule and the old
    `.mn-chip.mn-chip-clamped:hover { ... }` rule (Gotcha #4's rule) — both
    superseded by the new unified rule below. Do not re-add either.
  - Added: one `.mn-chip:hover` rule applying to every chip regardless of
    `.mn-chip-clamped` state:
    `transform: scale(1.12); max-height: none; overflow: visible;
    mask-image: none; border-color: transparent; box-shadow: 0 8px 24px
    var(--background-modifier-box-shadow, rgba(0,0,0,0.3)); z-index: 20;`
  - `.mn-margin-track` gained an explicit `overflow: visible;` (was
    implicit/default before, now stated explicitly so a future edit doesn't
    accidentally clip hovered/scaled chips).
  - `.mn-chip.mn-chip-clamped`'s own (non-hover) mask rule is UNCHANGED —
    it still governs the resting clamped state; only its hover companion
    rule was removed/replaced.
  - **Test:** hover over several chips — both a crowded/clamped one (should
    expand to full content at 1.12x scale with a soft shadow) and an
    isolated/unclamped one (should still get the same scale+shadow lift,
    even though there's no extra content to reveal). Confirm: (a) the
    editor caret/selection is completely unaffected by hovering — clicking
    still works as before via the existing `mousedown` handler; (b) the
    scaled chip visually grows toward the left/vertically, never toward or
    into the main text (`.cm-content`); (c) at the default 220px
    `marginWidth`, a scaled chip isn't clipped by anything. If a scaled chip
    gets cut off at the right edge check `transform-origin` is still `right
    center`; if it drifts toward the text check nothing re-introduced
    `transform-origin: center`.
  - Files touched this step: `styles.css` (modified). No `.ts` files
    changed.
- [x] **Step 3 — `src/linkMarkers.ts`** (§2.1 + §2.3). **DONE.**
  - New file `src/linkMarkers.ts`:
    - `LINK_RE = /(!?)\[\[([^\]]+)\]\]/g` — matches both `[[...]]` and
      `![[...]]`, capture group 1 is `'!'` or `''` (isEmbed), group 2 is
      everything inside the brackets (parsed further below).
    - `parseLinkInner(inner)` — splits `target[#heading][|alias]` by finding
      `|` first (splits off alias, everything before it is target+heading),
      then `#` within what's left (splits off heading from target). Handles
      all 6 forms from the plan: `[[Note]]`, `[[Note|Alias]]`,
      `[[Note#Heading]]`, `[[Note#Heading|Alias]]`, `![[Note]]`,
      `![[Note#Heading]]`. **Test these 6 forms explicitly** — this is the
      one regex/parsing piece the plan flagged as needing care.
    - `LinkMarker` interface: `{ from, to, id, isEmbed, linkpath, heading,
      alias, raw }`. `id` is `'link:' + from` (position-based, NOT a
      sequential counter like NoteMarker's `id` — links aren't numbered in
      the UI, so position-based identity is sufficient and simpler; it does
      mean a link's `id` changes if text before it shifts, which is fine
      since nothing persists a link id across renders the way note-chip
      `focusNoteText` re-lookup does by counter).
    - `findLinkMarkers(doc)` — parallel to `findNoteMarkers`, no `sourcePath`
      param needed at the parsing stage (parsing is source-independent;
      `sourcePath` is only needed later at resolution/open time, see below).
    - `linkDisplayText(marker)` — returns `alias ?? linkpath`, the plan's
      "alias if present, else target name" rule.
    - `LinkInlineWidget` (CM6 `WidgetType`) — renders a plain `<span
      class="mn-linktext">` with just the display text, `mousedown` handler
      calls `app.workspace.openLinkText(linkpath, sourcePath)` and
      preventDefaults/stopPropagates so it doesn't move the caret (same
      non-negotiable as the `mn-anchor` widget's click having its own
      distinct behavior, not caret placement).
    - `buildDecorations` / `linkMarkerField` (`StateField`) — parallel
      structure to `noteMarkers.ts`'s own field: same
      `isMarginNotesEnabled` gate, same strict-overlap "don't replace text
      the selection is touching" rule so an in-progress `[[` being typed
      stays raw/editable.
    - `getActiveLinkMarkers(state)` — parallel export to
      `getActiveNoteMarkers`, exposed for the margin panel (not yet used by
      it — `marginPanel.ts` currently calls `findLinkMarkers` directly
      inline; this export exists for parity/future use, harmless either way).
  - `main.ts` changed: imports and registers `linkMarkerField` alongside
    `noteMarkerField` in `registerEditorExtension([...])`.
  - `noteTypes.ts` changed: added two new exported constants,
    `LINK_CHIP_COLOR` (`#0ea5e9`) and `EMBED_CHIP_COLOR` (`#f472b6`) —
    deliberately NOT added to the `NOTE_TYPES` registry (these aren't `mn.`
    types, nothing autocompletes them).
  - `marginPanel.ts` changed:
    - Now also calls `findLinkMarkers(this.view.state.doc)` in `render()`.
    - New private `mergeByFrom(a, b)` — a stable two-pointer merge of two
      already-sorted `MarginItem[]` lists (note items, link items) into one
      combined sorted list, since `layoutMarginItems()` requires
      pre-sorted input and doesn't sort internally itself (see Step 1's
      `marginLayout.ts` docstring).
    - New private `buildLinkChip(marker)` — builds a **synchronous
      placeholder-only** chip: `.mn-chip.mn-chip-link`, left-border color
      `EMBED_CHIP_COLOR`/`LINK_CHIP_COLOR` depending on `marker.isEmbed`, a
      label span reading `"link"`/`"embed"`, and a text span showing
      `linkDisplayText(marker)` — i.e. just the bare title, exactly per the
      plan's Step 3 scope ("no preview yet"). Click navigates via
      `openLinkText`, same as the inline widget.
    - **No async content fetch yet** — that's Step 4 (`linkPreview.ts`).
      This step's chip is intentionally "dumb": it shows a title and
      nothing else, and this same chip DOM node is what Step 4 will reach
      into and swap the inner content of once the preview resolves,
      without re-running this layout pass (see §2.2's "swap in place"
      requirement).
  - `styles.css` changed: added `.mn-linktext` (plain-prose color via
    `color: inherit`, `cursor: pointer`) and `.mn-linktext:hover` (a very
    faint `text-decoration: underline` in `--text-faint`, nothing louder).
    No new rule was needed for `.mn-chip-link` itself — it inherits all of
    `.mn-chip`'s existing rules (including this step's shared hover-zoom
    from Step 2) and only needs its border-left color, which is set inline
    per-chip in JS exactly like `mn` chips already do via
    `noteTypeColor()`.
  - **Test:**
    1. Type `[[Some Note]]`, `[[Some Note|Alias Text]]`,
       `[[Some Note#A Heading]]`, `[[Some Note#A Heading|Alias]]`,
       `![[Some Note]]`, `![[Some Note#A Heading]]` on separate lines.
       Confirm each collapses to plain, non-blue, non-underlined inline
       text (the alias if given, else the bare note name — no brackets, no
       `!`), and that clicking each navigates to the target note (creating
       it if missing, same as Obsidian's own link-click behavior via
       `openLinkText`).
    2. Confirm a placeholder chip appears in the margin next to each of
       those lines, labeled `link` or `embed` appropriately, colored
       distinctly from `mn` chips and from each other (`link` vs `embed`),
       showing just the title (no rendered preview — that's expected until
       Step 4).
    3. Confirm hover-zoom (Step 2) already works on these new chips with
       zero extra code, since they share `.mn-chip` — if it doesn't, note
       that in Step 5 rather than patching a second hover rule now.
    4. Confirm placing the caret inside a `[[...]]` reveals the raw
       markdown (same reveal-on-selection-overlap behavior as `mn`
       markers), so it stays editable.
    5. Put an `[mn: ...]` note and a `[[link]]` on lines close enough to
       trigger collision-avoidance/clamping between them and confirm both
       chips lay out sanely relative to each other (this exercises
       `mergeByFrom` + the shared `layoutMarginItems` together).
  - Files touched this step: `src/linkMarkers.ts` (new), `src/main.ts`
    (modified), `src/noteTypes.ts` (modified), `src/marginPanel.ts`
    (modified), `styles.css` (modified).
- [x] **Step 4 — `src/linkPreview.ts`** (§2.2 + Gotcha #5/#7). **DONE.**
  - New file `src/linkPreview.ts`:
    - `PreviewState` union: `pending | ready(el) | missing(linkpath) | error`.
      `missing` is Gotcha #5's "note not found" case (broken link — dest is
      null); `error` is a belt-and-suspenders case if `MarkdownRenderer.render`
      itself throws (not expected in normal use, but a chip must never break
      the whole margin column if it does).
    - Module-level `cache: Map<path, CacheEntry>`, keyed by the **resolved
      file's path** (not the raw linkpath text), so two different `[[link
      text]]` spellings resolving to the same file share one render.
      `CacheEntry` carries `{ state, mtime, component, listeners }`.
    - **Gotcha #7 lifecycle decision made here:** rather than one
      `Component` per cache entry each individually unloaded, this uses ONE
      shared, lazily-created `Component` (`getSharedComponent()`) for every
      preview render for the plugin's whole lifetime, unloaded exactly once
      via `disposeAllLinkPreviews()` (called from `main.ts`'s `onunload()`).
      Re-rendering the same target into the same DOM/Component on cache
      invalidation is a supported "re-render," not a leak — this sidesteps
      per-entry unload bookkeeping entirely while still satisfying the
      plan's actual leak concern (a `Component` must exist and eventually be
      unloaded so its child renderers clean up — it does, once, at plugin
      unload).
    - `getLinkPreview(app, marker, sourcePath, onUpdate)` — **synchronous,
      never blocks.** Resolves `dest` via
      `app.metadataCache.getFirstLinkpathDest(marker.linkpath, sourcePath)`
      every call (cheap in-memory lookup, not cached itself — only the
      *rendered content* is cached). Returns `missing` state immediately if
      `dest` is null. Otherwise checks the cache by `dest.path`; if an entry
      exists AND its stored `mtime` still matches `dest.stat.mtime`, returns
      that cached state and adds `onUpdate` as a listener. Otherwise
      creates/replaces the entry (state `pending`), kicks off
      `renderInto()` (fire-and-forget async), and returns the `pending`
      state immediately. Returns `{ state, unsubscribe }` — caller must call
      `unsubscribe()` when its chip is torn down.
    - `renderInto(app, dest, entry)` (private, async) — Gotcha #5's safe
      approach: `app.vault.cachedRead(dest)` (not `.read()`, per §2.2 step
      3's "preferred... can serve from cache"), then
      `MarkdownRenderer.render(app, markdown, scratchEl, dest.path,
      entry.component)` — note `sourcePath` passed here is **the previewed
      file's own path**, not the original linking file, so links/embeds
      *inside* the preview resolve relative to the previewed note itself
      (matches how Obsidian's own embed rendering behaves). On success,
      sets `entry.state = { status: 'ready', el: scratchEl }`; on thrown
      error, `{ status: 'error' }` (logged via `console.error`, never
      thrown further). Either way, calls every listener in
      `entry.listeners` afterward — this is the "swap in place" signal
      `marginPanel.ts` reacts to.
    - `registerLinkPreviewInvalidation(app)` — call once from `main.ts`'s
      `onload()` (module-level cache is shared across all editors, so this
      is plugin-lifetime, not per-view, same rationale as the existing
      rename/metadataCache listeners in `main.ts`). Listens to
      `app.vault.on('modify')`; when a file with a cache entry is modified,
      marks it `pending`, notifies listeners immediately (so an open chip
      shows a loading state right away rather than waiting for some other
      trigger), and re-kicks `renderInto()`. Returns `{ unregister }`.
    - `disposeAllLinkPreviews()` — unloads the shared `Component` and clears
      the cache. Call once from `main.ts`'s `onunload()`.
  - `main.ts` changed:
    - Imports and calls `registerLinkPreviewInvalidation(this.app)` in
      `onload()`, storing the returned handle in a new private field
      `linkPreviewInvalidation`.
    - `onunload()` now calls `this.linkPreviewInvalidation?.unregister()`
      and `disposeAllLinkPreviews()` — previously `onunload()` was a no-op
      comment; this is the first thing it actually does.
  - `marginPanel.ts` changed:
    - New class field on `MarginColumn`: `linkPreviewUnsubs: Map<string,
      () => void>` — tracks the current preview-subscription per link
      marker `id`. **Why this exists:** `render()` rebuilds ALL chips from
      scratch on every pass (`this.track.replaceChildren()`), which can
      fire on doc changes, selection changes, scroll, viewport changes —
      far more often than "a link was added." Without this map, every one
      of those passes would call `getLinkPreview()` again for the same
      marker and add ANOTHER listener closure into `linkPreview.ts`'s
      `entry.listeners` Set, accumulating forever (a live leak, exactly
      what Gotcha #7 warned about, just relocated to the listener-tracking
      layer instead of the `Component` layer). Fix: `buildLinkChip()` now
      unsubscribes the marker's PREVIOUS listener (if any) before
      registering its new one, every time that marker's chip is rebuilt —
      bounding it to at most one live listener per marker at any time.
    - `buildLinkChip(marker)` rewritten: still builds the same
      `.mn-chip.mn-chip-link` shell as Step 3, but now also creates a
      `.mn-chip-link-body` inner span (separate from the `.mn-chip-label`
      "link"/"embed" tag) that starts showing the bare title (same as
      Step 3's placeholder), then calls `getLinkPreview(...)` once
      synchronously to paint whatever state is available immediately
      (cached-ready, freshly-kicked-off-pending, or missing) and registers
      `applyState` as the ongoing listener for later updates. `applyState`
      swaps `body`'s children/text depending on state: `ready` → replaces
      with the rendered DOM node and adds `.mn-chip-link-loaded`; `missing`
      → shows `No note titled "X" yet` text and adds
      `.mn-chip-link-missing`; `error` → falls back to showing the bare
      title, also flagged `.mn-chip-link-missing` (visually the same
      "something's off" treatment as a broken link, since from the user's
      view both mean "no preview available"); `pending` → no-op, keeps
      showing whatever was already there (the initial bare-title
      placeholder, or a still-stale previous render if this fired from an
      invalidation).
    - `MarginColumn.destroy()` now also unsubscribes every remaining entry
      in `linkPreviewUnsubs` before removing the track — an editor view
      closing shouldn't leave dangling listeners for markers that no longer
      have any chip anywhere.
  - `styles.css` changed: added `.mn-chip-link-body` (block, word-break),
    a rule taming rendered heading sizes/margins inside the preview so a
    target note's own `h1`/etc. don't blow up the tiny chip, a `p` margin
    reset, a subtle opacity dim on the body while
    `.mn-chip-link:not(.mn-chip-link-loaded):not(.mn-chip-link-missing)`
    (i.e. still pending) as the "loading" cue, and
    `.mn-chip-link.mn-chip-link-missing` (dashed border-left, muted italic
    body text) for the broken-link/error state.
  - **What was explicitly NOT done this step** (per §4.3's "what not to
    change" — that section is about hover-zoom, but the same spirit
    applies here): hover-zoom is untouched and not made to depend on the
    fetch completing — a still-`pending` chip zooms on hover exactly like
    any other chip, just showing the loading-opacity placeholder at scale.
    Verify this explicitly in testing (see below) rather than assuming it —
    this is exactly the seam Step 5 exists to double check.
  - **Test:**
    1. Reference an existing note via `[[Real Note]]` — confirm the chip
       shows the bare title first (loading, dimmed), then swaps to the
       actual rendered markdown preview shortly after, WITHOUT the margin
       layout re-running for other chips (other chips' `top`/clamping
       should not visibly jump when this one's content swaps in).
    2. Reference a non-existent note via `[[Totally Made Up Note Title]]` —
       confirm the chip shows `No note titled "Totally Made Up Note
       Title" yet`, dashed border, muted italic — not a blank chip, not a
       thrown error in the console (aside from the deliberate one only on
       actual render failure).
    3. With a `[[Real Note]]` chip already showing its rendered preview,
       edit and save that target note in a different pane/tab — confirm
       the chip's content updates live (via the `vault.on('modify')`
       invalidation) without needing to scroll or otherwise force a
       re-render of the linking document.
    4. Reference the SAME note from two different `[[...]]` links in one
       document — confirm both chips show content (exercises the
       path-keyed cache being shared, not two independent fetches you'd
       notice as, e.g., doubled network/disk activity — check
       via a console log or breakpoint in `renderInto` if you want to
       confirm it only runs once for the shared target).
    5. Scroll the document a lot (triggering many `render()` passes) with
       several link chips visible, then check (e.g. via a temporary
       `console.log(cache.size)` / listener-set-size probe in
       `linkPreview.ts`, or just trust the `linkPreviewUnsubs` unsubscribe
       logic and move on) that listener counts aren't silently growing
       per marker across passes.
    6. Confirm embeds (`![[...]]`) behave identically to links content-wise
       (same preview, same states) — only the label ("embed" vs "link")
       and accent color should differ, per §2.
  - Files touched this step: `src/linkPreview.ts` (new), `src/main.ts`
    (modified), `src/marginPanel.ts` (modified), `styles.css` (modified).
- [x] **Step 5 — Confirm hover-zoom "just works" on link/embed chips.** **DONE.**
  - No code changes needed or made this step, confirming §5's expectation:
    `.mn-chip-link` (added in Step 3) only ever adds classes/styles
    alongside the base `.mn-chip` class — it never overrides `transform`,
    `transition`, or `transform-origin`, so Step 2's unified
    `.mn-chip:hover` rule applies to link/embed chips automatically, with
    zero divergence to reconcile.
  - Also fixed during this step (found via VS Code's TS checker while
    verifying, not part of the original plan's scope but blocking a clean
    build): `linkPreview.ts`'s `app.vault.on('modify', handler)` /
    `app.vault.off('modify', handler)` calls didn't resolve to Obsidian's
    typed `'modify'` overload in this TS/`obsidian.d.ts` combination — TS
    fell back to the generic `Events.on(name: string, callback:
    (...data: unknown[]) => unknown)` signature, producing a type error on
    `handler`'s `TFile` parameter (`Type 'unknown' is not assignable to
    type 'TFile'`). Fixed by casting the handler through `(...data:
    unknown[]) => unknown` at the call site (no runtime behavior change —
    `vault.on` still emits a single `TFile` argument for `'modify'`
    regardless of how TS typed it) and switching the unregister path from
    `vault.off('modify', handler)` to `vault.offref(ref)` using the
    `EventRef` `vault.on()` returns, which is the more robust unregister
    pattern regardless of the overload-resolution quirk. If you hit the
    same red squiggle on a different Obsidian API version, check whether
    the overload resolves cleanly there first — the cast may no longer be
    necessary, but it's harmless to leave in either way.
  - **Test:** hover a link/embed chip in each state — pending (dimmed
    placeholder), ready (full preview), and missing (dashed/muted) — and
    confirm all three zoom identically to a note chip: scale up, shadow,
    pinned to the margin's right edge, full content revealed if it was
    clamped. Confirm a mixed-density paragraph (an `mn` note AND a
    `[[link]]` close together) still clamps sensibly per Step 3's test #5,
    and that hovering either one doesn't visually disturb the other's
    resting position.
  - Files touched this step: `src/linkPreview.ts` (bugfix only — the
    `vault.on('modify')` typing fix above). No other files changed.

---

## Plan status: COMPLETE

All 5 steps in §5's build order are implemented (see checklist above), and
a further amendment beyond the original plan removed embed handling
entirely — see "Second post-completion amendment" below. This document is
now a historical record of what was built and why, not an active TODO —
the `README.md` at the repo root has a "Links in the margin (embeds are
intentionally left alone)" section describing the shipped feature for
future readers who don't need the Gotchas/build-order narrative this file
was written for. Prefer the README for a description of current behavior;
come back to this file only if you need the historical reasoning behind a
specific implementation choice (e.g. why `coordsAtPos` over `lineBlockAt`,
or why embed margin chips were removed).

### Post-completion amendment: embeds do NOT get a custom inline widget

§2.1 as originally written said embeds should get the same plain-text
inline treatment as links (brackets/`!` stripped, replaced with clean
text). **That turned out to be wrong in practice and was reverted** —
Obsidian's own Live Preview already renders `![[...]]` as a native inline
embedded block (the target note's content appears embedded directly in the
running text; this is standard, existing Obsidian behavior, not something
this plugin adds). `linkMarkers.ts`'s `buildDecorations()` was originally
adding its OWN `Decoration.replace` over the same character range Obsidian
already decorates — two extensions both trying to replace the same range
causes CM6 to resolve the conflict inconsistently from render to render:
sometimes the plugin's decoration won (margin chip appeared, but the
inline text showed only the chip's label with no embedded content),
sometimes Obsidian's own decoration won (the full embed appeared inline as
normal, and the plugin's decoration silently failed to attach). This was
reported as "sometimes preview shows, sometimes it doesn't" and reproduced.

**Fix (already applied, see `linkMarkers.ts`):** `buildDecorations()` now
skips embeds (`if (m.isEmbed) continue;`) before building the inline
`Decoration.replace` — so `![[...]]`'s appearance in the running text is
left entirely to Obsidian's own native embed rendering, unmodified. Embeds
still get everything else this plan promised: full parsing
(`findLinkMarkers`, `isEmbed: true`), a margin chip with its own accent
color and "embed" label, an async live preview via `linkPreview.ts`, and
click-to-navigate — all of that is layered on independent of the inline
widget and was unaffected by this fix. Only the *inline text replacement*
for embeds was removed. `[[links]]` are unaffected — Obsidian does NOT
natively render those as embedded content (they're plain clickable link
text by default), so there's no competing decoration for `buildDecorations()`
to worry about there, and the original plain-text-widget treatment for
`[[links]]` stands as originally specified.

If a future change wants embeds to ALSO show the clean alias/title text
inline instead of Obsidian's own embed rendering, that would need to
either (a) find a way to override/suppress Obsidian's own embed decoration
extension specifically (not attempted — likely fragile, undocumented,
version-dependent), or (b) accept that showing both an inline embed AND
suppressing Obsidian's version isn't possible without (a), and instead
make the margin chip the primary place a clean preview shows, which is
already what's shipped today.

### Second post-completion amendment: embed handling removed entirely, not just the inline widget

The amendment above still left embeds with a margin chip, an `isEmbed`
flag, and their own accent color (`EMBED_CHIP_COLOR`) — only the inline
text replacement had been dropped. **That's since been removed too.**
Current `linkMarkers.ts` doesn't have an `isEmbed` field at all; its regex
(`LINK_RE`) only matches `[[...]]`, and `findLinkMarkers()` explicitly skips
any match preceded by `!` rather than parsing it into a marker with a flag.
There is no embed margin chip, no `EMBED_CHIP_COLOR` (removed from
`noteTypes.ts`), and no embed-specific code path anywhere in this feature
— `![[embeds]]` are 100% Obsidian's native rendering, completely outside
this plugin's involvement, full stop.

**Why:** once embeds no longer got an inline widget (the first amendment,
above), the only thing they still got from this plugin was a margin chip
duplicating content Obsidian was already showing live, inline, in the
running text. That's not a bug fix at that point, it's a design call: a
second copy of the same content sitting in the margin next to the one
already visible in the prose added visual clutter and one more code path
(with its own accent color, label, and layout-merge participation) for
zero net benefit over just... not doing that. `[[links]]` justify a margin
chip because Obsidian gives them nothing extra by default (they're plain
clickable text with no preview) — that's the actual gap this plugin fills.
Embeds never had that gap to begin with.

If a future maintainer wants embed margin chips back, treat it as a new
feature request, not a bug — re-add an `isEmbed`-flagged marker (this
document's original §2/§2.3 sections above still describe the shape that
would take), decide whether it's still worth the duplication given
Obsidian's native embed rendering, and give it its own accent color again
rather than assuming today's `[[link]]`-only code already has a hook for
it (it doesn't, on purpose).

---


**Audience for this document:** an LLM (or developer) picking up this codebase
cold, with no prior conversation history. Everything you need — architecture,
gotchas already hit and fixed, and the exact design decisions the human
maintainer made — is below. Read the whole thing before writing code; the
"Gotchas" section exists because several of these were discovered the hard
way and re-deriving them from scratch will waste time or reintroduce bugs.

---

## 0. Context: what this plugin already does

Margin Notes is an Obsidian plugin (CodeMirror 6 / `@codemirror/view`) that
renders `[mn: content]` / `[mn.type: content]` markers inline in a markdown
document as small superscript numbers, with the note's actual content shown
in a column to the right of the text ("the margin"), aligned to the line the
marker sits on. See the repo root `README.md` for the full existing
architecture. Relevant existing files:

- `src/noteMarkers.ts` — regex-scans the doc for `[mn...]` markers, decorates
  them as superscript widgets via a CM6 `StateField`.
- `src/marginPanel.ts` — the actual margin column: a `ViewPlugin` that builds
  one absolutely-positioned "chip" div per marker, aligned to that marker's
  line, with collision-avoidance so chips don't overlap.
- `src/noteTypes.ts` — a flat list of note "types" (info/warning/todo/etc),
  each with a color, used for the marker's text color and the chip's
  left-border accent color.
- `styles.css` — all margin/chip CSS.

This plan adds two independent-but-related features on top of that:

1. **Links/embeds rendered in the margin.** A `[[Note Title]]` in the prose
   should render inline as plain text (no brackets, no default blue
   link styling) — just the words, clickable, visually like normal prose. A
   margin chip appears next to that line showing a live-rendered preview of
   the target note's content (for `[[links]]`, the note's rendered content;
   for `![[embeds]]`, the same — treat both the same way content-wise, see
   §2). This is a *new, second kind* of margin chip, visually similar to
   `mn` chips (reuses `.mn-chip` shell, clamping, and — after this plan —
   hover-zoom) but with its own accent color and click behavior (open the
   note, not "edit inline text").

2. **Hover-zoom for ALL margin chips** (both `mn` note chips and the new
   link/embed chips). On mouse hover, a chip scales up noticeably and shows
   its full, un-clamped content, floating over its neighbors — a "tile lifts
   off the stack" motion, not just an instant max-height snap. It happens
   for every chip, not just crowded/clamped ones. The cursor in the main
   text is completely unaffected — this is purely a mouse-hover visual, not
   a click, not a focus change, not a scroll. It must appear pinned to the
   margin's horizontal position (same `left`/`right`/width as the column) —
   it must NOT drift toward the center of the document or grow into the main
   text area. This **replaces** the existing "clamped chip expands on
   hover" CSS (see Gotcha #4) with one unified hover treatment for every
   chip, clamped or not.

These two features are described together because link/embed chips need to
support the same hover behavior as note chips from day one — build hover-zoom
as a shared mechanism both chip-builders use, not two separate
implementations.

---

## 1. Gotchas already discovered (do not rediscover these)

These cost real debugging time in this codebase already. Take them as given.

### Gotcha #1 — `EditorView.documentTop` is NOT a stable constant
It is defined (CM6 source, `editorview.ts`) as
`contentDOM.getBoundingClientRect().top + viewState.paddingTop` — a
**viewport-relative screen coordinate**. It changes every time the editor
scrolls. Using it to compute a chip's stored `top` (in a coordinate space
that already scrolls naturally as a DOM child of `.cm-scroller`) causes the
chip to be correctly positioned only in the instant right after some CM6
transaction fires, then drift wrong as soon as the user scrolls without
triggering a `ViewUpdate` (plain wheel/trackpad scroll does not fire one).
**Do not use `documentTop` or `documentPadding.top` for this.**

### Gotcha #2 — `lineBlockAt(pos).top` gives the top of the whole *logical*
line, not the specific *wrapped visual row* `pos` is on, once `pos` is
outside `view.viewport`'s already-measured `viewportLines`. CM6's own
`lineBlockAt` implementation does `viewportLines.find(...)` first and only
falls back to a coarser `heightMap.lineAt(...)` query outside the viewport;
that fallback anchors to the paragraph's *first* visual row, not the actual
wrapped row containing `pos`. In prose with wrapped paragraphs, this made
every note's margin chip land several lines too high — reproducible,
constant-per-marker, and it does NOT change with scrolling (ruling out
Gotcha #1's symptom as the cause when you see this).

**The fix in place today (`marginPanel.ts`):** use
`view.coordsAtPos(pos)` instead — it returns real *screen* coordinates for
the exact character, verified empirically (via a live console diagnostic) to
match the DOM anchor element's own `getBoundingClientRect().top` exactly,
regardless of wrapping. Convert to track-relative coordinates with:

```ts
const scrollerTop = view.scrollDOM.getBoundingClientRect().top;
const scrollTop = view.scrollDOM.scrollTop;
const top = coords.top - scrollerTop + scrollTop;
```

`coordsAtPos` can return `null` for a position currently scrolled fully out
of the rendered viewport (CM6 only measures what's drawn) — fall back to
`lineBlockAt(pos).top` ONLY in that null case; it's a rare, acceptable
approximation for off-screen content, not the common path.

**When you add link/embed markers to the margin layout, reuse this exact
positioning logic — do not write a second, parallel implementation.** Both
`mn` chips and link/embed chips should go through one shared "where does
marker.from render on screen" helper (see §3, extract this into a function).

### Gotcha #3 — chip height was unclamped, causing crowding to push chips
away from their real anchors
Originally every chip printed its full content unconditionally, and the
per-chip collision-avoidance (`CHIP_GAP`) only pushed a *colliding* chip
further down — it never shrank a chip to avoid causing the collision in the
first place. In a dense area (several notes on nearby lines), one long
chip's real height would shove every chip below it further from *its own*
true anchor line, compounding visual misalignment from a totally different
cause than Gotcha #2.

**The fix in place today:** a two-pass layout. Pass 1 computes every
marker's true, un-clamped anchor `top` up front (via the Gotcha #2 fix).
Pass 2 places chips top-down; for each chip, it looks ahead at the *next*
marker's own anchor top (not the previous chip's post-clamp bottom) to
compute how much vertical room is genuinely available, and clamps this
chip's `max-height` (CSS var `--mn-chip-max-height`, floor of 20px) only if
its natural content height would exceed that room. An isolated chip with
space below it is never clamped. See `marginPanel.ts` render() pass 1/pass 2
comments for the full reasoning — read them before touching this function.

### Gotcha #4 — (being replaced by this plan) hover currently only affects
clamped chips
The current CSS (`styles.css`) only defines a hover-expand rule for chips
that carry the `.mn-chip-clamped` class (added by the JS when clamping
kicks in — see Gotcha #3). Non-clamped chips have no hover treatment at
all. **This plan explicitly replaces that rule** with the unified
hover-zoom described in §4 below, which applies to every chip regardless of
clamped state. Remove the old `.mn-chip.mn-chip-clamped:hover` rule as part
of this work — don't leave both active at once, they'll conflict.

### Gotcha #5 — Obsidian's plugin API may not render `![[embed]]` syntax
directly
As of the last time this was checked (forum reports from 2021, unconfirmed
whether still true in current Obsidian versions — **verify against the
current Obsidian API docs before relying on this**), `MarkdownRenderer.render()`
was reported not to expand embed (`![[...]]`) syntax the way Obsidian's own
built-in renderer does — it renders plain markdown fine, but embed
transclusion specifically was an unsupported edge case.

**Safe approach used in this plan (§2):** don't try to render the
`![[...]]` syntax token itself through the renderer. Instead, resolve the
link target to a `TFile` yourself (via `app.metadataCache.getFirstLinkpathDest`),
read *that file's own raw content* (`app.vault.read(file)` or
`app.vault.cachedRead(file)`), and feed *that* markdown string into
`MarkdownRenderer.render(app, markdown, el, sourcePath, component)`. This
produces the same practical result (a live rendered preview of the target
note) without depending on the renderer's embed-token support at all. Treat
`[[link]]` and `![[embed]]` identically at the content-fetching level — the
only difference between them should be inline treatment (see §2.1) if you
choose to make one, though the maintainer's current direction is to treat
them the same in the margin too (a live preview either way).

### Gotcha #6 — no existing link-resolution helper in this codebase
There is currently no code anywhere in `src/` that resolves `[[...]]` link
targets. You are building this from scratch. Use Obsidian's own resolution
API — do not hand-roll path-matching:

```ts
const dest = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
// dest: TFile | null. sourcePath = the file containing the [[link]] itself
// (needed because Obsidian resolves relative/shortest-path links relative
// to the linking file, not the vault root).
```

---

## 2. Feature 1: links/embeds rendered in the margin

### 2.1 Inline treatment (what stays in the running text)

For a `[[Character Bible]]` or `[[Character Bible|Alice]]` or
`![[Chapter 3 Outline]]` found in the document:

- Replace the raw `[[...]]` syntax (brackets included) with a plain
  `<span>` containing just the display text — the alias if present
  (`Character Bible|Alice` → `Alice`), otherwise the link target's name
  (`Character Bible`). For `![[...]]` (embed) syntax, drop the leading `!`
  too along with the brackets.
- No default Obsidian link color, no underline. It should read as normal
  prose — same color/weight as surrounding text (`color: var(--text-normal)`
  or inherit).
- Still clickable: clicking should navigate to the target note, same as a
  normal Obsidian internal link (use `app.workspace.openLinkText(linkpath,
  sourcePath)` — this is the standard Obsidian API for "open this like a
  wikilink would," and correctly handles headings/aliases/creating-if-
  missing the same way Obsidian's own link click does).
- A subtle non-color hover cue is fine (e.g. cursor: pointer, maybe a very
  faint underline on hover only) — the point is it shouldn't visually shout
  "I am a link" the way Obsidian's default blue does, but it should still
  discoverably behave like one.
- Give this widget its own CSS class (e.g. `.mn-linktext`) — do not reuse
  `.mn-anchor`/`.mn-marker` (those are for `mn:` note superscripts and
  should stay visually and semantically distinct).

### 2.2 Margin treatment (the new chip type)

- A chip appears in the margin aligned to the line the `[[...]]`/`![[...]]`
  syntax sits on — reuse the exact positioning pipeline from
  `marginPanel.ts` (Gotcha #2's `coordsAtPos`-based approach, and Gotcha #3's
  clamp-when-crowded pass). **This strongly suggests refactoring
  `marginPanel.ts`'s render loop to operate over a unified list of "margin
  items"** (a shared interface covering both `NoteMarker` and a new
  `LinkMarker` type) rather than duplicating the two-pass layout logic for a
  second marker kind. See §3 for the suggested refactor shape.
- Content: a live-rendered preview of the target note. Per Gotcha #5,
  fetch it like this:
  1. Resolve `dest = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)`.
  2. If `dest` is null (broken link, target doesn't exist yet), show a
     distinct "note not found" chip state (e.g. muted/dashed border,
     text like "No note titled '...' yet") — don't silently show nothing,
     and don't throw.
  3. If found, read its content (`app.vault.cachedRead(dest)` — preferred
     over `vault.read` for a read-only preview since it can serve from
     Obsidian's cache rather than hitting disk every render).
  4. Render that markdown into an off-screen or scratch container via
     `MarkdownRenderer.render(app, markdown, scratchEl, dest.path, component)`,
     then move/copy the resulting DOM into the chip. `component` needs to be
     a real `Component` instance you own and unload appropriately (see
     Gotcha #7 below) — required by the API so rendered content (e.g. any
     live re-render triggers) can clean itself up.
  5. Cache the rendered HTML (or the DOM fragment) keyed by
     `dest.path + ':' + contentHash` (or just `dest.stat.mtime`, simpler) so
     re-rendering the SAME margin column on every keystroke elsewhere in the
     document doesn't re-read-and-re-render every target file on every
     render pass. Invalidate the cache entry when `app.vault.on('modify')`
     fires for that specific file.
- This fetch is **async** — unlike `mn` chip content (already a plain
  string sitting in the document, synchronously available), link/embed
  chip content requires a disk read + markdown render that resolves later.
  The chip must render in the correct position immediately (using the
  cheap, synchronous `coordsAtPos` position math), with a lightweight
  loading state (e.g. skeleton/pulsing placeholder, or just the target's
  bare title while content loads), then have its content swapped in
  without re-triggering the whole margin layout pass (which would be
  wasteful and could cause visible jank on every note that references a
  link). Only the individual chip's *inner* content should update in
  place; do not call the full `render()` layout pass again just because one
  async fetch resolved — that would re-run positioning for every chip
  unnecessarily. (It's fine if a change in one chip's final rendered height
  requires a follow-up "just re-check crowding/clamping" pass — just don't
  make that a full re-fetch of every other chip's content too.)
- Give this chip type a distinct accent color from `mn` note chips (extend
  the `noteTypeColor`-style pattern — e.g. a new small module or an addition
  to `noteTypes.ts`'s pattern, but for link-kind rather than note-type,
  since these aren't `mn.` markers and shouldn't be forced through that
  registry). Suggested: one color for `[[link]]`, a distinct one for
  `![[embed]]`, so a user scanning the margin can tell at a glance which
  kind of thing they're looking at, even though both show a content
  preview.
- Clicking a link/embed chip should navigate to that note (same
  `openLinkText` call as clicking the inline text) — **not** "select text in
  the document" the way `mn` chip clicks do (`focusNoteText` in
  `marginPanel.ts` is specific to `mn` markers' edit-in-place model; link/
  embed chips have no "inline content" to select, since their inline text
  IS the link, not a note body).

### 2.3 New source files to add

- `src/linkMarkers.ts` — parallel structure to `noteMarkers.ts`. Needs:
  - A regex to find `!?\[\[([^\]]+)\]\]` (careful: this needs to correctly
    split `target|alias` and `target#heading` inside the capture — write
    tests/examples for `[[Note]]`, `[[Note|Alias]]`, `[[Note#Heading]]`,
    `[[Note#Heading|Alias]]`, `![[Note]]`, `![[Note#Heading]]`).
  - A `LinkMarker` interface: `{ from, to, id, isEmbed: boolean, linkpath:
    string, heading: string | null, alias: string | null }`.
  - `findLinkMarkers(doc, sourcePath)` — note it needs `sourcePath` (unlike
    `findNoteMarkers`) because link resolution is relative to the
    containing file.
  - A `StateField` (or extend the existing `noteMarkerField` pattern) that
    decorates matched ranges with the plain-text inline widget (§2.1).
- Extend `marginPanel.ts` (or, cleaner, factor its shared layout logic into
  a new `src/marginLayout.ts` that both `mn` and link/embed chip-builders
  call into) to also collect `LinkMarker`s and lay out their chips using
  the same positioning/clamping pipeline as `mn` chips (§3 has the
  suggested shape).
- A small new module (e.g. `src/linkPreview.ts`) owning the async
  fetch-resolve-render-cache logic from §2.2, so `marginPanel.ts` doesn't
  balloon with disk/render/cache concerns — it should just ask this module
  "give me the current preview state for this LinkMarker" and get back
  either a cached DOM node or a "pending" signal to show a placeholder for.

### 2.4 Gotcha #7 — lifecycle: the `Component` MarkdownRenderer.render()
needs
`MarkdownRenderer.render(app, markdown, el, sourcePath, component)` requires
a `Component` you own, so that any child renderers it creates (embeds within
the previewed note, links within it, etc.) can be told to unload when the
chip goes away — otherwise you leak listeners every time a chip is rebuilt
(which is often — every `render()` pass in `marginPanel.ts` rebuilds all
chips from scratch, see `this.track.replaceChildren()`). Create one
`Component` per chip (or per link-preview cache entry, reused across
re-renders of the same target), call `.load()` when created and `.unload()`
either when the chip's cache entry is evicted or when `MarginColumn.destroy()`
runs for the whole editor. Do not let this leak silently — audit this
carefully, since the existing render loop rebuilds the whole track (all
chips) on every scroll/edit/selection change (see `ViewPlugin`'s `update()`
in `marginPanel.ts`), so a naive per-render `new Component()` without
tracking + unloading old ones will leak fast in a document with several
links.

---

## 3. Suggested refactor: unify chip layout across marker kinds

Right now `marginPanel.ts`'s `render()` method is written specifically
around `NoteMarker`. To avoid duplicating the (nontrivial, already-debugged)
positioning + clamping logic for a second marker kind, refactor toward:

```ts
interface MarginItem {
  from: number;         // document position this item anchors to
  id: string;           // unique key across ALL item kinds combined
  buildChip(): HTMLDivElement;  // returns the chip shell; content may fill in async
}
```

`render()` becomes: gather `NoteMarker`s and `LinkMarker`s, map both into
`MarginItem[]`, sort by `.from`, then run the existing two-pass
anchor-then-clamp layout (Gotcha #2/#3 logic) generically over
`MarginItem[]` instead of `NoteMarker[]`. `buildChip()` for note markers
stays exactly as `buildChip()` is today; a new `buildLinkChip()` (in
`linkMarkers.ts` or `linkPreview.ts`) implements the async-content version
for link/embed items. This keeps the hard-won positioning code
(coordsAtPos, anchor lookahead, clamping) in exactly one place.

This refactor is not strictly mandatory to ship Feature 1, but strongly
recommended — implementing link/embed chip positioning as a second,
separate copy of the layout logic risks the two drifting out of sync when
one gets bugfixed later (as happened twice already with the note-chip
layout — see Gotchas #1-#3). If you skip this refactor, at minimum extract
the anchor-position helper (`coordsAtPos` + fallback, Gotcha #2's fix) into
one shared exported function both marker kinds call — never reimplement
that specific piece twice.

---

## 4. Feature 2: hover-zoom for every margin chip

### 4.1 Behavior specification

- Trigger: `:hover` on any `.mn-chip` (both `mn` note chips and the new
  link/embed chips) — pure CSS pseudo-class, no JS mouseenter/mouseleave
  handlers needed for the visual itself (JS may still be involved for the
  link-preview content fetch, but the zoom/scale/shadow motion should be
  CSS-driven for smoothness and simplicity).
- Applies uniformly to every chip — clamped or not. A chip that already
  shows its full content unclamped still gets the same hover lift/shadow
  treatment for visual consistency, even though there's no additional
  content to reveal in that case.
- Visual: on hover, the chip scales up noticeably (maintainer specified
  "noticeably larger, can overlap/cover neighboring chips above/below" —
  this is a deliberate choice: the hover state is allowed to visually cover
  the chip above/below it, since it's a temporary overlay, not a
  layout-affecting expansion). Suggested approach: `transform: scale(1.08)`
  to `scale(1.15)` (tune to feel right, test a few values), plus if the
  chip was clamped, simultaneously lift `max-height` to `none` so full
  content is visible while scaled. No hard border — "no borders and any
  distraction" per the maintainer's brief — so drop `.mn-chip`'s existing
  `border` on the hovered state (keep the subtle `border-left` accent
  color if desired, or drop that too — maintainer said "no borders", lean
  toward dropping all border, relying on background contrast + shadow
  instead to read as "lifted").
- A soft shadow (`box-shadow`) is appropriate to sell the "lifted off the
  stack" feel — something like
  `box-shadow: 0 8px 24px var(--background-modifier-box-shadow, rgba(0,0,0,0.3));`
  — tune opacity/blur to taste, should read as a soft elevation, not a hard
  drop-shadow.
- Positioning constraint (maintainer explicit requirement): **the hovered,
  scaled-up chip must stay pinned to its horizontal position in the margin
  column — it must never grow/drift toward the center of the document or
  overlap the main text area.** Concretely: don't scale from `transform-origin:
  center`, which would grow the chip both left AND right, potentially
  pushing its right/left edges into the reserved margin's boundary or past
  it toward the text. Use `transform-origin: right center` (chips are
  right-aligned in the margin per existing CSS: `.mn-margin-track { right:
  8px; }`) so growth happens leftward/vertically, stays inside the margin's
  reserved space, and never encroaches on `.cm-content`. Verify this
  visually against a real editor at the plugin's minimum configured margin
  width (`marginWidth` setting, default likely 220px per `settings.ts` —
  check current default) to make sure scaled chips don't get clipped by
  `.mn-margin-track`'s own `overflow` (currently the track has no explicit
  `overflow` rule — confirm it stays that way, or explicitly set
  `overflow: visible` on `.mn-margin-track`, since a hovered chip
  legitimately needs to render outside the track's own box when scaled up).
- `z-index`: hovered chip needs to render above its non-hovered siblings
  (which are laid out via absolute positioning within the same track) —
  set a clearly higher `z-index` on `:hover` (e.g. `z-index: 20`, higher
  than any other stacking already in play in `.mn-chip` rules).
- The cursor/caret in the main editor text is completely unaffected by any
  of this — this is pure CSS `:hover` + `transform`, no `view.dispatch()`,
  no selection change, no focus change. Do not attach this to the existing
  `mousedown` handler in `buildChip()`/`buildLinkChip()` (that handler is
  specifically for *click*, i.e. commit — hover-zoom must never fire on
  click alone if the mouse isn't actually resting there, and must never
  itself call `view.focus()` or move the selection).

### 4.2 CSS sketch (illustrative — tune values, don't treat as final)

```css
.mn-chip {
  /* existing rules stay: position: absolute; background; padding; etc. */
  transition: transform 120ms ease-out, box-shadow 120ms ease-out, max-height 120ms ease-out;
  transform-origin: right center;
  z-index: 1;
}

.mn-chip:hover {
  transform: scale(1.12);
  max-height: none;
  overflow: visible;
  border-color: transparent; /* or remove border entirely, see 4.1 */
  box-shadow: 0 8px 24px var(--background-modifier-box-shadow, rgba(0, 0, 0, 0.3));
  z-index: 20;
  mask-image: none; /* clear any clamp fade-mask from Gotcha #3's clamped state */
}

.mn-margin-track {
  /* existing rules stay */
  overflow: visible; /* make sure hovered chips aren't clipped when scaled */
}
```

Remove entirely: the old `.mn-chip.mn-chip-clamped:hover` rule (Gotcha #4) —
this plan's `.mn-chip:hover` rule supersedes it for every chip, clamped or
not. Keep `.mn-chip-clamped`'s non-hover mask/max-height rules as-is (they
still govern the resting, non-hovered state).

### 4.3 What NOT to change

- Do not touch the underlying anchor-position math (§Gotcha #2/#3) to
  accommodate hover — hover is purely a visual overlay on top of an
  already-correctly-positioned chip. The chip's `top`/stored layout value
  should never change on hover; only `transform`/`max-height`/`box-shadow`
  (all non-layout-affecting properties, so hovering one chip must not shift
  where any other chip sits).
- Do not make hover asynchronous or dependent on the link-preview fetch
  (§2.2) completing — a link/embed chip mid-loading should still zoom on
  hover, just showing its loading placeholder at the larger scale, exactly
  like a note chip showing its (complete) content at scale.

---

## 5. Suggested build order

1. Refactor `marginPanel.ts` per §3 (or at minimum extract the shared
   anchor-position helper) — do this first so link/embed chips have
   somewhere correct to plug into, and so you don't have to touch the
   layout math twice.
2. Ship hover-zoom (§4) against the *existing* `mn` chips only, using the
   refactored/shared chip shell. This is CSS-only-ish, low-risk, and
   independently testable/shippable before link support exists at all.
3. Build `linkMarkers.ts` (§2.1 + §2.3) — inline plain-text rendering and
   click-to-open, with a synchronous placeholder margin chip (e.g. just the
   target title, no preview yet). Verify positioning/clamping work
   correctly for this new marker kind riding the shared layout pass.
4. Layer in `linkPreview.ts` (§2.2 + Gotcha #5/#7) — async content fetch,
   caching, and swapping loading-state chips for rendered-content chips
   in place.
5. Confirm hover-zoom (step 2's work) still behaves correctly on the new
   link/embed chips without any additional changes — if it doesn't "just
   work" because both chip kinds share `.mn-chip`, something in steps 3-4
   diverged from the shared shell and should be reconciled, not patched
   around with a second hover rule.

Test explicitly: a paragraph with an `mn` note AND a `[[link]]` close
together (within collision-avoidance range) — confirm clamping decisions
account for both kinds correctly when they're neighbors, since §3's
unification is exactly what makes that correct.