import { EditorView } from '@codemirror/view';

export const CHIP_GAP = 6;

/**
 * Generic shape any margin item (note chip, link/embed chip, or any future
 * kind) must satisfy to go through the shared two-pass layout below. Kept
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

  const anchorTops = items.map((item) => anchorTopFor(view, item.from, scrollerTop, scrollTop));

  let lastBottom = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const chip = item.buildChip();
    let top = anchorTops[i];
    if (top < lastBottom + CHIP_GAP) top = lastBottom + CHIP_GAP;
    chip.style.top = `${top}px`;

    const nextTop = i + 1 < items.length ? anchorTops[i + 1] : Infinity;
    const availableHeight = nextTop - top - CHIP_GAP;
    // Measure natural height by appending unclamped first — max-height
    // starts at "none" via the CSS default, so this read is accurate.
    track.appendChild(chip);
    const naturalHeight = chip.offsetHeight;
    if (Number.isFinite(availableHeight) && naturalHeight > availableHeight) {
      const clamped = Math.max(availableHeight, 20); // never clamp below ~one line + padding
      chip.style.setProperty('--mn-chip-max-height', `${clamped}px`);
      chip.classList.add('mn-chip-clamped');
      lastBottom = top + clamped;
    } else {
      lastBottom = top + naturalHeight;
    }
  }
}