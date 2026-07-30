import { EditorState, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import { isMarginNotesEnabled, runtime } from './runtime';
import { forceMarginRefresh } from './noteMarkers';

// Matches both [[...]] and ![[...]] (embed), capturing everything between
// the double brackets. Deliberately permissive at this stage — the finer
// split into target/heading/alias happens in parseLinkInner() below, kept
// separate so the regex itself stays simple and this file has one obvious
// place to add test cases for the target|alias / target#heading grammar.
//
// Examples this must handle (see §2.3 of the plan):
//   [[Note]]                      -> target: Note
//   [[Note|Alias]]                -> target: Note, alias: Alias
//   [[Note#Heading]]               -> target: Note, heading: Heading
//   [[Note#Heading|Alias]]         -> target: Note, heading: Heading, alias: Alias
//   ![[Note]]                      -> same as [[Note]], isEmbed: true
//   ![[Note#Heading]]              -> same as [[Note#Heading]], isEmbed: true
export const LINK_RE = /(!?)\[\[([^\]]+)\]\]/g;

export interface LinkMarker {
  from: number;
  to: number;
  id: string; // 'link:<from>' — stable per-position id, unlike NoteMarker's
  // sequential numbering (links aren't numbered in the UI, so "the marker at
  // this position" is a sufficient and simpler identity than a counter that
  // would shift every id whenever a link is added/removed earlier in the doc).
  isEmbed: boolean;
  linkpath: string; // the raw target name, e.g. "Note" (no heading/alias)
  heading: string | null;
  alias: string | null;
  raw: string; // the full matched text, e.g. "[[Note#Heading|Alias]]" or "![[Note]]"
}

/**
 * Splits the inside of [[...]] into target/heading/alias.
 * Grammar: target[#heading][|alias]
 * ("target|alias" and "target#heading" both handled; "|" always separates
 * alias from everything before it, "#" always separates heading from the
 * target name that precedes it, and can appear before or absent from the
 * alias split.)
 */
function parseLinkInner(inner: string): { linkpath: string; heading: string | null; alias: string | null } {
  let rest = inner;
  let alias: string | null = null;
  const pipeIdx = rest.indexOf('|');
  if (pipeIdx !== -1) {
    alias = rest.slice(pipeIdx + 1).trim();
    rest = rest.slice(0, pipeIdx);
  }
  let heading: string | null = null;
  const hashIdx = rest.indexOf('#');
  if (hashIdx !== -1) {
    heading = rest.slice(hashIdx + 1).trim();
    rest = rest.slice(0, hashIdx);
  }
  return { linkpath: rest.trim(), heading, alias };
}

export function findLinkMarkers(doc: EditorState['doc']): LinkMarker[] {
  const text = doc.toString();
  const markers: LinkMarker[] = [];
  let match: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((match = LINK_RE.exec(text))) {
    const isEmbed = match[1] === '!';
    const inner = match[2];
    const { linkpath, heading, alias } = parseLinkInner(inner);
    if (!linkpath) continue; // malformed / empty target — skip rather than crash
    markers.push({
      from: match.index,
      to: match.index + match[0].length,
      id: `link:${match.index}`,
      isEmbed,
      linkpath,
      heading,
      alias,
      raw: match[0],
    });
  }
  return markers;
}

/** What to actually display inline: the alias if present, else the bare target name. */
export function linkDisplayText(marker: LinkMarker): string {
  return marker.alias ?? marker.linkpath;
}

class LinkInlineWidget extends WidgetType {
  constructor(
    readonly displayText: string,
    readonly linkpath: string,
    readonly sourcePath: string
  ) {
    super();
  }
  eq(other: LinkInlineWidget) {
    return (
      other.displayText === this.displayText &&
      other.linkpath === this.linkpath &&
      other.sourcePath === this.sourcePath
    );
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'mn-linktext';
    span.textContent = this.displayText;
    span.addEventListener('mousedown', (evt) => {
      // Prevent the editor from placing the caret here on click — this is a
      // navigation action, not a text-editing one, same intent as
      // NoteAnchorWidget's mn-anchor clicks not moving the caret into raw
      // markdown (that widget instead re-focuses the note's own content).
      evt.preventDefault();
      evt.stopPropagation();
      const app = runtime.app;
      if (!app) return;
      app.workspace.openLinkText(this.linkpath, this.sourcePath);
    });
    return span;
  }
  ignoreEvent() {
    return false; // let clicks through to the listener above
  }
}

function activeRanges(state: EditorState): Array<[number, number]> {
  return state.selection.ranges.map((r) => [r.from, r.to]);
}

// Same strict-overlap semantics as noteMarkers.ts's overlaps() — a caret
// sitting exactly at a link's edge should not count as "inside" it, so a
// freshly-typed [[ at the caret's position still collapses correctly rather
// than getting stuck showing raw brackets.
function overlaps(aFrom: number, aTo: number, bFrom: number, bTo: number) {
  return aFrom < bTo && bFrom < aTo;
}

function buildDecorations(state: EditorState): DecorationSet {
  const info = state.field(editorInfoField, false);
  const file = info?.file ?? null;
  if (!isMarginNotesEnabled(file)) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  const markers = findLinkMarkers(state.doc);
  const sel = activeRanges(state);
  const sourcePath = file?.path ?? '';

  for (const m of markers) {
    const isActive = sel.some(([f, t]) => overlaps(f, t, m.from, m.to));
    if (isActive) continue; // show raw [[...]] syntax so it stays editable
    builder.add(
      m.from,
      m.to,
      Decoration.replace({ widget: new LinkInlineWidget(linkDisplayText(m), m.linkpath, sourcePath) })
    );
  }
  return builder.finish();
}

// A StateField, same reasoning as noteMarkerField: this must settle as part
// of the transaction itself so a link's inline rendering never lags a redraw
// cycle behind a doc edit that shifted it.
export const linkMarkerField = StateField.define<DecorationSet>({
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
export function getActiveLinkMarkers(state: EditorState): LinkMarker[] {
  const info = state.field(editorInfoField, false);
  if (!isMarginNotesEnabled(info?.file ?? null)) return [];
  return findLinkMarkers(state.doc);
}