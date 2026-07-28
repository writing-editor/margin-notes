import { EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import { isMarginNotesEnabled } from './runtime';
import { noteTypeColor } from './noteTypes';

// Same regex and same sequential (1-based, order-of-appearance) numbering
// scheme as the original app's lib/parse.js / editor-src/noteWidgets.js, so
// anyone moving a vault between the two apps sees identical note ids.
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

export function findNoteMarkers(doc: EditorState['doc']): NoteMarker[] {
  const text = doc.toString();
  const markers: NoteMarker[] = [];
  let id = 0;
  let match: RegExpExecArray | null;
  MN_RE.lastIndex = 0;
  while ((match = MN_RE.exec(text))) {
    id++;
    markers.push({
      from: match.index,
      to: match.index + match[0].length,
      id,
      type: match[1] || null,
      content: match[2].trim(),
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
    return span;
  }
  ignoreEvent() {
    return false; // let clicks through so the margin panel can react
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
