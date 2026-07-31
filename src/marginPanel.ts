import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { editorInfoField, Platform, Modal, Notice } from 'obsidian';
import type { App, Component, TFile } from 'obsidian';
import { runtime, isMarginNotesEnabled } from './runtime';
import { findNoteMarkers, forceMarginRefresh, NoteMarker } from './noteMarkers';
import { findTopLevelLinkMarkers, linkDisplayText, LinkMarker } from './linkMarkers';
import { getLinkPreview, renderForConsumer } from './linkPreview';
import { noteTypeColor, LINK_CHIP_COLOR } from './noteTypes';
import { MarginItem, layoutMarginItems } from './marginLayout';

/**
 * Small trash-can icon (not an "×") for the per-chip delete button — an "×"
 * reads as "dismiss/close the hover-zoom", which is exactly the wrong
 * signal for a destructive, irreversible-feeling action. A bin icon makes
 * "this deletes the note" unambiguous at a glance, without needing a text
 * label the tiny badge has no room for anyway.
 */
const TRASH_ICON_SVG =
  '<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

/**
 * One shared builder for both chip kinds' delete buttons, so the pinned-
 * badge positioning/hover-reveal behaviour (all in styles.css's
 * .mn-chip-delete rules) and the "don't let this click fall through to the
 * chip's own mousedown handler" guard live in exactly one place rather than
 * being duplicated (and risking drifting apart) between buildChip() and
 * buildLinkChip().
 */
function buildDeleteButton(onDelete: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'mn-chip-delete';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Delete note');
  btn.innerHTML = TRASH_ICON_SVG;
  btn.addEventListener('mousedown', (evt) => {
    // Must stop this before it bubbles to the chip's own mousedown listener
    // (buildChip's focusNoteText / buildLinkChip's openLinkText) — otherwise
    // deleting would also fire the chip's normal "navigate/focus" action on
    // the same click.
    evt.preventDefault();
    evt.stopPropagation();
    onDelete();
  });
  return btn;
}

/**
 * Tiny confirm dialog for the one truly irreversible-feeling action here:
 * deleting a linked note's actual file. Obsidian has no built-in confirm
 * modal, so this is the minimal Modal subclass needed for a yes/no prompt.
 * Deliberately NOT used for mn (inline) notes — deleting inline text the
 * user can immediately Ctrl+Z is a much lower-stakes action than deleting
 * a file, so that path (see buildChip below) deletes instantly instead.
 */
class ConfirmDeleteFileModal extends Modal {
  constructor(app: App, private readonly fileName: string, private readonly onConfirm: () => void) {
    super(app);
  }
  onOpen() {
    this.titleEl.setText('Delete note?');
    this.contentEl.createEl('p', {
      text: `"${this.fileName}" will be deleted. This also removes the link from this document.`,
    });
    const buttons = this.contentEl.createDiv({ cls: 'mn-confirm-delete-buttons' });
    const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());
    const deleteBtn = buttons.createEl('button', { text: 'Delete', cls: 'mod-warning' });
    deleteBtn.addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
  }
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
  // Records, per link marker id, the markdown content string that marker's
  // chip was MOST RECENTLY LAID OUT against (i.e. what layoutMarginItems()
  // measured this chip's offsetHeight while showing). This exists to solve
  // a real bug: layoutMarginItems() runs synchronously, before any link's
  // async preview has necessarily resolved — so a chip can get positioned/
  // clamped based on its tiny one-line "pending" placeholder, and when the
  // real (often much taller) preview content swaps in afterward, nothing
  // re-ran the layout pass against the new, correct height. With several
  // links laid out close together, every one of them could get sized
  // against a placeholder and none of them clamped, then all grow to full
  // height in place once their previews load — overlapping or touching
  // with zero gap.
  // The fix (see buildLinkChip()): every time a chip's content is (re)set,
  // compare it against what's recorded here for that marker id. If it
  // differs — including the transition from "no entry yet" to "real
  // markdown text" — schedule a full re-render (which reruns
  // layoutMarginItems with this chip's now-correct height) exactly once,
  // then update the record. If a later render rebuilds the SAME marker's
  // chip and finds the SAME content already recorded, no re-layout is
  // triggered — this is what breaks what would otherwise be an infinite
  // reschedule loop (each reschedule would otherwise rebuild the chip,
  // synchronously find the same warm cache, and reschedule again forever).
  private readonly linkChipLayoutContent = new Map<string, string>();

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
      // render() is async (see its own doc comment for why: it needs to
      // pre-resolve every link's preview content BEFORE laying anything
      // out, so layoutMarginItems() measures real heights instead of
      // placeholders) — schedule() itself stays fire-and-forget here since
      // nothing needs to wait on it; render() manages its own generation
      // guard internally against overlapping calls.
      void this.render();
    });
  }

  /**
   * Guards against overlapping render() calls: schedule() can fire again
   * (e.g. a fast series of scroll/selection events) while a previous
   * render() is still mid-flight in its async pre-fetch step below. Each
   * call captures its own generation number; if a newer call started
   * before this one reached the point of actually mutating the DOM, this
   * (now-stale) call abandons itself rather than laying out against
   * possibly-outdated marker positions.
   */
  private renderGeneration = 0;

  private async render() {
    const myGeneration = ++this.renderGeneration;
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
    if (!chipsAllowed) {
      // Chips just got suppressed (disabled entirely, or the pane shrank
      // below threshold, or mobile) — clean up anything left over from a
      // previous render pass where they WERE showing, same teardown as
      // destroy() below, just without actually destroying the column
      // itself (the pane could grow back past threshold on the very next
      // resize, at which point a normal render() call resumes as usual).
      this.track.replaceChildren();
      for (const unsub of this.linkPreviewUnsubs.values()) unsub();
      this.linkPreviewUnsubs.clear();
      for (const component of this.linkPreviewComponents.values()) component.unload();
      this.linkPreviewComponents.clear();
      return;
    }

    const markers = findNoteMarkers(this.view.state.doc);
    const linkMarkers = findTopLevelLinkMarkers(this.view.state.doc);

    // THE ACTUAL FIX for chips visually touching/overlapping with no gap
    // when several links are laid out close together (e.g. two links each
    // on their own line with one blank line between): pre-resolve and
    // pre-render EVERY top-level link's preview content now, before
    // layoutMarginItems() ever runs, rather than letting each chip kick off
    // its own async render independently and hoping a later reschedule
    // catches up. getLinkPreview() itself is synchronous and safe to call
    // here (it only ever kicks off a fetch if the cache is cold — see
    // linkPreview.ts); this loop's actual awaiting is only for
    // renderForConsumer() calls on links whose cache is ALREADY warm
    // ('ready' state) at this exact moment, which is the common case for
    // any link that isn't brand new. A link whose fetch is still genuinely
    // in flight (a fresh 'pending' state) is deliberately NOT awaited here
    // — waiting on disk I/O before ever painting anything would delay the
    // whole margin column's first paint for one slow link; that case still
    // falls back to the old placeholder-then-live-update path inside
    // buildLinkChip(), same as before this fix.
    const prefetched = new Map<string, { el: HTMLElement; component: Component }>();
    await Promise.all(
      linkMarkers.map(async (marker) => {
        const sourcePath = file?.path ?? '';
        const app = runtime.app;
        if (!app) return;
        // onUpdate is a no-op here — this call's only purpose is to read
        // whatever state is CURRENTLY cached (and kick off a fetch if
        // needed for buildLinkChip's own subscription to pick up later);
        // the actual live-updating subscription is still registered by
        // buildLinkChip() itself below, same as before.
        const { state } = getLinkPreview(app, marker, sourcePath, () => {});
        if (state.status !== 'ready') return; // still pending/missing — buildLinkChip handles it
        const rendered = await renderForConsumer(app, state);
        prefetched.set(marker.id, rendered);
      })
    );

    // If a NEWER render() call started while the awaits above were in
    // flight, abandon this one — the newer call will redo this same
    // pre-fetch pass against current marker positions and win the race to
    // actually mutate the DOM. Without this check, an old, slow render()
    // call finishing late could stomp on a newer one's already-correct
    // layout.
    if (myGeneration !== this.renderGeneration) {
      for (const { component } of prefetched.values()) component.unload();
      return;
    }

    this.track.replaceChildren();

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
      buildChip: () => this.buildLinkChip(marker, prefetched.get(marker.id)),
    }));
    const items = mergeByFrom(noteItems, linkItems);

    layoutMarginItems(this.view, this.track, items);
  }

  private buildLinkChip(marker: LinkMarker, prefetched?: { el: HTMLElement; component: Component }): HTMLDivElement {
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

    if (prefetched) {
      // Content was ALREADY resolved and rendered before layoutMarginItems()
      // ran this pass (see render()'s pre-fetch step above) — apply it
      // synchronously right now, so this chip's real, final content is
      // what gets measured for offsetHeight during layout, not a
      // placeholder. This is the actual fix for chips visually touching
      // when several links sit close together: their true heights are
      // known BEFORE layout runs, not corrected after the fact.
      const prevComponent = this.linkPreviewComponents.get(marker.id);
      prevComponent?.unload();
      this.linkPreviewComponents.set(marker.id, prefetched.component);
      body.replaceChildren(prefetched.el);
      chip.classList.add('mn-chip-link-loaded');
    }

    if (app) {
      // Bumped each time applyState() kicks off a fresh renderForConsumer()
      // call, so that if TWO renders end up in flight for this same chip
      // (e.g. the target file changes again before the first re-render
      // finished — see registerLinkPreviewInvalidation) the OLDER one's
      // result is discarded on arrival instead of clobbering the newer
      // one. Purely a per-chip local guard.
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
            // This chip's real content just arrived asynchronously
            // (the common case here is: this link's fetch was genuinely
            // still in flight when render()'s pre-fetch step ran, since
            // that step deliberately doesn't wait on cold fetches — see
            // render()'s comment). Schedule a re-layout so
            // layoutMarginItems() re-measures this chip's now-correct
            // height instead of leaving it sized against the placeholder
            // it had during the last layout pass. This can still fire more
            // than once across a chip's lifetime (e.g. once here, then
            // again after a vault.on('modify') invalidation) — that's
            // fine; it only ever fires when content actually changes, not
            // on every rebuild, since a rebuild against an already-warm
            // cache goes through the `prefetched` branch above instead of
            // this subscription path reaching 'ready' from scratch.
            this.schedule();
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
      // state immediately. When `prefetched` was already applied above,
      // this call will immediately see the same 'ready' state and just
      // re-confirm it (harmless — renderForConsumer() runs once more
      // redundantly in that case, but does not loop, since nothing here
      // schedules another render when reached via this synchronous initial
      // call; only the LATER, genuinely-async arm above does that).
      const { unsubscribe } = getLinkPreview(app, marker, sourcePath, applyState);
      if (!prefetched) applyState();
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

    // Deleting a link chip is a bigger deal than deleting an mn note: it
    // deletes the actual target FILE from the vault, not just some inline
    // text — so, unlike deleteNote() above, this is gated behind a confirm
    // modal rather than firing instantly. Confirmed deletion also strips
    // the `[[link]]` markup itself from THIS document (see
    // deleteLinkedFile()) — leaving it in place would turn the chip into a
    // permanently broken/"missing" link pointing at a file that no longer
    // exists, which is exactly the dangling state cleanup is meant to avoid.
    chip.appendChild(buildDeleteButton(() => this.confirmDeleteLinkedFile(marker, sourcePath)));

    return chip;
  }

  private confirmDeleteLinkedFile(marker: LinkMarker, sourcePath: string) {
    const app = runtime.app;
    if (!app) return;
    const dest = app.metadataCache.getFirstLinkpathDest(marker.linkpath, sourcePath);
    if (!dest) {
      // Nothing to delete on disk (already missing) — still let the user
      // clear the dead [[link]] text out of the document.
      this.removeLinkMarkup(marker);
      return;
    }
    new ConfirmDeleteFileModal(app, dest.basename, () => this.deleteLinkedFile(marker, dest)).open();
  }

  private async deleteLinkedFile(marker: LinkMarker, dest: TFile) {
    const app = runtime.app;
    if (!app) return;
    try {
      // vault.trash's second argument (system trash vs. Obsidian's own
      // .trash folder) follows the user's own "Deleted files" setting the
      // same way Obsidian's native file-explorer delete does, rather than
      // this plugin imposing its own always-permanent app.vault.delete().
      await app.vault.trash(dest, true);
    } catch (err) {
      console.error('Margin Notes: failed to delete linked file', dest.path, err);
      new Notice(`Margin Notes: could not delete "${dest.basename}".`);
      return;
    }
    this.removeLinkMarkup(marker);
  }

  /** Strips the `[[...]]` markup itself out of the host document. */
  private removeLinkMarkup(marker: LinkMarker) {
    // Re-locate by position rather than trusting the marker's original
    // from/to, since the doc may have shifted (e.g. an async gap while a
    // confirm modal was open) between render() and this call.
    const current = findTopLevelLinkMarkers(this.view.state.doc).find((m) => m.id === marker.id);
    const from = current?.from ?? marker.from;
    const to = current?.to ?? marker.to;
    this.view.dispatch({ changes: { from, to, insert: '' } });
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