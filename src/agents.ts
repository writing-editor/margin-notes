import { App, requestUrl } from 'obsidian';
import { MN_RE } from './noteMarkers';
import { Paragraph, splitIntoParagraphs } from './paragraphs';
import type { SecretSettings } from './settings';

export type AgentProvider = 'claude' | 'openai' | 'gemini' | 'ollama';

export const AGENT_PROVIDERS: Array<{ id: AgentProvider; label: string; secretField: keyof SecretSettings }> = [
  { id: 'claude', label: 'Claude', secretField: 'claudeKey' },
  { id: 'openai', label: 'OpenAI', secretField: 'openaiKey' },
  { id: 'gemini', label: 'Gemini', secretField: 'geminiKey' },
  { id: 'ollama', label: 'Ollama (local)', secretField: 'claudeKey' }, // unused for ollama, kept for type uniformity
];

export interface Placement {
  charPos: number;
  content: string;
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
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The model is never asked for a character offset — it only ever names a
 * paragraphId it saw tagged in the prompt (buildPrompt() below). This
 * resolves that id back to a real charPos the code already knows for that
 * paragraph (a lookup, not a guess). Ported from lib/ai-proxy.js's
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
 * Every note for the same paragraph currently resolves to the same
 * charPos (paragraph.start) until precise in-paragraph anchoring lands
 * (see the plan doc) — to keep same-paragraph notes from being placed at
 * the exact identical document offset (which the margin layout's
 * from-ordering logic would rather not have to disambiguate), each
 * repeat's charPos is nudged forward by one character per prior note in
 * that same paragraph, clamped to stay inside the paragraph's own range.
 * This is a stable, cheap tie-breaker, not real precision — it only
 * exists so repeats sort in the order the model returned them rather than
 * comparing equal.
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
    const p = item as { paragraphId?: unknown; content?: unknown };
    if (!p || typeof p !== 'object') continue;
    const content = typeof p.content === 'string' ? p.content.trim() : '';
    if (!content) continue;
    const paragraphId = typeof p.paragraphId === 'string' ? p.paragraphId.trim() : '';
    const paragraph = byId.get(paragraphId);
    if (!paragraph) continue; // unknown/malformed id — nothing safe to clamp to

    const repeatIndex = seenCounts.get(paragraphId) ?? 0;
    const paragraphLength = Math.max(0, paragraph.end - paragraph.start);
    const charPos = paragraph.start + Math.min(repeatIndex, paragraphLength);

    if (landsInsideExistingNote(charPos, existingSpans)) {
      rejected++;
      continue;
    }
    seenCounts.set(paragraphId, repeatIndex + 1);
    out.push({ charPos, content });
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

/**
 * Ported from lib/ai-proxy.js's buildPrompt. Splits `text` into paragraphs,
 * shows the model each one tagged "[Pn]", and instructs it to name a
 * paragraph id rather than estimate a position — see the module comment in
 * lib/ai-proxy.js for the full reasoning (models can't reliably count
 * characters; they can recognize which paragraph they're looking at).
 * Says "text" throughout, not "chapter" — this runs for a whole file, a
 * selection, or a vault-wide pass, and the vault isn't always fiction.
 */
function buildPrompt(agentProfilePrompt: string, text: string): BuiltPrompt {
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
    '[{"paragraphId": "<the P-number of the paragraph, exactly as tagged, e.g. \\"P3\\">", "content": "<note text>"}]',
    '',
    'Rules:',
    '- paragraphId must be copied exactly from one of the "[Pn]" tags shown',
    '  \u2014 do not invent an id, and do not try to point at a specific word,',
    '  sentence, or character within the paragraph; a note always applies',
    '  to the whole paragraph it is tagged with.',
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
    "Density \u2014 this is the most important rule and overrides your own sense",
    'of thoroughness:',
    '- Do not flag every paragraph. A margin note next to every paragraph is',
    '  not useful to the person reading it \u2014 it is clutter they have to read',
    '  past. Most paragraphs in a clean text should get no note at all.',
    "- Only flag a paragraph if fixing what you'd note would meaningfully",
    '  improve the text. If you are unsure whether an issue is worth a note,',
    '  leave it unflagged.',
    '- If the same kind of issue (e.g. a repeated crutch word) occurs in',
    '  many paragraphs, do not give each one its own note. Note it once, on',
    '  its first or most representative paragraph, and cite the OTHER',
    '  paragraph IDs where it recurs by their actual "Pn" tags, not a vague',
    '  count (e.g. "\'suddenly\' also appears in P7, P12, and P19" \u2014 not',
    '  "appears 6 times in this text").',
    '- Use British spelling and punctuation conventions (e.g. "colour", "centre", "realise", Oxford commas, etc.)',
    '  unless the text is clearly written in American English, in which case use American conventions.',
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

/** End-to-end: prompt-build -> provider call -> parse -> resolve -> density cap. Mirrors lib/ai-proxy.js's chat(). */
export async function runAgentChat(cfg: ProviderConfig, agentProfilePrompt: string, text: string): Promise<ChatResult> {
  if (!text.trim()) throw new Error('No text provided.');
  const { fullSystem, userMessage, paragraphs } = buildPrompt(agentProfilePrompt, text);
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
 */
export function verifyInsertOnly(before: string, after: string): boolean {
  return stripAiNotes(before) === stripAiNotes(after);
}

/** Sequential text splice used for files not open in a live editor (see agentRunner.ts). */
export function spliceIntoRawText(text: string, placements: Placement[]): string {
  const sorted = [...placements].sort((a, b) => b.charPos - a.charPos);
  let result = text;
  for (const p of sorted) {
    result = result.slice(0, p.charPos) + `[mn.ai: ${p.content}]` + result.slice(p.charPos);
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
  const content = (res.json?.content ?? []) as Array<{ type: string; text?: string }>;
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
  return res.json?.choices?.[0]?.message?.content ?? '';
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
  const parts = res.json?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p: { text?: string }) => p.text ?? '').join('\n');
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
  return res.json?.message?.content ?? '';
}