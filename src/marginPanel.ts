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
    let lastBottom = -Infinity;

    for (const marker of markers) {
      const chip = this.buildChip(marker);
      // Align to the marker's OWN line, not the top of its paragraph. For
      // an AI note the marker sits at the paragraph's first character
      // anyway (see agents.ts), so this is identical to before for those.
      // For a note typed inline mid-paragraph, marker.from IS the exact,
      // already-known position the person placed it at — snapping instead
      // to the paragraph's top line (the old behaviour) is what produced
      // the one-or-two-line offset. The marker's own position needs no
      // lookup or guessing; just read the line it's actually on.
      const block = this.view.lineBlockAt(marker.from);
      let top = block.top;
      if (top < lastBottom + CHIP_GAP) top = lastBottom + CHIP_GAP;
      chip.style.top = `${top}px`;
      this.track.appendChild(chip);
      lastBottom = top + chip.offsetHeight;
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
