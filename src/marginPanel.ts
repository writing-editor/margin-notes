import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import { runtime, isMarginNotesEnabled } from './runtime';
import { findNoteMarkers, forceMarginRefresh, NoteMarker } from './noteMarkers';
import { findLinkMarkers, linkDisplayText, LinkMarker } from './linkMarkers';
import { getLinkPreview } from './linkPreview';
import { noteTypeColor, LINK_CHIP_COLOR, EMBED_CHIP_COLOR } from './noteTypes';
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
  // Tracks the current preview-update subscription per link marker id, so
  // rebuilding the same marker's chip on a later render() pass can
  // unsubscribe the previous chip's listener before registering the new
  // one — otherwise every render pass (docChanged/selection/scroll can all
  // trigger one) would leak one more listener into linkPreview.ts's cache
  // entry forever. See buildLinkChip() for where this is read/written.
  private readonly linkPreviewUnsubs = new Map<string, () => void>();

  constructor(private readonly view: EditorView) {
    this.track = document.createElement('div');
    this.track.className = 'mn-margin-track';
    // Appending inside .cm-scroller (not .cm-content) means the track scrolls
    // in lockstep with the text automatically — no manual scroll listener
    // needed, because both are laid out in the same scrolling coordinate
    // space. This is the trick that made the original app's manual
    // scroll-driven positionChips() unnecessary here.
    view.scrollDOM.appendChild(this.track);
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

    this.view.scrollDOM.classList.toggle('mn-has-margin', enabled);
    this.view.scrollDOM.style.setProperty('--mn-margin-width', `${runtime.settings.marginWidth}px`);
    this.track.replaceChildren();
    if (!enabled) return;

    const markers = findNoteMarkers(this.view.state.doc);
    const linkMarkers = findLinkMarkers(this.view.state.doc);

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
    chip.style.borderLeftColor = marker.isEmbed ? EMBED_CHIP_COLOR : LINK_CHIP_COLOR;
    chip.dataset.linkId = marker.id;

    const label = document.createElement('span');
    label.className = 'mn-chip-label';
    label.textContent = marker.isEmbed ? 'embed' : 'link';
    chip.appendChild(label);

    // Placeholder content shown synchronously while the async preview
    // fetch (linkPreview.ts) is in flight — just the bare title, per §2.2's
    // "must render in the correct position immediately... with a
    // lightweight loading state" requirement. Kept in its own wrapper span
    // (not reusing the plain .mn-chip-text the note chips use) so the
    // preview-swap logic below has one clearly-scoped element to replace
    // the *contents* of, without touching the label span next to it.
    const body = document.createElement('span');
    body.className = 'mn-chip-link-body';
    body.textContent = linkDisplayText(marker);
    chip.appendChild(body);

    const info = this.view.state.field(editorInfoField, false);
    const sourcePath = info?.file?.path ?? '';
    const app = runtime.app;

    if (app) {
      const applyState = () => {
        const { state } = getLinkPreview(app, marker, sourcePath, applyState);
        if (state.status === 'ready') {
          body.replaceChildren(state.el);
          chip.classList.add('mn-chip-link-loaded');
          chip.classList.remove('mn-chip-link-missing');
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
      // IMPORTANT: this chip's own DOM node is discarded and rebuilt from
      // scratch on every render() pass (this.track.replaceChildren() at the
      // top of render()) — there is currently no explicit teardown hook run
      // per-chip when that happens. Attaching unsubscribe here means once
      // this specific chip element is garbage-collected (no more DOM
      // references, no more closures holding it) the listener technically
      // still lives in the cache entry's `listeners` Set until something
      // removes it. To keep this bounded rather than accumulating forever
      // across many render passes, remove the immediately-previous
      // subscription for the same marker id proactively: getLinkPreview
      // dedupes by Set identity, so the simplest safe fix is to unsubscribe
      // this listener the next time THIS SAME marker's chip is rebuilt.
      // We track that via a WeakMap-free approach: store the unsubscribe
      // function on the track's dataset-adjacent map keyed by marker.id,
      // and call the previous one (if any) before registering this one.
      const prevUnsub = this.linkPreviewUnsubs.get(marker.id);
      if (prevUnsub) prevUnsub();
      this.linkPreviewUnsubs.set(marker.id, unsubscribe);
    }

    // Clicking a link/embed chip navigates to that note — same action as
    // clicking the inline text (linkMarkers.ts's LinkInlineWidget). This is
    // NOT "select text in the document" the way mn chip clicks are
    // (focusNoteText below is specific to mn markers' edit-in-place model;
    // link/embed chips have no inline note body to select, since their
    // inline text IS the link itself).
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
    for (const unsub of this.linkPreviewUnsubs.values()) unsub();
    this.linkPreviewUnsubs.clear();
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