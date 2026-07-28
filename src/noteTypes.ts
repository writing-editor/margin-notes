// One shared list of note types. Add a type here and it automatically shows
// up in the [mn. autocomplete, gets its marker/chip colour, and is valid to
// type directly into the document as `[mn.<id>: ...]` — there is no other
// registry to keep in sync (no dropdown, no modal, nothing else references
// types independently).
//
// id '' is the bare/default type: `[mn: content]`, no dot-suffix. It is
// deliberately excluded from the autocomplete (see typeAutocomplete.ts) since
// you don't type a dot for it — you just don't type a type at all.

export interface NoteTypeDef {
  id: string;
  label: string;
  color: string;
}

export const NOTE_TYPES: NoteTypeDef[] = [
  { id: '', label: 'Note', color: 'var(--text-accent)' },
  { id: 'info', label: 'Info', color: '#3b82f6' },
  { id: 'tip', label: 'Tip', color: '#10b981' },
  { id: 'success', label: 'Success', color: '#22c55e' },
  { id: 'question', label: 'Question', color: '#ca8a04' },
  { id: 'warning', label: 'Warning', color: '#f59e0b' },
  { id: 'danger', label: 'Danger', color: '#ef4444' },
  { id: 'bug', label: 'Bug', color: '#e11d48' },
  { id: 'example', label: 'Example', color: '#8b5cf6' },
  { id: 'quote', label: 'Quote', color: '#64748b' },
  { id: 'todo', label: 'To-do', color: '#14b8a6' },
  { id: 'query', label: 'Query', color: '#eab308' },
  { id: 'ref', label: 'Reference', color: '#6366f1' },
  { id: 'ai', label: 'AI', color: '#a855f7' },
];

const NOTE_TYPE_MAP: Map<string, NoteTypeDef> = new Map(NOTE_TYPES.map((t) => [t.id, t]));

export function noteTypeDef(type: string | null): NoteTypeDef {
  return NOTE_TYPE_MAP.get(type ?? '') ?? NOTE_TYPES[0];
}

export function noteTypeColor(type: string | null): string {
  return noteTypeDef(type).color;
}
