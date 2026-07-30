import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import { runtime, isMarginNotesEnabled } from './runtime';
import { findNoteMarkers, forceMarginRefresh, NoteMarker } from './noteMarkers';
import { noteTypeColor } from './noteTypes';

const CHIP_GAP = 6;

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

class MarginColumn {
  private readonly track: HTMLDivElement;
  private rafHandle: number | null = null;

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

    // lineBlockAt(pos) is meant to return the visual (wrapped) row pos sits
    // on, but that lookup only works within view.viewport — see CM6's own
    // source: it does `viewportLines.find(...)` first, and only falls back
    // to a coarser heightMap query outside the viewport. In practice, for
    // margin notes on wrapped paragraphs, this produced a block anchored at
    // the *paragraph's first visual row* rather than the specific wrapped
    // row the marker's own character sits on — chips would land several
    // lines too high, by a roughly-constant amount, matching exactly what
    // was reported. coordsAtPos(pos) instead asks CM6 directly "where does
    // this character render on screen right now", which is unambiguous
    // regardless of wrapping, and empirically verified (via a live-editor
    // diagnostic) to agree exactly with the anchor DOM element's own
    // getBoundingClientRect(). It returns viewport-relative screen
    // coordinates, so converting into the track's own coordinate space
    // needs one subtraction: the scroller's screen position.
    const scrollerTop = this.view.scrollDOM.getBoundingClientRect().top;
    const scrollTop = this.view.scrollDOM.scrollTop;

    // Pass 1: each marker's true, un-clamped anchor position — i.e. where
    // it would sit if nothing were crowding it. Computed for every marker
    // up front so pass 2 can look ahead at "where does the NEXT note want
    // to be" to decide how much room is genuinely available for this one,
    // rather than only knowing "where did the previous chip actually end up
    // after clamping" (which would compound clamping decisions instead of
    // basing each one on the real, independent anchor below it).
    const anchorTops = markers.map((marker) => {
      const coords = this.view.coordsAtPos(marker.from);
      // coordsAtPos can return null for a position that's been scrolled
      // fully out of the rendered viewport (CM6 only measures what's
      // drawn). Falling back to lineBlockAt here is deliberately the
      // *rarer* path now, only hit for genuinely off-screen markers, not
      // the common case that broke before.
      return coords ? coords.top - scrollerTop + scrollTop : this.view.lineBlockAt(marker.from).top;
    });

    // Pass 2: place chips top-down, clamping a chip's height only when its
    // natural full-content height would otherwise push past where the next
    // note's own anchor sits — an isolated note with room to spare is never
    // clamped. Clicking still always works the same regardless of clamping
    // (it re-locates the marker in the raw document); clamping only affects
    // how much is shown before you hover/click, never what the note IS.
    let lastBottom = -Infinity;
    for (let i = 0; i < markers.length; i++) {
      const marker = markers[i];
      const chip = this.buildChip(marker);
      let top = anchorTops[i];
      if (top < lastBottom + CHIP_GAP) top = lastBottom + CHIP_GAP;
      chip.style.top = `${top}px`;

      const nextTop = i + 1 < markers.length ? anchorTops[i + 1] : Infinity;
      const availableHeight = nextTop - top - CHIP_GAP;
      // Measure natural height by appending unclamped first — max-height
      // starts at "none" via the CSS default, so this read is accurate.
      this.track.appendChild(chip);
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