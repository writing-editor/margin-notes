import { EditorState, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { editorInfoField, Notice } from 'obsidian';
import { isMarginNotesEnabled, runtime } from './runtime';
import { forceMarginRefresh, findNoteMarkers } from './noteMarkers';

// Matches [[...]], capturing everything between the double brackets. This
// plugin only ever deals in plain `[[links]]`: Obsidian leaves them as
// plain clickable text with no inline preview, so this widget's job is
// just to render that text cleanly and open the target when clicked —
// nothing more.
//
// The regex itself does NOT exclude a leading "!" (no negative lookbehind
// here) — Obsidian's own mobile JS engine (iOS/Safari's older WebKit
// versions used inside the iOS app) does not support regex lookbehind
// assertions, and using one would silently make every [[link]] fail to
// match on iOS rather than throwing an obvious error. Instead,
// findLinkMarkers() below does the "was this preceded by !" check manually
// against the raw text, which is lookbehind-free and behaves identically.
//
// Examples this must handle:
//   [[Note]]                      -> target: Note
//   [[Note|Alias]]                -> target: Note, alias: Alias
//   [[Note#Heading]]               -> target: Note, heading: Heading
//   [[Note#Heading|Alias]]         -> target: Note, heading: Heading, alias: Alias
export const LINK_RE = /\[\[([^\]]+)\]\]/g;

export interface LinkMarker {
  from: number;
  to: number;
  id: string; // 'link:<from>' — stable per-position id, unlike NoteMarker's
  // sequential numbering (links aren't numbered in the UI, so "the marker at
  // this position" is a sufficient and simpler identity than a counter that
  // would shift every id whenever a link is added/removed earlier in the doc).
  linkpath: string; // the raw target name, e.g. "Note" (no heading/alias)
  heading: string | null;
  alias: string | null;
  raw: string; // the full matched text, e.g. "[[Note#Heading|Alias]]"
}

/**
 * Splits the inside of [[...]] into target/heading/alias.
 * Grammar: target[#heading][|alias]
 * ("target|alias" and "target#heading" both handled; "|" always separates
 * alias from everything before it, "#" always separates heading from the
 * target name that precedes it, and can appear before or absent from the
 * alias split.)
 *
 * Handles a BACKSLASH-ESCAPED pipe ("\|") the same as a bare "|": Markdown
 * requires escaping a literal "|" inside a table cell (e.g. writing
 * `[[Note\|Alias]]` in a doc's own markdown table so the pipe isn't read as
 * a column separator), so a trailing "\" directly before the split point is
 * stripped rather than left dangling on the end of linkpath/heading. Without
 * this, a link written as `[[Character Bible\|Alice]]` (exactly the form
 * this plugin's own user guide uses inside its syntax-reference table)
 * resolved to a linkpath of "Character Bible\" — trailing backslash
 * included — which never matches the real file "Character Bible.md", so the
 * chip incorrectly reported the note as missing even though it exists and
 * every other (non-escaped, non-table) link to it resolves fine. This is a
 * table-escaping artifact, not a real character in the note name, so it
 * should never survive into the resolved linkpath/heading.
 */
function parseLinkInner(inner: string): { linkpath: string; heading: string | null; alias: string | null } {
  let rest = inner;
  let alias: string | null = null;
  const pipeIdx = rest.indexOf('|');
  if (pipeIdx !== -1) {
    alias = rest.slice(pipeIdx + 1).trim();
    // Strip a trailing "\" left over from an escaped "\|" split — see the
    // function comment above. Plain "|" (no preceding backslash) is
    // unaffected: replace() only touches a "\" that's actually there.
    rest = rest.slice(0, pipeIdx).replace(/\\$/, '');
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
    // Skip a leading "!" (an embed, e.g. ![[Note]]) — see LINK_RE's
    // comment for why this is a manual character check rather than a
    // regex lookbehind. Embeds are left entirely to Obsidian's own
    // native rendering; this plugin doesn't touch them.
    if (match.index > 0 && text[match.index - 1] === '!') continue;
    const inner = match[1];
    const { linkpath, heading, alias } = parseLinkInner(inner);
    if (!linkpath) continue; // malformed / empty target — skip rather than crash
    markers.push({
      from: match.index,
      to: match.index + match[0].length,
      id: `link:${match.index}`,
      linkpath,
      heading,
      alias,
      raw: match[0],
    });
  }
  return markers;
}

/**
 * Same as findLinkMarkers(), but excludes any link whose range falls
 * inside an [mn: ...] note's own range (see buildDecorations()'s comment
 * for why nested links are suppressed rather than double-decorated). This
 * is the version other modules (e.g. readingMode.ts) should call when
 * they need to line up with what's actually rendered as a clickable
 * inline widget — using the raw findLinkMarkers() instead would count a
 * link that buildDecorations() below independently suppresses (because a
 * note already claims that range), which would be a confusing mismatch.
 */
export function findTopLevelLinkMarkers(doc: EditorState['doc']): LinkMarker[] {
  const links = findLinkMarkers(doc);
  const noteRanges = findNoteMarkers(doc).map((n): [number, number] => [n.from, n.to]);
  return links.filter((m) => !noteRanges.some(([f, t]) => overlaps(f, t, m.from, m.to)));
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
    const span = createSpan({ cls: 'mn-linktext', text: this.displayText });
    span.addEventListener('mousedown', (evt) => {
      // Prevent the editor from placing the caret here on click — this is a
      // navigation action, not a text-editing one, same intent as
      // NoteAnchorWidget's mn-anchor clicks not moving the caret into raw
      // markdown (that widget instead re-focuses the note's own content).
      evt.preventDefault();
      evt.stopPropagation();
      const app = runtime.app;
      if (!app) return;
      // Opens in a new split to the right, same as the old margin-chip
      // click behavior — a quick "look at this too" action, not a
      // navigation away from the document you're currently reading/
      // editing. openLinkText's third argument only accepts a boolean
      // (new tab) or 'tab'/'split'/'window' — passing the literal string
      // 'split' is what actually gets a vertical split instead of a
      // same-pane new tab.
      app.workspace.openLinkText(this.linkpath, this.sourcePath, 'split').catch((err: unknown) => {
        console.error('Margin Notes: failed to open link', this.linkpath, err);
        new Notice(`Margin Notes: couldn't open "${this.linkpath}".`);
      });
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
  // findTopLevelLinkMarkers (not findLinkMarkers) — a [[link]] written
  // INSIDE an [mn: ...] note's own content (e.g.
  // `[mn: see [[Character Bible]] for context]`) must NOT also get its own
  // independent inline Decoration.replace here — noteMarkerField already
  // claims that whole range (note text included) as ITS replaced widget.
  // Two different extensions each trying to Decoration.replace overlapping,
  // nested ranges is not something CM6 resolves predictably (its own docs/
  // examples treat "don't create overlapping replace decorations" as the
  // extension author's responsibility, not something the library sorts
  // out for you) — so this plugin resolves it explicitly itself: the note
  // wins, and a link nested inside one is left as plain text WITHIN the
  // note's own collapsed content, not turned into a second, competing
  // clickable widget. (It's still there in the raw markdown — clicking
  // into the note to edit it, which noteMarkers.ts already supports,
  // reveals and lets you edit the nested [[...]] like any other text in
  // the note.)
  const markers = findTopLevelLinkMarkers(state.doc);
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