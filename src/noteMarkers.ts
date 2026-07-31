import { EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import { isMarginNotesEnabled } from './runtime';
import { noteTypeColor } from './noteTypes';

// Same regex and same sequential (1-based, order-of-appearance) numbering
// scheme as the original app's lib/parse.js / editor-src/noteWidgets.js, so
// anyone moving a vault between the two apps sees identical note ids. NOT
// changed to fix the nesting bug below — see findNoteMarkers() instead,
// which corrects the match's end position after the fact rather than
// touching this regex's format-compatibility contract.
export const MN_RE = /\[mn(?:\.(\w+))?\s*:\s*([\s\S]*?)\]/g;

export interface NoteMarker {
  from: number;
  to: number;
  id: number;
  type: string | null;
  content: string;
}

// Dispatched when something outside the document itself changes whether
// margin notes should be visible for this file (a frontmatter edit made via
// the Properties UI instead of typing, or a file rename crossing a folder
// boundary) — see main.ts's refreshAllEditors(). The StateField's update()
// only recomputes automatically on docChanged/selection, so this effect is
// the hook for every other case.
export const forceMarginRefresh = StateEffect.define<null>();

/**
 * MN_RE's content group is non-greedy ([\s\S]*?), so it naturally stops at
 * the FIRST `]` after the colon. That's correct for a plain note, but
 * breaks the moment a note's content contains its own bracketed construct
 * with a single closing bracket inside it — most commonly a [[link]]
 * written inside a note, e.g. `[mn: see [[Character Bible]] for context]`.
 * The naive match stops at the link's own `]]`'s first `]`, truncating the
 * note to `"see [[Character Bible"` and leaving `] for context]` as stray
 * visible text after it.
 *
 * This scans forward from just after the note's opening `:` tracking
 * `[[`/`]]` bracket-pair depth, and returns the position of the note's
 * TRUE closing `]` — the first single `]` encountered while depth is 0.
 * Only called when the naive match's content contains more `[[` than `]]`
 * (an unbalanced-looking capture, i.e. exactly the truncation symptom) —
 * a normal note with no nested double-brackets is completely unaffected
 * and returns the naive match's own end unchanged.
 */
function findTrueNoteEnd(text: string, naiveMatchIndex: number, naiveMatchEnd: number, capturedContent: string): number {
  const opens = (capturedContent.match(/\[\[/g) || []).length;
  const closes = (capturedContent.match(/\]\]/g) || []).length;
  if (opens <= closes) return naiveMatchEnd; // balanced — naive match is already correct

  const colonIdx = text.indexOf(':', naiveMatchIndex);
  let depth = 0;
  for (let i = colonIdx + 1; i < text.length; i++) {
    if (text[i] === '[' && text[i + 1] === '[') {
      depth++;
      i++; // consume both characters of the pair
      continue;
    }
    if (text[i] === ']' && text[i + 1] === ']' && depth > 0) {
      depth--;
      i++;
      continue;
    }
    if (text[i] === ']' && depth === 0) {
      return i + 1; // the note's real closing bracket
    }
  }
  return naiveMatchEnd; // unterminated note (shouldn't normally happen) — fall back rather than throw
}

export function findNoteMarkers(doc: EditorState['doc']): NoteMarker[] {
  const text = doc.toString();
  const markers: NoteMarker[] = [];
  let id = 0;
  let match: RegExpExecArray | null;
  MN_RE.lastIndex = 0;
  while ((match = MN_RE.exec(text))) {
    id++;
    const naiveEnd = match.index + match[0].length;
    const trueEnd = findTrueNoteEnd(text, match.index, naiveEnd, match[2]);
    let content = match[2];
    if (trueEnd !== naiveEnd) {
      const colonIdx = text.indexOf(':', match.index);
      content = text.slice(colonIdx + 1, trueEnd - 1);
      // Resume MN_RE's own scan AFTER the note's true end, not the naive
      // (too-short) one — otherwise the regex's own next .exec() call
      // would re-enter the note's remaining text and could spuriously
      // match a SECOND, bogus "note" starting mid-way through content
      // that's actually still part of this same note.
      MN_RE.lastIndex = trueEnd;
    }
    markers.push({
      from: match.index,
      to: trueEnd,
      id,
      type: match[1] || null,
      content: content.trim(),
    });
  }
  return markers;
}

class NoteAnchorWidget extends WidgetType {
  constructor(readonly id: number, readonly type: string | null, readonly content: string) {
    super();
  }
  eq(other: NoteAnchorWidget) {
    return other.id === this.id && other.type === this.type && other.content === this.content;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'mn-anchor';
    span.dataset.noteId = String(this.id);
    const sup = document.createElement('sup');
    sup.className = 'mn-marker';
    sup.style.color = noteTypeColor(this.type);
    sup.textContent = String(this.id);
    span.appendChild(sup);
    // Tapping/clicking the superscript itself reveals the note's own raw
    // `[mn.type: content]` text right where it already lives in the
    // document, with the caret placed at the START of the content — NOT a
    // popup/popover. This is the ONLY way to reach an mn note's content at
    // all on a narrow pane or mobile, where marginPanel.ts's chip column is
    // suppressed entirely (see its narrow-pane gate) and so never renders
    // for this note to click on instead. On a wide desktop pane this is a
    // second path to the same place the margin chip's own click already
    // reaches (see MarginColumn.focusNoteText) — deliberately not shared
    // code with that method, since the two intentionally select
    // differently (this one collapses the caret to the start of the
    // content for reading/positioning; the chip's click selects the whole
    // content for one-motion replacement).
    span.addEventListener('mousedown', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const view = EditorView.findFromDOM(span);
      if (!view) return;
      const current = findNoteMarkers(view.state.doc).find((m) => m.id === this.id);
      if (!current) return;
      const innerEnd = current.to - 1; // just before ']'
      const innerStart = innerEnd - current.content.length;
      view.dispatch({ selection: { anchor: innerStart }, scrollIntoView: true });
      view.focus();
    });
    return span;
  }
  ignoreEvent() {
    return false; // let the mousedown listener above handle it
  }
}

function activeRanges(state: EditorState): Array<[number, number]> {
  return state.selection.ranges.map((r) => [r.from, r.to]);
}

// Strict overlap (not touching-at-a-boundary) — see original app's comment:
// a caret placed exactly at a freshly-inserted marker's edge must NOT count
// as "inside" it, or the marker would immediately show raw [mn: ...] text
// instead of collapsing to its widget.
function overlaps(aFrom: number, aTo: number, bFrom: number, bTo: number) {
  return aFrom < bTo && bFrom < aTo;
}

function buildDecorations(state: EditorState): DecorationSet {
  const info = state.field(editorInfoField, false);
  if (!isMarginNotesEnabled(info?.file ?? null)) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  const markers = findNoteMarkers(state.doc);
  const sel = activeRanges(state);

  for (const m of markers) {
    const isActive = sel.some(([f, t]) => overlaps(f, t, m.from, m.to));
    if (isActive) continue; // show raw markdown so it stays editable
    builder.add(m.from, m.to, Decoration.replace({ widget: new NoteAnchorWidget(m.id, m.type, m.content) }));
  }
  return builder.finish();
}

// A StateField, not a ViewPlugin — for the same reason as the original app:
// this needs to be settled as part of the transaction itself, before the
// view decides what to draw, so a note's displayed number can never lag one
// redraw cycle behind a doc edit that shifted it.
export const noteMarkerField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(deco, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(forceMarginRefresh))) {
      return buildDecorations(tr.state);
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Same enablement gate as buildDecorations(), exposed for the margin panel. */
export function getActiveNoteMarkers(state: EditorState): NoteMarker[] {
  const info = state.field(editorInfoField, false);
  if (!isMarginNotesEnabled(info?.file ?? null)) return [];
  return findNoteMarkers(state.doc);
}