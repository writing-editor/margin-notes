import { EditorView } from '@codemirror/view';

export const CHIP_GAP = 6;

/**
 * Per-track memory of the previous render's chip nodes, keyed by the track
 * element itself so each editor's margin column has independent state (a
 * WeakMap also means this never needs explicit cleanup when a track is
 * discarded — see layoutMarginItems' own doc comment for why this state
 * exists at all).
 */
const previousRenderByTrack = new WeakMap<HTMLDivElement, Map<string, { key: string; chip: HTMLDivElement }>>();

/**
 * Invalidates a track's remembered chip set without touching the DOM
 * itself. MUST be called by any caller that empties `track`'s children
 * directly (e.g. `track.replaceChildren()` on a "chips suppressed" bail-out
 * path) rather than through layoutMarginItems() — otherwise this module's
 * own reuse cache goes stale relative to what's actually attached: the next
 * layoutMarginItems() call would see the SAME item ids/keys as last time,
 * conclude every chip is reusable, skip its own track.replaceChildren()
 * call as a no-op DOM-churn optimization (see anyNewOrRemoved below), and
 * leave the real DOM emptied while only the chips' in-memory `style.top`
 * gets updated on now-detached nodes — visually nothing renders, and
 * nothing about that state self-corrects on a later call, since every
 * subsequent pass keeps seeing the same "nothing changed" reuse verdict.
 * This was the concrete cause of margin notes vanishing until a file
 * reload: a note-only file's chips have a content-derived, otherwise-
 * stable `key` (see MarginItem's own doc comment) and so are exactly the
 * shape of item that this stale-cache trap silently swallows; a file that
 * also has at least one link marker "self-heals" only as a side effect of
 * link chips deliberately never being reuse-eligible (their key changes
 * every render — see marginPanel.ts's buildLinkChip comment), which forces
 * track.replaceChildren() to run anyway and masks the same underlying bug.
 */
export function invalidateTrack(track: HTMLDivElement): void {
  previousRenderByTrack.delete(track);
}

/**
 * Generic shape any margin item (note chip, link chip, or any future kind)
 * must satisfy to go through the shared two-pass layout below. Kept
 * deliberately minimal — the layout pass only needs to know where an item
 * anchors in the document and how to build its chip DOM; it does not care
 * what kind of marker produced it.
 *
 * `id` must be unique across ALL item kinds combined (not just within one
 * kind) since chips from different marker kinds are laid out in one merged,
 * sorted list.
 */
export interface MarginItem {
  from: number;
  id: string;
  /**
   * Content fingerprint for this item's chip, distinct from `id`. `id` is
   * the item's stable SLOT identity (which marker this is, so a reused DOM
   * node maps back to the right marker across renders) — it does NOT
   * change just because the marker's text was edited, since note/link
   * marker ids are assigned by ordinal position in the document, not
   * derived from content (see noteMarkers.ts/linkMarkers.ts). `key` is
   * what layoutMarginItems() actually compares to decide whether a
   * previous render's chip DOM node can be reused as-is: it should be a
   * cheap-to-compute string that changes whenever anything the chip
   * renders would change (label text, note body, link title/preview,
   * clamped/expanded state source data) so that editing a note's content
   * gets a freshly rebuilt chip even though its `id` stayed the same.
   */
  key: string;
  buildChip(): HTMLDivElement;
}

/**
 * Where does `pos` render on screen right now, in the track's own
 * (scroll-following) coordinate space?
 *
 * Gotcha #2: lineBlockAt(pos).top looks correct but is NOT — CM6's own
 * lineBlockAt does `viewportLines.find(...)` first and only falls back to a
 * coarser heightMap query once `pos` is outside the already-measured
 * viewport; that fallback anchors to a wrapped paragraph's *first* visual
 * row, not the actual wrapped row `pos` is on. In prose with wrapped
 * paragraphs this put every chip several lines too high, constantly
 * (independent of scroll position, unlike Gotcha #1's symptom).
 *
 * The fix: coordsAtPos(pos) asks CM6 directly "where does this character
 * render on screen right now" — verified empirically (live-editor
 * diagnostic) to agree exactly with the anchor DOM element's own
 * getBoundingClientRect(), regardless of wrapping. It returns
 * viewport-relative screen coordinates; converting to the track's
 * scroll-following coordinate space needs exactly one subtraction (the
 * scroller's own screen position) — see Gotcha #1 for why using
 * `view.documentTop` instead would be wrong (it's viewport-relative too and
 * drifts on scrolls that don't fire a ViewUpdate).
 *
 * Falls back to lineBlockAt(pos).top ONLY when coordsAtPos returns null,
 * which happens for positions currently scrolled fully out of the rendered
 * viewport (CM6 only measures what's drawn) — a rare, acceptable
 * approximation for off-screen content, not the common path.
 */
export function anchorTopFor(view: EditorView, pos: number, scrollerTop: number, scrollTop: number): number {
  const coords = view.coordsAtPos(pos);
  return coords ? coords.top - scrollerTop + scrollTop : view.lineBlockAt(pos).top;
}

/**
 * Two-pass layout shared by every margin item kind.
 *
 * Pass 1 (done by the caller, via anchorTopFor per item) establishes every
 * item's true, un-clamped anchor top up front. Pass 2 (this function) places
 * chips top-down; for each chip it looks ahead at the *next* item's own
 * anchor top (not the previous chip's post-clamp bottom) to compute how much
 * vertical room is genuinely available, and only clamps this chip's
 * max-height (floor 20px) if its natural content height would exceed that
 * room. An isolated chip with space below it is never clamped.
 *
 * Looking ahead at the next item's real anchor rather than the previous
 * chip's clamped bottom matters: using the previous chip's actual (possibly
 * already-clamped) bottom would compound clamping decisions down the list
 * instead of basing each one on the real, independent anchor below it — see
 * Gotcha #3.
 *
 * `items` must already be sorted by `.from` ascending — this function does
 * not sort them, since different marker kinds may need a stable merge sort
 * by document position rather than being sorted independently.
 */
export function layoutMarginItems(
  view: EditorView,
  track: HTMLDivElement,
  items: MarginItem[]
): void {
  const scrollerTop = view.scrollDOM.getBoundingClientRect().top;
  const scrollTop = view.scrollDOM.scrollTop;

  // Reuse chip DOM nodes across calls, keyed by MarginItem.id with a `key`
  // (content fingerprint) check, instead of building and swapping in a
  // brand-new node for every item on every call. This matters for more
  // than raw DOM-churn cost: track lives INSIDE .cm-scroller as a sibling
  // of .cm-content, so any mutation to its children is a mutation inside
  // CM6's own scrolling container — CM6 (and Obsidian's surrounding
  // layout) can react to that by re-measuring geometry, even when the
  // mutation didn't actually change anything visible (e.g. this rebuild
  // reconfirmed the exact same chip set that was already there). That's
  // the actual mechanism behind the width "blink": .cm-content momentarily
  // reclaiming margin-right space and giving it back is downstream of the
  // DOM churn itself, not of the margin-right CSS value ever changing
  // (mn-has-margin isn't touched by typing at all — see
  // updateChipsAllowed's own doc comment). If the chip set genuinely
  // hasn't changed, the only children touched below are the reused nodes'
  // own style.top (a style mutation, not a childList mutation) — nothing
  // gets removed or re-inserted, so there's nothing for CM6 to interpret
  // as "the scroller's content changed".
  //
  // `id` alone is NOT enough to key reuse on: note/link marker ids are
  // assigned by ordinal position in the document (see noteMarkers.ts/
  // linkMarkers.ts), not derived from content, so editing an existing
  // note's text leaves its id unchanged. Comparing `key` too (see
  // MarginItem's own doc comment) is what catches that case and forces a
  // fresh buildChip() instead of reusing a now-stale node.
  const previous = previousRenderByTrack.get(track);
  const current = new Map<string, { key: string; chip: HTMLDivElement }>();
  let anyNewOrRemoved = previous === undefined || previous.size !== items.length;

  const chips = items.map((item) => {
    const prevEntry = previous?.get(item.id);
    const reusable = prevEntry && prevEntry.key === item.key;
    const chip = reusable ? prevEntry.chip : item.buildChip();
    if (!reusable) anyNewOrRemoved = true; // covers both "new id" and "id existed but key changed"
    current.set(item.id, { key: item.key, chip });
    return chip;
  });
  previousRenderByTrack.set(track, current);

  const anchorTops = items.map((item) => anchorTopFor(view, item.from, scrollerTop, scrollTop));

  // Reused chips are already attached in `track` with their previous
  // content — their offsetHeight can be read directly with no separate
  // measurement step. Only genuinely new/rebuilt chips need the detached-
  // container measurement pass, since they're not attached anywhere yet.
  const isNewChip = new Set(
    chips.filter((chip, i) => {
      const prevEntry = previous?.get(items[i].id);
      return !prevEntry || prevEntry.key !== items[i].key;
    })
  );
  const naturalHeightsByChip = new Map<HTMLDivElement, number>();
  if (isNewChip.size > 0) {
    const measureHost = track.ownerDocument.createElement('div');
    // setCssStyles (not direct .style.x assignment) per Obsidian's plugin
    // guidelines — obsidianmd/no-static-styles-assignment.
    measureHost.setCssStyles({
      position: 'absolute',
      visibility: 'hidden',
      pointerEvents: 'none',
      // Same width as the live track — a chip's wrapped-text height
      // depends on its available width, so measuring in a container of a
      // different width would give the wrong natural height.
      width: `${track.clientWidth}px`,
    });
    track.ownerDocument.body.appendChild(measureHost);
    for (const chip of isNewChip) measureHost.appendChild(chip);
    for (const chip of isNewChip) naturalHeightsByChip.set(chip, chip.offsetHeight);
    measureHost.remove();
  }
  for (const chip of chips) {
    if (!naturalHeightsByChip.has(chip)) {
      // Reused chip: it may still carry --mn-chip-max-height/mn-chip-clamped
      // from a PREVIOUS render pass. Reading offsetHeight without clearing
      // that first would measure the stale clamped height, not the chip's
      // true natural content height — feeding a wrong (too-small)
      // naturalHeight into this pass's clamp decision below. That mismatch
      // is what could make a chip's clamped/unclamped state oscillate
      // across renders even though nothing about its content or the
      // available space actually changed: this pass sees a falsely-small
      // natural height, decides it fits, unclamps it (chip visually
      // expands to something still capped by the OLD max-height until the
      // next paint) — then the following pass measures the now-genuinely-
      // larger unclamped height, decides it doesn't fit, clamps it again.
      // Clearing before measuring breaks that loop.
      chip.style.removeProperty('--mn-chip-max-height');
      chip.classList.remove('mn-chip-clamped');
      naturalHeightsByChip.set(chip, chip.offsetHeight);
    }
  }

  let lastBottom = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const chip = chips[i];
    let top = anchorTops[i];
    if (top < lastBottom + CHIP_GAP) top = lastBottom + CHIP_GAP;
    chip.setCssStyles({ top: `${top}px` });

    const nextTop = i + 1 < items.length ? anchorTops[i + 1] : Infinity;
    const availableHeight = nextTop - top - CHIP_GAP;
    const naturalHeight = naturalHeightsByChip.get(chip)!;
    if (Number.isFinite(availableHeight) && naturalHeight > availableHeight) {
      const clamped = Math.max(availableHeight, 20); // never clamp below ~one line + padding
      chip.style.setProperty('--mn-chip-max-height', `${clamped}px`);
      chip.classList.add('mn-chip-clamped');
      lastBottom = top + clamped;
    } else {
      chip.style.removeProperty('--mn-chip-max-height');
      chip.classList.remove('mn-chip-clamped');
      lastBottom = top + naturalHeight;
    }
  }

  // Only touch track's actual children (a childList mutation) if the set of
  // ids/keys genuinely changed. Repositioning already-attached, reused
  // chips via style.top above never needs this — DOM order doesn't affect
  // their absolute-positioned layout, so there's no need to reorder
  // children to match `items`' order either.
  if (anyNewOrRemoved) {
    track.replaceChildren(...chips);
  }
}