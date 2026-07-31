import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { editorInfoField, Platform } from 'obsidian';
import type { Component } from 'obsidian';
import { runtime, isMarginNotesEnabled } from './runtime';
import { findNoteMarkers, forceMarginRefresh, NoteMarker } from './noteMarkers';
import { findTopLevelLinkMarkers, linkDisplayText, LinkMarker } from './linkMarkers';
import { getLinkPreview, renderForConsumer } from './linkPreview';
import { noteTypeColor, LINK_CHIP_COLOR } from './noteTypes';
import { MarginItem, layoutMarginItems } from './marginLayout';

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
 */
export function insertAiNotes(view: EditorView, placements: Array<{ charPos: number; content: string }>) {
  const sorted = [...placements].sort((a, b) => b.charPos - a.charPos);
  for (const p of sorted) insertNoteAt(view, p.charPos, 'ai', p.content);
}

/**
 * Stable merge of two already-individually-sorted (by `.from`) MarginItem
 * lists into one combined, still-sorted list. Used to combine note-marker
 * items and link-marker items before handing them to layoutMarginItems(),
 * which requires its input pre-sorted rather than sorting internally
 * (different marker kinds may need this kind of merge rather than an
 * independent full sort).
 */
function mergeByFrom(a: MarginItem[], b: MarginItem[]): MarginItem[] {
  const out: MarginItem[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].from <= b[j].from) out.push(a[i++]);
    else out.push(b[j++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

class MarginColumn {
  private readonly track: HTMLDivElement;
  private rafHandle: number | null = null;
  private readonly resizeObserver: ResizeObserver;
  // Tracks the current preview-update subscription per link marker id, so
  // rebuilding the same marker's chip on a later render() pass can
  // unsubscribe the previous chip's listener before registering the new
  // one — otherwise every render pass (docChanged/selection/scroll can all
  // trigger one) would leak one more listener into linkPreview.ts's cache
  // entry forever. See buildLinkChip() for where this is read/written.
  private readonly linkPreviewUnsubs = new Map<string, () => void>();
  // Each chip's rendered preview now owns its own Component (see
  // linkPreview.ts's renderForConsumer — this replaced one shared,
  // plugin-lifetime Component after that design was found to let one
  // chip's rendered DOM node get silently stolen by another chip
  // referencing the same target file). Tracked per marker id, same
  // rebuild-replaces-previous pattern as linkPreviewUnsubs, so the
  // previous render's Component is always unloaded before a new one
  // is created for the same marker.
  private readonly linkPreviewComponents = new Map<string, Component>();

  constructor(private readonly view: EditorView) {
    this.track = document.createElement('div');
    this.track.className = 'mn-margin-track';
    // Appending inside .cm-scroller (not .cm-content) means the track scrolls
    // in lockstep with the text automatically — no manual scroll listener
    // needed, because both are laid out in the same scrolling coordinate
    // space. This is the trick that made the original app's manual
    // scroll-driven positionChips() unnecessary here.
    view.scrollDOM.appendChild(this.track);
    // Belt-and-suspenders for the narrow-pane gate (see render()):
    // ViewUpdate.geometryChanged SHOULD already catch a split-pane resize
    // (CM6 observes its own DOM element's size internally and sets its
    // Geometry flag on change), but that's an internal implementation
    // detail we don't want this feature silently depending on. Observing
    // scrollDOM directly here guarantees a resize across the
    // marginWidth * narrowPaneRatio boundary always triggers a re-render
    // and correctly shows/hides the chip column, regardless of whether
    // CM6's own flag happens to fire for a given resize path (e.g.
    // resizing without any accompanying doc/selection/viewport change).
    this.resizeObserver = new ResizeObserver(() => this.schedule());
    this.resizeObserver.observe(view.scrollDOM);
    this.schedule();
  }

  schedule() {
    if (this.rafHandle !== null) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      this.render();
    });
  }

  private render() {
    const info = this.view.state.field(editorInfoField, false);
    const file = info?.file ?? null;
    const enabled = isMarginNotesEnabled(file);

    // Narrow-pane / mobile gate. This ONLY affects the chip column built by
    // THIS class — noteMarkerField's superscript numbers and
    // linkMarkerField's underlined inline link text are separate CM6
    // StateFields that keep rendering completely unaffected by any of
    // this, on any pane width, on any platform. That split (chips here vs.
    // inline decorations in their own StateFields) is exactly what makes
    // this gate simple: there's no shared rendering path to carefully
    // thread a "skip this part" flag through, we just don't build a track
    // at all.
    //
    // Mobile check first (cheap, no DOM measurement needed) — Platform.
    // isMobile covers phones specifically (Obsidian gives tablets the
    // desktop-style layout, so this deliberately does NOT also gate on
    // Platform.isTablet).
    const mobileBlocked = runtime.settings.disableChipsOnMobile && Platform.isMobile;

    // Pane-width check: view.scrollDOM's own clientWidth is the actual
    // rendered width of THIS editor pane specifically — reading it here
    // (rather than window.innerWidth) is what makes a split-pane layout
    // correctly narrow just the half that's actually narrow, without
    // affecting a sibling pane that still has room. This compares against
    // marginWidth * narrowPaneRatio rather than a fixed pixel number, so
    // the threshold scales correctly with whatever marginWidth the user
    // has actually configured (see settings.ts's doc comment on
    // narrowPaneRatio for why a fixed number doesn't work well here).
    // ratio <= 0 means "never hide for width".
    const ratio = runtime.settings.narrowPaneRatio;
    const paneWidth = this.view.scrollDOM.clientWidth;
    const paneTooNarrow = ratio > 0 && paneWidth < runtime.settings.marginWidth * ratio;

    const chipsAllowed = enabled && !mobileBlocked && !paneTooNarrow;

    // mn-has-margin toggles on chipsAllowed, not on `enabled` alone — this
    // class is what reserves the CSS padding/margin space for the chip
    // column via --mn-margin-width. If chips are suppressed for width/
    // mobile reasons but this class stayed on anyway, the pane would
    // reserve empty space for nothing; basing it on chipsAllowed instead
    // means that reservation correctly disappears too, giving the narrow
    // pane's prose its full width back — which is the whole point of this
    // gate.
    this.view.scrollDOM.classList.toggle('mn-has-margin', chipsAllowed);
    this.view.scrollDOM.style.setProperty('--mn-margin-width', `${runtime.settings.marginWidth}px`);
    this.track.replaceChildren();
    if (!chipsAllowed) {
      // Chips just got suppressed (disabled entirely, or the pane shrank
      // below threshold, or mobile) — clean up anything left over from a
      // previous render pass where they WERE showing, same teardown as
      // destroy() below, just without actually destroying the column
      // itself (the pane could grow back past threshold on the very next
      // resize, at which point a normal render() call resumes as usual).
      for (const unsub of this.linkPreviewUnsubs.values()) unsub();
      this.linkPreviewUnsubs.clear();
      for (const component of this.linkPreviewComponents.values()) component.unload();
      this.linkPreviewComponents.clear();
      return;
    }

    const markers = findNoteMarkers(this.view.state.doc);
    const linkMarkers = findTopLevelLinkMarkers(this.view.state.doc);

    // Map both marker kinds into the generic MarginItem shape the shared
    // layout pass operates over (marginLayout.ts), then merge-sort by
    // document position — layoutMarginItems() requires its input already
    // sorted by `.from` ascending, and note/link markers are each already
    // individually sorted (both scanners walk the doc left to right), so a
    // stable merge is all that's needed rather than a full re-sort.
    const noteItems: MarginItem[] = markers.map((marker) => ({
      from: marker.from,
      id: `mn:${marker.id}`,
      buildChip: () => this.buildChip(marker),
    }));
    const linkItems: MarginItem[] = linkMarkers.map((marker) => ({
      from: marker.from,
      id: marker.id,
      buildChip: () => this.buildLinkChip(marker),
    }));
    const items = mergeByFrom(noteItems, linkItems);

    layoutMarginItems(this.view, this.track, items);
  }

  private buildLinkChip(marker: LinkMarker): HTMLDivElement {
    const chip = document.createElement('div');
    chip.className = 'mn-chip mn-chip-link';
    chip.style.borderLeftColor = LINK_CHIP_COLOR;
    chip.dataset.linkId = marker.id;

    const label = document.createElement('span');
    label.className = 'mn-chip-label';
    label.textContent = 'link';
    chip.appendChild(label);

    // Placeholder content shown synchronously while the async preview
    // fetch (linkPreview.ts) is in flight — just the bare title. Kept in
    // its own wrapper span (not reusing the plain .mn-chip-text the note
    // chips use) so the preview-swap logic below has one clearly-scoped
    // element to replace the *contents* of, without touching the label
    // span next to it.
    const body = document.createElement('span');
    body.className = 'mn-chip-link-body';
    body.textContent = linkDisplayText(marker);
    chip.appendChild(body);

    const info = this.view.state.field(editorInfoField, false);
    const sourcePath = info?.file?.path ?? '';
    const app = runtime.app;

    if (app) {
      // Bumped each time applyState() kicks off a fresh renderForConsumer()
      // call, so that if TWO renders end up in flight for this same chip
      // (e.g. the target file changes again before the first re-render
      // finished — see registerLinkPreviewInvalidation) the OLDER one's
      // result is discarded on arrival instead of clobbering the newer
      // one. Purely a per-chip local guard — unrelated to the cache-level
      // fix below.
      let renderToken = 0;

      const applyState = () => {
        const { state } = getLinkPreview(app, marker, sourcePath, applyState);
        if (state.status === 'ready') {
          const myToken = ++renderToken;
          // Each chip renders its OWN fresh DOM element from the cached
          // markdown string (renderForConsumer), rather than reusing a
          // single shared element across every chip that references the
          // same target — a shared element could only ever have one
          // parent, so whichever chip last called replaceChildren() on it
          // silently stole it from every other chip pointing at the same
          // note. See linkPreview.ts's cache comment for the full story.
          renderForConsumer(app, state).then(({ el, component }) => {
            if (myToken !== renderToken) {
              // Superseded by a newer render before this one finished —
              // discard it (and its Component) rather than applying stale
              // content or leaking the Component.
              component.unload();
              return;
            }
            const prevComponent = this.linkPreviewComponents.get(marker.id);
            prevComponent?.unload();
            this.linkPreviewComponents.set(marker.id, component);
            body.replaceChildren(el);
            chip.classList.add('mn-chip-link-loaded');
            chip.classList.remove('mn-chip-link-missing');
          });
        } else if (state.status === 'missing') {
          body.textContent = `No note titled "${state.linkpath}" yet`;
          chip.classList.add('mn-chip-link-missing');
        } else if (state.status === 'error') {
          body.textContent = linkDisplayText(marker);
          chip.classList.add('mn-chip-link-missing');
        }
        // 'pending' keeps showing the bare-title placeholder already set
        // above — nothing further to do for that state.
      };
      // First call both reads the current (possibly cached, possibly
      // freshly-kicked-off) state AND subscribes this chip's applyState as
      // the listener that fires again when the async fetch resolves later
      // — a single call handles both the synchronous initial paint and the
      // async swap-in-place, since getLinkPreview() always registers
      // onUpdate regardless of whether it returns 'pending' or a settled
      // state immediately.
      const { unsubscribe } = getLinkPreview(app, marker, sourcePath, applyState);
      applyState();
      // This chip's own DOM node is discarded and rebuilt from scratch on
      // every render() pass (this.track.replaceChildren() at the top of
      // render()) — docChanged/viewportChanged/selectionSet can all
      // trigger one. Unsubscribing the PREVIOUS listener for this same
      // marker id before registering the new one keeps this bounded to at
      // most one live listener (and, via linkPreviewComponents above, at
      // most one live rendered Component) per marker at any time, instead
      // of accumulating one more of each on every re-render pass.
      const prevUnsub = this.linkPreviewUnsubs.get(marker.id);
      if (prevUnsub) prevUnsub();
      this.linkPreviewUnsubs.set(marker.id, unsubscribe);
    }

    // Clicking a link chip navigates to that note — same action as
    // clicking the inline text (linkMarkers.ts's LinkInlineWidget). This is
    // NOT "select text in the document" the way mn chip clicks are
    // (focusNoteText below is specific to mn markers' edit-in-place model;
    // link chips have no inline note body to select, since their inline
    // text IS the link itself).
    chip.addEventListener('mousedown', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (!app) return;
      app.workspace.openLinkText(marker.linkpath, sourcePath);
    });

    return chip;
  }

  private buildChip(marker: NoteMarker): HTMLDivElement {
    const chip = document.createElement('div');
    chip.className = 'mn-chip';
    chip.style.borderLeftColor = noteTypeColor(marker.type);
    chip.dataset.noteId = String(marker.id);

    const label = document.createElement('span');
    label.className = 'mn-chip-label';
    label.textContent = String(marker.id);
    chip.appendChild(label);

    const text = document.createElement('span');
    text.className = 'mn-chip-text';
    text.textContent = marker.content;
    chip.appendChild(text);

    // No popup, no separate edit/delete affordances: clicking a chip just
    // moves the caret into the note's own text in the document (the raw
    // `[mn.type: content]` markdown, which noteMarkers.ts already reveals
    // whenever the selection overlaps it). Editing IS editing that text.
    // Deleting the note is deleting that text — there is nothing else
    // tracking the note's existence.
    chip.addEventListener('mousedown', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.focusNoteText(marker);
    });

    return chip;
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
    for (const unsub of this.linkPreviewUnsubs.values()) unsub();
    this.linkPreviewUnsubs.clear();
    for (const component of this.linkPreviewComponents.values()) component.unload();
    this.linkPreviewComponents.clear();
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
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.geometryChanged ||
        update.selectionSet ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(forceMarginRefresh)))
      ) {
        this.col.schedule();
      }
    }
    destroy() {
      this.col.destroy();
    }
  }
);