import { App, TFile, TFolder, requestUrl } from 'obsidian';
import { MN_RE } from './noteMarkers';
import { Paragraph, splitIntoParagraphs } from './paragraphs';
import type { SecretSettings } from './settings';

export type AgentProvider = 'claude' | 'openai' | 'gemini' | 'ollama';

/**
 * Global, cross-cutting prompt preferences (plan §2.5) — deliberately kept
 * separate from per-agent profile text. Both are "genuine style/behaviour
 * preferences," not structural/mechanical rules: they template into one
 * line each of buildPrompt()'s hardcoded instructions, rather than being a
 * freeform system-prompt override a person could use to accidentally break
 * the JSON-shape contract the parsing code depends on.
 */
export type SpellingConvention = 'british' | 'american' | 'auto';
export type DensityPosture = 'conservative' | 'balanced' | 'thorough';

export interface PromptOptions {
  spelling: SpellingConvention;
  density: DensityPosture;
}

export const AGENT_PROVIDERS: Array<{ id: AgentProvider; label: string; secretField: keyof SecretSettings }> = [
  { id: 'claude', label: 'Claude', secretField: 'claudeKey' },
  { id: 'openai', label: 'OpenAI', secretField: 'openaiKey' },
  { id: 'gemini', label: 'Gemini', secretField: 'geminiKey' },
  { id: 'ollama', label: 'Ollama (local)', secretField: 'claudeKey' }, // unused for ollama, kept for type uniformity
];

/**
 * Plan §2 — AI-authored linked notes. A placement is either:
 *  - `kind: 'inline'` (the default, and the only kind that existed before
 *    this feature) — spliced in as `[mn.ai: content]`, exactly as before.
 *  - `kind: 'report'` — `content` is still the short in-place remark text
 *    (used as the `[[link]]`'s alias, so the inline text reads naturally,
 *    e.g. "continuity notes"), but `reportContent` carries the long-form
 *    body that gets written to a SEPARATE note file rather than spliced
 *    inline. The anchor in the source file becomes a plain `[[link]]` to
 *    that file instead of an `[mn.ai: ...]` marker — see
 *    buildReportFilePath/spliceReportLink below.
 * `reportContent` is only meaningful when `kind === 'report'`; it's
 * `undefined` for inline placements.
 */
export interface Placement {
  charPos: number;
  content: string;
  kind: 'inline' | 'report';
  reportContent?: string;
}

export interface BundledAgent {
  name: string;
  prompt: string;
}

export const BUNDLED_AGENTS: BundledAgent[] = [
  {
    name: 'Continuity checker',
    prompt:
      'Focus on continuity: contradictions in names, dates, physical descriptions, timelines, or established ' +
      'facts versus earlier in the same text. Ignore style and prose quality entirely.',
  },
  {
    name: 'Line editor',
    prompt:
      'Focus on prose craft: sentences that are unclear, overlong, or repeat a word/construction used nearby, ' +
      'and paragraphs whose pacing drags. Do not comment on plot or continuity.',
  },
];

/** Names only — cheap enough to call synchronously from the settings tab render. */
export function listAgentNames(app: App, agentsFolder: string): string[] {
  const names = new Map<string, true>();
  for (const a of BUNDLED_AGENTS) names.set(a.name, true);
  const folder = agentsFolder.trim().replace(/^\/+|\/+$/g, '');
  if (folder) {
    for (const f of app.vault.getMarkdownFiles()) {
      if (f.path === folder || f.path.startsWith(folder + '/')) names.set(f.basename, true);
    }
  }
  return Array.from(names.keys());
}

/** Vault file of the same name shadows a bundled profile. Reads the file only when actually running. */
export async function loadAgentPrompt(app: App, agentsFolder: string, name: string): Promise<string> {
  const folder = agentsFolder.trim().replace(/^\/+|\/+$/g, '');
  if (folder) {
    const match = app.vault.getMarkdownFiles().find((f) => f.basename === name && (f.path === folder || f.path.startsWith(folder + '/')));
    if (match) return await app.vault.read(match);
  }
  const bundled = BUNDLED_AGENTS.find((a) => a.name === name);
  if (bundled) return bundled.prompt;
  throw new Error(`No agent profile named "${name}" found (checked bundled profiles and the ${folder || '(unset)'} folder).`);
}

// ── Plan §2: AI-authored linked reports ────────────────────────────────

/**
 * One report file per (source file, agent) pair, matching the plan's
 * naming scheme exactly: "<source basename> — <agent name> — <date>.md"
 * inside `reportsFolder`. The DATE is included in the filename (not just
 * inside the file) so a person browsing the reports folder can tell at a
 * glance when a report was last touched without opening it — but note
 * this means "same file/agent pair, same DAY" is what triggers append-
 * reuse below, not "same file/agent pair, ever": a report re-run on a
 * later day starts a fresh file rather than growing one file forever.
 * Characters that can't appear in a filename on some platforms (notably
 * Windows: \ / : * ? " < > |) are replaced with a hyphen so this never
 * fails on a provider/agent name containing one of them.
 */
function sanitizeForFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '-').trim();
}

function todayDateStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function buildReportFilePath(reportsFolder: string, sourceBasename: string, agentName: string): string {
  const folder = reportsFolder.trim().replace(/^\/+|\/+$/g, '');
  const name = `${sanitizeForFilename(sourceBasename)} \u2014 ${sanitizeForFilename(agentName)} \u2014 ${todayDateStamp()}.md`;
  return folder ? `${folder}/${name}` : name;
}

/**
 * Creates `path`'s parent folder(s) if they don't already exist. Vault's
 * own createFolder() throws if the folder is already there, so existence
 * is checked first rather than relying on try/catch to distinguish
 * "already exists" from a real failure.
 */
async function ensureFolderExists(app: App, path: string): Promise<void> {
  const idx = path.lastIndexOf('/');
  if (idx === -1) return; // no folder component — writing to vault root
  const folderPath = path.slice(0, idx);
  if (!folderPath) return;
  const existing = app.vault.getAbstractFileByPath(folderPath);
  if (existing instanceof TFolder) return;
  // Vault.createFolder doesn't create intermediate parents on every
  // Obsidian version reliably, so walk the path segment by segment.
  const segments = folderPath.split('/');
  let cur = '';
  for (const seg of segments) {
    cur = cur ? `${cur}/${seg}` : seg;
    const found = app.vault.getAbstractFileByPath(cur);
    if (found instanceof TFolder) continue;
    if (found instanceof TFile) throw new Error(`Cannot create reports folder "${cur}" \u2014 a file with that name already exists.`);
    await app.vault.createFolder(cur);
  }
}

/**
 * Writes `reportContent` to `path`, appending to the file if a run
 * earlier the same day already created it for this exact source-file/
 * agent pair (see buildReportFilePath's doc comment for the reuse
 * window), rather than overwriting or creating a duplicate. Mirrors
 * `openInCompanionSplit`'s "reuse if it still exists" pattern (see
 * marginPanel.ts) — checked fresh via getAbstractFileByPath each call
 * rather than a cached reference, since the underlying object here is a
 * vault path a person could have renamed or deleted between runs, not an
 * in-memory workspace leaf.
 *
 * Each append is visually separated with a horizontal rule and a small
 * timestamp heading so multiple same-day runs (e.g. re-running the agent
 * after an edit) are distinguishable within one file rather than reading
 * as one undifferentiated blob.
 */
export async function writeOrAppendReport(app: App, path: string, reportContent: string): Promise<TFile> {
  await ensureFolderExists(app, path);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    const stamp = new Date().toLocaleTimeString();
    await app.vault.append(existing, `\n\n---\n\n#### Update — ${stamp}\n\n${reportContent}\n`);
    return existing;
  }
  return app.vault.create(path, `${reportContent}\n`);
}

/**
 * The `[[link]]` text inserted into the SOURCE file for a report
 * placement. Uses the file's basename (not its full vault path) as the
 * link target — standard Obsidian shorthand-link form, resolved the same
 * way any hand-typed `[[Note]]` link is — with `linkLabel` (the
 * placement's own `content`, e.g. "continuity notes") as the alias, so
 * the inline text reads naturally rather than showing the raw filename.
 * This is deliberately plain `[[...]]` syntax, NOT wrapped in an
 * `[mn.ai: ...]` marker: nesting a link inside a note marker would
 * suppress its own margin chip/live-preview (see linkMarkers.ts's
 * findTopLevelLinkMarkers), which is exactly the opposite of what plan
 * §2 wants — the link should get full normal-link treatment "for free."
 */
export function buildReportLinkText(reportFilePath: string, linkLabel: string): string {
  const basename = reportFilePath.slice(reportFilePath.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  return `[[${basename}|${linkLabel}]]`;
}

// ── §3 hallucination-protection: pre-write invariant check ────────────────
// Ported from lib/ai-proxy.js's findExistingNoteSpans/landsInsideExistingNote.
export function findExistingNoteSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const re = new RegExp(MN_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) spans.push({ start: match.index, end: match.index + match[0].length });
  return spans;
}

function landsInsideExistingNote(pos: number, spans: Array<{ start: number; end: number }>): boolean {
  return spans.some(({ start, end }) => pos > start && pos < end);
}

/** Tolerant extraction: strips a ```json fence if present, then takes the outermost [...] span. */
export function extractJsonArray(raw: string): unknown[] {
  if (typeof raw !== 'string') return [];
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Precise in-paragraph anchoring (step 2 of the plan doc). The model is
 * still never asked for a character offset — instead of estimating a
 * position, it may optionally return a short exact-substring "quote" from
 * within the paragraph it named. This locates that substring via a plain,
 * case-sensitive string search SCOPED TO THAT PARAGRAPH'S OWN TEXT ONLY
 * (never the whole document) via String.indexOf, which is why a
 * wrong/duplicate match is low-stakes: the search space is a few hundred
 * characters at most, so a bad match still lands somewhere inside the
 * right paragraph, never somewhere else in the document. Returns the
 * paragraph-relative offset of the match, or null if the quote is missing,
 * blank, or not found — callers fall back to the existing start-of-
 * paragraph-plus-nudge behaviour in that case (see
 * resolveParagraphPlacements below), exactly as before this feature
 * existed.
 */
function locateQuoteInParagraph(paragraph: Paragraph, quote: string | undefined): number | null {
  if (!quote) return null;
  const trimmed = quote.trim();
  if (!trimmed) return null;
  const idx = paragraph.text.indexOf(trimmed);
  return idx === -1 ? null : idx;
}

/**
 * The model is never asked for a character offset — it only ever names a
 * paragraphId it saw tagged in the prompt (buildPrompt() below), plus an
 * optional exact-substring "quote" (see locateQuoteInParagraph above) for
 * pointing at a specific sentence/phrase within that paragraph. This
 * resolves both back to a real charPos the code already knows for that
 * paragraph (a lookup/search, not a guess). Ported from lib/ai-proxy.js's
 * resolveParagraphPlacements. Never throws.
 *
 * MULTIPLE notes per paragraph are allowed (previously the second+ note for
 * any given paragraphId was silently dropped — "one note per paragraph,
 * first wins" — on the theory that a paragraph should get at most one
 * combined note). That restriction is gone: margin notes already lay out
 * side by side without overlapping (marginLayout.ts's clamp/collision
 * logic), so a paragraph with several genuinely distinct issues should get
 * several distinct notes rather than being forced into one combined,
 * harder-to-read note or having extras thrown away entirely.
 *
 * Anchoring precedence per placement:
 *  1. If a "quote" was given AND found inside that paragraph's own text,
 *     anchor there — this is the precise, per-sentence anchor.
 *  2. Otherwise (no quote, or quote not found), fall back to the original
 *     behaviour: paragraph.start, nudged forward by one character per
 *     prior note already resolved for that same paragraph, clamped to
 *     stay inside the paragraph's own range. This is a stable, cheap
 *     tie-breaker, not real precision — it only exists so repeats sort in
 *     the order the model returned them rather than comparing equal.
 * The two can mix freely within one paragraph (e.g. two quoted notes and
 * one unquoted one) — the nudge counter only advances for the fallback
 * case, so a quoted note never "uses up" a nudge slot an unquoted note
 * would otherwise need.
 *
 * Plan §2 — `kind`/`reportContent` (see Placement's own doc comment) pass
 * straight through unchanged; anchoring logic above is identical for both
 * kinds; what differs is only what agentRunner.ts later splices in at
 * that charPos (an `[mn.ai: ...]` marker for 'inline', a `[[link]]` for
 * 'report'). An unrecognised/missing `kind`, or a 'report' with no actual
 * `reportContent` to write, silently degrades to 'inline' — see inline
 * comments below — rather than dropping the placement.
 */
export function resolveParagraphPlacements(
  rawPlacements: unknown[],
  paragraphs: Paragraph[],
  existingSpans: Array<{ start: number; end: number }>
): { placements: Placement[]; rejected: number } {
  const byId = new Map(paragraphs.map((p) => [p.id, p]));
  const seenCounts = new Map<string, number>();
  const out: Placement[] = [];
  let rejected = 0;

  for (const item of rawPlacements) {
    const p = item as { paragraphId?: unknown; content?: unknown; quote?: unknown; kind?: unknown; reportContent?: unknown };
    if (!p || typeof p !== 'object') continue;
    const content = typeof p.content === 'string' ? p.content.trim() : '';
    if (!content) continue;
    const paragraphId = typeof p.paragraphId === 'string' ? p.paragraphId.trim() : '';
    const paragraph = byId.get(paragraphId);
    if (!paragraph) continue; // unknown/malformed id — nothing safe to clamp to

    // Plan §2 — report kind. Anything other than the literal string
    // "report" is treated as the (default, pre-existing) "inline" kind —
    // an unrecognised or missing kind value degrades to today's inline-
    // note behaviour rather than being dropped, so a model that ignores
    // or misspells the field still produces a normal, safe note instead
    // of silently losing the placement.
    const kind: 'inline' | 'report' = p.kind === 'report' ? 'report' : 'inline';
    const reportContent = typeof p.reportContent === 'string' ? p.reportContent.trim() : '';
    // A "report" placement with no actual report body has nothing to
    // write anywhere — demote it to inline rather than creating an empty
    // report file or silently dropping a note the model clearly intended.
    const effectiveKind: 'inline' | 'report' = kind === 'report' && reportContent ? 'report' : 'inline';

    const quote = typeof p.quote === 'string' ? p.quote : undefined;
    const quoteOffset = locateQuoteInParagraph(paragraph, quote);

    let charPos: number;
    if (quoteOffset !== null) {
      charPos = paragraph.start + quoteOffset;
    } else {
      const repeatIndex = seenCounts.get(paragraphId) ?? 0;
      const paragraphLength = Math.max(0, paragraph.end - paragraph.start);
      charPos = paragraph.start + Math.min(repeatIndex, paragraphLength);
      seenCounts.set(paragraphId, repeatIndex + 1);
    }

    if (landsInsideExistingNote(charPos, existingSpans)) {
      rejected++;
      continue;
    }
    out.push(
      effectiveKind === 'report'
        ? { charPos, content, kind: 'report', reportContent }
        : { charPos, content, kind: 'inline' }
    );
  }
  return { placements: out, rejected };
}

// Same pattern as noteMarkers.ts's MN_RE, used only to strip note markers
// out of the copy of the text shown to the model — see buildPrompt().
const MN_MARKER_STRIP_RE = /\[mn(?:\.(\w+))?\s*:\s*([\s\S]*?)\]/g;

interface BuiltPrompt {
  fullSystem: string;
  userMessage: string;
  paragraphs: Paragraph[];
}

// Plan §2.5 — spelling convention promoted to a global setting. Only the
// wording of this one line changes per option; everything else in
// `instructions` is unaffected. 'auto' keeps the original hardcoded
// behaviour byte-for-byte (British-unless-clearly-American) so someone who
// never touches the new setting sees no prompt change at all.
const SPELLING_LINES: Record<SpellingConvention, string> = {
  auto:
    '- Use British spelling and punctuation conventions (e.g. "colour", "centre", "realise", Oxford commas, etc.)\n' +
    '  unless the text is clearly written in American English, in which case use American conventions.',
  british:
    '- Use British spelling and punctuation conventions throughout (e.g. "colour", "centre", "realise",\n' +
    '  Oxford commas, etc.), regardless of which convention the text itself uses.',
  american:
    '- Use American spelling and punctuation conventions throughout (e.g. "color", "center", "realize", no\n' +
    '  Oxford commas unless needed for clarity, etc.), regardless of which convention the text itself uses.',
};

// Plan §2.5 — note density posture promoted to a global setting. This
// swaps in a different version of the density paragraph rather than
// exposing a free-text override, since a person picking "how aggressive
// should this be" from three labelled options can't accidentally break
// the JSON-shape contract the way a freeform prompt edit could. 'balanced'
// is the original hardcoded paragraph byte-for-byte, so it stays the
// default and existing behaviour is unchanged unless someone opts into a
// different posture.
const DENSITY_PARAGRAPHS: Record<DensityPosture, string> = {
  conservative:
    "Density \u2014 this is the most important rule and overrides your own sense\n" +
    'of thoroughness. Default to saying LESS:\n' +
    '- Flag only issues you are confident meaningfully hurt the text \u2014 skip anything\n' +
    '  minor, subjective, or debatable. When in doubt, leave it unflagged.\n' +
    '- Most paragraphs, even in an imperfect draft, should get no note at all. A note\n' +
    '  next to every few paragraphs is already a lot \u2014 do not aim for coverage.\n' +
    "- Only flag a paragraph if fixing what you'd note would meaningfully improve the\n" +
    '  text. If you are unsure whether an issue is worth a note, leave it unflagged.\n' +
    '- If the same kind of issue (e.g. a repeated crutch word) occurs in many\n' +
    '  paragraphs, do not give each one its own note. Note it once, on its first or\n' +
    '  most representative paragraph, and cite the OTHER paragraph IDs where it\n' +
    '  recurs by their actual "Pn" tags, not a vague count (e.g. "\'suddenly\' also\n' +
    '  appears in P7, P12, and P19" \u2014 not "appears 6 times in this text").',
  balanced:
    "Density \u2014 this is the most important rule and overrides your own sense\n" +
    'of thoroughness:\n' +
    '- Do not flag every paragraph. A margin note next to every paragraph is\n' +
    '  not useful to the person reading it \u2014 it is clutter they have to read\n' +
    '  past. Most paragraphs in a clean text should get no note at all.\n' +
    "- Only flag a paragraph if fixing what you'd note would meaningfully\n" +
    '  improve the text. If you are unsure whether an issue is worth a note,\n' +
    '  leave it unflagged.\n' +
    '- If the same kind of issue (e.g. a repeated crutch word) occurs in\n' +
    '  many paragraphs, do not give each one its own note. Note it once, on\n' +
    '  its first or most representative paragraph, and cite the OTHER\n' +
    '  paragraph IDs where it recurs by their actual "Pn" tags, not a vague\n' +
    '  count (e.g. "\'suddenly\' also appears in P7, P12, and P19" \u2014 not\n' +
    '  "appears 6 times in this text").',
  thorough:
    "Density \u2014 this is the most important rule, but for THIS run thoroughness is\n" +
    'explicitly wanted, so err toward flagging more rather than less:\n' +
    '- A genuinely clean paragraph still gets no note \u2014 do not pad the count or\n' +
    '  invent issues that are not really there.\n' +
    '- But do not stay silent on real, fixable issues just because they are minor.\n' +
    '  If it is worth a line-edit\u2019s attention, it is worth a note.\n' +
    '- A paragraph with several distinct issues should get several distinct notes\n' +
    '  (see the multi-note rule above) \u2014 do not compress them into one to keep the\n' +
    '  count down.\n' +
    '- If the same kind of issue (e.g. a repeated crutch word) occurs in many\n' +
    '  paragraphs, do not give each one its own note. Note it once, on its first or\n' +
    '  most representative paragraph, and cite the OTHER paragraph IDs where it\n' +
    '  recurs by their actual "Pn" tags, not a vague count (e.g. "\'suddenly\' also\n' +
    '  appears in P7, P12, and P19" \u2014 not "appears 6 times in this text").',
};

/**
 * Ported from lib/ai-proxy.js's buildPrompt. Splits `text` into paragraphs,
 * shows the model each one tagged "[Pn]", and instructs it to name a
 * paragraph id rather than estimate a position — see the module comment in
 * lib/ai-proxy.js for the full reasoning (models can't reliably count
 * characters; they can recognize which paragraph they're looking at).
 * Says "text" throughout, not "chapter" — this runs for a whole file, a
 * selection, or a vault-wide pass, and the vault isn't always fiction.
 *
 * `options` (plan §2.5) templates in the two settings promoted out of this
 * previously-hardcoded block: which spelling line to use, and which
 * version of the density paragraph to use. Everything else in
 * `instructions` below stays fixed — see SPELLING_LINES/DENSITY_PARAGRAPHS
 * doc comments for why only these two are settings and the rest aren't.
 */
function buildPrompt(agentProfilePrompt: string, text: string, options: PromptOptions): BuiltPrompt {
  const paragraphs = splitIntoParagraphs(text);

  // Strips markers only from the copy shown to the model — paragraphs[].start
  // stays a real offset into the untouched `text`, which is what
  // resolveParagraphPlacements() looks up. Stripping the real text first
  // would shift every offset after the first marker.
  const displayText = (t: string) => t.replace(MN_MARKER_STRIP_RE, '').trim();
  const numberedText = paragraphs
    .map((p) => ({ id: p.id, text: displayText(p.text) }))
    .filter((p) => p.text)
    .map((p) => `[${p.id}] ${p.text}`)
    .join('\n\n');

  const instructions = [
    'You are an editorial assistant annotating a document with margin',
    'notes. The text below has already been split into paragraphs for you',
    'and each one is tagged with its ID in square brackets, e.g. "[P3]"',
    "immediately before that paragraph's text. These IDs are the ONLY way",
    'you place a note \u2014 you never count characters or estimate a position',
    'yourself.',
    '',
    'Decide which paragraphs need a note and what each should say. Respond',
    'with ONLY a JSON array, no prose before or after it, no markdown code',
    'fence, in exactly this shape:',
    '[{"paragraphId": "<the P-number of the paragraph, exactly as tagged, e.g. \\"P3\\">", "content": "<note text>", "quote": "<optional short exact substring>", "kind": "<optional: \\"inline\\" (default) or \\"report\\">", "reportContent": "<required only if kind is \\"report\\": the long-form body>"}]',
    '',
    'Rules:',
    '- paragraphId must be copied exactly from one of the "[Pn]" tags shown',
    '  \u2014 do not invent an id.',
    '- "quote" is OPTIONAL. When the issue is about a specific sentence or',
    '  phrase rather than the whole paragraph, include a short EXACT',
    '  substring (a few words, copied character-for-character from that',
    '  paragraph\u2019s text, not paraphrased or retyped from memory) so the',
    '  note can be anchored right next to what it is about. Omit "quote"',
    '  entirely if the note is about the paragraph as a whole \u2014 do not',
    '  invent a quote just to fill the field. Never count characters or',
    '  guess a position yourself; "quote" is text to be located, not an',
    '  offset.',
    '- "kind" is OPTIONAL and defaults to "inline". Almost every note should',
    '  be "inline" \u2014 a short remark that belongs right next to the text it',
    '  is about, exactly like a normal margin note. Only use "kind":',
    '  "report" for something that is genuinely its own document: a',
    '  continuity report spanning many paragraphs, a style-consistency',
    '  summary of the whole text, or a list collecting every place a',
    '  recurring issue shows up. A single short observation about one',
    '  paragraph is NEVER a report, no matter how it is phrased.',
    '- When "kind" is "report", "content" is still required and should be a',
    '  short label for the link itself (e.g. "continuity notes",',
    '  "style summary") \u2014 it is what appears inline where the note is',
    '  anchored, NOT the report\u2019s actual content. The long-form write-up',
    '  goes in "reportContent" instead, which may be as long as needed and',
    '  may use its own Markdown headings/lists. Do not put the long-form',
    '  body in "content", and do not set "kind" to "report" without also',
    '  providing "reportContent".',
    '- A paragraph MAY get more than one note if it genuinely has more than',
    '  one DISTINCT issue worth flagging \u2014 return a separate entry per',
    '  issue (same paragraphId, different content) rather than combining',
    '  unrelated issues into one crowded note. Do NOT split a single issue',
    "  into multiple notes just to pad the count, and don't repeat the same",
    '  point twice for one paragraph.',
    '- If an issue involves more than one paragraph (e.g. two clauses that',
    '  contradict each other), anchor the note at whichever of those',
    '  paragraphs appears FIRST in the text, and mention the other by its',
    '  paragraph ID or a short quote so it is easy to find \u2014 do not return',
    '  a second entry for the other paragraph just to cross-reference it.',
    '- Return an empty array [] if no notes are warranted.',
    '- Do not include any text outside the JSON array.',
    '',
    DENSITY_PARAGRAPHS[options.density],
    SPELLING_LINES[options.spelling],
  ].join('\n');

  const behaviour = (agentProfilePrompt || '').trim();
  const fullSystem = behaviour ? `${instructions}\n\nAdditional instructions from the user for this agent:\n${behaviour}` : instructions;
  const userMessage = `Text (paragraph IDs shown in [brackets]):\n\n${numberedText}`;

  return { fullSystem, userMessage, paragraphs };
}

// Hard backstop against a runaway model — NOT a target density the plugin
// tries to steer toward. Multiple notes per paragraph are now expected and
// welcome (see resolveParagraphPlacements' comment above): a paragraph with
// several genuinely distinct issues should get several distinct notes, and
// this cap must not silently thin that out. What it still guards against is
// a small/local model that ignores the prompt's density guidance entirely
// and returns a note for nearly every sentence in the whole document — that
// failure mode is about gross over-triggering across the WHOLE text, not
// about how many notes land on any one paragraph, so the cap is deliberately
// generous (roughly one note per MIN_WORDS_PER_NOTE words) rather than
// tuned to what a "normal" run looks like. Sampling stays even across the
// sorted list (not "first N in document order") so a runaway model that
// front-loads notes doesn't blind the run to everything past the cap.
// Ported from lib/ai-proxy.js's capPlacementDensity, threshold loosened.
const MIN_WORDS_PER_NOTE = 12;
function capPlacementDensity(placements: Placement[], text: string): { kept: Placement[]; capped: number } {
  const wordCount = (text || '').trim().split(/\s+/).filter(Boolean).length;
  const maxNotes = Math.max(10, Math.ceil(wordCount / MIN_WORDS_PER_NOTE));
  if (placements.length <= maxNotes) return { kept: placements, capped: 0 };

  const sorted = [...placements].sort((a, b) => a.charPos - b.charPos);
  const step = sorted.length / maxNotes;
  const kept: Placement[] = [];
  for (let i = 0; i < maxNotes; i++) kept.push(sorted[Math.floor(i * step)]);
  return { kept, capped: sorted.length - kept.length };
}

interface ProviderConfig {
  provider: AgentProvider;
  model: string;
  apiKey: string;
  ollamaUrl: string;
}

export interface ChatResult {
  placements: Placement[];
  rejected: number;
  capped: number;
}

// Matches buildPrompt's original hardcoded behaviour byte-for-byte — the
// default so a settings object that predates this feature (or a caller
// that doesn't care) reproduces exactly what shipped before plan §2.5.
export const DEFAULT_PROMPT_OPTIONS: PromptOptions = { spelling: 'auto', density: 'balanced' };

/** End-to-end: prompt-build -> provider call -> parse -> resolve -> density cap. Mirrors lib/ai-proxy.js's chat(). */
export async function runAgentChat(
  cfg: ProviderConfig,
  agentProfilePrompt: string,
  text: string,
  promptOptions: PromptOptions = DEFAULT_PROMPT_OPTIONS
): Promise<ChatResult> {
  if (!text.trim()) throw new Error('No text provided.');
  const { fullSystem, userMessage, paragraphs } = buildPrompt(agentProfilePrompt, text, promptOptions);
  const rawText = await callAgentProvider(cfg, fullSystem, userMessage);
  const rawPlacements = extractJsonArray(rawText);
  const existingSpans = findExistingNoteSpans(text);
  const { placements: resolved, rejected } = resolveParagraphPlacements(rawPlacements, paragraphs, existingSpans);
  const { kept: placements, capped } = capPlacementDensity(resolved, text);
  return { placements, rejected, capped };
}

function stripAiNotes(text: string): string {
  return text.replace(/\[mn\.ai\s*:\s*[\s\S]*?\]/g, '');
}

/**
 * The insert-only guarantee: everything except newly-added [mn.ai: ...]
 * markers must be byte-identical before and after. Both sides are stripped
 * of ai markers (rather than just the "after" side) so a vault that already
 * had older ai notes in it doesn't produce a false mismatch.
 *
 * Plan §2 — report placements insert a plain `[[link]]`, not an
 * `[mn.ai: ...]` marker (see buildReportLinkText's doc comment for why),
 * so the static regex above can't recognise them the way it recognises
 * inline notes. Rather than trying to pattern-match "was this [[link]]
 * AI-inserted" from the text alone (indistinguishable from a human-typed
 * link to the same file), the caller passes the EXACT list of strings it
 * just inserted — it already knows precisely what those are, since it
 * built them — and those literal occurrences are stripped from `after`
 * before comparing. This keeps the guarantee just as strong as before
 * for inline notes (still a pure regex, no caller-supplied state needed)
 * while extending it correctly to report links without weakening it: a
 * `[[link]]` that was already in the document before this run, and
 * happens to match one of the inserted strings by coincidence, would at
 * worst make the check slightly less strict for that one file on that one
 * run — it can never hide an insertion the caller didn't actually make,
 * since only strings actually passed in are ever stripped.
 */
export function verifyInsertOnly(before: string, after: string, insertedLinkTexts: string[] = []): boolean {
  const stripLinkTexts = (t: string) => {
    let out = t;
    for (const linkText of insertedLinkTexts) {
      // split/join rather than a single replace() — replace() with a
      // plain string only removes the FIRST occurrence, but two distinct
      // report placements could legitimately produce identical link text
      // (same report file, same label), and every occurrence actually
      // inserted needs to be accounted for, not just one.
      out = out.split(linkText).join('');
    }
    return out;
  };
  return stripLinkTexts(stripAiNotes(before)) === stripLinkTexts(stripAiNotes(after));
}

/**
 * The exact text spliced in at a placement's charPos. Shared by
 * spliceIntoRawText (below) and marginPanel.ts's insertAiNotes so the two
 * insertion paths (file not open in an editor vs. file open live) can
 * never drift into inserting different text for the same placement kind.
 * `reportLinkText`, when the placement is `kind: 'report'`, is the
 * already-built `[[target|alias]]` string (see buildReportLinkText) —
 * built by the caller because it alone knows the report file's real path,
 * which this function has no way to derive from a Placement alone.
 */
export function renderPlacementText(p: Placement, reportLinkText?: string): string {
  if (p.kind === 'report' && reportLinkText) return reportLinkText;
  return `[mn.ai: ${p.content}]`;
}

/** Sequential text splice used for files not open in a live editor (see agentRunner.ts). `reportLinkTexts` maps a report placement's charPos to its already-built [[link]] text. */
export function spliceIntoRawText(text: string, placements: Placement[], reportLinkTexts: Map<number, string> = new Map()): string {
  const sorted = [...placements].sort((a, b) => b.charPos - a.charPos);
  let result = text;
  for (const p of sorted) {
    const insertText = renderPlacementText(p, reportLinkTexts.get(p.charPos));
    result = result.slice(0, p.charPos) + insertText + result.slice(p.charPos);
  }
  return result;
}

async function callAgentProvider(cfg: ProviderConfig, systemPrompt: string, userMessage: string): Promise<string> {
  switch (cfg.provider) {
    case 'claude':
      return callClaude(cfg, systemPrompt, userMessage);
    case 'openai':
      return callOpenAI(cfg, systemPrompt, userMessage);
    case 'gemini':
      return callGemini(cfg, systemPrompt, userMessage);
    case 'ollama':
      return callOllama(cfg, systemPrompt, userMessage);
  }
}

async function callClaude(cfg: ProviderConfig, systemPrompt: string, userMessage: string): Promise<string> {
  if (!cfg.apiKey) throw new Error('No Claude API key set — add one in plugin settings.');
  const res = await requestUrl({
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: cfg.model, max_tokens: 2000, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] }),
    throw: false,
  });
  if (res.status >= 400) throw new Error(`Claude API error ${res.status}: ${res.text.slice(0, 300)}`);
  const body = res.json as { content?: Array<{ type: string; text?: string }> } | undefined;
  const content = body?.content ?? [];
  return content.map((b) => b.text ?? '').join('\n');
}

async function callOpenAI(cfg: ProviderConfig, systemPrompt: string, userMessage: string): Promise<string> {
  if (!cfg.apiKey) throw new Error('No OpenAI API key set — add one in plugin settings.');
  const res = await requestUrl({
    url: 'https://api.openai.com/v1/chat/completions',
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
    throw: false,
  });
  if (res.status >= 400) throw new Error(`OpenAI API error ${res.status}: ${res.text.slice(0, 300)}`);
  const body = res.json as { choices?: Array<{ message?: { content?: string } }> } | undefined;
  return body?.choices?.[0]?.message?.content ?? '';
}

async function callGemini(cfg: ProviderConfig, systemPrompt: string, userMessage: string): Promise<string> {
  if (!cfg.apiKey) throw new Error('No Gemini API key set — add one in plugin settings.');
  const res = await requestUrl({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    }),
    throw: false,
  });
  if (res.status >= 400) throw new Error(`Gemini API error ${res.status}: ${res.text.slice(0, 300)}`);
  const body = res.json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } | undefined;
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('\n');
}

async function callOllama(cfg: ProviderConfig, systemPrompt: string, userMessage: string): Promise<string> {
  const res = await requestUrl({
    url: `${cfg.ollamaUrl.replace(/\/+$/, '')}/api/chat`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
    throw: false,
  });
  if (res.status >= 400) throw new Error(`Ollama error ${res.status}: ${res.text.slice(0, 300)} (is Ollama running at ${cfg.ollamaUrl}?)`);
  const body = res.json as { message?: { content?: string } } | undefined;
  return body?.message?.content ?? '';
}