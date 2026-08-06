import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { editorInfoField, Platform } from 'obsidian';
import { runtime, isMarginNotesEnabled } from './runtime';
import { findNoteMarkers, forceMarginRefresh, NoteMarker } from './noteMarkers';
import { noteTypeColor } from './noteTypes';
import { MarginItem, layoutMarginItems, invalidateTrack } from './marginLayout';
import type { Placement } from './agents';
import { renderPlacementText } from './agents';

/**
 * Small trash-can icon (not an "×") for the per-chip delete button — an "×"
 * reads as "dismiss/close the hover-zoom", which is exactly the wrong
 * signal for a destructive, irreversible-feeling action. A bin icon makes
 * "this deletes the note" unambiguous at a glance, without needing a text
 * label the tiny badge has no room for anyway.
 *
 * Built via Obsidian's own `createSvg`/`createEl` element-creation methods
 * (available on every HTMLElement/SVGElement, per Obsidian's `Node`
 * interface extension in obsidian.d.ts) rather than an innerHTML string.
 * The string was a fixed constant with no user input, so it was never an
 * actual injection risk, but Obsidian's own reviewer/linter flags
 * innerHTML categorically since it can't tell "safe hardcoded constant"
 * apart from "unsafe interpolated string" — and separately prefers its
 * own createEl-family helpers over raw `document.createElement`/
 * `document.createElementNS` so every plugin's DOM construction goes
 * through one consistent, typed API.
 */
function appendTrashIcon(button: HTMLButtonElement): void {
  const svg = button.createSvg('svg', { attr: { viewBox: '0 0 24 24' } });
  const paths = ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13', 'M10 11v6', 'M14 11v6'];
  for (const d of paths) {
    svg.createSvg('path', { attr: { d } });
  }
}

/**
 * Shared builder for a chip's delete button, so the pinned-badge
 * positioning/hover-reveal behaviour (all in styles.css's .mn-chip-delete
 * rules) and the "don't let this click fall through to the chip's own
 * mousedown handler" guard live in exactly one place.
 */
function buildDeleteButton(onDelete: () => void): HTMLButtonElement {
  const btn = createEl('button', { cls: 'mn-chip-delete', attr: { type: 'button', 'aria-label': 'Delete note' } });
  appendTrashIcon(btn);
  btn.addEventListener('mousedown', (evt) => {
    // Must stop this before it bubbles to the chip's own mousedown listener
    // (buildChip's focusNoteText) — otherwise deleting would also fire the
    // chip's normal "navigate/focus" action on the same click.
    evt.preventDefault();
    evt.stopPropagation();
    onDelete();
  });
  return btn;
}

// Exported so main.ts's insert-note command can splice a new marker into a
// specific view without duplicating the [mn.type: content] formatting rule.
export function insertNoteAt(view: EditorView, pos: number, type: string | null, content: string) {
  const tag = type ? `mn.${type}` : 'mn';
  const marker = `[${tag}: ${content}]`;
  view.dispatch({ changes: { from: pos, to: pos, insert: marker }, selection: { anchor: pos } });
}

/**
 * Inserting from the highest charPos down means each insertion never shifts
 * the position of one already placed above it — the shift only propagates
 * to positions greater than the insertion point, and we've already handled
 * those. Used by the agent runner to land several notes in one file.
 *
 * Plan §2 — a `kind: 'report'` placement inserts a plain `[[link]]`
 * (already-built text, via `reportLinkTexts`, keyed by charPos) instead of
 * an `[mn.ai: ...]` marker — see renderPlacementText's and
 * buildReportLinkText's doc comments in agents.ts for why. Dispatched as
 * one plain string insert exactly like insertNoteAt's own marker string;
 * CodeMirror doesn't need to know it happens to contain `[[...]]`
 * syntax — Obsidian's own link-parsing extension (already registered
 * elsewhere) picks it up the same way it would a hand-typed link.
 */
export function insertAiNotes(view: EditorView, placements: Placement[], reportLinkTexts: Map<number, string> = new Map()) {
  const sorted = [...placements].sort((a, b) => b.charPos - a.charPos);
  for (const p of sorted) {
    const insertText = renderPlacementText(p, reportLinkTexts.get(p.charPos));
    view.dispatch({ changes: { from: p.charPos, to: p.charPos, insert: insertText }, selection: { anchor: p.charPos } });
  }
}

// How long to hold off rebuilding the margin column after a doc-changing
// keystroke, in ms — only applies to changes isDocChangeLayoutRelevant()
// (below) flags as actually able to move/add/remove a chip; a plain
// same-line character edit that isn't near a marker never reaches this at
// all (see the ViewPlugin's update()), so this only ever debounces a
// genuine burst of marker/newline edits rather than every keystroke.
const TYPING_DEBOUNCE_MS = 200;

// Safety-net interval, in ms, for a background refresh independent of any
// specific trigger. isDocChangeLayoutRelevant() is a heuristic over each
// transaction's inserted/deleted text — deliberately cheap, which means
// deliberately not exhaustive. If some edit path ever slips past it
// (an edge case in how CodeMirror batches/represents a particular kind of
// change, a future marker syntax this heuristic wasn't updated for, etc.),
// this periodic refresh is what self-corrects the column within a bounded
// worst-case delay instead of leaving it stale until some unrelated trigger
// (scroll, resize, selection move) happens to fire. 4s is long enough to
// cost nothing while idle or mid-typing, short enough that a missed
// condition is never wrong for more than a glance.
const SAFETY_NET_INTERVAL_MS = 4000;

/**
 * Cheap pre-filter for whether a doc-changing transaction could possibly
 * need a margin-column rebuild at all, checked BEFORE any debounce timer
 * is even armed (see the ViewPlugin's update() below) — most individual
 * keystrokes (typing a normal character in the middle of a line, nowhere
 * near any marker) touch neither a line count nor any marker-relevant
 * character, so they can be skipped entirely with zero rebuild, zero
 * debounce timer churn, and zero rescan of the document.
 *
 * Deliberately over-inclusive rather than exact: this only looks at the
 * raw characters/line-count of what changed, not whether a full marker
 * scan would actually find something new. A false positive here just
 * costs one debounced rebuild that turns out to reconfirm the same layout
 * (cheap, correct); a false negative would leave the column stale, which
 * is why every check below errs toward "yes, that counts":
 *
 * - Any inserted or deleted text containing '\n' — a line count change
 *   shifts every marker anchor below it, even ones the edit itself didn't
 *   touch (this is the single most common layout-relevant edit: pressing
 *   Enter).
 * - Any inserted or deleted text containing '[' or ']' — the only
 *   characters MN_RE (note markers) and LINK_RE (link markers) can start
 *   or end on. An edit that can't possibly create, remove, or resize a
 *   bracketed span can't change which markers exist.
 */
function isDocChangeLayoutRelevant(update: ViewUpdate): boolean {
  let relevant = false;
  update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (relevant) return; // already found a reason; skip scanning the rest
    const insertedText = inserted.toString();
    if (/[\n[\]]/.test(insertedText)) {
      relevant = true;
      return;
    }
    // Deleted text isn't available as a string directly from iterChanges
    // (it only gives us the INSERTED Text) — but a deletion that removed a
    // newline or bracket is exactly as layout-relevant as inserting one,
    // so read it from the pre-change doc via the fromA/toA range.
    const deletedText = update.startState.doc.sliceString(_fromA, _toA);
    if (/[\n[\]]/.test(deletedText)) {
      relevant = true;
    }
  });
  return relevant;
}

class MarginColumn {
  private readonly track: HTMLDivElement;
  private rafHandle: number | null = null;
  private debounceHandle: number | null = null;
  // Belt-and-suspenders background refresh — see SAFETY_NET_INTERVAL_MS's
  // doc comment. Scheduled with `immediate: false` so it competes for the
  // same debounce slot as a real edit rather than forcing its own
  // rebuild mid-keystroke; if nothing's actually changed, render() just
  // reconfirms the current layout at negligible cost.
  private safetyNetHandle: number | null = null;
  private readonly resizeObserver: ResizeObserver;
  // Cached result of the mobile/narrow-pane gate (see updateChipsAllowed()).
  // Deliberately NOT recomputed inside every render() pass — render() also
  // runs on every debounced keystroke, and re-measuring clientWidth there
  // ties this gate's outcome to whatever the pane's width happens to be at
  // that exact moment, which can visibly flicker independently of any real
  // width change (e.g. while text is still reflowing mid-edit). This value
  // only changes in response to an actual width-changing event — window
  // resize/maximize, a sidebar opening/closing, a new pane splitting in
  // beside this one — via the ResizeObserver in the constructor (the sole
  // trigger; see its own comment for why CM6's geometryChanged flag is
  // deliberately NOT used here despite looking like a fit), never as a
  // side effect of typing.
  private chipsAllowed = true;

  constructor(private readonly view: EditorView) {
    // Appending inside .cm-scroller (not .cm-content) means the track scrolls
    // in lockstep with the text automatically — no manual scroll listener
    // needed, because both are laid out in the same scrolling coordinate
    // space. This is the trick that made the original app's manual
    // scroll-driven positionChips() unnecessary here.
    this.track = view.scrollDOM.createDiv({ cls: 'mn-margin-track' });
    // ResizeObserver on scrollDOM is the ONLY place chipsAllowed gets
    // recomputed from a live width measurement (see updateChipsAllowed()) —
    // it fires precisely on a real box-size change of the pane itself
    // (window resize/maximize, sidebar toggle, a sibling pane splitting in)
    // and nothing else. CM6's own ViewUpdate.geometryChanged flag looks
    // like it should cover the same cases, but per CM6's docs it ALSO
    // fires on ordinary typing that changes content height (e.g. a line
    // wrapping) — using it here previously caused chips to vanish while
    // typing (a live re-measurement + immediate rebuild racing against
    // the doc's own fast-changing state on every such keystroke). This
    // ResizeObserver is deliberately the only live-resize trigger now.
    this.resizeObserver = new ResizeObserver(() => {
      this.updateChipsAllowed();
      this.schedule();
    });
    this.resizeObserver.observe(view.scrollDOM);
    this.updateChipsAllowed();
    this.schedule(); // initial paint — immediate, nothing to debounce yet

    // Safety-net background refresh — see SAFETY_NET_INTERVAL_MS's doc
    // comment for why this exists alongside the targeted triggers above.
    // Uses `immediate: false` (the debounced path) so it never interrupts
    // active typing with its own forced rebuild — it just joins whatever
    // debounce window may already be pending, or starts one that fires
    // after the normal TYPING_DEBOUNCE_MS if nothing else is happening.
    const win = view.dom.ownerDocument.defaultView ?? window;
    this.safetyNetHandle = win.setInterval(() => this.schedule(false), SAFETY_NET_INTERVAL_MS);
  }

  /**
   * Recomputes and caches whether the chip column is allowed to show at
   * all right now (see the `chipsAllowed` field's own doc comment for why
   * this is split out from render() rather than inlined there). Also
   * applies the `mn-has-margin` class immediately here — that CSS class is
   * what actually reserves/releases the editor's margin-right space, so it
   * needs to flip in lockstep with this check, not lag behind it until the
   * next debounced render() happens to run.
   */
  updateChipsAllowed() {
    const info = this.view.state.field(editorInfoField, false);
    const file = info?.file ?? null;
    const enabled = isMarginNotesEnabled(file);

    // Mobile check first (cheap, no DOM measurement needed) — Platform.
    // isMobile covers phones specifically (Obsidian gives tablets the
    // desktop-style layout, so this deliberately does NOT also gate on
    // Platform.isTablet).
    const mobileBlocked = runtime.settings.disableChipsOnMobile && Platform.isMobile;

    // Pane-width check: view.scrollDOM's own clientWidth is the actual
    // rendered width of THIS editor pane specifically — reading it here
    // (rather than window.innerWidth) is what makes a split-pane layout
    // correctly narrow just the half that's actually narrow, without
    // affecting a sibling pane that still has room. narrowPaneCutoffPx is
    // a direct pixel threshold now (previously marginWidth * a ratio
    // setting — see settings.ts's doc comment on narrowPaneCutoffPx for
    // why that combination was dropped: at the sliders' extremes it
    // produced a cutoff wider than any real monitor, silently hiding
    // margins forever with no indication why). cutoff <= 0 means "never
    // hide for width".
    const cutoff = runtime.settings.narrowPaneCutoffPx;
    const paneWidth = this.view.scrollDOM.clientWidth;
    const paneTooNarrow = cutoff > 0 && paneWidth < cutoff;

    this.chipsAllowed = enabled && !mobileBlocked && !paneTooNarrow;

    // Effective margin width: instead of staying pinned at the full
    // configured marginWidth right up until the pane crosses `cutoff` and
    // then snapping straight to zero (the previous behaviour — see the
    // bug this fixes: text stayed full-width while the margin sat on top
    // of it right up to the cutoff, then the two visually merged), shrink
    // the margin proportionally over a runway BEFORE the cutoff. The
    // runway is the same width as the margin itself (from `cutoff` up to
    // `cutoff + marginWidth`), so a wider margin naturally gets a wider —
    // and therefore smoother — runway too, rather than every margin width
    // sharing one fixed pixel runway that would feel abrupt for a large
    // marginWidth and sluggish for a small one. Below `cutoff`, chips are
    // already hidden entirely (chipsAllowed is false above), so
    // effectiveMarginWidth going to 0 there just matches that.
    const runwayStart = cutoff + runtime.settings.marginWidth;
    let effectiveMarginWidth = runtime.settings.marginWidth;
    if (cutoff > 0 && paneWidth < runwayStart) {
      const t = Math.max(0, (paneWidth - cutoff) / (runwayStart - cutoff || 1));
      effectiveMarginWidth = runtime.settings.marginWidth * t;
    }
    if (!this.chipsAllowed) effectiveMarginWidth = 0;

    // mn-has-margin toggles on chipsAllowed, not on `enabled` alone — this
    // class is what reserves the CSS padding/margin space for the chip
    // column via --mn-margin-width. If chips are suppressed for width/
    // mobile reasons but this class stayed on anyway, the pane would
    // reserve empty space for nothing; basing it on chipsAllowed instead
    // means that reservation correctly disappears too, giving the narrow
    // pane's prose its full width back — which is the whole point of this
    // gate.
    this.view.scrollDOM.classList.toggle('mn-has-margin', this.chipsAllowed);
    this.view.scrollDOM.style.setProperty('--mn-margin-width', `${effectiveMarginWidth}px`);
    this.view.scrollDOM.style.setProperty(
      '--mn-chip-font-size',
      `calc(var(--font-text-size, 16px) * ${runtime.settings.chipFontRatio})`
    );
  }

  /**
   * @param immediate When false (the default caller for doc changes — see
   * marginPanel's update() below), a pending rebuild is debounced by
   * TYPING_DEBOUNCE_MS and re-armed on every call, so a fast run of
   * keystrokes collapses into a single rebuild once typing actually
   * pauses instead of one full rebuild per character. When true (scroll,
   * resize, non-typing selection moves), the rebuild is scheduled on the
   * very next animation frame as before — those triggers don't come in
   * keystroke-speed bursts, and users expect the column to track them
   * without a visible lag.
   */
  schedule(immediate = true) {
    if (!immediate) {
      const win = this.view.dom.ownerDocument.defaultView ?? window;
      if (this.debounceHandle !== null) win.clearTimeout(this.debounceHandle);
      this.debounceHandle = win.setTimeout(() => {
        this.debounceHandle = null;
        this.scheduleFrame();
      }, TYPING_DEBOUNCE_MS);
      return;
    }
    this.scheduleFrame();
  }

  private scheduleFrame() {
    if (this.rafHandle !== null) return;
    // window.requestAnimationFrame (not the bare global) matters specifically
    // for Obsidian's popout windows: a popout is a separate browser window
    // with its own `window` object, and the bare identifier can resolve to
    // the WRONG window's animation-frame timer in that context. this.view's
    // own DOM lives in whichever window the pane was popped out into, and
    // that's the window whose paint cycle this frame actually needs to be
    // scheduled against.
    const win = this.view.dom.ownerDocument.defaultView ?? window;
    this.rafHandle = win.requestAnimationFrame(() => {
      this.rafHandle = null;
      this.render();
    });
  }

  private render() {
    // The mobile/narrow-pane gate itself is NOT recomputed here — see
    // updateChipsAllowed() and the `chipsAllowed` field's doc comment for
    // why. This render pass just acts on whatever the most recent real
    // width-change event last determined.
    if (!this.chipsAllowed) {
      // Chips just got suppressed (disabled entirely, or the pane shrank
      // below threshold, or mobile) — clean up anything left over from a
      // previous render pass where they WERE showing, same teardown as
      // destroy() below, just without actually destroying the column
      // itself (the pane could grow back past threshold on the very next
      // resize, at which point a normal render() call resumes as usual).
      this.track.replaceChildren();
      // MUST accompany the direct replaceChildren() above — see
      // invalidateTrack()'s own doc comment. Without this, layoutMarginItems()'s
      // next call (once chips are allowed again) would see the same
      // item ids/keys as its last successful pass, conclude every chip is
      // still reusable, and skip its own re-attach step as a no-op — leaving
      // correctly-positioned chips sitting detached in memory while `track`
      // stays empty in the live DOM.
      invalidateTrack(this.track);
      return;
    }

    const markers = findNoteMarkers(this.view.state.doc);

    // mn: notes are the only thing this margin column ever shows. Each is
    // simple/synchronous (buildChip has no async state or subscriptions),
    // so it's safe to key on actual content: layoutMarginItems() will
    // reuse the previous render's DOM node whenever both id and key
    // match, skipping a rebuild for any note whose text/type didn't
    // change. `key` deliberately includes marker.type and marker.content
    // (not just `.id`, which is an ordinal position that stays the same
    // even when a note's text is edited).
    const noteItems: MarginItem[] = markers.map((marker) => ({
      from: marker.from,
      id: `mn:${marker.id}`,
      key: `${marker.type ?? ''}\u0000${marker.content}`,
      buildChip: () => this.buildChip(marker),
    }));

    layoutMarginItems(this.view, this.track, noteItems);
  }


  private buildChip(marker: NoteMarker): HTMLDivElement {
    const chip = createDiv({ cls: 'mn-chip' });
    chip.dataset.noteId = String(marker.id);

    // Plain sidenotes have no left border anymore to carry the
    // per-note-type color, so the color now lives on the superscript
    // label itself instead — same noteTypeColor(marker.type) value as
    // before, just moved to where it's still visible.
    const label = chip.createSpan({ cls: 'mn-chip-label', text: `${marker.id}` });
    label.setCssStyles({ color: noteTypeColor(marker.type) });
    chip.createSpan({ cls: 'mn-chip-text', text: marker.content });

    // Clicking a chip (outside the delete button) just moves the caret into
    // the note's own text in the document (the raw `[mn.type: content]`
    // markdown, which noteMarkers.ts already reveals whenever the selection
    // overlaps it). Editing IS editing that text.
    chip.addEventListener('mousedown', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.focusNoteText(marker);
    });

    // Deleting an mn note removes its entire `[mn.type: content]` span from
    // the document in one shot — there is no separate file backing it, so
    // "delete" here just means "delete that inline text". Instant, no
    // confirmation: unlike a linked file's deletion below, this is a single
    // normal doc edit the user can undo with Ctrl+Z like any other typing,
    // so a modal would be more friction than the action warrants.
    chip.appendChild(buildDeleteButton(() => this.deleteNote(marker)));

    return chip;
  }

  private deleteNote(marker: NoteMarker) {
    // Re-locate by id in case the doc shifted since render() (same reason
    // focusNoteText() does this) — deleting against a stale from/to could
    // remove the wrong span or a now-incorrect range.
    const current = findNoteMarkers(this.view.state.doc).find((m) => m.id === marker.id);
    if (!current) return;
    this.view.dispatch({ changes: { from: current.from, to: current.to, insert: '' } });
    this.view.focus();
  }

  private focusNoteText(marker: NoteMarker) {
    // Re-locate the marker by id in case the doc shifted since render().
    const current = findNoteMarkers(this.view.state.doc).find((m) => m.id === marker.id);
    if (!current) return;
    // Select just the content between "...: " and the closing "]" so a
    // click both places the caret there for appending AND lets someone
    // immediately start typing to replace the whole note in one motion —
    // the same one-click affordance a popup textarea gave, minus the popup.
    const innerEnd = current.to - 1; // just before ']'
    const innerStart = innerEnd - current.content.length;
    this.view.dispatch({ selection: { anchor: innerStart, head: innerEnd }, scrollIntoView: true });
    this.view.focus();
  }

  destroy() {
    this.resizeObserver.disconnect();
    // Cancel a still-pending scheduled frame (see schedule()) — without
    // this, a frame requested just before the editor closes would still
    // fire afterward and call this.render() against an instance whose
    // track/scrollDOM have already been torn down below.
    if (this.rafHandle !== null) {
      const win = this.view.dom.ownerDocument.defaultView ?? window;
      win.cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.debounceHandle !== null) {
      const win = this.view.dom.ownerDocument.defaultView ?? window;
      win.clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    if (this.safetyNetHandle !== null) {
      const win = this.view.dom.ownerDocument.defaultView ?? window;
      win.clearInterval(this.safetyNetHandle);
      this.safetyNetHandle = null;
    }
    invalidateTrack(this.track);
    this.track.remove();
    this.view.scrollDOM.classList.remove('mn-has-margin');
  }
}

export const marginPanel = ViewPlugin.fromClass(
  class {
    private col: MarginColumn;
    constructor(view: EditorView) {
      this.col = new MarginColumn(view);
    }
    update(update: ViewUpdate) {
      // docChanged fires at keystroke speed (every character typed is a
      // doc change), but most individual keystrokes can't possibly move,
      // add, or remove a chip — typing a letter in the middle of a
      // sentence changes neither the line count nor any marker's
      // brackets. isDocChangeLayoutRelevant() filters those out before a
      // debounce timer is even armed, so ordinary typing schedules NO
      // rebuild at all rather than one that just gets debounced away.
      // Edits that DO look layout-relevant (a newline, or a bracket that
      // could start/end/resize a [mn:...] or [[link]]) still go through
      // the same debounce as before, so a burst of THOSE still collapses
      // into one rebuild rather than one per edit.
      if (update.docChanged && isDocChangeLayoutRelevant(update)) {
        this.col.schedule(false);
      }
      // geometryChanged is CM6's OWN signal for "this editor's rendered
      // dimensions changed in this update" — but per CM6's docs that
      // covers BOTH a real box-size change (pane resize, sidebar toggle,
      // split open/close) AND ordinary typing that grows/shrinks content
      // height (e.g. a line wrapping to a new visual row). Treating it as
      // a live-resize signal was the actual cause of chips vanishing while
      // typing: on a geometryChanged-from-typing update, this branch called
      // updateChipsAllowed() (a live clientWidth re-measurement) and an
      // IMMEDIATE, non-debounced schedule() on literally the same keystroke
      // isDocChangeLayoutRelevant() above was correctly trying to skip or
      // debounce — a race between that immediate render() and the doc's
      // own fast-changing state during a typing burst is what left the
      // column empty until a full file close/reopen forced a clean re-init.
      //
      // The constructor's ResizeObserver on view.scrollDOM is the correct,
      // narrower signal for this: it only fires on an actual box-size
      // change of the pane itself, never as a side effect of content
      // reflowing inside a pane whose own box didn't resize. That's the
      // sole live-measurement trigger now; geometryChanged is no longer
      // read here at all.
      const forcedRefresh = update.transactions.some((tr) => tr.effects.some((e) => e.is(forceMarginRefresh)));
      if (forcedRefresh) {
        this.col.updateChipsAllowed();
      }
      if (update.viewportChanged || (update.selectionSet && !update.docChanged) || forcedRefresh) {
        this.col.schedule();
      }
    }
    destroy() {
      this.col.destroy();
    }
  }
);