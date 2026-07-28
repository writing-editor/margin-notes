// Ported from lib/paragraphs.js. One shared definition of "paragraph" — a
// maximal run of non-blank-line text, bounded by one-or-more blank lines
// (or the start/end of the text) — used both by marginPanel.ts (chip
// alignment) and agents.ts (the paragraph-ID contract the agent uses
// instead of guessing a character offset). Keeping both on this one
// function is the point: if they ever disagreed on where paragraph 4
// starts, "paragraph 4" on screen and "paragraph 4" the model anchored a
// note to would be different places.

export interface Paragraph {
  id: string;
  start: number;
  end: number;
  text: string;
}

const BLANK_LINE_RE = /\r?\n[ \t]*\r?\n+/g;

export function splitIntoParagraphs(text: string): Paragraph[] {
  if (typeof text !== 'string' || !text) return [];

  const out: Paragraph[] = [];
  const re = new RegExp(BLANK_LINE_RE.source, BLANK_LINE_RE.flags);

  const pushBlock = (start: number, end: number) => {
    const raw = text.slice(start, end);
    if (!raw.trim()) return; // whitespace-only block — not a paragraph
    const leading = raw.match(/^\s*/)?.[0].length ?? 0;
    const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
    const trimmedStart = start + leading;
    const trimmedEnd = end - trailing;
    if (trimmedStart >= trimmedEnd) return;
    out.push({
      id: `P${out.length + 1}`,
      start: trimmedStart,
      end: trimmedEnd,
      text: text.slice(trimmedStart, trimmedEnd),
    });
  };

  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    pushBlock(lastEnd, match.index);
    lastEnd = match.index + match[0].length;
  }
  pushBlock(lastEnd, text.length);

  return out;
}

/** The paragraph containing `pos` (inclusive of its end boundary, since a note is often appended right after a paragraph's last character). */
export function paragraphAt(paragraphs: Paragraph[], pos: number): Paragraph | undefined {
  return paragraphs.find((p) => pos >= p.start && pos <= p.end);
}
